import asyncio
import json
import hashlib
import time
import random
import re
from typing import Optional, Dict, Any, Literal, List, Union, Tuple
from pathlib import Path
import aiosqlite

from core.config import ITUNES_BASE_URL, OFFLINE_MODE, PROXY, API_TOKEN, TELEGRAM_TOKEN
from core.logger import logger
from core.http_client import HttpClient
from services.telegram_service import TelegramUploadService


def _is_unresolved_telegram_url(url: str) -> bool:
    return bool(re.search(
        r"^https://api\.telegram\.org/file/bot[^/]+/\d+$",
        str(url),
        flags=re.IGNORECASE,
    ))


def _telegram_message_id(url: str) -> Optional[str]:
    match = re.search(
        r"^https://api\.telegram\.org/file/bot[^/]+/(\d+)$",
        str(url),
        flags=re.IGNORECASE,
    )
    return match.group(1) if match else None


class iTunesSQLiteCache:
    def __init__(self, db_path: str = "cache/itunes_cache.db", ttl_seconds: int = 4 * 3600):
        self.db_path = db_path
        self.ttl_seconds = ttl_seconds
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._db: Optional[aiosqlite.Connection] = None
        self._lock = asyncio.Lock()

    async def _get_db(self) -> aiosqlite.Connection:
        async with self._lock:
            if self._db is None:
                self._db = await aiosqlite.connect(self.db_path)
                await self._db.execute(
                    "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, response TEXT, timestamp REAL)"
                )
                await self._db.commit()
            return self._db

    def _get_cache_key(self, endpoint: str, params: dict) -> str:
        key_data = f"{endpoint}:{json.dumps(params, sort_keys=True)}"
        return hashlib.md5(key_data.encode()).hexdigest()

    async def get(self, endpoint: str, params: dict) -> Optional[Dict[str, Any]]:
        cache_key = self._get_cache_key(endpoint, params)
        try:
            db = await self._get_db()
            async with db.execute("SELECT response, timestamp FROM cache WHERE key = ?", (cache_key,)) as cursor:
                row = await cursor.fetchone()
                if row:
                    response_json, timestamp = row
                    if time.time() - timestamp > self.ttl_seconds:
                        await db.execute("DELETE FROM cache WHERE key = ?", (cache_key,))
                        await db.commit()
                        return None
                    return json.loads(response_json)
        except Exception as e:
            logger.error(f"Error reading from SQLite cache: {e}")
        return None

    async def set(self, endpoint: str, params: dict, response: Dict[str, Any]):
        cache_key = self._get_cache_key(endpoint, params)
        try:
            db = await self._get_db()
            await db.execute(
                "INSERT OR REPLACE INTO cache (key, response, timestamp) VALUES (?, ?, ?)",
                (cache_key, json.dumps(response), time.time())
            )
            await db.commit()
        except Exception as e:
            logger.error(f"Error writing to SQLite cache: {e}")

    async def close(self):
        if self._db:
            await self._db.close()
            self._db = None


_itunes_cache = iTunesSQLiteCache()

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]


async def fetch_itunes(endpoint: str, params: dict = None, bypass_cache: bool = False,
                       method: Literal["GET", "POST", "PUT", "DELETE"] = "GET", payload: dict = None,
                       official: bool = False, quality: str = None,
                       http_max_attempts: Optional[int] = None) -> Optional[Dict[str, Any]]:
    params = params or {}
    if quality: params["quality"] = quality

    # Exclude download queue from cache to prevent re-processing same items
    can_cache = method == "GET" and not any(endpoint.startswith(p) for p in ["download", "mirror"])

    if can_cache and not bypass_cache and not OFFLINE_MODE:
        cached = await _itunes_cache.get(endpoint, params)
        if cached: return cached

    if OFFLINE_MODE: return None

    api_path = f"/{endpoint}" if not endpoint.startswith("/") else endpoint
    url = f"{ITUNES_BASE_URL}{api_path}"

    headers = {
        "Authorization": f"Bearer {API_TOKEN}"
    }
    logger.info(f"3rah Request [{method}]: {url} - Params: {params}")

    # Use multi-method request for better reliability
    data, status, is_tech_err = await HttpClient.request_with_methods(
        method, url, params=params, json=payload, headers=headers, use_proxy=False,
        max_attempts=http_max_attempts
    )

    if status == 200 and data:
        if isinstance(data, bytes):
            text = data.decode("utf-8", errors="replace")
        
            logger.error(f"3rah RAW RESPONSE ({status}): {repr(text[:500])}")
        
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                logger.error("3rah returned invalid JSON")
                return {
                    "success": False,
                    "error": "Invalid JSON response",
                    "raw": text[:500]
                }
        if can_cache:
            await _itunes_cache.set(endpoint, params, data)
        return data
        

    if is_tech_err:
        details = ""
        if isinstance(data, dict):
            details = f" body={data}"
        elif isinstance(data, (str, bytes)):
            details = f" body={str(data)[:1000]}"
        logger.error(
            f"3rah fetch failed with technical error: {status} for {url}{details}")
        # Returning None indicates technical error (consistent with design)
        return None

    logger.warning(f"3rah fetch returned status {status} (Not Found?) for {url}")
    return {"success": False, "status": status}


async def search_itunes(term: str, entity: Optional[str] = None, limit: int = 50, official: bool = False, quality: str = None) -> Optional[
    Dict[str, Any]]:
    return await fetch_itunes("search",
                              {"term": term, "media": "music", "limit": limit, "entity": entity} if entity else {
                                  "term": term, "media": "music", "limit": limit}, official=official, quality=quality)


async def lookup_itunes(id: Union[int, str], entity: Optional[str] = None, bypass_cache: bool = False,
                        official: bool = False, quality: str = None) -> Optional[Dict[str, Any]]:
    return await fetch_itunes("lookup", {"id": id, "entity": entity} if entity else {"id": id},
                              bypass_cache=bypass_cache, official=official, quality=quality)


async def set_mirror(entity_type: str, entity_id: Union[int, str], url_type: str, mirror_url: str,
                     quality: str = None, max_retries: int = 3,
                     source: str = None) -> Optional[Dict[str, Any]]:
    if source and source.lower() == "telegram":
        mirror_url = re.sub(
            r"(https://api\.telegram\.org/file/bot)[^/]+(/)",
            r"\1<token>\2",
            mirror_url,
            flags=re.IGNORECASE,
        )
    payload = {"entityType": entity_type, "entityId": str(entity_id), "urlType": url_type, "mirrorUrl": mirror_url}
    if quality: payload["quality"] = quality
    if source: payload["source"] = source
    logger.info(f"Setting mirror: {entity_type} {entity_id} {url_type} -> {mirror_url} ({quality})")

    for attempt in range(1, max_retries + 1):
        try:
            # Retry this write here, but avoid the HTTP client's long generic
            # retry sequence. Mirror writes are already bounded and idempotent.
            result = await fetch_itunes(
                "mirror/set", method="POST", payload=payload, http_max_attempts=1)
            if result and result.get("success"):
                logger.info(f"Mirror set successful for {entity_id} ({url_type}, quality: {quality}), refreshing cache...")
                await lookup_itunes(entity_id, entity=entity_type, bypass_cache=True, quality=quality)
                return result
            duplicate_error = str(result.get("error", "")).lower() if result else ""
            if result and (
                    "duplicate" in duplicate_error
                    and "mirror" in duplicate_error):
                logger.info(
                    f"Mirror already exists for {entity_id} "
                    f"({url_type}, quality: {quality}); treating as success")
                try:
                    await lookup_itunes(
                        entity_id, entity=entity_type, bypass_cache=True,
                        quality=quality)
                except Exception as refresh_error:
                    logger.warning(
                        f"Unable to refresh duplicate mirror cache for "
                        f"{entity_id}: {refresh_error}")
                return {**result, "success": True, "duplicate": True}
            logger.warning(f"set_mirror attempt {attempt}/{max_retries} failed for {entity_id}: {result}")
        except Exception as e:
            logger.warning(f"set_mirror attempt {attempt}/{max_retries} exception for {entity_id}: {e}")

        if attempt < max_retries:
            await asyncio.sleep(0.5 * attempt)

    logger.error(f"set_mirror failed after {max_retries} attempts for {entity_id}")
    return None


async def get_attachments(entity_type: str, entity_id: Union[int, str], quality: str = None) -> Optional[
    Dict[str, Any]]:
    logger.info(f"Fetching attachments for {entity_type} {entity_id} ({quality})")
    # New 3rah API: attachments are included in lookup response
    data = await lookup_itunes(entity_id, entity=entity_type, quality=quality)
    if data and data.get("results"):
        entity = data["results"][0]
        return entity.get("attachments")
    return None


async def get_cached_audio(track_id: Union[int, str], quality: str = None,
                           source: str = "bale", api_client=None) -> Optional[str]:
    attachments = await get_attachments('track', track_id, quality=quality or "192")
    if attachments and attachments.get('audioUrls'):
        for audio in attachments['audioUrls']:
            audio_source = str(audio.get('source', '')).lower()
            telegram_metadata = any(audio.get(key) for key in (
                "telegramFilePath", "telegramFileId", "telegramFileUrl"))
            if (str(audio.get('quality')) != str(quality or "192")
                    or (audio_source != source.lower()
                        and not (source.lower() == "telegram" and telegram_metadata))):
                continue
            if source.lower() == "telegram" and TELEGRAM_TOKEN:
                file_path = audio.get("telegramFilePath")
                if file_path:
                    return f"https://api.telegram.org/file/bot{TELEGRAM_TOKEN}/{file_path}"
                file_id = audio.get("telegramFileId")
                if file_id:
                    try:
                        telegram = TelegramUploadService()
                        info = await telegram.file_info(str(file_id))
                        if api_client and audio.get("telegramMessageId"):
                            await api_client.save_messenger_file(
                                "telegram", str(track_id), info["file_id"],
                                str(audio["telegramMessageId"]), str(quality or "192"),
                                str(audio.get("telegramFilename") or ""), info["file_path"])
                        return f"https://api.telegram.org/file/bot{TELEGRAM_TOKEN}/{info['file_path']}"
                    except RuntimeError as error:
                        logger.warning(
                            f"Unable to resolve Telegram file for {track_id}: {error}")
                        # A URL ending in the Telegram message id is not a
                        # downloadable file URL. Do not retry a known-stale
                        # mirror and turn it into repeated HTTP 404 failures.
                        if _is_unresolved_telegram_url(
                                str(audio.get("telegramFileUrl") or audio.get("url") or "")):
                            message_id = _telegram_message_id(
                                str(audio.get("telegramFileUrl") or audio.get("url") or ""))
                            if message_id:
                                try:
                                    telegram = TelegramUploadService()
                                    info = await telegram.file_info_from_message_id(message_id)
                                    if api_client:
                                        await api_client.save_messenger_file(
                                            "telegram", str(track_id), info["file_id"],
                                            message_id, str(quality or "192"),
                                            str(audio.get("telegramFilename") or ""), info["file_path"])
                                    return f"https://api.telegram.org/file/bot{TELEGRAM_TOKEN}/{info['file_path']}"
                                except RuntimeError as resolve_error:
                                    logger.warning(
                                        f"Unable to resolve Telegram message {message_id} "
                                        f"for {track_id}: {resolve_error}")
            if source.lower() == "bale":
                bale_file_id = audio.get("baleFileId")
                if bale_file_id:
                    logger.info(f"Cached Bale file found for {track_id}: {bale_file_id}")
                    return str(bale_file_id)
            url = audio.get("telegramFileUrl") or audio.get('url')
            if url:
                if source.lower() == "bale" and str(url).startswith("bale://"):
                    logger.warning(
                                f"Skipping Bale mirror without file ID for {track_id}: {url}")
                    continue
                if source.lower() == "telegram" and _is_unresolved_telegram_url(str(url)):
                    message_id = _telegram_message_id(str(url))
                    if message_id:
                        try:
                            telegram = TelegramUploadService()
                            info = await telegram.file_info_from_message_id(message_id)
                            if api_client:
                                await api_client.save_messenger_file(
                                    "telegram", str(track_id), info["file_id"],
                                    message_id, str(quality or "192"),
                                    str(audio.get("telegramFilename") or ""), info["file_path"])
                            return f"https://api.telegram.org/file/bot{TELEGRAM_TOKEN}/{info['file_path']}"
                        except RuntimeError as resolve_error:
                            logger.warning(
                                f"Unable to resolve Telegram message {message_id} "
                                f"for {track_id}: {resolve_error}")
                    continue
                logger.info(f"Cached audio found for {track_id}: {url}")
                return url
    logger.info(f"No cached audio for {track_id} with quality {quality or '192'}")
    return None


async def get_download_queue(status: str = "pending", limit: int = 60) -> Optional[Dict[str, Any]]:
    logger.info(f"Fetching download queue with status: {status}")
    return await fetch_itunes("download/queue", params={"status": status, "limit": limit})


async def update_download_status(download_id: int, status: str, error_message: str = None, percent: int = None) -> Optional[Dict[str, Any]]:
    logger.info(f"Updating download {download_id} to status: {status} ({percent}%)")
    payload = {"id": download_id, "status": status}
    if error_message:
        payload["errorMessage"] = error_message
    if percent is not None:
        payload["percent"] = percent
    return await fetch_itunes("download/update", method="POST", payload=payload)


async def reset_stuck_downloads() -> Optional[Dict[str, Any]]:
    logger.info("Resetting stuck downloads (downloading -> pending)")
    return await fetch_itunes("download/update", method="POST", payload={"filterStatus": "downloading", "status": "pending"})
