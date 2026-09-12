import sys
from unittest.mock import MagicMock

sys.modules['ytmusicapi'] = MagicMock()

import pytest
import unittest
from unittest.mock import AsyncMock, patch
from pathlib import Path
from services.download_service import DownloadService
from services.direct_download_service import DirectDownloadService

class TestDualUploadCondition(unittest.TestCase):

    def test_download_service_dual_upload_condition(self):
        # Verify 192kbps threshold logic: > 480 seconds (8 minutes)
        short_duration_sec = 300  # 5 minutes
        long_duration_sec = 600   # 10 minutes

        # For 320 quality, other_quality is "192"
        quality_value = "320"
        other_quality = "192" if str(quality_value) == "320" else "320"

        # Under 8 minutes
        is_longer_than_8_min_short = short_duration_sec is not None and short_duration_sec > 480
        should_convert_192_short = other_quality == "192" and is_longer_than_8_min_short
        self.assertFalse(should_convert_192_short)

        # Over 8 minutes
        is_longer_than_8_min_long = long_duration_sec is not None and long_duration_sec > 480
        should_convert_192_long = other_quality == "192" and is_longer_than_8_min_long
        self.assertTrue(should_convert_192_long)

        # Exactly 8 minutes (480s)
        exact_duration_sec = 480
        is_longer_than_8_min_exact = exact_duration_sec is not None and exact_duration_sec > 480
        should_convert_192_exact = other_quality == "192" and is_longer_than_8_min_exact
        self.assertFalse(should_convert_192_exact)

    def test_when_quality_value_is_192_no_dual_upload(self):
        # If primary quality_value became 192 (e.g. fallback due to size), other_quality is 320
        quality_value = "192"
        other_quality = "192" if str(quality_value) == "320" else "320"
        duration_sec = 600  # 10 minutes

        is_longer_than_8_min = duration_sec is not None and duration_sec > 480
        should_convert = other_quality == "192" and is_longer_than_8_min
        self.assertFalse(should_convert)

class TestCacheHitDualUpload(unittest.IsolatedAsyncioTestCase):

    async def test_cache_hit_dual_upload_condition_long_track(self):
        bot = AsyncMock()
        service = DownloadService(bot, AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock())

        # Mock get_track and get_cached_audio
        track_data = {"results": [{"trackId": 123, "trackName": "Long Song", "artistName": "Artist", "trackTimeMillis": 600000}]}

        with patch("services.download_service.get_track", new_callable=AsyncMock) as mock_get_track, \
             patch("services.download_service.get_cached_audio", new_callable=AsyncMock) as mock_get_cached:
            mock_get_track.return_value = track_data
            mock_get_cached.side_effect = lambda tid, quality=None: "file_320_id" if quality == "320" else "file_192_id"

            await service.download_and_send_track(chat_id=1234, track_id=123, user_id=99)

            # bot.send_audio should be called twice (320kbps + 192kbps)
            self.assertEqual(bot.send_audio.call_count, 2)
            first_call_audio = bot.send_audio.call_args_list[0].kwargs['audio']
            second_call_audio = bot.send_audio.call_args_list[1].kwargs['audio']
            self.assertEqual(first_call_audio, "file_320_id")
            self.assertEqual(second_call_audio, "file_192_id")

    async def test_cache_hit_dual_upload_condition_short_track(self):
        bot = AsyncMock()
        service = DownloadService(bot, AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock())

        track_data = {"results": [{"trackId": 124, "trackName": "Short Song", "artistName": "Artist", "trackTimeMillis": 200000}]}

        with patch("services.download_service.get_track", new_callable=AsyncMock) as mock_get_track, \
             patch("services.download_service.get_cached_audio", new_callable=AsyncMock) as mock_get_cached:
            mock_get_track.return_value = track_data
            mock_get_cached.side_effect = lambda tid, quality=None: "file_320_id" if quality == "320" else "file_192_id"

            await service.download_and_send_track(chat_id=1234, track_id=124, user_id=99)

            # bot.send_audio should be called only once (320kbps)
            self.assertEqual(bot.send_audio.call_count, 1)
            first_call_audio = bot.send_audio.call_args_list[0].kwargs['audio']
            self.assertEqual(first_call_audio, "file_320_id")

if __name__ == '__main__':
    unittest.main()
