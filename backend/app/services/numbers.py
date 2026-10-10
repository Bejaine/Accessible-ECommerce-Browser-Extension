"""Spoken-number normaliser (Track A): number words in ASR transcripts and typed text → digits.

normalise_numbers("डेढ़ लाख के अंदर", "hi") == "150000 के अंदर"
parse_number("రెండున్నర లక్షలు", "te") == 250000

Covers English (incl. Indian English: lakh, crore, 15k), Hindi in Devanagari, romanised Hindi
(only when lang == "hi"), Telugu, native digits and Indian digit grouping (1,50,000).

Safe by default, because a wrong number is worse than a word left alone:
- a lone "weak" word stays a word: एक/दो/ek/do (दो is also "give": "डाल दो"), one ("the
  cheaper one"), ఒక ("a"). They become digits only inside a bigger number ("दो हज़ार").
- a lone multiplier stays a word ("lakhs of reviews", "सौ बार").
- numbers said side by side are not added ("two three days" -> "2 3 days").
- digits are never reformatted ("6.50" stays "6.50"); romanised words that are also common
  words ("saath" = with) are left out.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_DIGITS = str.maketrans("०१२३४५६७८९౦౧౨౩౪౫౬౭౮౯", "0123456789" * 2)
_GROUP_COMMA = re.compile(r"(?<=\d),(?=\d{2,3}\b)")  # 1,50,000 and 1,299 -> no commas

# kinds: unit (a value), mult (x100, x1000, ...), mod (साढ़े +0.5, सवा +0.25, पौने -0.25),
# point (decimal point), and (English "one hundred and five", "and a half")
UNIT, MULT, MOD, POINT, AND = "unit", "mult", "mod", "point", "and"


def _units(words: str, start: int = 0) -> dict[str, tuple[str, float]]:
    return {w: (UNIT, float(start + i)) for i, w in enumerate(words.split())}


_EN: dict[str, tuple[str, float]] = {
    **_units(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
        "fifteen sixteen seventeen eighteen nineteen"
    ),
    **{w: (UNIT, float(v)) for w, v in zip(
        "twenty thirty forty fifty sixty seventy eighty ninety".split(), range(20, 100, 10),
        strict=True,
    )},
    "half": (UNIT, 0.5),
    "hundred": (MULT, 1e2), "thousand": (MULT, 1e3), "million": (MULT, 1e6),
    "lakh": (MULT, 1e5), "lakhs": (MULT, 1e5), "lac": (MULT, 1e5), "lacs": (MULT, 1e5),
    "crore": (MULT, 1e7), "crores": (MULT, 1e7),
    "point": (POINT, 0.0), "and": (AND, 0.0),
}  # fmt: skip

_HI_1_99 = (
    "एक दो तीन चार पांच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस "
    "बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस "
    "तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस "
    "चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन "
    "छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ "
    "उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी "
    "अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे "
    "बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे"
)
_HI: dict[str, tuple[str, float]] = {
    **_units(_HI_1_99, start=1),
    "शून्य": (UNIT, 0.0), "छः": (UNIT, 6.0), "छे": (UNIT, 6.0), "पन्द्रह": (UNIT, 15.0),
    "डेढ़": (UNIT, 1.5), "ढाई": (UNIT, 2.5), "अढ़ाई": (UNIT, 2.5), "आधा": (UNIT, 0.5),
    "सौ": (MULT, 1e2), "हज़ार": (MULT, 1e3), "लाख": (MULT, 1e5), "करोड़": (MULT, 1e7),
    "साढ़े": (MOD, 0.5), "सवा": (MOD, 0.25), "पौने": (MOD, -0.25),
}  # fmt: skip

_HINGLISH: dict[str, tuple[str, float]] = {
    **{w: (UNIT, float(v)) for v, words in {
        1: "ek", 2: "do", 3: "teen", 4: "char chaar", 5: "paanch panch", 6: "chhe chhah chheh",
        7: "saat", 8: "aath", 9: "nau", 10: "das", 11: "gyarah", 12: "barah baarah",
        13: "terah", 14: "chaudah", 15: "pandrah", 16: "solah", 17: "satrah", 18: "atharah",
        19: "unnis", 20: "bees", 25: "pachees pachis", 30: "tees", 40: "chalis chaalis",
        50: "pachas pachaas", 70: "sattar", 80: "assi", 90: "nabbe",
    }.items() for w in words.split()},
    "dedh": (UNIT, 1.5), "derh": (UNIT, 1.5), "dhai": (UNIT, 2.5), "dhaai": (UNIT, 2.5),
    "aadha": (UNIT, 0.5), "adha": (UNIT, 0.5),
    "sau": (MULT, 1e2), "hazaar": (MULT, 1e3), "hazar": (MULT, 1e3), "hajar": (MULT, 1e3),
    "hajaar": (MULT, 1e3), "lakh": (MULT, 1e5), "lac": (MULT, 1e5), "crore": (MULT, 1e7),
    "karod": (MULT, 1e7), "karor": (MULT, 1e7),
    "saadhe": (MOD, 0.5), "sadhe": (MOD, 0.5), "sade": (MOD, 0.5),
    "sawa": (MOD, 0.25), "sava": (MOD, 0.25), "paune": (MOD, -0.25), "pone": (MOD, -0.25),
}  # fmt: skip

_TE: dict[str, tuple[str, float]] = {
    **_units(
        "సున్నా ఒకటి రెండు మూడు నాలుగు ఐదు ఆరు ఏడు ఎనిమిది తొమ్మిది పది పదకొండు పన్నెండు "
        "పదమూడు పద్నాలుగు పదిహేను పదహారు పదిహేడు పద్దెనిమిది పందొమ్మిది"
    ),
    **{w: (UNIT, float(v)) for v, words in {
        1: "ఒక", 5: "అయిదు", 20: "ఇరవై", 30: "ముప్పై ముప్పయి", 40: "నలభై నలబై", 50: "యాభై",
        60: "అరవై", 70: "డెబ్బై", 80: "ఎనభై", 90: "తొంభై", 100: "నూట నూరు",
        1.5: "ఒకటిన్నర", 2.5: "రెండున్నర", 3.5: "మూడున్నర", 4.5: "నాలుగున్నర",
        5.5: "ఐదున్నర", 6.5: "ఆరున్నర", 7.5: "ఏడున్నర", 8.5: "ఎనిమిదిన్నర",
        9.5: "తొమ్మిదిన్నర", 10.5: "పదిన్నర", 0.5: "అర",
        200: "రెండొందలు రెండొందల", 300: "మూడొందలు మూడొందల", 400: "నాలుగొందలు నాలుగొందల",
        500: "ఐదొందలు ఐదొందల", 600: "ఆరొందలు ఆరొందల", 700: "ఏడొందలు ఏడొందల",
        800: "ఎనిమిదొందలు ఎనిమిదొందల", 900: "తొమ్మిదొందలు తొమ్మిదొందల",
    }.items() for w in words.split()},
    **{w: (MULT, 1e2) for w in "వంద వందలు వందల".split()},
    **{w: (MULT, 1e3) for w in "వెయ్యి వేయి వేలు వేల".split()},
    **{w: (MULT, 1e5) for w in "లక్ష లక్షలు లక్షల".split()},
    **{w: (MULT, 1e7) for w in "కోటి కోట్లు కోట్ల".split()},
}  # fmt: skip

# Telugu question/emphasis endings on a number word: వందలా? (hundreds?), వేలే (thousands only)
_TE_ENDINGS = {"ా", "ే", "ో"}  # ా ే ో

# Alone, these mean "a"/"the one"/"give": only part of a bigger number makes them a number.
_WEAK = {"one", "एक", "दो", "ek", "do", "ఒక", "ఒకటి"}


def _key(word: str) -> str:
    """Lookup form: lower case; Hindi nukta and chandrabindu spellings folded (हज़ार = हजार,
    पाँच = पांच, डेढ़ = डेढ)."""
    word = word.lower().replace("़", "").replace("ँ", "ं")
    for composed, plain in (("ज़", "ज"), ("ड़", "ड"), ("ढ़", "ढ"), ("फ़", "फ")):
        word = word.replace(composed, plain)
    return word


def _lexicon(lang: str | None) -> dict[str, tuple[str, float]]:
    table = {**_EN, **_HI, **_TE}
    if lang == "hi":
        table |= _HINGLISH
    return {_key(w): v for w, v in table.items()}


_LEXICONS = {lang: _lexicon(lang) for lang in ("en", "hi", "te", None)}
_TOKEN = re.compile(
    r"(?P<num>\d+(?:\.\d+)?)(?P<k>[kK]\b)?"
    r"|(?P<word>[A-Za-zऀ-ॣॱ-ॿఀ-౥౰-౿‌‍]+)"
)


@dataclass
class _Tok:
    kind: str
    value: float
    start: int
    end: int
    text: str


@dataclass
class _Phrase:
    start: int
    end: int
    value: float
    tokens: list[_Tok]
    forced: bool = False  # replace even if it looks like a lone weak word ("ek se do lakh")


# Words between the two ends of a range: "पंद्रह से बीस हज़ार", "10-12 hazaar", "ten to fifteen
# thousand", "పది నుంచి పదిహేను వేల". English "and" only after "between".
_RANGE_WORDS = {"से", "se", "to", "or", "या", "ya", "నుంచి", "నుండి", "లేదా", "-", "–"}


def normalise_digits(text: str) -> str:
    return text.translate(_DIGITS)


def normalise_numbers(text: str, lang: str | None = None) -> str:
    text = _GROUP_COMMA.sub("", normalise_digits(text))
    phrases = _phrases(text, lang)
    _share_range_multipliers(text, phrases)
    out, last = [], 0
    for p in phrases:
        if p.forced or _worth_replacing(p):
            out += [text[last : p.start], _format(p.value)]
            last = p.end
    out.append(text[last:])
    return "".join(out)


def parse_number(text: str, lang: str | None = None) -> float | None:
    """The value if `text` is exactly one number (weak words included), else None."""
    text = _GROUP_COMMA.sub("", normalise_digits(text)).strip()
    phrases = _phrases(text, lang)
    if len(phrases) == 1 and phrases[0].start == 0 and phrases[0].end == len(text):
        return phrases[0].value
    return None


def _share_range_multipliers(text: str, phrases: list[_Phrase]) -> None:
    """ "15 से 20 हज़ार" means 15000 to 20000: the first end takes the second end's multiplier,
    but only if it has none of its own and the range then still runs upwards."""
    for a, b in zip(phrases, phrases[1:], strict=False):
        gap = text[a.end : b.start].strip().lower()
        between = gap == "and" and text[: a.start].rstrip().lower().endswith("between")
        if gap not in _RANGE_WORDS and not between:
            continue
        mults = [t.value for t in b.tokens if t.kind == MULT]
        if not mults or any(t.kind == MULT for t in a.tokens):
            continue
        scaled = a.value * max(mults)
        if scaled < b.value:
            a.value, a.forced = scaled, True


def _is_tens(v: float) -> bool:
    return 20 <= v < 100 and v % 10 == 0


def _worth_replacing(p: _Phrase) -> bool:
    if len(p.tokens) == 1:
        t = p.tokens[0]
        if t.kind == "digits" or t.kind == MULT or _key(t.text) in _WEAK:
            return False
    return True


def _format(value: float) -> str:
    return str(int(value)) if value == int(value) else f"{value:.6f}".rstrip("0").rstrip(".")


def _tokens(text: str, lang: str | None) -> list[_Tok]:
    lex = _LEXICONS.get(lang, _LEXICONS[None])
    toks = []
    for m in _TOKEN.finditer(text):
        if m.group("num"):
            value = float(m.group("num")) * (1000 if m.group("k") else 1)
            kind = UNIT if m.group("k") else "digits"
            toks.append(_Tok(kind, value, m.start(), m.end(), m.group()))
        else:
            word = _key(m.group("word"))
            kind, value = lex.get(word, ("word", 0.0))
            if kind == "word" and word[-1:] in _TE_ENDINGS:  # "వందలా?" = "hundreds?"
                kind, value = lex.get(word[:-1], ("word", 0.0))
            toks.append(_Tok(kind, value, m.start(), m.end(), m.group()))
    return toks


def _phrases(text: str, lang: str | None) -> list[_Phrase]:
    """Runs of number tokens separated only by spaces, evaluated in the Indian system."""
    toks = _tokens(text, lang)
    phrases: list[_Phrase] = []
    i = 0
    while i < len(toks):
        if toks[i].kind in ("word", AND, POINT):
            i += 1
            continue
        i = _read_phrase(text, toks, i, phrases)
    return phrases


def _read_phrase(text: str, toks: list[_Tok], i: int, phrases: list[_Phrase]) -> int:
    total = 0.0
    current: float | None = None
    mod: float | None = None
    used: list[_Tok] = []

    def adjacent(j: int) -> bool:
        if j >= len(toks):
            return False
        gap = text[toks[j - 1].end : toks[j].start]
        if gap == "-":  # "twenty-five" joins; "दस-बारह" (10–12) is a range, not one number
            left, right = toks[j - 1], toks[j]
            return _is_tens(left.value) and right.kind == UNIT and right.value < 10
        return gap.isspace()

    def unit_ok(cur: float | None, v: float) -> bool:
        if cur is None:
            return True
        rest = cur % 100  # what follows the hundreds: "दो सौ पचास", "three hundred ninety nine"
        if rest == 0 and v < 100:
            return True
        return _is_tens(rest) and v < 10 and v == int(v)

    j = i
    while j < len(toks):
        t = toks[j]
        if j > i and not adjacent(j):
            break
        if t.kind in (UNIT, "digits"):
            v = t.value + (mod or 0.0)
            if not unit_ok(current, v) or (mod is None and used and used[-1].kind == MOD):
                break
            current = (current or 0.0) + v if current is not None else v
            mod = None
        elif t.kind == MOD:
            if current is not None or mod is not None:
                break
            mod = t.value
        elif t.kind == MULT:
            base = current if current is not None else 1.0 + (mod or 0.0)
            if current is None and mod is None and used:
                break  # "hazaar lakh": two multipliers in a row
            if t.value == 100:
                current = base * 100
            else:
                total += base * t.value
                current = None
            mod = None
        elif t.kind == POINT and current is not None and adjacent(j + 1):
            digits = []
            k = j + 1
            while k < len(toks) and adjacent(k) and toks[k].kind == UNIT and toks[k].value < 10:
                digits.append(str(int(toks[k].value)))
                k += 1
            if not digits:
                break
            current += float("0." + "".join(digits))
            used += toks[j:k]
            j = k
            continue
        elif t.kind == AND and current is not None and adjacent(j + 1):
            # "and a half" / "and half" add 0.5; "and" before a unit continues the number
            rest = [toks[k].text.lower() for k in range(j + 1, min(j + 3, len(toks)))]
            if rest[:2] == ["a", "half"] and adjacent(j + 2):
                current += 0.5
                used += toks[j : j + 3]
                j += 3
                continue
            if rest[:1] == ["half"]:
                current += 0.5
                used += toks[j : j + 2]
                j += 2
                continue
            if toks[j + 1].kind in (UNIT, "digits") and unit_ok(current, toks[j + 1].value):
                used.append(t)
                j += 1
                continue
            break
        else:
            break
        used.append(t)
        j += 1

    while used and used[-1].kind in (MOD, AND, POINT):  # a dangling "saadhe" is not a number
        used.pop()
        j -= 1
    if not used:
        return i + 1
    value = total + (current or 0.0)
    phrases.append(_Phrase(used[0].start, used[-1].end, value, used))
    return max(j, i + 1)
