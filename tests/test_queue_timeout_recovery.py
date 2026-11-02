import asyncio
from unittest.mock import AsyncMock

import pytest

import crawlers.itunes as itunes
from core.config import API_RETRY_DELAY_SECONDS
from main import QUEUE_ERROR_RETRY_DELAY_SECONDS, process_queue_item
from services.worker_restart import restart_worker


def test_queue_api_error_retry_is_at_least_ten_seconds():
    assert QUEUE_ERROR_RETRY_DELAY_SECONDS >= 10


@pytest.mark.asyncio
async def test_download_queue_uses_bounded_http_retries(monkeypatch):
    request = AsyncMock(return_value=({"success": True, "items": []}, 200, False))
    monkeypatch.setattr(itunes.HttpClient, "request_with_methods", request)

    await itunes.get_download_queue(limit=25)

    assert request.await_args.kwargs["max_attempts"] == 2
    assert request.await_args.kwargs["timeout_seconds"] == 20
    assert request.await_args.kwargs["use_proxy"] is True
    assert request.await_args.kwargs["retry_delay_seconds"] == API_RETRY_DELAY_SECONDS


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
        http_retry_delay_seconds=API_RETRY_DELAY_SECONDS,
    )


@pytest.mark.asyncio
async def test_telegram_failure_does_not_reopen_download_after_bale_completion(monkeypatch):
    status_updates = AsyncMock(return_value={"success": True})
    download_service = AsyncMock()

    async def upload_and_fail_telegram(**kwargs):
        await status_updates(17, "completed", percent=100)
        kwargs["bale_completion_callback"]()
        raise RuntimeError("Telegram upload failed")

    download_service.download_and_send_track.side_effect = upload_and_fail_telegram
    active_downloads = {17}
    active_tracks = {"123"}
    monkeypatch.setattr("main.update_download_status", status_updates)

    await process_queue_item(
        None,
        {"download_id": 17, "trackId": "123"},
        download_service,
        1,
        active_downloads,
        active_track_ids=active_tracks,
    )

    statuses = [call.args[1] for call in status_updates.await_args_list]
    assert statuses.count("completed") == 1
    assert "failed" not in statuses
    assert active_downloads == set()
    assert active_tracks == set()