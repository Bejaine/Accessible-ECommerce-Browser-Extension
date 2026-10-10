"""Masking before MT (rule 7). Placeholder style ZQX<n> was chosen by a live test on
2026-10-11: ⟦0⟧ made the MT model invent numbers, <0>/{0}/__0__ failed in some direction,
ZQX0 survived en→hi, en→te and hi→en in a natural position."""

import pytest

from app.services.masking import mask, missing, unmask

# (text, masked text, the masked originals in order)
CASES = [
    # prices
    ("boAt Airdopes 141 costs ₹1,299", "ZQX0 costs ZQX1", ["boAt Airdopes 141", "₹1,299"]),
    ("It costs Rs. 1,299 today.", "It costs ZQX0 today.", ["Rs. 1,299"]),
    ("Only INR 999 with ₹ 49.50 delivery", "Only ZQX0 with ZQX1 delivery", ["INR 999", "₹ 49.50"]),
    ("Now 1,299/- only", "Now ZQX0 only", ["1,299/-"]),
    # number + unit
    ("Battery: 5000 mAh, charges at 45W.", "Battery: ZQX0, charges at ZQX1.", ["5000 mAh", "45W"]),
    (
        "It has 12 GB RAM and 256GB storage",
        "It has ZQX0 ZQX1 and ZQX2 storage",
        ["12 GB", "RAM", "256GB"],
    ),
    (
        "A 1.5 L kettle that boils 500 ml fast",
        "A ZQX0 kettle that boils ZQX1 fast",
        ["1.5 L", "500 ml"],
    ),
    ("Wi-Fi 6 at 2.4 GHz", "ZQX0 at ZQX1", ["Wi-Fi 6", "2.4 GHz"]),
    # model names and brands, kept whole
    (
        "The Samsung Galaxy S24 Ultra 5G is fast.",
        "The ZQX0 is fast.",
        ["Samsung Galaxy S24 Ultra 5G"],
    ),
    (
        "I like the iPhone 15 and the OnePlus 12R.",
        "I like the ZQX0 and the ZQX1.",
        ["iPhone 15", "OnePlus 12R"],
    ),
    ("Supports USB-C, HDMI and ANC.", "Supports ZQX0, ZQX1 and ZQX2.", ["USB-C", "HDMI", "ANC"]),
    ("Model SM-A156B in black", "Model ZQX0 in black", ["SM-A156B"]),
    (
        "Reviewers compare it with Sony headphones.",
        "Reviewers compare it with ZQX0 headphones.",
        ["Sony"],
    ),
    # brand words in Hindi / Telugu text
    ("मुझे iPhone 15 Pro दिखाओ", "मुझे ZQX0 दिखाओ", ["iPhone 15 Pro"]),
    ("boat airdopes ka price kya hai", "boat airdopes ka price kya hai", []),  # all-Latin Hinglish
    ("ఈ Redmi Note 13 ధర ఎంత?", "ఈ ZQX0 ధర ఎంత?", ["Redmi Note 13"]),
    # links
    (
        "See https://www.amazon.in/dp/B0XX for more",
        "See ZQX0 for more",
        ["https://www.amazon.in/dp/B0XX"],
    ),
    # decimals and inches: live MT turned "6.8 inch" into "6.80" and "Bluetooth 5.3" into "5"
    ("A 6.8 inch display", "A ZQX0 display", ["6.8 inch"]),
    ('A 6.7" screen and 15.6 inches wide', "A ZQX0 screen and ZQX1 wide", ['6.7"', "15.6 inches"]),
    ("Rated 4.3 out of 5 by buyers", "Rated ZQX0 out of 5 by buyers", ["4.3"]),
    # left alone
    ("The earphones are good.", "The earphones are good.", []),
    ("Add two of these to my cart", "Add two of these to my cart", []),
    (
        "Battery lasts 30 hours on a single charge.",
        "Battery lasts 30 hours on a single charge.",
        [],
    ),
    ("", "", []),
]


@pytest.mark.parametrize(("text", "masked", "originals"), CASES)
def test_mask(text, masked, originals):
    out, table = mask(text)
    assert out == masked
    assert list(table.values()) == originals


@pytest.mark.parametrize(("text", "masked", "originals"), CASES)
def test_round_trip(text, masked, originals):
    out, table = mask(text)
    assert unmask(out, table) == text


def test_keep_masks_everyday_word_brands_anywhere():
    out, table = mask("Noise earphones are cheaper than Apple ones.", keep=["Noise", "Apple"])
    assert out == "ZQX0 earphones are cheaper than ZQX1 ones."
    assert table == {"ZQX0": "Noise", "ZQX1": "Apple"}


def test_keep_is_whole_word_and_ignores_empty_terms():
    out, _ = mask("Noisemaker earphones", keep=["Noise", ""])
    assert out == "Noisemaker earphones"


def test_sentence_start_words_are_not_brands():
    for text in ["Buy it now.", "Please add it.", "Yes. Show reviews."]:
        assert mask(text) == (text, {})


@pytest.mark.parametrize(
    "translated",
    [
        "ZQX0 की कीमत ZQX1 है",
        "ZQX 0 की कीमत ZQX 1 है",  # the MT model inserted spaces
        "zqx0 की कीमत Zqx1 है",  # or changed case
        "ZQX० की कीमत ZQX१ है",  # or used Devanagari digits
    ],
)
def test_unmask_tolerates_what_mt_does_to_placeholders(translated):
    table = {"ZQX0": "boAt Airdopes 141", "ZQX1": "₹1,299"}
    assert unmask(translated, table) == "boAt Airdopes 141 की कीमत ₹1,299 है"


def test_unmask_leaves_unknown_placeholders():
    assert unmask("ZQX7 here", {"ZQX0": "x"}) == "ZQX7 here"


def test_missing_lists_placeholders_the_mt_dropped():
    table = {"ZQX0": "boAt", "ZQX1": "₹1,299", "ZQX2": "5000 mAh"}
    assert missing("ZQX0 की कीमत Z Q X 1 है", table) == ["ZQX2"]
    assert missing("anything", {}) == []


def test_existing_zqx_text_is_not_confused_with_placeholders():
    """ZQX9 looks like a model code, so it is masked too; restoring is one pass, so its
    replacement never gets substituted again."""
    out, table = mask("Code ZQX9 for boAt")
    assert out == "Code ZQX0 for ZQX1"
    assert unmask(out, table) == "Code ZQX9 for boAt"
