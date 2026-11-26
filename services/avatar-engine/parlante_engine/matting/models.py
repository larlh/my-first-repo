"""Weights of the person-matting model.

ORMBG ("Open Remove Background Model", schirrmacher/ormbg, Apache-2.0): an IS-Net trained for
HUMAN matting. ONNX export published as onnx-community/ormbg-ONNX (Apache-2.0).
Chosen over MODNet (soft halos around hair), MediaPipe selfie segmentation (256-px mask, ragged
hair, holes) and BiRefNet / BiRefNet-lite (equal or marginally better hair at 20-30x the time
and 5-8x the memory on CPU); RMBG 1.4 / 2.0 are non-commercial. Evaluation in docs/MODELS.md.
"""
from parlante_engine.core.registry import ModelFile

ORMBG = ModelFile(
    model_id="ormbg-onnx", role="matting", capabilities=("prepare",),
    repo="onnx-community/ormbg-ONNX", revision="034e2d884afbab897e10e78fc5bb566b29533fd6",
    filename="onnx/model.onnx",
    sha256="2830b6f461809cdc7e2f15d19fc1a898b14ad53504640d4147b525d53ebb09c9", size=176116019,
    license="Apache-2.0", commercial_use=True,
    description="Person matting (ORMBG / IS-Net, 1024x1024, ONNX)")

MODELS = [ORMBG]
