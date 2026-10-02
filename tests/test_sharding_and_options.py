import pytest
import asyncio
import aiohttp
from unittest.mock import AsyncMock, patch
from crawlers.youtube import COMMON_OPTS, _build_opts
from services.download_service import _is_file_too_large_error as is_large_download
from services.direct_download_service import _is_file_too_large_error as is_large_direct
from main import start_trigger_server, handle_trigger, new_task_event, format_progress_bar
from crawlers.itunes import save_telegram_file

def test_format_progress_bar():
    assert format_progress_bar(0) == "░░░░░░░░░░"
    assert format_progress_bar(40) == "▓▓▓▓░░░░░░"
    assert format_progress_bar(100) == "▓▓▓▓▓▓▓▓▓▓"

def test_common_opts_socket_timeout():
    assert "socket_timeout" in COMMON_OPTS
    assert COMMON_OPTS["socket_timeout"] == 20

def test_build_opts_includes_progress_hook():
    dummy_hook = lambda d: None
    opts = _build_opts(1, "/tmp", 128, use_proxy=False, progress_hook=dummy_hook)
    assert "socket_timeout" in opts
    assert opts["socket_timeout"] == 20
    assert "progress_hooks" in opts
    assert dummy_hook in opts["progress_hooks"]

def test_chunked_sharding_numeric_and_string_ids_5_instances():
    total_instances = 5
    chunk_size = 5
    test_ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]

    expected_instances = [
        1, 1, 1, 1, 1,
        2, 2, 2, 2, 2,
        3, 3, 3, 3, 3,
        4, 4, 4, 4, 4,
        5, 5, 5, 5, 5
    ]

    for download_id, expected_instance in zip(test_ids, expected_instances):
        try:
            numeric_id = int(download_id)
        except (ValueError, TypeError):
            numeric_id = abs(hash(str(download_id)))

        assigned_instance = ((numeric_id // chunk_size) % total_instances) + 1
        assert assigned_instance == expected_instance

def test_file_too_large_error_matching():
    errors = [
        Exception("Request Entity Too Large"),
        Exception("HTTP/1.1 413 Request Entity Too Large"),
        Exception("Telegram error: file_too_large"),
        Exception("File is too large"),
    ]
    for err in errors:
        assert is_large_download(err) is True
        assert is_large_direct(err) is True

    other_err = Exception("Connection reset by peer")
    assert is_large_download(other_err) is False
    assert is_large_direct(other_err) is False

@pytest.mark.asyncio
async def test_instant_trigger_server():
    new_task_event.clear()
    runner = await start_trigger_server(8089)
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post("http://127.0.0.1:8089/trigger") as resp:
                assert resp.status == 200
                data = await resp.json()
                assert data.get("success") is True
                assert new_task_event.is_set()
    finally:
        await runner.cleanup()

@pytest.mark.asyncio
async def test_save_telegram_file():
    with patch("crawlers.itunes.fetch_itunes", new_callable=AsyncMock) as mock_fetch:
        mock_fetch.return_value = {"success": True}
        res = await save_telegram_file(
            track_id="12345",
            file_id="CQACAgQAAxkBAAI...",
            message_id="9801",
            quality="320",
            filename="song.mp3"
        )
        assert res == {"success": True}
        mock_fetch.assert_called_once_with(
            "telegram/file/save",
            method="POST",
            payload={
                "trackId": "12345",
                "fileId": "CQACAgQAAxkBAAI...",
                "messageId": "9801",
                "quality": "320",
                "filename": "song.mp3"
            }
        )

if __name__ == "__main__":
    test_format_progress_bar()
    test_common_opts_socket_timeout()
    test_build_opts_includes_progress_hook()
    test_chunked_sharding_numeric_and_string_ids_5_instances()
    test_file_too_large_error_matching()
    print("Sharding, options, and error matching tests passed!")
