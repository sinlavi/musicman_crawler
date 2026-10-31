# 🎵 MusicMan Crawler & Bot Service

[![Main Instance](https://img.shields.io/badge/Main_Instance-mm.3rah.ir-6366f1?style=for-the-badge&logo=appveyor)](https://mm.3rah.ir)
[![Python Version](https://img.shields.io/badge/python-3.10%2B-blue.svg?style=for-the-badge&logo=python)](https://python.org)
[![License](https://img.shields.io/badge/license-MIT-green.svg?style=for-the-badge)](LICENSE)
[![Status](https://img.shields.io/badge/status-active-brightgreen.svg?style=for-the-badge)](https://mm.3rah.ir)

An automated music crawler and Bale Messenger delivery service. **MusicMan** processes the backend download queue, gets track metadata and artwork from iTunes, downloads audio from YouTube, adds LRCLIB or YouTube Music lyrics, tags the MP3, and sends the resulting file through Bale.

🌐 **Project Main Instance:** [**https://mm.3rah.ir**](https://mm.3rah.ir)

---

## ✨ Key Features

- ⚡ **Distributed Sharding & Queue Polling:** Scalable multi-instance execution using deterministic modulo task distribution across runner instances.
- 🎨 **Rich Metadata & HD Artwork Tagging:** Automatically injects artist, album, title, release year, genre, and high-resolution album artwork into ID3/MP3 tags.
- 🎼 **Lyrics:** Uses LRCLIB first and YouTube Music when LRCLIB has no lyrics.
- 📤 **Bale Delivery:** Uploads the tagged audio file without a message caption; long tracks retain the additional 192 kbps upload.
- 🔄 **Automatic Recovery & Rate Limiting:** Self-healing polling loop that automatically rescues stuck/interrupted downloads and prevents rate limiting via exponential backoff.
- 🌐 **Cloudflare WARP Proxy Support:** Built-in proxy routing (SOCKS5/HTTP) for bypassing geo-restrictions and network rate limits.
- 📝 **Lyrics Integration:** Synchronized and plain text lyrics retrieval and tagging for enhanced user experience.

---

## 🏗️ System Architecture

```
                                  ┌───────────────────────────┐
                                  │      Main Web Instance    │
                                  │     ( https://mm.3rah.ir ) │
                                  └─────────────┬─────────────┘
                                                │ Queue Poll / API
                                                ▼
                   ┌────────────────────────────────────────────────────────┐
                   │               MusicMan Distributed Crawlers            │
                   ├───────────────────┬───────────────────┬────────────────┤
                   │    Instance 1/3   │    Instance 2/3   │  Instance 3/3  │
                   │ (download_id % 3) │ (download_id % 3) │(download_id % 3)│
                   └─────────┬─────────┴─────────┬─────────┴────────┬───────┘
                             │                   │                  │
        ┌────────────────────┼───────────────────┼──────────────────┐
        ▼                    ▼                   ▼                  ▼
 ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
 │ iTunes API   │    │ YouTube DL   │    │ Tagging & HD │    │ Bale Messenger │
 │ Metadata     │    │ Engine       │    │ Artwork      │    │ Delivery     │
 └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

---

## 📁 Repository Structure

```
├── core/               # Configuration, HTTP client, & logger modules
├── crawlers/           # iTunes, YouTube, and crawler utility engines
├── models/             # Data models and structures
├── services/           # Artwork, download, tagging, lyrics, and rate-limiting services
├── tests/              # Unit and integration tests
├── main.py             # Application entry point and distributed runner loop
├── pyproject.toml      # Project configurations & tool settings
└── requirements.txt    # Python dependencies
```

---

## 🚀 Quick Start

### 1. Prerequisites

- Python 3.10+
- FFmpeg (for audio transcoding and preview extraction)
- Optional: Cloudflare WARP / SOCKS5 proxy

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/your-username/musicman.git
cd musicman

# Create and activate virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Environment Configuration

Create a `.env` file in the root directory:

```env
# Bale Messenger Configuration
BALE_TOKEN=your_bale_bot_token
BALE_CHAT_ID=6053683389
INFO_CHANNEL_ID=your_bale_status_chat_id
# Required Telegram mirror storage
TELEGRAM_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_channel_id

# API & Instance Settings
API_BASE_URL=https://3rah.ir/mm/api
API_TOKEN=your_secure_api_token
ITUNES_BASE_URL=https://3rah.ir/mm/api

# Sharding & Scaling
INSTANCE_ID=1
TOTAL_INSTANCES=1

# Optional Proxy Setup
proxy=socks5h://127.0.0.1:1080
OFFLINE_MODE=False
```

### GitHub Actions secrets

Required for every worker:

- `BALE_TOKEN`: token from the Bale bot used to upload audio.
- `BALE_CHAT_ID`: Bale channel/group/chat ID where audio is uploaded.
- `TELEGRAM_TOKEN`: token from `@BotFather` for the Telegram bot used to upload audio.
- `TELEGRAM_CHAT_ID`: Telegram channel/group ID where the bot uploads mirrors.

Optional:

- `INFO_CHANNEL_ID`: Bale chat for error notifications.
- `proxy`: proxy URL for messenger/API/YouTube traffic.
- `OFFLINE_MODE`: set to `True` only for local offline testing.
- `API_TOKEN`: API authentication token, if enabled by the server.

The Telegram bot must be an administrator of the target channel/group with permission
to post audio. GitHub repository secrets are configured under **Settings → Secrets and
variables → Actions**.

### 4. Running the Crawler

```bash
python main.py
```

### 5. Running Tests

```bash
PYTHONPATH=. python -m pytest
```

---

## 🌐 Live Main Instance

Visit the main web application instance at:
👉 **[https://mm.3rah.ir](https://mm.3rah.ir)**

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
