import asyncio

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
async def test_3rah_connection_failure_pauses_all_requests_without_switching_proxy(
    monkeypatch,
):
    failed = asyncio.Event()
    transport_attempts = []
    request_times = []
    loop = asyncio.get_running_loop()

    def get_session(use_proxy):
        transport_attempts.append(use_proxy)
        if len(transport_attempts) == 1:
            class FailingSession:
                def request(self, *args, **kwargs):
                    request_times.append(loop.time())
                    failed.set()
                    raise aiohttp.ServerDisconnectedError(
                        "connection reset by peer"
                    )

            return FailingSession()

        class SuccessSession:
            def request(self, *args, **kwargs):
                request_times.append(loop.time())
                return FakeResponse(200, data={"success": True})

        return SuccessSession()

    monkeypatch.setattr(
        HttpClient, "get_session", AsyncMock(side_effect=get_session)
    )
    monkeypatch.setattr("core.config.PROXY", "socks5h://127.0.0.1:1080")
    monkeypatch.setattr(
        http_client, "_API_REQUEST_COOLDOWN_SECONDS", 0.03
    )
    monkeypatch.setattr(http_client, "_API_REQUESTS_PAUSED_UNTIL", 0.0)

    request = {
        "method": "GET",
        "url": "https://mm.3rah.ir/api/download/queue",
        "use_proxy": False,
        "max_attempts": 2,
        "retry_delay_seconds": 0,
    }
    first = asyncio.create_task(HttpClient.request_with_methods(**request))
    await failed.wait()
    second = asyncio.create_task(HttpClient.request_with_methods(
        **{**request, "url": "https://mm.3rah.ir/api/download/update",
           "max_attempts": 1}
    ))
    first_result, second_result = await asyncio.gather(first, second)

    assert first_result == ({"success": True}, 200, False)
    assert second_result == ({"success": True}, 200, False)
    assert min(request_times[1:]) - request_times[0] >= 0.025
    assert transport_attempts == [False, False, False]
    assert http_client._API_REQUESTS_PAUSED_UNTIL <= (
        asyncio.get_running_loop().time()
    )


@pytest.mark.asyncio
async def test_3rah_cooldown_does_not_pause_other_hosts(monkeypatch):
    session = FakeSession([FakeResponse(200, data={"ok": True})])
    get_session = AsyncMock(return_value=session)
    sleep = AsyncMock()
    monkeypatch.setattr(HttpClient, "get_session", get_session)
    monkeypatch.setattr("core.http_client.asyncio.sleep", sleep)
    monkeypatch.setattr(
        http_client,
        "_API_REQUESTS_PAUSED_UNTIL",
        asyncio.get_running_loop().time() + 60,
    )

    result = await HttpClient.request_with_methods(
        "GET", "https://example.test", use_proxy=False, max_attempts=1
    )

    assert result == ({"ok": True}, 200, False)
    sleep.assert_not_awaited()
