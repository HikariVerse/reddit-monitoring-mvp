"""共享依赖：模型编码器单例。"""
from __future__ import annotations

from pathlib import Path
from threading import Lock
import os

ROOT = Path(__file__).resolve().parents[2]
_ENC = None
_LOCK = Lock()


def get_encoder():
    global _ENC
    if _ENC is None:
        with _LOCK:
            if _ENC is None:
                from model_runtime import PotionINT8Encoder
                model_dir = os.environ.get("BI_POTION_MODEL_DIR", str(ROOT / "models" / "potion-int8"))
                _ENC = PotionINT8Encoder(model_dir)
    return _ENC
