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
the missing weights with sha256 verification (prepare + animate ≈ 0.56 GB, the audio driver
1.65 GB, plus the portrait generator and matting models declared by the `portrait` / `matting`
sub-packages; `AVATAR_ENGINE_DOWNLOAD_ARGS=--no-audio` leaves the audio driver out and
`--minimal` keeps only prepare + animate with the viseme driver) and starts the
server on `http://127.0.0.1:8090`. The first start also derives the split generator graphs (~15 s)
and runs a 20-second benchmark so that `/health` can report real speed.

```bash
bash services/avatar-engine/run.sh --setup                    # install + download, do not start
AVATAR_ENGINE_DOWNLOAD_ARGS=--no-audio bash services/avatar-engine/run.sh      # without the audio driver (−1.65 GB)
.venv/bin/python scripts/download_models.py --list            # models, sizes, licences, state
.venv/bin/python scripts/download_models.py --check           # exit 1 if something is missing
.venv/bin/python scripts/smoke.py                             # full HTTP cycle, contract-validated
.venv/bin/python scripts/benchmark.py                         # measure this machine (run it idle)
.venv/bin/python -m parlante_engine.selftest                  # self-diagnosis: device, every model, 1 s of animation, a small portrait
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

- Linux x86-64 (developed on Debian), **Python 3.12 – 3.13** (the pinned numpy needs ≥ 3.12),
  **ffmpeg ≥ 5** on `PATH`. Windows: through WSL2 (see "GPU and Windows"); macOS: not tried.
- No system GL / EGL libraries, no `mediapipe` wheel, no PyTorch: everything runs on ONNX Runtime,
  OpenVINO and LiteRT wheels from PyPI.
- CPU with AVX2; **AVX512-BF16 / AMX** (Sapphire Rapids and later) makes the generator ~2.8× faster
  (OpenVINO picks bf16 automatically). 4 cores is the practical minimum.
- RAM: **≈ 2 GB** for the viseme driver, **≈ 4 GB** peak while the audio driver extracts speech
  features (measured: 1.9 GB and 3.5–3.8 GB). Disk: 0.6 GB of weights + 1.65 GB audio driver + the portrait models.
- GPU: optional. With `onnxruntime-gpu` and an NVIDIA card the generator and the audio driver run
  on the CUDA execution provider. **Prepared but not verified** — the build machine has no GPU.
  See "GPU and Windows" for what was reviewed, the self-test to run on your card and the WSL2 steps.

## Measured performance

Measured on the build machine: 4 vCPU Intel Xeon @ 2.3 GHz with AMX/AVX512-BF16, 15 GB RAM, no GPU,
4 threads, 512×512 output, 30 fps. The machine was shared with other builds; the load average during
each measurement is given because it changes the result a lot. `GET /health` always reports the
figures measured on the machine the engine is actually running on.

| What was measured                                                                                                                                                              | Frames | s / frame             | Minutes per 10 s of video (30 fps) | Peak RAM (RSS)  | Load avg (1 min) during the run |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------- | ---------------------------------- | --------------- | ------------------------------- |
| Generator alone, hybrid OpenVINO bf16 (benchmark, real tensor shapes)                                                                                                          | 8      | **0.95**              | 4.8                                | —               | 2.8                             |
| Generator alone, ONNX Runtime f32 (reference, no OpenVINO)                                                                                                                     | 2      | 4.61                  | 23                                 | —               | 1.1                             |
| Generator alone, hybrid OpenVINO f32 (CPU without bf16)                                                                                                                        | 12     | 2.69                  | 13.5                               | —               | 3.0                             |
| **Viseme driver**, full job (render + paste-back + matte + 2 × H.264), 9.5 s clip                                                                                              | 286    | **1.55**              | 7.7                                | 1.8 GB          | 8.9 → 7.3                       |
| Viseme driver, full job, 9.0 s clip                                                                                                                                            | 269    | 1.80                  | 9.0                                | 1.9 GB          | 4.6 → 5.0                       |
| Viseme driver, full job, 9.0 s clip (same process had just run `prepare` with the matting model)                                                                               | 269    | 2.01                  | 10.1                               | 2.1 GB          | 7.7 → 6.0                       |
| **Audio driver**, full job, 7.3 s clip: 35 s of set-up (HuBERT + 150 diffusion steps) + render                                                                                 | 221    | 2.48                  | 12.4 + 0.6 set-up                  | 3.8 GB          | 6.4 → 9.5                       |
| `prepare` over HTTP (detection, validation, matte, 7 calibration renders; first call also loads the models)                                                                    | —      | 23.5 s total          | —                                  | 2.2 GB          | ≈ 12                            |
| `python -m parlante_engine.selftest` (2026-11-24): generator benchmark, 4 frames                                                                                               | 4      | **1.11**              | 5.6                                | 1.6 GB          | 2.9                             |
| selftest: `animate` 1 s at 25 fps, viseme driver                                                                                                                               | 25     | 1.13                  | 5.7                                | 2.2 GB          | 2.9                             |
| selftest: `animate` 1 s at 25 fps, **audio driver** (lips): 6.1 s of set-up (HuBERT load 2.3 s + features 0.7 s + motion-model load 1.7 s + 50 diffusion steps 1.4 s) + render | 25     | 1.11                  | 5.5 + set-up                       | 3.6 GB          | 2.9                             |
| selftest: `prepare` of the bundled face / 384 px portrait in 8 steps, 1 attempt                                                                                                | —      | 10.1 s / 12.3 s total | —                                  | 2.2 GB / 5.8 GB | 2.9                             |

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

|               | `visemes`                                                                                                                                                                                                                                                                                           | `audio`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input         | Parlante viseme timeline (`visemes`, optional `words`)                                                                                                                                                                                                                                              | the WAV itself; the timeline, when sent, is only a hint for /p b m/                                                                                                                                                                                                                                                                                                                                                             |
| How           | deterministic rig: the 15 visemes of `packages/shared/src/visemes.ts` → mouth opening through LivePortrait's lip-retargeting MLP (calibrated per avatar) + small keypoint bases for width / rounding / teeth; coarticulation, forced closure on /p b m/, seeded blinks, brows and head micro-motion | HuBERT speech features → LMDM motion diffusion (Ditto) → **lip** motion. When and how the mouth moves is the model's; how much it opens goes through the same per-avatar mouth calibration, with a bounded per-clip articulation gain. Blinks, brows and head micro-motion are the seeded rig of the viseme driver (`AVATAR_ENGINE_AUDIO_MOTION=full` takes eyes and head pose from the model too: measured below, less stable) |
| Determinism   | same request + `seed` ⇒ identical frames (seed defaults to a hash of portrait + timeline + fps)                                                                                                                                                                                                     | same audio + `seed` ⇒ same motion on the same machine                                                                                                                                                                                                                                                                                                                                                                           |
| Extra weights | none                                                                                                                                                                                                                                                                                                | 1.65 GB (part of the default download; `--no-audio` leaves them out), loaded lazily and released before rendering                                                                                                                                                                                                                                                                                                               |
| Extra cost    | none                                                                                                                                                                                                                                                                                                | set-up per clip ≈ 10 s for a 3 s clip with the engine warm and the machine quiet (HuBERT + 50 diffusion steps per 3.2 s of audio), +1.8 GB of resident memory while it runs (3.5–3.6 GB peak measured, 1.8–1.9 GB for the viseme driver)                                                                                                                                                                                        |
| At its best   | timelines that are exact (eSpeak NG emits its phoneme events)                                                                                                                                                                                                                                       | natural-sounding speech: neural voices, recordings, any audio whose timeline is estimated, late or missing                                                                                                                                                                                                                                                                                                                      |

Both produce driving keypoints for the same LivePortrait generator; stitching, rendering,
paste-back, matte and encoding are shared.

### Who chooses: `driver`

| `driver`   | What the engine does                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| absent     | the rule older clients rely on, unchanged: the timeline when one is sent, the audio model otherwise                                                                                                                                                                                                                                                                                                                                                                      |
| `visemes`  | the timeline rig (400 `visemes_required` without a timeline)                                                                                                                                                                                                                                                                                                                                                                                                             |
| `audio`    | the audio-driven lips (503 `weights_missing` when the audio weights are not downloaded)                                                                                                                                                                                                                                                                                                                                                                                  |
| **`auto`** | the best available — what Parlante's render worker sends. With both drivers usable (`AVATAR_ENGINE_AUTO_DRIVER=fit`, the default) the audio model runs, the mouth opening each driver would command is correlated with the loudness of **this clip**, and the timeline is kept only when it follows the sound better by more than 0.05; otherwise the lips follow the audio. The result says which one ran and both scores (`driver`, `stats.driverReason`, `stats.fit`) |

`auto` never fails for an optional model: without the audio weights, or with less than 2.5 GB
of free memory, it uses the timeline (`driverReason: audio_weights_missing` / `low_memory`); a
silent clip is animated with the mouth at rest and never loads the audio model (`silent`); only
speech without any timeline and without the audio weights cannot be animated (503).
`AVATAR_ENGINE_AUTO_DRIVER=audio` or `visemes` fixes the choice instead of measuring.
`GET /health → animation` announces `{ autoDriver, key }`; `key` changes with anything that
changes the pixels of an `auto` clip, and Parlante's worker makes it part of its clip-cache key.

### Measured comparison (2026-11-24)

Three stock avatars (`lucia`, `diego`, `samuel`) × two languages × two voices, the same sentence
per language ("Buenos días. Empezamos pronto, amigos." / "My brother made a big map. Please
stop.", 2.5–2.9 s, 30 fps, 512 px, seed 7): 33 clips rendered with
`scripts/compare_drivers.py` and measured on the **pixels of the encoded clip** and the samples
of the WAV (`scripts/lip_metrics.py`). Nobody listened or watched to produce these numbers; the
frames were also looked at as contact sheets. Each cell is the mean over the three avatars
(range in brackets where it matters).

| Voice     | Lang. | Driver                                          | n   | Mouth–loudness corr. (lag 0) | Lag of the lips (ms) | Lip ratio in pauses (max) | Lip ratio speaking (mean) | Largest step per frame | Identity PSNR (dB) | Face-shape drift (%) | Background MAD | Blinks | Head travel X / Y (% eye dist.) | Head jitter (%) | s / frame (load avg) | Set-up (s) |
| --------- | ----- | ----------------------------------------------- | --- | ---------------------------- | -------------------- | ------------------------- | ------------------------- | ---------------------- | ------------------ | -------------------- | -------------- | ------ | ------------------------------- | --------------- | -------------------- | ---------- |
| eSpeak NG | es    | `visemes`                                       | 3   | 0.54 (0.53…0.55)             | 10 (10…10)           | 0.006                     | 0.183 (0.180…0.185)       | 0.43                   | 27.0               | 5.3                  | 3.28           | 1      | 6.9 / 7.3                       | 0.56            | 1.46 (5.1)           | 3.9        |
| eSpeak NG | es    | `audio` full (Ditto as published)               | 3   | 0.30 (0.27…0.35)             | 3 (0…10)             | 0.004                     | 0.103 (0.067…0.128)       | 0.15                   | 24.3               | 6.5                  | 3.29           | 1      | 4.0 / 12.6                      | 0.33            | 1.62 (5.2)           | 12.5       |
| eSpeak NG | es    | `audio` lips, raw displacement                  | 3   | 0.28 (0.26…0.33)             | 53 (0…160)           | 0.006                     | 0.098 (0.065…0.122)       | 0.16                   | 27.7               | 5.3                  | 3.28           | 1      | 6.9 / 6.0                       | 0.35            | 1.49 (4.9)           | 12.4       |
| eSpeak NG | en    | `visemes`                                       | 3   | 0.54 (0.52…0.56)             | 30 (30…30)           | 0.007                     | 0.188 (0.186…0.190)       | 0.35                   | 23.7               | 5.2                  | 3.28           | 1      | 6.3 / 8.4                       | 0.55            | 1.85 (5.8)           | 0.0        |
| eSpeak NG | en    | `audio` full (Ditto as published)               | 3   | 0.63 (0.62…0.64)             | -3 (-10…0)           | 0.006                     | 0.140 (0.119…0.159)       | 0.18                   | 24.8               | 7.7                  | 3.30           | 1      | 6.7 / 11.0                      | 0.44            | 1.99 (6.7)           | 11.4       |
| eSpeak NG | en    | `audio` lips, raw displacement                  | 3   | 0.63 (0.61…0.67)             | -3 (-10…0)           | 0.005                     | 0.131 (0.118…0.148)       | 0.18                   | 23.8               | 4.7                  | 3.28           | 1      | 6.4 / 7.4                       | 0.46            | 1.82 (6.1)           | 11.4       |
| eSpeak NG | en    | `auto` → `audio` (lips, calibrated; final code) | 3   | 0.66 (0.64…0.68)             | 3 (0…10)             | 0.006                     | 0.147 (0.143…0.152)       | 0.20                   | 23.7               | 5.0                  | 3.30           | 1      | 6.4 / 7.7                       | 0.54            | 2.47 (9.4)           | 17.6       |
| Kokoro    | es    | `visemes`                                       | 3   | 0.18 (0.17…0.19)             | 53 (50…60)           | 0.080                     | 0.180 (0.176…0.183)       | 0.40                   | 25.8               | 5.6                  | 3.28           | 1      | 5.7 / 8.2                       | 0.60            | 2.19 (7.6)           | 0.9        |
| Kokoro    | es    | `audio` (lips, calibrated)                      | 3   | 0.39 (0.37…0.42)             | 10 (10…10)           | 0.006                     | 0.162 (0.160…0.165)       | 0.24                   | 26.3               | 5.2                  | 3.30           | 1      | 5.9 / 7.5                       | 0.47            | 2.23 (8.2)           | 11.8       |
| Kokoro    | en    | `visemes`                                       | 3   | 0.17 (0.15…0.17)             | 200 (200…200)        | 0.007                     | 0.128 (0.125…0.131)       | 0.40                   | 24.2               | 4.9                  | 3.29           | 1      | 6.1 / 7.8                       | 0.56            | 2.38 (8.4)           | 0.0        |
| Kokoro    | en    | `audio` (lips, calibrated)                      | 3   | 0.31 (0.29…0.33)             | 37 (30…40)           | 0.007                     | 0.150 (0.139…0.160)       | 0.21                   | 23.9               | 5.1                  | 3.27           | 1      | 6.4 / 7.7                       | 0.53            | 2.41 (8.3)           | 12.7       |

How to read it:

- **Mouth–loudness correlation**: Pearson correlation between the mouth opening measured on each
  frame (inner-lip gap / mouth width, FaceMesh landmarks) and the RMS loudness of that frame's
  audio, with no lag allowed. It is a proxy — closed-mouth voiced sounds and quiet open ones
  lower it for any driver — so compare rows, do not read it as an absolute score.
- **Lag**: the shift of the mouth track (10 ms steps, ±200 ms) with the highest correlation;
  positive = the lips move after the sound. 200 means "at least 200".
- **Identity PSNR**: upper face of every frame, aligned on eye corners and nose bridge, against
  the portrait (median over the clip). A pixel measure of "still the same face"; no
  face-recognition model is shipped. **Face-shape drift**: 95th percentile of the change of two
  face proportions. **Background MAD**: mean absolute difference to the portrait over the pixels
  the matte calls background (0…255); the ≈ 3.3 common to every row is the fixed offset of the
  pasted crop, not motion.
- **s / frame** was measured while another build kept the machine at a load average of 5–9, so
  it is two times the idle figure of "Measured performance"; the set-up column is the cost the
  audio model adds per clip under that same load (10–11 s for these clips at a load average of 1–3.5: 3–5 s to load HuBERT, ≈ 0.6 s of features per second of audio, 2 s to load the motion model, ≈ 3 s per 3.2 s window of 50 diffusion steps).

What it shows:

1. **A timeline is only as good as its timing.** eSpeak's timeline is exact and the viseme rig
   scores 0.54 in both languages. The Kokoro timeline of the day ran 50 ms (es) and ≥ 200 ms
   (en) behind its audio: the same rig drops to 0.17–0.18 and, in Spanish, keeps the mouth open
   into the pauses (lip ratio 0.08 against 0.006). The audio driver cannot be late: 0.39 / 0.31
   on the same clips with a lag of 10–40 ms (about one frame).
2. **The audio model is at home in natural English, not in robotic Spanish**: on eSpeak it scores
   0.63 in English (better than the timeline at lag 0) and 0.28–0.30 in Spanish (worse).
3. **Raw audio-driven lips mumble on some faces**: the published displacement opened `diego`'s
   mouth to a mean lip ratio of 0.065 against 0.12 for `lucia` on the same sentence. Sending the
   opening through each avatar's mouth calibration plus the per-clip articulation gain (0.85–1.39
   measured) brings every avatar to 0.15–0.16, close to the viseme rig's 0.18.
4. **Eyes and head from the audio model cost stability**: with `full` motion the head travels
   11–13 % of the eye distance vertically (6–8 % with the seeded rig), the face-shape drift rises
   from 5 % to 6.5–7.7 % and the identity PSNR falls by up to 3 dB. Lips-only motion is as stable
   as the viseme driver on every measure, and blinks once in 3 s like it.
5. Background, identity and blink figures are otherwise the same for all drivers: they share
   the generator, the paste-back and the rig.

**Decision.** No driver is best everywhere, so `auto` measures instead of assuming: per clip, it
keeps the mouth track that follows the sound better (table below; no rendering involved, only
the audio model's set-up). The audio driver is the lips-only variant with calibrated opening;
`full` stays available as a setting.

| Voice     | Lang. | Fit of the timeline | Fit of the audio-driven lips (3 avatars) | `auto` keeps | Articulation gain |
| --------- | ----- | ------------------- | ---------------------------------------- | ------------ | ----------------- |
| eSpeak NG | es    | 0.56                | 0.33 (0.29…0.35)                         | `visemes`    | 1.02…1.39         |
| eSpeak NG | en    | 0.53                | 0.67 (0.65…0.70)                         | `audio`      | 0.90…1.03         |
| Kokoro    | es    | 0.18                | 0.45 (0.44…0.46)                         | `audio`      | 1.02…1.33         |
| Kokoro    | en    | 0.14                | 0.35 (0.34…0.35)                         | `audio`      | 0.85…0.85         |

The last eSpeak row of the first table is that decision rendered and measured (`driver: "auto"`, final code): 0.66 at a lag of 0–10 ms, against 0.54 for the timeline on the same clips.

**After the Kokoro timeline was corrected** (it ran behind its audio; the voice provider now
places every symbol 75 ms earlier, `docs/MODELS.md`), the Kokoro rows of both tables above no
longer describe what `auto` does: its timeline now scores like eSpeak's, and `auto` keeps the
viseme rig on most short Kokoro clips. Measured again with the corrected timeline (no rendering,
avatars `lucia` and `diego`):

| Kokoro clip                                     | Fit of the timeline | Fit of the audio-driven lips | `auto` keeps |
| ----------------------------------------------- | ------------------- | ---------------------------- | ------------ |
| `ef_dora`, es, the 2.8 s sentence of the table  | 0.58                | 0.48 … 0.50                  | `visemes`    |
| `em_alex`, es, same sentence                    | 0.37                | 0.36 … 0.42                  | `audio`      |
| `af_heart`, en, the 2.5 s sentence of the table | 0.31                | 0.24 … 0.26                  | `visemes`    |
| `ef_dora`, es, "Hola, bienvenidos a Parlante."  | 0.54                | 0.25 … 0.29                  | `visemes`    |
| `ef_dora`, es, "Hola, soy Carmen."              | 0.77                | 0.60 … 0.62                  | `visemes`    |
| `ef_dora`, es, a 5.2 s sentence                 | 0.29                | 0.34 … 0.38                  | `audio`      |

One of them rendered both ways through the product (stock avatar `real_lucia`, 2.8 s, 85
frames) and measured on the pixels of the exported MP4: `auto` → `visemes` 0.70 at a lag of
+20 ms, largest lip change per frame 0.33; engine started with `AVATAR_ENGINE_AUTO_DRIVER=audio`
→ 0.57 at +20 ms, largest change 0.24; lips in the pauses 0.007 in both. Both follow the sound;
which one LOOKS more natural was not judged (nobody watched the clips at speed). Set
`AVATAR_ENGINE_AUTO_DRIVER=audio` to have the audio model move the lips of every clip.

### Tuning of the audio-driven lips (what was checked)

- **Pauses**: frames more than 120 ms away from sound rest exactly on the portrait's own mouth;
  the closure weight rises and falls over 3 frames inside the pause, never across speech
  (largest change 0.33 per frame, unit test). Measured lip ratio in pauses: 0.005–0.008 (max over
  the clip) for every audio variant, standard deviation ≤ 0.002 — no tremble.
- **Bilabials**: with a timeline that follows the sound (its own fit ≥ 0.4, as eSpeak's) every
  /p b m/ cue closes the lips within a frame of its instant; with a timeline that does not, the
  closure is snapped to the lowest point of the audio-driven opening within ±90 ms and skipped
  when there is no dip there. Measured lip ratio at the /p b m/ instants of eSpeak's exact timeline: 0.004 mean, 0.008 worst (8 bilabials × 3 avatars, final code), against 0.032 mean and 0.147 worst before the timeline was trusted; the viseme rig gives 0.004–0.005.
- **Transitions**: the largest change of the lip ratio between two frames is 0.21–0.24 for the
  audio driver against 0.35–0.43 for the viseme rig (a full vowel-to-closure swing in one frame).
- **Timing over a long clip**: motion is produced at 25 fps in 3.2 s windows and resampled by
  time at the centre of each output frame, so it cannot accumulate an offset (unit test over
  60 s). A 10.5 s Kokoro clip (316 frames, `auto` → `audio`, fit 0.438 against 0.042 for its timeline) was rendered once: lag of the lips 0 ms in the first 3.5 s, +10 ms in the middle, −10 ms in the last 3.5 s; 3 blinks; lip ratio in pauses ≤ 0.008; set-up 38 s and 1.67 s per frame at a load average of 7.
- **End to end**: a 3.6 s video rendered through the API (worker + this engine, stock avatar
  `real_diego`, Kokoro voice, `driver: "auto"`): the engine kept the audio driver (fit 0.67
  against 0.27 for the timeline); measured on the exported 720p MP4, the mouth–loudness
  correlation is 0.61 at lag 0 (0.64 at +30 ms), the lip ratio stays ≤ 0.009 in the pauses and
  the avatar blinks once. 109 frames in 145 s of engine time (1.15 s per frame at a load average
  of 2–4, plus 20 s of set-up in a cold process).

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
released after two idle minutes. It is part of the default download, but `prepare` does not
depend on it: when its weights are missing or it fails at run time, `prepare` degrades to the
MediaPipe selfie segmenter instead of failing (`result.matteModel` says which one was used).

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

| Variable                                                             | Default                 | Meaning                                                                                                        |
| -------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `AVATAR_ENGINE_URL`                                                  | `http://127.0.0.1:8090` | only the **port** is taken from it (the engine binds to loopback)                                              |
| `AVATAR_ENGINE_HOST`                                                 | `127.0.0.1`             | bind address. A non-loopback value **requires** `AVATAR_ENGINE_TOKEN` (the server refuses to start otherwise)  |
| `AVATAR_ENGINE_PORT`                                                 | from the URL            | overrides the port                                                                                             |
| `AVATAR_ENGINE_TOKEN`                                                | —                       | when set, every request except `GET /health` needs `Authorization: Bearer <token>`                             |
| `AVATAR_ENGINE_WORK_DIR`                                             | `./data/avatar-engine`  | directory shared with the Node worker; the **only** place the API reads or writes files                        |
| `AVATAR_ENGINE_MODELS_DIR`                                           | `./data/models`         | weight cache (never committed)                                                                                 |
| `AVATAR_ENGINE_MODEL_SEARCH_DIRS` / `HF_HOME`                        | —                       | extra Hugging Face caches whose verified files are reused in place                                             |
| `AVATAR_ENGINE_THREADS`                                              | CPU count (max 8)       | inference threads                                                                                              |
| `AVATAR_ENGINE_BACKEND`                                              | `auto`                  | `auto` \| `openvino` \| `onnxruntime`                                                                          |
| `AVATAR_ENGINE_PRECISION`                                            | `auto`                  | OpenVINO precision: `auto` (bf16 where supported) \| `f32` \| `bf16`                                           |
| `AVATAR_ENGINE_DEVICE`                                               | `auto`                  | `auto` \| `cpu` \| `gpu`                                                                                       |
| `AVATAR_ENGINE_SHARPEN`                                              | `0.6`                   | unsharp-mask amount on generated crops (0 = off)                                                               |
| `AVATAR_ENGINE_PORTRAIT_MAX_SIDE`                                    | `768`                   | side of prepared portraits                                                                                     |
| `AVATAR_ENGINE_PORTRAIT_STEPS`                                       | `20`                    | sampler steps of portrait generation (8…40; time is linear in it)                                              |
| `AVATAR_ENGINE_PORTRAIT_GUIDANCE`                                    | `5.5`                   | classifier-free guidance of portrait generation (1.5…12)                                                       |
| `AVATAR_ENGINE_PORTRAIT_ATTEMPTS`                                    | `4`                     | attempts (different seeds) while the automatic quality control fails (1…6)                                     |
| `AVATAR_ENGINE_MAX_IMAGE_MB` / `_MAX_AUDIO_MB` / `_MAX_CLIP_SECONDS` | 25 / 200 / 600          | input limits                                                                                                   |
| `AVATAR_ENGINE_JOB_TTL_SECONDS`                                      | `3600`                  | how long a finished job stays queryable through `GET /v1/jobs/{jobId}` (60…86400)                              |
| `AVATAR_ENGINE_STARTUP_BENCHMARK`                                    | `1`                     | measure the generator at first start when no measurement exists                                                |
| `AVATAR_ENGINE_AUDIO_FEATURES_BACKEND`                               | `onnxruntime`           | `openvino` = faster HuBERT, +0.7 GB RAM                                                                        |
| `AVATAR_ENGINE_AUTO_DRIVER`                                          | `fit`                   | `driver: "auto"`: `fit` (per clip, keep the mouth track that follows the sound better) \| `audio` \| `visemes` |
| `AVATAR_ENGINE_AUDIO_MOTION`                                         | `lips`                  | audio driver: `lips` = only the lips come from the audio model \| `full` = eyes and head pose too              |
| `AVATAR_ENGINE_AUDIO_LIP_GAIN` / `_AUDIO_LIP_ADVANCE_MS`             | `1.0` / `0`             | audio driver: gain on the lip displacement (0.5…2) and ms the lips run ahead of the sound (−200…200)           |
| `AVATAR_ENGINE_CUDA_GENERATOR`                                       | automatic               | GPU only: `whole` \| `split` generator layout (see "GPU and Windows")                                          |
| `AVATAR_ENGINE_SKIP_DOWNLOAD`, `AVATAR_ENGINE_DOWNLOAD_ARGS`         | —                       | `run.sh` only                                                                                                  |
| `FFMPEG_PATH`                                                        | `ffmpeg`                | ffmpeg binary                                                                                                  |

Relative directories resolve from the repository root, exactly like `packages/providers`.

## API notes beyond the contract

All additions are optional and ignored by clients that do not know them.

- Requests: `words` (word timeline → nods on word onsets), `driver` (`auto` \| `visemes` \| `audio`;
  see "Who chooses: `driver`" — a request without the field behaves exactly as before),
  `seed` on `/v1/animations`; `clientRef` on every POST (a queued/running job with the same kind and
  reference is returned instead of starting a second one).
- Job errors carry `reason`, a stable key for i18n. Reasons of `prepare`: `no_face`,
  `multiple_faces`, `face_unclear`, `face_too_small`, `face_cut_off`, `not_frontal`, `head_tilted`,
  `image_too_small`, `image_too_large`, `unsupported_image`, `image_unreadable`,
  `no_face_at_landmarks`. Others: `weights_missing`, `path_outside_work_dir`, `file_not_found`,
  `file_too_large`, `not_wav`, `audio_empty`, `audio_too_long`, `out_of_memory`, `queue_full`,
  `visemes_required`.
  The `message` is a complete English sentence that can be shown as is.
- Results: `prepare` adds `previewPath`, `pose`, `matteModel`; `animate` adds `driver`, `seed` and
  `stats` (seconds per frame, load average, peak RSS, frame hash of that very run; `driverRequested`,
  `driverReason`, and for the audio model `fit`, `audioSetupSeconds`, `audioArticulationGain`).
- `/health` adds `drivers`, `performance` (per driver: `secondsPerFrame`, `minutesPer10sVideo`,
  `peakRssMb`, when it was measured and under which load), `backend` (with `gpuNote`), `queue`,
  `animation` (`autoDriver`, `key`) and `privacy` (the telemetry switches).
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

## Privacy: nothing leaves the machine

The engine makes **no outbound connection** while it runs (the only download is the explicit,
checksummed `scripts/download_models.py`). Two of its libraries do phone home by default, and
that is switched off before they are imported (`parlante_engine/core/privacy.py`, called from
the package's `__init__`, so the server, every script and the tests are covered):

| Library            | What it does by default (measured here, 2026-11-24)                                                                                                                                                           | Switch                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| onnxruntime 1.32.0 | creating one session writes `~/.cache/Microsoft/DeveloperTools/.onnxruntime/{deviceid,onnxruntime.db}` (a persistent device id and an event queue) and opens `CONNECT mobile.events.data.microsoft.com:443`   | `ORT_DISABLE_TELEMETRY=1` in the process environment before the library initialises (its `Privacy.md`) |
| openvino 2026.4.1  | `import openvino` alone (it imports its conversion tools, which use the `openvino_telemetry` package) writes `~/intel/{openvino_ga_cid,stats}` (a client id) and opens `CONNECT www.google-analytics.com:443` | `openvino_telemetry` is made unimportable; OpenVINO then uses its own no-op `telemetry_stub`           |
| huggingface_hub    | never called (installed only as a dependency of `tokenizers`)                                                                                                                                                 | `HF_HUB_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`                                                       |

How it was measured: a child process with an **empty `HOME`** and every proxy variable pointing at
a local sink that records who connects, running real ONNX Runtime and OpenVINO sessions; and the
real server under `strace -e trace=connect` through start-up, `prepare`, `animate` (both
drivers) and `generate` (results in "Measured" below). `tests/test_privacy.py` repeats the first
measurement on every test run, with a negative control (the same workload without the switches
must be caught, otherwise the test says it could not prove anything). `GET /health → privacy`
reports the switches.

Measured with the switches in place, real server (`AVATAR_ENGINE_STARTUP_BENCHMARK=1`):

| Phase (real server over HTTP, empty `HOME`, proxies → sink, `strace`)                                | Connections seen by the sink                                                                                 | `connect()` calls other than to the engine's own port | Files written under `HOME`                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| start-up + benchmark, then 22 s idle                                                                 | 0                                                                                                            | 0                                                     | 0                                                                                   |
| `prepare` (face detection, matte, calibration renders)                                               | 0                                                                                                            | 0                                                     | 0                                                                                   |
| `animate` twice: `driver: "visemes"`, then `"auto"` (it chose the audio model)                       | 0                                                                                                            | 0                                                     | 0                                                                                   |
| `generate` (384 px portrait, 8 steps)                                                                | 0                                                                                                            | 0                                                     | 0                                                                                   |
| **control**: same server with the libraries initialised first (as before this change), start-up only | 4 in 23 s: `www.google-analytics.com:443` at 0.5 s, `mobile.events.data.microsoft.com:443` at 9, 15 and 23 s | 4 (to the proxy)                                      | 6: the device id, the event queue (3 files), `intel/openvino_ga_cid`, `intel/stats` |

If an earlier version of the engine ran on your machine, the identifiers it left behind can be
deleted: `~/.cache/Microsoft/DeveloperTools/.onnxruntime/` and `~/intel/openvino_ga_cid`,
`~/intel/stats`, `~/intel/openvino_telemetry`.

Embedding the engine in another Python program: import `parlante_engine` **before**
`onnxruntime` / `openvino`; otherwise it warns that their telemetry could not be stopped in time.

## GPU and Windows (prepared, NOT verified: there is no GPU on the build machine)

Everything in this section was written and reviewed by reading the code; none of it has run on a
GPU or on Windows. `python -m parlante_engine.selftest` exists so that you can find out on your
own machine in a couple of minutes.

### Self-test

```bash
.venv/bin/python -m parlante_engine.selftest --json selftest.json     # Linux / macOS / WSL2
.venv\Scripts\python -m parlante_engine.selftest --json selftest.json  # Windows (native, untested)
```

It prints the platform, CPU features, RAM, library versions and execution providers; whether
the CUDA provider **really starts** (and if not, why); every model and whether it is downloaded;
then it loads the models, times the generator (on a GPU: both layouts, see below), prepares the
bundled synthetic face, animates one second with the viseme driver and one with the audio driver
and generates one 384 px portrait in 8 steps — seconds, seconds per frame, resident memory and
(with `nvidia-smi`) GPU memory for every step. Steps whose weights are missing are `SKIPPED`;
`--quick` skips the audio driver and the portrait. Exit status 1 when a step fails. Nothing is
downloaded and nothing is sent anywhere: the JSON is for you to read or to attach to a report.
Measured on the build machine (CPU): see "Measured performance".

### What the CUDA path does (code review)

- **Detection** (`core/backends.py`): `onnxruntime-gpu` lists `CUDAExecutionProvider` even when
  the driver or the CUDA / cuDNN libraries are missing, and a session then falls back to the CPU
  without an error. The engine therefore creates a one-node session and checks which provider it
  actually runs on (`probe_cuda`) before it reports `device: "gpu"`; when the GPU cannot be used
  `/health → backend.gpuNote` and the self-test say why, and the engine keeps the fast OpenVINO
  CPU path instead of a slow f32 fallback. `onnxruntime.preload_dlls()` is called so that CUDA and
  cuDNN installed as pip wheels are found. `AVATAR_ENGINE_DEVICE=cpu` forces the CPU.
- **Generator** (`animate/generator.py`): the graph has two 5-D `GridSample` nodes. Stock
  onnxruntime-gpu builds have not had a CUDA kernel for 5-D `GridSample`, so two layouts exist:
  `whole` (the original graph on the GPU) is tried first with one real inference; if it raises,
  `split` is used — the three convolutional stages on the GPU and the two `GridSample` nodes on
  the CPU provider, the same split the CPU path uses with OpenVINO. The split plumbing is verified
  on the CPU provider: its output is bit-identical to the whole graph (slow test); only the CUDA
  kernels themselves are unverified. The two `GridSample` nodes take 0.13 s per frame on the
  build CPU (4 cores), so the split layout cannot go much beyond 7 frames per second there,
  whatever the GPU; the whole-graph layout has no such floor. `AVATAR_ENGINE_CUDA_GENERATOR=whole|split` forces one; the self-test times both.
- **Audio driver**: HuBERT and the motion model run on the CUDA provider when it is usable
  (`allow_gpu=True`); 1.65 GB of weights, well inside 8 GB of video memory together with the
  generator.
- **Stay on the CPU on purpose**: the small keypoint networks, face detection and the matte
  (milliseconds); and **portrait generation**, which is written for OpenVINO only. On a Ryzen
  7840HS (Zen 4: AVX-512 with BF16) OpenVINO should choose the bf16 path that this README measures
  on the build CPU — the self-test prints the precision it chose.
- **Not done**: TensorRT, half precision on the GPU, DirectML, Intel / AMD GPUs through OpenVINO.

### Windows: what stops a native run today, and the shortest way

Evaluated by reading the code and the PyPI metadata of the pinned packages; **not implemented**.

| Obstacle to a native Windows run                                                                                                                                                                                                                                  | Size                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `run.sh` is bash (creates the venv, hashes `requirements.txt` with `sha256sum`, calls `.venv/bin/python`; on Windows the interpreter is `.venv\Scripts\python.exe`) and `pnpm avatar-engine` calls it                                                             | a launcher in Node or PowerShell (~60 lines)          |
| The rest of Parlante starts Postgres and Redis with `scripts/dev-services.sh` (bash)                                                                                                                                                                              | outside the engine                                    |
| Wheels: every pinned package publishes `win_amd64` wheels for Python 3.12 / 3.13 (checked on PyPI: onnxruntime, onnxruntime-gpu, openvino, ai-edge-litert, opencv-python-headless, tokenizers, numpy), so installation should work — **never installed there**    | to verify                                             |
| Code: `os.getloadavg()` and the `resource` module (Unix only) were called in every job — **fixed in this version** (`perf.load_avg`, `perf.peak_rss_mb`); `malloc_trim` is skipped off Linux; paths go through `pathlib`; hard links of `--import-from` need NTFS | done / small                                          |
| The work directory must be the **same absolute path** for the Node worker and the engine: fine when both are native, impossible with the engine in WSL2 and the worker on Windows (`C:\…` vs `/mnt/c/…`)                                                          | decides the layout                                    |
| GPU natively: `onnxruntime-gpu` 1.32 has a Windows wheel built for CUDA 13 + cuDNN 9 (`pip install "onnxruntime-gpu[cuda,cudnn]==1.32.0"` pulls NVIDIA's runtime wheels). `onnxruntime-directml` stops at 1.24.4 on PyPI and the engine has no DirectML code path | CUDA: to verify; DirectML: new code + another ORT pin |
| Nothing — tests, smoke scripts, the self-test — has ever run on Windows                                                                                                                                                                                           | the real cost                                         |

**Shortest way: run the whole of Parlante inside WSL2**, with the GPU exposed by the Windows
NVIDIA driver. It needs no code change, it is the platform the engine is tested on, and CUDA in
WSL2 is the configuration NVIDIA and Microsoft support. A native port is perhaps two days of
work plus verification on a real machine (launcher, a pass over the test suite, the CUDA DLLs),
and DirectML is the longest of the three (different runtime version, no code path, 5-D
`GridSample` support unknown).

#### WSL2 with the NVIDIA driver — exact steps (NOT verified)

1. Windows 11 (or Windows 10 21H2 or later). Install the current **NVIDIA driver for Windows**
   (Game Ready or Studio; CUDA 13 needs the 580 branch or newer). Do **not** install a Linux
   NVIDIA driver inside WSL: the Windows driver provides `/usr/lib/wsl/lib/libcuda.so`.
2. PowerShell as administrator: `wsl --install -d Ubuntu-24.04`, restart, then `wsl --update`.
3. Give WSL enough memory (the default is half of the RAM; the engine peaks at 4–6 GB next to
   Postgres, Redis, the API and the worker). `%UserProfile%\.wslconfig`:

   ```ini
   [wsl2]
   memory=12GB
   swap=8GB
   ```

   then `wsl --shutdown` and open Ubuntu again.

4. Inside Ubuntu, `nvidia-smi` must list the card (for example "RTX 4060 Laptop GPU, 8188 MiB").
   If it does not, the driver or WSL is too old: stop here.
5. `sudo apt update && sudo apt install -y python3 python3-venv ffmpeg git curl` (Ubuntu 24.04
   ships Python 3.12), then Node 22, pnpm, Postgres and Redis as the main README describes.
6. Clone the repository **inside the Linux file system** (`~/parlante`, not `/mnt/c/…`: the
   Windows mount is several times slower and both processes must see the work directory at the
   same path), then `pnpm install`.
7. `bash services/avatar-engine/run.sh --setup` (virtualenv, pinned CPU requirements, weights;
   the audio driver is part of the default set).
8. Swap the CPU runtime for the GPU one, with NVIDIA's CUDA 13 and cuDNN 9 runtime wheels
   (proprietary NVIDIA licence, free of charge, about 2 GB):

   ```bash
   cd services/avatar-engine
   .venv/bin/pip uninstall -y onnxruntime
   .venv/bin/pip install "onnxruntime-gpu[cuda,cudnn]==1.32.0"
   ```

   (`run.sh` reinstalls `requirements.txt` only when that file changes; repeat this step then.)

9. `.venv/bin/python -m parlante_engine.selftest --json selftest.json`. Expected: `cudaUsable:
true`, `device: "gpu"`, a generator backend that names `CUDAExecutionProvider`, and seconds per
   frame far below the CPU figure of this README. If `cudaUsable` is false the `cudaNote` line
   says what is missing. Keep the JSON: it is the first measurement of this engine on a GPU.
10. `pnpm services`, `pnpm db:migrate`, `pnpm avatar-engine`, `pnpm dev`; open
    `http://localhost:5173` in the Windows browser (WSL2 forwards `localhost`).

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
  selftest.py `python -m parlante_engine.selftest`: self-diagnosis of this machine
              (core/privacy.py: telemetry switches, applied when the package is imported)
scripts/      download_models.py, smoke.py (+ validate_contract.ts), render_clip.py, eval_clip.py, benchmark.py,
              compare_drivers.py + lip_metrics.py (the driver comparison of this README)
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
- The **audio driver** is not bit-exact across machines (diffusion noise + floating point). Its
  model was trained on natural speech: on robotic Spanish (eSpeak) its lips follow the sound
  worse than an exact timeline does (measured, "Measured comparison"), which is why `auto`
  compares the two per clip. Its articulation is normalised per clip within 0.85–1.75×: a
  whispered sentence is not rendered as a whisper.
- **Lip-sync is measured by proxy**: every figure of the comparison is a correlation between
  mouth opening and loudness, measured on pixels. Nobody listened to or watched the clips at
  speed; perceived naturalness with a human voice has not been assessed.
- The matte is tracked, not re-estimated: very fast head motion could leave a thin halo (not
  observed with the motion amplitudes above).
- Frontal, single-person portraits only (|yaw|, |pitch| ≤ 25°); glasses and beards work, hands or
  objects in front of the face do not.

## Troubleshooting

| Symptom                                           | Cause / fix                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `503 SERVICE_UNAVAILABLE … weights missing`       | run `python scripts/download_models.py` (the audio driver is part of the default set; `--no-audio` / `--minimal` leave it out); `--list` shows what is missing           |
| `Checksum mismatch` while downloading             | a truncated or altered file: it is deleted; run the script again                                                                                                         |
| Download hangs behind a proxy                     | set `HTTPS_PROXY` and, for a custom CA, `SSL_CERT_FILE`; downloads resume where they stopped                                                                             |
| `Refusing to listen on 0.0.0.0`                   | set `AVATAR_ENGINE_TOKEN` (and the same variable for the worker)                                                                                                         |
| `400 … path is outside the engine work directory` | the worker and the engine do not share `AVATAR_ENGINE_WORK_DIR` at the same absolute path                                                                                |
| `422 UNPROCESSABLE` on `prepare`                  | see `error.reason` (no face, several faces, too small, not frontal…) and show the message to the user                                                                    |
| Very slow (≥ 4 s/frame)                           | CPU without bf16 or OpenVINO missing (`/health → backend`), or the machine is busy; lower `fps` to 25 or `maxSize` does **not** help (the generator always renders 512²) |
| `MemoryError` / killed during an audio-driven job | the audio driver needs ≈ 4 GB of RAM in total; `auto` already avoids it below 2.5 GB free — set `AVATAR_ENGINE_AUTO_DRIVER=visemes` or ask for `driver: "visemes"`       |
| `ffmpeg was not found`                            | install ffmpeg or set `FFMPEG_PATH`                                                                                                                                      |
| ETA looks wrong right after start                 | it is the startup benchmark's figure; it converges to the real speed after the first job                                                                                 |
