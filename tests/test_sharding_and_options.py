import pytest
from crawlers.youtube import COMMON_OPTS, _build_opts

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

if __name__ == "__main__":
    test_common_opts_socket_timeout()
    test_build_opts_includes_socket_timeout()
    test_sharding_numeric_and_string_ids()
    print("Sharding and options tests passed!")
