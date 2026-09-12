import os
import tempfile
from pathlib import Path
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TLEN
from services.tagging_service import TaggingService

def test_tag_mp3_metadata(tmp_path):
    # Create dummy MP3 file
    mp3_file = tmp_path / "test_song.mp3"
    # Write empty file
    mp3_file.write_bytes(b"")

    track_data = {
        "trackName": "Test Track Title",
        "artistName": "Test Artist Name",
        "collectionName": "Test Album Name",
        "trackTimeMillis": 210000,
        "releaseDate": "2023-05-20",
        "primaryGenreName": "Pop"
    }

    TaggingService.tag_mp3(mp3_file, track_data)

    audio = ID3(mp3_file)
    assert audio.get("TIT2").text[0] == "Test Track Title"
    assert audio.get("TPE1").text[0] == "Test Artist Name"
    assert audio.get("TALB").text[0] == "Test Album Name"
    assert audio.get("TLEN").text[0] == "210000"
