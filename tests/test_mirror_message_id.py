import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from services.artwork_service import ArtworkService
from bot.handlers.preview import send_voice_preview


@pytest.mark.asyncio
async def test_set_artwork_mirror_uses_message_id():
    mock_api = MagicMock()
    service = ArtworkService(mock_api)

    with patch("services.artwork_service.set_mirror", new_callable=AsyncMock) as mock_set_mirror:
        mock_set_mirror.return_value = {"success": True}
        res = await service.set_artwork_mirror("track", 12345, 98765)

        assert res is True
        mock_set_mirror.assert_called_once_with(
            "track", "12345", "artworkUrl", "https://api.telegram.org/file/bot<token>/98765"
        )


@pytest.mark.asyncio
async def test_send_artwork_photo_uses_message_id():
    mock_api = MagicMock()
    service = ArtworkService(mock_api)
    mock_bot = AsyncMock()
    mock_msg = MagicMock()
    mock_msg.photo = [MagicMock()]
    mock_msg.message_id = 554433
    mock_bot.send_photo.return_value = mock_msg

    with patch.object(service, "set_artwork_mirror", new_callable=AsyncMock) as mock_set_artwork_mirror:
        res = await service.send_artwork_photo(
            mock_bot, 100, b"fake_bytes", "Caption", entity_type="track", entity_id=123
        )

        assert res == mock_msg
        mock_set_artwork_mirror.assert_called_once_with("track", 123, 554433)


@pytest.mark.asyncio
async def test_preview_uses_message_id():
    mock_bot = AsyncMock()
    mock_msg = MagicMock()
    mock_msg.message_id = 778899
    mock_bot.send_voice.return_value = mock_msg

    mock_resp = AsyncMock()
    mock_resp.status = 200
    mock_resp.read = AsyncMock(return_value=b"audio data")

    mock_session = MagicMock()
    mock_session.get.return_value.__aenter__.return_value = mock_resp

    with patch("bot.handlers.preview.get_track", new_callable=AsyncMock) as mock_get_track, \
         patch("bot.handlers.preview.get_cached_preview", new_callable=AsyncMock) as mock_get_cached, \
         patch("bot.handlers.preview.HttpClient.get_session", new_callable=AsyncMock) as mock_get_session, \
         patch("bot.handlers.preview.set_mirror", new_callable=AsyncMock) as mock_set_mirror:

        mock_get_track.return_value = {"results": [{"trackName": "Test Track", "previewUrl": "http://example.com/p.mp3"}]}
        mock_get_cached.return_value = None
        mock_get_session.return_value = mock_session
        mock_set_mirror.return_value = {"success": True}

        await send_voice_preview(mock_bot, 12345, 999, silent=True)

        mock_set_mirror.assert_called_once_with(
            "track", "999", "previewUrl", "https://api.telegram.org/file/bot<token>/778899"
        )
