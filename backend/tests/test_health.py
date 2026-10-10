def test_health(client, assert_schema):
    res = client.get("/health")
    assert res.status_code == 200
    assert_schema("HealthResponse", res.json())
    assert res.json()["mock"] is True
