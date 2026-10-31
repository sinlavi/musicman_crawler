import asyncio
import unittest
from unittest.mock import MagicMock, patch
import sys

# Mock YTMusic before importing LyricsService to avoid ConnectionError in __init__
sys.modules['ytmusicapi'] = MagicMock()

from services.lyrics_service import LyricsService
from core.http_client import HttpClient

class TestLyricsPlaceholder(unittest.IsolatedAsyncioTestCase):
    @patch('services.lyrics_service.LyricsService._fetch_from_lrclib')
    @patch('services.lyrics_service.LyricsService._fetch_from_ytmusic')
    async def test_lyrics_placeholder(self, mock_ytm, mock_lrclib):
        # LRCLIB returns empty dict
        mock_lrclib.return_value = {}
        # YTMusic returns empty dict
        mock_ytm.return_value = {}

        ls = LyricsService()
        lyrics = await ls.get_lyrics("test_id", "test_title", "test_artist")

        self.assertEqual(lyrics, {"synced": None, "plain": "Instrumental/Not found"})

    @patch.object(HttpClient, 'request_with_methods')
    async def test_lrclib_retries_direct_failure_with_proxy(self, mock_request):
        mock_request.side_effect = [
            (None, 503, True),
            ({"plainLyrics": "lyrics", "syncedLyrics": None}, 200, False),
        ]

        ls = LyricsService()
        lyrics = await ls._fetch_from_lrclib("title", "artist")

        self.assertEqual(lyrics["plain"], "lyrics")
        self.assertEqual(mock_request.call_count, 2)
        self.assertFalse(mock_request.call_args_list[0].kwargs["use_proxy"])
        self.assertTrue(mock_request.call_args_list[1].kwargs["use_proxy"])

if __name__ == '__main__':
    unittest.main()
