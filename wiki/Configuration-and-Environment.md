# 🔧 Configuration and Environment Variable Reference

MusicMan configures its behavior via environment variables defined in `.env` or injected by deployment environments like Docker or GitHub Actions secrets.

---

## 📋 Environment Variables Overview

| Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| `TG_TOKEN` | String | *Required* | Telegram Bot API Token obtained from [@BotFather](https://t.me/BotFather). |
| `API_BASE_URL` | String | `https://musicman.gt.tc/users/index.php` | Backend API endpoint for download queue polling and status updates. |
| `API_TOKEN` | String | `change_me_to_a_secure_token` | Secret API key for authentication with the backend API service. |
| `ITUNES_BASE_URL` | String | `https://3rah.ir/mm/api` | Mirror/proxy endpoint for iTunes metadata requests. |
| `DB_CHANNEL_ID` | String/Int | `None` | Telegram channel ID used for internal caching and storage. |
| `INFO_CHANNEL_ID` | String/Int | `5524168471` | Public channel ID for system announcements and error notifications. |
| `INSTANCE_ID` | Integer | `1` | 1-based instance index for sharding (e.g., `1` for first instance). |
| `TOTAL_INSTANCES` | Integer | `1` | Total count of active parallel instances in the cluster. |
| `MAX_RUNTIME` | Integer | `19800` (5.5 hrs) | Maximum runtime in seconds before graceful termination. |
| `proxy` / `HTTP_PROXY` | String | `socks5h://127.0.0.1:1080` | SOCKS5 or HTTP proxy URL for outbound HTTP/Telegram API traffic. |
| `OFFLINE_MODE` | Boolean | `False` | Toggle mock/offline mode for testing without real network calls. |
| `SPOTIFY_CLIENT_ID` | String | `None` | Spotify Web API client ID for extended track metadata matching. |
| `SPOTIFY_CLIENT_SECRET` | String | `None` | Spotify Web API client secret. |

---

## ⚙️ Core Configuration Code (`core/config.py`)

Key parameters in `core/config.py`:

```python
BOT_NAME = "MusicMan"
BOT_USERNAME = "@musicman_official_bot"
INFO_CHANNEL_USERNAME = "@musicman_official"
TARGET_CHAT_ID = -1004499922541

# Quality settings
DEFAULT_QUALITY = "192"  # Default bitrate kbps

# Cache parameters
SEARCH_CACHE_TTL = 600      # 10 minutes cache TTL
SEARCH_CACHE_MAX_ITEMS = 100
MESSAGE_OWNER_TTL = 600
```

---

## 🛡️ SOCKS5 & SOCKS5H Proxy Routing

When using Cloudflare WARP or standard SOCKS5 proxies:
- Use `socks5h://` protocol prefix so DNS resolution happens on the proxy server side (essential for bypassing DNS censorship or geo-blocking).
- Example: `proxy=socks5h://127.0.0.1:1080`

Main Instance Web Service: [https://mm.3rah.ir](https://mm.3rah.ir)
