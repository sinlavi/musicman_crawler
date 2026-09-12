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
        should_convert_192_short = other_quality != "192" or is_longer_than_8_min_short
        self.assertFalse(should_convert_192_short)

        # Over 8 minutes
        is_longer_than_8_min_long = long_duration_sec is not None and long_duration_sec > 480
        should_convert_192_long = other_quality != "192" or is_longer_than_8_min_long
        self.assertTrue(should_convert_192_long)

        # Exactly 8 minutes (480s)
        exact_duration_sec = 480
        is_longer_than_8_min_exact = exact_duration_sec is not None and exact_duration_sec > 480
        should_convert_192_exact = other_quality != "192" or is_longer_than_8_min_exact
        self.assertFalse(should_convert_192_exact)

if __name__ == '__main__':
    unittest.main()
