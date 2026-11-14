"""CLIP ViT-L/14 BPE tokenizer for Stable Diffusion 1.5, built with the `tokenizers` library
from the model's own `vocab.json` + `merges.txt` (no `transformers`, no torch).

Output is identical to `transformers.CLIPTokenizer` (checked on ASCII, accented and emoji text
during development): lower-cased, byte-level BPE with the `</w>` word suffix.

One CLIP window only (75 tokens + BOS/EOS), longer prompts are truncated. Encoding a long
prompt as two concatenated windows was tried and REJECTED: for the same seed, an 80-token
presenter prompt split 73 + 7 and 40 + 40 both produced a person of the wrong gender and
clothing, while the 70-token single-window version followed the description. The prompt
template therefore budgets its parts to fit (prompts.py).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

BOS, EOS = 49406, 49407
WINDOW = 77            # tokens per CLIP window, including BOS and EOS
MAX_TOKENS = WINDOW - 2

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

    def encode(self, text: str) -> np.ndarray:
        """int64 array [1, 77]: BOS + up to 75 tokens + EOS padding (the tail is truncated)."""
        ids = self.ids(text)[:MAX_TOKENS]
        out = np.full((1, WINDOW), EOS, np.int64)
        out[0, 0] = BOS
        out[0, 1: 1 + len(ids)] = ids
        return out
