from crawlers.utils import format_artist_hashtag

def test_format_artist_hashtag_basic():
    assert format_artist_hashtag("Queen") == "#Queen"
    assert format_artist_hashtag("AC/DC & Guns N Roses") == "#AcDcAndGunsNRoses"
    assert format_artist_hashtag("artist_name") == "#ArtistName"

def test_format_artist_hashtag_unicode():
    assert format_artist_hashtag("Beyoncé") == "#Beyoncé"
    assert format_artist_hashtag("Motörhead") == "#Motörhead"
    assert format_artist_hashtag("Sigur Rós") == "#SigurRós"

def test_format_artist_hashtag_edge_cases():
    assert format_artist_hashtag("") == ""
    assert format_artist_hashtag(None) == ""
    assert format_artist_hashtag("  ") == ""
    assert format_artist_hashtag("1234") == "#1234"

def test_format_artist_hashtag_lru_cache():
    info_before = format_artist_hashtag.cache_info()
    format_artist_hashtag("The Beatles")
    format_artist_hashtag("The Beatles")
    info_after = format_artist_hashtag.cache_info()
    assert info_after.hits > info_before.hits
