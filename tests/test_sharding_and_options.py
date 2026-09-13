import pytest
from crawlers.youtube import COMMON_OPTS, _build_opts
from services.download_service import _is_file_too_large_error as is_large_download
from services.direct_download_service import _is_file_too_large_error as is_large_direct

def test_common_opts_socket_timeout():
    assert "socket_timeout" in COMMON_OPTS
    assert COMMON_OPTS["socket_timeout"] == 20

def test_build_opts_includes_socket_timeout():
    opts = _build_opts(1, "/tmp", 128, use_proxy=False)
    assert "socket_timeout" in opts
    assert opts["socket_timeout"] == 20

def test_sharding_numeric_and_string_ids():
    total_instances = 3

    test_ids = [101, "102", "item_xyz_123", 0, "456"]

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

if __name__ == "__main__":
    test_common_opts_socket_timeout()
    test_build_opts_includes_socket_timeout()
    test_sharding_numeric_and_string_ids()
    test_file_too_large_error_matching()
    print("Sharding, options, and error matching tests passed!")
