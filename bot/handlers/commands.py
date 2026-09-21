from telegram import Update
from telegram.ext import ContextTypes
from utils.messages import send_message
from core.config import BOT_NAME

WELCOME_TEXT = (
    f"🎵 *به ربات {BOT_NAME} خوش آمدید!*\n\n"
    "با استفاده از این ربات می‌توانید به راحتی موزیک‌های دلخواه خود را جستجو و دانلود کنید.\n\n"
    "📌 *قابلیت‌ها:*\n"
    "• 🔍 *جستجوی متنی:* کافیست اسم آهنگ یا خواننده را بفرستید.\n"
    "• 🔗 *دانلود از لینک:* پشتیبانی از لینک‌های اپل موزیک (iTunes)، اسپاتیفای، یوتیوب، ساندکلاد و دیزر.\n"
    "• 🎧 *پیش‌نمایش صوتی:* استماع پیش‌نمایش ۳۰ ثانیه‌ای موزیک‌ها.\n"
    "• 🏷️ *تگ‌های با کیفیت:* دانلود با بالاترین کیفیت همراه با کاور HD و مشخصات کامل.\n\n"
    "💡 *دستورات:* \n"
    "• /start - شروع کار با ربات\n"
    "• /help - راهنمای استفاده\n"
    "• /search <نام آهنگ> - جستجوی آهنگ\n"
    "• /album <نام آلبوم> - جستجوی آلبوم\n"
    "• /artist <نام هنرمند> - جستجوی خواننده\n"
    "• /ytm <نام آهنگ> - جستجو در یوتیوب موزیک\n"
    "• /sp <نام آهنگ> - جستجو در اسپاتیفای\n"
    "• /sc <نام آهنگ> - جستجو در ساندکلاد\n"
)

HELP_TEXT = (
    "📖 *راهنمای استفاده از ربات*\n\n"
    "1️⃣ *ارسال نام موزیک:* متن جستجو را مستقیماً پیام دهید.\n"
    "2️⃣ *ارسال لینک:* لینک موزیک را بفرستید تا بلافاصله دانلود و ارسال شود.\n"
    "3️⃣ *انتخاب از نتایج:* پس از جستجو، روی دکمه دانلود موزیک موردنظر کلیک کنید.\n"
)

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat:
        await send_message(context.bot, update.effective_chat.id, WELCOME_TEXT)

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat:
        await send_message(context.bot, update.effective_chat.id, HELP_TEXT)
