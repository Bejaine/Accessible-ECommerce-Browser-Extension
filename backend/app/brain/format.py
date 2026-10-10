"""Small formatters for spoken/visual text built from ProductJSON fields (no facts added)."""

from __future__ import annotations

import re

CURRENCY_SYMBOLS = {"INR": "₹", "USD": "$", "EUR": "€", "GBP": "£"}


def group_digits(n: int, *, indian: bool) -> str:
    s = str(abs(n))
    if indian and len(s) > 3:
        head, tail = s[:-3], s[-3:]
        head = re.sub(r"(\d)(?=(\d\d)+$)", r"\1,", head)
        s = f"{head},{tail}"
    elif not indian:
        s = f"{abs(n):,}"
    return ("-" if n < 0 else "") + s


def number(value: float | int, *, indian: bool = True) -> str:
    """5000 -> "5,000", 124999 -> "1,24,999", 6.67 -> "6.67"."""
    if isinstance(value, float) and not value.is_integer():
        whole, frac = f"{value}".split(".")
        return f"{group_digits(int(whole), indian=indian)}.{frac}"
    return group_digits(int(value), indian=indian)


def money(amount: float, currency: str) -> str:
    symbol = CURRENCY_SYMBOLS.get(currency)
    text = number(amount, indian=currency == "INR")
    return f"{symbol}{text}" if symbol else f"{text} {currency}"


def spec_value(value: str | float | int | bool, unit: str | None) -> str:
    if isinstance(value, bool):
        text = "Yes" if value else "No"
    elif isinstance(value, int | float):
        text = number(value, indian=False).replace(",", "") if value < 10000 else number(value)
    else:
        text = value
    return f"{text} {unit}" if unit else text


def short_title(title: str) -> str:
    """The name without the listing's sales text: "Zentra Pulse 5G (Black, 8GB)" -> "Zentra
    Pulse 5G"; "Apple iPhone 16 128 GB: 5G Mobile Phone with ..." -> "Apple iPhone 16 128 GB"."""
    short = re.sub(r"\s*[(\[].*$", "", title).strip(" ,-|") or title
    if len(short) > 40:
        cuts = [short.find(sep, 10) for sep in (": ", " | ", " - ", ", ")]
        cuts = [c for c in cuts if c > 0]
        if cuts:
            short = short[: min(cuts)].strip(" ,-|:")
    return short


def join_words(parts: list[str]) -> str:
    if len(parts) <= 1:
        return "".join(parts)
    return f"{', '.join(parts[:-1])} and {parts[-1]}"


def brief(text: str, limit: int = 90) -> str:
    """Cut a long page value down to its first clause(s), word for word (never reworded), so a
    900-character camera paragraph is not read aloud: "Rated IP68 (maximum..." -> "Rated IP68"."""
    if len(text) <= limit:
        return text
    cut = max(text.rfind(sep, 0, limit) for sep in (". ", "; ", ", ", " (", " - "))
    if cut < 12:
        cut = text.rfind(" ", 0, limit)
    return text[: cut if cut > 0 else limit].rstrip(" ,;:(-")
