from app.services.numbers import normalise_digits


def test_native_digits_become_ascii():
    assert normalise_digits("२ और ౩") == "2 और 3"
