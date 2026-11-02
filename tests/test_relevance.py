import logging
import pytest

import crawlers.youtube as youtube
from crawlers.youtube import _calculate_relevance_score, _has_strong_title_artist_match

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("TestRelevance")

def test_relevance_scoring():
    # Test case 1: Perfect match
    video_info = {
        'title': 'The Less I Know The Better',
        'channel': 'Tame Impala',
        'uploader': 'Tame Impala',
        'upload_date': '20150717',
        'duration': 218 # 3:38
    }
    score = _calculate_relevance_score(
        video_info,
        'The Less I Know The Better',
        'Tame Impala',
        'Currents',
        '2015',
        target_duration_ms=218000
    )
    logger.info(f"Perfect match score: {score}")
    assert score >= 0.9

    # Test case 2: Duration mismatch
    video_info_bad_dur = video_info.copy()
    video_info_bad_dur['duration'] = 300 # 5:00
    score_bad_dur = _calculate_relevance_score(
        video_info_bad_dur,
        'The Less I Know The Better',
        'Tame Impala',
        'Currents',
        '2015',
        target_duration_ms=218000
    )
    logger.info(f"Bad duration match score: {score_bad_dur}")
    assert score_bad_dur < score

    # Test case 3: Title mismatch
    video_info_bad_title = video_info.copy()
    video_info_bad_title['title'] = 'Let It Happen'
    score_bad_title = _calculate_relevance_score(
        video_info_bad_title,
        'The Less I Know The Better',
        'Tame Impala',
        'Currents',
        '2015',
        target_duration_ms=218000
    )
    logger.info(f"Bad title match score: {score_bad_title}")
    assert score_bad_title < score


def test_candidate_match_requires_the_requested_artist():
    assert _has_strong_title_artist_match(
        "The Less I Know The Better", "Tame Impala - Topic",
        "The Less I Know The Better", "Tame Impala",
    )
    assert not _has_strong_title_artist_match(
        "The Less I Know The Better", "Random Cover Channel",
        "The Less I Know The Better", "Tame Impala",
    )


def test_candidate_match_rejects_unrelated_titles():
    assert not _has_strong_title_artist_match(
        "Let It Happen", "Tame Impala", "The Less I Know The Better",
        "Tame Impala",
    )


def test_album_match_improves_candidate_relevance():
    matching = {
        "title": "The Less I Know The Better",
        "channel": "Tame Impala",
        "album": "Currents",
    }
    mismatching = {**matching, "album": "Lonerism"}

    matching_score = _calculate_relevance_score(
        matching, "The Less I Know The Better", "Tame Impala",
        "Currents", "", target_duration_ms=0,
    )
    mismatching_score = _calculate_relevance_score(
        mismatching, "The Less I Know The Better", "Tame Impala",
        "Currents", "", target_duration_ms=0,
    )

    assert matching_score > mismatching_score


@pytest.mark.asyncio
async def test_search_ranks_all_results_and_skips_wrong_artist(monkeypatch):
    results = [
        {
            "id": "wrong-artist",
            "title": "The Less I Know The Better",
            "channel": "Random Cover Channel",
            "duration": 218,
        },
        {
            "id": "right-artist",
            "title": "The Less I Know The Better",
            "channel": "Tame Impala - Topic",
            "duration": 218,
        },
    ]
    monkeypatch.setattr(youtube, "SEARCH_METHOD_ORDER", [8, 2])
    monkeypatch.setattr(youtube, "_sync_search_youtube", lambda *args: None)
    searched_methods = []

    def search_candidates(query, method, use_proxy):
        searched_methods.append(method)
        return results

    monkeypatch.setattr(youtube, "_search_with_ytdlp", search_candidates)

    result = await youtube.search_youtube_track(
        "The Less I Know The Better", "Tame Impala", "Currents", "2015",
        target_duration_ms=218000,
    )

    assert result == "right-artist"
    assert searched_methods == [8]

if __name__ == "__main__":
    test_relevance_scoring()
    print("Relevance scoring tests passed!")
