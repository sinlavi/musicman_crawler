import os
from io import BytesIO
from pathlib import Path
from typing import Optional

import aiohttp
from PIL import Image

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

    async def upload_audio(self, path: str, title: str, duration: Optional[int],
                           performer: Optional[str] = None,
                           artwork: Optional[bytes] = None) -> dict:
        if not self.enabled:
            raise RuntimeError("Telegram upload is not configured")
        form = aiohttp.FormData()
        form.add_field("chat_id", str(self.chat_id))
        form.add_field("title", title)
        if performer:
            form.add_field("performer", performer)
        if duration is not None:
            form.add_field("duration", str(duration))
        thumbnail = self._prepare_thumbnail(artwork)
        if thumbnail:
            form.add_field("thumb", BytesIO(thumbnail), filename="cover.jpg",
                           content_type="image/jpeg")
        with open(path, "rb") as audio:
            form.add_field("audio", audio, filename=os.path.basename(path),
                           content_type="audio/mpeg")
            return await self._request("sendAudio", form=form)

    @staticmethod
    def _prepare_thumbnail(artwork: Optional[bytes]) -> Optional[bytes]:
        if not artwork:
            return None
        try:
            with Image.open(BytesIO(artwork)) as image:
                image = image.convert("RGB")
                image.thumbnail((320, 320), Image.Resampling.LANCZOS)
                quality = 85
                while quality >= 40:
                    output = BytesIO()
                    image.save(output, format="JPEG", quality=quality, optimize=True)
                    thumbnail = output.getvalue()
                    if len(thumbnail) <= 200 * 1024:
                        return thumbnail
                    quality -= 10
        except (OSError, ValueError):
            return None
        return None

    async def file_url(self, file_id: str) -> str:
        file = await self.file_info(file_id)
        return f"https://api.telegram.org/file/bot{self.token}/{file['file_path']}"

    async def file_info(self, file_id: str) -> dict:
        file = await self._request("getFile", {"file_id": file_id})
        file_path = file.get("file_path")
        if not file_path:
            raise RuntimeError("Telegram getFile returned no file_path")
        return {"file_id": file_id, "file_path": file_path}

    async def file_info_from_message_id(self, message_id: str) -> dict:
        if not self.chat_id:
            raise RuntimeError("TELEGRAM_CHAT_ID is not configured")
        forwarded = await self._request("forwardMessage", {
            "chat_id": str(self.chat_id),
            "from_chat_id": str(self.chat_id),
            "message_id": str(message_id),
        })
        media = forwarded.get("audio") or forwarded.get("document")
        file_id = media.get("file_id") if isinstance(media, dict) else None
        if not file_id:
            raise RuntimeError(
                f"Telegram message {message_id} does not contain audio or document")
        try:
            info = await self.file_info(file_id)
            info["message_id"] = str(message_id)
            return info
        finally:
            forwarded_id = forwarded.get("message_id")
            if forwarded_id is not None:
                try:
                    await self._request("deleteMessage", {
                        "chat_id": str(self.chat_id),
                        "message_id": str(forwarded_id),
                    })
                except RuntimeError:
                    pass

    async def file_url_from_message_id(self, message_id: str) -> str:
        info = await self.file_info_from_message_id(message_id)
        return f"https://api.telegram.org/file/bot{self.token}/{info['file_path']}"

    async def download(self, url: str, destination: Path) -> None:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, proxy=PROXY or None,
                                   timeout=aiohttp.ClientTimeout(total=120)) as response:
                if response.status != 200:
                    raise RuntimeError(f"Telegram mirror download failed: HTTP {response.status}")
                destination.write_bytes(await response.read())


__all__ = ["TelegramUploadService"]
