# 🎵 MusicMan Crawler & Bot Service

[![Main Instance](https://img.shields.io/badge/Main_Instance-mm.3rah.ir-6366f1?style=for-the-badge&logo=appveyor)](https://mm.3rah.ir)
[![Python Version](https://img.shields.io/badge/python-3.10%2B-blue.svg?style=for-the-badge&logo=python)](https://python.org)
[![License](https://img.shields.io/badge/license-MIT-green.svg?style=for-the-badge)](LICENSE)
[![Status](https://img.shields.io/badge/status-active-brightgreen.svg?style=for-the-badge)](https://mm.3rah.ir)

An automated, high-performance distributed music crawler and Telegram delivery service. **MusicMan** seamlessly processes music download queues, fetches tracks from iTunes and YouTube Music, enriches audio with high-resolution artwork and accurate ID3 tags, generates audio voice previews, and delivers content directly to target Telegram channels and users.

🌐 **Project Main Instance:** [**https://mm.3rah.ir**](https://mm.3rah.ir)

---

## ✨ Key Features

- ⚡ **Distributed Sharding & Queue Polling:** Scalable multi-instance execution using deterministic modulo task distribution across runner instances.
- 🎨 **Rich Metadata & HD Artwork Tagging:** Automatically injects artist, album, title, release year, genre, and high-resolution album artwork into ID3/MP3 tags.
- 🎙️ **Voice Preview Generation:** Extracts high-quality 30-second audio preview snippets formatted specifically for instant listening on Telegram.
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
 │ iTunes API   │    │ YouTube DL   │    │ Tagging & HD │    │ Telegram Bot │
 │ Metadata     │    │ Engine       │    │ Artwork      │    │ Delivery     │
 └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

---

## 📁 Repository Structure

```
├── bot/                # Telegram bot handlers & preview delivery
├── core/               # Configuration, HTTP client, & logger modules
├── crawlers/           # iTunes, YouTube, and crawler utility engines
├── docs/               # GitHub Pages website documentation
├── models/             # Data models and structures
├── services/           # Artwork, download, tagging, lyrics, and rate-limiting services
├── tests/              # Unit and integration tests
├── wiki/               # Project documentation wiki
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
# Telegram Bot Configuration
TG_TOKEN=your_telegram_bot_token
DB_CHANNEL_ID=-100xxxxxxxxxx
INFO_CHANNEL_ID=5524168471

# API & Instance Settings
API_BASE_URL=https://musicman.gt.tc/users/index.php
API_TOKEN=your_secure_api_token
ITUNES_BASE_URL=https://3rah.ir/mm/api

# Sharding & Scaling
INSTANCE_ID=1
TOTAL_INSTANCES=1

# Optional Proxy Setup
proxy=socks5h://127.0.0.1:1080
OFFLINE_MODE=False
```

### 4. Running the Crawler

```bash
python main.py
```

### 5. Running Tests

```bash
PYTHONPATH=. python -m pytest
```

---

## 📚 Documentation & Wiki

Explore detailed documentation in our [Wiki Directory](./wiki/):

- 📖 [Home & Overview](./wiki/Home.md)
- ⚙️ [Architecture & Sharding](./wiki/Architecture-and-Sharding.md)
- 🔧 [Configuration & Environment Reference](./wiki/Configuration-and-Environment.md)
- 🎧 [Services & Crawlers](./wiki/Services-and-Crawlers.md)
- 🚀 [Deployment & GitHub Actions CI](./wiki/Deployment-and-CI.md)
- ❓ [Troubleshooting & FAQ](./wiki/Troubleshooting-and-FAQ.md)

---

## 🌐 Live Main Instance

Visit the main web application instance at:
👉 **[https://mm.3rah.ir](https://mm.3rah.ir)**

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
