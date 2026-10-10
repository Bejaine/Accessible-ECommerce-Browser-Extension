import pytest

from app.errors import ApiError
from app.services.serpapi import amazon_product


async def test_mock_reads_recorded_response_and_caches():
    first = await amazon_product("B0MOCK0001")
    assert first["product_results"]["asin"] == "B0MOCK0001"
    assert await amazon_product("B0MOCK0001") is first


async def test_unknown_asin_in_mock_mode_is_not_found():
    with pytest.raises(ApiError):
        await amazon_product("B0NOTREC00")
