# Models of the local neural avatar engine, of local speech recognition and of the local neural voices

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
| `ditto-audio2motion`          | animation — audio driver (lips that follow the sound; part of the default download)                                  | `hubert.onnx` (1458.7 MB), `lmdm_v0.4_hubert.onnx` (192.5 MB) — 1.65 GB                                                                                                                                             | `digital-avatar/ditto-talkinghead` @ `e4a2f603…` (`ditto_onnx/`)                               | **Apache-2.0** (`LICENSE` file of the repository; the model card carries no licence tag) | Yes            | Ditto (Ant Group): HuBERT speech features + motion-space diffusion. Optional download (`--with-audio`). The card does not document the provenance of the HuBERT checkpoint beyond shipping it under the repository licence.                                                                                          |
| `mediapipe-blazeface-onnx`    | face-detection                                                                                                       | `blaze_face.onnx` (0.4 MB)                                                                                                                                                                                          | `digital-avatar/ditto-talkinghead` @ `e4a2f603…`                                               | **Apache-2.0** (repository `LICENSE`; original MediaPipe model: Apache-2.0)              | Yes            | MediaPipe BlazeFace short-range, ONNX export. Run with our own pre/post-processing in ONNX Runtime (no `mediapipe` wheel).                                                                                                                                                                                           |
| `mediapipe-facemesh-onnx`     | face-detection (478 landmarks)                                                                                       | `face_mesh.onnx` (5.0 MB)                                                                                                                                                                                           | `digital-avatar/ditto-talkinghead` @ `e4a2f603…`                                               | **Apache-2.0** (as above)                                                                | Yes            | MediaPipe FaceMesh with irises, ONNX export.                                                                                                                                                                                                                                                                         |
| `mediapipe-selfie-multiclass` | matting (fallback)                                                                                                   | `selfie_multiclass_256x256.tflite` (16.4 MB)                                                                                                                                                                        | `storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/` | **Apache-2.0** (MediaPipe model card)                                                    | Yes            | Used for the portrait matte only when the dedicated matting model of the next section is not downloaded. Executed with LiteRT (`ai-edge-litert`).                                                                                                                                                                    |

Derived files (not downloaded, built locally from the weights above and cached in
`AVATAR_ENGINE_MODELS_DIR/derived/`): the generator graph `warping_spade.onnx` split into three
convolutional stages and two single-node GridSample graphs so that OpenVINO can run the
convolutions. Same weights, same licence.

Not used, on purpose: InsightFace detectors / landmark models (non-commercial research licence),
any TensorRT plugin binaries shipped in the model repositories, any `.pth` / `.pkl` file.

Optional, **not installed by default and not verified** (the build machine has no GPU): to run
the engine on an NVIDIA card the user replaces `onnxruntime` by `onnxruntime-gpu==1.32.0` (PyPI,
MIT) with its `cuda` and `cudnn` extras, which pull NVIDIA's CUDA 13 and cuDNN 9 runtime wheels
from PyPI (`nvidia-cuda-runtime`, `nvidia-cuda-nvrtc`, `nvidia-cufft`, `nvidia-curand`,
`nvidia-cudnn-cu13`; NVIDIA proprietary licence, free of charge, runtime use permitted — read
it before a commercial deployment). No weight changes. Steps and what was reviewed:
`services/avatar-engine/README.md`, "GPU and Windows".

Library telemetry (onnxruntime 1.32.0 and openvino 2026.4.1 both report usage by default) is
switched off before the libraries load; measurements in the engine README, "Privacy".

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

## Local neural voices: Kokoro and Piper (owner: voice-neural)

Not part of the avatar engine: these models run **inside the Node processes** (API for previews
and the interactive avatar, worker for renders and dubbing), on the CPU, through
`onnxruntime-node`, in a worker thread. The machine-readable source of truth is
`packages/providers/src/tts/neural-models.ts` (repository, pinned revision, size and SHA-256 of
every file) and `neural-voices.ts` (the voices, with the licence of each one);
`pnpm voices:setup --list` prints both with the state on disk.

The same rules apply: data-only formats (ONNX graphs, raw float32 tensors, JSON; no pickle, no
`trust_remote_code`), downloaded only from `huggingface.co` at a pinned commit, every file
checked against its size and SHA-256 **before** it takes its final name, never committed and
**never fetched at run time** (`pnpm voices:setup` is the only code that downloads). The
inference code is ours: text → phonemes with the eSpeak NG the repository already ships
(WebAssembly), phonemes → the alphabet of each model, tensors in and out of ONNX Runtime. No code
from the model repositories, from `kokoro` / `kokoro-js` or from `piper` is executed or installed.

Licences verified: 2026-11-24 (front matter of the model cards and every `MODEL_CARD` of the
Piper repository at the pinned revision, read through the Hugging Face API).

### Files

| Model                                                                                           | Files (size)                                                                                                                                                                                                                                                                                                                                 | Origin (repo @ revision)                                                                       | Licence                                                                                                                              | Commercial use              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kokoro-82M v1.0**, ONNX export that also returns the predicted duration of every input symbol | `onnx/model_uint8.onnx` (177.5 MB, **default**) or `onnx/model.onnx` (325.5 MB, fp32) or `onnx/model_quantized.onnx` (92.4 MB, q8) + `tokenizer.json` (3.5 kB, the symbol table) + `voices/<voice>.bin` (0.52 MB each: raw float32 `[510, 1, 256]`, the style of a voice per text length). Default install (model + 13 voices): **184.3 MB** | `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` @ `dd4401a9add81ac692d20e240d22ec9dda82cc29` | **Apache-2.0** (model card `license: apache-2.0`; base model `hexgrad/Kokoro-82M`: `license: apache-2.0`, "Apache-licensed weights") | Yes                         | StyleTTS 2 architecture with an ISTFTNet decoder, 82 M parameters, 24 kHz. The upstream card states it was trained "exclusively on permissive/non-copyrighted audio data" (public domain, Apache / MIT audio and synthetic audio from closed TTS providers) and lists two CC BY sources: SIWIS (CC BY 4.0, the French voice `ff_siwis`: **attribution required**) and Koniwa (Japanese voices, not offered). The Spanish and Portuguese voices carry no quality grade upstream. |
| **Piper voices** (VITS, one graph per voice)                                                    | `<voice>.onnx` (63 MB for `medium`, 21–28 MB for `x_low`; 77 MB for the two-speaker Spanish voice) + `<voice>.onnx.json` (symbol table, sample rate, inference scales)                                                                                                                                                                       | `rhasspy/piper-voices` @ `e5349433ed883a32f893a434dc43a6c66b95ef7c`                            | Repository: MIT. **Each voice: the licence of its training data**, table below                                                       | Yes for every voice offered | 22.05 kHz (`medium`) or 16 kHz (`x_low`). The graphs only return audio: when a voice is loaded, the tensor with the predicted durations (the output of the graph's only `Ceil` node) is added to the graph outputs **in memory** (`onnx-graph.ts`); the file on disk stays the verified one.                                                                                                                                                                                    |

Piper voices offered, with what their `MODEL_CARD` says:

| Voice                                        | Language         | Dataset licence (card)                             | Trained from                                                                     | Attribution                                                             |
| -------------------------------------------- | ---------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `de_DE-kerstin-medium`                       | German           | CC0                                                | fine-tuned from `en_US-hifi_tts_92` (Hi-Fi TTS, CC BY 4.0, trained from scratch) | Hi-Fi TTS (NVIDIA), reader Cori Samuel — for the base                   |
| `de_DE-thorsten-medium`                      | German           | CC0 (Thorsten-Voice)                               | fine-tuned from `nl_BE-rdh` (CC0, trained from scratch)                          | —                                                                       |
| `nl_BE-nathalie-medium`                      | Dutch (Flanders) | CC0                                                | fine-tuned from `en_US-hifi_tts_92`                                              | Hi-Fi TTS — for the base                                                |
| `nl_NL-pim-medium`                           | Dutch            | CC0                                                | fine-tuned from `nl_BE-rdh`                                                      | —                                                                       |
| `pl_PL-gosia-medium`                         | Polish           | CC0                                                | fine-tuned from `en_US-hifi_tts_92`                                              | Hi-Fi TTS — for the base                                                |
| `pl_PL-darkman-medium`                       | Polish           | CC0                                                | fine-tuned from `nl_BE-rdh`                                                      | —                                                                       |
| `ru_RU-denis-medium`                         | Russian          | CC0                                                | fine-tuned from `nl_BE-rdh`                                                      | —                                                                       |
| `sv_SE-alma-medium`                          | Swedish          | **CC BY 4.0** (weights, following the NST dataset) | NST Swedish TTS dataset                                                          | NST / Språkbanken; voice by `yeagersthlm`                               |
| `sv_SE-nst-medium`                           | Swedish          | CC0 (NST)                                          | from scratch (KBLab)                                                             | —                                                                       |
| `el_GR-rapunzelina-medium`                   | Greek            | CC0                                                | from scratch                                                                     | —                                                                       |
| `ca_ES-upc_ona-x_low`, `ca_ES-upc_pau-x_low` | Catalan          | **CC BY-SA 3.0 ES** (UPC FestCat)                  | from scratch                                                                     | UPC FestCat TTS corpora; share-alike applies to adaptations of the data |
| `es_ES-davefx-medium`                        | Spanish          | CC0                                                | fine-tuned from `nl_BE-rdh`                                                      | —                                                                       |
| `es_ES-sharvard-medium` (speaker F)          | Spanish          | **CC BY 3.0** (Sharvard corpus)                    | fine-tuned from `en_US-hifi_tts_92`                                              | Aubanel, García Lecumberri & Cooke (2014); Hi-Fi TTS for the base       |
| `es_MX-ald-medium`                           | Spanish (Mexico) | Unlicense                                          | fine-tuned from `nl_BE-rdh`                                                      | —                                                                       |

SHA-256 of the weight files (all of them, with the JSON files, are in `neural-models.ts`):

| File                                        | SHA-256                                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Kokoro `onnx/model_uint8.onnx` (default)    | `b44c5c0d90458a8d9175cea933ff6d8a6351b74f1e651060df48672f5a167e4f`                                                                 |
| Kokoro `onnx/model.onnx`                    | `651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054`                                                                 |
| Kokoro `onnx/model_quantized.onnx`          | `c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c`                                                                 |
| Kokoro `tokenizer.json`                     | `77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34`                                                                 |
| Kokoro `voices/ef_dora.bin` / `em_alex.bin` | `f66ec66b…4ac9a532` / `27809e9e…d6b83e95` (the other eleven in the code)                                                           |
| Piper `.onnx` files                         | one per voice, in the code (e.g. `de_DE-thorsten-medium.onnx`: `fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f`) |

**Not offered, on purpose** (what each card says at the pinned revision):

- Turkish: the only voice, `tr_TR-dfki`, is CC BY-NC-SA 4.0. **Turkish has no neural voice.**
- Russian, female: `ru_RU-irina` declares "License: Unknown"; `ru_RU-ruslan` is CC BY-NC-SA 4.0.
- Greek `el_GR-joy` (CC BY-NC 4.0), German `de_DE-pavoque` (CC BY-NC-SA 4.0), Swedish
  `sv_SE-lisa` (its card declares no licence), German `eva_k` / `karlsson` / `ramona` ("License:
  See URL", not verified).
- French, male: `fr_FR-tom` (dataset under AGPLv3), `fr_FR-gilles` and `fr_FR-upmc` (fine-tuned
  from `en_US-ryan` / `en_US-lessac`).
- Every voice fine-tuned from `en_US-lessac` or `en_US-ryan` (among them `ca_ES-upc_ona-medium`
  and `es_AR-daniela-high`): the licence of the Lessac (Blizzard 2013) data is given on its card
  only as a link and was not verified to allow commercial use, and a fine-tuned voice carries
  the weights of its base. That is why Catalan uses the smaller `x_low` voices, which were
  trained from scratch.
- `ru_RU-dmitri-medium` and `pt_PT-tugão-medium` (both CC0): their median pitch measured here
  (180 and 183 Hz) does not match the gender their names suggest, and nobody could listen to
  them; a wrongly labelled gender would give a male avatar a female voice by default.
- Kokoro's Hindi, Japanese and Mandarin voices (not product languages) and its "santa" voices.

### Text to phonemes

Both models were trained on the IPA that eSpeak NG writes. Parlante takes it from the events of
the eSpeak NG it already ships: phonemes per spoken word, where each word comes from in the text
(numbers, signs and abbreviations are expanded by eSpeak: "2024" is three spoken words of one
display word) and the pauses eSpeak makes.

- **Kokoro** expects the symbols of `misaki`, its G2P library, in which diphthongs and
  affricates are single letters (`eɪ → A`, `aɪ → I`, `tʃ → ʧ`…). The two tables of
  `misaki/espeak.py` (`misaki` 0.7.4 on PyPI, Apache-2.0: `EspeakG2P` for Spanish, French,
  Italian and Portuguese, `EspeakFallback` for English) were re-implemented in
  `neural-phonemes.ts`; `misaki` itself is not a dependency. English goes through the eSpeak
  fallback path for every word (upstream uses a pronunciation dictionary first and eSpeak for
  the words it lacks).
- **Piper** takes eSpeak's IPA as it is, decomposed (NFD), with the symbol table of each voice
  (recent voices have one id for a whole diphthong).
- Checked: a text of each language with numbers, acronyms, currency, accents and loan words
  produced **no symbol outside the model's table** — Kokoro in Spanish, English (US and UK),
  French, Italian and Portuguese (1 094 symbols), and the 15 Piper voices offered, each with
  its own table (a `[slow]` test repeats it for whatever is installed).
- What eSpeak cannot expand is read as eSpeak reads it: "2 h 30 min" is spelled letter by
  letter in Spanish and the acronym "ONU" is spelled out ("o ene u").

### How the voices and the Kokoro precision were chosen

Measured on the build machine (4 vCPU, 4 inference threads, 15 GB RAM, no GPU) **through the
product providers**. The machine was busy with another job during every measurement (load
average 6–10 on 4 cores), so the times below are pessimistic and noisy; precisions were
compared in interleaved rounds (A B C, A B C…) so that each met the same load. Nobody listened
to anything: quality is stated only through what was measured.

- **Intelligibility**: 12 Spanish and 12 English plain sentences of 9–15 words (6 in the other
  languages) are synthesized, transcribed by the repository's own local Whisper (`whisper-base`,
  language given) and compared with the text: word error rate after lower-casing and removing
  punctuation. The same sentences with the eSpeak voice are the reference. This measures how
  well a small speech recogniser understands the voice, which follows clarity of pronunciation;
  it says nothing about naturalness or timbre.
- **Speed**: seconds of computation per second of audio, first sentence excluded.
- **Memory**: peak resident memory of the whole Node process.

Precisions of Kokoro (voice `ef_dora` in Spanish, `af_heart` in English):

| Precision          | Download | WER es          | WER en          | Compute s per audio s (best / median round) | First sentence (incl. load) | Peak RSS     | Verdict                                                                                         |
| ------------------ | -------- | --------------- | --------------- | ------------------------------------------- | --------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| **uint8**          | 177.5 MB | 2.2 % (3/139)   | 0.7 % (1/148)   | **0.53 / 0.55**                             | 4.2–4.5 s                   | 0.70–0.75 GB | **Default.** Fastest, half the download of fp32                                                 |
| fp32               | 325.5 MB | 1.4 % (2/139)   | 0.7 % (1/148)   | 0.63 / 0.66                                 | 4.2–4.4 s                   | 0.87 GB      | Offered (`VOICE_KOKORO_VARIANT=fp32`)                                                           |
| q8                 | 92.4 MB  | 2.9 % (4/139)   | 0.7 % (1/148)   | 1.59 / 1.60                                 | 7.8–10.6 s                  | 0.57–0.59 GB | Offered: smallest, three times slower                                                           |
| uint8f16           | 114.2 MB | 2.2 % (3/139)   | 0.7 % (1/148)   | 0.57 / 0.58                                 | 5.3 s                       | 0.70 GB      | Not offered: slower than uint8                                                                  |
| q4                 | 305.2 MB | 1.4 % (2/139)   | 0.7 % (1/148)   | 0.62 / 0.62                                 | 4.0–4.6 s                   | 0.85 GB      | Not offered: as big as fp32                                                                     |
| fp16               | 163.2 MB | 10.8 % (15/139) | 27.0 % (40/148) | 0.84–1.12 (single pass)                     | 5.2–6.9 s                   | 0.87 GB      | **Rejected**: some sentences come out silent                                                    |
| q4f16              | 154.6 MB | 10.8 % (15/139) | 8.1 % (12/148)  | 0.78–0.81 (single pass)                     | 5.1–6.7 s                   | 0.89 GB      | **Rejected**: same failure                                                                      |
| q8f16              | 86.1 MB  | —               | —               | —                                           | —                           | —            | **Rejected**: ONNX Runtime 1.30 crashes while loading it (segmentation fault; the process dies) |
| eSpeak (reference) | —        | 43.9 % (61/139) | 6.1 % (9/148)   | 0.01                                        | 0.8 s                       | 0.24 GB      | The fallback voice                                                                              |

- The differences between uint8, fp32, q4 and q8 are one or two words out of 139: within the
  noise of this sample. The one English "error" of every row is Whisper writing "4 o'clock" for
  "four o'clock". The 16-bit float files are a different matter: whole sentences are missing.
- eSpeak's Spanish is understood far worse than its English by the same recogniser (44 % against
  6 %); the neural Spanish voice closes that gap (2 %).

Every voice offered (Kokoro with the default precision). "Cue vs sound" is the alignment of the
next section.

| Voice id                         | Name        | Language | Gender | Median pitch | WER (local Whisper base) | eSpeak, same sentences | Compute s per audio s | Cue vs sound: median / p90 (starts) |
| -------------------------------- | ----------- | -------- | ------ | ------------ | ------------------------ | ---------------------- | --------------------- | ----------------------------------- |
| `kokoro:ef_dora`                 | Dora        | es       | female | 174 Hz       | 2.2 % (3/139)            | 43.9 % (61/139)        | 0.56                  | 12 / 78 ms (33)                     |
| `kokoro:em_alex`                 | Álex        | es       | male   | 131 Hz       | 1.4 % (2/139)            | 43.9 % (61/139)        | 0.58                  | 12 / 83 ms (34)                     |
| `kokoro:af_heart`                | Heart       | en       | female | 196 Hz       | 0.7 % (1/148)            | 6.1 % (9/148)          | 0.60                  | 12 / 59 ms (38)                     |
| `kokoro:am_michael`              | Michael     | en       | male   | 113 Hz       | 0.0 % (0/148)            | 6.1 % (9/148)          | 0.56                  | 12 / 71 ms (36)                     |
| `kokoro:af_bella`                | Bella       | en       | female | 197 Hz       | 0.0 % (0/148)            | 6.1 % (9/148)          | 0.67                  | 12 / 73 ms (37)                     |
| `kokoro:am_fenrir`               | Fenrir      | en       | male   | 137 Hz       | 0.0 % (0/148)            | 6.1 % (9/148)          | 0.69                  | 12 / 67 ms (25)                     |
| `kokoro:bf_emma`                 | Emma (UK)   | en-GB    | female | 178 Hz       | 1.4 % (2/148)            | 6.1 % (9/148)          | 0.61                  | 12 / 57 ms (32)                     |
| `kokoro:bm_george`               | George      | en-GB    | male   | 142 Hz       | 0.0 % (0/148)            | 6.1 % (9/148)          | 0.62                  | 17 / 65 ms (46)                     |
| `kokoro:ff_siwis`                | Siwis       | fr       | female | 210 Hz       | 12.1 % (8/66)            | 92.4 % (61/66)         | 1.05                  | 37 / 90 ms (12)                     |
| `kokoro:if_sara`                 | Sara        | it       | female | 218 Hz       | 4.8 % (3/62)             | 61.3 % (38/62)         | 0.65                  | 12 / 12 ms (6)                      |
| `kokoro:im_nicola`               | Nicola      | it       | male   | 96 Hz        | 3.2 % (2/62)             | 61.3 % (38/62)         | 0.83                  | 12 / 12 ms (6)                      |
| `kokoro:pf_dora`                 | Dora (BR)   | pt-BR    | female | 179 Hz       | 3.1 % (2/64)             | 89.1 % (57/64)         | 0.56                  | 12 / 25 ms (8)                      |
| `kokoro:pm_alex`                 | Alex (BR)   | pt-BR    | male   | 136 Hz       | 3.1 % (2/64)             | 89.1 % (57/64)         | 0.59                  | 12 / 65 ms (9)                      |
| `piper:de_DE-kerstin-medium`     | Kerstin     | de       | female | 166 Hz       | 8.8 % (6/68)             | 77.9 % (53/68)         | 0.23                  | 43 / 73 ms (10)                     |
| `piper:de_DE-thorsten-medium`    | Thorsten    | de       | male   | 118 Hz       | 7.4 % (5/68)             | 77.9 % (53/68)         | 0.25                  | 41 / 63 ms (11)                     |
| `piper:nl_BE-nathalie-medium`    | Nathalie    | nl-BE    | female | 155 Hz       | 18.5 % (12/65)           | 87.7 % (57/65)         | 0.25                  | 12 / 68 ms (7)                      |
| `piper:nl_NL-pim-medium`         | Pim         | nl       | male   | 134 Hz       | 10.8 % (7/65)            | 87.7 % (57/65)         | 0.23                  | 13 / 43 ms (7)                      |
| `piper:pl_PL-gosia-medium`       | Gosia       | pl       | female | 209 Hz       | 9.1 % (5/55)             | 83.6 % (46/55)         | 0.21                  | 8 / 40 ms (10)                      |
| `piper:pl_PL-darkman-medium`     | Darkman     | pl       | male   | 106 Hz       | 12.7 % (7/55)            | 83.6 % (46/55)         | 0.23                  | 8 / 45 ms (12)                      |
| `piper:ru_RU-denis-medium`       | Denis       | ru       | male   | 140 Hz       | 18.0 % (9/50)            | 106.0 % (53/50)        | 0.23                  | 26 / 63 ms (8)                      |
| `piper:sv_SE-alma-medium`        | Alma        | sv       | female | 185 Hz       | 25.8 % (16/62)           | 95.2 % (59/62)         | 0.22                  | 10 / 28 ms (6)                      |
| `piper:sv_SE-nst-medium`         | Nils        | sv       | male   | 79 Hz        | 19.4 % (12/62)           | 95.2 % (59/62)         | 0.23                  | 12 / 446 ms (7)                     |
| `piper:el_GR-rapunzelina-medium` | Rapunzelina | el       | female | 200 Hz       | 46.2 % (30/65)           | 87.7 % (57/65)         | 0.22                  | 13 / 43 ms (6)                      |
| `piper:ca_ES-upc_ona-x_low`      | Ona         | ca       | female | 180 Hz       | 21.4 % (15/70)           | 90.0 % (63/70)         | 0.16                  | 12 / 41 ms (9)                      |
| `piper:ca_ES-upc_pau-x_low`      | Pau (UPC)   | ca       | male   | 85 Hz        | 35.7 % (25/70)           | 90.0 % (63/70)         | 0.17                  | 12 / 64 ms (12)                     |
| `piper:es_ES-davefx-medium`      | Dave        | es       | male   | 120 Hz       | 5.0 % (7/139)            | 43.9 % (61/139)        | 0.20                  | 20 / 58 ms (23)                     |
| `piper:es_ES-sharvard-medium+F`  | Marta       | es       | female | 204 Hz       | 4.3 % (6/139)            | 43.9 % (61/139)        | 0.19                  | 12 / 20 ms (22)                     |
| `piper:es_MX-ald-medium`         | Aldo        | es-MX    | male   | 147 Hz       | 5.0 % (7/139)            | 43.9 % (61/139)        | 0.20                  | 10 / 72 ms (28)                     |

- How to read the WER column: `whisper-base` is itself weak outside the big languages (it
  writes Greek and Catalan with spelling mistakes even when it hears the right word), so the
  column compares a voice with the eSpeak voice **of the same language**, not one language with
  another. In every language the neural voice is understood several times better than eSpeak
  (which the recogniser barely understands outside English and Spanish: 61–106 % errors).
  Non-English samples other than Spanish are six sentences (50–70 words): one word is 1.5–2
  points.
- The compute column was measured voice by voice at different moments of a busy machine (load
  average 6–10): `ff_siwis` (1.05) and `im_nicola` (0.83) ran while the load was highest, and
  nothing suggests those voices are slower by themselves (they share the graph of the others).
  Piper `medium` voices take about 0.2 s per second of speech, the `x_low` ones about 0.16.
- Kokoro is the engine of every language it covers because one 184 MB install gives thirteen
  voices in five languages with a low error rate. **In Spanish no other open option was clearly
  better**: the Piper Spanish voices with a usable licence were measured on the same sentences
  (table) and stay in the catalogue as extra voices (a second male, a second female and a
  Mexican accent), not as the default.
- The French voice of Kokoro has the worst alignment of the set and French has no male neural
  voice; Catalan only has the 16 kHz `x_low` voices.
- The genders of the catalogue were checked against the measured median pitch.

### Timing for lip-sync and karaoke subtitles

The timeline (visemes and words) of a neural voice is not eSpeak's and is not estimated: both
models predict how many frames every input symbol lasts **before** they generate the audio, and
the audio has exactly that length. Kokoro returns the durations; Piper's are exposed when its
graph is loaded. Each symbol is a phoneme, a space or a punctuation mark and belongs to a word
of the script, so the mouth shape of each phoneme and the span of each word come from the audio
that was really generated.

Three corrections are applied, all measured on the audio itself:

- A model without a silence symbol (Piper) hides the silence it makes at the start of a
  sentence inside the first phoneme: the durations then put the first word up to 150 ms before
  any sound (measured: −128 ms on average for `de_DE-kerstin`). When a word starts with more
  silence than a stop closure takes (70 ms), its start is moved to 40 ms before the first sound.
- Kokoro sometimes hurries past a full stop inside a chunk (120 ms measured between two short
  sentences); silence is inserted at the quietest point of that pause up to 260 ms.
- Kokoro's sound comes **earlier** than its durations add up to: every symbol is placed 75 ms
  (three frames) before the raw sum (`KOKORO_TIMELINE_LEAD_MS`). Measured on whole sentences
  of 6–7 s, as the lag that maximises the correlation between the mouth opening the visemes
  ask for and the loudness envelope of the audio (10 ms steps):

  | Voice (language)      | Raw durations: lag, correlation at lag 0 | With the 75 ms lead: lag, correlation at lag 0 |
  | --------------------- | ---------------------------------------- | ---------------------------------------------- |
  | `ef_dora` (es)        | lips 70 ms late, −0.06                   | 0 ms, 0.49                                     |
  | `em_alex` (es)        | 80 ms late, −0.08                        | 10 ms late, 0.44                               |
  | `af_heart` (en-US)    | 50 ms late, 0.07                         | 20 ms early, 0.23                              |
  | `am_michael` (en-US)  | 60 ms late, 0.08                         | 10 ms early, 0.24                              |
  | `bf_emma` (en-GB)     | not measured                             | 40 ms late, 0.20                               |
  | `ff_siwis` (fr)       | not measured                             | 0 ms, 0.50                                     |
  | `if_sara` (it)        | not measured                             | 20 ms late, 0.21                               |
  | `pf_dora` (pt-BR)     | not measured                             | 20 ms late, 0.26                               |
  | eSpeak `es-f1` (ref.) | 10 ms late, 0.54                         | —                                              |
  | eSpeak `en-f1` (ref.) | 10 ms late, 0.49                         | —                                              |

  The onset measure of the next paragraph did not show this, because a word that follows a
  pause is snapped to the sound anyway; it is the sounds inside the words that ran behind. The
  end of the last word is not moved (it decides where the audio is cut). The avatar engine saw
  the same thing from its side: its viseme-driven mouth scored 0.14–0.19 against the loudness
  of Kokoro clips before the correction and 0.29–0.77 after it (six phrases).

**Alignment error**, measured where it can be observed: at every onset of sound after a real
pause (at least 120 ms below 3 % of the loud level — longer than the closure of a "p" or a "k"),
the distance to the nearest word cue. Table above: for the Kokoro voices the median is **12 ms**
(one voice 17 ms, the French one 37 ms) and the 90th percentile 12–90 ms; for Piper, after the
correction, medians of 8–43 ms and 90th percentiles of 20–73 ms. The 446 ms of `sv_SE-nst` is
not a cue: it is the release of the final "t" of a sentence ("lugnt."), which the detector took
for a start of sound inside the last word. The same measure on eSpeak, whose cues come from the
synthesiser itself, gives medians of 0–16 ms and 90th percentiles of 40–53 ms (116 ms in
Italian): a good part of the spread is the measure, not the cue. On average the cues of Kokoro
are 10–26 ms **after** the onset (48 ms for the French voice) and Piper's between 44 ms before
and 26 ms after it. Before the first correction Piper's German voices were 116 and 51 ms off
(median). Words that follow another without a pause cannot be checked this way, and the
samples are small outside Spanish and English (6–12 onsets).

End to end (`e2e/voices.mjs`, real browser, real API): in the Studio preview the mouth of the 2D
avatar is open at three instants in which the model pronounces an open vowel (55–135 dark pixels
of mouth cavity) and closed in the pause at the full stop and before the first word (3–9); the
first subtitle of the exported SRT starts at 352 ms, the same millisecond as the first word of
the preview, and the render did not synthesize again.

### Long texts, speed and pitch

- A script is cut into chunks at paragraph ends, at explicit pauses (`<break>`) and between
  sentences: Kokoro gets whole sentences up to about 220 symbols per inference (it rushes near
  its 510-symbol limit and is weak on very short inputs), Piper one sentence. A sentence that
  does not fit is cut at a comma, else at a space. Each chunk is trimmed to 12 ms before its
  first phoneme and 70 ms after its last one, faded (4 ms in, 12 ms out) and joined with silence
  (300 ms after a sentence, 530 ms after a paragraph, scaled by the speed): a seam is always
  silence reached from a faded edge (checked by a `[slow]` test on a 30 s text).
- **Speed** is a native input of both models (Kokoro `speed`, Piper `length_scale`).
- **Pitch**: neither model has a pitch input. It is changed by resampling the audio and asking
  the model for the inverse tempo, which keeps the duration and moves the formants with the
  pitch (the voice sounds smaller or larger). The range is therefore limited to **±4 semitones**
  and the interface says how it works (`Voice.pitchRange.resampled`). Measured: asking for +3
  semitones raised the median pitch between 1.8 and 4.2 semitones (test bounds) with the
  duration unchanged within 20 %.
- Reproducibility is not relied upon: Piper draws noise on every synthesis. Kokoro returned
  byte-identical audio for the same text twice in a row in one process (checked once, on this
  machine); across precisions, machines or runtime versions nothing guarantees it. The TTS cache
  of `packages/jobs` is what makes preview and export share one synthesis.

### Latency and memory

One sentence of about 5–6 s of speech and one paragraph of about 37 s, Kokoro `uint8`, voice
`ef_dora`, each in a fresh process (cold = the thread starts and the model loads; then three
warm requests with other texts of the same length):

| Request                       | Speech produced | Cold (thread start + model load + synthesis) | Warm, three requests                                         | Peak RSS of the process |
| ----------------------------- | --------------- | -------------------------------------------- | ------------------------------------------------------------ | ----------------------- |
| One sentence                  | 5.4–6.7 s       | **5.0 s**                                    | **3.1 / 3.2 / 3.6 s** (about 0.55 s per second of speech)    | 0.70 GB                 |
| One paragraph (six sentences) | 36.7–38.0 s     | **20.1 s**                                   | **18.3 / 18.9 / 19.1 s** (about 0.50 s per second of speech) | 0.83 GB                 |

Load average of the machine during this run: 7.3 on 4 cores (another agent's jobs). The same
benchmark while this agent's own speech-recognition job was also running (load 8–10) gave 7.6 s
cold and 5.6–6.0 s warm for the sentence and 34.6 s cold and 31.8–32.5 s warm for the paragraph:
synthesis time follows whatever else the processor is doing. On an idle machine or with more
cores it will be lower; that was not measured. The whole audio is returned at once (no
streaming): a preview of a long paragraph waits for all of it, and repeated previews of the same
text come from the cache.

**On a quiet machine, through the product** (same 4 cores, load average 1.5–2.6, real API and
worker with the default configuration and no keys; integration pass):

| What                                                                        | Measured                                                                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview of one sentence (4.7–5.3 s of speech), `POST /api/tts/synthesize`   | 2.8 s cold (model load included); 1.1–1.2 s warm (0.23 s per second of speech); 9 ms repeated (cache)                                              |
| Render of a 30 s 2D video at 720p (built-in explainer, 4 scenes)            | 18.7 s cold (worker loads the model and synthesizes); 16.9 s new script, model loaded; 10.5 s voice already cached — 1.6×, 1.8× and 2.9× real time |
| Video translation es→en of that video, local transcription + neural dubbing | 17.3 s                                                                                                                                             |
| API process (Node, whole process)                                           | 0.29 GB at start → 0.86 GB with Kokoro loaded → 2.06 GB with Kokoro and Whisper (peak 2.48 GB)                                                     |
| Worker process                                                              | 0.26 GB at start → 1.0 GB after rendering with Kokoro → 2.27 GB with Kokoro and Whisper (peak 2.60 GB)                                             |

- The process that synthesizes (API or worker) grows by about 0.5 GB with Kokoro loaded (peak
  0.70–0.83 GB for the whole benchmark process, which holds nothing else); a Piper voice needs
  about 0.6 GB including the runtime. At most three graphs stay loaded per process and
  everything is released after `VOICE_IDLE_UNLOAD_SEC` (15 min) without use.
- Running in a worker thread: the `[slow]` test measures the event loop of the calling thread
  during a synthesis and requires its longest pause to stay under 500 ms.
- ONNX Runtime's telemetry is switched off before the library is loaded (same switch as the
  speech recogniser); the `[slow]` test routes every outbound connection of the process to a
  local listener and requires that none is attempted and nothing is written to the home
  directory.

### GPU: prepared, not verified

`VOICE_DEVICE=dml` (DirectML, Windows) or `cuda` asks ONNX Runtime for a GPU execution provider
and falls back to the CPU when it cannot be used. **This was not run on any GPU**: the build
machine has none, and the Linux package of `onnxruntime-node` has no DirectML and no CUDA
provider binaries (its post-install script, which fetches them, is not run). What is verified is
only the fallback: with `dml` or `cuda` the voices still synthesize here on the CPU. Whether the
`uint8` graph runs faster on a GPU than on the CPU, or at all, is unknown (quantised graphs often
do not); `VOICE_KOKORO_VARIANT=fp32` is the natural one to try there.

## Third-party software that is not a model weight

Not loaded by the avatar engine, but listed here because its licence is not permissive and
whoever redistributes Parlante has to know about it.

| Component                                | Role                                                                                         | Origin                                  | Licence                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@echogarden/espeak-ng-emscripten` 0.3.5 | Local text-to-speech (`packages/providers/src/tts/espeak-engine.ts`): voice + phoneme timing | npm (eSpeak NG compiled to WebAssembly) | **GPL-3.0** (`license` field of its package.json; ships `COPYING`) | Used unmodified as an npm dependency of the API and the worker; its voice data file is part of the package. Running Parlante yourself is unaffected. **Redistributing** Parlante together with it (e.g. a Docker image) means complying with the GPL-3.0 for that component; whether that reaches the rest of the work is a legal question this project has not had reviewed. An installation that must avoid it can use another TTS provider and drop the dependency. |

Licence read from the installed package on 2026-11-24.

Since the local neural voices exist, eSpeak NG is also **what writes their phonemes** (Kokoro and
Piper were both trained on eSpeak's IPA), not only the fallback voice: an installation without
this package has no local voice at all, neural or not. The neural voices add no other
dependency: `onnxruntime-node` 1.30.0 (**MIT**, table below) was already installed for speech
recognition and is now also a direct, exact-version dependency of `packages/providers`; the
phoneme tables of `misaki` 0.7.4 (**Apache-2.0**, read from its PyPI source distribution) were
re-implemented in TypeScript and the package is neither installed nor executed.

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
