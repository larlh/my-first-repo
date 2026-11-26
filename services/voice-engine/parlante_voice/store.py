"""Cloned voices on disk: `<data dir>/voices/<voiceId>/{conds.pt, meta.json}`.

Only the conditionals derived from the sample are kept (speaker embedding, prompt tokens and
decoder reference features), never the recording itself: Parlante keeps the sample in its own
storage and deletes it with the voice. Deleting a voice removes its whole directory.
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
import time
from pathlib import Path

VOICE_ID = re.compile(r"^cbx_[a-z0-9]{20}$")


def new_voice_id() -> str:
    return "cbx_" + secrets.token_hex(10)


def valid_voice_id(voice_id: str) -> bool:
    return bool(VOICE_ID.fullmatch(voice_id))


class VoiceStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def directory(self, voice_id: str) -> Path:
        if not valid_voice_id(voice_id):
            raise KeyError(voice_id)
        return self.root / voice_id

    def conds_path(self, voice_id: str) -> Path:
        return self.directory(voice_id) / "conds.pt"

    def exists(self, voice_id: str) -> bool:
        return valid_voice_id(voice_id) and self.conds_path(voice_id).is_file()

    def meta(self, voice_id: str) -> dict | None:
        try:
            return json.loads((self.directory(voice_id) / "meta.json").read_text())
        except (KeyError, OSError, ValueError):
            return None

    def write_meta(self, voice_id: str, meta: dict) -> None:
        path = self.directory(voice_id)
        path.mkdir(parents=True, exist_ok=True)
        (path / "meta.json").write_text(json.dumps({**meta, "createdAt": int(time.time())}))

    def delete(self, voice_id: str) -> bool:
        if not valid_voice_id(voice_id):
            return False
        path = self.root / voice_id
        existed = path.exists()
        shutil.rmtree(path, ignore_errors=True)
        return existed

    def count(self) -> int:
        return sum(1 for p in self.root.iterdir() if valid_voice_id(p.name) and (p / "conds.pt").is_file())
