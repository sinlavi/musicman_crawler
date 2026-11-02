import aiohttp
import asyncio
import random
import logging
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional, Tuple, Any, List
from urllib.parse import urlsplit
from aiohttp_socks import ProxyConnector
from core.config import API_BASE_URL, ITUNES_BASE_URL, USER_AGENTS

logger = logging.getLogger("HttpClient")
_API_PROXY_PREFERENCE_SECONDS = 5 * 60
_API_PROXY_PREFERRED_UNTIL = 0.0


def _is_3rah_request(url: str) -> bool:
    host = urlsplit(url).hostname
    configured_hosts = {
        urlsplit(base_url).hostname
        for base_url in (API_BASE_URL, ITUNES_BASE_URL)
        if base_url
    }
    return host == "mm.3rah.ir" or host in configured_hosts


def _retry_delay(
        attempt: int,
        retry_delay_seconds: Optional[float],
        *,
        status: Optional[int] = None,
        headers=None,
        body: str = "",
) -> float:
    retry_after = (headers or {}).get("Retry-After")
    retry_after_delay = None
    if retry_after:
        try:
            retry_after_delay = min(300.0, max(0.0, float(retry_after)))
        except (TypeError, ValueError):
            try:
                retry_at = parsedate_to_datetime(retry_after)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                retry_after_delay = min(
                    300.0,
                    max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds()),
                )
            except (TypeError, ValueError, OverflowError):
                logger.warning("Ignoring invalid Retry-After header: %r", retry_after)

    if "max_user_connections" in body.lower():
        return max(
            30.0,
            retry_after_delay or 0.0,
            retry_delay_seconds or 0.0,
        )
    if retry_after_delay is not None:
        return retry_after_delay

    base_delay = (
        max(0.0, retry_delay_seconds)
        if retry_delay_seconds is not None
        else 1.0
    )
    if status == 429:
        base_delay = max(base_delay, 5.0)
    jitter = random.uniform(0, 0.5) if base_delay else 0.0
    return min(base_delay * (2 ** min(attempt, 4)), 60.0) + jitter


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
        global _API_PROXY_PREFERRED_UNTIL
        from core.config import PROXY
        headers = kwargs.pop('headers', {}).copy()
        last_status = 0
        is_3rah = _is_3rah_request(url)
        api_proxy_override = None

        uas = list(USER_AGENTS)
        random.shuffle(uas)

        attempts = max_attempts or min(max(len(uas) * 2, 4), 6)
        for i in range(attempts):
            ua = uas[i % len(uas)]
            headers['User-Agent'] = headers.get('User-Agent') or ua
            if is_3rah:
                proxy_preferred = asyncio.get_running_loop().time() < _API_PROXY_PREFERRED_UNTIL
                if api_proxy_override is not None:
                    attempt_proxy = bool(PROXY) and api_proxy_override
                elif proxy_preferred:
                    attempt_proxy = bool(PROXY)
                else:
                    attempt_proxy = bool(PROXY) and use_proxy and i % 2 == 0
            else:
                # Non-3rah callers retain the existing transport selection.
                attempt_proxy = use_proxy and PROXY and i % 2 == 0

            # For HTTP proxies in direct session, we still might want to pass it?
            # No, if use_proxy is False we want direct.
            current_proxy = PROXY if (attempt_proxy and not PROXY.startswith("socks")) else None

            retry_delay = None
            try:
                session = await cls.get_session(use_proxy=bool(attempt_proxy))
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
                            if is_3rah and not attempt_proxy:
                                _API_PROXY_PREFERRED_UNTIL = 0.0
                            return data, resp.status, False

                        if resp.status == 404:
                            if is_3rah and not attempt_proxy:
                                _API_PROXY_PREFERRED_UNTIL = 0.0
                            return None, 404, False
                        if is_3rah and not attempt_proxy:
                            _API_PROXY_PREFERRED_UNTIL = 0.0

                        if resp.status in (408, 425, 429) or resp.status >= 500:
                            body = await resp.text()
                            if i + 1 >= attempts:
                                logger.error(
                                    "Final HTTP failure for %s: status=%s body=%s",
                                    url,
                                    resp.status,
                                    body[:1000].replace("\n", " "),
                                )
                                break
                            retry_delay = _retry_delay(
                                i,
                                retry_delay_seconds,
                                status=resp.status,
                                headers=resp.headers,
                                body=body,
                            )
                            logger.warning(
                                "Request to %s failed with status %s; retrying in %.1fs",
                                url, resp.status, retry_delay)

                        if resp.status == 403:
                            logger.warning(
                                f"Request to {url} failed with status {resp.status}, "
                                "trying next method...")
                            continue

            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
                if is_3rah and PROXY:
                    if attempt_proxy:
                        api_proxy_override = False
                        logger.warning(
                            "WARP connection to 3rah failed; retrying directly"
                        )
                    else:
                        _API_PROXY_PREFERRED_UNTIL = (
                            asyncio.get_running_loop().time()
                            + _API_PROXY_PREFERENCE_SECONDS
                        )
                        api_proxy_override = True
                        logger.warning(
                            "Direct 3rah connection failed; failing over to WARP "
                            "and preferring it for %s seconds",
                            _API_PROXY_PREFERENCE_SECONDS,
                        )
                if i + 1 >= attempts:
                    logger.error("Final HTTP failure for %s: %s", url, e)
                    break
                retry_delay = _retry_delay(i, retry_delay_seconds)
                logger.warning(
                    "Request to %s failed (%s: %s); retrying in %.1fs",
                    url, type(e).__name__, e, retry_delay)

            if retry_delay is not None:
                await asyncio.sleep(retry_delay)
            else:
                await asyncio.sleep(0.1)

        return None, last_status, True
