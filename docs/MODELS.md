# Models of the local neural avatar engine

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

| id (`/health`) | Role | Files (size) | Origin (repo @ revision) | Licence | Commercial use | Notes |
|---|---|---|---|---|---|---|
| `liveportrait-onnx` | animation — generator shared by both drivers, appearance / motion encoders, stitching and lip / eye retargeting MLPs | `appearance_feature_extractor.onnx` (3.4 MB), `motion_extractor.onnx` (112.6 MB), `warping_spade.onnx` (421.2 MB), `stitching.onnx` (0.2 MB), `stitching_lip.onnx` (0.2 MB), `stitching_eye.onnx` (0.6 MB) — 538 MB | `warmshao/FasterLivePortrait` @ `eb937f4b…` (`liveportrait_onnx/`) | **MIT** (model card `license: mit`; upstream `KlingTeam/LivePortrait`: MIT) | Yes | ONNX export of LivePortrait (Kuaishou). Only the six graphs listed are fetched: the repository also hosts InsightFace-derived detectors (`retinaface_det_static.onnx`, `face_2dpose_106_static.onnx`, non-commercial) which the engine does **not** download or use — face analysis uses the MediaPipe models below. |
| `ditto-audio2motion` | animation — audio driver only (audio without a viseme timeline) | `hubert.onnx` (1458.7 MB), `lmdm_v0.4_hubert.onnx` (192.5 MB) — 1.65 GB | `digital-avatar/ditto-talkinghead` @ `e4a2f603…` (`ditto_onnx/`) | **Apache-2.0** (`LICENSE` file of the repository; the model card carries no licence tag) | Yes | Ditto (Ant Group): HuBERT speech features + motion-space diffusion. Optional download (`--with-audio`). The card does not document the provenance of the HuBERT checkpoint beyond shipping it under the repository licence. |
| `mediapipe-blazeface-onnx` | face-detection | `blaze_face.onnx` (0.4 MB) | `digital-avatar/ditto-talkinghead` @ `e4a2f603…` | **Apache-2.0** (repository `LICENSE`; original MediaPipe model: Apache-2.0) | Yes | MediaPipe BlazeFace short-range, ONNX export. Run with our own pre/post-processing in ONNX Runtime (no `mediapipe` wheel). |
| `mediapipe-facemesh-onnx` | face-detection (478 landmarks) | `face_mesh.onnx` (5.0 MB) | `digital-avatar/ditto-talkinghead` @ `e4a2f603…` | **Apache-2.0** (as above) | Yes | MediaPipe FaceMesh with irises, ONNX export. |
| `mediapipe-selfie-multiclass` | matting (fallback) | `selfie_multiclass_256x256.tflite` (16.4 MB) | `storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/` | **Apache-2.0** (MediaPipe model card) | Yes | Used for the portrait matte only when the dedicated matting model of the next section is not downloaded. Executed with LiteRT (`ai-edge-litert`). |

Derived files (not downloaded, built locally from the weights above and cached in
`AVATAR_ENGINE_MODELS_DIR/derived/`): the generator graph `warping_spade.onnx` split into three
convolutional stages and two single-node GridSample graphs so that OpenVINO can run the
convolutions. Same weights, same licence.

Not used, on purpose: InsightFace detectors / landmark models (non-commercial research licence),
any TensorRT plugin binaries shipped in the model repositories, any `.pth` / `.pkl` file.

## Portrait generation and matting (owner: motor-retratos)

<!-- motor-retratos: add your rows below (same columns). -->
