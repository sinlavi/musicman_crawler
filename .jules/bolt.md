## 2026-03-30 - Parallelize I/O bound tasks in Crawler Loop
**Learning:** In the queue processor, fetching artwork and sending voice preview were executed sequentially. Since both are independent I/O tasks communicating with Telegram API, running them concurrently via `asyncio.gather` reduces queue processing latency significantly without altering bot detection rate-limit sleep intervals.
**Action:** Always parallelize independent Telegram I/O operations (like artwork photo upload and voice preview upload) using `asyncio.gather` while respecting existing API sleep delays.
