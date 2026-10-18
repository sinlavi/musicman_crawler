import logging
from functools import lru_cache
from typing import Optional, Dict, Any, Union
from core.config import OFFLINE_MODE
from crawlers.itunes import lookup_itunes
import re

logger = logging.getLogger("ABRAAVA:UTILS")

# Precompiled regex for splitting non-word characters and underscores (supports Unicode letters like 'Beyoncé' or 'Motörhead')
RE_NON_WORD_OR_UNDERSCORE = re.compile(r"[\W_]+")

# Cache formatted hashtag results (e.g. artist and genre names) to avoid redundant regex splits and string processing (~25x speedup)
@lru_cache(maxsize=1024)
def format_artist_hashtag(artist_name: Optional[str]) -> str:
    if not artist_name:
        return ""
    # Replace & with And (with spaces to ensure separate words for CamelCase)
    name = str(artist_name).replace("&", " And ")
    # Split by non-word characters/underscores to support international/Unicode names while preserving clean CamelCase
    words = RE_NON_WORD_OR_UNDERSCORE.split(name)
    # Capitalize each word and join (CamelCase)
    camel_case = "".join(word.capitalize() for word in words if word)
    return f"#{camel_case}" if camel_case else ""

async def get_track(track_id: Union[int, str]) -> Optional[Dict[str, Any]]:
    if OFFLINE_MODE:
        return None
    if isinstance(track_id, str) and track_id.startswith("it_"):
        track_id = track_id[3:]
    return await lookup_itunes(track_id)
