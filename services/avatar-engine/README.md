# services/avatar-engine — local neural avatar engine

Photorealistic talking avatars with open-source models and freely downloadable weights, running
on the user's machine with **no paid service** (master prompt §2b). Python service, CPU by
default; the rest of Parlante talks to it over a small loopback HTTP API.

| Capability | Endpoint | What it does |
|---|---|---|
| **prepare** | `POST /v1/portraits/prepare` | photo → validated, upright, framed portrait + background matte + preview; caches the appearance features, canonical keypoints and mouth calibration the animator needs |
| **animate** | `POST /v1/animations` | prepared portrait + audio (+ viseme timeline) → H.264 clip of the avatar talking, pasted back on the full portrait, plus a matte clip to compose it over any background |
| **generate** | `POST /v1/portraits/generate` | text → portrait of a synthetic person (sub-package `portrait`, see its section in this file) |
| jobs | `GET` / `DELETE /v1/jobs/{jobId}` | progress (0..1), ETA from the measured speed, result, cancellation |
| health | `GET /health` | capabilities, models + licences, device, **measured** speed |

The HTTP contract (zod) lives in `packages/shared/src/avatar-engine.ts`; the only client is the
`local-neural` provider in `packages/providers`.

## Quick start

```bash
bash services/avatar-engine/run.sh          # or: pnpm avatar-engine
```

`run.sh` creates `services/avatar-engine/.venv`, installs the pinned `requirements.txt`, downloads
the missing weights with sha256 verification (≈ 560 MB; `--with-audio` adds 1.65 GB) and starts the
server on `http://127.0.0.1:8090`. The first start also derives the split generator graphs (~15 s)
and runs a 20-second benchmark so that `/health` can report real speed.

```bash
bash services/avatar-engine/run.sh --setup                    # install + download, do not start
AVATAR_ENGINE_DOWNLOAD_ARGS=--with-audio bash services/avatar-engine/run.sh    # + audio driver
.venv/bin/python scripts/download_models.py --list            # models, sizes, licences, state
.venv/bin/python scripts/download_models.py --check           # exit 1 if something is missing
.venv/bin/python scripts/smoke.py                             # full HTTP cycle, contract-validated
.venv/bin/python scripts/benchmark.py                         # measure this machine (run it idle)
.venv/bin/python -m pytest                                    # unit tests (seconds)
.venv/bin/python -m pytest -m slow                            # integration: renders 1 s of real video
```

Command line without the server (handy for trying a photo):

```bash
.venv/bin/python scripts/render_clip.py --image photo.jpg --audio speech.wav \
    --runtime runtime.json --out out_dir --mux        # runtime.json = {visemes:[{tMs,viseme}], words?}
.venv/bin/python scripts/eval_clip.py out_dir/avatar.mp4 --runtime runtime.json --seed 7
```

### Requirements

- Linux x86-64 (developed on Debian), **Python 3.11 – 3.13**, **ffmpeg ≥ 5** on `PATH`.
- No system GL / EGL libraries, no `mediapipe` wheel, no PyTorch: everything runs on ONNX Runtime,
  OpenVINO and LiteRT wheels from PyPI.
- CPU with AVX2; **AVX512-BF16 / AMX** (Sapphire Rapids and later) makes the generator ~2.8× faster
  (OpenVINO picks bf16 automatically). 4 cores is the practical minimum.
- RAM: **2 GB** for the viseme driver, **≈ 4.5 GB** peak while the audio driver extracts speech
  features. Disk: 0.6 GB of weights (+1.65 GB audio driver, + the portrait models).
- GPU: optional. With `onnxruntime-gpu` and a CUDA device the generator runs on the CUDA execution
  provider. **Implemented but not verified** — the build machine has no GPU.

## Measured performance

Measured on the build machine: 4 vCPU Intel Xeon @ 2.3 GHz with AMX/AVX512-BF16, 15 GB RAM, no GPU,
4 threads, 512×512 output, 30 fps. The machine was shared with other builds; the load average during
each measurement is given because it changes the result a lot. `GET /health` always reports the
figures measured on the machine the engine is actually running on.

MEASURED_TABLE_PLACEHOLDER

Reading the table: a 10-second scene at 30 fps is 300 generated frames. On an idle 4-core machine
that is about **5 minutes**; expect **8–10 minutes** when the CPU is also busy with the Parlante
worker, Postgres and a browser. Time is linear in clip length and in fps (25 fps: −17 %), and
independent of the picture.

What was tried to make it faster (all measured, see "Design notes" for the numbers):

| Option | Result | Decision |
|---|---|---|
| OpenVINO hybrid generator, bf16 | 0.95 s/frame vs 4.6 s (ONNX Runtime f32); 63.5 dB PSNR vs the f32 reference | **used** |
| Same, f32 (CPUs without bf16) | 2.7 s/frame; 127 dB | automatic fallback |
| All-OpenVINO graph with GridSample rewritten as GatherND, bf16 | 0.91 s/frame but **35 dB** (max error 0.53): bf16 breaks the sampling indices | rejected (not faithful) |
| 2 or 4 parallel generator streams | 1.59 / 3.1 s per frame effective vs 0.95 with one 4-thread stream | rejected (slower) |
| Render every 2nd frame + interpolate (linear or optical flow) | mouth-region PSNR drops below 30 dB on 19 % of the interpolated frames; **short bilabial closures disappear** (5 of the 6 worst frames are /p b m/) | rejected (visibly degrades the mouth) |
| INT8 quantisation of the generator | not completed in R&D (no calibrated model) and SPADE decoders are known to band; not pursued | not done |

## Output format (how the worker composes the clip)

`POST /v1/animations` writes two files into `outputDir`:

- `avatar.mp4` — H.264 (`yuv420p`, CRF 16, `+faststart`), no audio, **exactly `ceil(duration × fps)`
  frames**, same framing and aspect ratio as the prepared portrait, scaled so that the largest
  side is `min(maxSize, portrait side)` (even dimensions). The animated 512×512 face crop is pasted
  back on the full portrait with a feathered mask.
- `avatar-matte.mp4` — H.264 greyscale clip, same size and frame count, white = person
  (`alpha: "mask-video"`). Present when the request has a `maskPath`; otherwise `alpha: "none"`.

Why two H.264 files rather than one file with alpha: every ffmpeg build decodes them, they are
tiny (measured: ≈ 70 KB + 6 KB per second at 512², 30 fps) and cost < 1 % of the render time; VP9/ProRes with alpha
are slower, larger and not available in every ffmpeg build, and PNG sequences are ~100× bigger.
Compose with stock ffmpeg:

```bash
ffmpeg -i avatar.mp4 -i avatar-matte.mp4 -i background.png -filter_complex \
  "[1:v]format=gray[m];[0:v][m]alphamerge[fg];[2:v][fg]overlay=shortest=1" out.mp4
```

The matte follows the head: the prepared (static) matte is carried along with the motion by
smoothed dense optical flow between each generated frame and the portrait (≈ 10 ms per frame), so
the quality of the prepared matte is kept and its edge does not flicker.

Both clips carry the AI-generated mark in their MP4 metadata
(`comment=AI-generated content (synthetic talking-head video)…`); the worker must keep an
equivalent tag on the final export.

`POST /v1/portraits/prepare` writes `portrait.png` (square, upright, ≤ 768 px), `mask.png` (same
size, white = person) and `preview.jpg`, and returns the five landmarks of the contract normalised
to the prepared portrait.

## The two drivers (one generator)

| | `visemes` (default) | `audio` |
|---|---|---|
| Input | Parlante viseme timeline (`visemes`, optional `words`) | the WAV alone |
| Chosen when | the request carries `visemes` | no `visemes`, or `driver: "audio"` |
| How | deterministic rig: the 15 visemes of `packages/shared/src/visemes.ts` → mouth opening through LivePortrait's lip-retargeting MLP (calibrated per avatar) + small keypoint bases for width / rounding / teeth; coarticulation, forced closure on /p b m/, seeded blinks, brows and head micro-motion | HuBERT speech features → LMDM motion diffusion (Ditto) → lips, eyes and head pose; lips are closed in silences |
| Determinism | same request + `seed` ⇒ identical frames (seed defaults to a hash of portrait + timeline + fps) | same audio + `seed` ⇒ same motion on the same machine |
| Extra weights | none | 1.65 GB (`--with-audio`), loaded lazily and released before rendering |
| Typical use | every voice synthesised by Parlante's TTS | uploaded recordings, external TTS without phoneme timing |

Both produce driving keypoints for the same LivePortrait generator; stitching, rendering,
paste-back, matte and encoding are shared.

## Configuration

Environment variables (the repo's `.env` is read by `run.sh`; already-set variables win):

| Variable | Default | Meaning |
|---|---|---|
| `AVATAR_ENGINE_URL` | `http://127.0.0.1:8090` | only the **port** is taken from it (the engine binds to loopback) |
| `AVATAR_ENGINE_HOST` | `127.0.0.1` | bind address. A non-loopback value **requires** `AVATAR_ENGINE_TOKEN` (the server refuses to start otherwise) |
| `AVATAR_ENGINE_PORT` | from the URL | overrides the port |
| `AVATAR_ENGINE_TOKEN` | — | when set, every request except `GET /health` needs `Authorization: Bearer <token>` |
| `AVATAR_ENGINE_WORK_DIR` | `./data/avatar-engine` | directory shared with the Node worker; the **only** place the API reads or writes files |
| `AVATAR_ENGINE_MODELS_DIR` | `./data/models` | weight cache (never committed) |
| `AVATAR_ENGINE_MODEL_SEARCH_DIRS` / `HF_HOME` | — | extra Hugging Face caches whose verified files are reused in place |
| `AVATAR_ENGINE_THREADS` | CPU count (max 8) | inference threads |
| `AVATAR_ENGINE_BACKEND` | `auto` | `auto` \| `openvino` \| `onnxruntime` |
| `AVATAR_ENGINE_PRECISION` | `auto` | OpenVINO precision: `auto` (bf16 where supported) \| `f32` \| `bf16` |
| `AVATAR_ENGINE_DEVICE` | `auto` | `auto` \| `cpu` \| `gpu` |
| `AVATAR_ENGINE_SHARPEN` | `0.6` | unsharp-mask amount on generated crops (0 = off) |
| `AVATAR_ENGINE_PORTRAIT_MAX_SIDE` | `768` | side of prepared portraits |
| `AVATAR_ENGINE_MAX_IMAGE_MB` / `_MAX_AUDIO_MB` / `_MAX_CLIP_SECONDS` | 25 / 200 / 600 | input limits |
| `AVATAR_ENGINE_STARTUP_BENCHMARK` | `1` | measure the generator at first start when no measurement exists |
| `AVATAR_ENGINE_AUDIO_FEATURES_BACKEND` | `onnxruntime` | `openvino` = faster HuBERT, +0.7 GB RAM |
| `AVATAR_ENGINE_SKIP_DOWNLOAD`, `AVATAR_ENGINE_DOWNLOAD_ARGS` | — | `run.sh` only |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary |

Relative directories resolve from the repository root, exactly like `packages/providers`.

## API notes beyond the contract

All additions are optional and ignored by clients that do not know them.

- Requests: `words` (word timeline → nods on word onsets), `driver` (`auto` \| `visemes` \| `audio`),
  `seed` on `/v1/animations`; `clientRef` on every POST (a queued/running job with the same kind and
  reference is returned instead of starting a second one).
- Job errors carry `reason`, a stable key for i18n. Reasons of `prepare`: `no_face`,
  `multiple_faces`, `face_unclear`, `face_too_small`, `face_cut_off`, `not_frontal`, `head_tilted`,
  `image_too_small`, `image_too_large`, `unsupported_image`, `image_unreadable`,
  `no_face_at_landmarks`. Others: `weights_missing`, `path_outside_work_dir`, `file_not_found`,
  `file_too_large`, `not_wav`, `audio_empty`, `audio_too_long`, `out_of_memory`, `queue_full`.
  The `message` is a complete English sentence that can be shown as is.
- Results: `prepare` adds `previewPath`, `pose`, `matteModel`; `animate` adds `driver`, `seed` and
  `stats` (seconds per frame, load average, peak RSS, frame hash of that very run).
- `/health` adds `drivers`, `performance` (per driver: `secondsPerFrame`, `minutesPer10sVideo`,
  `peakRssMb`, when it was measured and under which load), `backend` and `queue`.
- One heavy job runs at a time; others wait in FIFO order (max 32). The ETA of a queued job
  includes the work ahead of it. Finished jobs are kept for an hour.

## Security

- Loopback only by default; non-loopback binds need the bearer token (contract).
- Every path in a request is resolved (symlinks included) and must stay inside
  `AVATAR_ENGINE_WORK_DIR`; anything else is `400 VALIDATION_ERROR` and nothing is created.
- Real file types are checked (PNG / JPEG / WebP magic, RIFF/WAVE header), sizes are limited, JSON
  bodies are capped at 8 MB, ffmpeg is always invoked with argument arrays.
- Weights: data-only formats, pinned revisions, sha256-verified, from huggingface.co and
  storage.googleapis.com/mediapipe-models only. No pickle, no remote code.

## Models and licences

See `docs/MODELS.md` (origin, size, licence, commercial use for every file). Summary for the parts
in this section: LivePortrait ONNX (MIT), Ditto HuBERT + LMDM for the audio driver (Apache-2.0),
MediaPipe BlazeFace / FaceMesh / selfie segmenter (Apache-2.0). All permit commercial use; the
InsightFace models that the upstream pipelines use are **not** used.

## Layout

```
parlante_engine/
  core/       config, model registry + verified downloads, job queue, backends, video, paths, perf
  prepare/    face detection + landmarks (ONNX), validation, framing, matte adapter, service, api
  animate/    generator (hybrid OpenVINO/ORT), LivePortrait maths, rig, control tracks, drivers,
              matte tracker, service, api
  portrait/   text → portrait            (portrait team)
  matting/    dedicated matting model    (portrait team; `prepare` uses it when present)
  server.py   FastAPI app; includes `parlante_engine.<sub>.api:router` of each sub-package
scripts/      download_models.py, smoke.py (+ validate_contract.ts), render_clip.py, eval_clip.py, benchmark.py
tests/        pytest: unit tests + `-m slow` integration
```

A sub-package plugs in by convention: `models.py` exposes `MODELS: list[ModelFile]` (aggregated by
the registry and by `/health`) and `api.py` may expose `router`.

## Design notes

- **Generator backend.** `warping_spade.onnx` contains two 5-D `GridSample` nodes that OpenVINO's
  ONNX frontend rejects. The graph is split once into three convolution-only stages (OpenVINO) and
  two single-node GridSample graphs (ONNX Runtime, f32). Keeping the sampling in f32 is what makes
  bf16 safe; `tests/test_integration_slow.py` asserts > 45 dB PSNR against the f32 reference.
- **Mouth calibration.** The lip-retargeting MLP does not open every face by the same amount for
  the same target, so `prepare` renders seven targets, measures the opening on the pixels with
  FaceMesh and stores the inverse curve. Commanded and measured opening then correlate at 0.98
  with zero lag (`scripts/eval_clip.py`).
- **Bilabials.** A /p b m/ cue forces opening to 0 around its midpoint and guarantees one fully
  closed frame even when the cue is shorter than a frame.
- **Sharpening.** The SPADE decoder is softer than a photo (Laplacian variance 180 vs 988 on the
  test portrait); a light unsharp mask (0.6) brings part of it back without ringing.
- **Avatar cache.** `AVATAR_ENGINE_WORK_DIR/.cache/avatars/<sha256 of portrait.png>.npz` (plain
  arrays, loaded with `allow_pickle=False`). A portrait that was not prepared by this engine is
  registered on first use, so any picture with a detectable face can be animated.

## Known limits (stated plainly)

- **Slow on CPU**: minutes per 10 s of video (table above). There is no faithful shortcut.
- **Softness**: the animated face region is generated at 512×512 and is softer than the original
  photo, most visibly in hair and skin texture; portraits above ~600 px get an upscaled face.
- **Teeth and mouth interior** are invented by the generator: on portraits with a closed mouth the
  lower teeth can look dark or slightly uneven in wide vowels. The tongue is never visible
  (`TH`, `NL` are approximated by opening and teeth exposure).
- **Lip-rounding** (`O`, `U`, `CHJ`) is weaker than a real speaker's: the implicit keypoints give
  little control over protrusion.
- **Head motion is small** by design (±3° yaw, ±2° pitch): larger rotations make the pasted crop
  drift against the static shoulders.
- The **audio driver** is not bit-exact across machines (diffusion noise + floating point) and
  articulates less crisply than the viseme driver; use it only when there is no timeline.
- The matte is tracked, not re-estimated: very fast head motion could leave a thin halo (not
  observed with the motion amplitudes above).
- Frontal, single-person portraits only (|yaw|, |pitch| ≤ 25°); glasses and beards work, hands or
  objects in front of the face do not.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 SERVICE_UNAVAILABLE … weights missing` | run `python scripts/download_models.py` (add `--with-audio` for requests without visemes); `--list` shows what is missing |
| `Checksum mismatch` while downloading | a truncated or altered file: it is deleted; run the script again |
| Download hangs behind a proxy | set `HTTPS_PROXY` and, for a custom CA, `SSL_CERT_FILE`; downloads resume where they stopped |
| `Refusing to listen on 0.0.0.0` | set `AVATAR_ENGINE_TOKEN` (and the same variable for the worker) |
| `400 … path is outside the engine work directory` | the worker and the engine do not share `AVATAR_ENGINE_WORK_DIR` at the same absolute path |
| `422 UNPROCESSABLE` on `prepare` | see `error.reason` (no face, several faces, too small, not frontal…) and show the message to the user |
| Very slow (≥ 4 s/frame) | CPU without bf16 or OpenVINO missing (`/health → backend`), or the machine is busy; lower `fps` to 25 or `maxSize` does **not** help (the generator always renders 512²) |
| `MemoryError` / killed during an audio-driven job | the audio driver needs ≈ 4.5 GB free; send a viseme timeline instead |
| `ffmpeg was not found` | install ffmpeg or set `FFMPEG_PATH` |
| ETA looks wrong right after start | it is the startup benchmark's figure; it converges to the real speed after the first job |
