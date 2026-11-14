"""Prompt template for presenter avatars.

Every portrait the engine generates must be usable by the animator: head-and-shoulders medium
shot, frontal, looking at the camera, MOUTH CLOSED with a neutral-friendly expression, studio
lighting and a plain background that mattes cleanly. The template enforces that framing around
either a structured `PortraitSpec` (age, gender, skin tone, hair, clothing, style) or a
free-text description (the HTTP API), and adds the negative prompt.

Stable Diffusion's CLIP text encoder is English-centric, so free text gets a small
deterministic Spanish -> English keyword pass (best effort, documented as such).
Only adult, clothed, synthetic presenters are generated: descriptions of minors are refused and
nudity is pushed away by the negative prompt.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from parlante_engine.core.errors import EngineError

GENDERS = ("female", "male", "neutral")
_NOUN = {"female": "woman", "male": "man", "neutral": "person"}

#: skin tone -> phrase (kept short: every token counts)
SKIN_TONES = {
    "very-light": "very fair skin",
    "light": "light skin",
    "medium": "medium olive skin",
    "tan": "tan skin",
    "brown": "brown skin",
    "dark": "dark brown skin",
}

#: style/profession -> default clothing per gender (all closed necklines: the base model drifts
#: to revealing clothes unless the garment is explicit)
STYLES = {
    "business": {
        "female": "a navy blazer over a white high-neck blouse",
        "male": "a charcoal suit jacket, white shirt and blue tie",
        "neutral": "a dark blazer over a white collared shirt",
    },
    "casual": {
        "female": "a plain crew-neck sweater",
        "male": "a plain crew-neck sweater",
        "neutral": "a plain crew-neck sweater",
    },
    "healthcare": {
        "female": "light blue medical scrubs with a v-neck collar",
        "male": "a white doctor coat over a light blue shirt",
        "neutral": "light blue medical scrubs",
    },
    "teacher": {
        "female": "a cardigan over a collared blouse",
        "male": "a knitted vest over a collared shirt",
        "neutral": "a cardigan over a collared shirt",
    },
    "creative": {
        "female": "a black turtleneck",
        "male": "a black turtleneck",
        "neutral": "a black turtleneck",
    },
    "tech": {
        "female": "a gray zip hoodie over a white t-shirt",
        "male": "a dark polo shirt",
        "neutral": "a dark polo shirt",
    },
    "hospitality": {
        "female": "a white shirt with a dark vest",
        "male": "a white shirt with a dark vest",
        "neutral": "a white shirt with a dark vest",
    },
}

BACKGROUNDS = {
    "light-gray": "plain light gray wall background",
    "white": "plain white wall background",
    "blue-gray": "plain blue gray wall background",
    "beige": "plain beige wall background",
}

_HEAD = "RAW photo, front view portrait of"
#: never dropped: without them the portrait is useless for the animator
_POSE = "facing the camera, looking into the camera, lips closed"
_FRAMING = "head and shoulders, centered"
#: dropped from the END when the prompt would not fit in one CLIP window (75 tokens)
_OPTIONAL = ("calm friendly expression", "soft even studio lighting", "sharp focus", "natural skin texture")
TOKEN_BUDGET = 75

#: one CLIP window including the gender / age counter-terms (checked by the tests)
NEGATIVE = (
    "open mouth, teeth, laughing, tilted head, side view, looking away, hands, raised arm, cleavage, "
    "bare shoulders, nude, cartoon, painting, illustration, 3d render, anime, doll, deformed, "
    "asymmetric eyes, blurry, text, watermark, multiple people, busy background, studio equipment"
)
_NEGATIVE_GENDER = {"female": "man, male, beard", "male": "woman, female", "neutral": ""}
_NEGATIVE_AGE_YOUNG = "old, wrinkles"
_NEGATIVE_AGE_OLD = "young, teenager"

MIN_AGE, MAX_AGE = 18, 90


@dataclass(frozen=True)
class PromptPair:
    positive: str
    negative: str
    gender: str


@dataclass(frozen=True)
class PortraitSpec:
    gender: str = "neutral"
    #: years (18..90); None lets the model choose an adult
    age: int | None = None
    skin_tone: str | None = None
    #: optional free text such as "East Asian", "Latina", "Nordic" (helps the model with skin tone)
    heritage: str | None = None
    hair: str | None = None
    clothing: str | None = None
    style: str = "business"
    #: extra free text: "rectangular glasses", "short beard", ...
    extra: str | None = None
    background: str = "light-gray"

    def validate(self) -> None:
        if self.gender not in GENDERS:
            raise EngineError("VALIDATION_ERROR", f"gender must be one of {GENDERS}", "invalid_gender")
        if self.age is not None and not (MIN_AGE <= int(self.age) <= MAX_AGE):
            raise EngineError("VALIDATION_ERROR", f"age must be between {MIN_AGE} and {MAX_AGE}: only adult "
                              "presenters can be generated.", "invalid_age")
        if self.skin_tone is not None and self.skin_tone not in SKIN_TONES:
            raise EngineError("VALIDATION_ERROR", f"skin_tone must be one of {tuple(SKIN_TONES)}", "invalid_skin_tone")
        if self.style not in STYLES:
            raise EngineError("VALIDATION_ERROR", f"style must be one of {tuple(STYLES)}", "invalid_style")
        if self.background not in BACKGROUNDS:
            raise EngineError("VALIDATION_ERROR", f"background must be one of {tuple(BACKGROUNDS)}",
                              "invalid_background")


def _clean(text: str | None, limit: int = 160) -> str:
    """Free-text fragment made safe for the prompt: one line, no prompt-weight syntax."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[\r\n\t]+", " ", text)
    text = re.sub(r"[()\[\]{}<>|\\]", " ", text)          # no attention / embedding syntax
    text = re.sub(r"\s+", " ", text).strip(" ,.;:")
    return text[:limit].rstrip(" ,")


def approx_tokens(text: str) -> int:
    """Estimate of the CLIP token count without the vocabulary: one per word, digit and
    punctuation mark. Slightly low for rare words, so callers without the real tokenizer use a
    smaller budget."""
    return len(re.findall(r"[^\W\d_]+|\d|[^\w\s]|_", text, flags=re.UNICODE))


def _assemble(required: list[str], optional: tuple[str, ...], count_tokens) -> str:
    """Join the parts with commas, dropping optional parts from the end until the prompt fits
    in one CLIP window. A prompt whose REQUIRED parts already overflow is returned whole (the
    tokenizer then splits it into two balanced windows)."""
    budget = TOKEN_BUDGET if count_tokens is not None else TOKEN_BUDGET - 4
    counter = count_tokens or approx_tokens
    parts = [p for p in required if p]
    kept = list(optional)
    while kept and counter(", ".join(parts + kept)) > budget:
        kept.pop()
    return ", ".join(parts + kept)


def _age_negative(age: int | None) -> str:
    if age is None:
        return ""
    if age >= 50:
        return _NEGATIVE_AGE_OLD
    if age <= 30:
        return _NEGATIVE_AGE_YOUNG
    return ""


def _join_negative(*parts: str) -> str:
    return ", ".join(p for p in parts if p)


def build_prompt(spec: PortraitSpec, count_tokens=None) -> PromptPair:
    """Structured description -> (positive, negative). Deterministic. `count_tokens` is the real
    CLIP token counter when the tokenizer is loaded (an estimate is used otherwise)."""
    spec.validate()
    noun = _NOUN[spec.gender]
    who = []
    if spec.age is not None:
        who.append(f"{int(spec.age)} year old")
        if spec.age >= 60:
            who.append("senior")
        elif spec.age >= 45:
            who.append("middle-aged")
    heritage = _clean(spec.heritage, 40)
    if heritage:
        who.append(heritage)
    who.append(noun)
    subject = "a " + " ".join(who)
    if spec.skin_tone:
        subject += f" with {SKIN_TONES[spec.skin_tone]}"
    parts = [f"{_HEAD} {subject}"]
    hair = _clean(spec.hair, 80)
    if hair:
        parts.append(hair)
    extra = _clean(spec.extra, 120)
    if extra:
        parts.append(extra)
    clothing = _clean(spec.clothing, 100) or STYLES[spec.style][spec.gender]
    parts.append(f"wearing {clothing}")
    parts += [_POSE, _FRAMING, BACKGROUNDS[spec.background]]
    negative = _join_negative(_NEGATIVE_GENDER[spec.gender], _age_negative(spec.age), NEGATIVE)
    return PromptPair(_assemble(parts, _OPTIONAL, count_tokens), negative, spec.gender)


# ---------------------------------------------------------------- free text (HTTP API)
#: phrases first (longest match wins), then single words. Accents are folded before matching.
_ES_PHRASES = [
    (r"de mediana edad", "middle-aged"), (r"azul marino", "navy blue"), (r"azul claro", "light blue"),
    (r"verde oscuro", "dark green"), (r"gris oscuro", "dark gray"), (r"gris claro", "light gray"), (r"tercera edad", "elderly"), (r"pelo|cabello", "hair"),
    (r"piel (muy )?clara", "light skin"), (r"piel (muy )?oscura", "dark brown skin"),
    (r"piel morena", "brown skin"), (r"piel negra", "dark brown skin"), (r"piel blanca", "light skin"),
    (r"tez clara", "light skin"), (r"tez morena", "brown skin"), (r"tez oscura", "dark brown skin"),
    (r"de color", "dark-skinned"), (r"cola de caballo|coleta", "ponytail"), (r"media melena", "shoulder-length hair"),
    (r"bata (blanca|medica|de medico)", "white doctor coat"), (r"bata", "white coat"),
    (r"traje de chaqueta", "suit"), (r"cuello alto", "turtleneck"), (r"jersey de cuello alto", "turtleneck sweater"),
    (r"camisa de cuadros", "plaid shirt"), (r"gafas de sol", "glasses"), (r"sin barba", "clean-shaven"),
    (r"ojos (\w+)", r"\1 eyes"), (r"(\d{1,3}) anos", r"\1 years old"), (r"anos", "years old"),
]
_ES_WORDS = {
    "mujer": "woman", "senora": "woman", "chica": "young woman", "hombre": "man", "senor": "man",
    "chico": "young man", "persona": "person", "joven": "young", "mayor": "older", "anciana": "elderly",
    "anciano": "elderly", "adulto": "adult", "adulta": "adult", "maduro": "middle-aged", "madura": "middle-aged",
    "rubio": "blonde", "rubia": "blonde", "moreno": "dark-haired", "morena": "dark-haired",
    "castano": "brown", "castana": "brown", "pelirrojo": "red-haired", "pelirroja": "red-haired",
    "canoso": "gray-haired", "canosa": "gray-haired", "canas": "gray hair", "gris": "gray", "negro": "black",
    "negra": "black", "blanco": "white", "blanca": "white", "rojo": "red", "roja": "red", "azul": "blue",
    "azules": "blue", "verde": "green", "verdes": "green", "marron": "brown", "marrones": "brown",
    "rizado": "curly", "rizada": "curly", "rizos": "curls", "liso": "straight", "lisa": "straight",
    "ondulado": "wavy", "ondulada": "wavy", "corto": "short", "corta": "short", "largo": "long", "larga": "long",
    "recogido": "tied back", "recogida": "tied back", "trenzas": "braids", "calvo": "bald", "rapado": "buzz cut",
    "flequillo": "bangs", "mono": "hair bun", "barba": "beard", "bigote": "mustache", "perilla": "goatee",
    "gafas": "glasses", "lentes": "glasses", "pendientes": "earrings", "panuelo": "headscarf", "hiyab": "hijab",
    "pecas": "freckles", "arrugas": "wrinkles", "sonriente": "friendly", "amable": "friendly", "seria": "serious",
    "serio": "serious", "traje": "suit", "chaqueta": "blazer", "americana": "blazer", "camisa": "shirt",
    "blusa": "blouse", "corbata": "tie", "jersey": "sweater", "sueter": "sweater", "camiseta": "t-shirt",
    "sudadera": "hoodie", "vestido": "high-neck dress", "chaleco": "vest", "uniforme": "uniform",
    "rebeca": "cardigan", "polo": "polo shirt", "medico": "doctor", "medica": "doctor", "doctora": "doctor",
    "doctor": "doctor", "enfermera": "nurse", "enfermero": "nurse", "profesor": "teacher", "profesora": "teacher",
    "maestra": "teacher", "maestro": "teacher", "docente": "teacher", "presentador": "news presenter",
    "presentadora": "news presenter", "ejecutiva": "business executive", "ejecutivo": "business executive",
    "empresaria": "businesswoman", "empresario": "businessman", "abogada": "lawyer", "abogado": "lawyer",
    "ingeniera": "engineer", "ingeniero": "engineer", "cocinero": "chef", "cocinera": "chef",
    "cientifica": "scientist", "cientifico": "scientist", "asiatica": "East Asian", "asiatico": "East Asian",
    "latina": "Latina", "latino": "Latino", "africana": "African", "africano": "African", "europea": "European",
    "europeo": "European", "arabe": "Middle Eastern", "india": "South Asian", "indio": "South Asian",
    "mediterranea": "Mediterranean", "mediterraneo": "Mediterranean", "nordica": "Nordic", "nordico": "Nordic",
    "con": "with", "y": "and", "de": "", "del": "", "la": "", "el": "", "las": "", "los": "", "un": "a",
    "una": "a", "unos": "", "unas": "", "que": "", "lleva": "wearing", "llevando": "wearing", "viste": "wearing",
    "vistiendo": "wearing", "tiene": "with", "muy": "very", "sin": "without", "claro": "light", "clara": "light",
    "oscuro": "dark", "oscura": "dark", "piel": "skin", "ojos": "eyes", "edad": "age", "estilo": "style",
    "profesional": "professional", "elegante": "elegant", "informal": "casual", "deportivo": "sporty",
    "deportiva": "sporty", "sanitario": "healthcare worker", "sanitaria": "healthcare worker",
}

_MINOR_WORDS = re.compile(
    r"\b(child|children|kid|kids|boy|girl|teen|teens|teenager|teenage|toddler|baby|infant|minor|schoolgirl|schoolboy|"
    r"nino|nina|ninos|ninas|bebe|adolescente|adolescentes|menor|menores|chaval|chavala|colegiala|colegial|"
    r"infantil|preteen|loli|shota)\b")
_AGE_NUMBER = re.compile(r"\b(\d{1,3})\s*(?:-|\s)?\s*(?:years?|yrs?|yo|y/o|anos)\b")
_FEMALE_WORDS = re.compile(
    r"\b(woman|female|lady|businesswoman|actress|mujer|senora|chica|presentadora|profesora|doctora|medica|enfermera|"
    r"ejecutiva|empresaria|abogada|ingeniera|cientifica|maestra|cocinera|rubia|pelirroja|canosa|asiatica|africana|"
    r"europea|nordica|latina)\b")
_MALE_WORDS = re.compile(
    r"\b(man|male|gentleman|guy|businessman|actor|hombre|senor|chico|presentador|profesor|medico|enfermero|ejecutivo|"
    r"empresario|abogado|ingeniero|cientifico|maestro|cocinero|rubio|pelirrojo|canoso|calvo|asiatico|africano|"
    r"europeo|nordico|latino|barba|bigote|beard|mustache)\b")
_PERSON_NOUN = re.compile(r"\b(woman|man|person|lady|gentleman)\b")
_CLOTHING_WORDS = re.compile(
    r"\b(wearing|shirt|blouse|suit|blazer|sweater|coat|scrubs|dress|hoodie|uniform|turtleneck|vest|cardigan|jacket|"
    r"polo|t-shirt)\b")


def fold(text: str) -> str:
    """Lower-case and strip accents (ñ -> n) for keyword matching."""
    text = unicodedata.normalize("NFD", text.lower())
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


def spanish_to_english(text: str) -> str:
    """Keyword-level Spanish -> English for portrait descriptions. Unknown words pass through
    unchanged, so English input is returned (almost) as is. Best effort, not a translator."""
    t = fold(text)
    for pattern, repl in _ES_PHRASES:
        t = re.sub(rf"\b(?:{pattern})\b", repl, t)

    def word(m: re.Match) -> str:
        w = m.group(0)
        return _ES_WORDS.get(w, w)

    t = re.sub(r"[a-z]+", word, t)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"\s+,", ",", t)
    return t.strip(" ,")


_FEMALE_NOUNS = re.compile(r"\b(woman|female|lady|businesswoman|mujer|senora|chica)\b")
_MALE_NOUNS = re.compile(r"\b(man|male|gentleman|guy|businessman|hombre|senor|chico)\b")


def detect_gender(text: str) -> str:
    """'female' | 'male' when the description is unambiguous, else 'neutral'. Explicit nouns
    (mujer, man, …) win over gendered adjectives and professions (médica, canoso, …)."""
    t = fold(text)
    for female, male in ((_FEMALE_NOUNS.search(t), _MALE_NOUNS.search(t)),
                         (_FEMALE_WORDS.search(t), _MALE_WORDS.search(t))):
        if female and not male:
            return "female"
        if male and not female:
            return "male"
        if female and male:
            return "neutral"
    return "neutral"


def check_adult(text: str) -> None:
    """Refuse descriptions of minors (the engine only generates adult presenters)."""
    t = fold(text)
    ages = [int(m.group(1)) for m in _AGE_NUMBER.finditer(t)]
    if _MINOR_WORDS.search(t) or any(a < MIN_AGE for a in ages):
        raise EngineError("VALIDATION_ERROR", "Only adult synthetic presenters can be generated; the description "
                          "refers to a minor.", "minor_not_allowed")


def _described_age(text: str) -> int | None:
    ages = [int(m.group(1)) for m in _AGE_NUMBER.finditer(fold(text))]
    return ages[0] if ages else None


def prompt_from_description(description: str, gender: str | None = None, count_tokens=None) -> PromptPair:
    """Free-text description (Spanish or English) -> presenter prompt, with the same pose,
    framing and background constraints as the structured template."""
    description = _clean(description, 300)
    if not description:
        raise EngineError("VALIDATION_ERROR", "prompt must describe the person.", "empty_prompt")
    check_adult(description)
    if gender is not None and gender not in GENDERS:
        raise EngineError("VALIDATION_ERROR", f"gender must be one of {GENDERS}", "invalid_gender")
    english = spanish_to_english(description)
    g = gender if gender in ("female", "male") else detect_gender(description)
    subject = english
    # the description rarely names the noun the model needs: add it when missing
    if not _PERSON_NOUN.search(english):
        subject = f"{_NOUN[g] if g != 'neutral' else 'adult person'}, {english}"
    article = "" if re.match(r"^(a|an|the)\b", subject) else ("an " if subject[:1] in "aeiou" else "a ")
    parts = [f"{_HEAD} {article}{subject}"]
    if not _CLOTHING_WORDS.search(english):
        parts.append("wearing modest professional clothes")
    parts += [_POSE, _FRAMING, BACKGROUNDS["light-gray"]]
    positive = _assemble(parts, _OPTIONAL, count_tokens)
    negative = _join_negative(_NEGATIVE_GENDER[g], _age_negative(_described_age(description)), NEGATIVE)
    return PromptPair(positive, negative, g)
