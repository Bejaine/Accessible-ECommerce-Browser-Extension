import pytest

from app.brain.grounding import FALLBACK_SUMMARY, Unresolved, claim_matches, resolve
from app.brain.output import OutputBuilder
from app.models import ProductJSON

PID = "amazon.in:B0ZNTRA5G1"


@pytest.fixture
def product(mock_body) -> ProductJSON:
    return ProductJSON.model_validate(mock_body("ProductJSON"))


def test_resolve_dot_paths(product):
    data = product.model_dump(mode="json", by_alias=True)
    assert resolve(data, "specs.battery.value") == 5000
    assert resolve(data, "reviews.items[2].rating") == 2
    assert resolve(data, "reviews.histogram.5") == 1880
    for bad in ("specs.wireless_charging.value", "images[9].alt", "", "seller.name"):
        with pytest.raises(Unresolved):
            resolve(data, bad)


def test_claim_matching():
    assert claim_matches("₹17,999", 17999)
    assert claim_matches("1,24,999", 124999)
    assert claim_matches("rated 4.2 out of 5", 4.2)
    assert not claim_matches("6000 mAh", 5000)
    assert claim_matches("Midnight Black", "Midnight Black")
    assert claim_matches("In stock", "in_stock")
    assert not claim_matches("waterproof", "Android 15")
    assert claim_matches("GB", "GB"), "short units match exactly"
    assert claim_matches("The main complaint is heating", {"topic": "Heat"}), "shared stem"
    assert not claim_matches("Great for gaming", {"topic": "Heat"})


def test_check_drops_invented_claims_and_remaps(product):
    b = OutputBuilder(PID)
    b.section(
        "Specs",
        [
            b.item("Battery: 6000 mAh", "spec", claim="6000 mAh", path="specs.battery.value"),
            b.item("RAM: 8 GB", "spec", claim="8 GB", path="specs.ram.value"),
            b.item("Wireless charging: yes", "spec", path="specs.wireless_charging.value"),
            b.item("Charges in 30 minutes"),
            b.item("Feels premium"),
        ],
    )
    result = b.checked(
        {PID: product},
        "It has 8 GB RAM. It charges fully in 30 minutes.",
        simpler="Battery is 6000 mAh.",
    )
    out = result.output
    assert [i.text for i in out.sections[0].items] == ["RAM: 8 GB", "Feels premium"]
    assert out.sections[0].items[0].grounding_index == 0
    assert [g.field_path for g in out.grounding] == ["specs.ram.value"]
    assert out.summary == "It has 8 GB RAM."
    assert out.simpler is None
    assert len(result.dropped) == 7  # 2 bad fields, 2 items that lost them, 1 item, 2 sentences


def test_unknown_subject_and_empty_summary_fall_back(product):
    b = OutputBuilder("amazon.in:NOPE")
    b.ground("₹999", "price.amount")
    out = b.checked({PID: product}, "It costs ₹999.").output
    assert out.grounding == []
    assert out.summary == FALLBACK_SUMMARY


def test_table_cells_and_derived_numbers(product):
    b = OutputBuilder(PID)
    b.ground("₹17,999", "price.amount")
    b.derive(3)
    table = {
        "columns": ["", "Price"],
        "rows": [["Zentra", "₹17,999"], ["Other", "₹9,999"]],
        "spoken": "Zentra costs ₹17,999. Other costs ₹9,999.",
    }
    b.section("Compare", table=table)
    out = b.checked({PID: product}, "I compared 3 phones.").output
    assert out.summary == "I compared 3 phones."
    assert out.sections[0].table.rows[1] == ["Other", "not listed"]
    assert out.sections[0].table.spoken == "Zentra costs ₹17,999."


def test_brief_cuts_long_values_word_for_word():
    from app.brain.format import brief

    long = "Rated IP68 (maximum depth of 6 metres up to 30 minutes) under IEC standard 60529"
    assert brief(long, 60) == "Rated IP68 (maximum depth of 6 metres up to 30 minutes)"
    assert long.startswith(brief(long, 60))
    assert len(brief(long, 60)) <= 60
    assert brief("iOS", 60) == "iOS"
