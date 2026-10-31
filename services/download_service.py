from services.lyrics_service import lyrics_service
from services.telegram_service import TelegramUploadService
import asyncio
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional, Union, List
from core.logger import logger
from core.config import OFFLINE_MODE, DEFAULT_QUALITY
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


class DownloadService:
    def __init__(self, bot, api_client, artwork_service,
                 tagging_service, error_notifier):
        self.bot = bot
        self.api_client = api_client
        self.artwork_service = artwork_service
        self.tagging_service = tagging_service
        self.error_notifier = error_notifier
        self.download_semaphore = asyncio.Semaphore(100)
        self.telegram = TelegramUploadService()

    async def _send_bale_audio(self, chat_id, path: str, title: str,
                               duration: Optional[int], performer: str,
                               artwork: Optional[bytes] = None):
        """Send audio with metadata omitted by Balethon's high-level wrapper."""
        resolved_chat_id = await self.bot.resolve_peer_id(chat_id)
        with open(path, "rb") as audio:
            payload = {
                "chat_id": resolved_chat_id,
                "audio": audio,
                "title": title,
                "duration": duration,
                "performer": performer,
                "thumb": artwork,
            }
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
                                      silent=False, download_id=None):

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

        # Default target download quality is 320, unless specified (e.g. 192)
        quality_value = selected_quality or "320"
        if quality_value == "ask": quality_value = "320"

        duration_ms = int(track.get('trackTimeMillis') or 0)
        duration_sec = duration_ms // 1000 if duration_ms > 0 else None
        title = track.get('trackName')
        artist_name = track.get('artistName') or ""
        cover_bytes = album_cover_bytes
        if cover_bytes is None:
            cover_bytes = await self.artwork_service.get_artwork_bytes(
                track.get('collectionId') or track_id,
                track.get('artworkUrl100'),
                track_name=title,
                artist_name=artist_name)
        # Check cache
        audio_cache = await get_cached_audio(track_id, quality=quality_value)
        telegram_cache = None
        if self.telegram.enabled:
            telegram_cache = await get_cached_audio(
                track_id, quality=quality_value, source="telegram")
        if audio_cache:
            logger.info(f"Using cached audio for track {track_id} (quality: {quality_value}) -> {audio_cache}")
            # A completed dual-platform cache hit must already contain both
            # mirrors; otherwise continue and repair the missing platform.
            if telegram_cache or not self.telegram.enabled:
                try:
                    status_msg = await self._update_status(
                        chat_id, status_msg, "📤 *در حال ارسال فایل از حافظه کش...*",
                        status_prefix, is_batch, silent=silent)
                    logger.info(f"Sending cached audio: {track.get('trackName')} ({quality_value}kbps)")
                    await self.bot.send_audio(
                        chat_id, audio=audio_cache, title=title, duration=duration_sec)

                    if duration_sec is not None and duration_sec > 480 and str(quality_value) == "320":
                        audio_192_cache = await get_cached_audio(track_id, quality="192")
                        if audio_192_cache:
                            await self.bot.send_audio(
                                chat_id, audio=audio_192_cache, title=title, duration=duration_sec)

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

        # Download from Telegram when available, otherwise download from YouTube.
        if telegram_cache:
            temp_dir = tempfile.mkdtemp(prefix="musicman-telegram-")
            mp3_path = os.path.join(temp_dir, f"{track_id}_{quality_value}.mp3")
            status_msg = await self._update_status(
                chat_id, status_msg, "📥 *در حال دریافت فایل آماده از تلگرام...*",
                status_prefix, is_batch, silent=silent)
            await self.telegram.download(telegram_cache, Path(mp3_path))
            lyrics_to_tag = None
        else:
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
        try:
            try:
                logger.info(f"Uploading Bale audio: {track.get('trackName')} ({quality_value}kbps)")
                msg = await self._send_bale_audio(
                    chat_id, mp3_path, title, duration_sec, artist_name, cover_bytes)
            except Exception as upload_error:
                if not (_is_file_too_large_error(upload_error) and str(quality_value) == "320"):
                    raise
                retry_path = mp3_path.replace(".mp3", "_retry_192.mp3")
                if not convert_bitrate(Path(mp3_path), Path(retry_path), "192"):
                    raise upload_error
                self.tagging_service.tag_mp3(Path(retry_path), track, cover_bytes,
                                             lyrics=lyrics_to_tag)
                msg = await self._send_bale_audio(
                    chat_id, retry_path, title, duration_sec, artist_name, cover_bytes)
                mp3_path = retry_path
                quality_value = "192"
            bale_file_id, bale_message_id = _bale_upload_ids(msg)
            if not bale_file_id or bale_message_id is None:
                response_type = type(msg).__name__
                response_keys = list(msg.keys()) if isinstance(msg, dict) else []
                raise RuntimeError(
                    f"Bale upload returned no file or message id "
                    f"(type={response_type}, keys={response_keys})")
            bale_mirror = f"bale://{bale_message_id}"
            await set_mirror('track', str(track_id), 'audioUrl', bale_mirror,
                             quality=quality_value, source="bale")
            await self.api_client.save_messenger_file(
                "bale", str(track_id), bale_file_id, str(bale_message_id),
                quality_value, os.path.basename(mp3_path), bale_mirror)

            if self.telegram.enabled:
                telegram_mirror = await get_cached_audio(
                    track_id, quality=quality_value, source="telegram")
                if not telegram_mirror:
                    with open(mp3_path, "rb") as f:
                        telegram_message = await self.telegram.upload_audio(
                            mp3_path, title, duration_sec, performer=artist_name,
                            artwork=cover_bytes)
                    telegram_audio = telegram_message.get("audio") or {}
                    telegram_file_id = telegram_audio.get("file_id")
                    telegram_message_id = telegram_message.get("message_id")
                    if not telegram_file_id or telegram_message_id is None:
                        raise RuntimeError("Telegram upload returned no file or message id")
                    # The API mirror is the stable platform/message reference.
                    # Keep the resolved file URL only in the messenger-file
                    # record because Telegram requires file_path for downloads.
                    telegram_file_path = ""
                    try:
                        telegram_file_path = await self.telegram.file_url(telegram_file_id)
                    except RuntimeError as file_error:
                        if "file is too big" not in str(file_error).lower():
                            raise
                        logger.warning(
                            "Telegram getFile cannot resolve file %s because it exceeds "
                            "the Bot API download limit; keeping the uploaded mirror",
                            telegram_file_id)
                    telegram_mirror = (
                        f"https://api.telegram.org/file/bot"
                        f"{self.telegram.token}/{telegram_message_id}"
                    )
                    await set_mirror(
                        'track', str(track_id), 'audioUrl', telegram_mirror,
                        quality=quality_value, source="telegram")
                    await self.api_client.save_messenger_file(
                        "telegram", str(track_id), telegram_file_id,
                        str(telegram_message_id), quality_value,
                        os.path.basename(mp3_path), telegram_file_path)
        except Exception as e:
            logger.error(f"Messenger upload failed: {e}")
            raise

        try:
            other_quality = "192" if str(quality_value) == "320" else "320"
            if other_quality == "192" and duration_sec is not None and duration_sec > 480:
                converted_path = mp3_path.replace(".mp3", f"_{other_quality}.mp3")
                if convert_bitrate(Path(mp3_path), Path(converted_path), other_quality):
                    self.tagging_service.tag_mp3(Path(converted_path), track, cover_bytes,
                                                 lyrics=lyrics_to_tag)
                    if not await get_cached_audio(track_id, quality=other_quality):
                        converted_msg = await self._send_bale_audio(
                            chat_id, converted_path, title, duration_sec,
                            artist_name, cover_bytes)
                        converted_file = getattr(getattr(converted_msg, "audio", None), "id", None)
                        converted_message = getattr(converted_msg, "id", None)
                        if converted_file and converted_message is not None:
                            converted_mirror = f"bale://{converted_message}"
                            await set_mirror("track", str(track_id), "audioUrl",
                                             converted_mirror, quality=other_quality, source="bale")
                            await self.api_client.save_messenger_file(
                                "bale", str(track_id), converted_file, str(converted_message),
                                other_quality, os.path.basename(converted_path), converted_mirror)

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
