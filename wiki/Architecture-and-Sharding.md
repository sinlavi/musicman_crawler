# ⚙️ Architecture and Sharding Mechanism

This page details the underlying architecture, polling loop design, and distributed sharding algorithm used by **MusicMan**.

---

## 🏗️ High-Level System Architecture

```
                    ┌────────────────────────────┐
                    │     Queue Master API       │
                    │   ( https://mm.3rah.ir )   │
                    └─────────────┬──────────────┘
                                  │ Poll Queue (/get_download_queue)
                                  ▼
      ┌───────────────────────────────────────────────────────┴───────────────────────────────────────────────────────┐
      │                                           Distributed Crawler Pool                                            │
      │                                                                                                               │
      │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                       │
      │  │ Node #1 (1/5)│  │ Node #2 (2/5)│  │ Node #3 (3/5)│  │ Node #4 (4/5)│  │ Node #5 (5/5)│                       │
      │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                       │
      └─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┼───────────────────────────────┘
                │                 │                 │                 │                 │
                ▼                 ▼                 ▼                 ▼                 ▼
       ┌────────────────┐┌────────────────┐┌────────────────┐┌────────────────┐┌────────────────┐
       │ Shard Filter   ││ Shard Filter   ││ Shard Filter   ││ Shard Filter   ││ Shard Filter   │
       │ (id % 5 == 0)  ││ (id % 5 == 1)  ││ (id % 5 == 2)  ││ (id % 5 == 3)  ││ (id % 5 == 4)  │
       └───────┬────────┘└───────┬────────┘└───────┬────────┘└───────┬────────┘└───────┬────────┘
                  │                   │                   │
                  └───────────────────┼───────────────────┘
                                      ▼
                      ┌───────────────────────────────┐
                      │ Download, Tag, & Upload Engine│
                      │  - Metadata Fetch (iTunes)    │
                      │  - Audio Transcode (yt-dlp)   │
                      │  - ID3 / HD Artwork Embed     │
                      │  - Voice Preview Clip         │
                      └───────────────┬───────────────┘
                                      ▼
                      ┌───────────────────────────────┐
                      │       Telegram Delivery       │
                      │       (Target Channels)       │
                      └───────────────────────────────┘
```

---

## ⚡ Modulo Sharding Mechanism

To scale queue processing across multiple runners without requiring complex external message brokers like RabbitMQ or Redis, MusicMan employs **deterministic modulo sharding**.

### Sharding Formula

Given:
- `download_id`: Unique integer identifier for each queue item.
- `INSTANCE_ID`: 1-based index of current runner instance (e.g., 1, 2, 3).
- `TOTAL_INSTANCES`: Total count of active runner instances.

A task is processed by an instance **if and only if**:

$$\text{download\_id} \pmod{\text{TOTAL\_INSTANCES}} == (\text{INSTANCE\_ID} - 1)$$

### Example

For `TOTAL_INSTANCES = 5`:
- Instance 1 handles `download_id`s where $id \pmod 5 == 0$ (e.g., 0, 5, 10, 15...)
- Instance 2 handles `download_id`s where $id \pmod 5 == 1$ (e.g., 1, 6, 11, 16...)
- Instance 3 handles `download_id`s where $id \pmod 5 == 2$ (e.g., 2, 7, 12, 17...)
- Instance 4 handles `download_id`s where $id \pmod 5 == 3$ (e.g., 3, 8, 13, 18...)
- Instance 5 handles `download_id`s where $id \pmod 5 == 4$ (e.g., 4, 9, 14, 19...)

---

## 🚀 Instant Crawl Request Trigger Mechanism

To support instant response times like Telegram Bots without relying solely on polling delays, each crawler runner hosts an embedded HTTP trigger listener listening on `TRIGGER_PORT` (default 8080 or `PORT`).

When a user submits a new crawl or download request on the web platform, the server sends an HTTP `POST` or `GET` request to `/trigger` or `/webhook` on the crawler instances:

```bash
curl -X POST http://<crawler-host>:8080/trigger
```

Upon receiving this signal, the crawler instantly wakes up from idle sleep and queries the download queue immediately with **zero latency**.

---

## 🔒 Concurrency & Lock Control

1. **Artwork Lock (`artwork_lock`):** An `asyncio.Lock` ensures that high-resolution cover artwork for a given album/collection is not repeatedly uploaded concurrently by multiple workers.
2. **Primary Instance Controls (`INSTANCE_ID == 1`):** Cleanup tasks such as `reset_stuck_downloads()` are restricted exclusively to the primary instance (Instance 1) on startup to prevent race conditions across parallel runners.
3. **Task Deduplication (`active_tasks`):** In-memory tracking set prevents re-launching tasks already being actively downloaded in the local instance event loop.

---

## ⌛ Graceful Shutdown & Runtime Limits

Each crawler instance enforces `MAX_RUNTIME` (default 5.5 hours, aligned with GitHub Actions workflow execution limits):

```python
if time.time() - START_TIME > MAX_RUNTIME:
    logger.info("Max runtime reached. Shutting down crawler gracefully...")
    # Waits up to 15 minutes for in-flight tasks to finish
```

When runtime expires, remaining active tasks are allowed a grace period to complete cleanly, after which the process exits gracefully allowing CI/CD runners to restart the workflow.
