from __future__ import annotations

import difflib
import os
import re
import sys
import time
import random
import logging
import subprocess
import tempfile
import uuid
import shutil
from pathlib import Path
from typing import Callable, Optional

import asyncio
import yt_dlp
from rapidfuzz import fuzz
from ytmusicapi import YTMusic

try:
    from core.config import COOKIES_FILE, OFFLINE_MODE, PROXY, USER_AGENTS, YOUTUBE_CONCURRENCY
except ImportError:
    OFFLINE_MODE = False
    PROXY = "socks5h://127.0.0.1:1080"
    COOKIES_FILE = str(Path(__file__).resolve().parents[1] / "cookies.txt")
    YOUTUBE_CONCURRENCY = max(1, int(os.getenv("YOUTUBE_CONCURRENCY", "3")))

logger = logging.getLogger("yt_downloader")
logging.basicConfig(level=logging.INFO)

# ── Audio post‑processor ──────────────────────────────────────────
AUDIO_POSTPROCESSOR = {
    "key": "FFmpegExtractAudio",
    "preferredcodec": "mp3",
    "preferredquality": "128",
}
CONFIDENT_SEARCH_SCORE = 0.88

# ── Common yt‑dlp flags (shared by all methods) ──────────────────────────
COMMON_OPTS: dict = {
    "outtmpl": "%(title)s.%(ext)s",
    "noplaylist": True,
    "retries": 10,
    "fragment_retries": 10,
    "no_check_certificate": True,
    "concurrent_fragments": 8,
    "quiet": True,
    "no_warnings": True,
    "sleep_interval": 2,
    "max_sleep_interval": 6,
    "sleep_interval_requests": 1,
    "socket_timeout": 20,
}

# ── Smart Method Sorting ────────────────────────────────────────────────
METHOD_ORDER = [8, 2, 3, 4, 5, 6, 7, 1]
METHOD_ORDER_LOCK = asyncio.Lock()

# ── Search Method Order (same as download methods) ───────────────────────
SEARCH_METHOD_ORDER = [8, 2, 3, 4, 5, 6, 7, 1]
SEARCH_METHOD_ORDER_LOCK = asyncio.Lock()
YOUTUBE_REQUEST_SEMAPHORE = asyncio.Semaphore(
    YOUTUBE_CONCURRENCY
)
_YOUTUBE_RATE_LIMIT_UNTIL = 0.0
_YOUTUBE_RATE_LIMIT_TRIGGERED = False
_YOUTUBE_RATE_LIMIT_LOCK = asyncio.Lock()
YOUTUBE_RATE_LIMIT_COOLDOWN = max(
    15 * 60, int(os.getenv("YOUTUBE_RATE_LIMIT_COOLDOWN", str(60 * 60)))
)

# ============================================================================
# YouTube Music Helper
# ============================================================================
YT = None


def _get_cookies_path() -> Optional[str]:
    """
    Get the path to cookies.txt in the root project folder.
    Returns None if the file doesn't exist.
    """
    cookies_path = Path(COOKIES_FILE).expanduser()

    if cookies_path.exists() and cookies_path.is_file():
        logger.info("Using YouTube cookies from: %s", cookies_path)
        return str(cookies_path)
    else:
        logger.warning("YouTube cookies file not found: %s", cookies_path)
        return None


def _get_random_headers() -> dict:
    """Generate professional browser headers to evade bot detection."""
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    }


_HAS_DENO = None


def _check_deno() -> bool:
    """Return True if Deno runtime is available."""
    global _HAS_DENO
    if _HAS_DENO is not None:
        return _HAS_DENO
    try:
        subprocess.run(["deno", "--version"], capture_output=True, check=True)
        _HAS_DENO = True
    except (FileNotFoundError, subprocess.CalledProcessError):
        _HAS_DENO = False
    return _HAS_DENO


_CACHED_LOCAL_PROXY = None


def _check_proxy() -> Optional[str]:
    """Return SOCKS5 proxy URL if WARP/Dante/etc. is listening on 1080."""
    global _CACHED_LOCAL_PROXY
    if _CACHED_LOCAL_PROXY is not None:
        return _CACHED_LOCAL_PROXY if _CACHED_LOCAL_PROXY else None
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    try:
        if s.connect_ex(("127.0.0.1", 1080)) == 0:
            s.close()
            _CACHED_LOCAL_PROXY = "socks5://127.0.0.1:1080"
        else:
            _CACHED_LOCAL_PROXY = ""  # Use empty string to indicate checked but not found
    except Exception:
        _CACHED_LOCAL_PROXY = ""
    finally:
        s.close()
    return _CACHED_LOCAL_PROXY if _CACHED_LOCAL_PROXY else None


# ============================================================================
# Similarity & matching helpers
# ============================================================================

def _get_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return fuzz.WRatio(str(a), str(b)) / 100.0


# ── Text normalization for matching ─────────────────────────────────────
_NOISE_PATTERNS = [
    r"\(official\s*(music\s*)?video\)",
    r"\[official\s*(music\s*)?video\]",
    r"\(official\s*audio\)",
    r"\[official\s*audio\]",
    r"\(lyric[s]?\s*video\)",
    r"\[lyric[s]?\s*video\]",
    r"\(audio\)",
    r"\[audio\]",
    r"\(hd\)",
    r"\[hd\]",
    r"\(hq\)",
    r"\[hq\]",
    r"\((?:re)?master(?:ed)?\)",
    r"\[(?:re)?master(?:ed)?\]",
    r"\(explicit\)",
    r"\[explicit\]",
    r"\(clean\)",
    r"\[clean\]",
    r"\(feat\.?[^)]*\)",
    r"\[feat\.?[^\]]*\]",
    r"\(ft\.?[^)]*\)",
    r"\[ft\.?[^\]]*\]",
    r"\(with\s+[^)]*\)",
    r"\b(?:ft|feat)\.?\s+\S+",
    r"\bofficial\s+(?:music\s+)?video\b",
    r"\blyric[s]?\s+video\b",
    r"\bofficial\s+audio\b",
    r"\b(?:re)?master(?:ed)?\b",
    r"\bexplicit\b",
    r"\bclean\b",
]
_NOISE_REGEX = [re.compile(p, re.IGNORECASE) for p in _NOISE_PATTERNS]


def _normalize_text_for_matching(text: str) -> str:
    """Strip noise (Official Video, [Lyrics], feat. X, remaster, etc.) and lowercase."""
    if not text:
        return ""
    s = str(text).lower()
    for pat in _NOISE_REGEX:
        s = pat.sub(" ", s)
    # Treat common separators as spaces so "Artist - Song" ≈ "Artist Song"
    s = re.sub(r"[\-_/|]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _score_duration(target_duration_ms: int, video_duration_sec: float) -> float:
    """
    Continuous similarity in [0, 1] between the *source* song length and the
    candidate's length. Music videos often differ by a few seconds (intros,
    outros, skits), so this is a soft curve rather than hard tiers.
    Returns 0.5 (neutral) when either side is missing.
    """
    if not target_duration_ms or not video_duration_sec:
        return 0.5
    diff = abs(target_duration_ms / 1000.0 - float(video_duration_sec))
    if diff <= 2:
        return 1.0
    if diff <= 5:
        return 0.9
    if diff <= 10:
        return 0.7
    if diff <= 15:
        return 0.5
    if diff <= 25:
        return 0.25
    if diff <= 40:
        return 0.05
    return 0.0


def _is_official_channel(channel: str, uploader: str, target_artist: str) -> bool:
    """Heuristic: VEVO, *- Topic (auto-generated), or channel name matches the artist."""
    text = f"{channel} {uploader}".strip().lower()
    if "vevo" in text:
        return True
    if "- topic" in text:
        return True
    if target_artist:
        norm_target = _normalize_text_for_matching(target_artist)
        norm_text = _normalize_text_for_matching(text)
        if norm_target and norm_target in norm_text:
            return True
    return False


def _score_candidate(
    *,
    title: str,
    artist_text: str,
    album: str,
    upload_date: str,
    duration_sec: float,
    description: str,
    t_name: str,
    a_name: str,
    collection_name: str,
    ye: str,
    target_duration_ms: int = 0,
    is_official_channel: bool = False,
) -> tuple[float, float, float, float]:
    """
    Unified candidate scoring.

    Signals (weights ≈ 1.0):
      - Title similarity         0.35
      - Artist similarity        0.25
      - Duration match           0.20   <- song length
      - Album similarity         0.10   <- album title
      - Year match               0.05
      - Bonus: official channel  +0.03
      - Bonus: artist-in-title   +0.02
      - Penalty: >25s / >40s duration mismatch, or very low title sim

    Returns (total_score, title_sim, artist_sim, duration_score).
    """
    norm_title = _normalize_text_for_matching(title)
    norm_target_title = _normalize_text_for_matching(t_name)
    norm_artist = _normalize_text_for_matching(artist_text)
    norm_target_artist = _normalize_text_for_matching(a_name)

    # ── Title ──────────────────────────────────────────────────────────
    title_sim = _get_similarity(norm_target_title, norm_title)
    # If the target title is fully contained (e.g. "Song (Remastered 2011)"),
    # treat it as a near-perfect match.
    if norm_target_title and norm_target_title in norm_title:
        title_sim = max(title_sim, 0.85)

    # ── Artist ─────────────────────────────────────────────────────────
    artist_sim = (
        _get_similarity(norm_target_artist, norm_artist) if a_name else 1.0
    )
    artist_in_title = bool(norm_target_artist) and norm_target_artist in norm_title
    effective_artist_sim = artist_sim
    if artist_in_title and artist_sim < 0.5:
        # Channel is the *uploader*, not the artist — title still carries
        # the artist name (very common for YouTube music uploads).
        effective_artist_sim = max(artist_sim, 0.75)

    # ── Song length ────────────────────────────────────────────────────
    duration_score = _score_duration(target_duration_ms, duration_sec)

    # ── Album ──────────────────────────────────────────────────────────
    album_sim = 0.0
    if collection_name and album:
        album_sim = _get_similarity(
            _normalize_text_for_matching(collection_name),
            _normalize_text_for_matching(album),
        )
    elif collection_name:
        # No album metadata — check if the album name appears in title/desc.
        norm_collection = _normalize_text_for_matching(collection_name)
        if norm_collection and (
            norm_collection in norm_title
            or norm_collection in _normalize_text_for_matching(description)
        ):
            album_sim = 0.5

    # ── Year ───────────────────────────────────────────────────────────
    year_score = 0.0
    if ye and upload_date:
        video_year = str(upload_date)[:4]
        if str(ye) == video_year:
            year_score = 1.0

    # ── Weighted total ─────────────────────────────────────────────────
    score = (
        title_sim * 0.35
        + effective_artist_sim * 0.25
        + duration_score * 0.20
        + album_sim * 0.10
        + year_score * 0.05
    )

    if is_official_channel:
        score += 0.03
    if artist_in_title:
        score += 0.02

    # Hard penalties for obvious mismatches
    if target_duration_ms and duration_sec:
        diff = abs(target_duration_ms / 1000.0 - float(duration_sec))
        if diff > 40:
            score -= 0.30  # Definitely a different recording
        elif diff > 25:
            score -= 0.10  # Likely a remix / extended version
    if title_sim < 0.35:
        score -= 0.20

    return score, title_sim, effective_artist_sim, duration_score


def _has_strong_title_artist_match(
    title: str,
    artist_text: str,
    target_title: str,
    target_artist: str,
) -> bool:
    """Fast pre-filter before scoring — normalized title + artist check."""
    norm_title = _normalize_text_for_matching(title)
    norm_target_title = _normalize_text_for_matching(target_title)

    if _get_similarity(norm_target_title, norm_title) < 0.55:
        # Allow containment (e.g. "Song (Official Video)" or "Song ft. X")
        if not (norm_target_title and norm_target_title in norm_title):
            return False

    if not target_artist:
        return True

    norm_artist = _normalize_text_for_matching(artist_text)
    norm_target_artist = _normalize_text_for_matching(target_artist)

    if _get_similarity(norm_target_artist, norm_artist) >= 0.5:
        return True
    # Artist appears inside the title — accept (YouTube-uploader case)
    if norm_target_artist in norm_title:
        return True
    return False


def _calculate_relevance_score(
    video_info: dict,
    t_name: str,
    a_name: str,
    collection_name: str,
    ye: str,
    target_duration_ms: int = 0,
) -> tuple[float, float, float, float]:
    """
    Wrapper around _score_candidate() for yt-dlp-style result dicts.
    Returns (score, title_sim, artist_sim, duration_score).
    """
    channel = video_info.get("channel", "") or ""
    uploader = video_info.get("uploader", "") or ""
    artist_text = f"{channel} {uploader}".strip()

    return _score_candidate(
        title=video_info.get("title", "") or "",
        artist_text=artist_text,
        album=video_info.get("album") or "",
        upload_date=video_info.get("upload_date", "") or "",
        duration_sec=video_info.get("duration", 0) or 0,
        description=video_info.get("description", "") or "",
        t_name=t_name,
        a_name=a_name,
        collection_name=collection_name,
        ye=ye,
        target_duration_ms=target_duration_ms,
        is_official_channel=_is_official_channel(channel, uploader, a_name),
    )


# ============================================================================
# yt-dlp search
# ============================================================================

def _build_search_ydl_opts(method: int, preferred_quality: int, use_proxy: bool = True) -> dict:
    """
    Build yt‑dlp options specifically for searching (extract info only).
    """
    opts = dict(COMMON_OPTS)
    opts["quiet"] = True
    opts["no_warnings"] = True
    opts["extract_flat"] = False  # Get full info
    opts["skip_download"] = True  # Don't download, just extract info
    opts.pop("sleep_interval", None)
    opts.pop("max_sleep_interval", None)
    opts.pop("sleep_interval_requests", None)

    cookies_path = _get_cookies_path()
    if cookies_path:
        opts["cookiefile"] = cookies_path

    opts["http_headers"] = _get_random_headers()

    has_deno = _check_deno()
    opts["proxy"] = PROXY if use_proxy else None

    # Same method-specific configurations as download
    if method == 8:
        opts["extractor_args"] = {"youtube": {"player_client": ["web"]}}
        if has_deno:
            opts["js_runtimes"] = {"deno": {}}
            opts["remote_components"] = ["ejs:github"]

    elif method == 2:
        opts["extractor_args"] = {"youtube": {"player_client": ["web"]}}
        if has_deno:
            opts["js_runtimes"] = {"deno": {}}
            opts["remote_components"] = ["ejs:npm"]

    elif method == 3:
        opts["extractor_args"] = {
            "youtube": {"player_client": ["web", "mweb", "android_vr"]}
        }
        if has_deno:
            opts["js_runtimes"] = {"deno": {}}
            opts["remote_components"] = ["ejs:github"]

    elif method == 4:
        opts["extractor_args"] = {"youtube": {"player_client": ["mweb"]}}

    elif method == 5:
        opts["extractor_args"] = {"youtube": {"player_client": ["android_vr"]}}

    elif method == 6:
        opts["extractor_args"] = {"youtube": {"player_client": ["web"]}}
        if has_deno:
            opts["js_runtimes"] = {"deno": {}}
            opts["remote_components"] = ["ejs:github"]

    elif method == 7:
        opts["extractor_args"] = {"youtube": {"player_client": ["mweb"]}}

    elif method == 1:
        opts["extractor_args"] = {"youtube": {"player_client": ["android"]}}
        opts["http_headers"]["User-Agent"] = (
            "Mozilla/5.0 (Linux; Android 12; SM-S906N Build/QP1A.190711.020) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36"
        )

    return opts


def _search_with_ytdlp(search_query: str, method: int, use_proxy: bool = True) -> list[dict]:
    """
    Search YouTube using yt-dlp with specific method.
    Returns the available video candidates for relevance ranking.
    """
    try:
        opts = _build_search_ydl_opts(method, 128, use_proxy=use_proxy)

        with yt_dlp.YoutubeDL(opts) as ydl:
            # Search query format for yt-dlp
            search_url = f"ytsearch5:{search_query}"
            info = ydl.extract_info(search_url, download=False)

            if info and "entries" in info and info["entries"]:
                return [entry for entry in info["entries"] if isinstance(entry, dict)]

    except Exception as e:
        logger.debug(f"Search method {method} failed: {e}")

    return []


# ============================================================================
# High-level search
# ============================================================================

async def search_youtube_track(
    t_name: str,
    a_name: str,
    collection_name: str,
    ye: str,
    target_duration_ms: int = 0,
) -> Optional[str]:
    """
    Search for a YouTube track using multiple methods (same as download).
    Returns video ID or None.
    """
    if OFFLINE_MODE:
        logger.info("Offline mode: skipping YouTube search")
        return None

    async with _YOUTUBE_RATE_LIMIT_LOCK:
        if time.monotonic() < _YOUTUBE_RATE_LIMIT_UNTIL:
            logger.warning("YouTube rate-limit cooldown is active; skipping search")
            return None

    # First try YTMusic as it's faster for searches
    for use_proxy in [bool(PROXY)]:
        try:
            loop = asyncio.get_event_loop()
            ytmusic_id = await loop.run_in_executor(
                None,
                _sync_search_youtube,
                t_name,
                a_name,
                collection_name,
                ye,
                target_duration_ms,
                use_proxy,
            )
            if ytmusic_id:
                logger.info(f"✅ YTMusic search successful (Proxy: {use_proxy}): {ytmusic_id}")
                return ytmusic_id
        except Exception as e:
            if _is_youtube_rate_limit_error(e):
                await _activate_youtube_cooldown()
                return None
            logger.debug(f"YTMusic search failed (Proxy: {use_proxy}): {e}")

    # Build search query
    search_query = f"{t_name} {a_name}".strip()
    if collection_name:
        search_query += f" {collection_name}"

    best_result = None
    best_score = -1.0
    best_title_sim = 0.0
    best_artist_sim = 0.0
    successful_methods = []

    # Try each method in order
    async with SEARCH_METHOD_ORDER_LOCK:
        current_order = list(SEARCH_METHOD_ORDER)

    for method in current_order:
        use_proxy = bool(PROXY)
        logger.debug(f"Searching with method {method} (Proxy: {use_proxy})")

        try:
            loop = asyncio.get_event_loop()
            results = await loop.run_in_executor(
                None, _search_with_ytdlp, search_query, method, use_proxy
            )

            for result in results:
                if not result.get("id"):
                    continue
                artist_text = (
                    f"{result.get('channel', '')} {result.get('uploader', '')}"
                )
                if not _has_strong_title_artist_match(
                    result.get("title", ""), artist_text, t_name, a_name
                ):
                    continue

                score, title_sim, artist_sim, duration_score = _calculate_relevance_score(
                    result, t_name, a_name, collection_name, ye, target_duration_ms
                )

                logger.debug(
                    "Method %s found %s (score: %.2f, title: %.2f, artist: %.2f, dur: %.2f)",
                    method,
                    result.get("title", "N/A"),
                    score,
                    title_sim,
                    artist_sim,
                    duration_score,
                )

                if score > best_score:
                    best_score = score
                    best_result = result.get("id")
                    best_title_sim = title_sim
                    best_artist_sim = artist_sim
                    successful_methods.append(method)

                    async with SEARCH_METHOD_ORDER_LOCK:
                        if method in SEARCH_METHOD_ORDER:
                            SEARCH_METHOD_ORDER.remove(method)
                            SEARCH_METHOD_ORDER.insert(0, method)

                    if score >= CONFIDENT_SEARCH_SCORE:
                        logger.info(
                            "Found confident match with method %s (score: %.2f)",
                            method,
                            score,
                        )
                        break

            if best_score >= CONFIDENT_SEARCH_SCORE:
                break

            # Random delay between methods to avoid rate limiting
            await asyncio.sleep(random.uniform(0.1, 0.3))

        except Exception as e:
            if _is_youtube_rate_limit_error(e):
                await _activate_youtube_cooldown()
                return None
            logger.debug(f"Search method {method} error: {e}")
            # Move failed method to the end
            async with SEARCH_METHOD_ORDER_LOCK:
                if method in SEARCH_METHOD_ORDER:
                    SEARCH_METHOD_ORDER.remove(method)
                    SEARCH_METHOD_ORDER.append(method)

    if best_result:
        # Title similarity check for the best result
        if best_score < 0.45 or best_title_sim < 0.55 or (
            a_name and best_artist_sim < 0.5
        ):
            logger.warning(
                f"Best match found but score too low "
                f"(score: {best_score:.2f}, title_sim: {best_title_sim:.2f}, "
                f"artist_sim: {best_artist_sim:.2f}): {t_name} - {a_name}"
            )
            return None

        logger.info(
            f"Search successful with methods: {successful_methods}, "
            f"best score: {best_score:.2f}, title_sim: {best_title_sim:.2f}"
        )
        return best_result
    else:
        logger.warning(f"No search results found for: {t_name} - {a_name}")
        return None


# ============================================================================
# YTMusic fallback search
# ============================================================================

_YT_PROXIED = None
_YT_DIRECT = None


def _sync_search_youtube(
    t_name: str,
    a_name: str,
    collection_name: str,
    ye: str,
    target_duration_ms: int = 0,
    use_proxy: bool = True,
) -> Optional[str]:
    """
    Original YTMusic search as fallback.
    """
    global _YT_PROXIED, _YT_DIRECT

    if use_proxy and PROXY:
        if _YT_PROXIED is None:
            _YT_PROXIED = YTMusic(proxies={"https": PROXY, "http": PROXY})
        yt = _YT_PROXIED
    else:
        if _YT_DIRECT is None:
            _YT_DIRECT = YTMusic()
        yt = _YT_DIRECT

    search_query = f"{t_name} {a_name} {collection_name}".strip()

    try:
        results = yt.search(search_query, filter="songs", limit=10)

        if not results or not isinstance(results, list):
            return None

        best_match_id = None
        highest_score = -1.0
        best_title_sim = 0.0
        best_artist_sim = 0.0
        best_duration_score = 0.0

        for res in results:
            res_title = res.get("title", "") or ""
            artists = res.get("artists", [])
            res_artist = (
                ", ".join([a.get("name", "") for a in artists]) if artists else ""
            )
            album_data = res.get("album") or {}
            res_album = album_data.get("name", "") or ""
            res_year = res.get("year", "") or ""
            duration_sec = res.get("duration_seconds", 0) or 0

            if not _has_strong_title_artist_match(
                res_title, res_artist, t_name, a_name
            ):
                continue

            # YTMusic "songs" filter returns official entries by default.
            is_official = True

            score, title_sim, artist_sim, duration_score = _score_candidate(
                title=res_title,
                artist_text=res_artist,
                album=res_album,
                upload_date=str(res_year)[:4] if res_year else "",
                duration_sec=duration_sec,
                description="",
                t_name=t_name,
                a_name=a_name,
                collection_name=collection_name,
                ye=ye,
                target_duration_ms=target_duration_ms,
                is_official_channel=is_official,
            )

            if score > highest_score:
                highest_score = score
                best_match_id = res.get("videoId")
                best_title_sim = title_sim
                best_artist_sim = artist_sim
                best_duration_score = duration_score

        if best_match_id:
            if (
                highest_score < 0.45
                or best_title_sim < 0.55
                or (a_name and best_artist_sim < 0.5)
            ):
                logger.warning(
                    "YTMusic best match score too low "
                    "(score: %.2f, title_sim: %.2f, artist_sim: %.2f, dur: %.2f)",
                    highest_score,
                    best_title_sim,
                    best_artist_sim,
                    best_duration_score,
                )
                return None

        return best_match_id

    except Exception as e:
        logger.error(f"YTMusic search error: {e}")

    return None


def get_artist_image(artist_name):
    """Get artist image from YTMusic with improved error handling"""
    global _YT_PROXIED, _YT_DIRECT

    for use_proxy in [bool(PROXY)]:
        try:
            if use_proxy and PROXY:
                if _YT_PROXIED is None:
                    _YT_PROXIED = YTMusic(proxies={"https": PROXY, "http": PROXY})
                yt = _YT_PROXIED
            else:
                if _YT_DIRECT is None:
                    _YT_DIRECT = YTMusic()
                yt = _YT_DIRECT

            search_results = yt.search(artist_name, filter="artists", limit=1)
            if not search_results or not isinstance(search_results, list):
                continue

            artist_id = search_results[0].get("browseId")
            if not artist_id:
                continue

            artist_info = yt.get_artist(artist_id)
            if not artist_info or not isinstance(artist_info, dict):
                continue

            thumbnails = artist_info.get("thumbnails")
            if thumbnails and isinstance(thumbnails, list) and len(thumbnails) > 0:
                # thumbnails are usually sorted by size, but we'll try to find the one
                # with highest resolution or just take the first one which is standard
                # for get_artist
                return thumbnails[-1].get("url")

        except Exception as e:
            logger.error(f"YTMusic get_artist_image error for '{artist_name}': {e}")

    return None


# ============================================================================
# Download
# ============================================================================

async def download_audio(
    url: str,
    output_dir: Optional[str] = None,
    *,
    max_retries_per_method: int = 1,
    quality: int = 128,
    progress_callback: Optional[Callable[[float], None]] = None,
) -> Optional[str]:
    """
    Download YouTube audio as MP3.
    """
    preferred_quality = quality
    url = _normalize_url(url)

    if output_dir is None:
        base_dir = os.path.join(os.getcwd(), "downloads")
    else:
        base_dir = output_dir
    os.makedirs(base_dir, exist_ok=True)

    unique_id = uuid.uuid4().hex
    unique_dir = os.path.join(base_dir, unique_id)
    os.makedirs(unique_dir, exist_ok=True)

    logger.info("Starting download: %s", url)
    logger.info("Unique output directory: %s", unique_dir)

    before = set(Path(unique_dir).glob("*.mp3"))
    loop = asyncio.get_event_loop()

    async with METHOD_ORDER_LOCK:
        current_order = list(METHOD_ORDER)

    for method in current_order:
        for attempt in range(1, max_retries_per_method + 1):
            use_proxy = bool(PROXY)
            logger.info(
                "▶ Try Method %d (Attempt %d, Proxy: %s)", method, attempt, use_proxy
            )
            try:
                opts = _build_opts(
                    method, unique_dir, preferred_quality, use_proxy=use_proxy
                )
                if progress_callback:

                    def report_progress(status: dict) -> None:
                        percent = _download_progress_percent(status)
                        if percent is not None:
                            progress_callback(percent)

                    opts["progress_hooks"] = [report_progress]

                def run_ydl():
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        ydl.download([url])

                async with YOUTUBE_REQUEST_SEMAPHORE:
                    await loop.run_in_executor(None, run_ydl)

            except Exception as exc:
                logger.warning("Method %d failed: %s", method, exc)
                if _is_youtube_rate_limit_error(exc):
                    await _activate_youtube_cooldown()
                    logger.error(
                        "YouTube rate limit detected; stopping fallback methods for this download"
                    )
                    break
                async with METHOD_ORDER_LOCK:
                    if method in METHOD_ORDER:
                        METHOD_ORDER.remove(method)
                        METHOD_ORDER.append(method)

                await asyncio.sleep(random.uniform(0.5, 1.0))
                continue

            after = set(Path(unique_dir).glob("*.mp3"))
            new_files = after - before
            if new_files:
                mp3_path = max(new_files, key=lambda p: p.stat().st_mtime)
                size_mb = mp3_path.stat().st_size / (1024 * 1024)
                logger.info(
                    "✅ Success with method %d → %s (%.1f MB)",
                    method,
                    mp3_path.name,
                    size_mb,
                )

                async with METHOD_ORDER_LOCK:
                    if method in METHOD_ORDER:
                        METHOD_ORDER.remove(method)
                        METHOD_ORDER.insert(0, method)

                return str(mp3_path)
            else:
                logger.warning(
                    "Method %d completed but no MP3 found – retrying…", method
                )
                await asyncio.sleep(random.uniform(0.3, 0.7))

    try:
        shutil.rmtree(unique_dir, ignore_errors=True)
    except Exception:
        pass
    msg = f"❌ All download methods failed for: {url}"
    logger.error(msg)
    raise Exception(msg)


def _is_youtube_rate_limit_error(error: BaseException) -> bool:
    message = str(error).lower()
    return (
        "rate-limited" in message
        or "rate limit" in message
        or "too many requests" in message
    )


def _download_progress_percent(status: dict) -> Optional[float]:
    if status.get("status") != "downloading":
        return None
    total = status.get("total_bytes") or status.get("total_bytes_estimate")
    downloaded = status.get("downloaded_bytes")
    if not total or downloaded is None:
        return None
    return min(100.0, max(0.0, downloaded * 100.0 / total))


async def _activate_youtube_cooldown() -> None:
    global _YOUTUBE_RATE_LIMIT_UNTIL
    global _YOUTUBE_RATE_LIMIT_TRIGGERED
    async with _YOUTUBE_RATE_LIMIT_LOCK:
        _YOUTUBE_RATE_LIMIT_UNTIL = max(
            _YOUTUBE_RATE_LIMIT_UNTIL,
            time.monotonic() + YOUTUBE_RATE_LIMIT_COOLDOWN,
        )
        _YOUTUBE_RATE_LIMIT_TRIGGERED = True


def youtube_rate_limit_triggered() -> bool:
    return _YOUTUBE_RATE_LIMIT_TRIGGERED


def _normalize_url(url: str) -> str:
    """Convert youtu.be short links to full youtube.com/watch?v= URLs."""
    m = re.search(r"youtu\.be/([a-zA-Z0-9_-]+)", url)
    if m:
        vid = m.group(1).split("?")[0]
        return f"https://www.youtube.com/watch?v={vid}"
    return url


def _build_opts(
    method: int, output_dir: str, preferred_quality: int, use_proxy: bool = True
) -> dict:
    """
    Build yt‑dlp options dict for the given method number (1‑8).
    """
    opts = dict(COMMON_OPTS)
    opts["outtmpl"] = f"{output_dir}/%(title)s.%(ext)s"
    opts["format"] = "bestaudio/best"

    cookies_path = _get_cookies_path()
    if cookies_path:
        opts["cookiefile"] = cookies_path
        logger.debug(f"Using cookies from: {cookies_path}")
    else:
        logger.debug("No cookies.txt found, proceeding without cookies")

    opts["postprocessors"] = [
        {
            **AUDIO_POSTPROCESSOR,
            "preferredquality": str(preferred_quality),
        }
    ]

    has_deno = _check_deno()
    opts["proxy"] = PROXY if use_proxy else None

    opts["http_headers"] = _get_random_headers()

    if method == 8:
        opts["extractor_args"] = {"youtube": {"player_client": ["web"]}}
        if has_deno:
            opts["js_runtimes"] = {"deno": {}}
            opts["remote_components"] = ["ejs:github"]

    elif method == 2:
        opts["extractor_args"] = {"youtube": {"player_client": ["web"]}}
        if has_deno:
            opts["js_runtimes"] = {"deno": {}}
            opts["remote_components"] = ["ejs:npm"]

    elif method == 3:
        opts["extractor_args"] = {
            "youtube": {"player_client": ["web", "mweb", "android_vr"]}
        }
        if has_deno:
            opts["js_runtimes"] = {"deno": {}}
            opts["remote_components"] = ["ejs:github"]

    elif method == 4:
        opts["extractor_args"] = {"youtube": {"player_client": ["mweb"]}}

    elif method == 5:
        opts["extractor_args"] = {"youtube": {"player_client": ["android_vr"]}}

    elif method == 6:
        opts["extractor_args"] = {"youtube": {"player_client": ["web"]}}
        if has_deno:
            opts["js_runtimes"] = {"deno": {}}
            opts["remote_components"] = ["ejs:github"]

    elif method == 7:
        opts["extractor_args"] = {"youtube": {"player_client": ["mweb"]}}

    elif method == 1:
        opts["extractor_args"] = {"youtube": {"player_client": ["android"]}}
        opts["http_headers"]["User-Agent"] = (
            "Mozilla/5.0 (Linux; Android 12; SM-S906N Build/QP1A.190711.020) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36"
        )

    return opts
