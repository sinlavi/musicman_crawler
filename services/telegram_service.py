import os
from pathlib import Path
from typing import Optional

import aiohttp

from core.config import PROXY, TELEGRAM_CHAT_ID, TELEGRAM_TOKEN


class TelegramUploadService:
    def __init__(self, token: Optional[str] = TELEGRAM_TOKEN,
                 chat_id: Optional[str] = TELEGRAM_CHAT_ID):
        self.token = token
        self.chat_id = chat_id

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.chat_id)

    async def _request(self, method: str, data: Optional[dict] = None,
                       form: Optional[aiohttp.FormData] = None) -> dict:
        if not self.token:
            raise RuntimeError("TELEGRAM_TOKEN is not configured")
        url = f"https://api.telegram.org/bot{self.token}/{method}"
        async with aiohttp.ClientSession() as session:
            async with session.post(url, data=form or data, proxy=PROXY or None,
                                    timeout=aiohttp.ClientTimeout(total=120)) as response:
                payload = await response.json(content_type=None)
                if response.status != 200 or not payload.get("ok"):
                    raise RuntimeError(f"Telegram {method} failed: {payload}")
                return payload["result"]

    async def upload_audio(self, path: str, title: str, duration: Optional[int]) -> dict:
        if not self.enabled:
            raise RuntimeError("Telegram upload is not configured")
        form = aiohttp.FormData()
        form.add_field("chat_id", str(self.chat_id))
        form.add_field("title", title)
        if duration is not None:
            form.add_field("duration", str(duration))
        with open(path, "rb") as audio:
            form.add_field("audio", audio, filename=os.path.basename(path),
                           content_type="audio/mpeg")
            return await self._request("sendAudio", form=form)

    async def file_url(self, file_id: str) -> str:
        file = await self._request("getFile", {"file_id": file_id})
        file_path = file.get("file_path")
        if not file_path:
            raise RuntimeError("Telegram getFile returned no file_path")
        return f"https://api.telegram.org/file/bot{self.token}/{file_path}"

    async def download(self, url: str, destination: Path) -> None:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, proxy=PROXY or None,
                                   timeout=aiohttp.ClientTimeout(total=120)) as response:
                if response.status != 200:
                    raise RuntimeError(f"Telegram mirror download failed: HTTP {response.status}")
                destination.write_bytes(await response.read())


__all__ = ["TelegramUploadService"]
