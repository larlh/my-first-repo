"""Split a script into chunks Chatterbox can speak in one pass.

The T3 model stops after 1000 speech tokens (~40 s) and is most natural with medium-length
sentences, so text is cut at sentence ends and long sentences at clause boundaries, then
neighbours are merged up to MAX_CHARS.
"""

from __future__ import annotations

import re

MAX_CHARS = 220
_SENTENCE = re.compile(r"(?<=[.!?…])\s+")
_CLAUSE = re.compile(r"(?<=[,;:])\s+")


def _split_long(sentence: str) -> list[str]:
    if len(sentence) <= MAX_CHARS:
        return [sentence]
    out: list[str] = []
    for clause in _CLAUSE.split(sentence):
        while len(clause) > MAX_CHARS:
            cut = clause.rfind(" ", 0, MAX_CHARS)
            cut = cut if cut > 0 else MAX_CHARS
            out.append(clause[:cut].strip())
            clause = clause[cut:].strip()
        if clause:
            out.append(clause)
    return out


def split_text(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    pieces: list[str] = []
    for sentence in _SENTENCE.split(text):
        pieces.extend(_split_long(sentence.strip()))
    chunks: list[str] = []
    for piece in pieces:
        if not piece:
            continue
        if chunks and len(chunks[-1]) + 1 + len(piece) <= MAX_CHARS:
            chunks[-1] = f"{chunks[-1]} {piece}"
        else:
            chunks.append(piece)
    return chunks
