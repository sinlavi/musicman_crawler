from services.lyrics_service import lyrics_service
import asyncio
import os
import shutil
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


class DownloadService:
    def __init__(self, bot, api_client, artwork_service,
                 tagging_service, error_notifier):
        self.bot = bot
        self.api_client = api_client
        self.artwork_service = artwork_service
        self.tagging_service = tagging_service
        self.error_notifier = error_notifier
        self.download_semaphore = asyncio.Semaphore(100)

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
        # Check cache
        audio_cache = await get_cached_audio(track_id, quality=quality_value)
        if audio_cache:
            logger.info(f"Using cached audio for track {track_id} (quality: {quality_value}) -> {audio_cache}")
            try:
                status_msg = await self._update_status(chat_id, status_msg, "📤 *در حال ارسال فایل از حافظه کش...*",
                                                       status_prefix, is_batch, silent=silent)
                logger.info(f"Sending cached audio: {track.get('trackName')} ({quality_value}kbps)")

                await self.bot.send_audio(chat_id, audio=audio_cache, title=title, duration=duration_sec)

                # Send 192kbps cached audio if track is longer than 8 minutes (480s)
                if duration_sec is not None and duration_sec > 480 and str(quality_value) == "320":
                    audio_192_cache = await get_cached_audio(track_id, quality="192")
                    if audio_192_cache:
                        try:
                            logger.info(f"Sending cached 192kbps audio for long track {track_id}")
                            await self.bot.send_audio(
                                chat_id, audio=audio_192_cache, title=title, duration=duration_sec
                            )
                        except Exception as e_192:
                            logger.error(f"Failed to send 192kbps cached audio: {e_192}")

                if not is_batch: await safe_delete(status_msg)
                await self.api_client.log_download(user_id, str(track_id), track.get('trackName', ''),
                                                   track.get('artistName', ''), track.get('collectionName', ''),
                                                   0, 'cache', quality_value)
                await self.error_notifier.check_and_clear_if_resolved(self.bot, test_success=True)
                return status_msg, True
            except Exception as e:
                logger.error(f"Cache send failed: {e}")
                await self.error_notifier.notify_upload_error(self.bot, str(e))

        if OFFLINE_MODE:
            status_msg = await self._update_status(chat_id, status_msg, "بات در حالت آفلاین است.", status_prefix,
                                                   is_batch, silent=silent)
            return status_msg, False

        # Download from YouTube
        cover_bytes = album_cover_bytes
        # show_artwork is now effectively always True as settings are removed
        if cover_bytes is None:
            status_msg = await self._update_status(chat_id, status_msg, "🖼️ *در حال دریافت کاور آهنگ...*",
                                                   status_prefix, is_batch, silent=silent)

            cover_bytes = await self.artwork_service.get_artwork_bytes(track.get('collectionId') or track_id,
                                                                       track.get('artworkUrl100'),
                                                                       track_name=track.get('trackName'),
                                                                       artist_name=track.get('artistName'))

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
        try:
            async with self.download_semaphore:
                if download_id:
                    await update_download_status(download_id, "downloading", percent=40)
                status_msg = await self._update_status(chat_id, status_msg,
                                                       f"⏳ *در حال دانلود با کیفیت {quality_value}kbps...*",
                                                       status_prefix, is_batch, silent=silent)
                logger.info(f"Downloading from YouTube: {video_url} with quality {quality_value}")
                mp3_path = await download_audio(video_url, quality=quality_value)
                if not mp3_path: raise Exception("Download failed")

                temp_dir = os.path.dirname(mp3_path)
                if download_id:
                    await update_download_status(download_id, "downloading", percent=70)
                lyrics_dict = await lyrics_service.get_lyrics(track_id, track.get("trackName", ""),
                                                              track.get("artistName", ""), track.get("collectionName"),
                                                              duration_ms=duration_ms)

                if lyrics_dict is None:
                     msg = f"Technical error fetching lyrics for {track_id}"
                     logger.error(msg)
                     raise Exception(msg)

                if download_id:
                    await update_download_status(download_id, "downloading", percent=75)
                status_msg = await self._update_status(chat_id, status_msg, "🏷️ *در حال تگ‌گذاری فایل...*",
                                                       status_prefix, is_batch, silent=silent)
                lyrics_to_tag = (lyrics_dict.get("synced") or lyrics_dict.get("plain")) if lyrics_dict else None
                self.tagging_service.tag_mp3(Path(mp3_path), track, cover_bytes, lyrics=lyrics_to_tag)

                if download_id:
                    await update_download_status(download_id, "downloading", percent=90)
                status_msg = await self._update_status(chat_id, status_msg, "📤 *در حال ارسال فایل در بله...*",
                                                       status_prefix, is_batch, silent=silent)

                with open(mp3_path, 'rb') as f:
                    logger.info(f"Uploading fresh audio: {track.get('trackName')} ({quality_value}kbps)")

                    try:
                        msg = await self.bot.send_audio(
                            chat_id, audio=f, title=title, duration=duration_sec
                        )
                    except Exception as e:
                        if _is_file_too_large_error(e) and str(quality_value) == "320":
                            logger.warning(f"File too large for 320kbps (error: {e}), retrying with 192kbps: {track.get('trackName')}")
                            status_msg = await self._update_status(chat_id, status_msg, "⚠️ *حجم فایل زیاد است، در حال تبدیل به ۱۹۲...*",
                                                                   status_prefix, is_batch, silent=silent)

                            mp3_192_retry_path = mp3_path.replace(".mp3", "_retry_192.mp3")
                            if convert_bitrate(Path(mp3_path), Path(mp3_192_retry_path), "192"):
                                self.tagging_service.tag_mp3(Path(mp3_192_retry_path), track, cover_bytes, lyrics=lyrics_to_tag)
                                with open(mp3_192_retry_path, 'rb') as f_retry:
                                    msg = await self.bot.send_audio(
                                        chat_id, audio=f_retry, title=title, duration=duration_sec
                                    )
                                    quality_value = "192" # Update quality for logging and mirroring
                            else:
                                raise e
                        else:
                            raise e

                    audio_file_id = getattr(getattr(msg, "audio", None), "id", None)
                    if audio_file_id and track_id:
                        mirror_res = await set_mirror('track', str(track_id), 'audioUrl',
                                                     audio_file_id, quality=quality_value,
                                                     source="bale")
                        if not mirror_res or not mirror_res.get("success"):
                            logger.error(f"Failed to set mirror for track {track_id} quality {quality_value} after retries")

                # DUAL UPLOAD: Only send 192kbps in addition for audios longer than 8 minutes (480s)
                other_quality = "192" if str(quality_value) == "320" else "320"
                is_longer_than_8_min = duration_sec is not None and duration_sec > 480
                if other_quality == "192" and is_longer_than_8_min:
                    try:
                        status_msg = await self._update_status(chat_id, status_msg, f"🔄 *در حال تبدیل به کیفیت {other_quality}kbps...*",
                                                               status_prefix, is_batch, silent=silent)

                        mp3_conv_path = mp3_path.replace(".mp3", f"_{other_quality}.mp3")
                        if convert_bitrate(Path(mp3_path), Path(mp3_conv_path), other_quality):
                            # Re-tag converted file
                            self.tagging_service.tag_mp3(Path(mp3_conv_path), track, cover_bytes, lyrics=lyrics_to_tag)

                            with open(mp3_conv_path, 'rb') as f_conv:
                                logger.info(f"Uploading converted {other_quality}kbps audio: {track.get('trackName')}")

                                msg_conv = await self.bot.send_audio(
                                    chat_id, audio=f_conv, title=title, duration=duration_sec
                                )
                                converted_file_id = getattr(getattr(msg_conv, "audio", None), "id", None)
                                if converted_file_id and track_id:
                                    mirror_conv_res = await set_mirror('track', str(track_id), 'audioUrl',
                                                                       converted_file_id,
                                                                       quality=other_quality,
                                                                       source="bale")
                                    if not mirror_conv_res or not mirror_conv_res.get("success"):
                                        logger.error(f"Failed to set mirror for converted track {track_id} quality {other_quality} after retries")
                    except Exception as e:
                        logger.error(f"Failed to perform dual quality upload for {other_quality}kbps: {e}")

                file_size = os.path.getsize(mp3_path)
                await self.api_client.log_download(user_id, str(track_id), track.get('trackName', ''),
                                                   track.get('artistName', ''), track.get('collectionName', ''),
                                                   file_size, 'youtube', quality_value)
                await self.error_notifier.check_and_clear_if_resolved(self.bot, test_success=True)
                if not is_batch: await safe_delete(status_msg)
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

