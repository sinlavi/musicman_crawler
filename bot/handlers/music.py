import uuid
import logging
from typing import Optional, List, Dict, Any
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes

from crawlers.itunes import search_itunes
from crawlers.utils import get_track, get_or_crawl_collection_tracks, get_or_crawl_artist_collections, music_adapter
from services.odesli_service import OdesliService
from services.search_cache_service import search_cache_service
from bot.handlers.preview import send_voice_preview
from utils.parser import parse_search_query
from utils.messages import send_message, edit_message, safe_delete

logger = logging.getLogger("ABRAAVA:BOT_MUSIC")

def build_search_keyboard(items: List[Dict[str, Any]], page: int = 1, search_id: Optional[str] = None, items_per_page: int = 5) -> InlineKeyboardMarkup:
    keyboard = []
    start_idx = (page - 1) * items_per_page
    end_idx = start_idx + items_per_page
    page_items = items[start_idx:end_idx]

    for item in page_items:
        track_id = item.get("trackId") or item.get("id")
        title = item.get("trackName") or item.get("title") or "Unknown"
        artist = item.get("artistName") or item.get("uploader") or "Unknown"

        btn_text = f"🎵 {artist[:15]} - {title[:20]}"
        row = [InlineKeyboardButton(btn_text, callback_data=f"dl_{track_id}")]

        # Add voice preview button if available
        if item.get("previewUrl") or item.get("wrapperType") == "track":
            row.append(InlineKeyboardButton("🎧", callback_data=f"prev_{track_id}"))

        keyboard.append(row)

    # Navigation buttons
    total_pages = (len(items) + items_per_page - 1) // items_per_page
    if total_pages > 1 and search_id:
        nav_row = []
        if page > 1:
            nav_row.append(InlineKeyboardButton("◀️ قبلی", callback_data=f"pg_{search_id}_{page-1}"))
        nav_row.append(InlineKeyboardButton(f"صفحه {page}/{total_pages}", callback_data="noop"))
        if page < total_pages:
            nav_row.append(InlineKeyboardButton("بعدی ▶️", callback_data=f"pg_{search_id}_{page+1}"))
        keyboard.append(nav_row)

    return InlineKeyboardMarkup(keyboard)


async def perform_search_and_reply(chat_id: int, term: str, context: ContextTypes.DEFAULT_TYPE, search_type: str = "all"):
    status_msg = await send_message(context.bot, chat_id, f"🔍 *در حال جستجو برای:* `{term}`...")

    results = []
    if search_type == "ytm":
        results = await music_adapter.search_ytm(term, entity_type="track")
    elif search_type == "sp":
        results = await music_adapter.search_spotify(term, entity_type="track")
    elif search_type == "sc":
        results = await music_adapter.search_sc(term)
    elif search_type == "itunes_official":
        results = await music_adapter.search_itunes_official(term, entity_type="track")
    else:
        resp = await search_itunes(term, limit=15)
        if resp and isinstance(resp, dict) and resp.get("results"):
            results = resp.get("results", [])

    if not results:
        await edit_message(status_msg, f"❌ متأسفانه نتایجی برای `{term}` یافت نشد.")
        return

    search_id = uuid.uuid4().hex[:8]
    user_id = chat_id
    await search_cache_service.store(search_id, search_type, term, results, user_id)

    reply_text = f"🔎 *نتایج جستجو برای:* `{term}`\nلطفاً موزیک موردنظر را انتخاب کنید:"
    reply_markup = build_search_keyboard(results, page=1, search_id=search_id)

    await safe_delete(status_msg)
    await send_message(context.bot, chat_id, reply_text, reply_markup=reply_markup)


async def handle_album_tracks(chat_id: int, collection_id: Any, context: ContextTypes.DEFAULT_TYPE):
    status_msg = await send_message(context.bot, chat_id, "💿 *در حال دریافت ترک‌های آلبوم...*")
    data = await get_or_crawl_collection_tracks(collection_id)

    if not data or not data.get("results"):
        await edit_message(status_msg, "❌ اطلاعات آلبوم یافت نشد.")
        return

    tracks = data.get("results", [])
    first = tracks[0] if tracks else {}
    album_name = first.get("collectionName", "Album")
    artist_name = first.get("artistName", "Artist")

    reply_text = f"💿 *آلبوم:* {album_name}\n🎤 *هنرمند:* {artist_name}\n\nیک موزیک را جهت دانلود انتخاب کنید:"
    reply_markup = build_search_keyboard(tracks, page=1, search_id=None, items_per_page=10)

    await safe_delete(status_msg)
    await send_message(context.bot, chat_id, reply_text, reply_markup=reply_markup)


async def handle_text_message(update: Update, context: ContextTypes.DEFAULT_TYPE, download_service, direct_download_service):
    if not update.effective_chat or not update.message or not update.message.text:
        return

    chat_id = update.effective_chat.id
    user_id = update.effective_user.id if update.effective_user else chat_id
    text = update.message.text.strip()

    parsed = await parse_search_query(text)
    if not parsed:
        return

    query_type, query_val = parsed

    if query_type == "direct_link":
        await direct_download_service.download_direct(chat_id, query_val, user_id)

    elif query_type == "music_link":
        resolved = await OdesliService.resolve_link(query_val)
        if resolved:
            if resolved.get("itunes_id"):
                await download_service.download_and_send_track(chat_id, resolved["itunes_id"], user_id)
            elif resolved.get("youtube_url"):
                await direct_download_service.download_direct(chat_id, resolved["youtube_url"], user_id)
            elif resolved.get("title"):
                search_term = f"{resolved.get('title')} {resolved.get('artist') or ''}".strip()
                await perform_search_and_reply(chat_id, search_term, context)
            else:
                await send_message(context.bot, chat_id, "❌ امکان دریافت اطلاعات این لینک وجود نداشت.")
        else:
            await send_message(context.bot, chat_id, "❌ خطایی در بررسی لینک رخ داد.")

    elif query_type == "itunes_track":
        await download_service.download_and_send_track(chat_id, query_val, user_id)

    elif query_type == "itunes_album":
        await handle_album_tracks(chat_id, query_val, context)

    elif query_type in ["ytm", "sp", "sc", "itunes_official", "track", "quick", "all"]:
        if query_val:
            await perform_search_and_reply(chat_id, query_val, context, search_type=query_type)
        else:
            await send_message(context.bot, chat_id, "لطفاً عبارتی برای جستجو وارد کنید.")


async def handle_callback_query(update: Update, context: ContextTypes.DEFAULT_TYPE, download_service, direct_download_service):
    query = update.callback_query
    if not query or not query.data:
        return

    await query.answer()

    chat_id = update.effective_chat.id if update.effective_chat else query.message.chat.id
    user_id = update.effective_user.id if update.effective_user else chat_id
    data = query.data

    if data == "noop":
        return

    if data.startswith("dl_"):
        track_id = data[3:]
        await download_service.download_and_send_track(chat_id, track_id, user_id)

    elif data.startswith("prev_"):
        track_id = data[5:]
        await send_voice_preview(context.bot, chat_id, track_id, user_id, reply_to=query.message.message_id)

    elif data.startswith("album_"):
        coll_id = data[6:]
        await handle_album_tracks(chat_id, coll_id, context)

    elif data.startswith("pg_"):
        parts = data.split("_")
        if len(parts) == 3:
            search_id = parts[1]
            page = int(parts[2])
            cached = await search_cache_service.get(search_id)
            if cached and "results" in cached:
                items = cached["results"]
                term = cached.get("term", "")
                reply_markup = build_search_keyboard(items, page=page, search_id=search_id)
                reply_text = f"🔎 *نتایج جستجو برای:* `{term}`\nصفحه {page}:"
                try:
                    await query.edit_message_text(text=reply_text, reply_markup=reply_markup)
                except Exception as e:
                    logger.debug(f"Failed to edit message text in pagination: {e}")
            else:
                await send_message(context.bot, chat_id, "⚠️ نتایج جستجو منقضی شده است. لطفاً دوباره جستجو کنید.")
