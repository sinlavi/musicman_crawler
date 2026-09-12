# 🚀 Deployment and GitHub Actions CI

This document explains how MusicMan is deployed and executed automatically using GitHub Actions multi-runner schedules and Cloudflare WARP SOCKS5 proxying.

---

## 🔁 GitHub Actions Scheduled Execution

MusicMan is configured to run continuously across multiple GitHub Actions workflow instances:
- `.github/workflows/python-app.yml` (Instance 1)
- `.github/workflows/python-app-2.yml` (Instance 2)
- `.github/workflows/python-app-3.yml` (Instance 3)

### Workflow Schedule & Self-Restart Loop

```yaml
on:
  workflow_dispatch:
  push:
  schedule:
    - cron: "0 */6 * * *"
```

Each workflow step includes an automatic self-restart trigger:
```yaml
- name: Restart workflow
  if: always()
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    gh workflow run "Test Deploy"
```

This pattern ensures that when an instance hits its maximum 5.5 hour runtime (`MAX_RUNTIME`), it terminates gracefully and automatically triggers a fresh runner execution, achieving 24/7 continuous operation on free GitHub Actions infrastructure.

---

## 🌐 Cloudflare WARP Docker SOCKS5 Proxy Setup

To prevent rate limiting and IP blocking from YouTube or iTunes, each GitHub runner starts a isolated Cloudflare WARP Docker container:

```yaml
- name: Start Cloudflare WARP proxy
  run: |
    docker run -d \
      --name warp \
      --network host \
      --cap-add NET_ADMIN \
      caomingjun/warp
```

The crawler process routes all traffic through `socks5h://127.0.0.1:1080`.

---

## 🎬 FFmpeg Static Caching

FFmpeg binaries are downloaded and cached using `actions/cache@v4` to minimize runner startup times:

```yaml
- name: Cache FFmpeg binaries
  uses: actions/cache@v4
  with:
    path: |
      ~/ffmpeg-bin
      /usr/local/bin/ffmpeg
      /usr/local/bin/ffprobe
    key: ffmpeg-static-linux64-${{ runner.os }}-v1
```

---

## 🐳 Running with Docker Locally

You can also run MusicMan locally using Docker:

```dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "main.py"]
```

```bash
docker build -t musicman-crawler .
docker run -d --name musicman-instance-1 -e INSTANCE_ID=1 -e TOTAL_INSTANCES=1 musicman-crawler
```

Main Project Instance: [https://mm.3rah.ir](https://mm.3rah.ir)
