"""Weights used by `prepare` (face detection + landmarks, fallback matte)."""
from parlante_engine.core.registry import ModelFile

DITTO_REPO = "digital-avatar/ditto-talkinghead"
DITTO_REV = "e4a2f60328ee7c32af585ac4b3cce299e4c8e254"
_DITTO_LICENSE = "Apache-2.0"

# MediaPipe BlazeFace (short range) and FaceMesh-478 (with irises), exported to ONNX and shipped
# in the Ditto repository (Apache-2.0 LICENSE file; the original MediaPipe models are Apache-2.0).
BLAZE_FACE = ModelFile(
    model_id="mediapipe-blazeface-onnx", role="face-detection", capabilities=("prepare", "animate"),
    repo=DITTO_REPO, revision=DITTO_REV, filename="ditto_onnx/blaze_face.onnx",
    sha256="9b217128f6b66f7e11dc3673c22be250d72f68f507430817d0754ef1451eb609", size=418456,
    license=_DITTO_LICENSE, commercial_use=True, description="Face detector (MediaPipe BlazeFace short-range, ONNX)")
FACE_MESH = ModelFile(
    model_id="mediapipe-facemesh-onnx", role="face-detection", capabilities=("prepare", "animate"),
    repo=DITTO_REPO, revision=DITTO_REV, filename="ditto_onnx/face_mesh.onnx",
    sha256="bbbb49fac007b7cde79b478c680d171969f23f53ae6cdaf6a3b4264fa18c8479", size=4958394,
    license=_DITTO_LICENSE, commercial_use=True, description="478 face landmarks (MediaPipe FaceMesh, ONNX)")

# Fallback person matte, used only when the `matting` sub-package (portrait team) is absent.
SELFIE_MULTICLASS = ModelFile(
    model_id="mediapipe-selfie-multiclass", role="matting", capabilities=("prepare",),
    url="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
    filename="selfie_multiclass_256x256.tflite",
    sha256="c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0", size=16371837,
    license="Apache-2.0", commercial_use=True, description="Person segmentation (MediaPipe selfie multiclass, LiteRT)")

MODELS = [BLAZE_FACE, FACE_MESH, SELFIE_MULTICLASS]
