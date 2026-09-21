import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from telegram import Update, Message, Chat, User, CallbackQuery
from bot.handlers.commands import start_command, help_command
from bot.handlers.music import (
    handle_text_message,
    handle_callback_query,
    build_search_keyboard,
    perform_search_and_reply
)

class TestBotHandlers(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.bot = AsyncMock()
        self.context = AsyncMock()
        self.context.bot = self.bot
        self.download_service = AsyncMock()
        self.direct_download_service = AsyncMock()

    async def test_start_command(self):
        update = AsyncMock(spec=Update)
        update.effective_chat = MagicMock(spec=Chat)
        update.effective_chat.id = 12345

        with patch("bot.handlers.commands.send_message", new_callable=AsyncMock) as mock_send:
            await start_command(update, self.context)
            mock_send.assert_called_once()
            self.assertEqual(mock_send.call_args[0][1], 12345)
            self.assertIn("خوش آمدید", mock_send.call_args[0][2])

    async def test_help_command(self):
        update = AsyncMock(spec=Update)
        update.effective_chat = MagicMock(spec=Chat)
        update.effective_chat.id = 12345

        with patch("bot.handlers.commands.send_message", new_callable=AsyncMock) as mock_send:
            await help_command(update, self.context)
            mock_send.assert_called_once()
            self.assertEqual(mock_send.call_args[0][1], 12345)
            self.assertIn("راهنمای", mock_send.call_args[0][2])

    def test_build_search_keyboard(self):
        items = [
            {"trackId": 101, "trackName": "Song 1", "artistName": "Artist 1"},
            {"trackId": 102, "trackName": "Song 2", "artistName": "Artist 2"},
            {"trackId": 103, "trackName": "Song 3", "artistName": "Artist 3"}
        ]
        markup = build_search_keyboard(items, page=1, search_id="s123", items_per_page=2)
        # Should contain 2 item rows + 1 nav row
        self.assertEqual(len(markup.inline_keyboard), 3)
        self.assertEqual(markup.inline_keyboard[0][0].callback_data, "dl_101")
        self.assertEqual(markup.inline_keyboard[1][0].callback_data, "dl_102")

    async def test_handle_text_message_direct_link(self):
        update = AsyncMock(spec=Update)
        update.effective_chat = MagicMock(spec=Chat, id=12345)
        update.effective_user = MagicMock(spec=User, id=99)
        update.message = MagicMock(spec=Message, text="https://www.youtube.com/watch?v=dQw4w9WgXcQ")

        await handle_text_message(update, self.context, self.download_service, self.direct_download_service)
        self.direct_download_service.download_direct.assert_called_once_with(
            12345, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", 99
        )

    async def test_handle_text_message_itunes_link(self):
        update = AsyncMock(spec=Update)
        update.effective_chat = MagicMock(spec=Chat, id=12345)
        update.effective_user = MagicMock(spec=User, id=99)
        update.message = MagicMock(spec=Message, text="https://music.apple.com/us/album/yellow/1440822606?i=1440822610")

        await handle_text_message(update, self.context, self.download_service, self.direct_download_service)
        self.download_service.download_and_send_track.assert_called_once_with(
            12345, "1440822610", 99
        )

    async def test_handle_text_message_plain_search(self):
        update = AsyncMock(spec=Update)
        update.effective_chat = MagicMock(spec=Chat, id=12345)
        update.effective_user = MagicMock(spec=User, id=99)
        update.message = MagicMock(spec=Message, text="Coldplay Yellow")

        with patch("bot.handlers.music.perform_search_and_reply", new_callable=AsyncMock) as mock_search:
            await handle_text_message(update, self.context, self.download_service, self.direct_download_service)
            mock_search.assert_called_once_with(12345, "Coldplay Yellow", self.context, search_type="all")

    async def test_handle_callback_query_download(self):
        update = AsyncMock(spec=Update)
        query = AsyncMock(spec=CallbackQuery)
        query.data = "dl_1440822610"
        query.message = MagicMock(spec=Message)
        query.message.chat = MagicMock(spec=Chat, id=12345)
        update.callback_query = query
        update.effective_chat = MagicMock(spec=Chat, id=12345)
        update.effective_user = MagicMock(spec=User, id=99)

        await handle_callback_query(update, self.context, self.download_service, self.direct_download_service)
        query.answer.assert_called_once()
        self.download_service.download_and_send_track.assert_called_once_with(
            12345, "1440822610", 99
        )

    async def test_handle_callback_query_preview(self):
        update = AsyncMock(spec=Update)
        query = AsyncMock(spec=CallbackQuery)
        query.data = "prev_1440822610"
        query.message = MagicMock(spec=Message, message_id=77)
        query.message.chat = MagicMock(spec=Chat, id=12345)
        update.callback_query = query
        update.effective_chat = MagicMock(spec=Chat, id=12345)
        update.effective_user = MagicMock(spec=User, id=99)

        with patch("bot.handlers.music.send_voice_preview", new_callable=AsyncMock) as mock_preview:
            await handle_callback_query(update, self.context, self.download_service, self.direct_download_service)
            query.answer.assert_called_once()
            mock_preview.assert_called_once_with(
                self.bot, 12345, "1440822610", 99, reply_to=77
            )

if __name__ == "__main__":
    unittest.main()
