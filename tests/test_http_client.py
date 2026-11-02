import aiohttp
from unittest.mock import AsyncMock

import pytest

import core.http_client as http_client
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


class FailingSession:
    def request(self, *args, **kwargs):
        raise aiohttp.ServerDisconnectedError("connection reset by peer")


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


@pytest.mark.asyncio
async def test_3rah_connection_failure_fails_over_to_warp(monkeypatch):
    warp_session = FakeSession([FakeResponse(200, data={"success": True})])
    get_session = AsyncMock(side_effect=lambda use_proxy: (
        warp_session if use_proxy else FailingSession()
    ))
    monkeypatch.setattr(HttpClient, "get_session", get_session)
    monkeypatch.setattr("core.config.PROXY", "socks5h://127.0.0.1:1080")
    monkeypatch.setattr(http_client, "_API_PROXY_PREFERRED_UNTIL", 0.0)
    monkeypatch.setattr("core.http_client.asyncio.sleep", AsyncMock())

    result = await HttpClient.request_with_methods(
        "POST",
        "https://mm.3rah.ir/api/download/update",
        use_proxy=False,
        max_attempts=2,
        retry_delay_seconds=0,
        json={"id": 123, "status": "completed"},
    )

    assert result == ({"success": True}, 200, False)
    assert [
        call.kwargs["use_proxy"] for call in get_session.await_args_list
    ] == [False, True]


@pytest.mark.asyncio
async def test_3rah_prefers_warp_after_direct_connection_failure(monkeypatch):
    warp_session = FakeSession([
        FakeResponse(200, data={"success": True}),
        FakeResponse(200, data={"success": True}),
    ])
    get_session = AsyncMock(side_effect=lambda use_proxy: (
        warp_session if use_proxy else FailingSession()
    ))
    monkeypatch.setattr(HttpClient, "get_session", get_session)
    monkeypatch.setattr("core.config.PROXY", "socks5h://127.0.0.1:1080")
    monkeypatch.setattr(http_client, "_API_PROXY_PREFERRED_UNTIL", 0.0)
    monkeypatch.setattr("core.http_client.asyncio.sleep", AsyncMock())

    first = await HttpClient.request_with_methods(
        "GET", "https://mm.3rah.ir/api/download/queue",
        use_proxy=False, max_attempts=2, retry_delay_seconds=0,
    )
    second = await HttpClient.request_with_methods(
        "GET", "https://mm.3rah.ir/api/download/queue",
        use_proxy=False, max_attempts=1,
    )

    assert first == ({"success": True}, 200, False)
    assert second == ({"success": True}, 200, False)
    assert [
        call.kwargs["use_proxy"] for call in get_session.await_args_list
    ] == [False, True, True]
