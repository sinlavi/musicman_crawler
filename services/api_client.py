from typing import Dict, Any
from core.logger import logger
from core.http_client import HttpClient

class APIClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip('/')
        self.token = token

    async def _post_json(self, url: str, data: Dict[str, Any]) -> Dict[str, Any]:
        response, status, technical_error = await HttpClient.request_with_methods(
            "POST", url, json=data,
            headers={
                'Authorization': 'Bearer ' + self.token,
                'Content-Type': 'application/json',
            })
        if technical_error:
            logger.error(f"API request failed: {url} (status={status})")
            return {'success': False, 'status': status, 'message': 'API request failed'}
        if not isinstance(response, dict):
            logger.error(f"API returned an invalid response: {url} (status={status})")
            return {'success': False, 'status': status, 'message': 'Invalid API response'}
        return response

    async def _request(self, action: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return await self._post_json(f"{self.base_url}?action={action}", data)

    async def _post_path_json(self, url: str, data: Dict[str, Any]) -> Dict[str, Any]:
        response, status, technical_error = await HttpClient.request_with_methods(
            "POST", url, json=data,
            headers={
                'Authorization': 'Bearer ' + self.token,
                'Content-Type': 'application/json',
            })
        if technical_error:
            logger.error(f"API path request failed: {url} (status={status})")
            return {'success': False, 'status': status, 'message': 'API request failed'}
        if not isinstance(response, dict):
            logger.error(f"API path returned an invalid response: {url} (status={status})")
            return {'success': False, 'status': status, 'message': 'Invalid API response'}
        return response

    async def _request_path(self, path: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return await self._post_path_json(f"{self.base_url}/{path.lstrip('/')}", data)

    async def register_user(self, user_data: Dict[str, Any]) -> Dict[str, Any]:
        return await self._request('register', user_data)

    async def get_user(self, user_id: int) -> Dict[str, Any]:
        return await self._request('get_user', {'user_id': user_id})

    async def get_user_settings(self, user_id: int) -> Dict[str, Any]:
        return await self._request('get_user_settings', {'user_id': user_id})

    async def update_quick_mode(self, user_id: int, enabled: bool) -> Dict[str, Any]:
        return await self._request('update_quick_mode', {'user_id': user_id, 'enabled': enabled})

    async def update_download_quality(self, user_id: int, quality: str) -> Dict[str, Any]:
        return await self._request('update_download_quality', {'user_id': user_id, 'quality': quality})

    async def update_show_artwork(self, user_id: int, show: bool) -> Dict[str, Any]:
        return await self._request('update_show_artwork', {'user_id': user_id, 'show': show})

    async def update_auto_download(self, user_id: int, enabled: bool) -> Dict[str, Any]:
        return await self._request('update_auto_download', {'user_id': user_id, 'enabled': enabled})

    async def update_notifications(self, user_id: int, enabled: bool) -> Dict[str, Any]:
        return await self._request('update_notifications', {'user_id': user_id, 'enabled': enabled})

    async def log_search(self, user_id: int, search_type: str, search_term: str, result_count: int) -> Dict[str, Any]:
        return await self._request('log_search', {
            'user_id': user_id,
            'search_type': search_type,
            'search_term': search_term,
            'result_count': result_count
        })

    async def log_download(self, user_id: int, track_id: str, track_name: str, artist_name: str,
                           album_name: str = '', file_size: int = 0, download_source: str = 'youtube', quality: str = '192') -> Dict[str, Any]:
        logger.warning("Download logging skipped: current API has no log_download route")
        return {'success': False, 'error': 'log_download endpoint is unavailable'}

    async def log_album_download(self, user_id: int, collection_id: str, collection_name: str,
                                 artist_name: str, total_tracks: int, successful_tracks: int,
                                 failed_tracks: int) -> Dict[str, Any]:
        return await self._request('log_album', {
            'user_id': user_id,
            'collection_id': collection_id,
            'collection_name': collection_name,
            'artist_name': artist_name,
            'total_tracks': total_tracks,
            'successful_tracks': successful_tracks,
            'failed_tracks': failed_tracks
        })

    async def get_required_channels(self) -> Dict[str, Any]:
        return await self._request('get_required_channels', {})

    async def get_broadcast_channels(self) -> Dict[str, Any]:
        return await self._request('get_broadcast_channels', {})

    async def get_active_users(self, limit: int = None) -> Dict[str, Any]:
        return await self._request('get_active_users', {'limit': limit})

    async def log_broadcast(self, message_id: str, channel_id: str, message_text: str,
                            sent_to: int, successful: int, failed: int) -> Dict[str, Any]:
        return await self._request('log_broadcast', {
            'message_id': message_id,
            'channel_id': channel_id,
            'message_text': message_text,
            'sent_to': sent_to,
            'successful': successful,
            'failed': failed
        })

    async def save_messenger_file(self, platform: str, track_id: str, file_id: str,
                                  message_id: str, quality: str, filename: str,
                                  file_path: str = '') -> Dict[str, Any]:
        return await self._request_path('file/save', {
            'platform': platform,
            'trackId': str(track_id),
            'fileId': str(file_id),
            'messageId': str(message_id),
            'quality': str(quality),
            'filename': filename,
            'filePath': file_path,
        })
