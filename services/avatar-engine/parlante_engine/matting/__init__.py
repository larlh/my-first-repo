"""Person matting (alpha matte that separates the presenter from the background).

Public API: `parlante_engine.matting.api.matte(image_bgr) -> alpha`. `compute_alpha` is the
name the `prepare` sub-package looks up; it is the same function.
"""
from .api import available, matte, refine_edges, release

compute_alpha = matte

__all__ = ["available", "compute_alpha", "matte", "refine_edges", "release"]
