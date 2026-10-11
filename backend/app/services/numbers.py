"""Spoken-number normaliser (Track A): number words in ASR transcripts and typed text → digits.

normalise_numbers("डेढ़ लाख के अंदर", "hi") == "150000 के अंदर"
parse_number("రెండున్నర లక్షలు", "te") == 250000

Covers English (incl. Indian English: lakh, crore, 15k), Hindi in Devanagari, romanised Hindi
(only when lang == "hi"), Telugu, Malayalam, native digits and Indian digit grouping (1,50,000).

Safe by default, because a wrong number is worse than a word left alone:
- a lone "weak" word stays a word: एक/दो/ek/do (दो is also "give": "डाल दो"), one ("the
  cheaper one"), ఒక ("a"), ഒരു ("a"). They become digits only inside a bigger number ("दो हज़ार").
- a lone multiplier stays a word ("lakhs of reviews", "सौ बार").
- numbers said side by side are not added ("two three days" -> "2 3 days").
- digits are never reformatted ("6.50" stays "6.50"); romanised words that are also common
  words ("saath" = with) are left out.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_DIGITS = str.maketrans("०१२३४५६७८९౦౧౨౩౪౫౬౭౮౯൦൧൨൩൪൫൬൭൮൯", "0123456789" * 3)
# Old Malayalam spelling of the chillu letters: consonant + virama + ZWJ (ന്‍ = ൻ)
ML_OLD_CHILLUS = [(c + "\u0d4d\u200d", ch) for c, ch in zip("ണനരലളക", "ൺൻർൽൾൿ", strict=True)]
_GROUP_COMMA = re.compile(r"(?<=\d),(?=\d{2,3}\b)")  # 1,50,000 and 1,299 -> no commas

# kinds: unit (a value), mult (x100, x1000, ...), mod (साढ़े +0.5, सवा +0.25, पौने -0.25),
# point (decimal point), and (English "one hundred and five", "and a half")
UNIT, MULT, MOD, POINT, AND = "unit", "mult", "mod", "point", "and"
THOUSANDS = "thousands"  # one Malayalam word for count x 1000 (രണ്ടായിരം); split into two tokens


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

# Malayalam joins number words: ഇരുപത് (20) + അഞ്ച് (5) = ഇരുപത്തിയഞ്ച് (25), നൂറ് (100) +
# more = നൂറ്റി..., ആയിരം (1000) + more = ആയിരത്തി... These tables build both the spoken form
# (speakable) and the words the normaliser understands, so the two always agree.
_ML_0_19 = (
    "പൂജ്യം ഒന്ന് രണ്ട് മൂന്ന് നാല് അഞ്ച് ആറ് ഏഴ് എട്ട് ഒമ്പത് പത്ത് പതിനൊന്ന് പന്ത്രണ്ട് "
    "പതിമൂന്ന് പതിനാല് പതിനഞ്ച് പതിനാറ് പതിനേഴ് പതിനെട്ട് പത്തൊമ്പത്"
).split()
_ML_TENS = "ഇരുപത് മുപ്പത് നാൽപത് അമ്പത് അറുപത് എഴുപത് എൺപത് തൊണ്ണൂറ്".split()
_ML_TENS_JOIN = "ഇരുപത്തി മുപ്പത്തി നാൽപത്തി അമ്പത്തി അറുപത്തി എഴുപത്തി എൺപത്തി തൊണ്ണൂറ്റി".split()
_ML_HUNDREDS = "നൂറ് ഇരുനൂറ് മുന്നൂറ് നാനൂറ് അഞ്ഞൂറ് അറുനൂറ് എഴുനൂറ് എണ്ണൂറ് തൊള്ളായിരം".split()
_ML_HUNDREDS_JOIN = [w[:-1] + "ത്തി" if w.endswith("ം") else w + "റി" for w in _ML_HUNDREDS]
_ML_THOUSANDS = {
    1: "ആയിരം", 2: "രണ്ടായിരം", 3: "മൂവായിരം", 4: "നാലായിരം", 5: "അയ്യായിരം", 6: "ആറായിരം",
    7: "ഏഴായിരം", 8: "എണ്ണായിരം", 9: "ഒമ്പതിനായിരം", 10: "പതിനായിരം", 20: "ഇരുപതിനായിരം",
    30: "മുപ്പതിനായിരം", 40: "നാൽപതിനായിരം", 50: "അമ്പതിനായിരം", 60: "അറുപതിനായിരം",
    70: "എഴുപതിനായിരം", 80: "എൺപതിനായിരം", 90: "തൊണ്ണൂറായിരം",
}  # fmt: skip
# A vowel-initial word joins with a y-glide: ഇരുപത്തി + അഞ്ച് -> ഇരുപത്തിയഞ്ച്
_ML_GLIDE = {"അ": "യ", "ആ": "യാ", "ഇ": "യി", "ഉ": "യു", "എ": "യെ", "ഏ": "യേ", "ഒ": "യൊ", "ഓ": "യോ"}
# ...or, in the shorter spelling, as a vowel sign: ഇരുപത്ത + അഞ്ച് -> ഇരുപത്തഞ്ച്
_ML_VOWEL_SIGN = {"അ": "", "ആ": "ാ", "ഇ": "ി", "എ": "െ", "ഏ": "േ", "ഒ": "ൊ", "ഓ": "ോ"}


def _ml_glue(head: str, word: str) -> str:
    glide = _ML_GLIDE.get(word[0])
    return head + (glide + word[1:] if glide else word)


def _ml_under_100(n: int) -> str:
    if n < 20:
        return _ML_0_19[n]
    tens, unit = divmod(n, 10)
    return _ml_glue(_ML_TENS_JOIN[tens - 2], _ML_0_19[unit]) if unit else _ML_TENS[tens - 2]


def _ml_thousands(count: int, more: bool) -> str:
    word = _ML_THOUSANDS.get(count) or f"{_ml_under_100(count)} ആയിരം"
    return word[:-1] + "ത്തി" if more else word  # ആയിരം -> ആയിരത്തി when more follows


def _ml_lexicon() -> dict[str, tuple[str, float]]:
    table: dict[str, tuple[str, float]] = {w: (UNIT, float(i)) for i, w in enumerate(_ML_0_19)}
    for n in range(20, 100):
        table[_ml_under_100(n)] = (UNIT, float(n))
        tens, unit = divmod(n, 10)
        if unit:  # ഇരുപത്തഞ്ച്, and "ഇരുപത്തി അഞ്ച്" said as two words
            head, first = _ML_TENS_JOIN[tens - 2][:-1], _ML_0_19[unit]
            sign = _ML_VOWEL_SIGN.get(first[0])
            table[head + (sign + first[1:] if sign is not None else "ി" + first)] = (UNIT, float(n))
        else:
            table[_ML_TENS_JOIN[tens - 2]] = (UNIT, float(n))
    for h, (alone, joined) in enumerate(zip(_ML_HUNDREDS, _ML_HUNDREDS_JOIN, strict=True), 1):
        table[alone] = table[joined] = (UNIT, h * 100.0)  # "ഇരുനൂറ്റി അമ്പത്" -> 200 + 50
        for rest in range(1, 100):  # ഇരുനൂറ്റിയമ്പത് (250) written as one word
            table[_ml_glue(joined, _ml_under_100(rest))] = (UNIT, h * 100.0 + rest)
    for count in _ML_THOUSANDS:  # രണ്ടായിരം = 2 x 1000, read as two tokens
        table[_ml_thousands(count, False)] = table[_ml_thousands(count, True)] = (
            THOUSANDS,
            float(count),
        )
    table |= {"ആയിരം": (MULT, 1e3), "ആയിരത്തി": (MULT, 1e3)}
    for w, v in zip("ഒന്നര രണ്ടര മൂന്നര നാലര അഞ്ചര ആറര ഏഴര എട്ടര ഒമ്പതര പത്തര".split(),
                    range(1, 11), strict=True):  # fmt: skip
        table[w] = (UNIT, v + 0.5)
    table |= {
        "ഒരു": (UNIT, 1.0), "അര": (UNIT, 0.5), "ലക്ഷം": (MULT, 1e5), "ലക്ഷത്തി": (MULT, 1e5),
        "കോടി": (MULT, 1e7),
    }  # fmt: skip
    return table


_ML = _ml_lexicon()
# Case endings on a Malayalam number: ആയിരത്തിൽ താഴെ (under a thousand), അഞ്ഞൂറിന് (for 500),
# കോടിയിൽ. Each is (ending, what the bare word ends with instead); tried longest first.
_ML_ENDINGS = [
    (end, bare)
    for bare, ends in (
        ("ം", "ത്തിനുള്ളിൽ ത്തിനകം ത്തിന്റെ ത്തിനു ത്തിന് ത്തിൽ ത്തോളം"),
        ("്", "ിനുള്ളിൽ ിനകം ിന്റെ ിനു ിന് ിൽ ോളം"),
        ("", "യ്ക്ക് ക്ക് യിൽ യോളം"),
    )
    for end in ends.split()
]
_ML_ENDINGS.sort(key=lambda e: len(e[0]), reverse=True)
# Alone, these Malayalam multipliers are still a plain number: "ആയിരം രൂപ" is 1000 rupees.
_ML_LONE_MULT = {"ആയിരം", "ആയിരത്തി", "ലക്ഷം", "കോടി"}

# Telugu question/emphasis endings on a number word: వందలా? (hundreds?), వేలే (thousands only)
_TE_ENDINGS = {"ా", "ే", "ో"}  # ా ే ో

# Alone, these mean "a"/"the one"/"give": only part of a bigger number makes them a number.
_WEAK = {"one", "एक", "दो", "ek", "do", "ఒక", "ఒకటి", "ഒരു", "ഒന്ന്", "അര"}


def _key(word: str) -> str:
    """Lookup form: lower case; Hindi nukta and chandrabindu spellings folded (हज़ार = हजार,
    पाँच = पांच, डेढ़ = डेढ)."""
    word = word.lower().replace("़", "").replace("ँ", "ं")
    for old, chillu in ML_OLD_CHILLUS:  # ന്‍ (old spelling) = ൻ
        word = word.replace(old, chillu)
    for composed, plain in (("ज़", "ज"), ("ड़", "ड"), ("ढ़", "ढ"), ("फ़", "फ")):
        word = word.replace(composed, plain)
    return word


def _lexicon(lang: str | None) -> dict[str, tuple[str, float]]:
    table = {**_EN, **_HI, **_TE, **_ML}
    if lang == "hi":
        table |= _HINGLISH
    return {_key(w): v for w, v in table.items()}


_LEXICONS = {lang: _lexicon(lang) for lang in ("en", "hi", "te", "ml", None)}
_TOKEN = re.compile(
    r"(?P<num>\d+(?:\.\d+)?)(?P<k>[kK]\b)?"
    r"|(?P<word>[A-Za-zऀ-ॣॱ-ॿఀ-౥౰-౿ഀ-൥൰-ൿ‌‍]+)"
)


@dataclass
class _Tok:
    kind: str
    value: float
    start: int
    end: int
    text: str
    joined: bool = False  # second half of one word read as two tokens (രണ്ടായിരം)
    ending: str = ""  # Malayalam case ending kept after the digits: ആയിരത്തിൽ -> 1000-ത്തിൽ


@dataclass
class _Phrase:
    start: int
    end: int
    value: float
    tokens: list[_Tok]
    forced: bool = False  # replace even if it looks like a lone weak word ("ek se do lakh")


# Words between the two ends of a range: "पंद्रह से बीस हज़ार", "10-12 hazaar", "ten to fifteen
# thousand", "పది నుంచి పదిహేను వేల". English "and" only after "between".
_RANGE_WORDS = {"से", "se", "to", "or", "या", "ya", "నుంచి", "నుండి", "లేదా", "മുതൽ", "അല്ലെങ്കിൽ",
                "-", "–"}  # fmt: skip


def normalise_digits(text: str) -> str:
    return text.translate(_DIGITS)


def normalise_numbers(text: str, lang: str | None = None) -> str:
    text = _GROUP_COMMA.sub("", normalise_digits(text))
    phrases = _phrases(text, lang)
    _share_range_multipliers(text, phrases)
    out, last = [], 0
    for p in phrases:
        if p.forced or _worth_replacing(p):
            ending = _ml_written_ending(p.tokens[-1].ending)
            out += [text[last : p.start], _format(p.value) + (f"-{ending}" if ending else "")]
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
        if t.kind == MULT and _ml_bare(_key(t.text))[0] in _ML_LONE_MULT:
            return True
        if t.kind == "digits" or t.kind == MULT or _key(t.text) in _WEAK:
            return False
        # Live real-voice test: ASR heard "Add this to cart" as "Add this two cart". A lone
        # small English number word stays a word (to/two, for/four, won/one, ate/eight); the
        # LLM reads "two" fine, and bigger numbers ("two thousand") still convert.
        if t.text.lower() in _EN and t.value <= 10:
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
            ending = ""
            if kind == "word":  # "ആയിരത്തിൽ" = "in a thousand"
                stem, ending = _ml_bare(word)
                kind, value = lex.get(stem, ("word", 0.0))
            if kind == THOUSANDS:
                toks.append(_Tok(UNIT, value, m.start(), m.start(), m.group()))
                kind, value, joined = MULT, 1e3, True
            else:
                joined = False
            toks.append(_Tok(kind, value, m.start(), m.end(), m.group(), joined, ending))
    return toks


def _ml_written_ending(ending: str) -> str:
    """How the ending is written after digits: 10-ൽ, 500-ന്, 1000-ത്തിൽ, 50-ഓളം."""
    if ending.endswith("ോളം"):
        return "ഓളം"
    if ending.startswith("യ"):
        ending = ending[1:]
    return ending[1:] if ending[:1] == "ി" else ending


def _ml_bare(word: str) -> tuple[str, str]:
    """A Malayalam number word without its case ending, and the ending ("" if none)."""
    for end, bare in _ML_ENDINGS:
        if word.endswith(end) and len(word) > len(end):
            stem = word[: -len(end)] + bare
            if stem in _ML:
                return stem, end
    return word, ""


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
        if toks[j].joined:
            return True
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
            if current is None and mod is None and used and used[-1].value <= t.value:
                break  # "hazaar lakh"; but "ലക്ഷത്തി ആയിരത്തി" is 1 lakh + 1 thousand
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
        if t.ending:  # a case ending closes the number
            break

    while used and used[-1].kind in (MOD, AND, POINT):  # a dangling "saadhe" is not a number
        used.pop()
        j -= 1
    if not used:
        return i + 1
    value = total + (current or 0.0)
    phrases.append(_Phrase(used[0].start, used[-1].end, value, used))
    return max(j, i + 1)


# --- Speaking numbers (TTS) ------------------------------------------------------------------
# Live test (2026-10-11): the Hindi and Telugu TTS voices read digits in English ("सेवेंटींथ",
# "బైవ్ థౌసండ్"), the English voice read "17,999" as "17th, 999th", and ₹ is stripped as a
# special character. So before TTS, numbers are written out in the listener's language, in the
# Indian system (lakh, crore). Model names (S24, 5G) are left alone.

_EN_0_19 = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen"
).split()
_EN_TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split()
_HI_0_99 = ["शून्य", *_HI_1_99.replace("पांच", "पाँच").split()]
_TE_0_19 = (
    "సున్నా ఒకటి రెండు మూడు నాలుగు ఐదు ఆరు ఏడు ఎనిమిది తొమ్మిది పది పదకొండు పన్నెండు "
    "పదమూడు పద్నాలుగు పదిహేను పదహారు పదిహేడు పద్దెనిమిది పందొమ్మిది"
).split()
_TE_TENS = "ఇరవై ముప్పై నలభై యాభై అరవై డెబ్బై ఎనభై తొంభై".split()

_SPEECH = {
    "en": {"point": "point", "rupee": ("rupee", "rupees"), "paise": "paise",
           "crore": "crore", "lakh": "lakh", "thousand": "thousand", "hundred": "hundred"},
    "hi": {"point": "दशमलव", "rupee": ("रुपया", "रुपये"), "paise": "पैसे",
           "crore": "करोड़", "lakh": "लाख", "thousand": "हज़ार", "hundred": "सौ"},
    "te": {"point": "పాయింట్", "rupee": ("రూపాయి", "రూపాయలు"), "paise": "పైసలు"},
    "ml": {"point": "പോയിന്റ്", "rupee": ("രൂപ", "രൂപ"), "paise": "പൈസ"},
}  # fmt: skip

_UNIT_WORDS = {
    "mAh": ("milliamp hours", "मिलीएम्पियर आवर", "మిల్లీ ఆంపియర్ అవర్", "മില്ലിആമ്പിയർ അവർ"),
    "GHz": ("gigahertz", "गीगाहर्ट्ज़", "గిగాహెర్ట్జ్", "ഗിഗാഹെർട്സ്"),
    "Hz": ("hertz", "हर्ट्ज़", "హెర్ట్జ్", "ഹെർട്സ്"),
    "TB": ("TB", "टीबी", "టీబీ", "ടിബി"),
    "GB": ("GB", "जीबी", "జీబీ", "ജിബി"),
    "MB": ("MB", "एमबी", "ఎంబీ", "എംബി"),
    "MP": ("megapixel", "मेगापिक्सल", "మెగాపిక్సెల్", "മെഗാപിക്സൽ"),
    "W": ("watt", "वॉट", "వాట్", "വാട്ട്"),
    "mm": ("millimetres", "मिलीमीटर", "మిల్లీమీటర్లు", "മില്ലിമീറ്റർ"),
    "cm": ("centimetres", "सेंटीमीटर", "సెంటీమీటర్లు", "സെന്റിമീറ്റർ"),
    "km": ("kilometres", "किलोमीटर", "కిలోమీటర్లు", "കിലോമീറ്റർ"),
    "kg": ("kilograms", "किलो", "కిలోలు", "കിലോ"),
    "g": ("grams", "ग्राम", "గ్రాములు", "ഗ്രാം"),
    "ml": ("millilitres", "मिलीलीटर", "మిల్లీలీటర్లు", "മില്ലിലിറ്റർ"),
    "L": ("litres", "लीटर", "లీటర్లు", "ലിറ്റർ"),
    "inch": ("inch", "इंच", "అంగుళాలు", "ഇഞ്ച്"),
    "inches": ("inches", "इंच", "అంగుళాలు", "ഇഞ്ച്"),
    '"': ("inch", "इंच", "అంగుళాలు", "ഇഞ്ച്"),
    "°C": ("degrees Celsius", "डिग्री सेल्सियस", "డిగ్రీల సెల్సియస్", "ഡിഗ്രി സെൽഷ്യസ്"),
    "%": ("percent", "प्रतिशत", "శాతం", "ശതമാനം"),
}
_LANG_INDEX = {"en": 0, "hi": 1, "te": 2, "ml": 3}

_AMOUNT = r"\d[\d,]*(?:\.\d+)?"
_SPEAK_PRICE = re.compile(rf"(?:₹|\bRs\.?|\bINR)\s?({_AMOUNT})|\b({_AMOUNT})/-")
_SPEAK_UNIT = re.compile(
    rf"\b({_AMOUNT})\s?("
    + "|".join(re.escape(u) for u in sorted(_UNIT_WORDS, key=len, reverse=True))
    + r")(?![\w])"
)
_SPEAK_PIN = re.compile(
    r"(\b(?:PIN|pin|Pin)(?:\s*code)?|\bpincode|पिन(?:\s*कोड)?|పిన్(?:\s*కోడ్)?|പിൻ(?:\s*കോഡ്)?)(\s*:?\s*)(\d{6})\b"
)
_SPEAK_LONG = re.compile(r"(?<![\w.,])(0\d+|\d{10,})(?![\w.,])")
_SPEAK_NUMBER = re.compile(r"(?<![\w.,])(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w])")


def number_to_words(n: int, lang: str, *, before_noun: bool = False) -> str:
    """A whole number in words, Indian system. Telugu takes its oblique form before a noun
    ("రెండు వేల రూపాయలు", not "రెండు వేలు రూపాయలు")."""
    if lang == "te":
        return _te_words(n, before_noun)
    if lang == "ml":
        return _ml_words(n, before_noun)
    s = _SPEECH[lang]
    under_100 = _en_under_100 if lang == "en" else _HI_0_99.__getitem__
    if n < 100:
        return under_100(n)
    crore, rest = divmod(n, 10_000_000)
    lakh, rest = divmod(rest, 100_000)
    thousand, rest = divmod(rest, 1000)
    hundred, last = divmod(rest, 100)
    parts = []
    if crore:
        parts.append(f"{number_to_words(crore, lang)} {s['crore']}")
    for count, word in ((lakh, "lakh"), (thousand, "thousand"), (hundred, "hundred")):
        if count:
            parts.append(f"{under_100(count)} {s[word]}")
    if last:
        parts.append(under_100(last))
    return " ".join(parts)


def _en_under_100(n: int) -> str:
    if n < 20:
        return _EN_0_19[n]
    tens, unit = divmod(n, 10)
    return _EN_TENS[tens - 2] + (f" {_EN_0_19[unit]}" if unit else "")


def _te_under_100(n: int) -> str:
    if n < 20:
        return _TE_0_19[n]
    tens, unit = divmod(n, 10)
    return _TE_TENS[tens - 2] + (f" {_TE_0_19[unit]}" if unit else "")


def _te_words(n: int, before_noun: bool) -> str:
    if n == 1 and before_noun:
        return "ఒక"
    if n < 100:
        return _te_under_100(n)
    crore, rest = divmod(n, 10_000_000)
    lakh, rest = divmod(rest, 100_000)
    thousand, rest = divmod(rest, 1000)
    hundred, last = divmod(rest, 100)
    # (count, word for 1, plural, oblique): the oblique form is used when more follows
    segments = [
        (crore, "కోటి", "కోట్లు", "కోట్ల"),
        (lakh, "ఒక లక్ష", "లక్షలు", "లక్షల"),
        (thousand, "వెయ్యి", "వేలు", "వేల"),
        (hundred, None, "వందలు", "వందల"),
    ]
    present = [i for i, seg in enumerate(segments) if seg[0]]
    parts = []
    for i, (count, one, plural, oblique) in enumerate(segments):
        if not count:
            continue
        more = last > 0 or i != present[-1] or before_noun
        if count == 1 and i == 3:  # 100: "వంద", or "నూట" when more follows
            parts.append("నూట" if last else "వంద")
        elif count == 1 and one:
            parts.append(one)
        else:
            head = number_to_words(count, "te") if i == 0 else _te_under_100(count)
            parts.append(f"{head} {oblique if more else plural}")
    if last:
        parts.append(_te_under_100(last))
    return " ".join(parts)


def _ml_words(n: int, before_noun: bool) -> str:
    """Malayalam: each part takes its joining form when more follows (ലക്ഷത്തി, ആയിരത്തി,
    നൂറ്റി); "one" before a noun is ഒരു ("ഒരു ലക്ഷം", "ഒരു രൂപ")."""
    if n == 1 and before_noun:
        return "ഒരു"
    if n < 100:
        return _ml_under_100(n)
    crore, rest = divmod(n, 10_000_000)
    lakh, rest = divmod(rest, 100_000)
    thousand, rest = divmod(rest, 1000)
    hundred, last = divmod(rest, 100)
    parts = []
    if crore:
        parts.append(f"{'ഒരു' if crore == 1 else _ml_words(crore, False)} കോടി")
    if lakh:
        more = bool(thousand or hundred or last)
        parts.append(f"{'ഒരു' if lakh == 1 else _ml_under_100(lakh)} ലക്ഷ{'ത്തി' if more else 'ം'}")
    if thousand:
        parts.append(_ml_thousands(thousand, bool(hundred or last)))
    if hundred:
        parts.append((_ML_HUNDREDS_JOIN if last else _ML_HUNDREDS)[hundred - 1])
    if last:
        parts.append(_ml_under_100(last))
    return " ".join(parts)


def _digit_words(digits: str, lang: str) -> str:
    return " ".join(number_to_words(int(d), lang) for d in digits)


def _amount_words(amount: str, lang: str, *, before_noun: bool = False) -> str:
    whole, _, frac = amount.replace(",", "").partition(".")
    words = number_to_words(int(whole), lang, before_noun=before_noun and not frac)
    if frac:
        words += f" {_SPEECH[lang]['point']} {_digit_words(frac, lang)}"
    return words


def _price_words(amount: str, lang: str) -> str:
    whole, _, frac = amount.replace(",", "").partition(".")
    rupees, paise = int(whole), int((frac + "00")[:2]) if frac else 0
    singular, plural = _SPEECH[lang]["rupee"]
    words = (
        f"{number_to_words(rupees, lang, before_noun=True)} {singular if rupees == 1 else plural}"
    )
    if paise:
        words += f" {number_to_words(paise, lang, before_noun=True)} {_SPEECH[lang]['paise']}"
    return words


def speakable(text: str, lang: str) -> str:
    """Text for TTS: prices, numbers, units and decimals in words of `lang` (en, hi, te, ml);
    PIN codes, long numbers and numbers with a leading zero digit by digit. Other languages
    are returned unchanged until they have word tables."""
    if lang not in _LANG_INDEX:
        return text
    col = _LANG_INDEX[lang]
    text = _SPEAK_PRICE.sub(lambda m: _price_words(m.group(1) or m.group(2), lang), text)
    text = _SPEAK_PIN.sub(lambda m: m.group(1) + m.group(2) + _digit_words(m.group(3), lang), text)
    text = _SPEAK_UNIT.sub(
        lambda m: (
            f"{_amount_words(m.group(1), lang, before_noun=True)} {_UNIT_WORDS[m.group(2)][col]}"
        ),
        text,
    )
    text = _SPEAK_LONG.sub(lambda m: _digit_words(m.group(1), lang), text)
    # Telugu: a number followed by a word is before a noun ("యాభై వేల రివ్యూలు")
    return _SPEAK_NUMBER.sub(
        lambda m: _amount_words(
            m.group(1), lang, before_noun=bool(re.match(r"\s+[^\W\d]", text[m.end() :]))
        ),
        text,
    )
