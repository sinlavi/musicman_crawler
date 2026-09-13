from core.config import TG_TOKEN, INFO_CHANNEL_ID, OFFLINE_MODE, API_BASE_URL, API_TOKEN, PROXY, TARGET_CHAT_ID, DEFAULT_QUALITY
import os

# Set global proxy environment variables
if PROXY:
    os.environ["HTTP_PROXY"] = PROXY
    os.environ["HTTPS_PROXY"] = PROXY

from telegram import Bot
from telegram.request import HTTPXRequest
from core.logger import logger
from core.http_client import HttpClient

from utils.helpers import get_high_res_artwork
from crawlers.utils import get_track
from bot.handlers.preview import send_voice_preview
from services.api_client import APIClient
from services.artwork_service import ArtworkService
from services.rate_limiter import DownloadRateLimiter
from services.tracker import AlbumDownloadTracker
from services.tagging_service import TaggingService
from services.error_notifier import BaleUploadErrorNotifier
from services.download_service import DownloadService
from services.lyrics_service import lyrics_service
from crawlers.itunes import get_download_queue, update_download_status, reset_stuck_downloads, set_mirror

import asyncio
import signal
import sys
import time

# Environment variables for sharding and runtime control
INSTANCE_ID = int(os.getenv("INSTANCE_ID", "1"))
TOTAL_INSTANCES = int(os.getenv("TOTAL_INSTANCES", "1"))
MAX_RUNTIME = int(os.getenv("MAX_RUNTIME", 5.5 * 3600)) # 5.5 hours default
MAX_CONCURRENT_TASKS = int(os.getenv("MAX_CONCURRENT_TASKS", "10"))
START_TIME = time.time()

# Target Chat ID from config
TARGET_CHANNEL_ID = TARGET_CHAT_ID

# Lock to prevent concurrent artwork uploads for the same collection
artwork_lock = asyncio.Lock()

async def process_queue_item(bot, item, download_service, artwork_service, user_id, active_tasks, task_done_event=None):
    download_id = item.get("download_id") or item.get("downloadId") or item.get("id")
    track_id = item.get("trackId") or item.get("track_id") or item.get("id")
    quality = str(item.get("quality") or DEFAULT_QUALITY)

    logger.info(f"Processing download {download_id} for track {track_id} (quality: {quality})")

    try:
        max_attempts = 3
        for attempt in range(1, max_attempts + 1):
            # Update status to downloading
            await update_download_status(download_id, "downloading", percent=0)

            # Process track
            try:
                # 1. Fetch metadata
                track_data = await get_track(track_id)
                if not track_data or not track_data.get("results"):
                    raise Exception("Track data not found")

                track = track_data["results"][0]
                await update_download_status(download_id, "downloading", percent=5)

                effective_track_id = track_id or track.get("trackId") or track.get("id")

                # 2 & 3. Process Artwork & Voice Preview concurrently
                async def _upload_artwork_task():
                    artwork_url = get_high_res_artwork(track.get("artworkUrl100"), 400)
                    if artwork_url:
                        coll_id = track.get("collectionId") or effective_track_id
                        # Use lock to prevent duplicate concurrent uploads for the same collection
                        async with artwork_lock:
                            if not await artwork_service.get_cached_artwork_url("collection", coll_id):
                                artwork_bytes = await artwork_service.get_artwork_for_display("collection", coll_id, artwork_url, user_id)
                                if artwork_bytes:
                                    caption = f"🖼 *کاور آهنگ:* {track.get('trackName')} - {track.get('artistName')}"
                                    photo_msg = await bot.send_photo(TARGET_CHANNEL_ID, photo=artwork_bytes, caption=caption)
                                    if photo_msg:
                                        message_id = photo_msg.message_id
                                        mirror_url = f"https://api.telegram.org/file/bot<token>/{message_id}"
                                        if coll_id:
                                            await set_mirror("collection", str(coll_id), "artworkUrl", mirror_url)
                                        if effective_track_id:
                                            await set_mirror("track", str(effective_track_id), "artworkUrl", mirror_url)

                async def _upload_preview_task():
                    if track.get("previewUrl") and effective_track_id:
                        await send_voice_preview(bot, TARGET_CHANNEL_ID, effective_track_id, user_id, silent=True)

                # Parallelize I/O bound tasks (artwork processing/mirroring and voice preview upload)
                await asyncio.gather(_upload_artwork_task(), _upload_preview_task())

                await update_download_status(download_id, "downloading", percent=15)

                # 4. Download and Send Audio
                _, success = await download_service.download_and_send_track(
                    chat_id=TARGET_CHANNEL_ID,
                    track_id=track_id,
                    user_id=user_id,
                    selected_quality=quality,
                    silent=True,
                    download_id=download_id
                )

                if success:
                    logger.info(f"Successfully processed download {download_id} on attempt {attempt}")
                    await update_download_status(download_id, "completed", percent=100)
                    return
                else:
                    raise Exception("Download or upload failed")

            except Exception as e:
                logger.warning(f"Error processing download {download_id} (Attempt {attempt}/{max_attempts}): {e}")
                if attempt < max_attempts:
                    # Wait before retrying (exponential backoff or fixed delay)
                    await asyncio.sleep(5 * attempt)
                else:
                    logger.error(f"Ultimate failure processing download {download_id}: {e}")
                    await update_download_status(download_id, "failed", error_message=str(e))
    finally:
        active_tasks.discard(download_id)
        if task_done_event:
            task_done_event.set()


async def run_crawler():
    # Initialize Services
    api_client = APIClient(API_BASE_URL, API_TOKEN)
    artwork_service = ArtworkService(api_client, None) # Passed None for user_settings_service
    download_rate_limiter = DownloadRateLimiter()
    album_tracker = AlbumDownloadTracker(api_client)
    tagging_service = TaggingService()
    error_notifier = BaleUploadErrorNotifier(api_client)

    request = HTTPXRequest(
        proxy=PROXY if PROXY else None,
        read_timeout=120.0,
        write_timeout=120.0,
        connect_timeout=60.0,
        pool_timeout=60.0
    )

    bot = Bot(token=TG_TOKEN, request=request)

    async with bot:
        download_service = DownloadService(bot, api_client, artwork_service,
                                           tagging_service, error_notifier, album_tracker, download_rate_limiter)

        logger.info(f"ABRAAVA Crawler Instance {INSTANCE_ID}/{TOTAL_INSTANCES} initialized with max concurrent tasks {MAX_CONCURRENT_TASKS}...")

        # Only the primary instance resets stuck downloads to avoid race conditions
        if INSTANCE_ID == 1:
            await reset_stuck_downloads()

        active_tasks = set()
        consecutive_tech_errors = 0
        task_done_event = asyncio.Event()

        while True:
            # Check for runtime limit
            if time.time() - START_TIME > MAX_RUNTIME:
                logger.info("Max runtime reached. Shutting down crawler gracefully...")
                # Wait for remaining tasks
                if active_tasks:
                    logger.info(f"Waiting for {len(active_tasks)} remaining tasks to complete...")
                    for _ in range(30):
                        if not active_tasks: break
                        await asyncio.sleep(10)
                break

            # Calculate available slots
            available_slots = MAX_CONCURRENT_TASKS - len(active_tasks)

            if available_slots <= 0:
                # Worker pool full, wait for any active task to finish
                task_done_event.clear()
                try:
                    await asyncio.wait_for(task_done_event.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    pass
                continue

            try:
                # Poll for pending downloads to fill open slots
                fetch_limit = max(available_slots * 2, 20)
                queue_resp = await get_download_queue(status="pending", limit=fetch_limit)

                # Check for technical error
                if queue_resp is None:
                    consecutive_tech_errors += 1
                    logger.warning(f"Technical error encountered ({consecutive_tech_errors}/10)")
                    if consecutive_tech_errors >= 10:
                        logger.critical("Too many consecutive technical errors. Exiting for workflow restart...")
                        sys.exit(1)
                    await asyncio.sleep(10)
                    continue

                # Reset error counter on any non-technical response
                consecutive_tech_errors = 0

                if not queue_resp.get("success") or not queue_resp.get("items"):
                    logger.debug("No pending downloads found. Sleeping briefly...")
                    if active_tasks:
                        task_done_event.clear()
                        try:
                            await asyncio.wait_for(task_done_event.wait(), timeout=3.0)
                        except asyncio.TimeoutError:
                            pass
                    else:
                        await asyncio.sleep(5)
                    continue

                items = queue_resp.get("items", [])
                user_id = 234591600
                tasks_started = 0

                for item in items:
                    if len(active_tasks) >= MAX_CONCURRENT_TASKS:
                        break

                    download_id = item.get("download_id") or item.get("downloadId") or item.get("id")
                    if download_id is None:
                        continue

                    # Sharding logic: only process items that belong to this instance
                    if download_id % TOTAL_INSTANCES != (INSTANCE_ID - 1):
                        continue

                    if download_id in active_tasks:
                        continue

                    active_tasks.add(download_id)
                    tasks_started += 1
                    asyncio.create_task(
                        process_queue_item(bot, item, download_service, artwork_service, user_id, active_tasks, task_done_event)
                    )

                if tasks_started == 0:
                    if active_tasks:
                        task_done_event.clear()
                        try:
                            await asyncio.wait_for(task_done_event.wait(), timeout=2.0)
                        except asyncio.TimeoutError:
                            pass
                    else:
                        await asyncio.sleep(5)

            except Exception as e:
                logger.exception(f"Crawler loop error: {e}")
                await asyncio.sleep(5)

def signal_handler(sig, frame):
    sys.exit(0)

async def main():
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    try:
        await run_crawler()
    finally:
        await HttpClient.close()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
