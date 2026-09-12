import pytest
import unittest
from unittest.mock import AsyncMock, patch
from crawlers.itunes import set_mirror


class TestSetMirrorRetry(unittest.IsolatedAsyncioTestCase):

    async def test_set_mirror_success_first_attempt(self):
        with patch("crawlers.itunes.fetch_itunes", new_callable=AsyncMock) as mock_fetch, \
             patch("crawlers.itunes.lookup_itunes", new_callable=AsyncMock) as mock_lookup:
            mock_fetch.return_value = {"success": True}

            res = await set_mirror("track", 12345, "audioUrl", "http://test_url", quality="192", max_retries=3)

            self.assertEqual(res, {"success": True})
            self.assertEqual(mock_fetch.call_count, 1)
            mock_lookup.assert_called_once_with(12345, entity="track", bypass_cache=True, quality="192")

    async def test_set_mirror_success_after_retries(self):
        with patch("crawlers.itunes.fetch_itunes", new_callable=AsyncMock) as mock_fetch, \
             patch("crawlers.itunes.lookup_itunes", new_callable=AsyncMock) as mock_lookup, \
             patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            mock_fetch.side_effect = [
                None,  # First attempt technical error
                {"success": False},  # Second attempt failed status
                {"success": True}  # Third attempt success
            ]

            res = await set_mirror("track", 12345, "audioUrl", "http://test_url", quality="320", max_retries=3)

            self.assertEqual(res, {"success": True})
            self.assertEqual(mock_fetch.call_count, 3)
            self.assertEqual(mock_sleep.call_count, 2)
            mock_lookup.assert_called_once_with(12345, entity="track", bypass_cache=True, quality="320")

    async def test_set_mirror_ultimate_failure(self):
        with patch("crawlers.itunes.fetch_itunes", new_callable=AsyncMock) as mock_fetch, \
             patch("crawlers.itunes.lookup_itunes", new_callable=AsyncMock) as mock_lookup, \
             patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            mock_fetch.return_value = None

            res = await set_mirror("track", 12345, "audioUrl", "http://test_url", quality="192", max_retries=3)

            self.assertIsNone(res)
            self.assertEqual(mock_fetch.call_count, 3)
            self.assertEqual(mock_sleep.call_count, 2)
            mock_lookup.assert_not_called()


if __name__ == '__main__':
    unittest.main()
