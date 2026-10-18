import asyncio
import logging

logger = logging.getLogger("ABRAAVA:MESSAGES")


async def safe_delete(message):
    if not message:
        return
    try:
        await message.delete()
    except Exception as error:
        logger.debug(f"Message delete failed: {error}")


async def send_message(bot, chat_id, text, reply_markup=None, reply_to_message_id=None, **kwargs):
    try:
        return await bot.send_message(
            chat_id,
            text=text,
            reply_markup=reply_markup,
            reply_to_message_id=reply_to_message_id,
        )
    except Exception as error:
        logger.error(f"Send message failed: {error}")
        raise


async def edit_message(message, text, reply_markup=None, **kwargs):
    if not message:
        return None
    try:
        return await message.edit_text(
            text=text,
            reply_markup=reply_markup,
        )
    except Exception as error:
        if "not modified" in str(error).lower():
            return message
        logger.warning(f"Failed to edit message: {error}")
        raise