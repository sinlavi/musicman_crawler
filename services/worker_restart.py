import asyncio

from core.logger import logger


async def restart_worker(processing_tasks, reason, update_download_status):
    logger.critical("%s Restarting worker workflow...", reason)
    pending_download_ids = []
    tasks_to_cancel = []
    for task, download_id in processing_tasks.items():
        if not task.done():
            task.cancel()
            pending_download_ids.append(download_id)
            tasks_to_cancel.append(task)
    if tasks_to_cancel:
        await asyncio.gather(*tasks_to_cancel, return_exceptions=True)

    results = await asyncio.gather(
        *(
            update_download_status(
                download_id,
                "pending",
                percent=0,
                http_max_attempts=2,
                http_timeout_seconds=15,
                http_use_proxy=True,
            )
            for download_id in pending_download_ids
        ),
        return_exceptions=True,
    )
    for download_id, result in zip(pending_download_ids, results):
        if (isinstance(result, BaseException) or result is None
                or (isinstance(result, dict) and not result.get("success"))):
            logger.error("Could not reset interrupted download %s before restart", download_id)

    raise SystemExit(75)