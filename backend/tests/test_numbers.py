"""Spoken-number normaliser, table-driven (Track A brief: native digits, number words,
lakh/crore, dedh/dhai). Unchanged rows are as important as converted ones: "डाल दो" is
"put it in", not "put 2", and "the cheaper one" is not "the cheaper 1"."""

import pytest

from app.services.numbers import normalise_digits, normalise_numbers, parse_number

CASES = [
    # --- English (Indian English included) ------------------------------------------------
    ("en", "two thousand five hundred", "2500"),
    ("en", "under twenty thousand rupees", "under 20000 rupees"),
    ("en", "one point five lakh", "150000"),
    ("en", "one and a half lakh", "150000"),
    ("en", "one hundred and five", "105"),
    ("en", "twenty five", "25"),
    ("en", "2 lakh", "200000"),
    ("en", "2 lakhs", "200000"),
    ("en", "1.5 crore", "15000000"),
    ("en", "budget is 15k", "budget is 15000"),
    ("en", "Rs 1,50,000", "Rs 150000"),
    ("en", "costs 1,299", "costs 1299"),
    ("en", "two three days", "2 3 days"),  # side by side, not added up
    # unchanged
    ("en", "show me the cheaper one", "show me the cheaper one"),
    ("en", "add one to cart", "add one to cart"),
    ("en", "I want 2 phones", "I want 2 phones"),
    ("en", "items 1, 2, 3", "items 1, 2, 3"),
    ("en", "lakhs of reviews", "lakhs of reviews"),
    ("en", "a 6.50 inch screen", "a 6.50 inch screen"),  # digits are kept as written
    ("en", "Do you have this in blue", "Do you have this in blue"),
    # --- Hindi, Devanagari ------------------------------------------------------------------
    ("hi", "डेढ़ लाख", "150000"),
    ("hi", "डेढ लाख", "150000"),  # without the nukta
    ("hi", "ढाई सौ रुपये", "250 रुपये"),
    ("hi", "बीस हज़ार के अंदर", "20000 के अंदर"),
    ("hi", "बीस हजार", "20000"),
    ("hi", "साढ़े तीन सौ", "350"),
    ("hi", "सवा सौ", "125"),
    ("hi", "पौने दो लाख", "175000"),
    ("hi", "एक लाख पचास हज़ार", "150000"),
    ("hi", "पाँच हज़ार पाँच सौ", "5500"),
    ("hi", "पांच सौ", "500"),
    ("hi", "पच्चीस", "25"),
    ("hi", "निन्यानवे", "99"),
    ("hi", "दो करोड़", "20000000"),
    ("hi", "आधा किलो", "0.5 किलो"),
    ("hi", "2 लाख 50 हज़ार", "250000"),
    ("hi", "1.5 लाख तक", "150000 तक"),
    ("hi", "१२००", "1200"),
    ("hi", "₹१,५०,०००", "₹150000"),
    # unchanged
    ("hi", "इसे कार्ट में डाल दो", "इसे कार्ट में डाल दो"),
    ("hi", "दो फ़ोन दिखाओ", "दो फ़ोन दिखाओ"),
    ("hi", "एक फ़ोन दिखाओ", "एक फ़ोन दिखाओ"),
    ("hi", "सौ बार", "सौ बार"),
    # --- Hinglish (romanised Hindi, typed or from English ASR) --------------------------------
    ("hi", "dedh lakh", "150000"),
    ("hi", "do hazaar", "2000"),
    ("hi", "dhai sau", "250"),
    ("hi", "bees hazaar ke andar", "20000 ke andar"),
    ("hi", "saadhe teen hazaar", "3500"),
    ("hi", "paanch sau", "500"),
    ("hi", "15 hazaar", "15000"),
    # unchanged
    ("hi", "isse cart mein daal do", "isse cart mein daal do"),
    ("hi", "mere saath chalo", "mere saath chalo"),  # saath = "with" here, not 60
    ("en", "teen hazaar", "teen hazaar"),  # romanised Hindi only when the language is Hindi
    # --- Telugu ---------------------------------------------------------------------------------
    ("te", "రెండు వేల", "2000"),
    ("te", "ఇరవై వేలు", "20000"),
    ("te", "ఒకటిన్నర లక్షలు", "150000"),
    ("te", "రెండున్నర లక్షలు", "250000"),
    ("te", "ఐదు వందల యాభై", "550"),
    ("te", "నూట యాభై రూపాయలు", "150 రూపాయలు"),
    ("te", "ఇరవై ఐదు", "25"),
    ("te", "పది వేల లోపు", "10000 లోపు"),
    ("te", "మూడు లక్షల యాభై వేలు", "350000"),
    ("te", "రెండు కోట్లు", "20000000"),
    ("te", "ఐదొందలు", "500"),
    ("te", "౧౫౦౦", "1500"),
    # unchanged
    ("te", "ఒక ఫోన్ చూపించు", "ఒక ఫోన్ చూపించు"),
    ("te", "లక్షలు", "లక్షలు"),
    # --- found by probing realistic sentences ----------------------------------------------
    ("en", "three hundred and ninety nine rupees", "399 rupees"),
    ("en", "twenty-five thousand", "25000"),
    ("te", "రెండు వేల ఐదు వందలా?", "2500?"),  # question ending on "hundreds"
    # ranges share the multiplier: "15 to 20 thousand" is 15000 to 20000
    ("hi", "पंद्रह से बीस हज़ार के बीच", "15000 से 20000 के बीच"),
    ("hi", "दस-बारह हज़ार तक", "10000-12000 तक"),
    ("hi", "2 se 3 lakh", "200000 se 300000"),
    ("hi", "ek se do lakh", "100000 se 200000"),
    ("en", "between ten and fifteen thousand", "between 10000 and 15000"),
    ("en", "ten to fifteen thousand", "10000 to 15000"),
    ("te", "పది నుంచి పదిహేను వేల", "10000 నుంచి 15000"),
    ("en", "10 to 12", "10 to 12"),  # no multiplier: nothing to share
    ("en", "two and five thousand", "2 and 5000"),  # "and" is a range only after "between"
    ("en", "twenty to fifteen thousand", "20 to 15000"),  # a range never runs backwards
    # --- nothing to do ----------------------------------------------------------------------
    ("en", "", ""),
    ("hi", "कार्ट दिखाओ", "कार्ट दिखाओ"),
]


@pytest.mark.parametrize(("lang", "spoken", "normalised"), CASES)
def test_normalise_numbers(lang, spoken, normalised):
    assert normalise_numbers(spoken, lang) == normalised


@pytest.mark.parametrize(
    ("lang", "text", "value"),
    [
        ("hi", "डेढ़ लाख", 150000),
        ("hi", "dhai sau", 250),
        ("te", "రెండున్నర లక్షలు", 250000),
        ("en", "one point five crore", 15000000),
        ("en", "₹1,299", None),  # not just a number
        ("en", "cheap phones", None),
        ("hi", "दो", 2),  # on its own, the whole answer is the number (e.g. "how many?")
    ],
)
def test_parse_number(lang, text, value):
    assert parse_number(text, lang) == value


def test_native_digits_become_ascii():
    assert normalise_digits("२ और ౩") == "2 और 3"
