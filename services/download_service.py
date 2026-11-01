from services.lyrics_service import lyrics_service
from services.telegram_service import TelegramUploadService
import asyncio
import os
import shutil
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Optional, Union, List
from core.logger import logger
from core.config import OFFLINE_MODE, DEFAULT_QUALITY, YOUTUBE_CONCURRENCY
from core.http_client import HttpClient
from crawlers.utils import get_track
from crawlers.youtube import search_youtube_track, download_audio
from crawlers.itunes import get_cached_audio, set_mirror, update_download_status
from utils.audio_utils import convert_bitrate
from utils.helpers import get_high_res_artwork
from utils.messages import send_message, edit_message, safe_delete


def _is_file_too_large_error(err: Exception) -> bool:
    err_str = str(err).lower()
    large_keywords = ["file is too large", "file_too_large", "request entity too large", "413"]
    return any(keyword in err_str for keyword in large_keywords)


def _bale_upload_ids(response):
    """Extract message and audio IDs from the response variants Bale returns."""
    if not response:
        return None, None
    if isinstance(response, dict) and isinstance(response.get("result"), dict):
        response = response["result"]

    def value(data, *keys):
        if isinstance(data, dict):
            for key in keys:
                if data.get(key) is not None:
                    return data[key]
        else:
            for key in keys:
                item = getattr(data, key, None)
                if item is not None:
                    return item
        return None

    message_id = value(response, "message_id", "messageId", "id")
    media = value(response, "audio", "document", "file")
    file_id = value(media, "file_id", "fileId", "id") or value(
        response, "file_id", "fileId", "audio_id", "audioId")
    return file_id, message_id


def _telegram_mirror_url(message_id: object) -> str:
    return f"https://api.telegram.org/file/bot<token>/{message_id}"


def _needs_192_copy(duration_sec: Optional[int]) -> bool:
    return duration_sec is not None and duration_sec > 8 * 60


class DownloadService:
    def __init__(self, bot, api_client, artwork_service,
                 tagging_service, error_notifier):
        self.bot = bot
        self.api_client = api_client
        self.artwork_service = artwork_service
        self.tagging_service = tagging_service
        self.error_notifier = error_notifier
        self.download_semaphore = asyncio.Semaphore(YOUTUBE_CONCURRENCY)
        self.telegram = TelegramUploadService()

    async def _send_bale_audio(self, chat_id, path: str, title: str,
                               duration: Optional[int], performer: str,
                               artwork: Optional[bytes] = None):
        """Send audio with metadata omitted by Balethon's high-level wrapper."""
        resolved_chat_id = await self.bot.resolve_peer_id(chat_id)
        thumbnail = TelegramUploadService._prepare_thumbnail(artwork)
        if artwork and not thumbnail:
            logger.warning("Artwork bytes could not be converted to Bale thumbnail")
        with open(path, "rb") as audio:
            payload = {
                "chat_id": resolved_chat_id,
                "audio": audio,
                "title": title,
                "duration": duration,
                "performer": performer,
            }
            if thumbnail:
                payload["thumb"] = BytesIO(thumbnail)
                payload["thumb"].name = "cover.jpg"
            result = await self.bot.execute("post", "sendAudio", **payload)
            return result

    async def _update_status(self, chat_id, status_msg, text, status_prefix="", is_batch=False, silent=False):
        if silent:
            return status_msg

        if status_prefix:
            full_text = f"{status_prefix}\n\n{text}"
        else:
            full_text = text

        if status_msg:
            await edit_message(status_msg, full_text)
            return status_msg
        return await send_message(self.bot, chat_id, full_text)

    async def download_and_send_track(self, chat_id, track_id, user_id, status_msg=None,
                                      is_batch=False, album_cover_bytes=None, collection_id=None,
                                      selected_quality=None, track_name_hint=None, track_index=None,
                                      status_prefix="", skip_size_check=True,
                                      silent=False, download_id=None,
                                      telegram_file_path=None, telegram_file=None):

        # If no status_msg provided, use the first update to create it to avoid redundant send/delete
        if status_msg is None:
            prefix = f"({track_index}) " if track_index else ""
            hint = f" {track_name_hint}" if track_name_hint else ""
            initial_text = f"🔍 *{prefix}در حال دریافت اطلاعات آهنگ{hint}...*"
            status_msg = await self._update_status(chat_id, status_msg, initial_text, status_prefix,
                                                   is_batch, silent=silent)
        else:
            status_msg = await self._update_status(chat_id, status_msg, "🔍 *در حال دریافت اطلاعات آهنگ...*",
                                                   status_prefix, is_batch, silent=silent)
        track_data = await get_track(track_id)
        if not track_data or not track_data.get("results"):
            status_msg = await self._update_status(chat_id, status_msg, "خطا در دریافت اطلاعات آهنگ.", status_prefix,
                                                   is_batch, silent=silent)
            return status_msg, False

        track = track_data["results"][0]
        track_id = track_id or track.get("trackId") or track.get("id")

        if not is_batch:
            track_name = track.get("trackName", "Unknown")
            artist_name = track.get("artistName", "Unknown")
            album_name = track.get("collectionName")

            status_prefix = f"🎵 *آهنگ:* {track_name}\n🎤 *هنرمند:* {artist_name}"
            if album_name:
                status_prefix += f"\n💿 *آلبوم:* {album_name}"

        quality_value = "320"

        duration_ms = int(track.get('trackTimeMillis') or 0)
        duration_sec = duration_ms // 1000 if duration_ms > 0 else None
        title = track.get('trackName')
        artist_name = track.get('artistName') or ""
        cover_bytes = album_cover_bytes
        if cover_bytes is None:
            attachment_artwork = (track.get("attachments") or {}).get("artworkUrls") or []
            attachment_artwork_url = (
                attachment_artwork[0].get("url")
                if attachment_artwork and isinstance(attachment_artwork[0], dict)
                else None
            )
            artwork_url = (
                track.get("artworkUrl100")
                or track.get("artworkUrl600")
                or track.get("artworkUrl")
                or attachment_artwork_url
            )
            cover_bytes = await self.artwork_service.get_artwork_bytes(
                track.get('collectionId') or track_id,
                artwork_url,
                track_name=title,
                artist_name=artist_name)
        # Check cache
        needs_192 = _needs_192_copy(duration_sec)
        cache_tasks = [get_cached_audio(track_id, quality=quality_value)]
        if self.telegram.enabled:
            cache_tasks.append(get_cached_audio(
                track_id, quality=quality_value, source="telegram",
                api_client=self.api_client))
        if needs_192:
            cache_tasks.append(get_cached_audio(track_id, quality="192"))
            if self.telegram.enabled:
                cache_tasks.append(get_cached_audio(
                    track_id, quality="192", source="telegram",
                    api_client=self.api_client))
        cache_results = await asyncio.gather(*cache_tasks)
        audio_cache = cache_results[0]
        cache_index = 1
        telegram_cache = cache_results[cache_index] if self.telegram.enabled else None
        cache_index += 1 if self.telegram.enabled else 0
        audio_192_cache = cache_results[cache_index] if needs_192 else None
        cache_index += 1 if needs_192 else 0
        telegram_192_cache = (
            cache_results[cache_index]
            if needs_192 and self.telegram.enabled else None
        )
        # A Bale message mirror is only a reference to a message, not a
        # downloadable URL. Continue through the mirror-download flow so a
        # Telegram mirror can repair Bale without downloading from YouTube.
        bale_cache_usable = bool(
            audio_cache and not str(audio_cache).startswith("bale://"))
        if bale_cache_usable:
            logger.info(f"Using cached audio for track {track_id} (quality: {quality_value}) -> {audio_cache}")
            # A completed dual-platform cache hit must already contain both
            # mirrors; otherwise continue and repair the missing platform.
            if (telegram_cache or not self.telegram.enabled) and (
                    not needs_192 or (
                    audio_192_cache and
                    (telegram_192_cache or not self.telegram.enabled))):
                try:
                    status_msg = await self._update_status(
                        chat_id, status_msg, "📤 *در حال ارسال فایل از حافظه کش...*",
                        status_prefix, is_batch, silent=silent)
                    logger.info(f"Sending cached audio: {track.get('trackName')} ({quality_value}kbps)")
                    cache_thumb = TelegramUploadService._prepare_thumbnail(cover_bytes)
                    cache_upload_options = {"thumb": cache_thumb} if cache_thumb else {}
                    await self.bot.send_audio(
                        chat_id, audio=audio_cache, title=title, duration=duration_sec,
                        **cache_upload_options)

                    if needs_192:
                        await self.bot.send_audio(
                            chat_id, audio=audio_192_cache, title=title, duration=duration_sec,
                            **cache_upload_options)

                    if not is_batch:
                        await safe_delete(status_msg)
                    await self.error_notifier.check_and_clear_if_resolved(
                        self.bot, test_success=True)
                    return status_msg, True
                except Exception as e:
                    logger.error(f"Cache send failed: {e}")
                    await self.error_notifier.notify_upload_error(self.bot, str(e))

        # A Telegram mirror is a tagged local artifact. Reuse it when Bale is
        # missing so a second YouTube download is not required.

        if OFFLINE_MODE:
            status_msg = await self._update_status(chat_id, status_msg, "بات در حالت آفلاین است.", status_prefix,
                                                   is_batch, silent=silent)
            return status_msg, False

        # Try the Telegram mirror once. A failed mirror must fall back to the
        # original YouTube flow within this attempt.
        telegram_downloaded = False
        telegram_file = telegram_file or {}
        telegram_path = telegram_file.get("path") or telegram_file_path
        telegram_file_id = telegram_file.get("file_id")
        telegram_message_id = telegram_file.get("message_id")
        if telegram_path or telegram_file_id or telegram_message_id or telegram_cache:
            temp_dir = tempfile.mkdtemp(prefix="musicman-telegram-")
            mp3_path = os.path.join(temp_dir, f"{track_id}_320.mp3")
            status_msg = await self._update_status(
                chat_id, status_msg, "📥 *در حال دریافت فایل آماده از تلگرام...*",
                status_prefix, is_batch, silent=silent)
            try:
                if telegram_path:
                    logger.info(
                        "Using Telegram file path from download queue for track %s",
                        track_id,
                    )
                    try:
                        await self.telegram.download_file_path(
                            telegram_path, Path(mp3_path))
                    except RuntimeError as path_error:
                        if "HTTP 404" not in str(path_error):
                            raise
                        logger.warning(
                            "Telegram file path is stale for %s; resolving a fresh path",
                            track_id,
                        )
                        if telegram_file_id:
                            try:
                                await self.telegram.download_file_id(
                                    telegram_file_id, Path(mp3_path))
                            except RuntimeError as file_id_error:
                                if not telegram_message_id:
                                    raise
                                logger.warning(
                                    "Telegram file ID is unavailable for %s; "
                                    "resolving by message ID: %s",
                                    track_id,
                                    file_id_error,
                                )
                                await self.telegram.download_message_id(
                                    telegram_message_id, Path(mp3_path))
                        elif telegram_message_id:
                            await self.telegram.download_message_id(
                                telegram_message_id, Path(mp3_path))
                        else:
                            raise
                elif telegram_file_id:
                    try:
                        await self.telegram.download_file_id(
                            telegram_file_id, Path(mp3_path))
                    except RuntimeError as file_id_error:
                        if not telegram_message_id:
                            raise
                        logger.warning(
                            "Telegram file ID is unavailable for %s; "
                            "resolving by message ID: %s",
                            track_id,
                            file_id_error,
                        )
                        await self.telegram.download_message_id(
                            telegram_message_id, Path(mp3_path))
                elif telegram_message_id:
                    await self.telegram.download_message_id(
                        telegram_message_id, Path(mp3_path))
                else:
                    await self.telegram.download(telegram_cache, Path(mp3_path))
                telegram_downloaded = True
                lyrics_to_tag = None
            except Exception as telegram_error:
                logger.warning(
                    f"Telegram mirror download failed once for {track_id}; "
                    f"falling back to YouTube: {telegram_error}")
                shutil.rmtree(temp_dir, ignore_errors=True)
                temp_dir = None

        if not telegram_downloaded:
            if download_id:
                await update_download_status(download_id, "downloading", percent=25)
            status_msg = await self._update_status(chat_id, status_msg, "🔍 *در حال جستجوی منبع با کیفیت...*",
                                                   status_prefix, is_batch, silent=silent)
            logger.info(f"Searching YouTube for track {track_id}: {track.get('trackName')} - {track.get('artistName')}")
            video_id = await search_youtube_track(track.get("trackName", ""), track.get("artistName", ""),
                                                  track.get("collectionName", ""), (track.get("releaseDate") or "")[:4],
                                                  target_duration_ms=duration_ms)

            if not video_id:
                status_msg = await self._update_status(chat_id, status_msg, "❌ منبعی برای ترک خواسته شده پیدا نشد.", status_prefix,
                                                       is_batch, silent=silent)
                return status_msg, False

            video_url = f"https://music.youtube.com/watch?v={video_id}"
            temp_dir = None
            async with self.download_semaphore:
                if download_id:
                    await update_download_status(download_id, "downloading", percent=40)
                status_msg = await self._update_status(chat_id, status_msg,
                                                       f"⏳ *در حال دانلود با کیفیت {quality_value}kbps...*",
                                                       status_prefix, is_batch, silent=silent)
                logger.info(f"Downloading from YouTube: {video_url} with quality {quality_value}")
                mp3_path = await download_audio(video_url, quality=quality_value)
                if not mp3_path:
                    raise Exception("Download failed")
                temp_dir = os.path.dirname(mp3_path)

            if download_id:
                await update_download_status(download_id, "downloading", percent=70)
            lyrics_dict = await lyrics_service.get_lyrics(track_id, track.get("trackName", ""),
                                                          track.get("artistName", ""), track.get("collectionName"),
                                                          duration_ms=duration_ms)
            if lyrics_dict is None:
                raise Exception(f"Technical error fetching lyrics for {track_id}")
            lyrics_to_tag = (lyrics_dict.get("synced") or lyrics_dict.get("plain"))
            if download_id:
                await update_download_status(download_id, "downloading", percent=75)
            status_msg = await self._update_status(chat_id, status_msg, "🏷️ *در حال تگ‌گذاری فایل...*",
                                                   status_prefix, is_batch, silent=silent)
            self.tagging_service.tag_mp3(Path(mp3_path), track, cover_bytes, lyrics=lyrics_to_tag)

        if download_id:
            await update_download_status(download_id, "downloading", percent=90)
        status_msg = await self._update_status(chat_id, status_msg, "📤 *در حال ارسال فایل در پیام‌رسان‌ها...*",
                                               status_prefix, is_batch, silent=silent)
        uploaded_192 = False
        try:
            async def upload_quality(path: str, quality: str) -> None:
                async def upload_bale() -> None:
                    cached_bale = await get_cached_audio(
                        track_id, quality=quality, source="bale",
                        api_client=self.api_client)
                    if cached_bale:
                        return
                    logger.info(
                        f"Uploading Bale audio: {track.get('trackName')} ({quality}kbps)")
                    bale_msg = await self._send_bale_audio(
                        chat_id, path, title, duration_sec, artist_name, cover_bytes)
                    bale_file_id, bale_message_id = _bale_upload_ids(bale_msg)
                    if not bale_file_id or bale_message_id is None:
                        raise RuntimeError("Bale upload returned no file or message id")
                    bale_mirror = f"bale://{bale_message_id}"
                    await set_mirror("track", str(track_id), "audioUrl", bale_mirror,
                                     quality=quality, source="bale")
                    await self.api_client.save_messenger_file(
                        "bale", str(track_id), bale_file_id, str(bale_message_id),
                        quality, os.path.basename(path), bale_mirror)

                async def upload_telegram() -> None:
                    if not self.telegram.enabled:
                        return
                    cached_telegram = await get_cached_audio(
                        track_id, quality=quality, source="telegram",
                        api_client=self.api_client)
                    if cached_telegram:
                        return
                    telegram_message = await self.telegram.upload_audio(
                        path, title, duration_sec, performer=artist_name,
                        artwork=cover_bytes)
                    telegram_audio = telegram_message.get("audio") or {}
                    telegram_file_id = telegram_audio.get("file_id")
                    telegram_message_id = telegram_message.get("message_id")
                    if not telegram_file_id or telegram_message_id is None:
                        raise RuntimeError("Telegram upload returned no file or message id")
                    telegram_file_path = ""
                    try:
                        telegram_file_path = await self.telegram.file_url(telegram_file_id)
                    except RuntimeError as file_error:
                        if "file is too big" not in str(file_error).lower():
                            raise
                        logger.warning(
                            "Telegram getFile cannot resolve oversized file %s",
                            telegram_file_id)
                    telegram_mirror = _telegram_mirror_url(telegram_message_id)
                    await set_mirror(
                        "track", str(track_id), "audioUrl", telegram_mirror,
                        quality=quality, source="telegram")
                    await self.api_client.save_messenger_file(
                        "telegram", str(track_id), telegram_file_id,
                        str(telegram_message_id), quality,
                        os.path.basename(path), telegram_file_path)

                await asyncio.gather(upload_bale(), upload_telegram())

            try:
                await upload_quality(mp3_path, "320")
            except Exception as upload_error:
                if not _is_file_too_large_error(upload_error):
                    raise
                retry_path = mp3_path.replace(".mp3", "_retry_192.mp3")
                if not convert_bitrate(Path(mp3_path), Path(retry_path), "192"):
                    raise upload_error
                self.tagging_service.tag_mp3(Path(retry_path), track, cover_bytes,
                                             lyrics=lyrics_to_tag)
                await upload_quality(retry_path, "192")
                mp3_path = retry_path
                uploaded_192 = True
        except Exception as e:
            logger.error(f"Messenger upload failed: {e}")
            raise

        try:
            if needs_192 and not uploaded_192 and mp3_path.endswith(".mp3"):
                converted_path = mp3_path.replace(".mp3", "_192.mp3")
                if convert_bitrate(Path(mp3_path), Path(converted_path), "192"):
                    self.tagging_service.tag_mp3(Path(converted_path), track, cover_bytes,
                                                 lyrics=lyrics_to_tag)
                    await upload_quality(converted_path, "192")

            await self.error_notifier.check_and_clear_if_resolved(self.bot, test_success=True)
            if not is_batch:
                await safe_delete(status_msg)
            return status_msg, True
        except Exception as e:
            logger.error(f"Download error: {e}")
            status_msg = await self._update_status(chat_id, status_msg, f"❌ خطا در دانلود {track.get('trackName', '')}",
                                                   status_prefix, is_batch, silent=silent)
            await self.error_notifier.notify_upload_error(self.bot, str(e))
            return status_msg, False
        finally:
            if temp_dir: shutil.rmtree(temp_dir, ignore_errors=True)


__all__ = ["DownloadService", "_is_file_too_large_error"]
