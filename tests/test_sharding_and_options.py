import pytest
from crawlers.youtube import COMMON_OPTS, _build_opts, _download_progress_percent
from services.download_service import _is_file_too_large_error as is_large_download
from main import (
    _belongs_to_instance,
    _merge_priority_items,
    _normalize_queue_items,
    _queue_priority,
)

def test_common_opts_socket_timeout():
    assert "socket_timeout" in COMMON_OPTS
    assert COMMON_OPTS["socket_timeout"] == 20

def test_build_opts_includes_socket_timeout():
    opts = _build_opts(1, "/tmp", 128, use_proxy=False)
    assert "socket_timeout" in opts
    assert opts["socket_timeout"] == 20


def test_download_progress_percent_uses_estimated_size_and_clamps():
    assert _download_progress_percent({
        "status": "downloading",
        "downloaded_bytes": 25,
        "total_bytes_estimate": 100,
    }) == 25
    assert _download_progress_percent({
        "status": "downloading",
        "downloaded_bytes": 150,
        "total_bytes": 100,
    }) == 100
    assert _download_progress_percent({"status": "finished"}) is None


def test_normalize_queue_items_accepts_track_id_keyed_mapping():
    item = {"download_id": 24541, "download_status": "downloading"}
    normalized = _normalize_queue_items({"1674218402": item})

    assert normalized == [{
        "download_id": 24541,
        "download_status": "downloading",
        "trackId": "1674218402",
    }]
    assert item.get("trackId") is None


def test_queue_priority_orders_high_tracks_ahead_of_regular_batch_items():
    items = [
        {"download_id": 1, "priority": 0},
        {"download_id": 2, "priority": 100},
        {"download_id": 3, "priority": "25"},
        {"download_id": 4},
    ]

    ordered = sorted(items, key=_queue_priority, reverse=True)

    assert [item["download_id"] for item in ordered] == [2, 3, 1, 4]


def test_new_priority_item_moves_ahead_of_unfinished_batch_without_duplicates():
    pending = [
        {"download_id": 1, "priority": 0},
        {"download_id": 2, "priority": 0},
    ]
    incoming = [
        {"download_id": 1, "priority": 0},
        {"download_id": 3, "priority": 100, "download_status": "pending"},
        {"download_id": 4, "priority": 200, "download_status": "downloading"},
    ]

    merged = _merge_priority_items(pending, incoming, {99})

    assert [item["download_id"] for item in merged] == [3, 1, 2]


def test_sharding_numeric_and_string_ids():
    total_instances = 3

    test_ids = [101, "102", "item_xyz_123", 0, "456"]

    for download_id in test_ids:
        assignments = [
            instance_id
            for instance_id in range(1, total_instances + 1)
            if _belongs_to_instance(download_id, instance_id, total_instances)
        ]
        assert len(assignments) == 1


def test_non_numeric_sharding_is_stable():
    assert _belongs_to_instance("item_xyz_123", 1, 3) == _belongs_to_instance(
        "item_xyz_123", 1, 3
    )

def test_file_too_large_error_matching():
    errors = [
        Exception("Request Entity Too Large"),
        Exception("HTTP/1.1 413 Request Entity Too Large"),
        Exception("Upload error: file_too_large"),
        Exception("File is too large"),
    ]
    for err in errors:
        assert is_large_download(err) is True

    other_err = Exception("Connection reset by peer")
    assert is_large_download(other_err) is False

if __name__ == "__main__":
    test_common_opts_socket_timeout()
    test_build_opts_includes_socket_timeout()
    test_sharding_numeric_and_string_ids()
    test_file_too_large_error_matching()
    print("Sharding, options, and error matching tests passed!")
