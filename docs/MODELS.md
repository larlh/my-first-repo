# Models of the local neural avatar engine and of local speech recognition

Every weight file `services/avatar-engine` can load, where it comes from, how big it is, its
licence and whether it may be used commercially (master prompt §2b). The machine-readable source
of truth is each sub-package's `models.py` (`repo`, pinned `revision`, `sha256`, `size`, licence);
`python services/avatar-engine/scripts/download_models.py --list` prints the same table with the
state on disk, and `GET /health` reports it to the application.

Rules applied to every entry:

- **Data-only formats** (ONNX, MediaPipe `.tflite`, safetensors). No pickle (`.pth`, `.pt`, `.ckpt`,
  `.pkl`), no `trust_remote_code`; the inference code is ours.
- Downloaded only from `huggingface.co` (pinned revision) or `storage.googleapis.com/mediapipe-models`,
  verified with **sha256** before first use. Weights are never committed.
- Licences were read on the model card / repository of each model on the date below, not assumed.

Licences verified: 2026-11-14.

## Animation, face analysis and matte (owner: motor-animación)

| id (`/health`)                | Role                                                                                                                 | Files (size)                                                                                                                                                                                                        | Origin (repo @ revision)                                                                       | Licence                                                                                  | Commercial use | Notes                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `liveportrait-onnx`           | animation — generator shared by both drivers, appearance / motion encoders, stitching and lip / eye retargeting MLPs | `appearance_feature_extractor.onnx` (3.4 MB), `motion_extractor.onnx` (112.6 MB), `warping_spade.onnx` (421.2 MB), `stitching.onnx` (0.2 MB), `stitching_lip.onnx` (0.2 MB), `stitching_eye.onnx` (0.6 MB) — 538 MB | `warmshao/FasterLivePortrait` @ `eb937f4b…` (`liveportrait_onnx/`)                             | **MIT** (model card `license: mit`; upstream `KlingTeam/LivePortrait`: MIT)              | Yes            | ONNX export of LivePortrait (Kuaishou). Only the six graphs listed are fetched: the repository also hosts InsightFace-derived detectors (`retinaface_det_static.onnx`, `face_2dpose_106_static.onnx`, non-commercial) which the engine does **not** download or use — face analysis uses the MediaPipe models below. |
| `ditto-audio2motion`          | animation — audio driver only (audio without a viseme timeline)                                                      | `hubert.onnx` (1458.7 MB), `lmdm_v0.4_hubert.onnx` (192.5 MB) — 1.65 GB                                                                                                                                             | `digital-avatar/ditto-talkinghead` @ `e4a2f603…` (`ditto_onnx/`)                               | **Apache-2.0** (`LICENSE` file of the repository; the model card carries no licence tag) | Yes            | Ditto (Ant Group): HuBERT speech features + motion-space diffusion. Optional download (`--with-audio`). The card does not document the provenance of the HuBERT checkpoint beyond shipping it under the repository licence.                                                                                          |
| `mediapipe-blazeface-onnx`    | face-detection                                                                                                       | `blaze_face.onnx` (0.4 MB)                                                                                                                                                                                          | `digital-avatar/ditto-talkinghead` @ `e4a2f603…`                                               | **Apache-2.0** (repository `LICENSE`; original MediaPipe model: Apache-2.0)              | Yes            | MediaPipe BlazeFace short-range, ONNX export. Run with our own pre/post-processing in ONNX Runtime (no `mediapipe` wheel).                                                                                                                                                                                           |
| `mediapipe-facemesh-onnx`     | face-detection (478 landmarks)                                                                                       | `face_mesh.onnx` (5.0 MB)                                                                                                                                                                                           | `digital-avatar/ditto-talkinghead` @ `e4a2f603…`                                               | **Apache-2.0** (as above)                                                                | Yes            | MediaPipe FaceMesh with irises, ONNX export.                                                                                                                                                                                                                                                                         |
| `mediapipe-selfie-multiclass` | matting (fallback)                                                                                                   | `selfie_multiclass_256x256.tflite` (16.4 MB)                                                                                                                                                                        | `storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/` | **Apache-2.0** (MediaPipe model card)                                                    | Yes            | Used for the portrait matte only when the dedicated matting model of the next section is not downloaded. Executed with LiteRT (`ai-edge-litert`).                                                                                                                                                                    |

Derived files (not downloaded, built locally from the weights above and cached in
`AVATAR_ENGINE_MODELS_DIR/derived/`): the generator graph `warping_spade.onnx` split into three
convolutional stages and two single-node GridSample graphs so that OpenVINO can run the
convolutions. Same weights, same licence.

Not used, on purpose: InsightFace detectors / landmark models (non-commercial research licence),
any TensorRT plugin binaries shipped in the model repositories, any `.pth` / `.pkl` file.

## Portrait generation and matting (owner: motor-retratos)

| id (`/health`)             | Role                                                           | Files (size)                                                                                                                                                                                                                         | Origin (repo @ revision)                            | Licence                                                                                                                                                                                                           | Commercial use                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realistic-vision-v6-onnx` | portrait-generation — text → portrait of a synthetic presenter | `text_encoder/model.onnx` (492.6 MB), `unet/model.onnx` + `model.onnx_data` (1.2 MB + 3438.1 MB), `vae_decoder/model.onnx` (198.1 MB), `vae_encoder/model.onnx` (136.8 MB), `tokenizer/vocab.json` + `merges.txt` (1.7 MB) — 4.27 GB | `Heliosoph/realistic-vision-cfg-onnx` @ `20f2bfe7…` | **CreativeML OpenRAIL-M** (model card `license: creativeml-openrail-m` + `LICENSE.md` in the repository; upstream `SG161222/Realistic_Vision_V6.0_B1_noVAE`: same tag). VAE: `stabilityai/sd-vae-ft-mse`, **MIT** | **Yes, with use restrictions** | Stable Diffusion 1.5 fine-tune for photographic people, plain ONNX export (optimum). OpenRAIL-M grants commercial use of the model and claims no rights on the outputs, but forbids the uses listed in its Attachment A (illegal or harmful content, harassment, impersonation without consent, medical advice, …) and obliges whoever redistributes the model or offers it as a service to pass those restrictions on. Parlante's terms of use must include them. Download is optional: `download_models.py --all`. |
| `ormbg-onnx`               | matting — person / background alpha matte                      | `onnx/model.onnx` (176.1 MB)                                                                                                                                                                                                         | `onnx-community/ormbg-ONNX` @ `034e2d88…`           | **Apache-2.0** (model card; upstream `schirrmacher/ormbg`: Apache-2.0)                                                                                                                                            | Yes                            | "Open Remove Background Model": IS-Net trained for humans. The upstream card lists its training data as the author's synthetic human dataset plus P3M-10k, AIM-500 and PPM-100 (research matting datasets); the weights themselves are published under Apache-2.0.                                                                                                                                                                                                                                                   |

Derived file (built locally, never downloaded): `derived/portrait/unet_fp16.xml` + `.bin` (1.72 GB), the
OpenVINO IR of the UNet with FP16-compressed weights, written the first time a portrait is generated
(3 s here). Same weights, same licence. Disk for portrait generation: 4.27 GB + 1.72 GB = **5.99 GB**.

### How the portrait generator was chosen

Constraints: photorealistic faces in a medium shot, a licence that allows commercial use, CPU only
(target ≤ 2–3 min per ~768 px image), ≤ 8 GB RAM, ≤ 7 GB disk, data-only weights and **no PyTorch at
run time** (the PyPI `torch` wheel for Linux is the multi-GB CUDA build; the whole engine runs on
OpenVINO / ONNX Runtime). Sizes and licences below were read from the Hugging Face API and model
cards on 2026-11-14; timings are from the build machine (4 vCPU, 4 threads, load average 2–3).

Candidates that were **run** (same four prompts and seeds at 768×768, sheet in
`services/avatar-engine/docs/eval/t2i-candidates.jpg`):

| Candidate                                                               | Licence                                                | Time @768²                                | Result                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LCM-Dreamshaper-v7 (ONNX, 8 LCM steps) — what the R&D prototypes used   | MIT tag (distilled from a CreativeML OpenRAIL-M model) | 21–29 s                                   | Follows the prompt, but the look is digital painting, not photography. **Rejected.**                                                                                                                                                                                                             |
| Realistic Vision 6 + LCM-LoRA fused by us, 8 steps, guidance 1          | OpenRAIL-M + OpenRAIL++                                | 21–29 s                                   | Photographic, but the description is largely ignored without guidance: "50-year-old Black man in a suit" and "East Asian man" both came out as young women; studio equipment in the background. **Rejected.**                                                                                    |
| Same, guidance 1.8 / 2.8 (16 UNet evaluations)                          | idem                                                   | 39–48 s                                   | 1.8: clothing better, gender still wrong. 2.8: over-contrasted, cluttered backgrounds. **Rejected.**                                                                                                                                                                                             |
| **Realistic Vision 6, DPM-Solver++(2M) Karras, 24 steps, guidance 5.5** | OpenRAIL-M                                             | 124–143 s (2.4–2.9 s per UNet evaluation) | Photographic skin and light; age, gender, skin tone and clothing followed in 4 of 4, but poses at 768² are often tilted or turned. **Chosen**, used in two stages: composition and quality control at ≤ 512², then image-to-image at the target size (see the engine README for measured times). |

Candidates discarded on verified data, **without** generating images (stated as such):

| Candidate                                                        | Why not                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDXL base 1.0, RealVisXL V5 (+ Lightning / LCM-LoRA), Hyper-SDXL | Licence fine (OpenRAIL++), but the UNet weighs 10.27 GB in FP32 / 5.14 GB in FP16 — three times the SD 1.5 UNet (3.44 GB), which already peaks at 5.7 GB RSS at 512² and 6.6 GB at 768² here. By proportion (an extrapolation, not a measurement) SDXL does not fit in the 8 GB RAM budget, and the FP32 ONNX exports exceed the 7 GB disk budget. |
| SDXL-Turbo, SD-Turbo                                             | `sai-nc-community` licence / "for commercial use refer to stability.ai/license": not free for commercial use.                                                                                                                                                                                                                                      |
| Stable Diffusion 3.5 Medium                                      | Stability AI Community Licence (gated; commercial use is free only below USD 1 M of annual revenue) and a 9.5 GB T5-XXL text encoder on top of the 4.9 GB transformer.                                                                                                                                                                             |
| FLUX.1 schnell (Apache-2.0)                                      | 23.8 GB transformer + 9.5 GB T5-XXL: far beyond RAM and disk. FLUX.1 dev is non-commercial.                                                                                                                                                                                                                                                        |
| FLUX.2 klein 4B, Z-Image-Turbo (both Apache-2.0)                 | 7.75 GB + 8.05 GB text encoder, and 24.6 GB + 8 GB respectively: beyond RAM and disk.                                                                                                                                                                                                                                                              |
| PixArt-Σ / PixArt-LCM (OpenRAIL++)                               | 2.4 GB transformer but a 19 GB T5-XXL text encoder.                                                                                                                                                                                                                                                                                                |
| Sana / Sana-Sprint 0.6B (Apache-2.0)                             | 7.7 GB on disk, 5.2 GB of it the Gemma-2-2B text encoder under the Gemma Terms of Use (not an open-source licence).                                                                                                                                                                                                                                |
| Hyper-SD LoRAs for SD 1.5                                        | The official repository declares no licence for the SD 1.5 files (its licence file covers only the FLUX and SD3 LoRAs).                                                                                                                                                                                                                            |
| Segmind SSD-1B / Vega (Apache-2.0, distilled SDXL)               | Would fit in RAM (5.3 GB / 3.0 GB FP32 UNets); **not evaluated**: only third-party ONNX exports without a licence tag exist, and Realistic Vision already met the quality and time targets. Worth a test if an Apache-2.0-only stack is ever required.                                                                                             |

Two implementation findings worth keeping: (1) prompts must fit in **one** CLIP window (75 tokens) —
encoding an 80-token prompt as two concatenated windows (73 + 7 or 40 + 40) made the model ignore the
subject's gender and clothing for the same seed, so the template budgets its parts instead; (2)
loading the UNet from a derived FP16 IR instead of compiling the 3.4 GB FP32 ONNX cut the peak RSS at
512² from 7.8 GB to 5.7 GB and the cold start from ~2 minutes to under 10 s (measured on the
architecture-identical LCM-Dreamshaper and Realistic Vision UNets respectively, machine under load).

### How the matting model was chosen

All candidates were run on the same generated portraits, re-composited over magenta and green and
inspected at the hair edge (`services/avatar-engine/docs/eval/matting-candidates.jpg`; OpenVINO, 4
threads, machine under load):

| Candidate                                           | Licence                                        | Time / peak RSS    | Hair edge                                                                                                |
| --------------------------------------------------- | ---------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| MediaPipe selfie multiclass (256 px)                | Apache-2.0                                     | 0.06 s / 0.2 GB    | Blocky, staircase edge; holes inside dark hair and a stray blob on one image. Kept only as the fallback. |
| MODNet (`Xenova/modnet`)                            | Apache-2.0                                     | 0.1 s / 0.4 GB     | Soft, but a wide semi-transparent halo of the old background around hair and shoulders.                  |
| **ORMBG** (`onnx-community/ormbg-ONNX`)             | Apache-2.0                                     | 0.3–0.5 s / 0.7 GB | Crisp edge, strands kept, no halo; slightly translucent in very thin wisps. **Chosen.**                  |
| BiRefNet-lite (`onnx-community/BiRefNet_lite-ONNX`) | MIT                                            | 9–14 s / 3.5 GB    | Marginally more solid inside loose hair than ORMBG; not worth 30× the time and 5× the memory.            |
| BiRefNet-portrait (Swin-L)                          | MIT                                            | 10–18 s / 5.9 GB   | Same quality class; too heavy for a CPU service that also holds the animator.                            |
| RMBG 1.4 / 2.0 (BRIA)                               | non-commercial (`bria-rmbg-1.4`, CC BY-NC 4.0) | —                  | Not evaluated: licence excludes commercial use.                                                          |

## Speech recognition for dictation and local STT (owner: dictation-backend)

Not part of the avatar engine: these models run **inside the Node processes** (API for dictation
by microphone, worker for the transcription of video translations), on the CPU, through
`@huggingface/transformers` + `onnxruntime-node`, in a worker thread. The machine-readable source
of truth is `packages/providers/src/stt/whisper-models.ts` (repository, pinned revision, size and
SHA-256 of every file); `pnpm dictation:setup --list` prints it with the state on disk.

The same rules apply: data-only formats (ONNX graphs and JSON configuration, no pickle, no
`trust_remote_code`), downloaded only from `huggingface.co` at a pinned commit, every file checked
against its size and SHA-256 **before** it takes its final name, never committed, and **never
fetched at run time** (the runtime is configured with remote models disabled and is given an
absolute local path; `pnpm dictation:setup` is the only code that downloads).

Licences verified: 2026-11-24 (model cards read through the Hugging Face API and their README
front matter: `license: apache-2.0` on `Xenova/whisper-base`, `Xenova/whisper-small` and on the
upstream `openai/whisper-base` / `openai/whisper-small` cards).

| id (`DICTATION_MODEL`)   | Role                             | Files (size)                                                                                                                                                                              | Origin (repo @ revision)                                            | Licence        | Commercial use | Notes                                                                                                                                                                       |
| ------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whisper-base` (default) | speech recognition, multilingual | `onnx/encoder_model.onnx` (78.7 MiB, FP32), `onnx/decoder_model_merged_quantized.onnx` (51.2 MiB, int8), `tokenizer.json`, `tokenizer_config.json`, 3 small JSON — **132.5 MiB** (139 MB) | `Xenova/whisper-base` @ `64da57285918e20ea79ea5c88eed7197933abaa8`  | **Apache-2.0** | Yes            | ONNX export of OpenAI Whisper base for Transformers.js. Installed in `DICTATION_MODEL_DIR/Xenova--whisper-base-64da57285918/`.                                              |
| `whisper-small`          | same, larger model               | `onnx/encoder_model_quantized.onnx` (88.0 MiB, int8), `onnx/decoder_model_merged_quantized.onnx` (149.5 MiB, int8), same tokenizer and JSON files — **240.2 MiB** (252 MB)                | `Xenova/whisper-small` @ `2d67713f236afa48a18992566e7647f6ca848e13` | **Apache-2.0** | Yes            | Documented alternative: clearly more accurate, slower than speech on 4 cores (table below). `pnpm dictation:setup --model whisper-small` + `DICTATION_MODEL=whisper-small`. |

SHA-256 of the weight files (the ones the Hub publishes for the LFS objects of those revisions;
the JSON files are pinned the same way in `whisper-models.ts`):

| File                                                       | SHA-256                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `whisper-base` `onnx/encoder_model.onnx`                   | `f0bd7927234639c6e1f293cef18a210cee4e4aea93e200ebbe48e1d7acf6fdb1`  |
| `whisper-base` `onnx/decoder_model_merged_quantized.onnx`  | `a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861`  |
| `whisper-small` `onnx/encoder_model_quantized.onnx`        | `969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06`  |
| `whisper-small` `onnx/decoder_model_merged_quantized.onnx` | `fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24`  |
| both: `tokenizer.json`                                     | `27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566`  |
| both: `tokenizer_config.json`                              | `2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce`  |
| both: `preprocessor_config.json`                           | `a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d`  |
| `whisper-base` `config.json` / `generation_config.json`    | `d1d347fd…6243685b` / `3bba359e…caa38d05` (full values in the code) |
| `whisper-small` `config.json` / `generation_config.json`   | `5a6429d2…d55ab3be` / `0b7407a4…a2223279` (full values in the code) |

Not used, on purpose: `onnx-community/whisper-small` (its model card declares **no licence**),
any `.bin` / `.pt` checkpoint, and the CUDA binaries `onnxruntime-node` can fetch from its
post-install script (the script is not run: pnpm ignores dependency build scripts that are not
allow-listed in `pnpm-workspace.yaml`, and the CPU binaries ship inside the npm package).

### How the speech model was chosen

Measured on the build machine (4 vCPU, 4 inference threads, 15 GB RAM, no GPU) **through the
product code path** (the worker-thread engine of `whisper-engine.ts`, decoding with timestamps,
language given, `cleanTranscript`). Audio: 24 phrases, 106.5 s in total — 12 Spanish and 12
English sentences of 9–17 words, each spoken by two voices of the repository's own eSpeak NG
(no recordings of people), resampled to 16 kHz. One fresh process per row. WER = word error rate
after lower-casing and removing punctuation.

| Model (encoder / decoder)       | Download  | WER es     | WER en    | Compute s per audio s | Median per phrase (4.4 s avg) | First phrase (incl. load) | Peak RSS of the process |
| ------------------------------- | --------- | ---------- | --------- | --------------------- | ----------------------------- | ------------------------- | ----------------------- |
| base, int8 / int8               | 76 MiB    | 48.8 %     | 10.8 %    | 0.31                  | 1.37 s                        | 2.4 s                     | 1.74 GB                 |
| **base, FP32 / int8 — default** | 132.5 MiB | **44.4 %** | **6.8 %** | **0.32**              | **1.40 s**                    | 2.6 s                     | **1.84 GB**             |
| base, FP32 / FP32               | 280 MiB   | 37.7 %     | 5.1 %     | 0.27                  | 1.16 s                        | 3.1 s                     | 2.16 GB                 |
| **small, int8 / int8 — alt.**   | 240.2 MiB | **25.3 %** | **1.1 %** | **1.08**              | **4.60 s**                    | 9.8 s                     | **3.91 GB**             |
| small, FP32 / int8              | 489 MiB   | 23.5 %     | 0.6 %     | 1.19                  | 5.19 s                        | 8.4 s                     | 4.18 GB                 |
| small, FP32 / FP32              | 926 MiB   | 23.5 %     | 0.0 %     | 0.99                  | 4.36 s                        | 12.4 s                    | 5.10 GB                 |
| base default, **no** language   | —         | 44.4 %     | 6.8 %     | 0.56                  | 2.50 s                        | 2.8 s                     | 1.82 GB                 |

What the numbers say, and what they do not:

- **`whisper-base` is the default** because it is the only size that keeps up with speech on a
  4-core CPU: about a third of real time, ~1.4 s for a typical phrase. **`whisper-small` halves
  the Spanish errors and all but removes the English ones, but needs about as long as the speech
  itself** (4.6 s per phrase, with one model instance: a second speaker would queue) and twice the
  memory. It is the right choice for a faster machine or when only video translation matters.
- Within the base size, the FP32 encoder with the int8 decoder was taken as the default: half the
  download and 0.3 GB less memory than full FP32, for about 0.25 s more per phrase. Int8 graphs
  are **not** faster than FP32 on this CPU (they are smaller, not quicker). The WER differences
  between the three base rows (6–11 words out of 162 Spanish words) are within what changes from
  one decoding mode to another on this sample; do not read a ranking into them.
- **The Spanish WER is dominated by the test voice, not by the model.** eSpeak's Spanish is far
  from the human speech Whisper was trained on (it turned "será soleado durante" into "se hace a
  un mutante tonal"); its English is much closer. These figures compare models under identical
  conditions; they are **not** the accuracy a person speaking into a microphone will get, which
  was not measured here (no recordings of people were used). Published results for these models
  on human speech are much better than the eSpeak figures; treat that as a claim of their
  authors, not as something verified in this repository.
- The language is detected (when the client sends none) with one extra pass of the encoder and
  a single decoder step restricted to the 13 product languages: 24 of 24 phrases detected
  correctly, at a cost of about 1.1 s per phrase. Clients that know the language should send it.
- Decoding **with** timestamps is used also for dictation: without them the model stopped at
  the first pause of a three-sentence, 15 s segment (it returned one sentence of three).
- Memory: the process settles around 1.4 GB with the base model loaded and peaks at 1.8 GB;
  disabling ONNX Runtime's memory arena lowers the settled figure to 0.56 GB but makes every
  phrase about 50 % slower, so the arena stays on and the model is unloaded after
  `DICTATION_IDLE_UNLOAD_SEC` (15 min) without use.
- With the base model loaded, the API process itself grew from 0.24 GB to 1.58 GB (peak
  2.0 GB after 30 s segments), measured on the running API.
- Running the model in the HTTP thread blocked the event loop for 1.8–7.2 s per phrase; in the
  worker thread the longest pause measured was 17–69 ms.

Latency of the HTTP route (`POST /api/dictation/transcribe`, API on the same machine, model warm,
`whisper-base`, five calls each): a 5 s segment (12 words) 1.30–1.45 s with the language given and
1.99–2.16 s without; a 15 s segment (33–36 words) 2.08–2.59 s and 2.82–2.97 s; a full 30 s
segment (72 words) 3.38–4.00 s.

## Third-party software that is not a model weight

Not loaded by the avatar engine, but listed here because its licence is not permissive and
whoever redistributes Parlante has to know about it.

| Component                                | Role                                                                                         | Origin                                  | Licence                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@echogarden/espeak-ng-emscripten` 0.3.5 | Local text-to-speech (`packages/providers/src/tts/espeak-engine.ts`): voice + phoneme timing | npm (eSpeak NG compiled to WebAssembly) | **GPL-3.0** (`license` field of its package.json; ships `COPYING`) | Used unmodified as an npm dependency of the API and the worker; its voice data file is part of the package. Running Parlante yourself is unaffected. **Redistributing** Parlante together with it (e.g. a Docker image) means complying with the GPL-3.0 for that component; whether that reaches the rest of the work is a legal question this project has not had reviewed. An installation that must avoid it can use another TTS provider and drop the dependency. |

Licence read from the installed package on 2026-11-24.

Dependencies added for local speech recognition (licences read from the `license` field of each
installed `package.json` on 2026-11-24; all pinned by `pnpm-lock.yaml`):

| Component                                                                                                                                               | Role                                                            | Licence                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@huggingface/transformers` 4.3.2 (exact version)                                                                                                       | Whisper pipeline: features, tokenizer, decoding                 | **Apache-2.0**                                                | Direct dependency of `packages/providers`. Configured with remote models disabled.                                                                                                                                                                                                                                                                                                                                                               |
| `onnxruntime-node` 1.30.0, `onnxruntime-common`                                                                                                         | Inference on the CPU                                            | **MIT**                                                       | Native binaries for Windows, macOS and Linux (x64 / arm64) ship inside the npm package. Its `postinstall` (download of CUDA providers) is **not run**. **It ships with usage telemetry switched on** (it tries to reach `mobile.events.data.microsoft.com` and keeps a device id under `~/.cache/Microsoft`): Parlante switches it off with `ORT_DISABLE_TELEMETRY=1` before loading it, and a real-model test checks that nothing connects out. |
| `onnxruntime-web` (dev build pinned by transformers), `@huggingface/jinja`                                                                              | Pulled by `@huggingface/transformers`; not used on this path    | **MIT**                                                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@huggingface/tokenizers` 0.2.0, `flatbuffers`, `long`                                                                                                  | Tokenizer; ONNX Runtime support code                            | **Apache-2.0**                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sharp` 0.35.5 and `@img/sharp-<platform>`                                                                                                              | Image decoding for transformers' vision pipelines; **not used** | **Apache-2.0**                                                | Installed because `@huggingface/transformers` depends on it.                                                                                                                                                                                                                                                                                                                                                                                     |
| `@img/sharp-libvips-<platform>` 1.3.4                                                                                                                   | Prebuilt libvips loaded by `sharp`                              | **LGPL-3.0-or-later**                                         | A dynamically loaded shared library, installed as an optional dependency of `sharp` and never called by Parlante. Whoever **redistributes** an installation that contains it (e.g. a Docker image) must comply with the LGPL for that library (keep it replaceable, ship its licence).                                                                                                                                                           |
| `protobufjs`, `@protobufjs/*`, `global-agent`                                                                                                           | ONNX Runtime support code / its installer                       | **BSD-3-Clause**                                              | `protobufjs` has a `postinstall` (a version check): not run.                                                                                                                                                                                                                                                                                                                                                                                     |
| `adm-zip`, `platform`, `matcher`, `serialize-error`, `globalthis`, `define-*`, `es-*`, `gopd`, `has-property-descriptors`, `object-keys`, `@img/colour` | Small transitive utilities                                      | **MIT** (`type-fest`: MIT OR CC0-1.0; `guid-typescript`: ISC) | —                                                                                                                                                                                                                                                                                                                                                                                                                                                |
