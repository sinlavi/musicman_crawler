from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters
from bot.handlers.commands import start_command, help_command
from bot.handlers.music import handle_text_message, handle_callback_query

def register_handlers(application: Application, download_service, direct_download_service):
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("help", help_command))

    async def _text_handler(update, context):
        await handle_text_message(update, context, download_service, direct_download_service)

    async def _callback_handler(update, context):
        await handle_callback_query(update, context, download_service, direct_download_service)

    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, _text_handler))
    application.add_handler(CallbackQueryHandler(_callback_handler))
