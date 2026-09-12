# 🎧 Services and Crawlers Reference

This page provides detailed technical explanations of the core services and crawler modules within MusicMan.

---

## 🗂️ Core Services Overview

```
                      ┌───────────────────────────────┐
                      │        DownloadService        │
                      └───────────────┬───────────────┘
                                      │
          ┌─────────────────┬─────────┴───────┬──────────────────┐
          ▼                 ▼                 ▼                  ▼
┌─────────────────┐ ┌───────────────┐ ┌───────────────┐ ┌─────────────────┐
│ TaggingService  │ │ArtworkService │ │LyricsService  │ │ DownloadRate    │
│ (Mutagen ID3)   │ │(Pillow & Cache│ │(LRCLIB & API) │ │ Limiter         │
└─────────────────┘ └───────────────┘ └───────────────┘ └─────────────────┘
```

---

## 1. `DownloadService` (`services/download_service.py`)

The primary orchestration engine responsible for downloading tracks from YouTube or iTunes sources and uploading audio to Telegram.

### Key Operations
- Orchestrates audio stream extraction using `yt-dlp`.
- Converts files to target bitrates (128k, 192k, 320k) via FFmpeg.
- Calls `TaggingService` to inject metadata and `ArtworkService` for cover embedding.
- Sends output files and voice previews via `python-telegram-bot`.

---

## 2. `TaggingService` (`services/tagging_service.py`)

Manages audio metadata enrichment using `mutagen`.

### ID3 Tags Injected
- `TIT2` (Title)
- `TPE1` (Artist)
- `TALB` (Album)
- `TDRC` / `TYER` (Release Year)
- `TCON` (Genre)
- `APIC` (Attached Picture / Cover Artwork)
- `USLT` (Unsynchronised Lyrics)

---

## 3. `ArtworkService` (`services/artwork_service.py`)

Handles high-resolution album cover processing and caching.

### Key Features
- Fetches high-res artwork (up to 3000x3000 px) from iTunes API.
- Re-encodes artwork using `Pillow` to meet Telegram photo upload requirements.
- Uses local file system and Telegram DB channels for caching uploaded image file IDs.

---

## 4. `LyricsService` (`services/lyrics_service.py`)

Fetches synced (.lrc) and plain text lyrics from LRCLIB and external providers. Injects lyrics into the MP3 tags so compatible media players display lyrics while offline.

---

## 5. `DownloadRateLimiter` (`services/rate_limiter.py`)

Protects download pipelines against rate-limiting blocks from source platforms (YouTube, iTunes, Telegram API) by enforcing token-bucket delays and concurrent task constraints.

---

## 🕷️ Crawler Modules (`crawlers/`)

- `crawlers/itunes.py`: Polls queue items from backend API (`/get_download_queue`), updates download status, and resets stuck tasks.
- `crawlers/youtube.py`: YouTube search, relevance score computation (`_calculate_relevance_score`), audio stream selection, and extraction.
- `crawlers/utils.py`: Text formatting, Persian/Arabic character normalizers, artist hashtag generation, and track search utilities.

Main Instance Access: [https://mm.3rah.ir](https://mm.3rah.ir)
