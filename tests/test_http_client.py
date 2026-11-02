from unittest.mock import AsyncMock

import pytest

from core.http_client import HttpClient, _retry_delay


class FakeResponse:
    def __init__(self, status, *, headers=None, body="", data=None):
        self.status = status
        self.headers = headers or {}
        self.body = body
        self.data = data

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        return False

    async def json(self):
        return self.data

    async def read(self):
        return self.body.encode()

    async def text(self):
        return self.body


class FakeSession:
    def __init__(self, responses):
        self.responses = iter(responses)

    def request(self, *args, **kwargs):
        return next(self.responses)


def test_retry_delay_honors_retry_after_and_caps_it():
    assert _retry_delay(
        0, 2, status=429, headers={"Retry-After": "7"}
    ) == 7
    assert _retry_delay(
        0, 2, status=429, headers={"Retry-After": "999"}
    ) == 300


def test_retry_delay_waits_for_api_connection_limit():
    assert _retry_delay(
        0, 2, status=503, body="max_user_connections exceeded"
    ) >= 30
    assert _retry_delay(
        0, 2, status=503,
        headers={"Retry-After": "45"},
        body="max_user_connections exceeded",
    ) == 45


@pytest.mark.asyncio
async def test_http_retry_uses_retry_after_and_releases_attempt(monkeypatch):
    session = FakeSession([
        FakeResponse(429, headers={"Retry-After": "7"}),
        FakeResponse(200, data={"ok": True}),
    ])
    monkeypatch.setattr(
        HttpClient, "get_session", AsyncMock(return_value=session)
    )
    sleep = AsyncMock()
    monkeypatch.setattr("core.http_client.asyncio.sleep", sleep)

    result = await HttpClient.request_with_methods(
        "GET", "https://example.test", use_proxy=False,
        max_attempts=2, retry_delay_seconds=2,
    )

    assert result == ({"ok": True}, 200, False)
    sleep.assert_awaited_once_with(7)
