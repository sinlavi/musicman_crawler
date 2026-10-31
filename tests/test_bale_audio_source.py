from unittest.mock import AsyncMock, patch

import pytest

from crawlers.itunes import get_cached_audio, set_mirror


@pytest.mark.asyncio
async def test_cached_audio_only_uses_bale_mirrors():
    attachments = {
        "audioUrls": [
            {"quality": "192", "source": "youtube", "url": "old_file_id"},
            {"quality": "192", "source": "bale", "url": "bale_file_id"},
        ]
    }

    with patch("crawlers.itunes.get_attachments", new_callable=AsyncMock) as get_attachments:
        get_attachments.return_value = attachments

        assert await get_cached_audio(123, quality="192") == "bale_file_id"


@pytest.mark.asyncio
async def test_cached_audio_prefers_bale_file_id_over_bale_message_url():
    attachments = {
        "audioUrls": [{
            "quality": "192",
            "source": "bale",
            "url": "bale://61452",
            "baleFileId": "BALE_FILE_ID",
        }]
    }

    with patch("crawlers.itunes.get_attachments", new_callable=AsyncMock) as get_attachments:
        get_attachments.return_value = attachments

        assert await get_cached_audio(123, quality="192") == "BALE_FILE_ID"


@pytest.mark.asyncio
async def test_cached_audio_ignores_bale_message_reference_without_file_id():
    with patch("crawlers.itunes.get_attachments", new_callable=AsyncMock) as get_attachments:
        get_attachments.return_value = {
            "audioUrls": [{
                "quality": "192",
                "source": "bale",
                "url": "bale://61452",
            }]
        }

        assert await get_cached_audio(123, quality="192") is None


@pytest.mark.asyncio
async def test_saved_audio_mirror_includes_bale_source():
    with patch("crawlers.itunes.fetch_itunes", new_callable=AsyncMock) as fetch_itunes, \
            patch("crawlers.itunes.lookup_itunes", new_callable=AsyncMock):
        fetch_itunes.return_value = {"success": True}

        await set_mirror(
            "track", 123, "audioUrl", "bale_file_id", quality="192", source="bale"
        )

        payload = fetch_itunes.call_args.kwargs["payload"]
        assert payload["source"] == "bale"


@pytest.mark.asyncio
async def test_cached_audio_ignores_non_bale_mirrors():
    with patch("crawlers.itunes.get_attachments", new_callable=AsyncMock) as get_attachments:
        get_attachments.return_value = {
            "audioUrls": [{"quality": "192", "source": "youtube", "url": "old_file_id"}]
        }

        assert await get_cached_audio(123, quality="192") is None