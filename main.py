from core.config import (
    BALE_TOKEN, API_BASE_URL, API_TOKEN, API_RETRY_DELAY_SECONDS, PROXY, TARGET_CHAT_ID, DEFAULT_QUALITY,
    TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, MAX_CONCURRENT_TASKS, QUEUE_BATCH_SIZE,
    QUEUE_PRIORITY_POLL_SECONDS,
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
import hashlib
import signal
import sys
import time
from collections import deque

# Environment variables for sharding and runtime control
INSTANCE_ID = int(os.getenv("INSTANCE_ID", "1"))
TOTAL_INSTANCES = int(os.getenv("TOTAL_INSTANCES", "1"))
MAX_RUNTIME = int(os.getenv("MAX_RUNTIME", 5.5 * 3600)) # 5.5 hours default
START_TIME = time.time()

# Target Chat ID from config
TARGET_CHANNEL_ID = TARGET_CHAT_ID
MAX_CONSECUTIVE_QUEUE_ERRORS = 3
QUEUE_ERROR_RETRY_DELAY_SECONDS = max(10.0, API_RETRY_DELAY_SECONDS)


def _belongs_to_instance(download_id, instance_id=INSTANCE_ID, total_instances=TOTAL_INSTANCES):
    try:
        numeric_id = int(download_id)
    except (ValueError, TypeError):
        digest = hashlib.sha256(str(download_id).encode("utf-8")).digest()
        numeric_id = int.from_bytes(digest[:8], "big")
    return numeric_id % total_instances == instance_id - 1


def _queue_priority(item):
    try:
        return float(item.get("priority") or 0)
    except (TypeError, ValueError):
        logger.warning("Ignoring invalid queue priority: %r", item.get("priority"))
        return 0


def _queue_download_id(item):
    return item.get("download_id") or item.get("downloadId") or item.get("id")


def _queue_track_id(item):
    return item.get("trackId") or item.get("track_id") or item.get("id")


def _queue_shard_id(item):
    return _queue_track_id(item) or _queue_download_id(item)


def _queue_items_for_instance(items, instance_id=INSTANCE_ID, total_instances=TOTAL_INSTANCES):
    return [
        item for item in items
        if (shard_id := _queue_shard_id(item)) is not None
        and _belongs_to_instance(shard_id, instance_id, total_instances)
    ]


def _merge_priority_items(pending_batch, incoming_items, active_download_ids):
    queued_items = {
        _queue_download_id(item): item
        for item in pending_batch
        if _queue_download_id(item) is not None
        and _queue_download_id(item) not in active_download_ids
    }

    for item in incoming_items:
        download_id = _queue_download_id(item)
        status = str(item.get("download_status") or item.get("status") or "").lower()
        if (
            download_id is None
            or download_id in active_download_ids
            or status in {"completed", "downloading", "failed", "stopped"}
            or _queue_priority(item) <= 0
        ):
            continue
        queued_items[download_id] = item

    return deque(sorted(
        queued_items.values(),
        key=_queue_priority,
        reverse=True,
    ))


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


def _normalize_queue_items(items):
    if isinstance(items, dict):
        normalized = []
        for track_id, item in items.items():
            if not isinstance(item, dict):
                logger.warning("Skipping malformed queue item for track %s", track_id)
                continue
            item = dict(item)
            item.setdefault("trackId", track_id)
            normalized.append(item)
        return normalized
    if isinstance(items, list):
        return [item for item in items if isinstance(item, dict)]
    logger.warning("Ignoring queue items with unsupported format: %s", type(items).__name__)
    return []


async def process_queue_item(
    bot, item, download_service, user_id, active_tasks, task_done_event=None,
    active_track_ids=None,
):
    download_id = item.get("download_id") or item.get("downloadId") or item.get("id")
    track_id = _queue_track_id(item)
    quality = str(item.get("quality") or DEFAULT_QUALITY)
    telegram_file = _queue_telegram_file(item)

    logger.info(f"Processing download {download_id} for track {track_id} (quality: {quality})")
    bale_completed = False

    def mark_bale_completed():
        nonlocal bale_completed
        bale_completed = True

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
                    bale_completion_callback=mark_bale_completed,
                )

                if success:
                    logger.info(f"Successfully processed download {download_id} on attempt {attempt}")
                    if not bale_completed:
                        await update_download_status(download_id, "completed", percent=100)
                    return True
                else:
                    raise Exception("Download or upload failed")

            try:
                success = await asyncio.wait_for(_process_track(), timeout=300.0)
                if success:
                    return
            except Exception as e:
                if bale_completed:
                    logger.error(
                        "Download %s was completed on Bale; Telegram follow-up failed: %s",
                        download_id,
                        e,
                    )
                    return
                logger.warning(f"Error processing download {download_id} (Attempt {attempt}/{max_attempts}): {e}")
                if attempt < max_attempts:
                    # Wait before retrying (exponential backoff or fixed delay)
                    await asyncio.sleep(5 * attempt)
                else:
                    logger.error(f"Ultimate failure processing download {download_id}: {e}")
                    await update_download_status(download_id, "failed", error_message=str(e))
    finally:
        active_tasks.discard(download_id)
        if active_track_ids is not None:
            active_track_ids.discard(str(track_id))
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
        active_track_ids = set()
        processing_tasks = {}
        pending_batch = deque()
        consecutive_tech_errors = 0
        task_done_event = asyncio.Event()
        last_queue_poll = 0.0

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

            try:
                polling_priority = bool(active_tasks)
                queue_poll_due = (
                    time.monotonic() - last_queue_poll
                    >= QUEUE_PRIORITY_POLL_SECONDS
                )
                fetch_initial_batch = not active_tasks and not pending_batch

                if fetch_initial_batch or (polling_priority and queue_poll_due):
                    queue_resp = await get_download_queue(
                        status="pending", limit=QUEUE_BATCH_SIZE
                    )
                    last_queue_poll = time.monotonic()

                    if queue_resp is None:
                        consecutive_tech_errors += 1
                        logger.warning(
                            "Queue API technical error (%s/%s)",
                            consecutive_tech_errors,
                            MAX_CONSECUTIVE_QUEUE_ERRORS,
                        )
                        if consecutive_tech_errors >= MAX_CONSECUTIVE_QUEUE_ERRORS:
                            await restart_worker(
                                processing_tasks,
                                "Repeated queue API failures.",
                                update_download_status,
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

                    consecutive_tech_errors = 0
                    queue_items = _normalize_queue_items(queue_resp.get("items", []))
                    assigned_items = _queue_items_for_instance(queue_items)
                    logger.info(
                        "Queue returned %s pending item(s); %s assigned to worker %s/%s",
                        len(queue_items),
                        len(assigned_items),
                        INSTANCE_ID,
                        TOTAL_INSTANCES,
                    )
                    if polling_priority:
                        pending_batch = _merge_priority_items(
                            pending_batch, assigned_items, active_tasks
                        )
                    else:
                        pending_batch.extend(
                            sorted(
                                assigned_items,
                                key=_queue_priority,
                                reverse=True,
                            )
                        )
                    if not pending_batch and not active_tasks:
                        logger.debug("No pending downloads found. Sleeping briefly...")
                        await asyncio.sleep(5)
                        continue

                user_id = 234591600
                tasks_started = 0

                while pending_batch and len(active_tasks) < MAX_CONCURRENT_TASKS:
                    item = pending_batch.popleft()
                    download_id = _queue_download_id(item)
                    if download_id is None:
                        continue

                    status = str(
                        item.get("download_status") or item.get("status") or ""
                    ).lower()
                    try:
                        percent = float(item.get("percent") or 0)
                    except (TypeError, ValueError):
                        percent = 0
                    if status == "completed" or percent >= 100:
                        await update_download_status(download_id, "completed", percent=100)
                        continue
                    if status in {"downloading", "failed", "stopped"}:
                        continue

                    if not _belongs_to_instance(_queue_shard_id(item)):
                        continue
                    track_id = _queue_track_id(item)
                    track_key = str(track_id)
                    if download_id in active_tasks or track_key in active_track_ids:
                        continue

                    active_tasks.add(download_id)
                    active_track_ids.add(track_key)
                    tasks_started += 1
                    task = asyncio.create_task(
                        process_queue_item(
                            bot,
                            item,
                            download_service,
                            user_id,
                            active_tasks,
                            task_done_event,
                            active_track_ids,
                        )
                    )
                    processing_tasks[task] = download_id
                    task.add_done_callback(processing_tasks.pop)

                if tasks_started == 0 and not pending_batch and not active_tasks:
                    await asyncio.sleep(5)
                elif active_tasks and (
                    not pending_batch or len(active_tasks) >= MAX_CONCURRENT_TASKS
                ):
                    task_done_event.clear()
                    wait_time = max(
                        0.1,
                        QUEUE_PRIORITY_POLL_SECONDS
                        - (time.monotonic() - last_queue_poll),
                    )
                    try:
                        await asyncio.wait_for(
                            task_done_event.wait(),
                            timeout=wait_time,
                        )
                    except asyncio.TimeoutError:
                        pass

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
