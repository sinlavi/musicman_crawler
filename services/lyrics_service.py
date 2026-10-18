import asyncio
import random
from ytmusicapi import YTMusic
from core.config import PROXY
import os
import logging
from concurrent.futures import ThreadPoolExecutor
from crawlers.youtube import search_youtube_track
from pathlib import Path
import http.cookiejar

logger = logging.getLogger("ABRAAVA:LYRICS_SERVICE")

def _load_cookies_as_header(cookie_file):
    """Load Netscape cookies.txt and return a Cookie header string."""
    try:
        if not os.path.exists(cookie_file):
            return None
        cj = http.cookiejar.MozillaCookieJar(cookie_file)
        cj.load(ignore_discard=True, ignore_expires=True)
        cookies = []
        for cookie in cj:
            cookies.append(f"{cookie.name}={cookie.value}")
        return "; ".join(cookies)
    except Exception as e:
        logger.error(f"Error loading cookies from {cookie_file}: {e}")
        return None

class LyricsService:
    def __init__(self):
        cookies_path = "cookies.txt"
        cookie_header = _load_cookies_as_header(cookies_path)

        self.ytm_proxied = YTMusic(proxies={"https": PROXY, "http": PROXY})
        self.ytm_direct = YTMusic()

        if cookie_header:
            logger.info(f"Adding Cookie header from: {cookies_path}")
            self.ytm_proxied.headers["Cookie"] = cookie_header
            self.ytm_direct.headers["Cookie"] = cookie_header

        self._executor = ThreadPoolExecutor(max_workers=5)

    async def get_lyrics(self, track_id, title, artist, album=None, duration_ms=0):
        """
        Fetch lyrics from LRCLIB, then YouTube Music as a fallback.
        """
        track_id = str(track_id)
        logger.info(f"Retrieving lyrics for: {title} - {artist} (ID: {track_id})")

        logger.info(f"Trying LRCLIB: {title} - {artist}")
        lyrics_dict = {}
        try:
            lyrics_dict = await self._fetch_from_lrclib(title, artist, album, duration_ms) or {}
        except Exception as e:
            logger.warning(f"Error fetching from LRCLIB for {track_id}: {e}")

        # YouTube Music fallback
        if not lyrics_dict or (not lyrics_dict.get("synced") and not lyrics_dict.get("plain")):
            logger.info(f"LRCLIB returned no lyrics, trying YTMusic: {title} - {artist}")
            try:
                lyrics_dict = await self._fetch_from_ytmusic(track_id, title, artist) or {}
            except Exception as e:
                logger.warning(f"Error fetching from YTMusic for {track_id}: {e}")

        if not lyrics_dict or (not lyrics_dict.get("synced") and not lyrics_dict.get("plain")):
            logger.info(f"No lyrics found for {track_id}. Using placeholder.")
            lyrics_dict = {"synced": None, "plain": "Instrumental/Not found"}

        logger.info(f"Lyrics successfully determined for {track_id}")
        return lyrics_dict

    async def _fetch_from_lrclib(self, title, artist, album=None, duration_ms=0):
        try:
            from core.http_client import HttpClient

            # 1. Try exact match with duration (best for accuracy)
            params = {"track_name": title, "artist_name": artist}
            if album: params["album_name"] = album
            if duration_ms: params["duration"] = int(duration_ms / 1000)

            url = "https://lrclib.net/api/get"
            data, status, is_tech_err = await HttpClient.request_with_methods("GET", url, params=params)

            if status == 200 and data:
                if data.get("instrumental"):
                    return {"synced": "Instrumental", "plain": "Instrumental"}
                return {"synced": data.get("syncedLyrics"), "plain": data.get("plainLyrics")}
            elif is_tech_err:
                msg = f"Technical error in LRCLIB direct get (Status: {status})"
                logger.error(msg)
                raise Exception(msg)

            # 2. Try search if direct get returns 404
            search_url = "https://lrclib.net/api/search"
            search_params = {"track_name": title, "artist_name": artist}
            if album: search_params["album_name"] = album

            data, status, is_tech_err = await HttpClient.request_with_methods("GET", search_url, params=search_params)

            results = data if status == 200 and data else []
            if is_tech_err:
                msg = f"Technical error in LRCLIB search (Status: {status})"
                logger.error(msg)
                raise Exception(msg)

            # Fallback 1: Try without album if album was provided and no results
            if not results and album:
                logger.info(f"LRCLIB search with album failed, trying without album: {title} - {artist}")
                no_album_params = {"track_name": title, "artist_name": artist}
                data, status, is_tech_err = await HttpClient.request_with_methods("GET", search_url, params=no_album_params)
                results = data if status == 200 and data else []
                if is_tech_err:
                    msg = f"Technical error in LRCLIB search no-album (Status: {status})"
                    logger.error(msg)
                    raise Exception(msg)

            # Fallback 2: General q search
            if not results:
                general_params = {"q": f"{title} {artist}"}
                data, status, is_tech_err = await HttpClient.request_with_methods("GET", search_url, params=general_params)
                results = data if status == 200 and data else []
                if is_tech_err:
                    msg = f"Technical error in LRCLIB general search (Status: {status})"
                    logger.error(msg)
                    raise Exception(msg)

            if results:
                    best_score = -1

                    target_sec = duration_ms / 1000 if duration_ms else 0

                    for res in results:
                        score = 0
                        if res.get("syncedLyrics"): score += 10
                        if res.get("plainLyrics"): score += 5

                        # Duration matching
                        res_dur = res.get("duration", 0)
                        if target_sec and res_dur:
                            diff = abs(target_sec - res_dur)
                            if diff < 2: score += 10
                            elif diff < 5: score += 5
                            elif diff > 10: score -= 5

                        if score > best_score:
                            best_score = score
                            best_match = res
                            if score >= 20: break # Good enough match

                    if best_match:
                        if best_match.get("instrumental"):
                            return {"synced": "Instrumental", "plain": "Instrumental"}
                        return {"synced": best_match.get("syncedLyrics"), "plain": best_match.get("plainLyrics")}
            return {} # Not found
        except Exception as e:
            logger.error(f"Error fetching lyrics from LRCLIB: {type(e).__name__}: {e}")
            return None # None indicates technical error

    async def _fetch_from_ytmusic(self, track_id, title, artist):
        track_id = str(track_id)
        video_id = None
        if track_id.startswith("yt_"):
            video_id = track_id[3:]
        else:
            # Search for the track on YouTube
            video_id = await search_youtube_track(title, artist, "", "")

        if not video_id:
            logger.warning(f"Could not find YouTube video for {title} - {artist}")
            return {}

        from core.config import USER_AGENTS
        uas = list(USER_AGENTS)
        random.shuffle(uas)

        last_error = None
        for i, ua in enumerate(uas):
            try:
                use_proxy = (i % 2 == 0) if PROXY else False
                ytm = self.ytm_proxied if use_proxy else self.ytm_direct

                ytm.headers["User-Agent"] = ua
                loop = asyncio.get_event_loop()

                # Get watch playlist to find lyrics browse ID
                watch_playlist = await loop.run_in_executor(
                    self._executor,
                    lambda: ytm.get_watch_playlist(video_id)
                )

                lyrics_browse_id = watch_playlist.get('lyrics')
                if not lyrics_browse_id:
                    logger.info(f"No lyrics found for {title} - {artist} (Video ID: {video_id})")
                    return {}

                # Fetch the actual lyrics
                lyrics_data = await loop.run_in_executor(
                    self._executor,
                    lambda: ytm.get_lyrics(lyrics_browse_id)
                )

                return {"synced": None, "plain": lyrics_data.get('lyrics')} if lyrics_data.get('lyrics') else {}
            except Exception as e:
                logger.debug(f"YTMusic lyrics method {i+1} failed (Proxy: {use_proxy}): {e}")
                last_error = e
                await asyncio.sleep(0.1)

        logger.error(f"All 8 methods failed for YTMusic lyrics: {last_error}")
        return None # Technical error

lyrics_service = LyricsService()
