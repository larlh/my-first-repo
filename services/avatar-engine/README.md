# services/avatar-engine — local neural avatar engine

Photorealistic talking avatars with open-source models and freely downloadable weights, running
on the user's machine with **no paid service** (master prompt §2b). Python service, CPU by
default; the rest of Parlante talks to it over a small loopback HTTP API.

| Capability   | Endpoint                          | What it does                                                                                                                                                            |
| ------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **prepare**  | `POST /v1/portraits/prepare`      | photo → validated, upright, framed portrait + background matte + preview; caches the appearance features, canonical keypoints and mouth calibration the animator needs  |
| **animate**  | `POST /v1/animations`             | prepared portrait + audio (+ viseme timeline) → H.264 clip of the avatar talking, pasted back on the full portrait, plus a matte clip to compose it over any background |
| **generate** | `POST /v1/portraits/generate`     | text → portrait of a synthetic person (sub-package `portrait`, see its section in this file)                                                                            |
| jobs         | `GET` / `DELETE /v1/jobs/{jobId}` | progress (0..1), ETA from the measured speed, result, cancellation                                                                                                      |
| health       | `GET /health`                     | capabilities, models + licences, device, **measured** speed                                                                                                             |

The HTTP contract (zod) lives in `packages/shared/src/avatar-engine.ts`; the only client is the
`local-neural` provider in `packages/providers`.

## Quick start

```bash
bash services/avatar-engine/run.sh          # or: pnpm avatar-engine
```

`run.sh` creates `services/avatar-engine/.venv`, installs the pinned `requirements.txt`, downloads
the missing weights with sha256 verification (prepare + animate ≈ 0.56 GB, plus the portrait
generator and matting models declared by the `portrait` / `matting` sub-packages; `--with-audio`
adds 1.65 GB; `AVATAR_ENGINE_DOWNLOAD_ARGS=--minimal` keeps only prepare + animate) and starts the
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
.venv/bin/python -m pytest -m slow tests/test_integration_slow.py   # renders 1 s of real video (~2 min)
.venv/bin/python scripts/download_models.py --import-from "$HF_HOME" --all   # reuse an HF cache (hard links)
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
- RAM: **≈ 2 GB** for the viseme driver, **≈ 4 GB** peak while the audio driver extracts speech
  features (measured: 1.9 GB and 3.8 GB). Disk: 0.6 GB of weights (+1.65 GB audio driver, + the portrait models).
- GPU: optional. With `onnxruntime-gpu` and a CUDA device the generator runs on the CUDA execution
  provider. **Implemented but not verified** — the build machine has no GPU.

## Measured performance

Measured on the build machine: 4 vCPU Intel Xeon @ 2.3 GHz with AMX/AVX512-BF16, 15 GB RAM, no GPU,
4 threads, 512×512 output, 30 fps. The machine was shared with other builds; the load average during
each measurement is given because it changes the result a lot. `GET /health` always reports the
figures measured on the machine the engine is actually running on.

| What was measured                                                                                           | Frames | s / frame    | Minutes per 10 s of video (30 fps) | Peak RAM (RSS) | Load avg (1 min) during the run |
| ----------------------------------------------------------------------------------------------------------- | ------ | ------------ | ---------------------------------- | -------------- | ------------------------------- |
| Generator alone, hybrid OpenVINO bf16 (benchmark, real tensor shapes)                                       | 8      | **0.95**     | 4.8                                | —              | 2.8                             |
| Generator alone, ONNX Runtime f32 (reference, no OpenVINO)                                                  | 2      | 4.61         | 23                                 | —              | 1.1                             |
| Generator alone, hybrid OpenVINO f32 (CPU without bf16)                                                     | 12     | 2.69         | 13.5                               | —              | 3.0                             |
| **Viseme driver**, full job (render + paste-back + matte + 2 × H.264), 9.5 s clip                           | 286    | **1.55**     | 7.7                                | 1.8 GB         | 8.9 → 7.3                       |
| Viseme driver, full job, 9.0 s clip                                                                         | 269    | 1.80         | 9.0                                | 1.9 GB         | 4.6 → 5.0                       |
| Viseme driver, full job, 9.0 s clip (same process had just run `prepare` with the matting model)            | 269    | 2.01         | 10.1                               | 2.1 GB         | 7.7 → 6.0                       |
| **Audio driver**, full job, 7.3 s clip: 35 s of set-up (HuBERT + 150 diffusion steps) + render              | 221    | 2.48         | 12.4 + 0.6 set-up                  | 3.8 GB         | 6.4 → 9.5                       |
| `prepare` over HTTP (detection, validation, matte, 7 calibration renders; first call also loads the models) | —      | 23.5 s total | —                                  | 2.2 GB         | ≈ 12                            |

No full job could be timed on an idle machine (other builds were running throughout); the
generator-alone row at load 2.8 is the closest to idle, and a full job adds 0.03 s per frame on top of it
(measured: paste-back 11 ms, matte tracking 14 ms, encoder pipe 4 ms, keypoints 0.5 ms). The full-job rows show what contention
does: the same code took between 1.5 and 3.2 s per frame depending on what else the 4 cores
were doing. Jobs report their own figures in `result.stats`, and the engine keeps a moving
average per driver for `/health` and for ETAs.

Reading the table: a 10-second scene at 30 fps is 300 generated frames. On an idle 4-core machine
that is about **5 minutes** (generator benchmark); **8–10 minutes** were measured for whole jobs
while the CPU was also busy with other work, which is what to expect next to the Parlante worker,
Postgres and a browser. Time is linear in clip length and in fps (25 fps: −17 %), and
independent of the picture.

What was tried to make it faster (all measured, see "Design notes" for the numbers):

| Option                                                         | Result                                                                                                                                              | Decision                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| OpenVINO hybrid generator, bf16                                | 0.95 s/frame vs 4.6 s (ONNX Runtime f32); 63.5 dB PSNR vs the f32 reference                                                                         | **used**                              |
| Same, f32 (CPUs without bf16)                                  | 2.7 s/frame; 127 dB                                                                                                                                 | automatic fallback                    |
| All-OpenVINO graph with GridSample rewritten as GatherND, bf16 | 0.91 s/frame but **35 dB** (max error 0.53): bf16 breaks the sampling indices                                                                       | rejected (not faithful)               |
| 2 or 4 parallel generator streams                              | 1.59 / 3.1 s per frame effective vs 0.95 with one 4-thread stream                                                                                   | rejected (slower)                     |
| Render every 2nd frame + interpolate (linear or optical flow)  | mouth-region PSNR drops below 30 dB on 19 % of the interpolated frames; **short bilabial closures disappear** (5 of the 6 worst frames are /p b m/) | rejected (visibly degrades the mouth) |
| INT8 quantisation of the generator                             | not completed in R&D (no calibrated model) and SPADE decoders are known to band; not pursued                                                        | not done                              |

## Output format (how the worker composes the clip)

`POST /v1/animations` writes two files into `outputDir`:

- `avatar.mp4` — H.264 (`yuv420p`, CRF 16, `+faststart`), no audio, **exactly `ceil(duration × fps)`
  frames**, same framing and aspect ratio as the prepared portrait, scaled so that the largest
  side is `min(maxSize, portrait side)` (even dimensions). The animated 512×512 face crop is pasted
  back on the full portrait with a feathered mask.
- `avatar-matte.mp4` — H.264 greyscale clip, same size and frame count, white = person
  (`alpha: "mask-video"`). Present when the request has a `maskPath`; otherwise `alpha: "none"`.

Why two H.264 files rather than one file with alpha: every ffmpeg build decodes them, they are
tiny (measured: ≈ 70 KB + 6 KB per second at 512², 30 fps) and the matte (tracking + its encode) costs ≈ 15 ms per frame, about 1.5 % of the render time; VP9/ProRes with alpha
are slower, larger and not available in every ffmpeg build, and PNG sequences are ~100× bigger.
Compose with stock ffmpeg:

```bash
ffmpeg -i avatar.mp4 -i avatar-matte.mp4 -i background.png -filter_complex \
  "[1:v]format=gray[m];[0:v][m]alphamerge[fg];[2:v][fg]overlay=shortest=1" out.mp4
```

The matte follows the head: the prepared (static) matte is carried along with the motion by
smoothed dense optical flow between each generated frame and the portrait (measured 14 ms per frame), so
the quality of the prepared matte is kept and its edge does not flicker.

Both clips carry the AI-generated mark in their MP4 metadata
(`comment=AI-generated content (synthetic talking-head video)…`); the worker must keep an
equivalent tag on the final export.

`POST /v1/portraits/prepare` writes `portrait.png` (square, upright, ≤ 768 px), `mask.png` (same
size, white = person) and `preview.jpg`, and returns the five landmarks of the contract normalised
to the prepared portrait. A head tilted by 2–35° is rotated upright about the eye centre; if
the rotated square does not fit in the photo it is shrunk, and what still falls outside is
mirror-filled (normally background that the matte removes). The matte comes from the dedicated
matting model of the `matting` sub-package when its weights are present, otherwise from the
MediaPipe selfie segmenter (coarser hair edge), otherwise `maskPath` is `null`: a missing matting
model never blocks `prepare` (`result.matteModel` says which one was used).

## The two drivers (one generator)

|               | `visemes` (default)                                                                                                                                                                                                                                                                                 | `audio`                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Input         | Parlante viseme timeline (`visemes`, optional `words`)                                                                                                                                                                                                                                              | the WAV alone                                                                                                  |
| Chosen when   | the request carries `visemes`                                                                                                                                                                                                                                                                       | no `visemes`, or `driver: "audio"`                                                                             |
| How           | deterministic rig: the 15 visemes of `packages/shared/src/visemes.ts` → mouth opening through LivePortrait's lip-retargeting MLP (calibrated per avatar) + small keypoint bases for width / rounding / teeth; coarticulation, forced closure on /p b m/, seeded blinks, brows and head micro-motion | HuBERT speech features → LMDM motion diffusion (Ditto) → lips, eyes and head pose; lips are closed in silences |
| Determinism   | same request + `seed` ⇒ identical frames (seed defaults to a hash of portrait + timeline + fps)                                                                                                                                                                                                     | same audio + `seed` ⇒ same motion on the same machine                                                          |
| Extra weights | none                                                                                                                                                                                                                                                                                                | 1.65 GB (`--with-audio`), loaded lazily and released before rendering                                          |
| Typical use   | every voice synthesised by Parlante's TTS                                                                                                                                                                                                                                                           | uploaded recordings, external TTS without phoneme timing                                                       |

Both produce driving keypoints for the same LivePortrait generator; stitching, rendering,
paste-back, matte and encoding are shared.

## Portrait generation and matting (sub-packages `portrait`, `matting`)

`POST /v1/portraits/generate` turns a description into the portrait of a **synthetic** presenter:
Realistic Vision V6 (a Stable Diffusion 1.5 fine-tune, CreativeML OpenRAIL-M) executed by OpenVINO
with our own tokenizer, sampler and decoder — no PyTorch, no `diffusers`. The weights are an
optional 4.3 GB download (`scripts/download_models.py --all`); the first job derives a 1.7 GB
FP16 IR of the UNet (a few seconds, cached). `docs/MODELS.md` explains why this model and which ones
were rejected.

```bash
.venv/bin/python scripts/download_models.py --capability generate
.venv/bin/python scripts/generate_portrait.py --out out/ana --seed 7 \
    --description "mujer de 35 años, pelo castaño rizado, chaqueta azul marino y gafas"
.venv/bin/python scripts/generate_portrait.py --out out/leo --seed 11 --size 768 --gender male \
    --age 52 --skin-tone dark --hair "short graying hair" --style business
```

What the job does:

1. **Presenter prompt template** (`portrait/prompts.py`). The description (free text in Spanish or
   English through the API; a structured `PortraitSpec` — gender, age, skin tone, heritage, hair,
   clothing, style/profession, background — from Python and the CLI) is wrapped in the constraints
   the animator needs: close-up head and shoulders, front view, looking into the camera, **lips
   closed**, calm expression, plain wall background, studio light. A negative prompt pushes away
   open mouths, teeth, tilted heads, hands, revealing clothes, illustration styles and cluttered
   backgrounds, plus counter-terms for the requested gender and age. The whole prompt is budgeted
   to **one CLIP window (75 tokens)**: optional tags are dropped first and an over-long description
   is cut, never the constraints. Spanish descriptions get a keyword-level translation (~190 entries:
   "pelo castaño rizado" → "hair brown curly") because the text encoder is English-centric; it is a
   glossary, not a translator. Descriptions of minors are refused (`400`, reason
   `minor_not_allowed`).
2. **Sampling in two stages**: DPM-Solver++(2M) with Karras sigmas, 20 steps, classifier-free
   guidance 5.5.
   - _Composition_ at ≤ 512 px (longest side), where the model reliably produces frontal, upright
     shots. Generating 768 px directly was tried first and rejected: the model drifts to tilted
     fashion poses there (three seeds in a row failed the quality control for a prompt that passes
     at 512 px).
   - _Re-frame and refine_: the approved composition is cropped to the head-and-shoulders framing
     that `prepare` normalises to (forehead-to-chin ≈ 47 % of the frame, eyes at 42 % of the
     height), scaled to the requested size and re-rendered by image-to-image (noise at half of the
     schedule, 10 more steps, same prompt and seed). The face is therefore large and detailed at
     the final resolution instead of a small face in a wider shot, and `prepare` keeps every pixel.
     Same request ⇒ same pixels (numpy PCG64 noise from `seed`; checked by the slow test). Sizes are
     rounded to multiples of 64 in 384…768 px.
3. **Automatic quality control** (`portrait/qc.py`, MediaPipe FaceMesh landmarks through the same
   detector as `prepare`): exactly one face, large enough (≥ 22 % of the height), centred, frontal,
   upright (roll ≤ 10°), eyes open and looking at the camera, **mouth closed** (inner-lip gap
   ≤ 7 % of the mouth width). It runs on the composition: when a check fails the job retries with
   a derived seed (`seed + k·1 000 003`, up to 4 attempts, each costing only the cheap 512-px
   stage) and keeps the least bad image; the final pixels are checked again and the result says
   what was found (`qcPassed`, `qcIssues`). If no attempt shows exactly one clear face the job
   fails with `UNPROCESSABLE` / `no_usable_face`.
4. Writes `portrait.png` and `portrait.json` (prompt, negative prompt, seeds tried, QC metrics,
   landmarks, timings, model and licence, `synthetic: true`) and releases the models' memory.

`GET /v1/portraits/options` (additive, not in the shared contract) lists the template's choices
(styles with their default clothing, skin tones, backgrounds, size limits) and the expected seconds
per size on this machine, so a form can show an estimate before queueing.

The result is then passed to `POST /v1/portraits/prepare` like any photo. `prepare` gets its matte
from `parlante_engine.matting.api.matte(image_bgr) -> alpha` (float32 H×W, 1 = person): ORMBG, an
Apache-2.0 IS-Net trained for humans, 176 MB, ~0.4 s per image; the model is loaded lazily and
released after two idle minutes. It is part of the default download (`prepare` needs it); if it
fails at run time `prepare` degrades to the MediaPipe selfie segmenter instead of failing.

### Measured cost of a portrait

Build machine (4 vCPU with AMX, 4 threads, OpenVINO bf16), shared with other builds — the load
average during each measurement is given. `GET /health → secondsPerPortrait` reports the last
512×512 job measured on the machine the engine runs on, and job ETAs use the speed of the job itself.
Sampler: 20 steps, guidance 5.5 (the defaults).

| What                                                                                     | Measured                                                                   | Load avg |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| UNet evaluation at 512×512 / 768×768 (2 per sampler step)                                | 0.57 s / 2.1 s                                                             | 2–3.5    |
| Composition attempt at 512×512 (40 evaluations + decode + quality control)               | 23–24 s                                                                    | 2–3.5    |
| Re-frame + refine pass (20 evaluations + encode / decode) at 512×512 / 768×768           | 13 s / 46 s                                                                | 2–3.5    |
| **768×768 portrait, first attempt passes** (`scripts/build_stock_avatars.py`, seed 1115) | **76 s**                                                                   | 1.5–3.3  |
| 768×768 portrait over HTTP, 2 attempts (`scripts/smoke_portrait.py --size 768`)          | 101 s (ETA announced at submit: 117 s)                                     | 2.2–3.7  |
| **512×512 portrait over HTTP, 2 attempts** (`scripts/smoke_portrait.py`)                 | **66 s** (≈ 42 s when the first attempt passes: one composition less)      | 2.5–3.3  |
| 12 stock portraits at 768×768 in one batch                                               | 74 s (1 attempt) · 95–98 s (2) · 117–120 s (3) · 139–143 s (4); mean 103 s | ≈ 3.5    |
| Peak RSS of a generation, 512×512 and 768×768                                            | 4.7 GB (6.2 GB in a process that also holds the animator's models)         | —        |
| Model load per job (released afterwards; RSS returns to its previous level)              | ≈ 3 s                                                                      | —        |
| First job after installing: checksum of the 4.3 GB of weights + UNet IR derivation       | 3.3 s + 3.3 s, once (files already in the page cache)                      | 1.9      |
| Person matte (ORMBG, 1024×1024 input)                                                    | 0.3–0.5 s, 0.7 GB peak RSS                                                 | 7        |
| `prepare` of a generated 768×768 portrait (face, framing, matte, animator cache)         | 7–10 s                                                                     | ≈ 3.5    |

The estimate announced when a job is queued (and by `GET /v1/portraits/options`) counts the
typical 2.3 compositions per portrait; `bestCaseSeconds` is the first-attempt figure.

Retries are the norm, not the exception: in the batch that produced the stock library (12
portraits at 768×768) only **10 of 28 compositions passed** the quality control — 4 portraits
passed at the first attempt, 3 needed two, 2 needed three and 3 used all four, one of which still
ended with a 10° head turn (`qcPassed: false`). Rejections were almost always pose
(`not_frontal` 15×, `head_tilted` 7×, `off_center` 3×); a mouth was never open. Each extra attempt
costs one 512-px composition (~23 s). RAM is the binding constraint: 768×768 is the largest size
offered (self-attention memory grows with the square of the pixel count).

### Stock library

`stock/avatars.json` describes the built-in photorealistic avatars (structured description + seed).
`scripts/build_stock_avatars.py --staging DIR` generates and prepares each one with the code above;
after a person has looked at every staged image, `--publish slug,slug,…` copies the approved ones
to `packages/stock-assets/assets/avatars/` (`<slug>.jpg`, `<slug>.mask.png`, `<slug>.thumb.webp`)
and regenerates the catalogue `packages/stock-assets/src/photoreal-avatars.data.ts`.

### Limits of portrait generation (stated plainly)

- **Pose is hit and miss**: about two compositions in three are rejected by the quality control
  (see above), so a portrait usually takes 1.5–2.5 minutes at 768 px rather than the 75 s of a
  first-attempt pass; and a portrait can come back with `qcPassed: false`.
- **The description is followed loosely**: age, skin tone and overall style are respected;
  colours drift ("navy blazer" came out grey), hair length, glasses or a requested garment may be
  ignored (medical scrubs came out as a sleeveless top). Nothing checks this automatically.
- **Gender bias of the base model**: without help it turned "bearded Middle Eastern man" into a
  woman with four seeds out of four and "Japanese man" with two out of three. Male prompts
  therefore get the noun's embedding weighted ×1.3, which fixed those seeds; expect occasional
  misses anyway, and the same bias towards young, conventionally attractive faces.
- **Quality control sees the face only**: a raised arm, visible hands, a stray blob of hair at
  the top edge (seen in 3 of 20 portraits) or an odd collar pass it. The stock library was
  reviewed by eye for that reason — 4 of the first 12 candidates were discarded (wrong gender
  twice, wrong garment, hair artefact) — but user-generated portraits are not.
- **Detail is invented**: the second pass re-renders a 1.5–2.5× enlargement of the composition;
  skin and hair look photographic but small asymmetries (one earring, uneven glasses) are common.
- Plain walls are requested, but textured or dark backdrops appear; the matte copes with them.
- The Spanish glossary covers common appearance, clothing and profession words only; anything
  else reaches the model untranslated and is usually ignored.
- Real-person likeness is **not** filtered here: the API moderates descriptions before they reach
  the engine, and the OpenRAIL-M licence forbids impersonation without consent.

## Configuration

Environment variables (the repo's `.env` is read by `run.sh`; already-set variables win):

| Variable                                                             | Default                 | Meaning                                                                                                       |
| -------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `AVATAR_ENGINE_URL`                                                  | `http://127.0.0.1:8090` | only the **port** is taken from it (the engine binds to loopback)                                             |
| `AVATAR_ENGINE_HOST`                                                 | `127.0.0.1`             | bind address. A non-loopback value **requires** `AVATAR_ENGINE_TOKEN` (the server refuses to start otherwise) |
| `AVATAR_ENGINE_PORT`                                                 | from the URL            | overrides the port                                                                                            |
| `AVATAR_ENGINE_TOKEN`                                                | —                       | when set, every request except `GET /health` needs `Authorization: Bearer <token>`                            |
| `AVATAR_ENGINE_WORK_DIR`                                             | `./data/avatar-engine`  | directory shared with the Node worker; the **only** place the API reads or writes files                       |
| `AVATAR_ENGINE_MODELS_DIR`                                           | `./data/models`         | weight cache (never committed)                                                                                |
| `AVATAR_ENGINE_MODEL_SEARCH_DIRS` / `HF_HOME`                        | —                       | extra Hugging Face caches whose verified files are reused in place                                            |
| `AVATAR_ENGINE_THREADS`                                              | CPU count (max 8)       | inference threads                                                                                             |
| `AVATAR_ENGINE_BACKEND`                                              | `auto`                  | `auto` \| `openvino` \| `onnxruntime`                                                                         |
| `AVATAR_ENGINE_PRECISION`                                            | `auto`                  | OpenVINO precision: `auto` (bf16 where supported) \| `f32` \| `bf16`                                          |
| `AVATAR_ENGINE_DEVICE`                                               | `auto`                  | `auto` \| `cpu` \| `gpu`                                                                                      |
| `AVATAR_ENGINE_SHARPEN`                                              | `0.6`                   | unsharp-mask amount on generated crops (0 = off)                                                              |
| `AVATAR_ENGINE_PORTRAIT_MAX_SIDE`                                    | `768`                   | side of prepared portraits                                                                                    |
| `AVATAR_ENGINE_PORTRAIT_STEPS`                                       | `20`                    | sampler steps of portrait generation (8…40; time is linear in it)                                             |
| `AVATAR_ENGINE_PORTRAIT_GUIDANCE`                                    | `5.5`                   | classifier-free guidance of portrait generation (1.5…12)                                                      |
| `AVATAR_ENGINE_PORTRAIT_ATTEMPTS`                                    | `4`                     | attempts (different seeds) while the automatic quality control fails (1…6)                                    |
| `AVATAR_ENGINE_MAX_IMAGE_MB` / `_MAX_AUDIO_MB` / `_MAX_CLIP_SECONDS` | 25 / 200 / 600          | input limits                                                                                                  |
| `AVATAR_ENGINE_STARTUP_BENCHMARK`                                    | `1`                     | measure the generator at first start when no measurement exists                                               |
| `AVATAR_ENGINE_AUDIO_FEATURES_BACKEND`                               | `onnxruntime`           | `openvino` = faster HuBERT, +0.7 GB RAM                                                                       |
| `AVATAR_ENGINE_SKIP_DOWNLOAD`, `AVATAR_ENGINE_DOWNLOAD_ARGS`         | —                       | `run.sh` only                                                                                                 |
| `FFMPEG_PATH`                                                        | `ffmpeg`                | ffmpeg binary                                                                                                 |

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

| Symptom                                           | Cause / fix                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `503 SERVICE_UNAVAILABLE … weights missing`       | run `python scripts/download_models.py` (add `--with-audio` for requests without visemes); `--list` shows what is missing                                                |
| `Checksum mismatch` while downloading             | a truncated or altered file: it is deleted; run the script again                                                                                                         |
| Download hangs behind a proxy                     | set `HTTPS_PROXY` and, for a custom CA, `SSL_CERT_FILE`; downloads resume where they stopped                                                                             |
| `Refusing to listen on 0.0.0.0`                   | set `AVATAR_ENGINE_TOKEN` (and the same variable for the worker)                                                                                                         |
| `400 … path is outside the engine work directory` | the worker and the engine do not share `AVATAR_ENGINE_WORK_DIR` at the same absolute path                                                                                |
| `422 UNPROCESSABLE` on `prepare`                  | see `error.reason` (no face, several faces, too small, not frontal…) and show the message to the user                                                                    |
| Very slow (≥ 4 s/frame)                           | CPU without bf16 or OpenVINO missing (`/health → backend`), or the machine is busy; lower `fps` to 25 or `maxSize` does **not** help (the generator always renders 512²) |
| `MemoryError` / killed during an audio-driven job | the audio driver needs ≈ 4 GB free; send a viseme timeline instead                                                                                                       |
| `ffmpeg was not found`                            | install ffmpeg or set `FFMPEG_PATH`                                                                                                                                      |
| ETA looks wrong right after start                 | it is the startup benchmark's figure; it converges to the real speed after the first job                                                                                 |
