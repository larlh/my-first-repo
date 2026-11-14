"""CLIP ViT-L/14 BPE tokenizer for Stable Diffusion 1.5, built with the `tokenizers` library
from the model's own `vocab.json` + `merges.txt` (no `transformers`, no torch).

Output is identical to `transformers.CLIPTokenizer` (checked on ASCII, accented and emoji text
during development): lower-cased, byte-level BPE with the `</w>` word suffix.

Prompts longer than one CLIP window (75 tokens) are split into several windows; the pipeline
encodes each window and concatenates the embeddings, so the tail of a long prompt is not lost.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

BOS, EOS = 49406, 49407
WINDOW = 77            # tokens per CLIP window, including BOS and EOS
MAX_WINDOWS = 2        # 150 usable tokens

_PATTERN = r"""<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+"""


class ClipTokenizer:
    def __init__(self, vocab_path: str | Path, merges_path: str | Path):
        from tokenizers import Regex, Tokenizer, models, normalizers, pre_tokenizers

        with open(vocab_path, encoding="utf-8") as fh:
            vocab = json.load(fh)
        merges: list[tuple[str, str]] = []
        with open(merges_path, encoding="utf-8") as fh:
            for line in fh.read().split("\n")[1:]:
                parts = line.split()
                if len(parts) == 2:
                    merges.append((parts[0], parts[1]))
        tok = Tokenizer(models.BPE(vocab=vocab, merges=merges, unk_token="<|endoftext|>",
                                   end_of_word_suffix="</w>", continuing_subword_prefix=""))
        tok.normalizer = normalizers.Sequence(
            [normalizers.NFC(), normalizers.Replace(Regex(r"\s+"), " "), normalizers.Lowercase()])
        tok.pre_tokenizer = pre_tokenizers.Sequence([
            pre_tokenizers.Split(Regex(_PATTERN), behavior="removed", invert=True),
            pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False),
        ])
        self._tok = tok

    def ids(self, text: str) -> list[int]:
        """Token ids without BOS/EOS."""
        return self._tok.encode(text.strip()).ids

    def count(self, text: str) -> int:
        return len(self.ids(text))

    def windows(self, text: str) -> np.ndarray:
        """int64 array [n_windows, 77]; each window is BOS + up to 75 tokens + EOS padding.

        A prompt that fits is ONE window (the case the model was trained on). A longer one is
        split into windows of similar length, cut at commas so phrases stay whole: an almost
        empty second window would dilute the first one in cross-attention (measured: the
        subject's gender and clothing were ignored with a 73 + 7 token split)."""
        ids = self.ids(text)
        comma = self._tok.token_to_id(",</w>")
        body = WINDOW - 2
        chunks: list[list[int]] = []
        n = min(MAX_WINDOWS, max(1, -(-len(ids) // body)))
        while ids and len(chunks) < n:
            remaining_windows = n - len(chunks)
            if remaining_windows == 1:
                chunks.append(ids[:body])
                ids = []
                break
            target = min(body, -(-len(ids) // remaining_windows))
            cut = target
            for delta in range(0, 16):                      # nearest comma around the target
                for i in (target + delta, target - delta):
                    if 0 < i <= body and i <= len(ids) and ids[i - 1] == comma:
                        cut = i
                        break
                else:
                    continue
                break
            chunks.append(ids[:cut])
            ids = ids[cut:]
        if not chunks:
            chunks = [[]]
        out = np.full((len(chunks), WINDOW), EOS, np.int64)
        for row, chunk in enumerate(chunks):
            out[row, 0] = BOS
            out[row, 1: 1 + len(chunk)] = chunk
        return out
