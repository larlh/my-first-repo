"""Weights of the portrait generator.

Realistic Vision V6.0 B1 (SG161222; Stable Diffusion 1.5 fine-tune, CreativeML OpenRAIL-M) in
the plain ONNX export published as Heliosoph/realistic-vision-cfg-onnx, which pairs it with
the stabilityai/sd-vae-ft-mse VAE (MIT). OpenRAIL-M allows commercial use of the model and of
its outputs under use-based restrictions (no illegal/harmful content, no impersonation without
consent, ...) that must be passed on to users: see docs/MODELS.md.

The engine derives an OpenVINO IR of the UNet with FP16-compressed weights
(`derived/portrait/…`, see derive.py); the ONNX files below are the checksummed sources.
"""
from parlante_engine.core.registry import ModelFile

RV_REPO = "Heliosoph/realistic-vision-cfg-onnx"
RV_REV = "20f2bfe722fa883f7852578f3335af1d437bcc75"
MODEL_ID = "realistic-vision-v6-onnx"
#: value of `model` in generate results and in the stock catalogue
MODEL_NAME = "realistic-vision-v6.0-b1 (SD 1.5, ONNX/OpenVINO) + sd-vae-ft-mse"
LICENSE = "CreativeML OpenRAIL-M"


def _rv(filename: str, sha: str, size: int, desc: str) -> ModelFile:
    return ModelFile(model_id=MODEL_ID, role="portrait-generation", capabilities=("generate",), repo=RV_REPO,
                     revision=RV_REV, filename=filename, sha256=sha, size=size, license=LICENSE,
                     commercial_use=True, description=desc)


TEXT_ENCODER = _rv("text_encoder/model.onnx", "430791d3b31e319ab59d04a6b770ad4bae5513fb7569effdc82707bc3c2cc650",
                   492588311, "CLIP ViT-L/14 text encoder of Realistic Vision V6.0 B1")
UNET_GRAPH = _rv("unet/model.onnx", "21d87eb51da5c6de1779e4f6a1d2928a87cce34b15d5fab915570bf2d193c1c3",
                 1206821, "UNet graph (weights in model.onnx_data)")
UNET_DATA = _rv("unet/model.onnx_data", "c909f1831ba3fec5fdbd3a3e967b0700484470c647475930edf0ee902a8dc5c0",
                3438083840, "UNet weights (860 M parameters, FP32)")
VAE_DECODER = _rv("vae_decoder/model.onnx", "20bf85ad399aafeac9ce47409f6a72f0d5ddb1becc2488ef4460a594fae2b752",
                  198078175, "VAE decoder (stabilityai/sd-vae-ft-mse, MIT)")
VAE_ENCODER = _rv("vae_encoder/model.onnx", "58360e3cb51fe8aaf092caaee599cb4a5e18f7be9112e90aa69ae976a27e5c3b",
                  136756653, "VAE encoder (high-resolution image-to-image pass)")
VOCAB = _rv("tokenizer/vocab.json", "fd67774a869730a6b27bf53d3e434e72054f2a825873c7af3bece183bb1f791e",
            1109372, "CLIP BPE vocabulary")
MERGES = _rv("tokenizer/merges.txt", "0bc7695944744789d6fd6d0ab754bcbbb9e36f1c182df0a006d619ce70a1e052",
             573514, "CLIP BPE merges")

MODELS = [TEXT_ENCODER, UNET_GRAPH, UNET_DATA, VAE_DECODER, VAE_ENCODER, VOCAB, MERGES]
