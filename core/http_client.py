import aiohttp
import asyncio
import random
import logging
from typing import Optional, Tuple, Any, List
from aiohttp_socks import ProxyConnector
from core.config import USER_AGENTS

logger = logging.getLogger("HttpClient")

class HttpClient:
    _proxy_session: Optional[aiohttp.ClientSession] = None
    _direct_session: Optional[aiohttp.ClientSession] = None
    _request_semaphore = asyncio.Semaphore(8)

    @classmethod
    async def get_session(cls, use_proxy: bool = True) -> aiohttp.ClientSession:
        from core.config import PROXY
        if use_proxy and PROXY:
            if cls._proxy_session is None or cls._proxy_session.closed:
                if PROXY.startswith("socks"):
                    proxy_url = PROXY.replace("socks5h://", "socks5://")
                    connector = ProxyConnector.from_url(
                        proxy_url, ssl=False, force_close=True)
                else:
                    connector = aiohttp.TCPConnector(
                        ssl=False, force_close=True, limit=20,
                        enable_cleanup_closed=True)
                cls._proxy_session = aiohttp.ClientSession(connector=connector, trust_env=True)
            return cls._proxy_session
        else:
            if cls._direct_session is None or cls._direct_session.closed:
                connector = aiohttp.TCPConnector(
                    ssl=False, force_close=True, limit=20,
                    enable_cleanup_closed=True)
                cls._direct_session = aiohttp.ClientSession(connector=connector, trust_env=False)
            return cls._direct_session

    @classmethod
    async def close(cls):
        if cls._proxy_session and not cls._proxy_session.closed:
            await cls._proxy_session.close()
        if cls._direct_session and not cls._direct_session.closed:
            await cls._direct_session.close()

    @classmethod
    async def request_with_methods(cls, method: str, url: str, *,
                                   use_proxy: bool = True,
                                   max_attempts: Optional[int] = None,
                                   timeout_seconds: float = 60,
                                   retry_delay_seconds: Optional[float] = None,
                                   **kwargs) -> Tuple[Any, int, bool]:
        """
        Executes a request using multiple methods (different User-Agents and toggling proxy).
        Returns (data, status_code, is_technical_error).
        """
        from core.config import PROXY
        headers = kwargs.pop('headers', {}).copy()
        last_status = 0

        uas = list(USER_AGENTS)
        random.shuffle(uas)

        attempts = max_attempts or min(max(len(uas) * 2, 4), 6)
        for i in range(attempts):
            ua = uas[i % len(uas)]
            headers['User-Agent'] = headers.get('User-Agent') or ua
            # API callers can force direct transport; other callers retain proxy fallback.
            attempt_proxy = use_proxy and PROXY and i % 2 == 0
            session = await cls.get_session(use_proxy=bool(attempt_proxy))

            # For HTTP proxies in direct session, we still might want to pass it?
            # No, if use_proxy is False we want direct.
            current_proxy = PROXY if (attempt_proxy and not PROXY.startswith("socks")) else None

            try:
                async with cls._request_semaphore:
                    response_context = session.request(
                        method, url, headers=headers, proxy=current_proxy,
                        ssl=False, timeout=aiohttp.ClientTimeout(total=timeout_seconds), **kwargs)
                    async with response_context as resp:
                        last_status = resp.status
                        if resp.status == 200:
                            try:
                                data = await resp.json()
                            except (aiohttp.ContentTypeError, ValueError):
                                data = await resp.read()
                            return data, resp.status, False

                        if resp.status == 404:
                            return None, 404, False

                        if resp.status in (408, 425, 429) or resp.status >= 500:
                            if i + 1 >= attempts:
                                body = await resp.text()
                                logger.error(
                                    "Final HTTP failure for %s: status=%s body=%s",
                                    url,
                                    resp.status,
                                    body[:1000].replace("\n", " "),
                                )
                                break
                            delay = (
                                max(0.0, retry_delay_seconds)
                                if retry_delay_seconds is not None
                                else min(2 ** min(i, 4), 16) + random.uniform(0, 0.5)
                            )
                            logger.warning(
                                f"Request to {url} failed with status {resp.status}; "
                                f"retrying in {delay}s")
                            await asyncio.sleep(delay)
                            continue

                        if resp.status == 403:
                            logger.warning(
                                f"Request to {url} failed with status {resp.status}, "
                                "trying next method...")
                            continue

            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
                if i + 1 >= attempts:
                    logger.error("Final HTTP failure for %s: %s", url, e)
                    break
                delay = (
                    max(0.0, retry_delay_seconds)
                    if retry_delay_seconds is not None
                    else min(2 ** min(i, 4), 16) + random.uniform(0, 0.5)
                )
                logger.warning(
                    f"Request to {url} failed ({type(e).__name__}: {e}); "
                    f"retrying in {delay}s")
                await asyncio.sleep(delay)

            await asyncio.sleep(0.1)

        return None, last_status, True
