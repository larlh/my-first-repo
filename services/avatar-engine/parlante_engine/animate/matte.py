"""Per-frame matte for compositing the clip over any background.

The portrait's matte (from `prepare`, any matting model) is static, but the head moves a few
pixels in every frame. Instead of re-segmenting each frame (which would discard the quality
of the prepared matte and flicker at the edges), the prepared matte is carried along with the
motion: dense optical flow (DIS) from each generated crop back to the portrait crop, heavily
smoothed because head motion is smooth, re-samples the matte. Outside the generator crop
the matte is the static one. ~10 ms per frame."""
from __future__ import annotations

import cv2
import numpy as np

from .lp import CROP, Avatar, Paster

FLOW_SIZE = 256


class MatteTracker:
    def __init__(self, avatar: Avatar, paster: Paster, portrait_bgr: np.ndarray, matte: np.ndarray):
        """matte: float32 HxW in 0..1, same size as the portrait."""
        self.paster = paster
        m_o2c = cv2.invertAffineTransform(avatar.m_c2o.astype(np.float64))
        crop = cv2.warpAffine(portrait_bgr, m_o2c, (CROP, CROP), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        self.ref_gray = cv2.cvtColor(cv2.resize(crop, (FLOW_SIZE, FLOW_SIZE), interpolation=cv2.INTER_AREA),
                                     cv2.COLOR_BGR2GRAY)
        self.matte_crop = cv2.warpAffine(matte, m_o2c, (CROP, CROP), flags=cv2.INTER_LINEAR,
                                         borderMode=cv2.BORDER_REPLICATE)
        interp = cv2.INTER_AREA if paster.out_w < matte.shape[1] else cv2.INTER_LINEAR
        self.static = cv2.resize(matte, (paster.out_w, paster.out_h), interpolation=interp)
        x0, y0, x1, y1 = paster.bbox
        self.static_local = self.static[y0:y1, x0:x1]
        self.dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        # flow is trusted only where the crop shows real portrait pixels (not replicated borders)
        m_small = m_o2c.copy()
        m_small *= FLOW_SIZE / CROP
        valid = cv2.warpAffine(np.ones(portrait_bgr.shape[:2], np.float32), m_small, (FLOW_SIZE, FLOW_SIZE),
                               flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        valid = cv2.erode(valid, np.ones((9, 9), np.uint8))
        self.valid = cv2.GaussianBlur(valid, (0, 0), 6.0)[..., None]
        gy, gx = np.mgrid[0:CROP, 0:CROP].astype(np.float32)
        self.gx, self.gy = gx, gy

    def frame_matte(self, frame_rgb512: np.ndarray) -> np.ndarray:
        """Generated crop -> uint8 matte of the full output frame."""
        gray = cv2.cvtColor(cv2.resize(frame_rgb512, (FLOW_SIZE, FLOW_SIZE), interpolation=cv2.INTER_AREA),
                            cv2.COLOR_RGB2GRAY)
        flow = self.dis.calc(gray, self.ref_gray, None)             # frame pixel -> portrait pixel
        flow = np.clip(flow, -12.0, 12.0) * self.valid
        flow = cv2.GaussianBlur(flow, (0, 0), 5.0)
        flow = cv2.resize(flow, (CROP, CROP), interpolation=cv2.INTER_LINEAR) * (CROP / FLOW_SIZE)
        moved = cv2.remap(self.matte_crop, self.gx + flow[..., 0], self.gy + flow[..., 1], cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)
        x0, y0, x1, y1 = self.paster.bbox
        local = cv2.warpAffine(moved, self.paster.m_local, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_REPLICATE)
        w = self.paster.mask[..., 0]
        out = self.static.copy()
        out[y0:y1, x0:x1] = local * w + self.static_local * (1.0 - w)
        return (np.clip(out, 0, 1) * 255.0 + 0.5).astype(np.uint8)


def load_matte(path, width: int, height: int) -> np.ndarray:
    """Read a matte PNG (grey, or the alpha channel of an RGBA image) as float32 0..1 at portrait size."""
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        from parlante_engine.core.errors import EngineError
        raise EngineError("UNPROCESSABLE", "maskPath could not be read as an image.", "mask_unreadable")
    if img.ndim == 3:
        img = img[..., 3] if img.shape[2] == 4 else cv2.cvtColor(img[..., :3], cv2.COLOR_BGR2GRAY)
    scale = 65535.0 if img.dtype == np.uint16 else 255.0
    matte = img.astype(np.float32) / scale
    if matte.shape != (height, width):
        matte = cv2.resize(matte, (width, height), interpolation=cv2.INTER_LINEAR)
    return matte
