"""Presenter prompt template (no weights needed)."""
from __future__ import annotations

import pytest

from parlante_engine.core.errors import EngineError
from parlante_engine.portrait.prompts import (BACKGROUNDS, NEGATIVE, SKIN_TONES, STYLES, PortraitSpec, build_prompt,
                                               detect_gender, prompt_from_description, spanish_to_english)

MANDATORY = ("front view portrait", "facing the camera", "lips closed", "head and shoulders", "wall background")


def test_structured_prompt_has_the_presenter_constraints_and_the_parameters():
    spec = PortraitSpec(gender="female", age=34, skin_tone="brown", heritage="South Asian",
                        hair="long black hair", clothing="a teal blazer", style="business", extra="thin glasses")
    pair = build_prompt(spec)
    for phrase in MANDATORY:
        assert phrase in pair.positive
    for phrase in ("34 year old", "South Asian woman", "brown skin", "long black hair", "thin glasses",
                   "wearing a teal blazer"):
        assert phrase in pair.positive
    # the mouth must be closed at rest: pushed from both sides
    assert "open mouth" in pair.negative and "teeth" in pair.negative
    assert "man, male" in pair.negative            # counter-terms for the requested gender
    assert pair.gender == "female"


def test_prompt_is_deterministic_and_parameters_change_it():
    a = build_prompt(PortraitSpec(gender="male", age=52, style="healthcare"))
    b = build_prompt(PortraitSpec(gender="male", age=52, style="healthcare"))
    c = build_prompt(PortraitSpec(gender="male", age=52, style="teacher"))
    assert a == b
    assert a.positive != c.positive
    assert "doctor coat" in a.positive and "middle-aged" in a.positive
    assert "young" in a.negative                    # an older subject pushes youth away


@pytest.mark.parametrize("style", sorted(STYLES))
@pytest.mark.parametrize("gender", ["female", "male", "neutral"])
def test_every_style_has_default_clothing_for_every_gender(style, gender):
    pair = build_prompt(PortraitSpec(gender=gender, style=style))
    assert f"wearing {STYLES[style][gender]}" in pair.positive
    assert NEGATIVE.split(",")[0] in pair.negative


def test_all_declared_options_build():
    for tone in SKIN_TONES:
        for background in BACKGROUNDS:
            pair = build_prompt(PortraitSpec(gender="neutral", skin_tone=tone, background=background))
            assert SKIN_TONES[tone] in pair.positive and BACKGROUNDS[background] in pair.positive


@pytest.mark.parametrize("bad", [
    dict(gender="robot"), dict(age=12), dict(age=17), dict(age=140), dict(skin_tone="purple"),
    dict(style="pirate"), dict(background="beach"),
])
def test_invalid_specs_are_rejected(bad):
    with pytest.raises(EngineError) as err:
        build_prompt(PortraitSpec(**bad))
    assert err.value.code == "VALIDATION_ERROR"


def test_free_text_cannot_inject_prompt_weight_syntax_or_newlines():
    pair = build_prompt(PortraitSpec(hair="(((red hair:1.9)))\n<lora:x>", extra="[nsfw] {a|b}"))
    for ch in "()[]{}<>|\n":
        assert ch not in pair.positive


def test_description_in_spanish_is_wrapped_and_translated():
    pair = prompt_from_description("Mujer de 35 años, pelo castaño rizado, chaqueta azul marino y gafas")
    assert pair.gender == "female"
    for phrase in ("woman", "35 years old", "hair", "curly", "navy blue", "glasses"):
        assert phrase in pair.positive
    for phrase in MANDATORY:
        assert phrase in pair.positive
    assert "años" not in pair.positive


def test_description_gender_detection_and_override():
    assert detect_gender("hombre mayor con barba canosa y bata médica") == "male"
    assert detect_gender("médica joven") == "female"
    assert detect_gender("a doctor with glasses") == "neutral"
    assert detect_gender("hombre y mujer") == "neutral"
    forced = prompt_from_description("a doctor with glasses", gender="male")
    assert forced.gender == "male" and "man" in forced.positive and "woman, female" in forced.negative


def test_description_without_clothing_gets_modest_clothes_and_with_clothing_does_not():
    assert "modest professional clothes" in prompt_from_description("young teacher with freckles").positive
    assert "modest professional clothes" not in prompt_from_description("man wearing a green sweater").positive


def test_spanish_to_english_keeps_english_text():
    assert spanish_to_english("a friendly man in a green sweater") == "a friendly man in a green sweater"
    assert spanish_to_english("Profesora pelirroja con pecas") == "teacher red-haired with freckles"


@pytest.mark.parametrize("text", ["niña de 10 años", "a 16 year old girl", "teen boy", "bebé sonriente",
                                  "adolescente con gafas", "un chaval de 15 años"])
def test_minors_are_refused(text):
    with pytest.raises(EngineError) as err:
        prompt_from_description(text)
    assert err.value.reason == "minor_not_allowed"


def test_empty_and_overlong_descriptions():
    with pytest.raises(EngineError):
        prompt_from_description("  ,, ")
    pair = prompt_from_description("woman " + "very " * 400 + "tall")
    assert len(pair.positive) < 900            # the description is capped, the constraints survive
    for phrase in MANDATORY:
        assert phrase in pair.positive
