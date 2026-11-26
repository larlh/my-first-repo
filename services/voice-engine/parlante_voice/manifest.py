"""Weights of the voice engine: pinned revisions, sizes and sha256 of every file it loads.

Chatterbox Multilingual (Resemble AI, MIT). The speaker encoder (`ve.pt`), the default
conditionals (`conds.pt`) and the speech decoder (`s3gen.pt`) come from the base repository;
the text-to-speech-token model is the Spain-Spanish finetune `t3_es_es.safetensors` (it gives
an accent from Spain, the general multilingual T3 a Latin-American one). The `s3gen_v3`
decoder of the es-es repository is NOT used: chatterbox-tts 0.1.7 cannot load its keys.
"""

from __future__ import annotations

from dataclasses import dataclass

BASE_REPO = "ResembleAI/chatterbox"
BASE_REVISION = "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18"
ES_REPO = "ResembleAI/Chatterbox-Multilingual-es-es"
ES_REVISION = "7262b364e3222ba9446c9289e7485eadc47ed902"

LICENCE = "MIT"
ENGINE_ID = "chatterbox-mtl-es-es"
ENGINE_NAME = "Chatterbox Multilingual · T3 es-ES"


@dataclass(frozen=True)
class WeightFile:
    key: str
    repo: str
    revision: str
    filename: str
    size: int
    sha256: str


WEIGHTS: tuple[WeightFile, ...] = (
    WeightFile(
        "ve", BASE_REPO, BASE_REVISION, "ve.pt", 5_698_626,
        "4b16d836bc598509860f6fa068165a8bb5e9ac84f05582dfcf278a5a372879f1",
    ),
    WeightFile(
        "conds", BASE_REPO, BASE_REVISION, "conds.pt", 107_374,
        "6552d70568833628ba019c6b03459e77fe71ca197d5c560cef9411bee9d87f4e",
    ),
    WeightFile(
        "s3gen", BASE_REPO, BASE_REVISION, "s3gen.pt", 1_057_165_844,
        "9b9ff07e60b20c136e2b1b3d7563a24604e8d2c4c267888d1ee929dd0151d2a3",
    ),
    # Read by the multilingual tokenizer for Chinese; downloaded so the engine never fetches
    # anything at run time.
    WeightFile(
        "cangjie", BASE_REPO, BASE_REVISION, "Cangjie5_TC.json", 1_920_163,
        "7073fd9de919443ae88e0bd2449917a65fe54898a4413ed1edcc4b67f28bce8c",
    ),
    WeightFile(
        "t3_es_es", ES_REPO, ES_REVISION, "t3_es_es.safetensors", 2_143_990_264,
        "d85844b13ea8cb45e95b8d84a55bcfeccb2d743035cf304ee3d778fc6be39546",
    ),
    WeightFile(
        "tokenizer", ES_REPO, ES_REVISION, "grapheme_mtl_merged_expanded_v1.json", 69_989,
        "69632f47220a788a52ce2661d096453c5655e9bf25289d89a8d832c46ee07dbf",
    ),
)


def weight(key: str) -> WeightFile:
    for item in WEIGHTS:
        if item.key == key:
            return item
    raise KeyError(key)
