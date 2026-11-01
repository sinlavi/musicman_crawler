import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Connection Settings
PROXY = os.getenv("PROXY") or os.getenv("proxy", "socks5h://127.0.0.1:1080")
COOKIES_FILE = os.getenv("COOKIES_FILE") or str(
    Path(__file__).resolve().parents[1] / "cookies.txt"
)
BALE_TOKEN = os.getenv("BALE_TOKEN")
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN") or os.getenv("TG_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID") or os.getenv("TG_CHAT_ID")

# Target chat ID for sending messages
TARGET_CHAT_ID = os.getenv("BALE_CHAT_ID") or os.getenv("TARGET_CHAT_ID", "6053683389")

# Optional Bale chat for upload-error notifications
INFO_CHANNEL_ID = os.getenv("INFO_CHANNEL_ID")

# API Settings
ITUNES_BASE_URL = os.getenv("ITUNES_BASE_URL", "https://mm.3rah.ir/api")
API_BASE_URL = os.getenv("API_BASE_URL", "https://mm.3rah.ir/api")
API_TOKEN = os.getenv("API_TOKEN", "change_me_to_a_secure_token")
API_RETRY_DELAY_SECONDS = max(0.0, float(os.getenv("API_RETRY_DELAY_SECONDS", "2")))
LRCLIB_APP_ID = os.getenv("LRCLIB_APP_ID")
LRCLIB_API_KEY = os.getenv("LRCLIB_API_KEY")

# Bot Behavior
OFFLINE_MODE = os.getenv("OFFLINE_MODE", "False").lower() == "true"
DEFAULT_QUALITY = "192"

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36"
]
