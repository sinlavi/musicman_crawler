from pathlib import Path
from typing import Union
from core.logger import logger
from core.http_client import HttpClient
from utils.helpers import get_high_res_artwork

class ArtworkService:
    async def get_artwork_bytes(self, entity_id: Union[int, str], artwork_url100: str,
                               track_name: str = None, artist_name: str = None):
        if not entity_id: return None

        # 1. Local Cache Check (by collection_id/entity_id)
        cache_path = Path("cache/artworks") / f"{entity_id}.jpg"
        if cache_path.exists():
            try:
                return cache_path.read_bytes()
            except Exception as e:
                logger.error(f"Error reading artwork cache: {e}")

        artwork_bytes = None

        # 2. Download from provided URL
        url = get_high_res_artwork(artwork_url100, 600)
        if url:
            # Use multi-method request for better reliability
            data, status, is_tech_err = await HttpClient.request_with_methods("GET", url)

            if status == 200 and data:
                artwork_bytes = data
            elif is_tech_err:
                msg = f"Technical error downloading artwork from {url} (Status: {status}). Failing process."
                logger.error(msg)
                raise Exception(msg)
            else:
                logger.warning(f"Artwork not found (404) at {url}. Proceeding to fallback.")

        # Save downloaded iTunes artwork locally for reuse.
        if artwork_bytes:
            try:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_bytes(artwork_bytes)
                logger.info(f"Artwork cached locally for {entity_id}")
            except Exception as e:
                logger.error(f"Error saving artwork to cache: {e}")

        return artwork_bytes
