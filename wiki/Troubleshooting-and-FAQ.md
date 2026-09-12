# ❓ Troubleshooting and FAQ

Common operational issues, error codes, and resolution steps for **MusicMan**.

---

## 🔧 Frequently Encountered Issues

### 1. Stuck Downloads (`status="downloading"` indefinitely)

**Cause:** A runner process was killed abruptly by CI time limit or memory exhaustion while processing a track.

**Resolution:**
The primary instance (`INSTANCE_ID=1`) automatically executes `reset_stuck_downloads()` upon startup. This resets all downloads stuck in `downloading` status back to `pending` so they can be re-queued.

---

### 2. Technical Errors Limit Reached (`Too many consecutive technical errors`)

```
CRITICAL: Too many consecutive technical errors. Exiting for workflow restart...
```

**Cause:** Backend API (`API_BASE_URL`) returned `None` 10 consecutive times due to network failure, API downtime, or invalid credentials.

**Resolution:**
- Check status of backend web service at [https://mm.3rah.ir](https://mm.3rah.ir).
- Verify `API_BASE_URL` and `API_TOKEN` environment variables in `.env` or GitHub Secrets.

---

### 3. Telegram API Rate Limits (`429 Too Many Requests`)

**Cause:** Sending too many messages or artwork photos per minute.

**Resolution:**
- `DownloadRateLimiter` enforces exponential delays when Telegram returns flood wait warnings.
- Adjust `download_rate_limiter` delay parameters if uploading large batches of tracks.

---

### 4. FFmpeg Executable Not Found

```
FileNotFoundError: [Errno 2] No such file or directory: 'ffmpeg'
```

**Resolution:**
- Install FFmpeg on system path (`sudo apt install ffmpeg` on Linux, or `brew install ffmpeg` on macOS).
- `static-ffmpeg` Python package is included in `requirements.txt` as a fallback.

---

## 💬 FAQ

#### Q: How do I change the target channel where tracks are posted?
A: Update `TARGET_CHAT_ID` in `core/config.py` or `.env`.

#### Q: Where is the main project web instance hosted?
A: The main web interface is accessible at [**https://mm.3rah.ir**](https://mm.3rah.ir).

#### Q: How can I add more worker instances?
A: Increase `TOTAL_INSTANCES` (e.g. to `5`) and spawn 5 runner processes with `INSTANCE_ID` set from `1` to `5`.
