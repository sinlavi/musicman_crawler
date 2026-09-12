# 📚 MusicMan Project Wiki

Welcome to the **MusicMan Crawler & Bot Service** official documentation wiki.

MusicMan is a distributed music crawler, tagging engine, and Telegram bot delivery platform. It automates queue processing from backend API services, extracts tracks from streaming sources (iTunes, YouTube Music), enriches track metadata and high-resolution album covers, generates Telegram-optimized voice previews, and delivers music files directly to target Telegram channels and subscribers.

🌐 **Main Application Instance:** [**https://mm.3rah.ir**](https://mm.3rah.ir)

---

## 📑 Wiki Contents

1. 📖 **[Home & Overview](./Home.md)** - Introduction, features, and main instance access.
2. ⚙️ **[Architecture & Sharding](./Architecture-and-Sharding.md)** - Queue polling, modulo sharding, lock handling, and process lifecycle.
3. 🔧 **[Configuration & Environment Reference](./Configuration-and-Environment.md)** - Detailed description of environment variables and operational switches.
4. 🎧 **[Services & Crawlers](./Services-and-Crawlers.md)** - In-depth breakdown of `DownloadService`, `ArtworkService`, `TaggingService`, `LyricsService`, and `itunes`/`youtube` crawlers.
5. 🚀 **[Deployment & CI](./Deployment-and-CI.md)** - Running locally, Docker setup, Cloudflare WARP SOCKS5 proxy, and GitHub Actions workflow schedules.
6. ❓ **[Troubleshooting & FAQ](./Troubleshooting-and-FAQ.md)** - Stuck download recovery, technical error backoff, rate limiting, and common resolution steps.

---

## 🔗 Quick Links

- [Main Instance (mm.3rah.ir)](https://mm.3rah.ir)
- [Main Repository README](../README.md)
