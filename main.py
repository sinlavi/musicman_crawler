from core.config import BALE_TOKEN, API_BASE_URL, API_TOKEN, PROXY, TARGET_CHAT_ID, DEFAULT_QUALITY
import os

# Set global proxy environment variables
if PROXY:
    os.environ["HTTP_PROXY"] = PROXY
    os.environ["HTTPS_PROXY"] = PROXY

from core.logger import logger
from core.http_client import HttpClient

from services.api_client import APIClient
from services.artwork_service import ArtworkService
from services.tagging_service import TaggingService
from services.error_notifier import BaleUploadErrorNotifier
from services.download_service import DownloadService
from crawlers.itunes import get_download_queue, update_download_status, reset_stuck_downloads

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

async def process_queue_item(bot, item, download_service, user_id, active_tasks, task_done_event=None):
    download_id = item.get("download_id") or item.get("downloadId") or item.get("id")
    track_id = item.get("trackId") or item.get("track_id") or item.get("id")
    quality = str(item.get("quality") or DEFAULT_QUALITY)

    logger.info(f"Processing download {download_id} for track {track_id} (quality: {quality})")

    try:
        max_attempts = 3
        for attempt in range(1, max_attempts + 1):
            # Update status to downloading
            await update_download_status(download_id, "downloading", percent=0)

            # Process track with timeout (300 seconds / 5 minutes per attempt)
            async def _process_track():
                await update_download_status(download_id, "downloading", percent=5)

                await update_download_status(download_id, "downloading", percent=15)

                # Download and send the tagged audio file
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
                    return True
                else:
                    raise Exception("Download or upload failed")

            try:
                success = await asyncio.wait_for(_process_track(), timeout=300.0)
                if success:
                    return
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
    from balethon import Client

    # Initialize Services
    api_client = APIClient(API_BASE_URL, API_TOKEN)
    artwork_service = ArtworkService()
    tagging_service = TaggingService()
    error_notifier = BaleUploadErrorNotifier(api_client)

    bot = Client(token=BALE_TOKEN, proxy=PROXY or None)
    await bot.connect()

    try:
        download_service = DownloadService(bot, api_client, artwork_service, tagging_service, error_notifier)

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
                fetch_limit = max(available_slots * 5, 100)
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

                    try:
                        numeric_id = int(download_id)
                    except (ValueError, TypeError):
                        numeric_id = abs(hash(str(download_id)))

                    # Sharding logic: only process items that belong to this instance
                    if numeric_id % TOTAL_INSTANCES != (INSTANCE_ID - 1):
                        continue

                    if download_id in active_tasks:
                        continue

                    active_tasks.add(download_id)
                    tasks_started += 1
                    asyncio.create_task(
                        process_queue_item(bot, item, download_service, user_id, active_tasks, task_done_event)
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
    finally:
        await bot.disconnect()

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
