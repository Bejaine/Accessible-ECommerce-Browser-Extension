from app.services.masking import mask, unmask


def test_mask_round_trips():
    text = "boAt Airdopes 141 costs ₹1,299"
    masked, table = mask(text)
    assert unmask(masked, table) == text
