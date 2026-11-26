"""Weights of the animator.

Generator (shared by both drivers): LivePortrait implicit-keypoint networks, ONNX export from
warmshao/FasterLivePortrait (model card: MIT; upstream KwaiVGI/LivePortrait weights: MIT).
Audio driver: HuBERT features + LMDM motion diffusion from digital-avatar/ditto-talkinghead
(Apache-2.0 LICENSE file in the repository). The Ditto generator graphs are numerically the
same networks as the LivePortrait ones (verified: PSNR 135 dB), so one generator serves both.
"""
from parlante_engine.core.registry import ModelFile

LP_REPO = "warmshao/FasterLivePortrait"
LP_REV = "eb937f4bec7186598df2d1f68e1ddbb488ae1de5"
DITTO_REPO = "digital-avatar/ditto-talkinghead"
DITTO_REV = "e4a2f60328ee7c32af585ac4b3cce299e4c8e254"


def _lp(name: str, sha: str, size: int, desc: str, caps=("prepare", "animate")) -> ModelFile:
    return ModelFile(model_id="liveportrait-onnx", role="animation", capabilities=caps, repo=LP_REPO,
                     revision=LP_REV, filename=f"liveportrait_onnx/{name}", sha256=sha, size=size,
                     license="MIT", commercial_use=True, description=desc)


APPEARANCE = _lp("appearance_feature_extractor.onnx",
                 "d070afccca7f528ffb0ef5052b21588b42225a996661833f7bdede562d1ab921", 3355896,
                 "Appearance encoder: portrait crop -> 3D feature volume")
MOTION = _lp("motion_extractor.onnx",
             "219a46174297b2b411bb3c5dce48d3a8c8e07a9d82120a0da21f49f58b67fca6", 112648514,
             "Motion encoder: canonical keypoints, expression, head pose")
WARPING_SPADE = _lp("warping_spade.onnx",
                    "b0e7a566db8fba690c23523bcd2faa4f0d13f05418db84a779397a851062ad69", 421233096,
                    "Generator: dense motion + warp + SPADE decoder -> 512x512 frame")
STITCHING = _lp("stitching.onnx",
                "8e33658425e3f1014dc35b28f60ca7459189e8f78f20540262a2fe5ac1dc6ec7", 182363,
                "Stitching MLP (keeps the pasted crop aligned with the portrait)")
STITCHING_LIP = _lp("stitching_lip.onnx",
                    "101d7025cafdc199b6108c4841c7cdee88451787b01d319a1374b3c78344bf72", 150609,
                    "Lip retargeting MLP (mouth opening)")
STITCHING_EYE = _lp("stitching_eye.onnx",
                    "b9a2086c4d757c9be71b9b290d020678406da6a33c6247252c4bb0aeeff48afc", 580926,
                    "Eye retargeting MLP (blinks)")


def _ditto(name: str, sha: str, size: int, desc: str) -> ModelFile:
    return ModelFile(model_id="ditto-audio2motion", role="animation", capabilities=("animate-audio",),
                     repo=DITTO_REPO, revision=DITTO_REV, filename=f"ditto_onnx/{name}", sha256=sha, size=size,
                     license="Apache-2.0", commercial_use=True, description=desc)


HUBERT = _ditto("hubert.onnx", "327a5b90c0bfb9df251c9af91d0bea5e6284dbb0a4d02814f1d3ace6b4c2b5aa", 1458714493,
                "HuBERT speech features (audio driver)")
LMDM = _ditto("lmdm_v0.4_hubert.onnx", "ea6664518746a1c2e13db496ffe97216da715742be83e069a02cc86873c6dcfc",
              192453963, "Motion diffusion: speech features -> expression/pose (audio driver)")

MODELS = [APPEARANCE, MOTION, WARPING_SPADE, STITCHING, STITCHING_LIP, STITCHING_EYE, HUBERT, LMDM]
