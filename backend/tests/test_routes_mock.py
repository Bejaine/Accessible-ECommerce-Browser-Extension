import pytest

ROUTES = [
    ("/product/prepare", "ProductPrepareRequest", "ProductPrepareResponse"),
    ("/ocr", "OCRRequest", "OCRResponse"),
    ("/speech/asr", "ASRRequest", "ASRResponse"),
    ("/speech/tts", "TTSRequest", "TTSResponse"),
    ("/translate", "TranslateRequest", "TranslateResponse"),
    ("/turn", "TurnRequest", "TurnResponse"),
    ("/vision/describe", "VisionDescribeRequest", "VisionDescribeResponse"),
    ("/reviews/summarize", "ReviewsSummarizeRequest", "AccessibleOutput"),
]


@pytest.mark.parametrize(("path", "req", "resp"), ROUTES)
def test_route_serves_valid_mock(client, assert_schema, mock_body, path, req, resp):
    res = client.post(path, json=mock_body(req))
    assert res.status_code == 200, res.text
    assert_schema(resp, res.json())


def test_invalid_request_returns_error_shape(client, assert_schema):
    res = client.post("/turn", json={"nope": True})
    assert res.status_code == 422
    assert_schema("ErrorResponse", res.json())
    assert res.json()["code"] == "invalid_request"


def test_real_mode_stub_returns_calm_error(client, assert_schema, mock_body, monkeypatch):
    monkeypatch.setenv("MOCK", "0")
    res = client.post("/turn", json=mock_body("TurnRequest"))
    assert res.status_code == 501
    assert_schema("ErrorResponse", res.json())
