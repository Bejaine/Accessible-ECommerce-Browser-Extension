"""Redaction before any text reaches an LLM (docs/safety.md).

Card numbers (Luhn-checked), OTPs and PINs, CVVs, Aadhaar (Verhoeff-checked), PAN, phone
numbers and emails become placeholders (CARD_1, OTP_1, CVV_1, AADHAAR_1, PAN_1, PHONE_1,
EMAIL_1). The mapping never leaves this process and is never sent to the LLM.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_CARD = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
_AADHAAR = re.compile(r"\b\d{4}[ -]?\d{4}[ -]?\d{4}\b")
# A delivery "pin code" is not a secret (we read it back); a UPI/ATM/card PIN is.
_OTP = re.compile(
    r"\b(?:otp|one[- ]time (?:password|code)|verification code"
    r"|(?:upi |atm |card )?pin(?!\s*-?code))\D{0,20}?(\d{4,8})\b",
    re.I,
)
_CVV = re.compile(r"\b(?:cvv|cvc|security code)\D{0,10}?(\d{3,4})\b", re.I)
_PAN = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b", re.I)
_PHONE = re.compile(r"(?<!\d)(?:\+?91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?!\d)")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")

# Verhoeff tables (Aadhaar checksum).
_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]  # fmt: skip
_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]  # fmt: skip


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text)


def luhn_ok(number: str) -> bool:
    digits = [int(d) for d in _digits(number)][::-1]
    total = sum(
        d if i % 2 == 0 else (d * 2 - 9 if d * 2 > 9 else d * 2) for i, d in enumerate(digits)
    )
    return len(digits) >= 13 and total % 10 == 0


def verhoeff_ok(number: str) -> bool:
    c = 0
    for i, d in enumerate(int(x) for x in reversed(_digits(number))):
        c = _D[c][_P[i % 8][d]]
    return c == 0


@dataclass
class Redacted:
    text: str
    found: dict[str, str] = field(default_factory=dict)  # placeholder -> original (stays here)


def redact(text: str) -> Redacted:
    found: dict[str, str] = {}
    counts: dict[str, int] = {}

    def place(kind: str, original: str) -> str:
        counts[kind] = counts.get(kind, 0) + 1
        token = f"{kind}_{counts[kind]}"
        found[token] = original
        return token

    def sub(pattern: re.Pattern[str], kind: str, check=None, group: int = 0):
        nonlocal text

        def repl(m: re.Match[str]) -> str:
            value = m.group(group)
            if check and not check(value):
                return m.group(0)
            token = place(kind, value)
            return m.group(0).replace(value, token) if group else token

        text = pattern.sub(repl, text)

    sub(_EMAIL, "EMAIL")
    sub(_CARD, "CARD", luhn_ok)
    sub(_AADHAAR, "AADHAAR", verhoeff_ok)
    sub(_OTP, "OTP", group=1)
    sub(_CVV, "CVV", group=1)
    sub(_PAN, "PAN")
    sub(_PHONE, "PHONE")
    return Redacted(text, found)
