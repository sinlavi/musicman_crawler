import pytest

import crawlers.youtube as youtube


@pytest.mark.asyncio
async def test_rate_limit_activation_requests_workflow_restart(monkeypatch):
    monkeypatch.setattr(youtube, "_YOUTUBE_RATE_LIMIT_TRIGGERED", False)

    await youtube._activate_youtube_cooldown()

    assert youtube.youtube_rate_limit_triggered()