from core.config import (
    BALE_TOKEN, API_BASE_URL, API_TOKEN, API_RETRY_DELAY_SECONDS, PROXY, TARGET_CHAT_ID, DEFAULT_QUALITY,
    TELEGRAM_TOKEN, TELEGRAM_CHAT_ID,
)
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
from services.worker_restart import restart_worker
from crawlers.itunes import get_download_queue, update_download_status, reset_stuck_downloads
from crawlers.youtube import youtube_rate_limit_triggered

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
MAX_CONSECUTIVE_QUEUE_ERRORS = 3
QUEUE_ERROR_RETRY_DELAY_SECONDS = API_RETRY_DELAY_SECONDS

def _queue_telegram_file(item):
    direct = {
        "path": item.get("telegramFilePath") or item.get("telegram_file_path"),
        "file_id": item.get("telegramFileId") or item.get("telegram_file_id"),
        "message_id": item.get("telegramMessageId") or item.get("telegram_message_id"),
    }
    attachments = item.get("attachments")
    if isinstance(attachments, dict):
        for audio in attachments.get("audioUrls") or []:
            if not isinstance(audio, dict):
                continue
            candidate = {
                "path": audio.get("telegramFilePath") or audio.get("telegramFileUrl"),
                "file_id": audio.get("telegramFileId"),
                "message_id": audio.get("telegramMessageId"),
            }
            if any(candidate.values()):
                direct = candidate
                break
    return {k: str(v) for k, v in direct.items() if v}

async def process_queue_item(bot, item, download_service, user_id, active_tasks, task_done_event=None):
    download_id = item.get("download_id") or item.get("downloadId") or item.get("id")
    track_id = item.get("trackId") or item.get("track_id") or item.get("id")
    quality = str(item.get("quality") or DEFAULT_QUALITY)
    telegram_file = _queue_telegram_file(item)

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
                    download_id=download_id,
                    telegram_file=telegram_file,
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

    missing = [
        name for name, value in (
            ("BALE_TOKEN", BALE_TOKEN),
            ("BALE_CHAT_ID", TARGET_CHAT_ID),
            ("TELEGRAM_TOKEN", TELEGRAM_TOKEN),
            ("TELEGRAM_CHAT_ID", TELEGRAM_CHAT_ID),
        ) if not value
    ]
    if missing:
        raise RuntimeError(
            "Both messenger uploads are required; missing environment variables: "
            + ", ".join(missing)
        )

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
        processing_tasks = {}
        consecutive_tech_errors = 0
        task_done_event = asyncio.Event()

        while True:
            if youtube_rate_limit_triggered():
                await restart_worker(
                    processing_tasks, "YouTube rate limit detected.", update_download_status
                )

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
                    logger.warning(
                        "Queue API technical error (%s/%s)",
                        consecutive_tech_errors,
                        MAX_CONSECUTIVE_QUEUE_ERRORS,
                    )
                    if consecutive_tech_errors >= MAX_CONSECUTIVE_QUEUE_ERRORS:
                        await restart_worker(
                            processing_tasks, "Repeated queue API failures.", update_download_status
                        )
                    await asyncio.sleep(QUEUE_ERROR_RETRY_DELAY_SECONDS)
                    continue

                if not queue_resp.get("success"):
                    consecutive_tech_errors += 1
                    logger.warning(
                        "Queue API returned an unsuccessful response (%s/%s)",
                        consecutive_tech_errors,
                        MAX_CONSECUTIVE_QUEUE_ERRORS,
                    )
                    if consecutive_tech_errors >= MAX_CONSECUTIVE_QUEUE_ERRORS:
                        await restart_worker(
                            processing_tasks,
                            "Repeated unsuccessful queue responses.",
                            update_download_status,
                        )
                    await asyncio.sleep(QUEUE_ERROR_RETRY_DELAY_SECONDS)
                    continue

                # Reset error counter on any non-technical response
                consecutive_tech_errors = 0

                if not queue_resp.get("items"):
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
                    task = asyncio.create_task(
                        process_queue_item(bot, item, download_service, user_id, active_tasks, task_done_event)
                    )
                    processing_tasks[task] = download_id
                    task.add_done_callback(processing_tasks.pop)

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
