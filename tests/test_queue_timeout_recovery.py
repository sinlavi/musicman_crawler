import asyncio
from unittest.mock import AsyncMock

import pytest

import crawlers.itunes as itunes
from services.worker_restart import restart_worker


@pytest.mark.asyncio
async def test_download_queue_uses_bounded_http_retries(monkeypatch):
    request = AsyncMock(return_value=({"success": True, "items": []}, 200, False))
    monkeypatch.setattr(itunes.HttpClient, "request_with_methods", request)

    await itunes.get_download_queue(limit=25)

    assert request.await_args.kwargs["max_attempts"] == 2
    assert request.await_args.kwargs["timeout_seconds"] == 20
    assert request.await_args.kwargs["use_proxy"] is True


@pytest.mark.asyncio
async def test_restart_worker_cancels_and_requeues_active_download():
    async def blocked_download():
        await asyncio.Future()

    task = asyncio.create_task(blocked_download())
    await asyncio.sleep(0)
    update_status = AsyncMock(return_value={"success": True})
    with pytest.raises(SystemExit) as exit_error:
        await restart_worker({task: 4321}, "test restart", update_status)

    assert exit_error.value.code == 75
    assert task.cancelled()
    update_status.assert_awaited_once_with(
        4321,
        "pending",
        percent=0,
        http_max_attempts=2,
        http_timeout_seconds=15,
        http_use_proxy=True,
    )