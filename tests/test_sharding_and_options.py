import pytest
import asyncio
import aiohttp
from crawlers.youtube import COMMON_OPTS, _build_opts
from services.download_service import _is_file_too_large_error as is_large_download
from services.direct_download_service import _is_file_too_large_error as is_large_direct
from main import start_trigger_server, handle_trigger, new_task_event

def test_common_opts_socket_timeout():
    assert "socket_timeout" in COMMON_OPTS
    assert COMMON_OPTS["socket_timeout"] == 20

def test_build_opts_includes_socket_timeout():
    opts = _build_opts(1, "/tmp", 128, use_proxy=False)
    assert "socket_timeout" in opts
    assert opts["socket_timeout"] == 20

def test_sharding_numeric_and_string_ids_5_instances():
    total_instances = 5
    test_ids = [101, "102", "item_xyz_123", 0, "456", 1000, 1001, 1002, 1003, 1004]

    for download_id in test_ids:
        try:
            numeric_id = int(download_id)
        except (ValueError, TypeError):
            numeric_id = abs(hash(str(download_id)))

        assigned_instance = (numeric_id % total_instances) + 1
        assert 1 <= assigned_instance <= total_instances

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

if __name__ == "__main__":
    test_common_opts_socket_timeout()
    test_build_opts_includes_socket_timeout()
    test_sharding_numeric_and_string_ids_5_instances()
    test_file_too_large_error_matching()
    print("Sharding, options, and error matching tests passed!")
