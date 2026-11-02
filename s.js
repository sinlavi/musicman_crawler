'use strict';

/* ══ CONFIG ══════════════════════════════════════════════════════════════════ */
const CFG = window.__MM_CONFIG__ || {},
      BASE = CFG.basePath || '', SCOPE = BASE + '/',
      API_BASE ='https://mm.3rah.ir/api',
      API_TOKEN = CFG.apiToken || 'change_me',
      TG_BOT = CFG.tgBotUsername || 'musicman_official_bot',
      GOOGLE_CLIENT_ID = CFG.googleClientId || '',
      PROVIDERS = CFG.providers || { telegram: false, google: false, email: true },
      HAS_DB = !!CFG.hasDb,
      IS_LOW_END = document.documentElement.classList.contains('low-end'),
      LONG_TRACK_MS = 48e4;

const KEY = {
  likes:'mm_likes', pls:'mm_playlists', recent:'mm_recent', downloads:'mm_downloads',
  plays:'mm_recently_played', following:'mm_followed', settings:'mm_settings',
  notes:'mm_notes', stats:'mm_stats_v1', queue:'mm_q_v2', vol:'mm_vol_v1', fptab:'mm_fptab_v1'
};
const SYNC_KEYS = ['likes','pls','following','plays','notes','stats','recent'];
const KEY_FOR = { likes:KEY.likes, pls:KEY.pls, following:KEY.following, plays:KEY.plays, notes:KEY.notes, stats:KEY.stats, recent:KEY.recent };
const DEF = {
  theme:'dark', animations:true, autoScrollLyrics:true, autoRetry:true, crossfade:0, sleepFade:true,
  accent:'auto', autoTheme:false, appBg:false, autoSaveAfterCrawl:false, saveData:false,
  autoSavePlayed:false, syncEnabled:true, lyricsTranslation:true, translationLang:'en',
  translationSourceLang:'en', autoExtendQueue:false, notifyDownloads:true, notifyCrawl:true,
  notifySync:true, notifyAuth:true, notifyPlaylist:true
};
const POLL_MS = IS_LOW_END ? 3500 : 2500, GRACE = 3e3, DEF_Q = '320',
      PTICK = IS_LOW_END ? 300 : 100, LTICK = IS_LOW_END ? 250 : 150;

/* ══ DOM HELPERS ═════════════════════════════════════════════════════════════ */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
let _mainEl = null;
const MAIN = () => _mainEl || (_mainEl = document.getElementById('main'));
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { _mainEl = document.getElementById('main') }, {once:true});
else _mainEl = document.getElementById('main');

const IS_DESKTOP = () => window.matchMedia('(min-width: 1024px)').matches;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const previewTagHtml = () => ' <span class="mm-preview-tag">PREVIEW</span>';

/* ══ STORAGE ═════════════════════════════════════════════════════════════════ */
const ls = {
  get(k,d){ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v) }catch{ return d } },
  set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)) }catch{} },
  remove(k){ try{ localStorage.removeItem(k) }catch{} }
};
const _lsSet = ls.set.bind(ls);
ls.set = function(k,v){
  _lsSet(k,v);
  if(SYNC_KEYS.some(s => KEY_FOR[s] === k)){
    try{ MMSync && MMSync.schedule && MMSync.schedule() }catch{}
  }
};

/* ══ GLOBAL UTILS ════════════════════════════════════════════════════════════ */
const cleanId   = id => id ? String(id).replace(/^it_/,'') : '';
const apiEndpoint = path => `${API_BASE.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
const proxyUrl = u => {
  if (!u) return '';

  const baleMessageId = String(u).match(/^bale:\/\/(?:message\/)?([^/?#]+)/i);
  const proxy = new URL(apiEndpoint('proxy'));
  if (baleMessageId && /^[A-Za-z0-9_-]+$/.test(baleMessageId[1])) {
    proxy.searchParams.set('message_id', baleMessageId[1]);
    return proxy.toString();
  }
  proxy.searchParams.set('url', u);
  return proxy.toString();
};

/* Some upstream sources (Telegram Bot API files, proxied through
   the audio proxy) respond 200 + Content-Length and then reset the socket
   mid-stream. Chrome reports net::ERR_CONNECTION_RESET even though
   status was 200. <audio> streaming dies on this; a full fetch() works
   (that's why the browser download path succeeds). For these URLs we
   bypass streaming entirely and play from a Blob URL. */
function isStreamUnfriendly(u){
  if(!u) return false;
  return /api\.telegram\.org\/file\/bot/i.test(String(u));
}
const audioProxyUrl = u => {
  if (!u) return '';

  const proxy = new URL(apiEndpoint('proxy'));
  proxy.searchParams.set('url', u);
  return proxy.toString();
};
const haptic    = ms => { try{ navigator.vibrate?.(ms) }catch{} };
const tgLink    = (type,id) => id ? `https://t.me/${TG_BOT}?start=${type}_${cleanId(id)}` : '';
const getSettings = () => ({...DEF, ...ls.get(KEY.settings,{})});
function setSetting(k,v){ const s = getSettings(); s[k] = v; ls.set(KEY.settings, s); applySettings(); }

/* ══ CONNECTION-AWARE ════════════════════════════════════════════════════════ */
const Net = {
  get conn(){ return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null },
  get saveData(){ return !!(this.conn && this.conn.saveData) || getSettings().saveData },
  get isSlow(){
    const c = this.conn; if(!c) return false;
    const et = String(c.effectiveType || '').toLowerCase();
    return et === 'slow-2g' || et === '2g' || et === '3g';
  },
  get isFast(){
    const c = this.conn; if(!c) return true;
    const et = String(c.effectiveType || '').toLowerCase();
    return et === '4g' || et === '5g' || /wifi/i.test(et || '');
  },
  get online(){ return navigator.onLine }
};
function _syncSaveDataAttr(){
  document.documentElement.setAttribute('data-save-data', (Net.saveData || Net.isSlow) ? '1' : '0');
}

/* ══ SAFE AREA ═══════════════════════════════════════════════════════════════ */
function detectSafeAreas(){
  try{
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;top:0;left:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);visibility:hidden;pointer-events:none;';
    document.body.appendChild(p);
    const cs = getComputedStyle(p);
    document.documentElement.style.setProperty('--safe-top', (parseFloat(cs.paddingTop)||0) + 'px');
    document.documentElement.style.setProperty('--safe-bottom', (parseFloat(cs.paddingBottom)||0) + 'px');
    p.remove();
  }catch{}
}
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ══ INJECTED STYLES ═════════════════════════════════════════════════════════ */
(function injectStyles(){
  const css = `
:focus{outline:none}
/* image fade-in: JS-driven, restored */
img.mm-fade{opacity:0;transition:opacity .25s var(--mm-ease, ease)}
img.mm-fade.mm-loaded{opacity:1}
img.mm-fade:not(.mm-loaded){animation:mmFadeFallback 0s 1.5s forwards}
@keyframes mmFadeFallback{to{opacity:1}}
@media (prefers-reduced-motion: reduce){
  img.mm-fade{transition:none}
  img.mm-fade:not(.mm-loaded){animation:none;opacity:1}
}
html[data-save-data="1"] img.mm-fade{transition-duration:.15s}

#toast{touch-action:pan-y;transition:transform .22s var(--mm-ease, ease), opacity .22s}
#toast.mm-dismissing{transform:translateY(120%);opacity:0}

#mm-progress{position:fixed;top:0;left:0;right:0;height:2px;z-index:99999;pointer-events:none;background:transparent;overflow:hidden}
#mm-progress>i{display:block;height:100%;width:0;background:var(--mm-accent-grad,linear-gradient(90deg,#7b2ff7,#f107a3));transition:width .3s ease,opacity .3s ease;opacity:0}
#mm-progress.on>i{opacity:1}
#mm-progress.done>i{width:100% !important;opacity:0;transition:width .2s ease, opacity .4s ease}

#offlineBanner{position:fixed;top:var(--safe-top,0);left:0;right:0;z-index:9998;padding:8px 14px;background:var(--bs-warning);color:#111;font-size:.78rem;font-weight:700;text-align:center;transform:translateY(-100%);transition:transform .28s ease;pointer-events:none}
#offlineBanner.on{transform:translateY(0)}

.page-enter{animation:mm-page-in .22s ease both}
@keyframes mm-page-in{from{opacity:.4;transform:translateY(4px)}to{opacity:1;transform:none}}

/* skeleton perf */
.sk,.sk-card,.sk-row,.sk-art,.sk-hero-art,.sk-l,.sk-c,.sk-lines,.sk-search-box,.sk-section-head,.sk-head,.sk-actions,.sk-stat-grid,.sk-week-chart,.sk-feed,.sk-fhead,.sk-fbody,.sk-settings-row,.sk-hist-row,.sk-dl-row,.sk-artist-card,.sk-tabs,.sk-filter-row{contain:layout paint style}
.sk-page{contain:layout}
.sk-page > *{content-visibility:auto; contain-intrinsic-size:auto 320px}
.ai-list-section,.artist-section,.lyrics-card,.crawl-card,.stat-grid,.mm-grid>.card-item,.mm-grid>.artist-item{content-visibility:auto; contain-intrinsic-size:auto 96px}
.row-item{content-visibility:auto; contain-intrinsic-size:auto 60px}

@media (prefers-reduced-motion: reduce){
  .page-enter{animation:none}
  .sk{animation:none;background:var(--mm-surface-2)}
  *,*::before,*::after{animation-duration:.001ms !important;transition-duration:.001ms !important}
}

.app-bar.mm-scrolled{box-shadow:0 4px 18px rgba(0,0,0,.28)}
.search-suggest{max-height:min(58vh,420px);overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;contain:layout paint}
.search-suggest .sg-loading,.search-suggest .sg-empty{position:sticky;top:0}
.search-box .mic-btn{transition:color .2s,transform .2s}
.search-box .mic-btn.recording{color:var(--bs-danger) !important;animation:mic-pulse 1.1s ease-in-out infinite}
@keyframes mic-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.08)}}
.fp-lyrics-head{display:flex;align-items:center;gap:8px;padding:10px 14px 8px;position:sticky;top:0;z-index:3}
.fp-lyrics-title{flex:1;opacity:0}
.fp-lyrics-title i{color:var(--bs-primary)}
.lyrics-trans-btn.on{color:var(--bs-primary) !important}
.mm-drag-handle{cursor:grab}
.lyric-trans{font-size:.82em;opacity:.72;font-style:italic;margin-top:3px;line-height:1.35;color:var(--bs-secondary-color);transition:opacity .25s ease}
.lyric-line.active .lyric-trans{opacity:.95;color:var(--bs-body-color)}
.lyric-trans-spin{display:inline-block;opacity:.5;animation:ltr-spin 1.2s linear infinite}
.lyric-trans.done .lyric-trans-spin{display:none}
@keyframes ltr-spin{to{transform:rotate(360deg)}}
.lyrics-body,.fp-lyrics-body,#lyricsBody,#rpLyricsBody,.fp-tabbody{overflow-anchor:none}
.lyric-line{overflow-anchor:none;scroll-margin-block:40vh}

.mm-preview-tag{display:inline-block;font-size:.6em;font-weight:800;letter-spacing:.08em;background:rgba(255,166,0,.22);color:#ffa600;border-radius:6px;padding:1px 6px;margin-left:6px;vertical-align:middle}
.row-item,.card-item,.icon-btn,.pill-btn,.artist-item,.dl-row{transition:transform .12s ease,background-color .12s ease,opacity .12s ease}
.row-item:active,.card-item:active,.artist-item:active,.dl-row:active{transform:scale(.985)}
.icon-btn:active,.pill-btn:active{transform:scale(.94)}
.state.mm-empty{padding:56px 24px 40px;text-align:center}
.state.mm-empty i{font-size:2.4rem;opacity:.4;color:var(--bs-primary)}
.state.mm-empty p{margin-top:14px}
.search-wrap.mm-scrolled .search-box{box-shadow:0 3px 14px rgba(0,0,0,.2)}

`;
  const s = document.createElement('style');
  s.setAttribute('data-mm','enhanced-4');
  s.textContent = css;
  document.head.appendChild(s);
})();

/* ══ PROGRESS BAR ════════════════════════════════════════════════════════════ */
const Progress = {
  el: null, _t: null,
  init(){ if(this.el) return; const d=document.createElement('div'); d.id='mm-progress'; d.innerHTML='<i></i>'; document.body.appendChild(d); this.el=d; },
  start(){ if(!this.el) this.init(); this.el.classList.remove('done'); this.el.classList.add('on'); clearTimeout(this._t); this._t = setTimeout(()=>this.done(), 12000); },
  done(){ if(!this.el) return; clearTimeout(this._t); this.el.classList.add('done'); setTimeout(()=>{ this.el.classList.remove('on','done'); const bar=this.el.querySelector('i'); if(bar) bar.style.width='0'; }, 400); }
};

/* ══ IMAGE FADE-IN — batched, non-blocking ═══════════════════════════════════ */
const _pendingFade = new Set();
let _fadeRaf = 0;
function _flushFade(){
  _fadeRaf = 0;
  if(!_pendingFade.size) return;
  for(const img of _pendingFade){
    if(!img.isConnected || img.classList.contains('mm-fade')) continue;
    img.classList.add('mm-fade');
    if(img.complete && img.naturalWidth) img.classList.add('mm-loaded');
    else {
      const done = () => img.classList.add('mm-loaded');
      img.addEventListener('load', done, {once:true});
      img.addEventListener('error', done, {once:true});
    }
  }
  _pendingFade.clear();
}
function _queueFade(node){
  if(!node || node.nodeType !== 1 || node.tagName !== 'IMG') return;
  if(node.classList.contains('mm-fade')) return;
  _pendingFade.add(node);
  if(!_fadeRaf) _fadeRaf = requestAnimationFrame(_flushFade);
}
function mmFadeImages(root = document){
  if(!root || root.nodeType !== 1) return;
  if(root.tagName === 'IMG'){ _queueFade(root); return }
  const imgs = root.querySelectorAll('img:not(.mm-fade)');
  if(!imgs.length) return;
  for(const img of imgs) _pendingFade.add(img);
  if(!_fadeRaf) _fadeRaf = requestAnimationFrame(_flushFade);
}
const _fadeObs = 'MutationObserver' in window ? new MutationObserver(muts => {
  let found = false;
  for(const m of muts){
    const added = m.addedNodes;
    if(!added || !added.length) continue;
    for(let i=0;i<added.length;i++){
      const n = added[i];
      if(n.nodeType !== 1) continue;
      if(n.tagName === 'IMG'){
        if(!n.classList.contains('mm-fade')){ _pendingFade.add(n); found = true }
      } else if(n.querySelectorAll){
        const imgs = n.querySelectorAll('img:not(.mm-fade)');
        if(imgs.length){ for(const x of imgs) _pendingFade.add(x); found = true }
      }
    }
  }
  if(found && !_fadeRaf) _fadeRaf = requestAnimationFrame(_flushFade);
}) : null;
if(_fadeObs){
  const start = () => _fadeObs.observe(document.documentElement, {childList:true, subtree:true});
  if(document.body) start();
  else document.addEventListener('DOMContentLoaded', start, {once:true});
}
document.addEventListener('mm:route', () => { try{ mmFadeImages(MAIN()) }catch{} }, {passive:true});

/* ══ IMAGE PREFETCH ══════════════════════════════════════════════════════════ */
const _imgPrefetched = new Set(), _IMG_PREFETCH_MAX = 60;
function prefetchArtwork(url){
  if(!url || _imgPrefetched.has(url)) return;
  if(Net.saveData || Net.isSlow) return;
  if(_imgPrefetched.size >= _IMG_PREFETCH_MAX) return;
  _imgPrefetched.add(url);
  const img = new Image();
  img.decoding = 'async';
  try{ img.fetchPriority = 'low' }catch{}
  img.referrerPolicy = 'no-referrer';
  img.src = url;
}
window.prefetchArtwork = prefetchArtwork;

/* ══ TELEGRAM DEEP LINKS ═════════════════════════════════════════════════════ */
function toTgDeepLink(u){
  if(!u) return null;
  try{
    const x = new URL(u);
    if(!['t.me','telegram.me','telegram.dog'].includes(x.hostname)) return null;
    const p = x.pathname.replace(/^\/+/,'').split('/').filter(Boolean);
    if(!p.length) return null;
    const d = new URLSearchParams();
    d.set('domain', p[0]); if(p[1]) d.set('post', p[1]);
    const q = new URLSearchParams(x.search || '');
    ['start','startgroup'].forEach(k => { const v = q.get(k); if(v) d.set(k,v) });
    return 'tg://resolve?' + d.toString();
  }catch{ return null }
}
function openTgUrl(u){
  if(!u) return;
  const d = toTgDeepLink(u);
  if(!d){ window.open(u,'_blank','noopener'); return }
  if(/TelegramBot|Telegram/i.test(navigator.userAgent || '')){ location.href = u; return }
  let f = false;
  const fb = () => { if(f) return; f = true; window.location.href = u };
  const t = setTimeout(fb, 1200);
  const oh = () => { clearTimeout(t); document.removeEventListener('visibilitychange', vh); window.removeEventListener('blur', oh); window.removeEventListener('pagehide', oh) };
  const vh = () => { if(document.hidden) oh() };
  document.addEventListener('visibilitychange', vh);
  window.addEventListener('blur', oh);
  window.addEventListener('pagehide', oh);
  try{ window.location.href = d } catch{ fb() }
}
const tgStart = (k,id) => { const u = tgLink(k,id); if(u) openTgUrl(u) };
window.openTgUrl = openTgUrl; window.toTgDeepLink = toTgDeepLink;

/* ══ FORMATTERS ══════════════════════════════════════════════════════════════ */
function fmtTime(s){
  s = Number(s);
  if(!s || !isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), x = s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}` : `${m}:${String(x).padStart(2,'0')}`;
}
function fmtCompact(n){
  n = Number(n)||0;
  if(n<1e3) return String(n);
  if(n<1e6){ const v=n/1e3; return (v<10?v.toFixed(1):String(Math.round(v))).replace(/\.0$/,'')+'K' }
  const v = n/1e6; return (v<10?v.toFixed(1):String(Math.round(v))).replace(/\.0$/,'')+'M';
}
function fmtSize(b){
  b = Number(b)||0;
  if(b<1024) return b+' B';
  if(b<1048576) return (b/1024).toFixed(1)+' KB';
  if(b<1073741824) return (b/1048576).toFixed(1)+' MB';
  return (b/1073741824).toFixed(2)+' GB';
}
function fmtAgo(ts){
  const d = Date.now() - (Number(ts)||0);
  if(d<6e4) return 'just now';
  if(d<36e5) return Math.floor(d/6e4)+'m ago';
  if(d<864e5) return Math.floor(d/36e5)+'h ago';
  if(d<6048e5) return Math.floor(d/864e5)+'d ago';
  return new Date(ts).toLocaleDateString();
}
const safeFileName = s => {
  const o = String(s||'track').replace(/[\\/:*?"<>|\u0000-\u001f]+/g,'_').replace(/\s+/g,' ').trim().slice(0,90);
  return o || 'track';
};
function extFromType(t,u){
  t = String(t||'').toLowerCase();
  if(t.includes('mpeg')||t.includes('mp3')) return '.mp3';
  if(t.includes('mp4')||t.includes('m4a')) return '.m4a';
  if(t.includes('aac')) return '.aac';
  if(t.includes('ogg')||t.includes('opus')) return '.ogg';
  if(t.includes('webm')) return '.webm';
  if(t.includes('wav')) return '.wav';
  if(t.includes('flac')) return '.flac';
  const m = String(u||'').split('?')[0].match(/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i);
  return m ? '.'+m[1].toLowerCase() : '.mp3';
}

/* ══ COUNT BADGES — indexed ══════════════════════════════════════════════════ */
let _likeBtnsById = new Map(), _followBtnsById = new Map();
function reindexActionButtons(){
  _likeBtnsById = new Map(); _followBtnsById = new Map();
  document.querySelectorAll('[data-like]').forEach(b => {
    const id = b.dataset.like; if(!id) return;
    let arr = _likeBtnsById.get(id); if(!arr){ arr=[]; _likeBtnsById.set(id,arr) } arr.push(b);
  });
  document.querySelectorAll('[data-follow]').forEach(b => {
    const id = b.dataset.follow; if(!id) return;
    let arr = _followBtnsById.get(id); if(!arr){ arr=[]; _followBtnsById.set(id,arr) } arr.push(b);
  });
}
function setLikeCount(id,n){
  id = String(id); n = Math.max(0, Number(n)||0);
  const arr = _likeBtnsById.get(id);
  if(arr){ for(const b of arr){ b.dataset.likes=String(n); const s=b.querySelector('.like-count'); if(s) s.textContent=n>0?fmtCompact(n):'' } return }
  $$(`[data-like="${CSS.escape(id)}"]`).forEach(b=>{ b.dataset.likes=String(n); const s=b.querySelector('.like-count'); if(s) s.textContent=n>0?fmtCompact(n):'' });
}
function bumpLikeCount(id,d){
  id = String(id);
  const arr = _likeBtnsById.get(id);
  if(arr){ for(const b of arr){ const c=Number(b.dataset.likes)||0, n=Math.max(0,c+d); b.dataset.likes=String(n); const s=b.querySelector('.like-count'); if(s) s.textContent=n>0?fmtCompact(n):'' } return }
  $$(`[data-like="${CSS.escape(id)}"]`).forEach(b=>{ const c=Number(b.dataset.likes)||0, n=Math.max(0,c+d); b.dataset.likes=String(n); const s=b.querySelector('.like-count'); if(s) s.textContent=n>0?fmtCompact(n):'' });
}
function setFollowerCount(id,n){
  id = String(id); n = Math.max(0, Number(n)||0);
  const arr = _followBtnsById.get(id);
  if(arr) for(const b of arr){ b.dataset.followers=String(n); const s=b.querySelector('.follow-count'); if(s) s.textContent=n>0?fmtCompact(n):'' }
  else $$(`[data-follow="${CSS.escape(id)}"]`).forEach(b=>{ b.dataset.followers=String(n); const s=b.querySelector('.follow-count'); if(s) s.textContent=n>0?fmtCompact(n):'' });
  $$(`[data-followers-for="${CSS.escape(id)}"]`).forEach(e=>{ e.dataset.followers=String(n); e.textContent=n>0?fmtCompact(n)+' followers':'' });
}
function bumpFollowerCount(id,d){
  id = String(id);
  const arr = _followBtnsById.get(id);
  if(arr) for(const b of arr){ const c=Number(b.dataset.followers)||0, n=Math.max(0,c+d); b.dataset.followers=String(n); const s=b.querySelector('.follow-count'); if(s) s.textContent=n>0?fmtCompact(n):'' }
  else $$(`[data-follow="${CSS.escape(id)}"]`).forEach(b=>{ const c=Number(b.dataset.followers)||0, n=Math.max(0,c+d); b.dataset.followers=String(n); const s=b.querySelector('.follow-count'); if(s) s.textContent=n>0?fmtCompact(n):'' });
  $$(`[data-followers-for="${CSS.escape(id)}"]`).forEach(e=>{ const c=Number(e.dataset.followers)||0, n=Math.max(0,c+d); e.dataset.followers=String(n); e.textContent=n>0?fmtCompact(n)+' followers':'' });
}

/* ══ LINK BUILDERS ═══════════════════════════════════════════════════════════ */
function artistLink(it, sp){
  const n = it?.artistName || ''; if(!n) return '';
  const id = it?.artistId ? String(it.artistId) : '';
  const a = sp ? ' onclick="event.stopPropagation()"' : '';
  return id ? `<a class="mm-link" href="${SCOPE}artist/${esc(id)}" data-link${a}>${esc(n)}</a>` : esc(n);
}
function albumLink(it, sp){
  const n = it?.collectionName || it?.albumName || ''; if(!n) return '';
  const id = it?.collectionId || it?.albumId ? String(it.collectionId || it.albumId) : '';
  const a = sp ? ' onclick="event.stopPropagation()"' : '';
  return id ? `<a class="mm-link" href="${SCOPE}album/${esc(id)}" data-link${a}>${esc(n)}</a>` : esc(n);
}
const badgeChip = (k,i,l) => `<span class="badge-chip ${k}"><i class="bi ${i}"></i>${esc(l)}</span>`;
const progressHtml = (p,k='') => `<div class="progress mt-2" style="height:5px;border-radius:999px;background:var(--mm-surface-3);overflow:hidden"><div class="progress-bar ${k}" style="width:${Math.max(0,Math.min(100,p))}%"></div></div>`;
const emptyState = (i,t,s='') => `<div class="state mm-empty"><i class="bi bi-${i}"></i><p class="fw-semibold text-body">${esc(t)}</p>${s?`<p class="mt-1" style="font-size:.78rem">${esc(s)}</p>`:''}</div>`;
const errorState = m => `<div class="state mm-empty"><i class="bi bi-exclamation-triangle text-danger"></i><p class="fw-semibold text-body">Something went wrong</p><p class="mt-1" style="font-size:.78rem">${esc(m||'Unknown error')}</p><button class="pill-btn mt-3" onclick="route()"><i class="bi bi-arrow-clockwise"></i> Retry</button></div>`;
const secTitle = (t,tight=false) => `<h6 class="sec-title ${tight?'tight':''}">${esc(t)}</h6>`;
const PLAYER_EMPTY = (i,t) => `<div class="fp-lyrics-empty"><i class="bi ${i}"></i>${esc(t)}</div>`;
const backBtn = () => `<div class="px-2 pt-2"><button class="icon-btn" onclick="goBack()" aria-label="Back"><i class="bi bi-chevron-left" style="font-size:1.5rem"></i></button></div>`;

/* ══ NOTIFY ══════════════════════════════════════════════════════════════════ */
const Notify = {
  ok(){ return typeof Notification !== 'undefined' && Notification.permission === 'granted' },
  async request(){
    if(typeof Notification === 'undefined') return false;
    if(Notification.permission === 'granted') return true;
    if(Notification.permission === 'denied') return false;
    try{ return (await Notification.requestPermission()) === 'granted' }catch{ return false }
  },
  _enabled(category){
    const s = getSettings();
    if(category === 'download')  return s.notifyDownloads !== false;
    if(category === 'crawl')     return s.notifyCrawl !== false;
    return true;
  },
  /* Only fire a toast when the caller explicitly asks via `toast: true`.
     Only fire a system notification when the tab is hidden (or always:true).
     This eliminates double-toasting and in-app notification spam. */
  show(t,b,o={}){
    if(o.toast) try{ toast(b||t, o.variant||'success') }catch{}
    if(!this._enabled(o.category)) return;
    if(!this.ok()) return;
    if(document.visibilityState === 'visible' && !o.always) return;
    try{
      const n = new Notification(t, {
        body:b||'', icon:o.icon||undefined, badge:o.badge||undefined,
        tag:o.tag||'mm-notify', silent:!!o.silent
      });
      n.onclick = () => { try{ window.focus(); if(o.url) location.href=o.url; n.close() }catch{} };
      return n;
    }catch{}
  }
};

/* ══ TRANSLATION ═════════════════════════════════════════════════════════════ */
const TRANSLATION_LANGS = [
  {code:'en',label:'English',flag:'🇺🇸'},{code:'fa',label:'Persian',flag:'🇮🇷'},{code:'ar',label:'Arabic',flag:'🇸🇦'},
  {code:'tr',label:'Turkish',flag:'🇹🇷'},{code:'es',label:'Spanish',flag:'🇪🇸'},{code:'fr',label:'French',flag:'🇫🇷'},
  {code:'de',label:'German',flag:'🇩🇪'},{code:'it',label:'Italian',flag:'🇮🇹'},{code:'ru',label:'Russian',flag:'🇷🇺'},
  {code:'zh',label:'Chinese',flag:'🇨🇳'},{code:'ja',label:'Japanese',flag:'🇯🇵'},{code:'ko',label:'Korean',flag:'🇰🇷'},
  {code:'hi',label:'Hindi',flag:'🇮🇳'},{code:'pt',label:'Portuguese',flag:'🇵🇹'},{code:'nl',label:'Dutch',flag:'🇳🇱'},
  {code:'pl',label:'Polish',flag:'🇵🇱'},{code:'sv',label:'Swedish',flag:'🇸🇪'},{code:'he',label:'Hebrew',flag:'🇮🇱'},
  {code:'id',label:'Indonesian',flag:'🇮🇩'},{code:'vi',label:'Vietnamese',flag:'🇻🇳'}
];
const POPULAR_LANGS = ['en','fa','ar','tr','es','fr','de','ru','hi','zh','ja','ko'];
const _langs = () => TRANSLATION_LANGS;
const _findLang = c => _langs().find(l => l.code === c) || {code:c, label:c, flag:'🌐'};

window.refreshLyricsTransBtn = function(){
  ['lyricsTransBtn','fpLyricsTransBtn'].forEach(id=>{
    const btn = document.getElementById(id); if(!btn) return;
    const s = getSettings(), e = s.lyricsTranslation !== false, t = s.translationLang || 'en', sr = s.translationSourceLang || 'auto';
    const a = e && t && t !== sr;
    btn.classList.toggle('on', a);
    btn.title = a ? `Translating to ${_findLang(t).label}` : 'Translate lyrics';
  });
};
window.openLyricsLangPopover = function(ev){
  if(ev){ ev.preventDefault(); ev.stopPropagation() }
  renderLangPickerList('');
  const el = document.getElementById('langPickerSearch'); if(el) el.value = '';
  sheet('#sheetLangPicker').show();
  setTimeout(()=>el && el.focus(), 320);
};
function renderLangPickerList(q){
  const h = document.getElementById('langPickerList'); if(!h) return;
  const s = getSettings(), e = s.lyricsTranslation !== false, c = s.translationLang || 'en';
  const Q = (q||'').toLowerCase().trim(), all = _langs(),
        pop = POPULAR_LANGS.map(x=>all.find(l=>l.code===x)).filter(Boolean),
        list = Q ? pop.filter(l=>(l.label+' '+l.code).toLowerCase().includes(Q)) : pop;
  let html = '';
  if(!Q) html += `<div class="px-2"><button class="sheet-item ${!e?'lang-picked':''}" data-lang="__off__"><i class="bi bi-x-circle"></i><span class="flex-grow-1">Off</span>${!e?'<i class="bi bi-check2 text-primary"></i>':''}</button></div><div class="sheet-title" style="padding-top:14px">Languages</div>`;
  if(!list.length){ h.innerHTML = html + `<div class="state mm-empty" style="padding:40px 24px"><i class="bi bi-search"></i><p>No languages found</p></div>`; return }
  html += `<div class="px-2">` + list.map(l=>{
    const a = e && c === l.code;
    return `<button class="sheet-item ${a?'lang-picked':''}" data-lang="${l.code}"><span class="lang-flag">${l.flag||'🌐'}</span><span class="flex-grow-1">${l.label}</span>${a?'<i class="bi bi-check2 text-primary ms-2"></i>':''}</button>`;
  }).join('') + `</div>`;
  h.innerHTML = html;
}
function pickLang(c){
  if(c === '__off__'){ setSetting('lyricsTranslation', false); toast('Translation off'); }
  else { setSetting('translationLang', c); setSetting('lyricsTranslation', true); toast(`Translating to ${_findLang(c).label}`); }
  rerenderLyricsTranslations(); refreshLyricsTransBtn(); sheet('#sheetLangPicker').hide(); haptic(10);
}
function _wireLangPicker(){
  const h = document.getElementById('langPickerList'), s = document.getElementById('langPickerSearch');
  if(h && !h.__wired){ h.__wired = true; h.addEventListener('click', e => { const b = e.target.closest('[data-lang]'); if(b) pickLang(b.dataset.lang) }) }
  if(s && !s.__wired){ s.__wired = true; let dt = null; s.addEventListener('input', () => { clearTimeout(dt); dt = setTimeout(()=>renderLangPickerList(s.value), 80) }) }
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wireLangPicker);
else _wireLangPicker();

window.rerenderLyricsTranslations = function(){
  try{
    document.querySelectorAll('#lyricsBody, .fp-lyrics-body, #rpLyricsBody').forEach(c=>{
      const d = c._lyricsData; if(!d) return;
      c.querySelectorAll('.lyric-trans').forEach(e=>e.remove());
      const s = getSettings(); if(s.lyricsTranslation === false) return;
      const t = s.translationLang || 'en', sr = s.translationSourceLang || 'auto';
      if(t === sr) return;
      d.elByLineIdx.forEach((el,idx)=>{
        const txt = el.querySelector('.lyric-orig')?.textContent.trim() || '';
        if(!txt || txt === '\u00A0') return;
        const e = document.createElement('div');
        e.className = 'lyric-trans';
        e.innerHTML = `<span class="lyric-trans-spin"><i class="bi bi-arrow-repeat"></i></span>`;
        el.appendChild(e);
        translateText(txt,t,sr).then(o=>{ if(!o){ e.remove(); return } e.innerHTML = esc(o); e.classList.add('done') }).catch(()=>e.remove());
      });
    });
  }catch(e){ console.warn('[rerenderLyrics]', e) }
};

const _transCache = new Map(), _TRANS_MAX = 800, _transInflight = new Map(), _detectedPerTrack = new Map();
async function _provGoogle(t,tl,sl,sg){
  const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl||'auto'}&tl=${tl}&dt=t&q=${encodeURIComponent(t)}`;
  const r = await fetch(u, {signal:sg, mode:'cors', credentials:'omit'});
  if(!r.ok) throw new Error('google '+r.status);
  const d = await r.json();
  if(!Array.isArray(d) || !Array.isArray(d[0])) throw new Error('bad');
  return {text: d[0].map(x=>x[0]||'').join('').trim(), detected: d[2]||'auto'};
}
async function _provMyMemory(t,tl,sl,sg){
  const s = (!sl || sl === 'auto') ? 'en' : sl;
  const u = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(t)}&langpair=${s}|${tl}`;
  const r = await fetch(u, {signal:sg});
  if(!r.ok) throw new Error('mymemory '+r.status);
  const d = await r.json();
  const o = (d?.responseData?.translatedText||'').trim();
  if(!o || /^MYMEMORY\s+WARNING/i.test(o) || /^PLEASE\s+SELECT/i.test(o)) throw new Error('bad');
  return {text:o, detected:s};
}
async function _provLibre(t,tl,sl,sg){
  const s = (!sl || sl === 'auto') ? 'auto' : sl;
  const r = await fetch('https://libretranslate.com/translate', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({q:t, source:s, target:tl, format:'text'}), signal: sg});
  if(!r.ok) throw new Error('libre '+r.status);
  const d = await r.json(); if(!d.translatedText) throw new Error('empty');
  return {text:String(d.translatedText).trim(), detected: d.detectedLanguage?.language || s};
}
const _PROVIDERS = [_provGoogle, _provMyMemory, _provLibre];
async function translateText(text,tl,sl){
  const s = getSettings();
  tl = tl || s.translationLang || 'en';
  sl = sl || s.translationSourceLang || 'auto';
  if(!text || !text.trim() || text.trim().length<2) return '';
  if(tl === sl) return '';
  const tid = Player?.track?.trackId ? String(Player.track.trackId) : null;
  let es = sl;
  if(sl === 'auto' && tid && _detectedPerTrack.has(tid)) es = _detectedPerTrack.get(tid);
  if(es === tl) return '';
  const c = text.trim().slice(0,480), k = `${es}>${tl}|${c.slice(0,120)}`;
  if(_transCache.has(k)) return _transCache.get(k);
  if(_transInflight.has(k)) return _transInflight.get(k);
  const ctrl = new AbortController(), to = setTimeout(()=>ctrl.abort(), 1e4);
  const p = (async () => {
    for(const prov of _PROVIDERS){
      try{
        const r = await prov(c, tl, es, ctrl.signal);
        if(!r || !r.text) continue;
        if(tid && r.detected && r.detected !== 'auto' && es === 'auto'){
          _detectedPerTrack.set(tid, r.detected);
          if(_detectedPerTrack.size > 200) _detectedPerTrack.delete(_detectedPerTrack.keys().next().value);
        }
        if(r.detected && r.detected === tl) continue;
        if(_transCache.size >= _TRANS_MAX) _transCache.delete(_transCache.keys().next().value);
        _transCache.set(k, r.text); clearTimeout(to); return r.text;
      }catch{}
    }
    clearTimeout(to); return '';
  })().finally(() => _transInflight.delete(k));
  _transInflight.set(k, p);
  return p;
}
function lyricTranslationHtml(text,li){
  const s = getSettings();
  if(s.lyricsTranslation === false) return '';
  if(!text || !text.trim()) return '';
  const l = s.translationLang || 'en';
  if(l === (s.translationSourceLang || 'en')) return '';
  return `<div class="lyric-trans" data-line="${li}" data-text="${esc(text.trim().slice(0,200))}"><span class="lyric-trans-spin"><i class="bi bi-arrow-repeat"></i></span></div>`;
}
function loadLyricTranslation(el,t,l){
  if(!el || !t || !l) return;
  translateText(t,l).then(o => { if(!o){ el.remove(); return } el.innerHTML = esc(o); el.classList.add('done') }).catch(()=>el.remove());
}

/* ══ ACCENTS ═════════════════════════════════════════════════════════════════ */
const ACCENTS = {
  auto:null, purple:['#7b2ff7','#f107a3'], blue:['#3b82f6','#06b6d4'], green:['#10b981','#84cc16'],
  orange:['#f97316','#facc15'], pink:['#ec4899','#f43f5e'], teal:['#14b8a6','#0ea5e9'],
  indigo:['#6366f1','#a855f7'], slate:['#64748b','#334155']
};
function parseRGB(c){
  if(!c) return [123,47,247];
  if(Array.isArray(c)) return c.map(v => Math.max(0, Math.min(255, Math.round(v))));
  if(c.startsWith('rgb')){ const m = c.match(/\d+/g); if(m && m.length>=3) return [+m[0],+m[1],+m[2]] }
  let h = c.replace('#','').trim();
  if(h.length === 3) h = h.split('').map(x=>x+x).join('');
  const n = parseInt(h,16); if(isNaN(n)) return [123,47,247];
  return [(n>>16)&255, (n>>8)&255, n&255];
}
function applyAccent(n, colors){
  let c1, c2;
  if(Array.isArray(colors)){ c1 = colors[0]; c2 = colors[1] || colors[0] }
  else if(n === 'auto'){ c1='#7b2ff7'; c2='#f107a3' }
  else { [c1,c2] = ACCENTS[n] || ACCENTS.purple }
  const [r,g,b] = parseRGB(c1), d = document.documentElement.getAttribute('data-bs-theme') !== 'light';
  let ar=r, ag=g, ab=b;
  const lum = .2126*r + .7152*g + .0722*b;
  if(d && lum < 70){ const f = 85/(lum||1); ar=Math.min(255,Math.round(r*f+20)); ag=Math.min(255,Math.round(g*f+20)); ab=Math.min(255,Math.round(b*f+20)) }
  else if(!d && lum > 190){ const f = 170/lum; ar=Math.max(0,Math.round(r*f)); ag=Math.max(0,Math.round(g*f)); ab=Math.max(0,Math.round(b*f)) }
  const h1 = `rgb(${ar},${ag},${ab})`, [r2,g2,b2] = parseRGB(c2), h2 = `rgb(${r2},${g2},${b2})`, root = document.documentElement;
  root.style.setProperty('--bs-primary', h1);
  root.style.setProperty('--bs-primary-rgb', `${ar},${ag},${ab}`);
  root.style.setProperty('--mm-accent-grad', `linear-gradient(135deg,${h1},${h2})`);
  root.style.setProperty('--mm-accent-1', h1);
}

/* ══ ARTWORK TINT ════════════════════════════════════════════════════════════ */
const _artTintCache = new Map(), ART_TINT_MAX = 200;
function _rgbToHsl(r,g,b){
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2, dd=mx-mn;
  let h=0, s=0;
  if(dd>0){
    s = l>.5 ? dd/(2-mx-mn) : dd/(mx+mn);
    if(mx===r) h = ((g-b)/dd + (g<b?6:0))*60;
    else if(mx===g) h = ((b-r)/dd + 2)*60;
    else h = ((r-g)/dd + 4)*60;
    if(h<0) h += 360;
  }
  return {h,s,l};
}
function _hslToRgb(h,s,l){
  h = ((h%360)+360)%360/360;
  const a = s*Math.min(l,1-l), f = n => { const k=(n+h*12)%12; return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))) };
  return [f(0),f(8),f(4)];
}
async function computeArtAccent(u){
  if(!u) return null;
  const d = document.documentElement.getAttribute('data-bs-theme') !== 'light', k = u + '|' + (d?'d':'l');
  if(_artTintCache.has(k)) return _artTintCache.get(k);
  try{
    const img = new Image(); img.crossOrigin='anonymous'; img.decoding='async'; img.referrerPolicy='no-referrer';
    const loaded = new Promise((res,rej)=>{
      let dn = false;
      const ok = () => { if(dn) return; dn=true; res() };
      const bad = () => { if(dn) return; dn=true; rej(new Error('fail')) };
      img.onload = ok; img.onerror = bad;
      setTimeout(()=>{ if(!dn){ dn=true; rej(new Error('timeout')) } }, 8e3);
    });
    img.src = u;
    await loaded;
    const c = document.createElement('canvas'); c.width = 48; c.height = 48;
    const ctx = c.getContext('2d', {willReadFrequently:true});
    ctx.drawImage(img, 0, 0, 48, 48);
    let data;
    try{ data = ctx.getImageData(0,0,48,48).data } catch{ _artTintCache.set(k, null); return null }
    let hx=0, hy=0, ws=0, sr=0, sg=0, sb=0, px=0;
    for(let i=0;i<data.length;i+=4){
      if(data[i+3]<128) continue;
      const r=data[i]/255, g=data[i+1]/255, b=data[i+2]/255;
      sr+=r; sg+=g; sb+=b; px++;
      const {h,s,l} = _rgbToHsl(r,g,b);
      if(s<.18) continue;
      if(l<.12 || l>.92) continue;
      const w = s*s, rad = h*Math.PI/180;
      hx += Math.cos(rad)*w; hy += Math.sin(rad)*w; ws += w;
    }
    let hue;
    if(ws>.02 && (hx*hx+hy*hy)>.0005){ hue = Math.atan2(hy,hx)*180/Math.PI; if(hue<0) hue += 360 }
    else if(px>0){ const ar=sr/px, ag=sg/px, ab=sb/px, {h,s} = _rgbToHsl(ar,ag,ab); if(s<.06){ _artTintCache.set(k,null); return null } hue = h }
    else { _artTintCache.set(k,null); return null }
    const SAT = d?60:65, LIGHT = d?55:42, hue2 = (hue+30)%360;
    const [r1,g1,b1] = _hslToRgb(hue, SAT/100, LIGHT/100);
    const [r2,g2,b2] = _hslToRgb(hue2, SAT/100, Math.max(.2, LIGHT/100-.15));
    const res = [`rgb(${r1}, ${g1}, ${b1})`, `rgb(${r2}, ${g2}, ${b2})`];
    if(_artTintCache.size >= ART_TINT_MAX) _artTintCache.delete(_artTintCache.keys().next().value);
    _artTintCache.set(k, res);
    return res;
  }catch{ return null }
}

/* ══ SETTINGS APPLY ══════════════════════════════════════════════════════════ */
function applySettings(){
  const s = getSettings();
  const t = s.autoTheme ? (new Date().getHours()>=7 && new Date().getHours()<19 ? 'light':'dark') : s.theme;
  document.documentElement.setAttribute('data-bs-theme', t);
  _syncSaveDataAttr();
  document.body.classList.toggle('no-animations', !s.animations);
  const m = document.querySelector('meta[name="theme-color"]');
  if(m) m.content = t === 'dark' ? '#0b0b0d' : '#ffffff';
  if(s.accent === 'auto' && Player && Player.track){
    const a = getArtwork(Player.track, 300) || Player.track.artworkUrl || '';
    if(a) computeArtAccent(a).then(c => { if(c && getSettings().accent === 'auto') applyAccent(null, c) });
  } else applyAccent(s.accent || 'purple');
  const bg = document.getElementById('appBg');
  if(bg){
    if(s.appBg){
      bg.style.display = '';
      if(Player && Player.track){
        const a = getArtwork(Player.track, 300) || Player.track.artworkUrl || '';
        if(a) bg.style.backgroundImage = `url("${a}")`;
      }
    } else { bg.style.display = 'none'; bg.style.backgroundImage = '' }
  }
}
function autoTheme(){
  const s = getSettings(); if(!s.autoTheme) return;
  const h = new Date().getHours(), w = h>=7 && h<19 ? 'light':'dark';
  if(document.documentElement.getAttribute('data-bs-theme') !== w){
    document.documentElement.setAttribute('data-bs-theme', w);
    const m = document.querySelector('meta[name="theme-color"]');
    if(m) m.content = w === 'dark' ? '#0b0b0d' : '#ffffff';
  }
}
setInterval(autoTheme, 6e4);

/* ══ TOAST ═══════════════════════════════════════════════════════════════════ */
let _toastInstance = null, _toastTimer = null;
function _showToast(c, v, delay){
  const el = $('#toast'); if(!el) return;
  try{ if(_toastInstance) _toastInstance.hide() }catch{}
  if(_toastTimer){ clearTimeout(_toastTimer); _toastTimer = null }
  el.className = `toast text-bg-${v} border-0`;
  const body = $('#toastMsg');
  body.replaceChildren();
  if(c instanceof Node) body.appendChild(c);
  else body.textContent = String(c||'');
  _toastInstance = new bootstrap.Toast(el, {delay, autohide:true});
  _toastInstance.show();
  el.classList.remove('mm-dismissing');
  if(!el.__swipeWired){
    el.__swipeWired = true;
    let sy = 0, cy = 0, drag = false;
    el.addEventListener('touchstart', e => {
      if(e.touches.length !== 1) return;
      sy = e.touches[0].clientY; cy = sy; drag = true;
      el.style.transition = 'none';
    }, {passive:true});
    el.addEventListener('touchmove', e => {
      if(!drag) return;
      cy = e.touches[0].clientY;
      const dy = Math.max(0, cy - sy);
      el.style.transform = `translateY(${dy}px)`;
      el.style.opacity = String(Math.max(.2, 1 - dy/140));
    }, {passive:true});
    el.addEventListener('touchend', () => {
      if(!drag) return; drag = false;
      el.style.transition = '';
      const dy = cy - sy;
      if(dy > 60){ el.classList.add('mm-dismissing'); try{ _toastInstance.hide() }catch{} }
      else { el.style.transform = ''; el.style.opacity = '' }
    }, {passive:true});
  }
}
function toast(m, v='dark'){ _showToast(m, v, 2600) }
function toastAction(m, actions, v='danger', delay=6500){
  const w = document.createElement('div');
  w.className = 'd-flex align-items-center gap-2 flex-wrap';
  const sp = document.createElement('span'); sp.textContent = m; w.appendChild(sp);
  for(const a of actions||[]){
    const b = document.createElement('button');
    b.className = `pill-btn ${a.class||'telegram'} sm`;
    b.innerHTML = a.html;
    b.onclick = () => { try{ a.fn && a.fn() }catch{}; try{ if(_toastInstance) _toastInstance.hide() }catch{} };
    w.appendChild(b);
  }
  _showToast(w, v, delay);
}

/* ══ SHEETS ══════════════════════════════════════════════════════════════════ */
const sheet = id => bootstrap.Offcanvas.getOrCreateInstance($(id));
function closeAllSheets(){
  const open = document.querySelectorAll('.offcanvas.show');
  if(!open.length) return;
  for(const el of open){ try{ bootstrap.Offcanvas.getInstance(el)?.hide() }catch{} }
}
let _pr = null;
function askText(t, v='', ph='Name'){
  return new Promise(r => {
    _pr = r;
    $('#promptTitle').textContent = t;
    const i = $('#promptInput'); i.value = v; i.placeholder = ph;
    sheet('#sheetPrompt').show();
    setTimeout(()=>i.focus(), 350);
  });
}
function submitPrompt(){
  const v = $('#promptInput').value.trim();
  sheet('#sheetPrompt').hide();
  if(_pr){ _pr(v||null); _pr = null }
}
$('#sheetPrompt')?.addEventListener('hidden.bs.offcanvas', () => { if(_pr){ _pr(null); _pr = null } });
$('#promptInput')?.addEventListener('keydown', e => { if(e.key === 'Enter') submitPrompt() });

let _cf = null;
function askConfirm(t, b, ok='Delete', tone='danger'){
  return new Promise(r => {
    _cf = r;
    $('#cfTitle').textContent = t;
    $('#cfBody').textContent = b;
    const o = $('#cfOkBtn'); o.textContent = ok;
    o.style.background = tone === 'primary' ? 'var(--bs-primary)' : 'var(--bs-danger)';
    o.style.color = '#fff';
    sheet('#sheetConfirm').show();
  });
}
$('#cfOkBtn')?.addEventListener('click', () => { sheet('#sheetConfirm').hide(); if(_cf){ _cf(true); _cf = null } });
$('#sheetConfirm')?.addEventListener('hidden.bs.offcanvas', () => { if(_cf){ _cf(false); _cf = null } });

/* ══ API ═════════════════════════════════════════════════════════════════════ */
async function api(path, opts={}){
  const {timeout=12e3, signal:externalSignal, ...fetchOpts} = opts;
  const ctrl = new AbortController(), to = setTimeout(()=>ctrl.abort(), timeout);
  const abort = () => ctrl.abort(externalSignal?.reason);
  if(externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, {once:true});
  const headers = {'Content-Type':'application/json','Authorization':'Bearer '+API_TOKEN, ...(opts.headers||{})};
  let res, text;
  try{
    res = await fetch(API_BASE+path, {...fetchOpts, signal:ctrl.signal, headers});
    text = await res.text();
  }catch(e){
    if(e && e.name==='AbortError') throw new Error('Request timed out');
    throw new Error('Network error: '+(e.message||'unknown'));
  }finally{
    clearTimeout(to);
    externalSignal?.removeEventListener('abort', abort);
  }
  let data = {};
  if(text){ try{ data = JSON.parse(text) }catch{ data = {raw:text.slice(0,400)} } }
  if(!res.ok) throw new Error((data&&data.error)||(data&&data.message)||`HTTP ${res.status}`);
  return data;
}
async function apiCall(path, opts={}){
  const {timeout=12e3, signal:externalSignal, ...fetchOpts} = opts;
  const url = API_BASE+path, headers = {...(opts.headers||{})};
  if(opts.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController(), to = setTimeout(()=>ctrl.abort(), timeout);
  const abort = () => ctrl.abort(externalSignal?.reason);
  if(externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, {once:true});
  let res, text;
  try{
    res = await fetch(url, {...fetchOpts, headers, signal:ctrl.signal, credentials:'include', cache:'no-store'});
    text = await res.text();
  }catch(e){
    return {ok:false, status:0, data:{error:e?.name === 'AbortError' ? 'Request timed out' : e.message||'Network error'}};
  }finally{
    clearTimeout(to);
    externalSignal?.removeEventListener('abort', abort);
  }
  let data = {};
  if(text){ try{ data = JSON.parse(text) }catch{ data = {raw:text.slice(0,400)} } }
  return {ok:res.ok, status:res.status, data};
}

const apiSearch = async t => (await api(`/search?term=${encodeURIComponent(t)}&limit=50&entity=musicArtist,album,song`)).results || [];
const apiFresh = async () => (await api('/fresh')).results || [];
const apiPopular = async (l=40) => (await api('/popular?limit='+l+'&wViews=1&wLikes=20&wRecent=5&wTrend=10&wFresh=8')).results || [];
const apiLookup = async (id,e) => (await api(`/lookup?id=${cleanId(id)}&entity=${e}&limit=200`)).results || [];
const apiLookupFull = async (id,e) => api(`/lookup?id=${cleanId(id)}&entity=${e}&limit=200`);
const apiArtistTracks = async (id, {page=1, limit=50, sort='album'}={}) => api(`/artist/tracks?id=${encodeURIComponent(cleanId(id))}&page=${page}&limit=${limit}&sort=${encodeURIComponent(sort)}`);
const apiQueueAdd = (b,q) => api('/download/add', {method:'POST', body:JSON.stringify({quality:q||DEF_Q, skipExisting:true, ...b})});
/* Treat the server's "Download entry not found" as a *successful*
   completion. The crawler removes the queue row after it finishes, so
   "not found" means: the crawl ran to completion and was cleaned up. */
function _isMissingEntryResponse(r){
  if(!r || typeof r !== 'object') return false;
  if(Number(r.status) === 404) return true;
  if(r.success === false){
    const msg = String(r.error || r.message || '');
    if(/\b404\b|not found|no item/i.test(msg)) return true;
  }
  return false;
}
function _isMissingEntryError(e){
  if(!e) return false;
  if(Number(e.status) === 404) return true;
  const msg = String(e.message || e.error || e);
  return /\b404\b|not found|no item/i.test(msg);
}
function _completedCrawlStatus(extra={}){
  return {
    download_status: 'completed',
    percent: 100,
    found: false,
    completedByAbsence: true,
    ...extra
  };
}
function _statusItemForId(id, items){
  if(Array.isArray(items)){
    return items.find(item => String(item?.trackId ?? item?.track_id ?? '') === String(id));
  }
  if(items && typeof items === 'object'){
    if(items[String(id)]) return items[String(id)];
    return Object.values(items).find(item =>
      String(item?.trackId ?? item?.track_id ?? '') === String(id));
  }
  return null;
}
function _normalizeCrawlStatus(id, response){
  if(!response || _isMissingEntryResponse(response)){
    return _completedCrawlStatus();
  }
  if(response.success === false) return null;
  const entry = response.download || response.item ||
    (response.items ? _statusItemForId(id, response.items) : response);
  if(!entry || typeof entry !== 'object'){
    return _completedCrawlStatus();
  }
  const percent = Number(entry.percent);
  if(entry.download_status === 'completed' || entry.status === 'completed' ||
     (Number.isFinite(percent) && percent >= 100)){
    return {
      ...entry,
      download_status: 'completed',
      percent: 100,
      found: entry.found ?? true
    };
  }
  return { ...entry, found: entry.found ?? true };
}
async function apiCrawlStatus(id){
  try{
    const r = await api(`/download/status?trackId=${cleanId(id)}`);
    const status = _normalizeCrawlStatus(id, r);
    if(status?.download_status === 'completed') _markCompletedId(id);
    return status;
  }catch(e){
    if(_isMissingEntryError(e)){
      _markCompletedId(id);
      return _completedCrawlStatus();
    }
    console.warn('[queue status]', e);
    return null;
  }
}
/* IDs confirmed completed by the server. Never re-queried until
   explicitly forgotten (force-crawl / retry). FIFO-capped so it can't
   grow unbounded. */
const _completedIds = new Set();
const _COMPLETED_MAX = 2000;

function _markCompletedId(id){
  id = String(id);
  if(_completedIds.has(id)) return;
  _completedIds.add(id);
  if(_completedIds.size > _COMPLETED_MAX){
    _completedIds.delete(_completedIds.values().next().value);
  }
}
function _forgetCompletedId(id){ _completedIds.delete(String(id)) }
let _batchStatusSupported = null;
async function apiBatchStatus(ids){
  if(!ids || !ids.length) return {};
  ids = ids.map(String);
  const out = {};

  /* Split into known-completed (served from cache) vs still-needed */
  const reqIds = [];
  for(const id of ids){
    if(_completedIds.has(id)){
      out[id] = {trackId: id, download_status:'completed', percent:100,
                 error:null, found:false, _cached:true};
    } else {
      reqIds.push(id);
    }
  }

  /* Nothing to ask the server for → skip the network entirely */
  if(!reqIds.length) return out;

  if(_batchStatusSupported !== false){
    try{
      const chunks = [];
      for(let i=0;i<reqIds.length;i+=150) chunks.push(reqIds.slice(i,i+150));
      const rs = await Promise.all(chunks.map(c => api(`/download/batch-status?ids=${c.join(',')}`)));
      if(rs.every(r => r && r.success !== false && r.items)){
        _batchStatusSupported = true;
        for(let i=0;i<rs.length;i++){
          const r = rs[i];
          for(const id of chunks[i]){
            const s = _normalizeCrawlStatus(
              id,
              { items: r.items }
            );
            out[id] = s;
            if(s.download_status === 'completed') _markCompletedId(id);
          }
        }
        if(Object.keys(out).length >= ids.length) return out;
      } else _batchStatusSupported = false;
    }catch{ _batchStatusSupported = false }
  }

  /* Per-ID fallback for anything still missing */
  const have = new Set(Object.keys(out));
  const miss = reqIds.filter(id => !have.has(id));
  if(miss.length){
    const r = await Promise.all(miss.map(async id => {
      try{ return [id, await apiCrawlStatus(id)] }catch{ return null }
    }));
    for(const x of r){
      if(!x) continue;
      out[x[0]] = _normalizeCrawlStatus(x[0], x[1]);
      if(out[x[0]].download_status === 'completed') _markCompletedId(x[0]);
    }
  }
  return out;
}
/* ══ FETCH CACHE ═════════════════════════════════════════════════════════════ */
const _ftCache = new Map(), _FT_TTL = 3e5, _FT_MAX = 500;
function _ftCachePrune(){
  if(_ftCache.size <= _FT_MAX) return;
  const n = Date.now();
  for(const [k,v] of _ftCache) if(v.exp < n) _ftCache.delete(k);
  while(_ftCache.size > _FT_MAX) _ftCache.delete(_ftCache.keys().next().value);
}
const _sgc = new Map(), SGC_MAX = 60;
function _sh(n,q){
  if(!q) return esc(n);
  const l = String(n).toLowerCase(), nd = q.toLowerCase(), i = l.indexOf(nd);
  if(i < 0) return esc(n);
  return esc(n.slice(0,i)) + '<b>' + esc(n.slice(i, i+nd.length)) + '</b>' + esc(n.slice(i+nd.length));
}
function initSuggest(input, dd){
  if(!input || !dd || input.__sg) return;
  input.__sg = 1;
  let items = [], ai = -1, lq = '', dt = null, ct = null;
  const close = () => { dd.classList.remove('show'); dd.replaceChildren(); input.setAttribute('aria-expanded','false'); items = []; ai = -1 };
  const render = () => {
    if(!items.length){ close(); return }
    dd.innerHTML = items.map((it,i) => {
      const ic = it.type === 'artist' ? 'bi-person' : it.type === 'collection' ? 'bi-disc' : 'bi-music-note';
      const lb = it.type === 'artist' ? 'Artist' : it.type === 'collection' ? 'Album' : 'Song';
      const artist = it.artistName ? `<div class="sg-sub">${_sh(it.artistName, lq)}</div>` : '';
      return `<button type="button" role="option" class="sg-item${i === ai ? ' active' : ''}" data-idx="${i}"><i class="bi ${ic} sg-icon"></i><span class="sg-text flex-grow-1 min-w-0"><span class="sg-title">${_sh(it.name, lq)}</span>${artist}</span><span class="sg-badge">${lb}</span></button>`;
    }).join('');
    dd.classList.add('show');
    input.setAttribute('aria-expanded','true');
    if(ai >= 0){ const e = dd.querySelector('.sg-item.active'); e?.scrollIntoView?.({block:'nearest'}) }
  };
  const pick = i => {
    const it = items[i]; if(!it) return;
    close(); input.blur();
    const l = ls.get(KEY.recent,[]).filter(x => x !== it.name);
    l.unshift(it.name); ls.set(KEY.recent, l.slice(0,12));
    go(`/${it.type}/${it.id}`);
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if(q === lq) return;
    lq = q;
    if(dt) clearTimeout(dt);
    if(q.length < 1){ close(); return }
    const c = _sgc.get(q.toLowerCase());
    if(c){ items = c; ai = -1; render(); return }
    if(!dd.classList.contains('show')){
      dd.innerHTML = `<div class="sg-loading"><span class="spinner-border spinner-border-sm" style="width:12px;height:12px;border-width:2px"></span> Searching…</div>`;
      dd.classList.add('show'); input.setAttribute('aria-expanded','true');
    }
    dt = setTimeout(async () => {
      if(ct) ct.abort();
      ct = new AbortController();
      try{
        const r = await fetch(`${API_BASE}/suggest?q=${encodeURIComponent(q)}&limit=8`, {headers:{'Authorization':'Bearer '+API_TOKEN}, signal:ct.signal});
        if(input.value.trim() !== q) return;
        const d = await r.json(), s = Array.isArray(d.suggestions) ? d.suggestions : [];
        if(_sgc.size >= SGC_MAX) _sgc.delete(_sgc.keys().next().value);
        _sgc.set(q.toLowerCase(), s);
        items = s; ai = -1;
        if(!items.length){
          dd.innerHTML = `<div class="sg-empty"><i class="bi bi-search"></i> No matches</div>`;
          dd.classList.add('show'); input.setAttribute('aria-expanded','true');
        } else render();
      }catch(e){ if(e.name !== 'AbortError') close() }
    }, 220);
  });
  input.addEventListener('keydown', e => {
    if(!dd.classList.contains('show')) return;
    if(e.key === 'ArrowDown'){ e.preventDefault(); ai = Math.min(ai+1, items.length-1); render() }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); ai = Math.max(ai-1, -1); render() }
    else if(e.key === 'Enter'){
      if(ai >= 0 && items[ai]){ e.preventDefault(); e.stopPropagation(); pick(ai); return }
      if(items.length === 1){ e.preventDefault(); e.stopPropagation(); pick(0); return }
      close();
    }
    else if(e.key === 'Escape'){ close(); input.blur() }
  });
  dd.addEventListener('pointerdown', e => { const b = e.target.closest('.sg-item'); if(b) e.preventDefault() });
  dd.addEventListener('click', e => { const b = e.target.closest('.sg-item'); if(!b) return; e.preventDefault(); e.stopPropagation(); pick(Number(b.dataset.idx)) });
  input.addEventListener('blur', () => setTimeout(() => { if(document.activeElement === input) return; if(dd.contains(document.activeElement)) return; close() }, 220));
  input.addEventListener('focus', () => { if(items.length && input.value.trim() === lq) render() });
  document.addEventListener('click', e => { if(!input.contains(e.target) && !dd.contains(e.target)) close() });
}

/* ══ ITEM UTILS ══════════════════════════════════════════════════════════════ */
const TYPE_MAP = {musicArtist:'artist', artist:'artist', album:'collection', collection:'collection', song:'track', track:'track'};
const itemType = it => TYPE_MAP[it?.wrapperType] || it?.wrapperType || '';
const itemId = it => it?.trackId || it?.collectionId || it?.artistId || '';

function _effectiveArtSize(size){
  if(!Net.saveData && !Net.isSlow && !IS_LOW_END) return size;
  if(size > 300) return 300;
  if(size > 100) return 100;
  return size;
}
function _resizeArtUrl(url, size){
  if(!url) return '';
  return url.replace(/\/(\d+)x(\d+)(bb)?\./, `/${size}x${size}bb.`).replace('1000x1000','200x200');
}
function getArtwork(it, size=300){
  size = _effectiveArtSize(size);
  const u = it?.attachments?.artworkUrls;
  if(!Array.isArray(u) || !u.length){
    const fb = it?.artworkUrl || '';
    return fb ? _resizeArtUrl(fb, size) : '';
  }
  let best = u[u.length-1], bestDiff = Infinity;
  for(const x of u){
    const uu = x?.url; if(!uu) continue;
    const m = uu.match(/\/(\d+)x(\d+)bb\./);
    if(!m){ best = x; break }
    const d = Math.abs(Number(m[1]) - size);
    if(d < bestDiff){ bestDiff = d; best = x }
  }
  return _resizeArtUrl(best?.url || '', size);
}
function hasAudio(it){
  const a = it?.attachments?.audioUrls;
  return (Array.isArray(a) && a.some(x => isBaleAudioMirror(x) || isCachedAudioMirror(x)))
    || (!!it?.trackId && isCached(String(it.trackId)));
}
function hasBaleAudio(it){
  const a = it?.attachments?.audioUrls;
  return Array.isArray(a) && a.some(isBaleAudioMirror);
}
function isBaleAudioMirror(x){
  if(!x || !(x.baleFileUrl || x.url)) return false;
  const source = String(x.source||'').trim().toLowerCase(),
        url = String(x.baleFileUrl || x.url || '').trim().toLowerCase();
  return source === 'bale' || source === 'balethon'
    || url.startsWith('bale://') || /(?:bale\.ai|ble\.ir)\//.test(url);
}
const isCachedAudioMirror = x => !!x?.url && String(x.source||'').toLowerCase() === 'cache';
function hasPreview(it){
  const p = it?.attachments?.previewUrls;
  return Array.isArray(p) && p.some(x => x && x.url);
}
function getPreviewUrl(it){
  const p = it?.attachments?.previewUrls;
  if(!Array.isArray(p) || !p.length) return null;
  for(const x of p) if(x && x.url) return x.url;
  return null;
}
function getAudioOptions(it){
  const a = it?.attachments?.audioUrls;
  if(!Array.isArray(a)) return [];
  return a.filter(x => x && (x.baleFileUrl || x.url) && (isBaleAudioMirror(x) || isCachedAudioMirror(x))).map(x => {
    if(isBaleAudioMirror(x) && x.baleFileUrl) x = {...x, url:x.baleFileUrl};
    const messageId = x.baleMessageId
      || String(x.url).match(/^bale:\/\/(?:message\/)?([^/?#]+)/i)?.[1];
    return messageId && /^[A-Za-z0-9_-]+$/.test(String(messageId)) && isBaleAudioMirror(x)
      ? {...x, url:`bale://message/${messageId}`}
      : x;
  });
}
function pickAudio(it, pq){
  const o = getAudioOptions(it);
  if(!o.length) return getPreviewUrl(it);
  const t = parseInt(pq,10) || 192, e = o.find(x => String(x.quality) === String(pq));
  if(e) return e.url;
  let c = o[0], bd = Infinity;
  for(const x of o){
    const q = parseInt(x.quality,10);
    if(!isFinite(q)) continue;
    const d = Math.abs(q-t);
    if(d < bd){ bd = d; c = x }
  }
  return c?.url || null;
}
const getPlayable = it => pickAudio(it, DEF_Q);
function dlActionFor(t){
  const d = hasAudio(t);
  return {isDirect:d, label:d?'Download':'Crawl', icon:d?'bi-download':'bi-cloud-arrow-down',
    idleTitle:d?'Not downloaded':'Not crawled',
    idleSub:d?'Full audio available — download for offline':(hasPreview(t)?'Crawl to listen offline · preview available now':'Crawl to listen offline')};
}
const isLongTrack = it => (Number(it?.trackTimeMillis)||0) > LONG_TRACK_MS;
const itemCache = new Map();
function cacheItems(items){
  for(const it of items||[]){
    const t = itemType(it), i = itemId(it);
    if(t && i) itemCache.set(`${t}:${i}`, it);
  }
}
const getCached = (t,id) => itemCache.get(`${t}:${id}`);

function normalizePlaylistTrack(t){
  if(!t || typeof t !== 'object') return null;
  const id = String(t.trackId||''); if(!id) return null;
  const cached = isCached(id), srv = t.attachments && typeof t.attachments === 'object' ? t.attachments : null;
  let artworkUrls = [], previewUrls = [], audioUrls = [], lyrics = null;
  if(srv){
    if(Array.isArray(srv.artworkUrls)) artworkUrls = srv.artworkUrls.filter(x => x && x.url);
    if(Array.isArray(srv.previewUrls)) previewUrls = srv.previewUrls.filter(x => x && x.url);
    if(Array.isArray(srv.audioUrls)) audioUrls = srv.audioUrls
      .filter(x => x && (x.url || x.baleFileUrl))
      .map(x => x.url ? x : {...x, url:x.baleFileUrl});
    lyrics = srv.lyrics || null;
  } else {
    if(t.artworkUrl100) artworkUrls.push({url:t.artworkUrl100, size:'100x100', source:'itunes'});
    else if(t.artworkUrl) artworkUrls.push({url:t.artworkUrl, source:'itunes'});
    if(Array.isArray(t.previewUrls) && t.previewUrls.length) previewUrls = t.previewUrls.filter(x => x && x.url);
    else if(t.previewUrl) previewUrls = [{url:t.previewUrl, source:'itunes'}];
    else if(t.preview_url) previewUrls = [{url:t.preview_url, source:'itunes'}];
    lyrics = t.lyrics || null;
  }
  if(cached && !audioUrls.some(a => a.url === 'local')) audioUrls = [{url:'local', quality:'320', source:'cache'}, ...audioUrls];
  return {
    wrapperType:'track', trackId:id, trackName:t.trackName||'Track', artistName:t.artistName||'',
    artistId:t.artistId||'', collectionName:t.collectionName||'', collectionId:t.collectionId||'',
    trackTimeMillis:t.trackTimeMillis||0, primaryGenreName:t.primaryGenreName||'',
    releaseDate:t.releaseDate||'', previewUrl:t.previewUrl||'', reason:t.reason||'',
    attachments:{artworkUrls, previewUrls, audioUrls, lyrics}
  };
}

/* ══ INDEXEDDB ═══════════════════════════════════════════════════════════════ */
let _dbp;
function getDB(){
  if(!_dbp) _dbp = new Promise((res,rej) => {
    const r = indexedDB.open('mm_audio', 2);
    r.onupgradeneeded = e => { const db = r.result; if(!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', {keyPath:'trackId'}) };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return _dbp;
}
async function idb(st, mode, fn){
  const db = await getDB();
  return new Promise((res,rej) => {
    const tx = db.transaction(st, mode), r = fn(tx.objectStore(st));
    tx.oncomplete = () => res(r?.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const cachePut = (id,b,m) => idb('audio','readwrite',s => s.put({trackId:String(id), blob:b, meta:m, size:b.size, at:Date.now()}));
const cacheGet = id => idb('audio','readonly',s => s.get(String(id))).then(r => r||null);
const cacheAll = () => idb('audio','readonly',s => s.getAll()).then(r => r||[]);
const cacheKeys = () => idb('audio','readonly',s => s.getAllKeys()).then(r => r||[]);
const cacheDel = id => idb('audio','readwrite',s => s.delete(String(id)));
const cacheClear = () => idb('audio','readwrite',s => s.clear());
const cachedIds = new Set();
async function refreshCacheIndex(){
  cachedIds.clear();
  (await cacheKeys()).forEach(id => cachedIds.add(String(id)));
}
const isCached = id => cachedIds.has(String(id));
async function getStorageEstimate(){
  if(!navigator.storage?.estimate) return null;
  try{ const e = await navigator.storage.estimate(); return {usage:e.usage||0, quota:e.quota||0} }catch{ return null }
}
function metaFromTrack(t){
  return {
    wrapperType:'track', trackId:String(t.trackId), trackName:t.trackName||'', artistName:t.artistName||'',
    artistId:t.artistId?String(t.artistId):'', collectionName:t.collectionName||'', collectionId:t.collectionId?String(t.collectionId):'',
    artworkUrl100:t.artworkUrl100||getArtwork(t,100)||'', primaryGenreName:t.primaryGenreName||'',
    releaseDate:t.releaseDate||'', trackTimeMillis:t.trackTimeMillis||0, trackNumber:t.trackNumber||0,
    lyrics:t.lyrics || t.attachments?.lyrics || null,
    attachments:{artworkUrls: t.attachments?.artworkUrls || (t.artworkUrl100 ? [{url:t.artworkUrl100, size:'100x100'}] : [])}
  };
}

/* ══ DOWNLOADS ═══════════════════════════════════════════════════════════════ */
const DL = {
  items:[], listeners:new Set(), timer:null, saving:new Set(), _polling:false,
  load(){
    this.items = ls.get(KEY.downloads,[]).map(it => it.status === 'saving' ? {...it, status:'paused', percent:0, error:'Interrupted'} : it);
    this.persist();
  },
  persist(){ ls.set(KEY.downloads, this.items) },
  all(){ return this.items },
  active(){ return this.items.filter(i => i.type !== 'batch' && ['queued','crawling','saving'].includes(i.status)) },
  activeBatches(){ return this.items.filter(i => i.type === 'batch' && ['queued','crawling','saving'].includes(i.status)) },
  ready(){ return this.items.filter(i => i.type !== 'batch' && i.status === 'ready') },
  readyBatches(){ return this.items.filter(i => i.type === 'batch' && i.status === 'ready') },
  failed(){ return this.items.filter(i => i.type !== 'batch' && ['failed','paused'].includes(i.status)) },
  failedBatches(){ return this.items.filter(i => i.type === 'batch' && i.status === 'failed') },
  get(id){ return this.items.find(i => String(i.trackId) === String(id)) },
  notify(){ this.persist(); updateDownloadBadges(); this.listeners.forEach(fn => { try{ fn(this) }catch{} }) },
  onChange(fn){ this.listeners.add(fn); return () => this.listeners.delete(fn) },
  upsert(e){
    const i = this.items.findIndex(x => String(x.trackId) === String(e.trackId));
    if(i >= 0) this.items[i] = {...this.items[i], ...e, updatedAt:Date.now()};
    else {
      const d = {trackId:String(e.trackId), name:e.name||'Track', artist:e.artist||'', artistId:e.artistId||'', album:e.album||'', collectionId:e.collectionId||'', artwork:e.artwork||'', type:e.type||'save', status:e.status||'queued', percent:e.percent||0, error:e.error||'', bytes:e.bytes||0, totalBytes:e.totalBytes||0, addedAt:e.addedAt||Date.now(), updatedAt:Date.now()};
      const ex = {}; for(const k in e) if(!(k in d)) ex[k] = e[k];
      this.items.unshift({...d, ...ex});
    }
    this.notify();
  },
  update(id, p){ const it = this.get(id); if(!it) return; Object.assign(it, p, {updatedAt:Date.now()}); this.notify() },
  remove(id){ this.items = this.items.filter(i => String(i.trackId) !== String(id)); this.notify() },
  async add(track, _t, q, forceCrawl=false){
    if(!track?.trackId) return;
    const id = String(track.trackId);
    if(forceCrawl) _forgetCompletedId(id); 
    if(isCached(id) && !forceCrawl){ toast('Already offline'); return }
    const ex = this.get(id);
    if(ex && ['queued','crawling','saving'].includes(ex.status)){ toast('Already in progress','warning'); return }
    this.upsert({trackId:id, name:track.trackName||'Track', artist:track.artistName||'', artistId:track.artistId?String(track.artistId):'', album:track.collectionName||'', collectionId:track.collectionId?String(track.collectionId):'', artwork:getArtwork(track,100), status:'queued', percent:0, error:'', forceCrawl});
    haptic(12);
    if(hasAudio(track) && !forceCrawl){ this.update(id, {status:'saving', percent:0}); this._runSave(id, track).catch(e => this.update(id, {status:'failed', error:e.message})); return }
    try{ await apiQueueAdd({trackId:cleanId(id), ...(forceCrawl ? {skipExisting:false} : {})}, q) }
    catch(e){
      this.update(id, {status:'failed', error:e.message||'Could not queue track'});
      toast('Queue failed: '+(e.message||'Could not queue track'),'danger');
      return;
    }
    this.update(id, {status:'queued', percent:0, addedAt:Date.now()});
    this._ensureTimer();
  },
  async addBatch({subType, sourceId, name, artist, artwork, tracks, forceSave=false}){
    if(!tracks || !tracks.length){ toast('Nothing to crawl','warning'); return }
    const bid = `batch_${subType}_${sourceId}`, ex = this.get(bid);
    if(ex && ['queued','crawling','saving'].includes(ex.status)){ toast('Already in progress','warning'); return }
    const ids = tracks.map(t => String(t.trackId)).filter(Boolean);
    this.upsert({trackId:bid, type:'batch', subType, sourceId:String(sourceId), name:name||'Batch', artist:artist||'', artwork:artwork||'', trackIds:ids, trackCount:ids.length, readyCount:0, status:'crawling', percent:0, error:'', forceSave:!!forceSave});
    haptic(15);
    this._ensureTimer();
  },
  async retry(id){
    Notify.request();
    const it = this.get(id); if(!it) return;
    _forgetCompletedId(id);    
    if(it.type === 'batch'){ this.update(id, {status:'crawling', error:'', percent:0, addedAt:Date.now()}); this._ensureTimer(); return }
    const tr = getCached('track', id) || await this._fetchTrack(id);
    if(!tr){ toast('Track unavailable','danger'); return }
    this.update(id, {status:'queued', error:'', percent:0, addedAt:Date.now(), _markTries:0});
    const forceCrawl = !!it.forceCrawl;
    if(hasAudio(tr) && !forceCrawl){ this.update(id, {status:'saving'}); this._runSave(id, tr).catch(e => this.update(id, {status:'failed', error:e.message})); return }
    try{ await apiQueueAdd({trackId:cleanId(id), ...(forceCrawl ? {skipExisting:false} : {})}) }
    catch(e){
      this.update(id, {status:'failed', error:e.message||'Could not queue track'});
      toast('Retry failed: '+(e.message||'Could not queue track'),'danger');
      return;
    }
    this.update(id, {status:'queued'});
    this._ensureTimer();
  },
async _fetchTrack(id){
  const k = String(id);

  /* itemCache: فقط اگر audio دارد استفاده کن */
  const c1 = getCached('track', k);
  if(c1 && hasAudio(c1)) return c1;

  /* _ftCache: TTL تنها کافی نیست — کش بی‌audio را دور بریز */
  const c2 = _ftCache.get(k);
  if(c2){
    if(c2.exp > Date.now() && c2.t && hasAudio(c2.t)) return c2.t;
    _ftCache.delete(k);                 // ← کش کهنه / بی‌audio → پاک کن
  }

  try{
    const r = await apiLookup(k, 'song');
    const it = r.find(x => itemType(x) === 'track') || r[0];
    if(it){
      cacheItems([it]);
      _ftCache.set(k, {t:it, exp:Date.now()+_FT_TTL});
      _ftCachePrune();
    }
    return it;
  }catch{ return null }
},
  async _runSave(id, track){
    if(this.saving.has(id)) return;
    this.saving.add(id);
    const url = getPlayable(track);
    if(!url){ this.saving.delete(id); throw new Error('No audio URL') }
    try{
      const res = await fetch(proxyUrl(url));
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length'))||0,
            mime = (res.headers.get('content-type')||'').split(';')[0] || 'audio/mpeg',
            reader = res.body?.getReader?.();
      let blob;
      if(reader){
        const ch = []; let rec = 0, last = 0;
        while(true){
          const {done, value} = await reader.read();
          if(done) break;
          ch.push(value); rec += value.length;
          const pct = total ? Math.min(99, Math.round(rec/total*100)) : 0;
          const n = performance.now();
          if(n - last > 250 || rec === total){ last = n; this.update(id, {percent:pct, bytes:rec, totalBytes:total}) }
        }
        blob = new Blob(ch);
      } else blob = await res.blob();
      await cachePut(id, blob, {...metaFromTrack(track), mime, url});
      cachedIds.add(String(id));
      this.update(id, {status:'completed', percent:100, bytes:blob.size, totalBytes:blob.size, completedAt:Date.now()});
      haptic(18);
      Notify.show('Download complete', `${track.trackName||track.name||'Track'} · ${fmtSize(blob.size)}`, {category:'download', url:(BASE||'')+'/track/'+id, tag:'mm-dl-'+id, icon:getArtwork(track,100)});
      if(isLibDl()) updateDlLists();
      if(isTrackRoute()){ const t = getCached('track', id); if(t) renderCrawlCard(t, null) }
      setTimeout(() => { if(this.get(id)?.status === 'completed') this.remove(id) }, 3500);
    } finally { this.saving.delete(id) }
  },async _saveTrackById(id){
  id = String(id);
  if(isCached(id)) return;

  _ftCache.delete(id);                       // کش کهنه را دور بریز

  let t = null;

  /* /download/status منبع معتبر — کل track با attachments تازه */
  try{
    const st = await apiCrawlStatus(id);
    if(st && hasAudio(st)){
      t = { wrapperType:'track', trackId:id, ...st };
      cacheItems([t]);
      _ftCache.set(id, {t, exp:Date.now()+_FT_TTL});
    }
  }catch{}

  /* fallback: /lookup (ممکن است کش سمت سرور باشد) */
  if(!t || !hasAudio(t)) t = await this._fetchTrack(id);
  if(!t || !hasAudio(t)) throw new Error('Audio not available');

  await this._runSave(id, t);
},async _markCompleted(id){
  id = String(id);
  const cur = this.get(id);
  if(!cur) return;

  /* اگر قبلاً حل شده، دوباره وارد نشو */
  if(['ready','saving','completed'].includes(cur.status)) return;

  if(getSettings().autoSaveAfterCrawl){
    this.update(id, {status:'saving', percent:0, readyAt:Date.now()});
    /* ذخیره‌ی async — poll را بلاک نکن */
    this._saveTrackById(id).catch(e =>
      this.update(id, {status:'failed', error:e.message})
    );
  } else {
    this.update(id, {status:'ready', percent:100, readyAt:Date.now()});
    Notify.show('Crawl complete',
      `${cur.name||'Track'} is ready — tap to save offline`,
      { category:'crawl', url:(BASE||'')+'/track/'+id,
        tag:'mm-crawl-'+id, icon:cur.artwork||undefined });
  }
},async _pollBatch(batch, st){
  const ids = (batch.trackIds||[]).map(String);
  if(!ids.length){ this.update(batch.trackId, {status:'ready', percent:100, readyCount:0}); return }

  const ge = Date.now() - (batch.addedAt||0) > GRACE;
  if(!st) st = await apiBatchStatus(ids);

  let ready = 0, failed = 0, pending = 0, pctSum = 0;

  for(const id of ids){
    /* اگر از قبل آفلاین است، مستقیم ۱۰۰ */
    if(isCached(id)){ ready++; pctSum += 100; continue }

    const s = st[id];
    if(!s){ pending++; continue }              // بی‌خبر → سهم صفر

    const ds = s.download_status;
    let itemPct = Number(s.percent);
    if(!isFinite(itemPct)) itemPct = 0;
    itemPct = Math.max(0, Math.min(100, itemPct));

    if(ds === 'failed' || ds === 'stopped'){
      failed++;
      pctSum += itemPct;                       // همان‌قدر که سرور می‌گوید
      continue;
    }

    if(ds === 'completed'){
      ready++;
      pctSum += 100;                           // complete = 100 قطعی
      continue;
    }

    if(s.found === false){
      /* ردیف از صف پاک شده. فقط بعد از grace به‌عنوان completed قبول کن */
      if(ge){ ready++; pctSum += 100 }
      else  { pending++; pctSum += itemPct }
      continue;
    }

    /* queued / downloading / crawling → در جریان */
    pending++;
    pctSum += itemPct;
  }

  /* میانگین درصد واقعی همه‌ی ترک‌ها */
  const pct = Math.round(pctSum / ids.length);

  /* ─── همه آماده ─── */
  if(ready === ids.length){
    if(getSettings().autoSaveAfterCrawl || batch.forceSave){
      this.update(batch.trackId, {status:'saving', percent:100, readyCount:ready});
      await this._saveBatch(this.get(batch.trackId));
    } else {
      this.update(batch.trackId, {status:'ready', percent:100, readyCount:ready});
      Notify.show('Crawl complete',
        `${batch.name||'Batch'} — ${ready} track${ready===1?'':'s'} ready to save`,
        { category:'crawl', tag:'mm-batch-'+batch.trackId, icon:batch.artwork||undefined });
    }
    return;
  }

  /* ─── همه resolved ─── */
  if(pending === 0){
    this.update(batch.trackId, {
      status:'failed', percent:pct, readyCount:ready, failedCount:failed,
      error:`${failed} of ${ids.length} failed tracks`
    });
    Notify.show('Crawl failed',
      `${batch.name||'Batch'} — ${failed} of ${ids.length} track${ids.length===1?'':'s'} failed`,
      { category:'crawl', variant:'danger', tag:'mm-batch-'+batch.trackId, icon:batch.artwork||undefined });
    return;
  }

  /* ─── در حال پیشرفت: هر بار درصد تغییر کرد، آپدیت بزن ─── */
  const prev = this.get(batch.trackId) || {};
  const changed = prev.readyCount !== ready
    || prev.failedCount !== failed
    || Math.abs((prev.percent||0) - pct) >= 1
    || prev.status !== 'crawling';

  if(changed){
    this.update(batch.trackId, {
      status:'crawling', percent:pct, readyCount:ready, failedCount:failed
    });
  }
},
async _saveBatch(batch){
  const ids = (batch.trackIds || []).map(String);
  if(!ids.length){
    this.update(batch.trackId, {status:'completed', percent:100, readyCount:0, failedCount:0});
    return;
  }

  let done = 0, failed = 0;
  const failedIds = [];

  for(const id of ids){
    /* از قبل آفلاین است → ذخیره لازم نیست */
    if(isCached(id)){ done++; continue }

    /* کش قبلی (قبل از crawl) را دور بریز تا در صورت نیاز
       lookup واقعاً تازه انجام شود */
    _ftCache.delete(id);

    /* ── منبع اصلی: /download/status ──
       فقط این endpoint attachments تازه دارد و کش سمت سرور نمی‌شود. */
    let t = null;
    try{
      const st = await apiCrawlStatus(id);
      if(st && hasAudio(st)){
        t = { wrapperType:'track', trackId:id, ...st };
        cacheItems([t]);
        _ftCache.set(id, {t, exp:Date.now()+_FT_TTL});
        _ftCachePrune();
      }
    }catch{}

    /* ── fallback: /lookup (ممکن است کش سمت سرور باشد) ── */
    if(!t || !hasAudio(t)){
      try{ t = await this._fetchTrack(id) }catch{ t = null }
    }

    if(!t || !hasAudio(t)){
      /* سرور هنوز فایلی برای این ترک ندارد */
      failed++;
      failedIds.push(id);
    } else {
      try{
        await this._runSave(id, t);
        done++;
      }catch(e){
        console.warn('[saveBatch] _runSave failed', id, e);
        failed++;
        failedIds.push(id);
      }
    }

    /* پیشرفت را بعد از هر ترک آپدیت کن (UI زنده) */
    this.update(batch.trackId, {
      percent: Math.round((done + failed) / ids.length * 100),
      readyCount: done,
      failedCount: failed
    });
  }

  /* ── پایان: همه ذخیره شدند ── */
  if(failed === 0){
    this.update(batch.trackId, {
      status:'completed', percent:100,
      readyCount:done, failedCount:0, error:''
    });
    haptic(20);
    Notify.show('Download complete',
      `${batch.name||'Batch'} — saved ${done}/${ids.length} track${ids.length===1?'':'s'}`,
      { category:'download', tag:'mm-batch-'+batch.trackId, icon:batch.artwork||undefined });
    setTimeout(() => {
      if(this.get(batch.trackId)?.status === 'completed') this.remove(batch.trackId);
    }, 3500);
    return;
  }

  /* ── پایان: همه شکست خوردند ── */
  if(done === 0){
    this.update(batch.trackId, {
      status:'failed', percent:100,
      readyCount:0, failedCount:failed,
      error:`${failed} of ${ids.length} track${ids.length===1?'':'s'} could not be saved`
    });
    Notify.show('Download failed',
      `${batch.name||'Batch'} — ${failed} of ${ids.length} track${ids.length===1?'':'s'} failed`,
      { category:'download', variant:'danger',
        tag:'mm-batch-'+batch.trackId, icon:batch.artwork||undefined });
    return;
  }

  /* ── پایان: ترکیبی (بعضی ذخیره، بعضی ناموفق) ── */
  this.update(batch.trackId, {
    status:'failed', percent:100,
    readyCount:done, failedCount:failed,
    error:`${failed} of ${ids.length} track${ids.length===1?'':'s'} failed to save`
  });
  haptic(14);
  Notify.show('Download partially complete',
    `${batch.name||'Batch'} — saved ${done}, failed ${failed} of ${ids.length}`,
    { category:'download', variant:'warning',
      tag:'mm-batch-'+batch.trackId, icon:batch.artwork||undefined });
},
 async _pollOnce(){
  if(!navigator.onLine) return 0;

  const cs = this.items.filter(i => i.type !== 'batch' && ['queued','crawling'].includes(i.status)),
        bs = this.items.filter(i => i.type === 'batch' && ['queued','crawling','saving'].includes(i.status));
  let pm = 0;

  /* یک درخواست batch-status مشترک برای همه‌ی IDهای در جریان.
     apiBatchStatus خودش IDهای completed را فیلتر می‌کند، پس اگر همه
     تمام شده باشند اصلاً درخواستی نمی‌فرستد. */
  const allIds = [], seen = new Set();
  for(const it of cs){
    const id = String(it.trackId);
    if(!seen.has(id)){ seen.add(id); allIds.push(id) }
  }
  for(const b of bs){
    if(b.status === 'saving') continue;                // کاملاً کراول شده
    for(const id of (b.trackIds||[])){
      const s = String(id);
      if(!seen.has(s)){ seen.add(s); allIds.push(s) }
    }
  }
  const st = allIds.length ? await apiBatchStatus(allIds) : {};

  /* ─── تک‌ترک‌ها ─── */
  for(const item of cs){
    const id = String(item.trackId), s = st[id];
    if(!s){ pm += Number(item.percent)||0; continue }

    const nf  = s.found === false;
    const ds  = s.download_status;
    const pct = Math.max(0, Math.min(100, Math.round(Number(s.percent)||0)));
    const age = Date.now() - (item.addedAt||0);

    if(nf && age < GRACE){ pm += Number(item.percent)||0; continue }
    if(nf || ds === 'completed'){ await this._markCompleted(id); continue }

    if(ds === 'failed' || ds === 'stopped'){
      if(getSettings().autoRetry && (item.retries||0) < 3){
        setTimeout(() => DL.retry(id).catch(()=>{}), 3e3);
        this.update(id, {
          status:'failed',
          error:(s.error||'Failed')+' — retrying…',
          retries:(item.retries||0)+1
        });
      } else {
        this.update(id, {status:'failed', error:s.error||'Failed'});
      }
    } else {
      if(pct !== (item.percent||0) || item.status !== 'crawling'){
        this.update(id, {status:'crawling', percent:pct});
      }
      pm += pct;
    }
  }

  /* ─── بچ‌ها: موازی، با نقشه‌ی مشترک st ─── */
  const bsToPoll = bs.filter(b => b.status !== 'saving');
  if(bsToPoll.length){
    await Promise.all(bsToPoll.map(b =>
      this._pollBatch(b, st).catch(e => console.warn('[pollBatch]', e))
    ));
  }
  for(const b of bs){ pm += (b.readyCount||0)*1e3 + (b.percent||0) }

  pm += cachedIds.size * 100;
  return pm;
},
_ensureTimer(){
  if(this._polling) return;
  this._polling = true;
  let np = 0, lp = -1;
  const self = this;
  const schedule = () => {
    const busy = self.active().length + self.activeBatches().length;
    if(!busy){ self._polling = false; self.timer = null; return }

    let base = IS_LOW_END ? 2500 : 1500;
    base *= Math.max(1, Math.ceil(busy / 10));

    const bo    = Math.min(3, 1 + np * 0.25);
    const delay = Math.min(8000, Math.round(base * bo));

    self.timer = setTimeout(async () => {
      try{
        const p = await self._pollOnce();
        if(p === lp) np++; else { np = 0; lp = p }
      }catch{}
      schedule();
    }, delay);
  };
  schedule();
}
};
function resumeDownloadPolling(){ if(DL.items.some(i => ['queued','crawling','saving'].includes(i.status))) DL._ensureTimer() }
function updateDownloadBadges(){
  const total = DL.active().length + DL.ready().length + DL.activeBatches().length + DL.readyBatches().length,
        ind = $('#dlIndicator'), indC = $('#dlIndicatorCount');
  if(ind && indC){ ind.style.display = total ? '' : 'none'; indC.textContent = total }
  const b = $('#libBadge');
  if(b){ b.classList.toggle('on', total > 0); b.textContent = total }
}
async function exportCached(id){
  let e; try{ e = await cacheGet(id) }catch{ e = null }
  if(!e?.blob){ toast('File not available','danger'); return }
  const m = e.meta||{}, base = safeFileName([m.artist, m.name].filter(Boolean).join(' - ') || m.name || id),
        mime = m.mime||'audio/mpeg', ext = extFromType(mime, m.url||''),
        blob = new Blob([e.blob], {type:mime}), url = URL.createObjectURL(blob);
  try{
    const a = document.createElement('a');
    a.href = url; a.download = base+ext; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    haptic(14); toast(`Saved "${base+ext}"`);
  }catch{ try{ window.open(url,'_blank') }catch{}; toast('Opened in new tab') }
  setTimeout(() => { try{ URL.revokeObjectURL(url) }catch{} }, 18e4);
}
async function exportAllCached(){
  const all = await cacheAll();
  if(!all.length){ toast('Nothing to export','warning'); return }
  const ok = await askConfirm('Export all tracks?', `${all.length} file${all.length!==1?'s':''} will be saved.`, 'Export', 'primary');
  if(!ok) return;
  for(let i=0;i<all.length;i++){ await exportCached(all[i].trackId); await new Promise(r => setTimeout(r, 650)) }
  toast('Export finished','success');
  Notify.show('Export finished', `${all.length} file${all.length!==1?'s':''} exported`, {category:'download'});
}

/* ══ LIKE / FOLLOW / PLAYLIST / NOTES / STATS ════════════════════════════════ */
const getLikes = () => ls.get(KEY.likes,[]);
const isLiked = id => getLikes().some(t => String(t.trackId) === String(id));
function makeLikeEntry(it){
  return {
    trackId:String(it.trackId), trackName:it.trackName||'Unknown', artistName:it.artistName||'',
    artistId:it.artistId?String(it.artistId):'', collectionName:it.collectionName||'',
    collectionId:it.collectionId?String(it.collectionId):'', artworkUrl:getArtwork(it,100)||it.artworkUrl||'', addedAt:Date.now()
  };
}
function toggleLike(it){
  if(!it?.trackId) return;
  if(!MMAuth.user){
    toastAction('Sign in to like tracks', [{html:'<i class="bi bi-box-arrow-in-right"></i> Sign in', class:'primary', fn:()=>openAuth()}], 'warning', 6e3);
    return;
  }
  const id = String(it.trackId), l = getLikes(), i = l.findIndex(t => String(t.trackId) === id),
        wasLiked = i >= 0, nowLiked = !wasLiked;
  if(wasLiked){ l.splice(i,1); toast('Removed from Liked') } else { l.unshift(makeLikeEntry(it)); toast('Added to Liked') }
  ls.set(KEY.likes, l);
  haptic(8);
  reindexActionButtons(); refreshLikes();
  bumpLikeCount(id, nowLiked ? 1 : -1);
  _recoHomeDirty = true;
  if(currentPath() === '/') refreshHomeRecommendations();
  apiCall('/like/toggle', {method:'POST', body:JSON.stringify({trackId:id, liked:nowLiked})}).then(r => {
    if(r?.ok && r.data?.ok && typeof r.data.likes === 'number') setLikeCount(id, r.data.likes);
  }).catch(()=>{});
  if(isLibLikes()) viewLikes();
}
async function toggleLikeById(id){
  let it = getCached('track', id);
  if(!it){
    try{
      const r = await apiLookup(id, 'song');
      it = r.find(x => itemType(x) === 'track') || r[0];
      if(it) cacheItems([it]);
    }catch{}
  }
  if(it) toggleLike(it); else toast('Track not available','danger');
}
function refreshLikes(){
  if(_likeBtnsById.size === 0) return;
  const cur = Player.track ? String(Player.track.trackId) : null;
  for(const [id, arr] of _likeBtnsById){
    const on = isLiked(id);
    for(const b of arr){
      if(on !== b.classList.contains('liked')){
        b.classList.toggle('liked', on);
        const ic = b.firstElementChild;
        if(ic) ic.className = `bi ${on ? 'bi-heart-fill' : 'bi-heart'}`;
      }
    }
  }
  const fps = document.querySelectorAll('.fp-like-btn');
  if(!fps.length) return;
  for(const f of fps){
    const on = cur ? isLiked(cur) : false;
    f.classList.toggle('liked', on);
    const i = f.querySelector('i');
    if(i) i.className = `bi ${on ? 'bi-heart-fill' : 'bi-heart'}`;
  }
}

const getFollowed = () => ls.get(KEY.following,[]);
const isFollowed = id => !!id && getFollowed().some(a => String(a.artistId) === String(id));
function toggleFollow(aid, art){
  const id = String(aid); if(!id) return;
  if(!MMAuth.user){
    toastAction('Sign in to follow artists', [{html:'<i class="bi bi-box-arrow-in-right"></i> Sign in', class:'primary', fn:()=>openAuth()}], 'warning', 6e3);
    return;
  }
  const l = getFollowed(), i = l.findIndex(a => String(a.artistId) === id),
        wasFollowed = i >= 0, nowFollowed = !wasFollowed;
  if(wasFollowed){ l.splice(i,1); toast('Unfollowed') }
  else {
    const c = getCached('artist', id);
    l.unshift({artistId:id, artistName:c?.artistName||'', primaryGenreName:c?.primaryGenreName||'', artwork:art||getArtwork(c,300)||'', followedAt:Date.now()});
    toast('Following'); haptic(10);
  }
  ls.set(KEY.following, l);
  refreshFollowButtons();
  bumpFollowerCount(id, nowFollowed ? 1 : -1);
  _recoHomeDirty = true;
  if(currentPath() === '/') refreshHomeRecommendations();
  apiCall('/follow/toggle', {method:'POST', body:JSON.stringify({artistId:id, followed:nowFollowed})}).then(r => {
    if(r?.ok && r.data?.ok && typeof r.data.followers === 'number') setFollowerCount(id, r.data.followers);
  }).catch(()=>{});
  if(isLibFoll()) viewFollowing();
}
function refreshFollowButtons(){
  if(_followBtnsById.size === 0) return;
  for(const [id, arr] of _followBtnsById){
    const on = isFollowed(id);
    for(const b of arr){
      b.classList.toggle('following', on);
      b.classList.toggle('primary', !on);
      const i = b.querySelector('i');
      if(i) i.className = `bi ${on ? 'bi-check-lg' : 'bi-plus-lg'}`;
      const l = b.querySelector('.follow-label');
      if(l) l.textContent = on ? 'Following' : 'Follow';
      const c = b.querySelector('.follow-count');
      if(c){ const n = Number(b.dataset.followers)||0; c.textContent = n>0 ? fmtCompact(n) : '' }
    }
  }
}

const getPlaylists = () => ls.get(KEY.pls,[]);
const savePlaylists = p => { ls.set(KEY.pls, p); if(typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists() };
function createPlaylist(n){
  n = (n||'').trim(); if(!n) return null;
  const pl = {id:'pl_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6), name:n, tracks:[], createdAt:Date.now(), updatedAt:Date.now(), isPublic:false, description:'', cover:''};
  const a = getPlaylists(); a.push(pl); savePlaylists(a);
  toast(`Created "${n}"`);
  return pl;
}
function removeFromPlaylist(pid, tid){
  const a = getPlaylists(), pl = a.find(p => p.id === pid);
  if(!pl) return;
  pl.tracks = pl.tracks.filter(t => String(t.trackId) !== String(tid));
  pl.updatedAt = Date.now();
  savePlaylists(a);
  if(pl.isPublic) syncPlaylistToServer(pid).catch(()=>{});
  if(isPlDet(pid)) renderPlaylistDetail(pid);
}

const getRecentlyPlayed = () => ls.get(KEY.plays,[]);
function pushRecentlyPlayed(it){
  if(!it?.trackId) return;
  const id = String(it.trackId), l = getRecentlyPlayed().filter(x => String(x.trackId) !== id);
  l.unshift({trackId:id, trackName:it.trackName||'Track', artistName:it.artistName||'', artistId:it.artistId?String(it.artistId):'', collectionName:it.collectionName||'', collectionId:it.collectionId?String(it.collectionId):'', artworkUrl:getArtwork(it,100)||it.artworkUrl||'', at:Date.now()});
  ls.set(KEY.plays, l.slice(0,30));
}

const getNotes = () => ls.get(KEY.notes,{});
const getNote = id => getNotes()[String(id)] || '';
function setNote(id, txt){
  const m = getNotes();
  if(txt && txt.trim()) m[String(id)] = {t:txt.trim(), at:Date.now()};
  else delete m[String(id)];
  ls.set(KEY.notes, m);
  toast(txt ? 'Note saved' : 'Note removed');
}
async function editNote(id){
  const cur = getNote(id), v = await askText(cur ? 'Edit note' : 'Add note', cur, 'Personal note about this track');
  if(v === null) return;
  setNote(id, v);
  if(currentPath() === '/track/'+id) viewTrack(id);
}

let _sc = null;
const getStats = () => {
  if(!_sc) _sc = ls.get(KEY.stats, {totalMs:0, plays:0, tracks:{}, days:{}});
  if(!_sc || typeof _sc !== 'object') _sc = {totalMs:0, plays:0, tracks:{}, days:{}};
  if(!_sc.tracks || typeof _sc.tracks !== 'object') _sc.tracks = {};
  if(!_sc.days || typeof _sc.days !== 'object') _sc.days = {};
  return _sc;
};
const saveStats = () => { if(_sc) ls.set(KEY.stats, _sc) };
let _sst = 0;
function backfillArtistArtwork(aid, art){
  if(!aid || !art) return;
  const a = String(aid), s = getStats(); let ch = false;
  for(const id in s.tracks){
    const t = s.tracks[id];
    if(String(t.artistId||'') === a && !t.artistArtwork){ t.artistArtwork = art; ch = true }
  }
  if(ch) saveStats();
}
function _statsRecord(ms){
  if(!Player.track?.trackId || ms < 1e3) return;
  const s = getStats();
  s.totalMs = (s.totalMs||0) + ms;
  const id = String(Player.track.trackId), aid = Player.track.artistId ? String(Player.track.artistId) : '',
        ca = getCached('artist', aid), aa = ca ? getArtwork(ca,300)||'' : '';
  if(!s.tracks[id]) s.tracks[id] = {count:0, ms:0, name:Player.track.trackName||'Track', artist:Player.track.artistName||'', artistId:aid, artwork:getArtwork(Player.track,100)||'', artistArtwork:aa, lastAt:0};
  else if(aa && !s.tracks[id].artistArtwork) s.tracks[id].artistArtwork = aa;
  s.tracks[id].count++; s.tracks[id].ms += ms; s.tracks[id].lastAt = Date.now();
  const day = new Date().toISOString().slice(0,10);
  s.days[day] = (s.days[day]||0) + ms;
  if(Object.keys(s.days).length > 180){ const ks = Object.keys(s.days).sort(); for(let i=0;i<ks.length-180;i++) delete s.days[ks[i]] }
  const keys = Object.keys(s.tracks);
  if(keys.length > 1e3){
    const keep = keys.sort((a,b) => (s.tracks[b].lastAt||0)-(s.tracks[a].lastAt||0)).slice(0,1e3), nu = {};
    for(const k of keep) nu[k] = s.tracks[k];
    s.tracks = nu;
  }
  saveStats();
}
function statsStart(){ if(!Player.track?.trackId){ _sst = 0; return } _sst = Date.now(); const s = getStats(); s.plays = (s.plays||0)+1; saveStats() }
function statsTick(){ if(!_sst || !Player.track?.trackId) return; const now = Date.now(), ms = now - _sst; if(ms < 1e3) return; _sst = now; _statsRecord(ms) }
function statsStop(){ if(!_sst) return; const ms = Date.now() - _sst; _sst = 0; if(ms >= 1e3) _statsRecord(ms) }
function resetStats(){ _sc = {totalMs:0, plays:0, tracks:{}, days:{}}; saveStats(); toast('Stats cleared'); Notify.show('Stats cleared','',{category:'misc'}) }

/* ══ AUDIO ELEMENT ═══════════════════════════════════════════════════════════ */
const audio = new Audio();
audio.preload = 'metadata';
audio.volume = (() => { const v = ls.get(KEY.vol, null); return typeof v === 'number' && v >= 0 && v <= 1 ? v : .85 })();
(function(){
  if(audio.__unlockInstalled) return;
  audio.__unlockInstalled = true;
  const unlock = () => {
    try{ const A = window.AudioContext||window.webkitAudioContext; if(A){ const c = new A(); c.resume().then(()=>c.close()).catch(()=>{}) } }catch{}
    document.removeEventListener('touchstart', unlock, true);
    document.removeEventListener('click', unlock, true);
  };
  document.addEventListener('touchstart', unlock, {capture:true, once:true, passive:true});
  document.addEventListener('click', unlock, {capture:true, once:true});
})();
function crossfadeOut(ms){
  return new Promise(res => {
    if(!ms || ms < 200 || !Player.playing){ res(); return }
    const sv = audio.volume, t0 = performance.now();
    const s = () => {
      const t = (performance.now() - t0)/ms;
      if(t >= 1){ audio.volume = sv; res(); return }
      audio.volume = Math.max(0, sv*(1-t));
      requestAnimationFrame(s);
    };
    s();
  });
}

let _fi = false;
/* ══ STREAM AUTO-RECOVERY — survives ERR_CONNECTION_RESET mid-playback ══ */
const _stream = {
  lastGoodTime: 0,   // آخرین نقطه‌ای که واقعاً در حال پخش بود
  attempts: 0,       // تعداد تلاش reconnect در چرخه‌ی خطای فعلی
  blobTried: false,  // آیا در این ترک fallback به blob انجام شده
  timer: null,
  blobbing: false,
};

function _resetStreamState(){
  _stream.attempts = 0;
  if(_stream.timer){ clearTimeout(_stream.timer); _stream.timer = null }
}

function _clearBlobUrl(){
  if(audio.dataset.blobUrl){
    try{ URL.revokeObjectURL(audio.dataset.blobUrl) }catch{}
    delete audio.dataset.blobUrl;
  }
}

audio.addEventListener('timeupdate', () => {
  if(!audio.error && audio.readyState >= 2 && audio.currentTime > 0){
    _stream.lastGoodTime = audio.currentTime;
  }
});
audio.addEventListener('playing', () => {
  // intentionally no-op: a 1-second buffer followed by a reset should
  // NOT reset _stream.attempts, otherwise we never reach the blob
  // fallback for URLs that consistently reset mid-stream.
  _stream._lastPlayingAt = performance.now();
});
async function playItemViaBlob(item, url, isPreview, gen){
  const id = String(item.trackId);

  /* ── Update the player UI FIRST, before the (potentially very slow) fetch ── */
  audio.pause();
  _clearBlobUrl();
  Player.track      = item;
  Player.isPreview  = !!isPreview;
  Player.preparing  = true;
  pushRecentlyPlayed(item);
  setQueueFromItem(item, id);
  syncPlayerUI();                 // title, artist, artwork, queue, icons all update now

  try{
    toast('Preparing playback…', 'info');
    const blob = await _fetchFullBlobWithRetry(proxyUrl(url));
    if(gen !== _playGen) return;              // user switched tracks — abort silently
    if(!blob || blob.size < 100) throw new Error('Empty or invalid audio file');

    _clearBlobUrl();
    const u = URL.createObjectURL(blob);
    audio.dataset.blobUrl = u;
    audio.src = u;
    audio.load();
    const pp = audio.play();
    if(pp && typeof pp.catch === 'function') pp.catch(()=>{});

    if(getSettings().autoSavePlayed && !isCached(id)){
      try{
        await cachePut(id, blob, metaFromTrack(item));
        cachedIds.add(id);
        updateDownloadBadges();
        syncSaveButton();
        if(typeof isLibDl === 'function' && isLibDl()) updateDlLists(true);
        if(typeof isTrackRoute === 'function' && isTrackRoute()){
          const t2 = getCached('track', id);
          if(t2) renderCrawlCard(t2, null);
        }
      }catch{}
    }
  }catch(e){
    console.warn('[playItemViaBlob]', e);
    if(gen === _playGen){
      toast('Playback failed: ' + (e.message || e || 'unknown'), 'danger');
      showUnavailableSheet(id, item);
    }
  }finally{
    if(gen === _playGen){
      Player.preparing = false;
      syncPlayIcons();
    }
  }
}
async function _fetchFullBlobWithRetry(url){
  let lastErr;
  for(let i = 0; i < 4; i++){
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 300000);
    try{
      const res  = await fetch(url, {cache:'no-store', signal: ctrl.signal});
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const total  = Number(res.headers.get('content-length')) || 0;
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if(reader){
        const ch = []; let rec = 0;
        while(true){
          const {done, value} = await reader.read();
          if(done) break;
          ch.push(value); rec += value.length;
        }
        if(total > 0 && rec < total) throw new Error(`Incomplete ${rec}/${total}`);
        return new Blob(ch);
      }
      return await res.blob();
    }catch(e){
      lastErr = e;
      console.warn(`[stream] blob fetch attempt ${i+1} failed:`, e && e.message);
    }finally{
      clearTimeout(to);
    }
    if(i < 3) await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  throw lastErr || new Error('Download failed');
}

async function _resumeStreamViaBlob(trackId, resumeAt){
  if(_stream.blobbing) return;
  _stream.blobbing = true;
  const t = getCached('track', trackId) || Player.track;
  try{
    if(!t || String(t.trackId) !== String(trackId)) return;

    // 1) آیا در کش IndexedDB هست؟
    let blob = null;
    try{
      const e = await cacheGet(trackId);
      if(e && e.blob) blob = e.blob;
    }catch{}

    // 2) دانلود کامل با retry
    if(!blob){
      const url = getPlayable(t);
      if(!url) throw new Error('No source URL');
      toast('Reconnecting…', 'info');
      blob = await _fetchFullBlobWithRetry(proxyUrl(url));
    }

    // 3) تعویض src روی blob
    audio.pause();
    _clearBlobUrl();
    const u = URL.createObjectURL(blob);
    audio.dataset.blobUrl = u;
    audio.src = u;
    audio.load();

    // 4) منتظر metadata
    await new Promise((resolve, reject) => {
      const onMeta = () => { cleanup(); resolve() };
      const onErr  = () => { cleanup(); reject(new Error('blob decode failed')) };
      const to = setTimeout(() => { cleanup(); reject(new Error('timeout')) }, 12000);
      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', onMeta);
        audio.removeEventListener('error', onErr);
        clearTimeout(to);
      };
      audio.addEventListener('loadedmetadata', onMeta, {once:true});
      audio.addEventListener('error', onErr, {once:true});
    });

    // 5) برگرد به همان موقعیت
    if(resumeAt > 0 && isFinite(audio.duration) && audio.duration > resumeAt){
      try{ audio.currentTime = Math.max(0, Math.min(resumeAt, audio.duration - 0.25)) }catch{}
    }

    await audio.play();
    Player.isPreview = false;
    _stream.lastGoodTime = audio.currentTime;
    toast('Resumed', 'success');
  }catch(err){
    console.warn('[stream] blob resume failed', err);
    toast('Playback failed: ' + (err && err.message || err), 'danger');
    showUnavailableSheet(trackId, t);
  }finally{
    _stream.blobbing = false;
  }
}

function _tryResumeStream(){
  if(_stream.blobbing) return;                      // وسط سوییچ به blob
  const t = Player.track;
  if(!t || !t.trackId) return;
  const trackId = String(t.trackId);
  const src = audio.src;
  if(!src || src.startsWith('blob:') || src.startsWith('data:')) return;

  const resumeAt = _stream.lastGoodTime || 0;

  // بعد از ۲ تلاش ناموفق → fallback قطعی به blob
  if(_stream.attempts >= 2){
    if(_stream.blobTried){ return }                 // یک بار بیشتر تلاش نکن
    _stream.blobTried = true;
    _resetStreamState();
    _resumeStreamViaBlob(trackId, resumeAt);
    return;
  }

  _stream.attempts++;
  if(_stream.timer){ clearTimeout(_stream.timer) }
  _stream.timer = setTimeout(() => {
    _stream.timer = null;
    if(_stream.blobbing) return;
    if(audio.src !== src){ _resetStreamState(); return }                       // ترک عوض شد
    if(String(Player.track && Player.track.trackId) !== trackId){ _resetStreamState(); return }
    try{
      // سوکت قدیمی را کامل تخریب کن — بدون این، play() فقط همان سوکت مرده را صدا می‌زند
      audio.pause();
      audio.src = '';
      audio.load();
      // اتصال تازه به همان URL
      audio.src = src;
      audio.load();
      const onMeta = () => {
        audio.removeEventListener('loadedmetadata', onMeta);
        if(resumeAt > 0 && isFinite(audio.duration) && audio.duration > resumeAt){
          try{ audio.currentTime = Math.max(0, Math.min(resumeAt, audio.duration - 0.25)) }catch{}
        }
        audio.play().catch(()=>{});
      };
      audio.addEventListener('loadedmetadata', onMeta, {once:true});
      // اگر metadata هم نرسید → مستقیم blob
      setTimeout(() => {
        if(String(Player.track && Player.track.trackId) !== trackId) return;
        // Fall back to blob if: error is set, OR we're still not really playing
// after 6 s (stalled readyState / no progress). Do not require `audio.error`
// — some resets only surface via a stalled networkState.
const stillBroken = !!audio.error
                 || !Player.playing
                 || audio.readyState < 2;
if(!stillBroken) return;
        if(_stream.blobTried) return;
        _stream.blobTried = true;
        _resetStreamState();
        _resumeStreamViaBlob(trackId, resumeAt);
      
          
      }, 6000);
    }catch(e){
      console.warn('[stream] reconnect failed', e);
      _stream.blobTried = true;
      _resumeStreamViaBlob(trackId, resumeAt);
    }
  }, 500 * _stream.attempts);
}
audio.addEventListener('play', () => {
  const x = Number(getSettings().crossfade||0);
  if(x && _fi){
    _fi = false;
    const tg = Number(ls.get(KEY.vol, null)) || .85;
    audio.volume = 0;
    const t0 = performance.now();
    const s = () => {
      const t = (performance.now() - t0)/x;
      if(t >= 1 || !Player.playing){ audio.volume = tg; return }
      audio.volume = tg*t;
      requestAnimationFrame(s);
    };
    s();
  }
});
let _xtr = false;
audio.addEventListener('timeupdate', () => {
  const x = Number(getSettings().crossfade||0);
  if(!x || _xtr || !audio.duration) return;
  if(audio.duration - audio.currentTime <= x/1e3){ _xtr = true; _fi = true; crossfadeOut(x) }
});
audio.addEventListener('play', () => { _xtr = false });

function abToggle(){
  const ab = Player.abRepeat;
  if(ab.a == null){ ab.a = audio.currentTime; if(ab.b != null && ab.b <= ab.a) ab.b = null; toast(`A · ${fmtTime(ab.a)}`) }
  else if(ab.b == null){ ab.b = audio.currentTime; if(ab.b <= ab.a+.5){ ab.b = null; toast('B too close','warning'); return } toast(`B · ${fmtTime(ab.b)}`) }
  else { Player.abRepeat = {a:null, b:null}; toast('A-B cleared') }
  updateAbChip();
}
function updateAbChip(root){
  const s = root || document;
  s.querySelectorAll('.ab-chip').forEach(c => {
    const ab = Player.abRepeat;
    if(ab.a == null){ c.classList.add('off'); c.innerHTML = ''; return }
    c.classList.remove('off');
    c.innerHTML = `<i class="bi bi-repeat"></i> A ${fmtTime(ab.a)} · B ${ab.b != null ? fmtTime(ab.b) : '—'}`;
  });
}
audio.addEventListener('timeupdate', () => {
  const ab = Player.abRepeat;
  if(ab.a != null && ab.b != null && audio.currentTime >= ab.b){ try{ audio.currentTime = ab.a }catch{} }
});
window.setSleepTimer = function(m){
  sheet('#sheetSleep').hide();
  if(Player.sleepTimer){ clearTimeout(Player.sleepTimer); Player.sleepTimer = null }
  const i = $('#sleepIcon'), pb = $('#pbSleepIcon');
  if(!m){ if(i) i.className = 'bi bi-moon'; if(pb) pb.className = 'bi bi-moon'; toast('Sleep timer off'); return }
  if(i) i.className = 'bi bi-moon-fill';
  if(pb) pb.className = 'bi bi-moon-fill';
  Player.sleepTimer = setTimeout(async () => {
    const s = getSettings();
    if(s.sleepFade !== false) await crossfadeOut(3e3);
    audio.pause();
    audio.volume = Number(ls.get(KEY.vol, null)) || .85;
    Player.sleepTimer = null;
    if(i) i.className = 'bi bi-moon';
    if(pb) pb.className = 'bi bi-moon';
    toast('Sleep timer — paused');
    Notify.show('Sleep timer', 'Playback paused', {category:'misc'});
  }, m*6e4);
  toast(`Sleep · ${m} min${getSettings().sleepFade !== false ? ' (fades out)' : ''}`);
};
function openSleepTimer(){ sheet('#sheetSleep').show() }

/* ══ DATA EXPORT / IMPORT ════════════════════════════════════════════════════ */
function exportData(){
  const d = {
    __mm_backup:3, exportedAt:new Date().toISOString(),
    likes:ls.get(KEY.likes,[]), playlists:ls.get(KEY.pls,[]), following:ls.get(KEY.following,[]),
    recent:ls.get(KEY.recent,[]), plays:ls.get(KEY.plays,[]), stats:ls.get(KEY.stats,{}),
    settings:ls.get(KEY.settings,{}), notes:ls.get(KEY.notes,{})
  };
  const b = new Blob([JSON.stringify(d,null,2)], {type:'application/json'}),
        u = URL.createObjectURL(b), a = document.createElement('a');
  a.href = u; a.download = `musicman-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 5e3);
  toast('Backup downloaded');
  Notify.show('Backup exported','',{category:'misc'});
}
function importData(){
  const i = document.createElement('input');
  i.type = 'file'; i.accept = '.json,application/json';
  i.onchange = async () => {
    const f = i.files?.[0]; if(!f) return;
    try{
      const d = JSON.parse(await f.text());
      if(!d.__mm_backup) throw new Error('Not a MusicMan backup');
      const ok = await askConfirm('Import backup?', 'Current data will be replaced.', 'Import', 'primary');
      if(!ok) return;
      [['likes', d.likes], ['pls', d.playlists], ['following', d.following], ['recent', d.recent], ['plays', d.plays]].forEach(([k,v]) => {
        if(Array.isArray(v)) ls.set(KEY[k], v);
      });
      if(d.stats){ _sc = d.stats; saveStats() }
      if(d.notes) ls.set(KEY.notes, d.notes);
      if(d.settings) ls.set(KEY.settings, d.settings);
      applySettings();
      toast('Backup restored');
      Notify.show('Backup restored', `${d.likes?.length||0} likes, ${d.playlists?.length||0} playlists`, {category:'misc'});
      sheet('#sheetSettings').hide();
      const y = MAIN().scrollTop;
      await route();
      MAIN().scrollTop = y;
    }catch(e){ toast('Import failed: '+e.message, 'danger') }
  };
  i.click();
}

/* ══ ROUTING ═════════════════════════════════════════════════════════════════ */
function currentPath(){
  let p = location.pathname;
  if(BASE && p.startsWith(BASE)) p = p.slice(BASE.length);
  if(!p) p = '/';
  if(!p.startsWith('/')) p = '/'+p;
  p = p.replace(/\/+$/,'');
  return p || '/';
}
function parseRoute(){
  const path = currentPath().replace(/^\/+/,''),
        parts = path ? path.split('/') : [],
        q = new URLSearchParams(location.search || '');
  return {parts, q};
}
const scrollMemory = new Map();
function go(path){
  if(!path) path = '/';
  if(!path.startsWith('/')) path = '/'+path;
  const target = (BASE||'') + path, current = location.pathname + location.search + location.hash;
  if(current === target){ const m = MAIN(); if(m){ try{ m.scrollTo({top:0, behavior:'smooth'}) }catch{ m.scrollTop = 0 } } return }
  try{ history.pushState(null,'',target) }catch{ location.href = target; return }
  route();
}
window.goBack = function(){ if(history.length > 1) history.back(); else go('/') };
window.addEventListener('popstate', () => route());

document.addEventListener('click', e => {
  if(e.defaultPrevented) return;
  if(e.button !== undefined && e.button !== 0) return;
  if(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]'); if(!a) return;
  if(a.hasAttribute('download') || a.hasAttribute('data-no-spa')) return;
  const raw = a.getAttribute('href') || '';
  if(!raw) return;
  if(/^(mailto:|tel:|sms:|javascript:|data:|blob:)/i.test(raw)) return;
  if(raw.startsWith('#')) return;
  if(/^https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i.test(raw)){ e.preventDefault(); e.stopPropagation(); openTgUrl(raw); return }
  let u; try{ u = new URL(raw, location.href) }catch{ return }
  if(u.origin !== location.origin) return;
  let p = u.pathname;
  if(BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || '/';
  if(!p.startsWith('/')) p = '/'+p;
  const target = (BASE||'') + p + (u.search||'') + (u.hash||''), current = location.pathname + location.search + location.hash;
  e.preventDefault();
  if(current === target){ const m = MAIN(); if(m){ try{ m.scrollTo({top:0, behavior:'smooth'}) }catch{ m.scrollTop = 0 } } return }
  try{ history.pushState(null,'',target) }catch{ location.href = target; return }
  route();
}, true);

document.addEventListener('mouseover', e => {
  if(!IS_DESKTOP()) return;
  if(IS_LOW_END || Net.saveData || Net.isSlow) return;
  const a = e.target.closest('a[href*="/track/"]'); if(!a) return;
  const img = a.querySelector('img[src]');
  if(img) prefetchArtwork(img.getAttribute('src'));
  const m = a.getAttribute('href').match(/\/track\/([A-Za-z0-9_\-]+)/); if(!m) return;
  const id = m[1];
  if(getCached('track', id)) return;
  if(_ftCache.has(id) && _ftCache.get(id).exp > Date.now()) return;
  DL._fetchTrack(id).catch(()=>{});
}, {passive:true});

/* Route guards */
const isLibLikes = () => currentPath() === '/library/likes';
const isLibFoll = () => currentPath() === '/library/following';
const isLibDl = () => currentPath() === '/library/downloads';
const isLibPl = () => currentPath() === '/library/playlists';
const isLibHist = () => currentPath() === '/library/history';
const isLibStats = () => currentPath() === '/library/stats';
const isPlDet = id => currentPath() === '/library/playlists/'+id;
const isTrackRoute = () => currentPath().startsWith('/track/');
function activeNavFor(p){ const f = p[0]||''; if(f === 'search') return 'search'; if(f === 'library') return 'library'; if(f === 'social') return 'social'; if(f === '') return 'home'; return '' }
const NAV_ICONS = {
  home:{on:'bi-house-door-fill', off:'bi-house-door'},
  search:{on:'bi-search', off:'bi-search'},
  social:{on:'bi-people-fill', off:'bi-people'},
  library:{on:'bi-collection-fill', off:'bi-collection'}
};
function updateNav(p){
  const a = activeNavFor(p);
  $$('[data-nav]').forEach(el => {
    const k = el.dataset.nav, on = k === a;
    el.classList.toggle('active', on);
    const i = el.querySelector('i');
    if(i && NAV_ICONS[k]) i.className = `bi ${on ? NAV_ICONS[k].on : NAV_ICONS[k].off}`;
  });
  const bt = $('#brandText'), bar = $('#barTitle');
  if(p.length === 0){ if(bt) bt.parentElement.style.display = ''; if(bar){ bar.classList.add('d-none'); bar.textContent = 'MusicMan' } if(bt) bt.classList.remove('d-none'); }
  else { if(bt) bt.classList.add('d-none'); if(bar){ bar.classList.remove('d-none'); bar.textContent = titleFor(p) } }
}
function setPageTitle(t){
  const site = 'MusicMan';
  document.title = t ? `${t} · ${site}` : `${site} — Music Player`;
  const bar = $('#barTitle');
  if(bar) bar.textContent = t || site;
}
function titleFor(p){
  if(p[0] === 'search') return 'Search';
  if(p[0] === 'library') return p[1] ? p[1].charAt(0).toUpperCase()+p[1].slice(1) : 'Library';
  if(p[0] === 'artist') return 'Artist';
  if(p[0] === 'album') return 'Album';
  if(p[0] === 'track') return 'Track';
  if(p[0] === 'p') return 'Playlist';
  if(p[0] === 'u') return 'Profile';
  if(p[0] === 'account') return 'Account';
  if(p[0] === 'social') return 'Social';
  if(p[0] === 'recommendations') return 'Recommended';
  return 'Home';
}

let _aiPage = 1, _aiHasMore = true, _aiLoading = false, _aiObserver = null;
let _aiScrollBound = false, _aiPendingSections = 0, _aiLastError = null;
function resetAiState(){
  _aiPage = 1; _aiHasMore = true; _aiLoading = false; _aiPendingSections = 0; _aiLastError = null;
  if(_aiObserver){ try{ _aiObserver.disconnect() }catch{}; _aiObserver = null }
}
let _navGen = 0, _pageTracks = [], _homeCache = null, _homeRendered = false,
    _recoHomeCache = null, _recoHomeDirty = true;
function invalidateHomeCache(){ _recoHomeDirty = true; _homeRendered = false }
let _trackSectionObs = null;
function disconnectTrackSectionObs(){ if(_trackSectionObs){ try{ _trackSectionObs.disconnect() }catch{}; _trackSectionObs = null } }

const nextPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

async function route(){
  const gen = ++_navGen;
  if(currentPath() === '/' && _homeRendered && _homeCache){ _homeCache.top = MAIN().scrollTop; _homeCache.at = Date.now() }
  Progress.start();
  document.body.classList.add('mm-nav-busy');
  resetAiState();
  disconnectRecoObserver();
  disconnectTrackSectionObs();
  closeAllSheets();
  disconnectArtistTracksObserver();
  if(typeof dlUnsub === 'function' && dlUnsub){ dlUnsub(); dlUnsub = null }
  _pageTracks = [];
  const {parts, q} = parseRoute();
  updateNav(parts);
  syncSidebarNav();
  closeFullPlayer();
  showSkeleton();
  await nextPaint();
  try{
    switch(parts[0]){
      case undefined: setPageTitle(''); await viewHome(); break;
      case 'search': setPageTitle(q.get('q') ? `Search: ${q.get('q')}` : 'Search'); await viewSearch(q.get('q')||''); break;
      case 'artist': await viewArtist(parts[1]); break;
      case 'album': await viewAlbum(parts[1]); break;
      case 'track': await viewTrack(parts[1]); break;
      case 'p': await viewPublicPlaylist(parts[1]); break;
      case 'u': await viewUserProfile(parts[1], parts[2]||'stats'); break;
      case 'account': setPageTitle('Account'); await viewAccountPage(); break;
      case 'social': setPageTitle('Social'); await viewSocial(q.get('tab')||'feed'); break;
      case 'recommendations': setPageTitle('Recommended'); await viewRecommendations(); break;
      case 'library': {
        if(parts[1] === 'playlists'){ if(parts[2]) renderPlaylistDetail(parts[2]); else { setPageTitle('Playlists'); viewPlaylists() } }
        else if(parts[1] === 'downloads'){ setPageTitle('Offline Downloads'); renderDownloads() }
        else if(parts[1] === 'following'){ setPageTitle('Following'); viewFollowing() }
        else if(parts[1] === 'history'){ setPageTitle('Listening History'); viewHistory() }
        else if(parts[1] === 'stats'){ setPageTitle('Listening Stats'); viewStats() }
        else { setPageTitle('Liked Songs'); viewLikes() }
        break;
      }
      default: setPageTitle(''); await viewHome();
    }
    if(gen !== _navGen) return;
  }catch(e){
    if(gen !== _navGen) return;
    console.error('[route]', e);
    MAIN().innerHTML = errorState(e.message);
  }
  const newKey = currentPath() + location.search;
  const restored = scrollMemory.get(newKey);
  if(restored != null) MAIN().scrollTop = restored;
  else MAIN().scrollTop = 0;
  reindexActionButtons();
  refreshLikes();
  refreshFollowButtons();
  updateRightPanel();
  scrollActiveLibTab();
  document.dispatchEvent(new Event('mm:route'));
  Progress.done();
  document.body.classList.remove('mm-nav-busy');
  const m = MAIN();
  if(m){ m.classList.remove('page-enter'); void m.offsetWidth; m.classList.add('page-enter') }
}

/* ══ SKELETON ════════════════════════════════════════════════════════════════ */
const SK = {
  l: (w, cls='')  => `<div class="sk sk-l ${cls}"${w?` style="width:${w}"`:''}></div>`,
  b: (w, h, r)    => `<div class="sk" style="width:${w};height:${h}${r?`;border-radius:${r}`:''}"></div>`,
  c: (s)          => `<div class="sk sk-c" style="width:${s}px;height:${s}px"></div>`,
  card:       () => `<div class="sk-card"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>`,
  artistCard: () => `<div class="sk-artist-card"><div class="sk"></div><div class="sk"></div></div>`,
  rail: (n, artist=false) => `<div class="sk-rail">${Array.from({length:n}).map(() => artist ? SK.artistCard() : SK.card()).join('')}</div>`,
  row: () => `<div class="sk-row"><div class="sk sk-c sk-play"></div><div class="sk sk-art"></div><div class="sk-lines"><div class="sk sk-l"></div><div class="sk sk-l"></div></div></div>`,
  rows: n => Array.from({length:n}).map(SK.row).join(''),
  histRow: () => `<div class="sk-hist-row"><div class="sk sk-c sk-play"></div><div class="sk sk-art"></div><div class="sk-lines"><div class="sk sk-l"></div><div class="sk sk-l"></div></div><div class="sk sk-c sk-tail"></div></div>`,
  histRows: n => Array.from({length:n}).map(SK.histRow).join(''),
  dlRow: () => `<div class="sk-dl-row"><div class="sk sk-art"></div><div class="sk-lines"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div></div>`,
  dlRows: n => Array.from({length:n}).map(SK.dlRow).join(''),
  feed: () => `<div class="sk-feed"><div class="sk-fhead"><div class="sk sk-c sk-avatar"></div><div class="sk-lines"><div class="sk"></div><div class="sk"></div></div></div><div class="sk-fbody"><div class="sk sk-art"></div><div class="sk-lines"><div class="sk"></div><div class="sk"></div></div></div></div>`,
  feeds: n => Array.from({length:n}).map(SK.feed).join(''),
  settingsRow: (ctrl=true) => `<div class="sk-settings-row"><div class="sk sk-ico"></div><div class="sk-lines"><div class="sk"></div><div class="sk"></div></div>${ctrl ? '<div class="sk sk-ctrl"></div>' : ''}</div>`,
  settingsRows: (n, ctrl=true) => Array.from({length:n}).map(() => SK.settingsRow(ctrl)).join(''),
  tabs:      (widths=[78,96,84,90,80]) => `<div class="sk-tabs">${widths.map(w => `<div class="sk" style="width:${w}px"></div>`).join('')}</div>`,
  filterRow: (widths=[62,78,72,68]) => `<div class="sk-filter-row">${widths.map(w => `<div class="sk" style="width:${w}px"></div>`).join('')}</div>`,
  searchBar: () => `<div class="sk-search-wrap"><div class="sk-search-box"><div class="sk"></div><div class="sk"></div></div></div>`,
  sectionHead: () => `<div class="sk-section-head"><div class="sk"></div><div class="sk"></div></div>`,
  head: (tight=false) => `<div class="sk-head${tight?' tight':''}"><div class="sk"></div><div class="sk"></div></div>`,
  hero: (round=false) => `<div class="sk-hero${round?' round':''}"><div class="sk sk-hero-art"></div><div class="sk sk-l"></div><div class="sk sk-l"></div></div>`,
  actions: (specs) => `<div class="sk-actions">${specs.map(s => s[1] === 'c' ? `<div class="sk sk-c" style="width:${s[0]}px;height:${s[0]}px"></div>` : `<div class="sk" style="width:${s[0]}px"></div>`).join('')}</div>`,
  socialHead: () => `<div class="sk-social-head"><div class="sk sk-c sk-avatar"></div><div class="sk-lines"><div class="sk"></div><div class="sk"></div></div></div>`,
  profileHero: () => `<div class="sk-profile-hero"><div class="sk sk-c"></div><div class="sk"></div><div class="sk"></div></div>`,
  statGrid: (n, cols=2) => `<div class="sk-stat-grid cols-${cols}">${Array.from({length:n}).map(() => '<div class="sk"></div>').join('')}</div>`,
  weekChart: () => { const hs = [40,62,28,78,55,88,46]; return `<div class="sk-week-chart">${hs.map(h => `<div class="sk" style="height:${h}%"></div>`).join('')}</div>` },
  pageHome: () => `<div class="sk-page">${SK.head(true)}${SK.sectionHead()}${SK.rail(4)}${SK.sectionHead()}${SK.rail(4)}${SK.sectionHead()}${SK.rail(4)}${SK.sectionHead()}${SK.rail(4, true)}</div>`,
  pageTrack: () => `<div class="sk-page">${SK.hero()}${SK.actions([[120],[96],[44,'c'],[44,'c'],[44,'c'],[44,'c']])}${SK.rows(IS_LOW_END ? 4 : 6)}</div>`,
  pageAlbum: () => `<div class="sk-page">${SK.hero()}${SK.actions([[110],[130],[96],[44,'c'],[44,'c']])}${SK.rows(IS_LOW_END ? 5 : 8)}</div>`,
  pageArtist: () => `<div class="sk-page">${SK.hero(true)}${SK.actions([[110],[110],[96],[96],[44,'c'],[44,'c']])}${SK.sectionHead()}${SK.rows(IS_LOW_END ? 3 : 5)}${SK.sectionHead()}${SK.rail(4)}${SK.filterRow([78,84,92])}${SK.rows(IS_LOW_END ? 4 : 7)}</div>`,
  pageSearch: hasQ => `<div class="sk-page">${SK.searchBar()}${hasQ ? SK.filterRow([62,78,72,68]) : ''}${SK.sectionHead()}${SK.rail(4, true)}${SK.sectionHead()}${SK.rail(4)}${hasQ ? SK.rows(IS_LOW_END ? 4 : 7) : ''}</div>`,
  pageLibrary: () => `<div class="sk-page">${SK.tabs()}${SK.head()}${SK.rows(IS_LOW_END ? 5 : 9)}</div>`,
  pageDownloads: () => `<div class="sk-page">${SK.tabs()}${SK.head()}${SK.statGrid(4, 4)}${SK.dlRows(IS_LOW_END ? 3 : 5)}</div>`,
  pageStats: () => `<div class="sk-page">${SK.tabs()}${SK.head()}${SK.statGrid(4, 2)}${SK.weekChart()}${SK.sectionHead()}${SK.rail(4, true)}${SK.rows(IS_LOW_END ? 4 : 6)}</div>`,
  pageHistory: () => `<div class="sk-page">${SK.tabs()}${SK.head()}${SK.histRows(IS_LOW_END ? 5 : 9)}</div>`,
  pagePlaylists: () => `<div class="sk-page">${SK.tabs()}${SK.head()}${SK.rail(4)}</div>`,
  pageSocial: tab => {
    const h = SK.socialHead() + SK.tabs([80,100,92,96,90]);
    if(tab === 'discover')  return `<div class="sk-page">${h}${SK.searchBar()}${SK.rows(5)}</div>`;
    if(tab === 'playlists') return `<div class="sk-page">${h}${SK.rail(4)}</div>`;
    if(tab === 'following' || tab === 'followers') return `<div class="sk-page">${h}${SK.settingsRows(IS_LOW_END?4:6, false)}</div>`;
    return `<div class="sk-page">${h}${SK.feeds(IS_LOW_END ? 3 : 5)}</div>`;
  },
  pageProfile: () => `<div class="sk-page">${SK.profileHero()}${SK.tabs([80,90,96,82,92])}${SK.statGrid(3, 3)}${SK.sectionHead()}${SK.rail(4, true)}${SK.rows(IS_LOW_END ? 4 : 6)}</div>`,
  pageAccount: () => `<div class="sk-page">${SK.profileHero()}${SK.tabs([92,130,44])}${SK.settingsRows(IS_LOW_END ? 3 : 4)}</div>`,
  pageRecommendations: () => `<div class="sk-page">${SK.head(true)}${SK.actions([[120],[96],[110]])}${SK.rows(IS_LOW_END ? 5 : 9)}</div>`,
  pagePublicPlaylist: () => `<div class="sk-page">${SK.head(true)}${SK.actions([[120],[96],[44,'c']])}${SK.rows(IS_LOW_END ? 5 : 9)}</div>`,
  pagePlaylistDetail: () => `<div class="sk-page">${SK.head(true)}${SK.actions([[110],[96],[90],[44,'c']])}${SK.rows(IS_LOW_END ? 5 : 9)}</div>`
};
function showSkeleton(){
  const p = currentPath(), q = new URLSearchParams(location.search || '');
  let html;
  if      (p === '/')                            html = SK.pageHome();
  else if (p.startsWith('/track/'))              html = SK.pageTrack();
  else if (p.startsWith('/album/'))              html = SK.pageAlbum();
  else if (p.startsWith('/artist/'))             html = SK.pageArtist();
  else if (p.startsWith('/search'))              html = SK.pageSearch(!!q.get('q'));
  else if (p.startsWith('/p/'))                  html = SK.pagePublicPlaylist();
  else if (p.startsWith('/u/'))                  html = SK.pageProfile();
  else if (p === '/account')                     html = SK.pageAccount();
  else if (p.startsWith('/social'))              html = SK.pageSocial(q.get('tab') || 'feed');
  else if (p.startsWith('/recommendations'))     html = SK.pageRecommendations();
  else if (p === '/library/downloads')           html = SK.pageDownloads();
  else if (p === '/library/stats')               html = SK.pageStats();
  else if (p === '/library/history')             html = SK.pageHistory();
  else if (p === '/library/playlists')           html = SK.pagePlaylists();
  else if (p.startsWith('/library/playlists/'))  html = SK.pagePlaylistDetail();
  else if (p.startsWith('/library'))             html = SK.pageLibrary();
  else                                           html = SK.pageHome();
  MAIN().innerHTML = html;
}

/* ══ CARD BUILDERS ═══════════════════════════════════════════════════════════ */
const cardAlbum = c => {
  const a = getArtwork(c, 300);
  return `<a class="card-item" href="${SCOPE}album/${esc(c.collectionId)}" data-link>${a ? `<img class="card-art" src="${esc(a)}" loading="lazy" decoding="async" alt="">` : `<div class="card-art card-art-ph"><i class="bi bi-disc"></i></div>`}<div class="card-name text-truncate">${esc(c.collectionName||'Album')}</div><div class="card-sub text-truncate">${esc(c.artistName||'')}</div></a>`;
};
const cardTrack = t => {
  const a = getArtwork(t, 300);
  return `<a class="card-item" href="${SCOPE}track/${esc(t.trackId)}" data-link>${a ? `<img class="card-art" src="${esc(a)}" loading="lazy" decoding="async" alt="">` : `<div class="card-art card-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="card-name text-truncate">${esc(t.trackName||'Track')}</div><div class="card-sub text-truncate">${esc(t.artistName||'')}</div></a>`;
};
function cardTrackPopular(t){
  const a = getArtwork(t, 300), sub = [t.artistName].filter(Boolean).join(' · ');
  return `<a class="card-item" href="${SCOPE}track/${esc(t.trackId)}" data-link>${a ? `<img class="card-art" src="${esc(a)}" loading="lazy" decoding="async" alt="">` : `<div class="card-art card-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="card-name text-truncate">${esc(t.trackName||'Track')}</div><div class="card-sub text-truncate">${esc(sub)}</div></a>`;
}
const cardArtist = a => {
  const ar = getArtwork(a, 300);
  return `<a class="artist-item" href="${SCOPE}artist/${esc(a.artistId)}" data-link>${ar ? `<img class="artist-art" src="${esc(ar)}" loading="lazy" decoding="async" alt="">` : `<div class="artist-art artist-art-ph"><i class="bi bi-person-fill"></i></div>`}<div class="card-name text-truncate">${esc(a.artistName||'Artist')}</div></a>`;
};
function trackRow(item, opts={}){
  if(!item) return '';
  const id = String(item.trackId||''), liked = isLiked(id), cached = isCached(id),
        dl = DL.get(id), art = getArtwork(item, 100) || item.artworkUrl || '',
        dur = item.trackTimeMillis ? fmtTime(item.trackTimeMillis/1e3) : item.duration ? fmtTime(item.duration) : '',
        isCur = Player.track && String(Player.track.trackId) === id,
        isPlaying = isCur && Player.playing,
        fa = hasAudio(item), po = !fa && hasPreview(item) && !cached,
        artistName = item.artistName || '', albumName = item.collectionName || item.albumName || '',
        subParts = [];
  if(artistName) subParts.push(artistLink(item, true));
  if(albumName && !opts.hideAlbum) subParts.push(albumLink(item, true));
  if(dur) subParts.push(dur);
  if(opts.extraSub) subParts.push(esc(opts.extraSub));
  const sub = subParts.filter(Boolean).join(' · ');
  let badge = '';
  if(cached) badge = badgeChip('crawled','bi-cloud-check-fill','Offline');
  else if(dl && ['queued','crawling','saving'].includes(dl.status)) badge = `<span class="badge-chip crawling"><span class="spinner-border"></span>${dl.status==='saving'?'Downloading':'Crawling'}</span>`;
  else if(dl && dl.status === 'ready') badge = badgeChip('ready','bi-cloud-download','Ready');
  else if(po) badge = badgeChip('preview','bi-play-circle','Preview');
  const em = opts.playlistId ? `,'${esc(opts.playlistId)}'` : '',
        iconCls = isPlaying ? 'bi-pause-fill' : po ? 'bi-play-circle' : 'bi-play-fill',
        ariaLabel = po ? 'Play preview' : 'Play';
  return `<div class="row-item ${isCur?'playing':''}" data-track-id="${esc(id)}"><button class="row-play ${isPlaying?'playing':''} ${po?'is-preview':''}" data-play-id="${esc(id)}" data-preview="${po?1:0}" onclick="event.preventDefault();event.stopPropagation();playTrackFromList('${esc(id)}')" aria-label="${ariaLabel}" title="${ariaLabel}"><i class="bi ${iconCls}"></i></button><a class="row-info" href="${SCOPE}track/${esc(id)}" data-link>${art ? `<img class="row-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="min-w-0 flex-grow-1"><div class="row-title text-truncate">${esc(item.trackName||'Track')}${badge ? ' '+badge : ''}</div><div class="row-sub text-truncate">${sub}</div></div></a><div class="row-actions"><button class="icon-btn sm ${liked?'liked':''}" data-like="${esc(id)}" onclick="event.preventDefault();event.stopPropagation();toggleLikeById('${esc(id)}')" aria-label="Like"><i class="bi ${liked?'bi-heart-fill':'bi-heart'}"></i></button><button class="icon-btn sm" onclick="event.preventDefault();event.stopPropagation();openTrackMenu('${esc(id)}'${em})" aria-label="More"><i class="bi bi-three-dots-vertical"></i></button></div></div>`;
}

/* ══ AI LISTS — 3-card loading, not one skeleton per list ═══════════════════ */
/* Single loading block shown while the FIRST page of AI lists is being fetched.
   Just THREE skeleton cards total (not one placeholder section per list). */
function _aiLoadingBlockHtml(){
  return `<div id="aiListsLoading" class="ai-list-section">
    <div style="padding:25px 16px 18px">
      <div class="sk" style="height:18px;width:55%;border-radius:6px;margin-bottom:6px"></div>
      <div class="sk" style="height:12px;width:35%;border-radius:4px"></div>
    </div>
    <div class="mm-grid">
      <div class="sk-card"><div class="sk sk-card-art"></div><div class="sk" style="height:13px;width:80%"></div><div class="sk" style="height:11px;width:55%"></div></div>
      <div class="sk-card"><div class="sk sk-card-art"></div><div class="sk" style="height:13px;width:80%"></div><div class="sk" style="height:11px;width:55%"></div></div>
      <div class="sk-card"><div class="sk sk-card-art"></div><div class="sk" style="height:13px;width:80%"></div><div class="sk" style="height:11px;width:55%"></div></div>
    </div>
  </div>`;
}
function _aiErrorBanner(){
  return `<div class="ai-list-section" style="margin-bottom:4px">
    <div style="padding:18px 16px 6px;display:flex;align-items:center;gap:10px">
      <i class="bi bi-exclamation-triangle" style="color:var(--bs-warning);font-size:1.2rem"></i>
      <div class="flex-grow-1 min-w-0">
        <div style="font-weight:800;font-size:.9rem">Couldn't load some playlists</div>
        <div class="text-secondary" style="font-size:.74rem">${_aiLastError ? esc(_aiLastError) : 'Network or server error'}</div>
      </div>
      <button class="pill-btn primary sm" onclick="aiListsRetry()"><i class="bi bi-arrow-repeat"></i> Retry</button>
    </div>
  </div>`;
}
function _aiSetSentinel(state){
  const sent = document.getElementById('aiListsSentinel');
  if(!sent) return;
  if(state === 'loading'){ sent.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>`; return }
  if(state === 'done'){
    const n = document.querySelectorAll('#aiListsGrid > .ai-list-section').length;
    sent.innerHTML = n > 0 ? `<div class="text-center py-4 text-secondary" style="font-size:.72rem">All playlists loaded</div>` : '';
    return;
  }
  if(state === 'retry'){ sent.innerHTML = `<div class="text-center py-4"><button class="pill-btn primary" onclick="aiListsRetry()"><i class="bi bi-arrow-repeat"></i> Retry</button></div>`; return }
  sent.innerHTML = '';
}
window.aiListsRetry = function(){
  _aiPage = Math.max(1, _aiPage - 1);
  _aiHasMore = true; _aiLastError = null;
  const sent = document.getElementById('aiListsSentinel');
  if(sent) sent.innerHTML = '';
  loadMoreAiLists();
};
async function aiListSectionHtml(item){
  let tracks = [];
  try{
    const r = await apiCall('/pl/get/'+encodeURIComponent(item.id)), d = r.data||{};
    if(r.ok && d.ok && Array.isArray(d.tracks)){
      tracks = d.tracks.slice(0, 12).map(normalizePlaylistTrack).filter(Boolean);
      cacheItems(tracks);
    }
  }catch{}
  const total = Number(item.track_count) || tracks.length,
        desc  = item.description || `${total} track${total === 1 ? '' : 's'}`;
  let html = `<div class="ai-list-section" style="margin-bottom:4px">
    <div style="display:flex;align-items:center;gap:10px;padding:25px 16px 18px">
      <div style="flex:1 1 auto;min-width:0">
        <div class="text-truncate" style="font-weight:800;font-size:.95rem;letter-spacing:-.01em">${esc(item.name || 'AI Playlist')}</div>
        <div class="text-truncate text-secondary" style="font-size:.74rem">${esc(desc)}</div>
      </div>
      <a href="${SCOPE}p/${esc(item.id)}" data-link class="pill-btn primary sm" style="flex:0 0 auto">Open <i class="bi bi-arrow-right"></i></a>
    </div>`;
  if(tracks.length) html += `<div class="mm-grid">${tracks.map(cardTrack).join('')}</div>`;
  else html += `<div class="px-3 text-secondary" style="font-size:.78rem;padding:4px 16px 12px">No tracks available</div>`;
  html += `</div>`;
  return html;
}
async function loadMoreAiLists(){
  if(_aiLoading || !_aiHasMore) return;
  const grid = document.getElementById('aiListsGrid');
  if(!grid) return;

  _aiLoading = true;
  _aiLastError = null;

  const isFirstPage = _aiPage === 1;
  const hasRealContent = !!grid.querySelector('.ai-list-section');

  /* First page + no real content yet → show the single 3-card loading block */
  if(isFirstPage && !hasRealContent) grid.innerHTML = _aiLoadingBlockHtml();
  else _aiSetSentinel('loading');

  try{
    const r = await apiCall(`/pl/list?type=ai&page=${_aiPage}&limit=12&includeStale=1&personalized=1`),
          d = r.data || {};
    if(!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
    const items = Array.isArray(d.items) ? d.items : [];

    /* Remove the loading block once the first batch arrives */
    if(isFirstPage){
      const lb = document.getElementById('aiListsLoading');
      if(lb) lb.remove();
    }

    if(items.length){
      /* Insert all section slots at once so order is stable, then fill in parallel */
      const batchId = 'aibatch_' + Date.now() + '_' + _aiPage;
      const slots = items.map((item, idx) => {
        const pid = `${batchId}_${idx}`;
        return { pid, item, slotHtml: `<div class="ai-list-section" id="${pid}" style="min-height:200px"></div>` };
      });
      grid.insertAdjacentHTML('beforeend', slots.map(s => s.slotHtml).join(''));

      slots.forEach(({pid, item}) => {
        _aiPendingSections++;
        aiListSectionHtml(item)
          .then(html => {
            const el = document.getElementById(pid);
            if(el && el.isConnected){
              el.outerHTML = html;
              const fresh = grid.querySelector('.ai-list-section:last-of-type');
              if(fresh) fresh.style.animation = 'mm-page-in .22s ease both';
            }
            reindexActionButtons();
            refreshLikes();
          })
          .catch(() => { const el = document.getElementById(pid); if(el && el.isConnected) el.remove() })
          .finally(() => {
            _aiPendingSections = Math.max(0, _aiPendingSections - 1);
            if(_aiPendingSections === 0) _aiAfterBatch();
          });
      });
    } else if(isFirstPage){
      grid.innerHTML = `<div class="px-3 text-secondary" style="font-size:.82rem;padding:8px 16px 12px">No AI playlists yet</div>`;
    }

    const pg = d.pagination || {};
    _aiHasMore = pg.hasMore !== undefined ? !!pg.hasMore : (items.length > 0);
    _aiPage++;
  }catch(e){
    _aiLastError = e.message || String(e);
    console.warn('[AI Lists]', _aiLastError);
    const lb = document.getElementById('aiListsLoading');
    if(lb) lb.remove();
    if(grid.childElementCount) grid.insertAdjacentHTML('beforeend', _aiErrorBanner());
    _aiHasMore = false;
    _aiSetSentinel('retry');
    return;
  }finally{
    _aiLoading = false;
    if(_aiHasMore) _aiSetSentinel('idle');
    else _aiSetSentinel('done');
  }
}
function _aiAfterBatch(){
  requestAnimationFrame(() => {
    if(_aiLoading || !_aiHasMore) return;
    if(currentPath() !== '/') return;
    const root = document.getElementById('main'), sent = document.getElementById('aiListsSentinel');
    if(!root || !sent) return;
    const rr = root.getBoundingClientRect(), sr = sent.getBoundingClientRect();
    if(sr.top < rr.bottom + 400) loadMoreAiLists();
  });
}
function attachAiListsObserver(){
  if(_aiObserver){ try{ _aiObserver.disconnect() }catch{}; _aiObserver = null }
  const root = document.getElementById('main'), sent = document.getElementById('aiListsSentinel');
  if(!root || !sent) return;
  _aiObserver = new IntersectionObserver(es => {
    for(const en of es){
      if(!en.isIntersecting) continue;
      if(currentPath() !== '/') continue;
      if(_aiLoading || !_aiHasMore) continue;
      if(_aiPendingSections > 0) continue;
      loadMoreAiLists();
    }
  }, {root, rootMargin:'600px 0px', threshold:0});
  _aiObserver.observe(sent);
  if(!_aiScrollBound){
    _aiScrollBound = true;
    let tick = 0;
    root.addEventListener('scroll', () => {
      if(tick) return;
      tick = requestAnimationFrame(() => {
        tick = 0;
        if(currentPath() !== '/') return;
        if(_aiLoading || !_aiHasMore) return;
        if(_aiPendingSections > 0) return;
        const s = document.getElementById('aiListsSentinel'); if(!s) return;
        const rr = root.getBoundingClientRect(), sr = s.getBoundingClientRect();
        if(sr.top < rr.bottom + 800) loadMoreAiLists();
      });
    }, {passive:true});
  }
  requestAnimationFrame(() => {
    if(_aiLoading || !_aiHasMore) return;
    if(currentPath() !== '/') return;
    if(_aiPendingSections > 0) return;
    const rr = root.getBoundingClientRect(), sr = sent.getBoundingClientRect();
    if(sr.top < rr.bottom + 400) loadMoreAiLists();
  });
}

/* ══ RECOMMENDATIONS ═════════════════════════════════════════════════════════ */
let _reco = {offset:0, limit:30, hasMore:true, loading:false, items:[], builtAt:null}, _recoObserver = null;
function disconnectRecoObserver(){ if(_recoObserver){ try{ _recoObserver.disconnect() }catch{}; _recoObserver = null } }
async function loadMoreRecommendations(){
  if(_reco.loading || !_reco.hasMore) return;
  _reco.loading = true;
  const list = document.getElementById('recoList'), sent = document.getElementById('recoSentinel');
  if(sent) sent.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>`;
  try{
    const r = await apiCall(`/recommendations?limit=${_reco.limit}&offset=${_reco.offset}`), d = r.data||{};
    if(!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
    if(!_reco.builtAt && d.builtAt) _reco.builtAt = d.builtAt;
    const items = (d.results||[]).filter(t => itemType(t) === 'track');
    if(!items.length && _reco.offset === 0){
      const reason = (d.profile && d.profile.reason) || '';
      const msg = reason === 'not enough signal' ? 'Listen to more music so we can learn your taste.'
                : reason === 'no candidates' ? 'No matching candidates right now. Try again later.'
                : 'No recommendations available right now.';
      if(list) list.innerHTML = emptyState('stars','No recommendations yet', msg);
      _reco.hasMore = false;
      return;
    }
    cacheItems(items);
    _reco.items = _reco.items.concat(items);
    if(list && items.length) list.insertAdjacentHTML('beforeend', items.map(t => trackRow(t)).join(''));
    _reco.offset += items.length;
    const serverSays = d.hasMore !== undefined ? !!d.hasMore
                     : d.pagination && d.pagination.hasMore !== undefined ? !!d.pagination.hasMore
                     : d.has_more !== undefined ? !!d.has_more : null;
    if(serverSays !== null) _reco.hasMore = serverSays;
    else _reco.hasMore = items.length >= _reco.limit;
    if(items.length === 0) _reco.hasMore = false;
    if(_reco.items.length >= 500) _reco.hasMore = false;
  }catch(e){
    if(sent) sent.innerHTML = `<div class="text-center py-4"><button class="pill-btn" onclick="loadMoreRecommendations()"><i class="bi bi-arrow-repeat"></i> Retry</button></div>`;
    _reco.hasMore = false;
    return;
  }finally{
    _reco.loading = false;
    if(sent){
      if(_reco.hasMore) sent.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-secondary" style="opacity:.4"></div></div>`;
      else if(_reco.items.length) sent.innerHTML = `<div class="text-center py-4 text-secondary" style="font-size:.75rem">All ${_reco.items.length} recommendations loaded</div>`;
    }
    const cnt = document.getElementById('recoCount');
    if(cnt && _reco.items.length) cnt.textContent = `${_reco.items.length} track${_reco.items.length!==1?'s':''}`;
    const pa = document.getElementById('recoPlayAll');
    if(pa && _reco.items.length){ pa.disabled = false; if(_reco.items[0]) pa.dataset.playId = String(_reco.items[0].trackId) }
  }
}
function attachRecoObserver(){
  disconnectRecoObserver();
  const root = document.getElementById('main'), sent = document.getElementById('recoSentinel');
  if(!root || !sent) return;
  _recoObserver = new IntersectionObserver(es => {
    for(const en of es){
      if(!en.isIntersecting) continue;
      if(currentPath() !== '/recommendations') continue;
      if(_reco.loading || !_reco.hasMore) continue;
      loadMoreRecommendations();
    }
  }, {root, rootMargin:'800px 0px', threshold:0});
  _recoObserver.observe(sent);
  if(!root.__recoScrollBound){
    root.__recoScrollBound = true;
    root.addEventListener('scroll', () => {
      if(currentPath() !== '/recommendations') return;
      if(_reco.loading || !_reco.hasMore) return;
      if(root.scrollTop + root.clientHeight >= root.scrollHeight - 600) loadMoreRecommendations();
    }, {passive:true});
  }
  requestAnimationFrame(() => {
    const r = sent.getBoundingClientRect(), rr = root.getBoundingClientRect();
    if(r.top < rr.bottom + 400 && _reco.hasMore && !_reco.loading) loadMoreRecommendations();
  });
}
async function refreshRecommendations(btn){
  if(btn){ btn.disabled = true; const o = btn.innerHTML; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; setTimeout(() => { if(btn){ btn.disabled = false; btn.innerHTML = o } }, 2500) }
  try{ await apiCall('/recommendations/refresh', {method:'POST'}) }catch{}
  _reco = {offset:0, limit:30, hasMore:true, loading:false, items:[], builtAt:null};
  const list = document.getElementById('recoList'); if(list) list.innerHTML = '';
  await loadMoreRecommendations();
}
async function viewRecommendations(){
  _reco = {offset:0, limit:30, hasMore:true, loading:false, items:[], builtAt:null};
  setPageTitle('Recommended');
  if(!MMAuth.user){
    try{ await MMAuth.refresh() }catch{}
    if(!MMAuth.user){ const t0 = Date.now(); while(Date.now()-t0 < 2500 && !MMAuth.user) await new Promise(r => setTimeout(r, 100)) }
  }
  if(!MMAuth.user){
    MAIN().innerHTML = `<div class="pb-4">${backBtn()}<div class="state mm-empty"><i class="bi bi-person-lock"></i><p class="fw-semibold text-body">Sign in required</p><p class="mt-1" style="font-size:.78rem">Recommendations are personalized using your likes and follows.</p><button class="pill-btn primary mt-3" onclick="openAuth()"><i class="bi bi-box-arrow-in-right"></i> Sign in</button></div></div>`;
    return;
  }
  let html = `<div class="pb-4">${backBtn()}<div class="px-3 pt-1"><div style="font-size:1.35rem;font-weight:800;letter-spacing:-.02em"><i class="bi bi-stars" style="color:var(--bs-primary)"></i> Recommended</div><div class="text-secondary" style="font-size:.8rem" id="recoCount">Loading…</div></div>`;
  html += `<div class="lib-tabs"><button class="pill-btn success" id="recoPlayAll" disabled data-play-id="" onclick="playIds(_reco.items.map(t=>t.trackId).join(','))"><i class="bi bi-play-fill"></i> Play all</button><button class="pill-btn" onclick="addAllToQueue(_reco.items)"><i class="bi bi-list-ul"></i> Queue</button><button class="pill-btn primary" onclick="refreshRecommendations(this)"><i class="bi bi-arrow-repeat"></i> Refresh</button></div>`;
  html += `<div id="recoList"></div><div id="recoSentinel"></div></div>`;
  MAIN().innerHTML = html;
  reindexActionButtons();
  await loadMoreRecommendations();
  attachRecoObserver();
}
function sectionHeaderHtml(title, desc, icon, color){
  return `<div style="display:flex;align-items:center;gap:10px;padding:14px 16px 18px"><div style="flex:1 1 auto;min-width:0"><div class="text-truncate" style="font-weight:800;font-size:.95rem;letter-spacing:-.01em">${esc(title)}</div><div class="text-truncate text-secondary" style="font-size:.74rem">${esc(desc)}</div></div></div>`;
}
function recoHomeSkeletonHtml(){
  return `<div class="px-3 pt-4 pb-4"><div class="sk mb-3" style="height:28px;width:40%;border-radius:8px"></div><div class="sk mb-4" style="height:14px;width:60%;border-radius:6px"></div><div class="d-flex gap-3 mb-4 overflow-hidden" style="margin:0 -12px;padding:0 12px">${`<div class="sk-card"><div class="sk sk-card-art"></div><div class="sk" style="height:13px;width:80%"></div><div class="sk" style="height:11px;width:55%"></div></div>`.repeat(4)}</div></div>`;
}
function recoHomeSectionHtml(items){
  return sectionHeaderHtml('Recommended for you','Personalized from your likes & follows','stars','primary')
    + `<div class="mm-grid">${items.slice(0,6).map(cardTrack).join('')}</div>`
    + `<div class="px-3 pt-2 pb-2"><button class="pill-btn primary w-100 justify-content-center" onclick="go('/recommendations')"><i class="bi bi-stars"></i> Show more recommendations</button></div>`;
}
async function refreshHomeRecommendations(){
  const host = document.getElementById('recoHomeSection');
  if(!host || host.dataset.busy === '1') return;
  const hasSignal = getFollowed().length > 0 || getLikes().length > 0;
  if(!MMAuth.user || !hasSignal){
    _recoHomeCache = null; _recoHomeDirty = false;
    host.innerHTML = '';
    if(_homeRendered && _homeCache) _homeCache.html = MAIN().innerHTML;
    return;
  }
  if(_recoHomeCache && _recoHomeCache.items.length){
    host.innerHTML = recoHomeSectionHtml(_recoHomeCache.items);
    reindexActionButtons(); refreshLikes();
  } else if(!_recoHomeCache) host.innerHTML = recoHomeSkeletonHtml();
  host.dataset.busy = '1';
  try{
    const r = await apiCall('/recommendations?limit=12&offset=0');
    if(!host.isConnected) return;
    if(!r.ok || !r.data.success) throw new Error();
    const reason = r.data.profile?.reason;
    if(reason === 'not enough signal'){ _recoHomeCache = {items:[], at:Date.now()}; host.innerHTML = '' }
    else {
      const recs = (r.data.results||[]).filter(t => itemType(t) === 'track');
      cacheItems(recs);
      _recoHomeCache = {items:recs, at:Date.now()};
      host.innerHTML = recs.length ? recoHomeSectionHtml(recs) : '';
      reindexActionButtons(); refreshLikes();
    }
    _recoHomeDirty = false;
    if(_homeRendered && _homeCache){ _homeCache.html = MAIN().innerHTML; _homeCache.at = Date.now() }
  }catch{}
  finally{ host.dataset.busy = '' }
}
window.refreshHomeRecommendations = refreshHomeRecommendations;

async function viewHome(){
  resetAiState();
  if(!MMAuth.user && !MMAuth.__authResolved){
    const t0 = Date.now();
    while(!MMAuth.__authResolved && Date.now()-t0 < 1200) await new Promise(r => setTimeout(r, 50));
  }
  if(_homeRendered && _homeCache && Date.now() - _homeCache.at < 6e5){
    MAIN().innerHTML = _homeCache.html;
    MAIN().scrollTop = _homeCache.top || 0;
    reindexActionButtons();
    attachAiListsObserver();
    const g = document.getElementById('aiListsGrid');
    if(g && g.childElementCount === 0){ resetAiState(); loadMoreAiLists(); }
    if(_recoHomeDirty) refreshHomeRecommendations();
    return;
  }
  const [fr, po] = await Promise.all([apiFresh().catch(()=>[]), apiPopular(40).catch(()=>[])]);
  cacheItems(fr); cacheItems(po);
  const artists = fr.filter(i => itemType(i) === 'artist'),
        albums = fr.filter(i => itemType(i) === 'collection'),
        tracks = fr.filter(i => itemType(i) === 'track'),
        seen = new Set();
  const pop = po.filter(i => itemType(i) === 'track').filter(i => {
    const id = String(i.trackId||''); if(!id || seen.has(id)) return false;
    seen.add(id); return true;
  });
  const recents = getRecentlyPlayed(), h = new Date().getHours(),
        greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  let html = `<div class="pb-4"><div class="px-3 pt-4 pb-1"><div style="font-size:1.5rem;font-weight:800;letter-spacing:-.02em">${greet}</div><div class="text-secondary" style="font-size:.82rem">Welcome back to MusicMan</div></div>`;
  html += `<div id="recoHomeSection"></div>`;
  if(recents.length){
    html += sectionHeaderHtml('Recently Played', `${recents.length} track${recents.length===1?'':'s'}`, 'clock-history', 'info');
    html += `<div class="mm-grid">${recents.slice(0,10).map(r => cardTrack({wrapperType:'track', trackId:r.trackId, trackName:r.trackName, artistName:r.artistName, artistId:r.artistId, collectionName:r.collectionName, collectionId:r.collectionId, attachments:{artworkUrls:r.artworkUrl?[{url:r.artworkUrl}]:[]}})).join('')}</div>`;
  }
  if(pop.length){
    html += sectionHeaderHtml('Popular', `${pop.length} track${pop.length===1?'':'s'}`, 'fire', 'danger');
    html += `<div class="mm-grid">${pop.slice(0,20).map(cardTrackPopular).join('')}</div>`;
  }
  if(tracks.length){
    html += sectionHeaderHtml(recents.length ? 'Fresh Music' : 'Fresh', `${tracks.length} track${tracks.length===1?'':'s'}`, 'stars', 'success');
    html += `<div class="mm-grid">${tracks.map(cardTrack).join('')}</div>`;
  }
  if(artists.length){
    html += sectionHeaderHtml('Fresh Artists', `${artists.length} artist${artists.length===1?'':'s'}`, 'person-fill', 'primary');
    html += `<div class="mm-grid mm-grid-narrow">${artists.map(cardArtist).join('')}</div>`;
  }
  if(albums.length){
    html += sectionHeaderHtml('Fresh Albums', `${albums.length} album${albums.length===1?'':'s'}`, 'disc', 'warning');
    html += `<div class="mm-grid">${albums.map(cardAlbum).join('')}</div>`;
  }
  if(!fr.length && !po.length && !recents.length) html += emptyState('collection','Nothing to show yet','Try searching for something.');
  html += secTitle('Daily Playlists') + `<div id="aiListsGrid"></div><div id="aiListsSentinel"></div></div>`;
  MAIN().innerHTML = html;
  reindexActionButtons();
  attachAiListsObserver();
  if('requestIdleCallback' in window) requestIdleCallback(() => refreshHomeRecommendations(), {timeout:1500});
  else setTimeout(() => refreshHomeRecommendations(), 0);
  _homeCache = {html:MAIN().innerHTML, top:0, at:Date.now()};
  _homeRendered = true;
}
function playSmartShuffle(){
  const s = getStats(), tracks = s.tracks||{}, likes = getLikes(),
        ids = [...new Set([...Object.keys(tracks), ...likes.map(l => String(l.trackId))])],
        shuffled = [...ids].sort(() => Math.random()-.5).slice(0,100);
  if(!shuffled.length){ toast('Nothing to shuffle','warning'); return }
  playIds(shuffled.join(','));
}

/* ══ SEARCH ══════════════════════════════════════════════════════════════════ */
let searchFilter = 'all', searchCache = {term:null, items:null};
function searchBarHtml(t=''){
  return `<div class="search-wrap"><form onsubmit="event.preventDefault();submitSearch()"><div class="search-box"><i class="bi bi-search"></i><input id="searchInput" type="search" placeholder="Songs, albums, artists…" value="${esc(t)}" autocomplete="off" enterkeyhint="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="searchSuggest"><button type="button" class="icon-btn sm mic-btn" id="voiceSearchBtn" onclick="startVoiceSearch(event)" aria-label="Voice search" title="Voice search"><i class="bi bi-mic"></i></button>${t?`<button type="button" class="icon-btn sm" onclick="clearSearch()" aria-label="Clear"><i class="bi bi-x-circle-fill"></i></button>`:''}</div><div class="search-suggest" id="searchSuggest" role="listbox" aria-label="Search suggestions"></div></form>${t?`<div class="filter-row"><button class="chip ${searchFilter==='all'?'on':''}" onclick="setSearchFilter('all')">All</button><button class="chip ${searchFilter==='artist'?'on':''}" onclick="setSearchFilter('artist')">Artists</button><button class="chip ${searchFilter==='album'?'on':''}" onclick="setSearchFilter('album')">Albums</button><button class="chip ${searchFilter==='track'?'on':''}" onclick="setSearchFilter('track')">Songs</button></div>`:''}</div>`;
}
let _voiceRec = null;
window.startVoiceSearch = function(ev){
  if(ev){ ev.preventDefault(); ev.stopPropagation() }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ toast('Voice search not supported on this device','warning'); return }
  if(_voiceRec){ try{ _voiceRec.abort() }catch{}; _voiceRec = null; return }
  const rec = new SR(), s = getSettings();
  rec.lang = s.translationLang === 'fa' ? 'fa-IR' : 'en-US';
  rec.interimResults = false; rec.continuous = false; rec.maxAlternatives = 1;
  _voiceRec = rec;
  const btn = document.getElementById('voiceSearchBtn');
  if(btn){ btn.classList.add('recording'); btn.innerHTML = '<i class="bi bi-mic-fill"></i>' }
  try{ haptic(12) }catch{}
  const cleanup = () => { if(btn){ btn.classList.remove('recording'); btn.innerHTML = '<i class="bi bi-mic"></i>' } _voiceRec = null };
  rec.onresult = e => {
    const t = (e.results?.[0]?.[0]?.transcript || '').trim();
    if(!t) return;
    const inp = document.getElementById('searchInput'); if(inp) inp.value = t;
    const l = ls.get(KEY.recent,[]).filter(x => x !== t); l.unshift(t); ls.set(KEY.recent, l.slice(0,12));
    searchFilter = 'all';
    go('/search?q='+encodeURIComponent(t));
  };
  rec.onerror = e => {
    if(e.error === 'no-speech') toast('No speech detected','warning');
    else if(e.error === 'not-allowed') toast('Microphone permission denied','danger');
    else if(e.error === 'aborted'){}
    else if(e.error === 'network') toast('Voice network error','danger');
    else toast('Voice error: '+e.error,'danger');
    cleanup();
  };
  rec.onend = cleanup;
  try{ rec.start(); toast('Listening…','info') }catch{ cleanup(); toast('Could not start voice search','danger') }
};
function wireSearchSuggest(f){
  requestAnimationFrame(() => {
    const i = document.getElementById('searchInput'), d = document.getElementById('searchSuggest');
    if(i && d) initSuggest(i, d);
    if(f && i && document.activeElement === document.body) i.focus();
  });
}
function setSearchFilter(f){
  searchFilter = f;
  if(searchCache.term && searchCache.items){ renderSearchResults(searchCache.term, searchCache.items); reindexActionButtons(); refreshLikes() }
  else { const {q} = parseRoute(); viewSearch(q.get('q')||'') }
}
function submitSearch(){
  const q = ($('#searchInput')?.value||'').trim();
  if(!q) return;
  const l = ls.get(KEY.recent,[]).filter(x => x !== q); l.unshift(q); ls.set(KEY.recent, l.slice(0,12));
  searchFilter = 'all';
  go('/search?q='+encodeURIComponent(q));
}
function clearSearch(){ const i = $('#searchInput'); if(i){ i.value = ''; i.focus() } }
function clearRecent(){ ls.remove(KEY.recent); viewSearch('') }
function removeRecent(term){ const l = ls.get(KEY.recent,[]).filter(x => x !== term); ls.set(KEY.recent, l); viewSearch('') }
async function viewSearch(term){
  if(!term){
    const r = ls.get(KEY.recent,[]);
    let html = `<div class="pb-4">${searchBarHtml('')}`;
    if(r.length){
      html += `<div class="d-flex align-items-center px-3 pt-4 pb-2"><div class="sec-title p-0 flex-grow-1">Recent searches</div><button class="icon-btn sm" onclick="clearRecent()" aria-label="Clear"><i class="bi bi-trash3"></i></button></div><div class="px-3 pb-2">` + r.map(x => `<div class="d-inline-flex align-items-center gap-2 me-2 mb-2" style="background:var(--mm-surface-2);border-radius:999px;padding:4px 6px 4px 14px;font-size:.82rem"><i class="bi bi-clock-history" style="opacity:.6"></i><span style="cursor:pointer" onclick="go('/search?q=${encodeURIComponent(x)}')">${esc(x)}</span><button class="icon-btn sm" onclick="event.stopPropagation();removeRecent(${JSON.stringify(x).replace(/"/g,'&quot;')})" style="width:24px;height:24px;font-size:.75rem"><i class="bi bi-x-lg"></i></button></div>`).join('') + `</div>`;
    } else html += emptyState('search','Find your music','Search for songs, albums and artists.');
    html += `</div>`;
    MAIN().innerHTML = html;
    wireSearchSuggest(true);
    return;
  }
  let items;
  if(searchCache.term === term && searchCache.items) items = searchCache.items;
  else { items = await apiSearch(term); searchCache = {term, items}; cacheItems(items) }
  renderSearchResults(term, items);
}
function renderSearchResults(term, items){
  const artists = items.filter(i => itemType(i) === 'artist'),
        albums = items.filter(i => itemType(i) === 'collection'),
        tracks = items.filter(i => itemType(i) === 'track'),
        sT = searchFilter === 'all' || searchFilter === 'track',
        sA = searchFilter === 'all' || searchFilter === 'album',
        sAr = searchFilter === 'all' || searchFilter === 'artist';
  let html = `<div class="pb-4">${searchBarHtml(term)}`;
  if(!items.length) html += emptyState('emoji-frown',`No results for "${term}"`,'Try different keywords.');
  else {
    let has = false;
    if(sAr && artists.length){ has = true; html += secTitle(`Artists · ${artists.length}`) + `<div class="mm-grid mm-grid-narrow">${artists.map(cardArtist).join('')}</div>` }
    if(sA && albums.length){ has = true; html += secTitle(`Albums · ${albums.length}`) + `<div class="mm-grid">${albums.map(cardAlbum).join('')}</div>` }
    if(sT && tracks.length){ has = true; html += secTitle(`Songs · ${tracks.length}`) + tracks.map(t => trackRow(t)).join('') }
    if(!has) html += emptyState('funnel','No matches for this filter');
  }
  html += `</div>`;
  MAIN().innerHTML = html;
  reindexActionButtons();
  wireSearchSuggest(false);
}

/* ══ ARTIST TRACKS PAGINATION ════════════════════════════════════════════════ */
const _at = {artistId:null, sort:'album', page:0, limit:50, total:0, pages:0, hasMore:false, loading:false, items:[]};
let _ato = null;
function disconnectArtistTracksObserver(){ if(_ato){ _ato.disconnect(); _ato = null } }
async function loadArtistTracks(aid, {reset=false, sort=null}={}){
  if(!aid) return;
  const st = _at;
  if(reset || st.artistId !== String(aid)){ st.artistId = String(aid); st.page = 0; st.items = []; st.total = 0; st.pages = 0; st.hasMore = false }
  if(sort) st.sort = sort;
  if(st.loading || (st.page > 0 && !st.hasMore)) return;
  st.loading = true;
  const np = st.page+1, sent = document.getElementById('artistTracksSentinel'), list = document.getElementById('artistTracksList');
  if(sent) sent.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>`;
  try{
    const res = await apiArtistTracks(aid, {page:np, limit:st.limit, sort:st.sort}),
          tracks = (res.results||[]).filter(t => itemType(t) === 'track');
    st.page = np; st.total = res.total ?? tracks.length; st.pages = res.pages ?? 1;
    st.hasMore = !!res.hasMore;
    st.items = st.items.concat(tracks);
    cacheItems(tracks);
    _pageTracks = st.items;
    if(list && tracks.length) list.insertAdjacentHTML('beforeend', tracks.map(t => trackRow(t)).join(''));
    reindexActionButtons();
    const ce = document.getElementById('artistTrackCount');
    if(ce) ce.textContent = `${st.items.length} of ${st.total}`;
    const pb = document.getElementById('artistPlayAllBtn');
    if(pb){ pb.disabled = st.items.length === 0; if(st.items[0]) pb.dataset.playId = String(st.items[0].trackId) }
    const lb = document.getElementById('artistLikeAllBtn');
    if(lb){
      const al = st.items.length > 0 && st.items.every(t => isLiked(t.trackId));
      lb.classList.toggle('liked', al);
      const i = lb.querySelector('i'); if(i) i.className = `bi ${al ? 'bi-heart-fill' : 'bi-heart'}`;
    }
    refreshLikes();
  }catch(e){
    if(sent) sent.innerHTML = `<div class="text-center py-4"><button class="pill-btn" onclick="loadArtistTracks('${esc(aid)}')"><i class="bi bi-arrow-repeat"></i> Retry</button></div>`;
  }
  finally{
    st.loading = false;
    if(sent && st.hasMore) sent.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-secondary" style="opacity:.4"></div></div>`;
    else if(sent && !st.hasMore) sent.innerHTML = st.items.length ? `<div class="text-center py-4 text-secondary" style="font-size:.75rem">All ${st.total} track${st.total!==1?'s':''} loaded</div>` : '';
    requestAnimationFrame(() => {
      if(!st.hasMore || st.loading) return;
      const s = document.getElementById('artistTracksSentinel'), m = document.getElementById('main');
      if(!s || !m) return;
      const r = s.getBoundingClientRect(), rr = m.getBoundingClientRect();
      if(r.top < rr.bottom + 300) loadArtistTracks(aid);
    });
  }
}
function attachArtistTracksObserver(){
  disconnectArtistTracksObserver();
  const root = document.getElementById('main'), sent = document.getElementById('artistTracksSentinel');
  if(!root || !sent) return;
  _ato = new IntersectionObserver(e => {
    for(const x of e){
      if(!x.isIntersecting) continue;
      if(_at.loading || !_at.hasMore) continue;
      loadArtistTracks(_at.artistId);
    }
  }, {root, rootMargin:'500px 0px', threshold:.01});
  _ato.observe(sent);
}
function setArtistSort(sort){
  if(_at.sort === sort) return;
  const l = document.getElementById('artistTracksList'); if(l) l.innerHTML = '';
  _at.items = []; _at.page = 0; _at.hasMore = true; _at.sort = sort;
  $$('#artistSort .chip').forEach(b => b.classList.toggle('on', b.dataset.sort === sort));
  loadArtistTracks(_at.artistId, {reset:true, sort});
}

/* ══ WIKIDATA ════════════════════════════════════════════════════════════════ */
const _wikiCache = new Map(), _WIKI_TTL = 6*3600*1000, _WIKI_MAX = 150, _wikiInflight = new Map();
async function fetchArtistWikidata(id){
  if(!id) return null;
  const key = String(id);
  const c = _wikiCache.get(key);
  if(c && c.exp > Date.now()) return c.data;
  if(_wikiInflight.has(key)) return _wikiInflight.get(key);
  if(Net.saveData) return null;
  const p = (async () => {
    try{
      const r = await apiCall('/artist/wikidata?id='+encodeURIComponent(id));
      if(!r.ok || !r.data || !r.data.success) return null;
      const f = r.data.facts || null;
      if(!f){ _wikiCache.set(key, {data:null, exp:Date.now()+_WIKI_TTL}); return null }
      const useful = [f.description, f.birth_date, f.death_date, f.inception, f.birth_place,
        (f.citizenship||[]).length, (f.occupations||[]).length, (f.genres||[]).length,
        (f.record_labels||[]).length, (f.members||[]).length, (f.notable_works||[]).length].filter(Boolean).length;
      const res = useful >= 1 ? f : null;
      if(_wikiCache.size >= _WIKI_MAX) _wikiCache.delete(_wikiCache.keys().next().value);
      _wikiCache.set(key, {data:res, exp:Date.now()+_WIKI_TTL});
      return res;
    }catch{ return null }
  })().finally(() => _wikiInflight.delete(key));
  _wikiInflight.set(key, p);
  return p;
}
function renderArtistKnowledgePanel(f){
  if(!f) return '';
  const rows = [];
  const pt = (l,v) => { if(v == null) return; const s = String(v).trim(); if(!s) return; rows.push(`<div class="kg-row"><span class="kg-k">${esc(l)}</span><span class="kg-v">${esc(s)}</span></div>`) };
  const pp = (l,arr) => { if(!Array.isArray(arr) || !arr.length) return; const c = arr.map(x => String(x||'').trim()).filter(Boolean); if(!c.length) return; const p = c.map(x => `<span class="kg-pill">${esc(x)}</span>`).join(''); rows.push(`<div class="kg-row"><span class="kg-k">${esc(l)}</span><span class="kg-v kg-pills">${p}</span></div>`) };
  const pl = (l,url) => { if(!url) return; rows.push(`<div class="kg-row"><span class="kg-k">${esc(l)}</span><span class="kg-v"><a href="${esc(url)}" rel="noopener" class="mm-link">${esc(url)}</a></span></div>`) };
  pt('Name', f.name); pt('Wikidata ID', f.qid); pt('Description', f.description);
  pt('Born', f.birth_date); pt('Died', f.death_date); pt('Birthplace', f.birth_place);
  pt('Formed', f.inception); pt('Dissolved', f.dissolved); pt('Formation place', f.formation_place);
  pp('Country of origin', f.country_of_origin); pp('Citizenship', f.citizenship); pp('Occupations', f.occupations);
  pp('Genres', f.genres); pp('Labels', f.record_labels); pp('Members', f.members); pp('Founded by', f.founded_by);
  pp('Notable works', f.notable_works); pp('Influenced by', f.influenced_by);
  pt('KG MID', f.gkg_mid); pl('KG URL', f.gkg_url); pp('KG Types', f.gkg_types); pt('KG Score', f.gkg_score);
  pl('Wikidata', f.wikidata_url); pl('Source', f.source_url);
  let ib = '';
  if(f.image) ib = `<div class="kg-image"><img src="${esc(f.image)}" loading="lazy" decoding="async" alt=""></div>`;
  if(!rows.length && !ib) return '';
  return `<section class="artist-kg">${ib}${rows.length ? `<div class="artist-kg-body">${rows.join('')}</div>` : ''}</section>`;
}
window.toggleArtistBio = function(btn){
  const p = document.getElementById('artistBio')?.querySelector('.artist-about-p'); if(!p) return;
  const s = p.dataset.short || '', f = p.dataset.full || '', e = p.dataset.expanded === '1';
  if(e){ p.textContent = s; p.dataset.expanded = '0'; btn.textContent = 'Read more' }
  else { p.textContent = f; p.dataset.expanded = '1'; btn.textContent = 'Show less' }
};

/* ══ ARTIST VIEW ═════════════════════════════════════════════════════════════ */
async function viewArtist(id){
  if(!id){ MAIN().innerHTML = emptyState('person','Artist not found'); return }
  _at.artistId = String(id); _at.sort = 'album'; _at.page = 0; _at.items = []; _at.hasMore = true; _at.loading = false;
  let a = getCached('artist', id), artistDescription = '', artistBlogPosts = [], wikidataFacts = null;
  const [lookupRes, wikiRes, albumRes, topRes] = await Promise.all([
    apiLookupFull(id, 'musicArtist').catch(()=>null),
    fetchArtistWikidata(id),
    apiLookup(id, 'album').catch(()=>[]),
    apiArtistTracks(id, {page:1, limit:10, sort:'views'}).catch(()=>null)
  ]);
  try{
    const arr = Array.isArray(lookupRes?.results) ? lookupRes.results : [],
          fresh = arr.find(x => itemType(x) === 'artist') || arr[0];
    if(fresh){
      if(!a) a = fresh;
      cacheItems([fresh]);
      backfillArtistArtwork(id, getArtwork(fresh, 300)||'');
      const fd = String(fresh.description||'').trim();
      if(fd) artistDescription = fd;
      if(Array.isArray(fresh.blogPosts) && fresh.blogPosts.length) artistBlogPosts = fresh.blogPosts;
    }
    if(!artistDescription && typeof lookupRes?.description === 'string') artistDescription = lookupRes.description.trim();
    if(!artistBlogPosts.length && Array.isArray(lookupRes?.blogPosts)) artistBlogPosts = lookupRes.blogPosts;
  }catch{}
  if(!artistDescription && a?.description) artistDescription = String(a.description).trim();
  if(!artistBlogPosts.length && Array.isArray(a?.blogPosts)) artistBlogPosts = a.blogPosts;
  if(!artistDescription && wikidataFacts?.description) artistDescription = String(wikidataFacts.description);
  wikidataFacts = wikiRes;
  if(!a){ MAIN().innerHTML = emptyState('person','Artist not found'); return }
  setPageTitle(a.artistName || 'Artist');
  const am = new Map();
  for(const x of (albumRes||[]).filter(x => itemType(x) === 'collection')){
    const cid = String(x.collectionId||'');
    if(cid && !am.has(cid)) am.set(cid, x);
  }
  const albums = [...am.values()]; cacheItems(albums);
  const topTracks = (topRes?.results||[]).filter(t => itemType(t) === 'track').slice(0,10); cacheItems(topTracks);
  let art = getArtwork(a, 640) || '';
  if(!art) for(const x of albums){ const ar = getArtwork(x, 640); if(ar){ art = ar; break } }
  const fl = isFollowed(id), genre = a.primaryGenreName||'', fcount = Number(a.followers)||0, sp = [];
  if(genre) sp.push(`<span>${esc(genre)}</span>`);
  if(albums.length) sp.push(`<span>${albums.length} album${albums.length!==1?'s':''}</span>`);
  sp.push(`<span id="artistFollowersCount" data-followers-for="${esc(id)}" data-followers="${fcount}">${fcount>0?fmtCompact(fcount)+' followers':''}</span>`);
  sp.push(`<span id="artistTrackCount">0 of —</span>`);
  let html = `<div class="pb-4">${backBtn()}<div class="hero">${art ? `<img class="hero-art round" src="${esc(art)}" loading="eager" fetchpriority="high" decoding="async" alt="">` : `<div class="hero-art hero-art-ph round"><i class="bi bi-person-fill"></i></div>`}<div class="hero-title">${esc(a.artistName||'Artist')}</div><div class="hero-sub hero-meta">${sp.join('')}</div></div>`;
  html += `<div class="lib-tabs"><button class="pill-btn success" id="artistPlayAllBtn" disabled data-play-id="" onclick="playIds(_pageTracks.map(t=>t.trackId).join(','))"><i class="bi bi-play-fill"></i> Play</button><button class="pill-btn follow-btn ${fl?'':'primary'}" data-follow="${esc(id)}" data-followers="${Number(a.followers)||0}" onclick="toggleFollow('${esc(id)}','${esc(art)}')"><i class="bi ${fl?'bi-check-lg':'bi-plus-lg'}"></i><span class="follow-label">${fl?'Following':'Follow'}</span>${Number(a.followers)>0?`<span class="follow-count">${fmtCompact(a.followers)}</span>`:''}</button><button class="pill-btn" onclick="artistRadio('${esc(id)}')"><i class="bi bi-broadcast"></i> Radio</button><button class="pill-btn info" onclick="crawlAll('artist','${esc(id)}',this,false)"><i class="bi bi-cloud-arrow-down"></i> Crawl</button><a class="pill-btn telegram" href="${tgLink('artist',id)}" rel="noopener"><i class="bi bi-telegram"></i></a><button class="icon-btn" style="background:rgba(var(--bs-body-color-rgb),.09)" onclick="artistMore('${esc(id)}')"><i class="bi bi-three-dots"></i></button></div>`;
  let aboutText = '';
  if(wikidataFacts && wikidataFacts.long_description && String(wikidataFacts.long_description).trim()) aboutText = String(wikidataFacts.long_description).trim();
  else if(wikidataFacts && wikidataFacts.description && String(wikidataFacts.description).trim()) aboutText = String(wikidataFacts.description).trim();
  else if(artistDescription && String(artistDescription).trim()) aboutText = String(artistDescription).trim();
  if(aboutText){
    const long = aboutText.length > 320,
          short = long ? aboutText.slice(0,320).replace(/\s+\S*$/,'')+'…' : aboutText;
    html += `<section class="artist-about"><h6 class="artist-about-title">About</h6><div class="artist-about-body" id="artistBio"><p class="artist-about-p" data-short="${esc(short)}" data-full="${esc(aboutText)}">${esc(short)}</p>${long?`<button class="artist-about-more" onclick="toggleArtistBio(this)">Read more</button>`:''}</div></section>`;
  }
  if(wikidataFacts) html += renderArtistKnowledgePanel(wikidataFacts);
  if(topTracks.length){
    _pageTracks = topTracks;
    html += `<section class="artist-section"><div class="d-flex align-items-center px-3 pb-2"><div class="flex-grow-1 fw-bold">Popular</div><button class="pill-btn primary" onclick="playIds(_pageTracks.map(t=>t.trackId).join(','))">Play all</button></div>${topTracks.map(t => trackRow(t)).join('')}</section>`;
  }
  if(albums.length) html += `<section class="artist-section"><div class="artist-section-head"><h6 class="artist-section-title">Discography</h6><span class="artist-section-count">${albums.length} album${albums.length!==1?'s':''}</span></div><div class="mm-grid">${albums.map(cardAlbum).join('')}</div></section>`;
  if(artistBlogPosts.length) html += `<section class="artist-section"><div class="artist-section-head"><h6 class="artist-section-title">Related articles</h6></div><div class="artist-articles">${artistBlogPosts.slice(0,6).map(p => `<a class="artist-article" href="${SCOPE}blog/${esc(p.slug||'')}" data-link>${p.coverImage?`<img class="artist-article-img" src="${esc(p.coverImage)}" loading="lazy" decoding="async" alt="">`:`<div class="artist-article-img artist-article-img-ph"><i class="bi bi-journal-text"></i></div>`}<div class="artist-article-body"><div class="artist-article-title">${esc(p.title||'Article')}</div>${p.excerpt?`<div class="artist-article-sub">${esc(String(p.excerpt).slice(0,140))}</div>`:''}</div></a>`).join('')}</div></section>`;
  html += `<section class="artist-section"><div class="artist-section-head"><h6 class="artist-section-title">All songs</h6></div><div class="artist-sort-row lib-tabs" id="artistSort"><button class="chip on" data-sort="album" onclick="setArtistSort('album')"><i class="bi bi-disc"></i> Album</button><button class="chip" data-sort="name" onclick="setArtistSort('name')"><i class="bi bi-sort-alpha-down"></i> A–Z</button><button class="chip" data-sort="views" onclick="setArtistSort('views')"><i class="bi bi-fire"></i> Popular</button></div><div id="artistTracksList"></div><div id="artistTracksSentinel"></div></section></div>`;
  MAIN().innerHTML = html;
  reindexActionButtons();
  await loadArtistTracks(id, {reset:true, sort:'album'});
  attachArtistTracksObserver();
  apiCall(`/follow/count?id=${encodeURIComponent(id)}`).then(r => {
    if(r?.ok && r.data?.ok && typeof r.data.followers === 'number') setFollowerCount(id, r.data.followers);
  }).catch(()=>{});
}
async function artistRadio(aid){
  const res = await apiArtistTracks(aid, {page:1, limit:60, sort:'views'}).catch(()=>null);
  if(!res || !res.results?.length){ toast('Nothing to play','warning'); return }
  const items = res.results.filter(t => itemType(t) === 'track');
  if(!items.length){ toast('Nothing to play','warning'); return }
  for(let i=items.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [items[i],items[j]] = [items[j],items[i]] }
  cacheItems(items);
  Player.queue = items; Player.index = 0; _extendState.added = 0; Player.shuffle = true;
  renderFpTabBody(); updateRightPanel();
  playItem(items[0], 'Artist Radio');
  toast(`Artist radio · ${items.length} tracks · shuffled`);
}
async function trackRadio(id){
  id = String(id||''); if(!id) return;
  let seed = getCached('track', id);
  if(!seed){
    try{
      const r = await apiLookup(id, 'song');
      seed = r.find(x => itemType(x) === 'track') || r[0];
      if(seed) cacheItems([seed]);
    }catch{}
  }
  if(!seed){ toast('Track not found','danger'); return }
  let related = [];
  try{
    const r = await apiCall(`/track/related?id=${encodeURIComponent(id)}&count=30`), d = r.data||{};
    if(r.ok && d.success && Array.isArray(d.results)) related = d.results.filter(t => itemType(t) === 'track' && String(t.trackId) !== id);
  }catch{}
  cacheItems(related);
  Player.queue = [seed, ...related]; Player.index = 0; _extendState.added = 0; Player.shuffle = false;
  renderFpTabBody(); updateRightPanel();
  playItem(seed, 'Track Radio');
  toast(related.length ? `Track radio · ${related.length} related` : 'Track radio · no related found','info');
}
window.trackRadio = trackRadio;
function artistMore(id){
  const r = [
    `<button class="sheet-item" onclick="closeAllSheets(); addAllToQueue(_pageTracks)"><i class="bi bi-list-ul"></i><span>Queue all tracks</span></button>`,
    `<button class="sheet-item" onclick="closeAllSheets(); openPlaylistPickerForItems(_pageTracks)"><i class="bi bi-plus-lg"></i><span>Add all to playlist</span></button>`,
    `<button class="sheet-item" onclick="closeAllSheets(); toggleLikeAll(_pageTracks)"><i class="bi bi-heart"></i><span>Like / unlike all</span></button>`,
    `<button class="sheet-item telegram" onclick="closeAllSheets(); tgStart('artist','${esc(id)}')"><i class="bi bi-telegram"></i><span>Open in Telegram bot</span></button>`
  ];
  $('#sheetTrackBody').innerHTML = `<div class="px-3 pb-2 pt-1"><div class="fw-bold">Artist actions</div></div><div class="px-2">${r.join('')}</div>`;
  sheet('#sheetTrack').show();
}

/* ══ ALBUM VIEW ══════════════════════════════════════════════════════════════ */
async function viewAlbum(id){
  if(!id){ MAIN().innerHTML = emptyState('disc','Album not found'); return }
  let a = getCached('collection', id);
  if(!a){
    try{ const r = await apiLookup(id, 'album'); a = r.find(x => itemType(x) === 'collection') || r[0]; if(a) cacheItems([a]) }catch{}
  }
  if(!a){ MAIN().innerHTML = emptyState('disc','Album not found'); return }
  setPageTitle(`${a.collectionName||'Album'}${a.artistName?' — '+a.artistName:''}`);
  const tracks = (await apiLookup(id, 'song')).filter(x => itemType(x) === 'track');
  cacheItems(tracks);
  const art = getArtwork(a, 600), needCount = tracks.filter(t => !isCached(t.trackId)).length,
        missing = tracks.filter(t => !hasAudio(t) && !isCached(t.trackId)).length,
        ids = tracks.map(t => String(t.trackId)).join(','),
        year = a.releaseDate ? new Date(a.releaseDate).getFullYear() : '';
  _pageTracks = tracks;
  const batchId = `batch_collection_${id}`, batch = DL.get(batchId);
  let batchBtn = '';
  if(batch && ['queued','crawling'].includes(batch.status)) batchBtn = `<button class="pill-btn info" onclick="go('/library/downloads')"><span class="spinner-border spinner-border-sm me-1" style="width:14px;height:14px;border-width:2px"></span>Crawling · ${batch.readyCount||0}/${batch.trackCount||0}</button>`;
  else if(batch && batch.status === 'saving') batchBtn = `<button class="pill-btn info" onclick="go('/library/downloads')"><span class="spinner-border spinner-border-sm me-1" style="width:14px;height:14px;border-width:2px"></span>Downloading · ${batch.percent||0}%</button>`;
  else if(batch && batch.status === 'ready') batchBtn = `<button class="pill-btn warn" onclick="saveBatch('${esc(batchId)}')"><i class="bi bi-download"></i> Save all · ${batch.readyCount||0}/${batch.trackCount||0}</button>`;
  else if(batch && batch.status === 'failed') batchBtn = `<button class="pill-btn danger" onclick="go('/library/downloads')"><i class="bi bi-exclamation-triangle"></i> View · ${batch.failedCount||0} failed</button>`;
  const firstId = tracks[0] ? String(tracks[0].trackId) : '';
  let html = `<div class="pb-4">${backBtn()}<div class="hero">${art ? `<img class="hero-art" src="${esc(art)}" loading="eager" fetchpriority="high" decoding="async" alt="">` : `<div class="hero-art hero-art-ph"><i class="bi bi-disc"></i></div>`}<div class="hero-title">${esc(a.collectionName||'Album')}</div><div class="hero-sub">${artistLink(a)}${year?` · ${year}`:''}${a.trackCount?` · ${a.trackCount} tracks`:''}</div></div>`;
  html += `<div class="lib-tabs">${tracks.length?`<button class="pill-btn success" data-play-id="${esc(firstId)}" onclick="playIds('${esc(ids)}')"><i class="bi bi-play-fill"></i> Play</button>`:''}${batchBtn}`;
  if(tracks.length && !batch){
    html += `<button class="pill-btn primary" onclick="albumDownloadAll('${esc(id)}',this)"><i class="bi bi-download"></i> Download all${needCount?' ('+needCount+')':''}</button>`;
    html += `<button class="pill-btn info" onclick="crawlAll('collection','${esc(id)}',this,false)"${missing?'':' disabled style="opacity:.55"'}'>${missing?'<i class="bi bi-cloud-arrow-down"></i> Crawl all ('+missing+')':'<i class="bi bi-check-circle-fill"></i> All crawled'}</button>`;
  }
  else if(tracks.length && needCount === 0 && !batch) html += `<span class="pill-btn" style="background:rgba(var(--bs-success-rgb),.16);color:var(--bs-success)"><i class="bi bi-check-circle-fill"></i> All ready</span>`;
  html += `<a class="pill-btn telegram" href="${tgLink('album',id)}" rel="noopener"><i class="bi bi-telegram"></i></a>`;
  if(tracks.length) html += `<button class="icon-btn" style="background:rgba(var(--bs-body-color-rgb),.09)" onclick="albumMore()"><i class="bi bi-three-dots"></i></button>`;
  html += `</div>`;
  html += tracks.length ? tracks.map(t => trackRow(t)).join('') : emptyState('music-note','No tracks found');
  html += `<div id="trackArtistSection"></div></div>`;
  MAIN().innerHTML = html;
  reindexActionButtons();
  loadTrackArtistSection(a);
}
async function albumDownloadAll(id, btn){
  Notify.request();
  const orig = btn?.innerHTML;
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" style="width:14px;height:14px;border-width:2px"></span>Fetching…' }
  try{
    let album = getCached('collection', id);
    if(!album){ const r = await apiLookup(id, 'album'); album = r.find(x => itemType(x) === 'collection') || r[0]; if(album) cacheItems([album]) }
    const tracks = (await apiLookup(id, 'song')).filter(x => itemType(x) === 'track');
    cacheItems(tracks);
    const need = tracks.filter(t => !isCached(t.trackId));
    if(!need.length){ toast('All tracks already saved','success'); return }
    const available = need.filter(t => hasAudio(t)), unavailable = need.filter(t => !hasAudio(t));
    for(const t of available) DL.add(t).catch(()=>{});
    if(unavailable.length){
      await DL.addBatch({subType:'collection', sourceId:String(id), name:album?.collectionName||'Album', artist:album?.artistName||'', artwork:getArtwork(album, 100), tracks:unavailable, forceSave:true});
      try{ await apiQueueAdd({albumId:cleanId(id)}) }catch{}
    }
    const parts = [];
    if(available.length) parts.push(`downloading ${available.length}`);
    if(unavailable.length) parts.push(`crawling ${unavailable.length}`);
    toast(parts.join(' · ')+'…');
    Notify.show('Album download started', album?.collectionName||'Album', {category:'download'});
    haptic(12);
    if(currentPath() === `/album/${id}`) refreshPage();
  }catch(e){ toast('Download failed: '+(e.message||e),'danger') }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = orig } }
}
function albumMore(){
  const r = [
    `<button class="sheet-item" onclick="closeAllSheets(); addAllToQueue(_pageTracks)"><i class="bi bi-list-ul"></i><span>Queue all tracks</span></button>`,
    `<button class="sheet-item" onclick="closeAllSheets(); openPlaylistPickerForItems(_pageTracks)"><i class="bi bi-plus-lg"></i><span>Add all to playlist</span></button>`,
    `<button class="sheet-item" onclick="closeAllSheets(); toggleLikeAll(_pageTracks)"><i class="bi bi-heart"></i><span>Like / unlike all</span></button>`
  ];
  $('#sheetTrackBody').innerHTML = `<div class="px-3 pb-2 pt-1"><div class="fw-bold">Album actions</div></div><div class="px-2">${r.join('')}</div>`;
  sheet('#sheetTrack').show();
}

/* ══ TRACK VIEW + RELATED ════════════════════════════════════════════════════ */
let trackPoller = null, lyricsTrackId = null;
function stopTrackPoller(){ if(trackPoller){ clearInterval(trackPoller); trackPoller = null } }
async function viewTrack(id){
  if(!id){ MAIN().innerHTML = emptyState('music-note','Track not found'); return }
  stopTrackPoller();
  lyricsTrackId = String(id);

  let t = null;
  if(isCached(id)){
    const e = await cacheGet(id);
    if(e && e.meta) t = { wrapperType:'track', trackId:id, ...e.meta };
  }
  if(!t){
    try{
      const r = await apiLookup(id, 'song');
      t = r.find(x => itemType(x) === 'track') || r[0];
      if(t) cacheItems([t]);
    }catch{}
  }
  if(!t) t = getCached('track', id);
  if(!t){ MAIN().innerHTML = emptyState('music-note','Track not found'); return }

  setPageTitle(`${t.trackName||'Track'}${t.artistName?' — '+t.artistName:''}`);

  const dl       = DL.get(id);
  const crawling = dl && ['queued','crawling','saving'].includes(dl.status);

  /* اگر crawler در جریان است یا آهنگ صوتی ندارد، /download/status
     را بگیر و اگر پاسخ کامل بود، t را با آن عوض کن. */
  let st = null;
  if(crawling || !hasAudio(t) || !isCached(id)){
    try{ st = await apiCrawlStatus(id) }catch{}
    if(st && hasAudio(st)){
      t = { wrapperType:'track', trackId:id, ...st };
      cacheItems([t]);
      _ftCache.set(id, {t, exp:Date.now()+_FT_TTL});
      _ftCachePrune();
    }
  }

  renderTrackPage(t);

  if(st && (st.download_status === 'failed' || st.download_status === 'stopped')){
    renderCrawlCard(t, st);
  } else if(st && ['pending','downloading','queued','crawling'].includes(st.download_status)){
    renderCrawlCard(t, st);
    startTrackPoller(id);
  } else {
    renderCrawlCard(t, null);
    /* autosave در حال ذخیره است → poller برای نمایش پیشرفت */
    if(dl && dl.status === 'saving') startTrackPoller(id);
  }
}
function renderTrackPage(t){
  const id = String(t.trackId), art = getArtwork(t, 600), liked = isLiked(id), cached = isCached(id),
        crawled = hasAudio(t), previewable = !crawled && hasPreview(t) && !cached, playable = crawled || cached,
        dur = t.trackTimeMillis ? fmtTime(t.trackTimeMillis/1e3) : '',
        year = t.releaseDate ? new Date(t.releaseDate).getFullYear() : '',
        dl = DL.get(id), action = dlActionFor(t);
  let html = `<div class="pb-4">${backBtn()}<div class="hero">${art ? `<img class="hero-art" src="${esc(art)}" loading="eager" fetchpriority="high" decoding="async" alt="">` : `<div class="hero-art hero-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="hero-title">${esc(t.trackName||'Track')}</div><div class="hero-sub">${artistLink(t)}${t.collectionId?` · ${albumLink(t)}`:''}</div><div class="hero-sub" style="font-size:.74rem">${[year,dur,t.primaryGenreName].filter(Boolean).join(' · ')}</div></div>`;
  let pb = '';

/* ── در حال crawl / download ── */
if(dl && ['queued','crawling','saving'].includes(dl.status)){
  const lb = dl.status === 'queued' ? 'Queued'
           : dl.status === 'crawling' ? 'Crawling'
           : 'Downloading';
  pb = `<button class="pill-btn info" onclick="go('/library/downloads')">
    <span class="spinner-border spinner-border-sm me-1" style="width:14px;height:14px;border-width:2px"></span>
    ${lb}${dl.percent?' · '+dl.percent+'%':''}
  </button>`;
}

/* ── آماده برای ذخیره ── */
else if(dl && dl.status === 'ready'){
  pb = `<button class="pill-btn warn" onclick="DL.retry('${esc(id)}')">
    <i class="bi bi-cloud-download"></i> Ready to download
  </button>`;
}

/* ── اصلاً پخش‌شدنی نیست ── */
else if(!playable){
  if(previewable){
    pb = `<button class="pill-btn preview" data-play-id="${esc(id)}" onclick="playById('${esc(id)}')">
            <i class="bi bi-play-circle"></i> Play preview
          </button>
          <button class="pill-btn primary" onclick="startCrawl('${esc(id)}',this,true)">
            <i class="bi bi-cloud-arrow-down"></i> Crawl
          </button>`;
  } else {
    pb = `<button class="pill-btn primary" data-play-id="${esc(id)}" onclick="startCrawl('${esc(id)}',this)">
            <i class="bi ${action.icon}"></i> ${action.label}
          </button>`;
  }
}

/* ── آفلاین است → فقط Play offline، بدون Crawl ── */
else if(cached){
  pb = `<button class="pill-btn success" data-play-id="${esc(id)}" onclick="playById('${esc(id)}')">
    <i class="bi bi-play-fill"></i> Play offline
  </button>`;
}

/* ── پخش آنلاین ممکن است (Bale mirror دارد) ── */
else {
  pb = `<button class="pill-btn success" data-play-id="${esc(id)}" onclick="playById('${esc(id)}')">
    <i class="bi bi-play-fill"></i> Play
  </button>`;

  /* فقط اگر Bale mirror دارد → امکان ذخیره آفلاین بده */
  if(hasBaleAudio(t)){
    pb += `<button class="pill-btn primary" onclick="startCrawl('${esc(id)}',this)">
      <i class="bi bi-download"></i> Download
    </button>`;
  }
}
  html += `<div class="lib-tabs">${pb}<a class="icon-btn" href="${tgLink('track',id)}" rel="noopener" style="background:rgba(41,171,226,.14);color:#29abe2" title="Open in Telegram bot"><i class="bi bi-telegram"></i></a><button class="icon-btn" onclick="trackRadio('${esc(id)}')" title="Track radio" style="background:rgba(var(--bs-primary-rgb),.18);color:var(--bs-primary)"><i class="bi bi-broadcast"></i></button><button class="icon-btn like-btn ${liked?'liked':''}" data-like="${esc(id)}" data-likes="${Number(t.likes)||0}" onclick="toggleLikeById('${esc(id)}')"><i class="bi ${liked?'bi-heart-fill':'bi-heart'}"></i><span class="like-count">${Number(t.likes)>0?fmtCompact(t.likes):''}</span></button><button class="icon-btn" onclick="openTrackMenu('${esc(id)}')" style="background:rgba(var(--bs-body-color-rgb),.09)"><i class="bi bi-three-dots"></i></button></div>`;
  html += `<div id="longTip"></div><div id="crawlCard"></div><div id="noteCard"></div>`;
  html += `<div class="lyrics-card"><div class="lyrics-head"><i class="bi bi-music-note-list"></i><span class="flex-grow-1">Lyrics</span><span class="lyrics-badge" id="lyricsBadge" style="display:none">Synced</span><button class="icon-btn sm lyrics-trans-btn" id="lyricsTransBtn" onclick="openLyricsLangPopover(event)" aria-label="Translate lyrics" title="Translate lyrics"><i class="bi bi-translate"></i></button><button class="icon-btn sm" onclick="copyLyrics()" aria-label="Copy lyrics"><i class="bi bi-clipboard"></i></button></div><div class="lyrics-body" id="lyricsBody"><div class="text-secondary d-flex align-items-center gap-2" style="font-size:.82rem"><span class="spinner-border spinner-border-sm"></span> Loading lyrics…</div></div></div>`;
  html += `<div id="trackArtistSection"></div><div id="trackRelatedSection"></div></div>`;
  MAIN().innerHTML = html;
  reindexActionButtons();
  renderLongTrackTip(t);
  loadLyrics(id, t);
  renderNoteCard(id);
  if(typeof refreshLyricsTransBtn === 'function') refreshLyricsTransBtn();
  if(t.likes == null){
    const c2 = _likeCountCache.get(id);
    if(c2 && c2.exp > Date.now()) setLikeCount(id, c2.v);
    else apiCall(`/like/count?id=${encodeURIComponent(id)}`).then(r => {
      if(r?.ok && r.data?.ok && typeof r.data.likes === 'number'){
        _likeCountCache.set(id, {v:r.data.likes, exp:Date.now()+_LIKE_TTL});
        setLikeCount(id, r.data.likes);
      }
    }).catch(()=>{});
  } else setLikeCount(id, Number(t.likes)||0);
  setupTrackSections(t);
}
const _likeCountCache = new Map(), _LIKE_TTL = 120000;
function setupTrackSections(t){
  disconnectTrackSectionObs();
  const s = getSettings(), root = document.getElementById('main');
  const el1 = $('#trackArtistSection'), el2 = $('#trackRelatedSection');
  if(!root) return;
  const map = new Map();
  if(el1) map.set(el1, () => loadTrackArtistSection(t));
  if(el2){ if(s.saveData) el2.innerHTML = ''; else map.set(el2, () => loadTrackRelatedSection(t)) }
  if(!map.size) return;
  _trackSectionObs = new IntersectionObserver(es => {
    for(const en of es){
      if(!en.isIntersecting) continue;
      const fn = map.get(en.target);
      _trackSectionObs.unobserve(en.target);
      if(fn) try{ fn() }catch{}
    }
  }, {root, rootMargin:'400px 0px', threshold:0});
  for(const el of map.keys()) _trackSectionObs.observe(el);
}
async function loadTrackArtistSection(t){
  const host = $('#trackArtistSection'); if(!host || !t?.artistId) return;
  const key = String(t.artistId);
  if(host.dataset.loadedFor === key && host.childElementCount) return;
  host.dataset.loadedFor = key;
  let a = getCached('artist', key), description = '', wikidata = null;
  const needLookup = !a || !a.description || !a.artistName;
  const [lookupRes, wikiRes] = await Promise.all([
    needLookup ? apiLookup(key, 'musicArtist').catch(()=>null) : Promise.resolve(null),
    fetchArtistWikidata(key).catch(()=>null)
  ]);
  wikidata = wikiRes;
  try{
    const arr = Array.isArray(lookupRes?.results) ? lookupRes.results : Array.isArray(lookupRes) ? lookupRes : [],
          found = arr.find(x => itemType(x) === 'artist') || arr[0];
    if(found){
      if(!a) a = found;
      cacheItems([found]);
      backfillArtistArtwork(key, getArtwork(found, 300)||'');
      const d = String(found.description||'').trim();
      if(d) description = d;
    }
    if(!description && typeof lookupRes?.description === 'string') description = lookupRes.description.trim();
  }catch{}
  if(!description && a?.description) description = String(a.description).trim();
  if(!description && wikidata?.long_description) description = String(wikidata.long_description).trim();
  if(!description && wikidata?.description) description = String(wikidata.description).trim();
  if(!a) a = {wrapperType:'artist', artistId:key, artistName:t.artistName||'Artist'};
  if(!host.isConnected) return;
  if(host.dataset.loadedFor !== key) return;
  const art = getArtwork(a, 300) || '', genre = a.primaryGenreName || '',
        country = (wikidata?.country_of_origin && wikidata.country_of_origin[0]) || (wikidata?.citizenship && wikidata.citizenship[0]) || '',
        meta = [genre, country].filter(Boolean).join(' · '),
        followed = isFollowed(key);
  const avatar = art ? `<img src="${esc(art)}" loading="lazy" decoding="async" alt="" style="width:56px;height:56px;border-radius:50%;object-fit:cover;flex:0 0 auto;background:var(--mm-surface-2)">` : `<div style="width:56px;height:56px;border-radius:50%;flex:0 0 auto;background:linear-gradient(145deg,rgba(var(--bs-primary-rgb),.28),rgba(var(--bs-primary-rgb),.08));color:var(--bs-primary);display:flex;align-items:center;justify-content:center;font-size:1.6rem"><i class="bi bi-person-fill"></i></div>`;
  const descBlock = description ? `<div style="padding:0px 17px 9px;font-size:.82rem;line-height:1.65;color:var(--bs-secondary-color);white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden">${esc(description)}</div>` : `<div style="padding:0px 17px 9px;font-size:.8rem;line-height:1.6;color:var(--bs-secondary-color);opacity:.7">No biography available.</div>`;
  host.innerHTML = `<div style="margin:20px 16px 0;border-radius:var(--r-lg);background:var(--mm-surface);overflow:hidden"><a href="${SCOPE}artist/${esc(key)}" data-link style="display:flex;align-items:center;gap:12px;padding:14px 16px;color:inherit;text-decoration:none">${avatar}<div class="min-w-0 flex-grow-1"><div class="row-title text-truncate" style="font-size:.92rem;font-weight:800">${esc(a.artistName||'Artist')}</div><div class="row-sub text-truncate">${meta?esc(meta):'Artist'}</div></div><i class="bi bi-chevron-right" style="color:var(--bs-secondary-color);font-size:.9rem;flex:0 0 auto"></i></a>${descBlock}<div style="display:flex;gap:8px;padding:16px"><button class="pill-btn follow-btn ${followed?'':'primary'} sm" data-follow="${esc(key)}" data-followers="${Number(a.followers)||0}" onclick="event.preventDefault();event.stopPropagation();toggleFollow('${esc(key)}','${esc(art)}')" style="flex:0 0 auto"><i class="bi ${followed?'bi-check-lg':'bi-plus-lg'}"></i><span class="follow-label">${followed?'Following':'Follow'}</span>${Number(a.followers)>0?`<span class="follow-count">${fmtCompact(a.followers)}</span>`:''}</button><button class="pill-btn" onclick="event.preventDefault();event.stopPropagation();artistRadio('${esc(key)}')"><i class="bi bi-broadcast"></i> Radio</button></div></div>`;
  reindexActionButtons();
  if(a.followers == null) apiCall(`/follow/count?id=${encodeURIComponent(key)}`).then(r => {
    if(r?.ok && r.data?.ok && typeof r.data.followers === 'number') setFollowerCount(key, r.data.followers);
  }).catch(()=>{});
}
async function loadTrackRelatedSection(t){
  const host = $('#trackRelatedSection'); if(!host || !t?.trackId) return;
  const key = String(t.trackId);
  if(host.dataset.loadedFor === key && host.childElementCount) return;
  host.dataset.loadedFor = key;
  let related = [];
  try{ related = await fetchRelatedTracks(t, 12) }catch{}
  if(!host.isConnected) return;
  if(host.dataset.loadedFor !== key) return;
  if(!related.length){ host.innerHTML = ''; return }
  cacheItems(related);
  host.innerHTML = sectionHeaderHtml('More like this', `${related.length} track${related.length===1?'':'s'}`, 'bi-stars','warning') + `<div class="mm-grid">${related.map(cardTrack).join('')}</div>`;
}
function renderLongTrackTip(t){
  const el = $('#longTip'); if(!el) return;
  if(!isLongTrack(t)){ el.innerHTML = ''; return }
  const id = String(t.trackId);
  el.innerHTML = `<div class="crawl-card longtip" style="flex-direction:column;align-items:stretch;gap:10px"><div class="d-flex align-items-start gap-2"><i class="bi bi-exclamation-triangle text-warning" style="font-size:1.5rem"></i><div class="cc-body flex-grow-1"><div class="cc-title">Long track (over 8 minutes)</div><div class="cc-sub">This track is longer than 8 minutes and may fail. If it doesn't work, use the Telegram bot.</div></div></div><div class="d-flex gap-2 flex-wrap"><a class="pill-btn telegram" href="${tgLink('track',id)}" rel="noopener"><i class="bi bi-telegram"></i> Get via Telegram bot</a></div></div>`;
}
function renderNoteCard(id){
  const el = $('#noteCard'); if(!el) return;
  const n = getNote(id);
  el.innerHTML = `<div class="crawl-card idle" style="flex-direction:column;align-items:stretch"><div class="d-flex align-items-center gap-2"><i class="bi bi-journal-text" style="color:var(--bs-primary);font-size:1.3rem"></i><div class="cc-body flex-grow-1"><div class="cc-title">${n?'Your note':'Track notes'}</div>${n?`<div class="cc-sub" style="white-space:pre-wrap">${esc(n.t)}</div>`:`<div class="cc-sub">Keep a personal note about this track</div>`}</div><button class="pill-btn ${n?'sm':'primary sm'}" onclick="editNote('${esc(id)}')"><i class="bi bi-${n?'pencil':'plus-lg'}"></i> ${n?'Edit':'Add'}</button></div></div>`;
}
function renderCrawlCard(t, st){
  const el = $('#crawlCard'); if(!el) return;
  if(!t) return;

  const id = String(t.trackId), dl = DL.get(id), action = dlActionFor(t);

  /* تعیین وضعیت: اول st (سرور)، بعد dl (لوکال) */
  let wantKind = 'none', pct = 0, status = 'crawling', error = '';

  if(st){
    const ds = st.download_status;
    if(ds === 'completed'){
      if(dl && dl.status === 'saving'){ wantKind = 'pending'; status = 'saving'; pct = dl.percent||0 }
      else { wantKind = 'none' }             // ready → Save button بالای صفحه
    } else if(ds === 'failed' || ds === 'stopped'){
      wantKind = 'fail'; error = st.error || '';
    } else if(['pending','downloading','queued','crawling'].includes(ds)){
      wantKind = 'pending';
      pct = Math.max(0, Math.min(100, Number(st.percent)||0));
    }
  } else if(dl){
    if(dl.status === 'failed'){ wantKind = 'fail'; error = dl.error || '' }
    else if(['queued','crawling','saving'].includes(dl.status)){
      wantKind = 'pending'; pct = Math.max(0, Math.min(100, dl.percent||0)); status = dl.status;
    }
  }

  const currentKind = el.dataset.crawlKind || 'none';

  if(wantKind === 'none'){
    if(currentKind !== 'none'){ el.innerHTML = ''; el.dataset.crawlKind = 'none' }
    return;
  }

  /* ── pending ── */
  if(wantKind === 'pending'){
    const sv = status === 'saving';
    const lb = status === 'queued'
      ? (action.isDirect ? 'Queued to download' : 'Queued to crawl')
      : sv ? 'Downloading' : 'Crawling';

    if(currentKind === 'pending'){
      const wrap = el.firstElementChild;
      if(wrap){
        const lbl = wrap.querySelector('[data-cc-label]');
        if(lbl){ const v = lb+'…'; if(lbl.textContent !== v) lbl.textContent = v }
        const pctEl = wrap.querySelector('[data-cc-pct]');
        if(pctEl){ const v = pct+'%'; if(pctEl.textContent !== v) pctEl.textContent = v }
        const bar = wrap.querySelector('[data-cc-bar]');
        if(bar) bar.style.width = pct+'%';
        return;
      }
    }

    el.dataset.crawlKind = 'pending';
    el.innerHTML = `<div class="crawl-card pending" style="flex-direction:column;align-items:stretch">
      <div class="d-flex align-items-center gap-2">
        <span class="spinner-border spinner-border-sm text-info"></span>
        <span class="cc-title flex-grow-1" data-cc-label>${lb}…</span>
        <span class="fw-bold text-info" style="font-size:.8rem" data-cc-pct>${pct}%</span>
      </div>
      <div class="progress mt-2" style="height:5px;border-radius:999px;background:var(--mm-surface-3);overflow:hidden">
        <div class="progress-bar bg-info" data-cc-bar style="width:${pct}%"></div>
      </div>
    </div>`;
    return;
  }

  /* ── fail ── */
  if(wantKind === 'fail'){
    if(currentKind === 'fail'){
      const wrap = el.firstElementChild;
      if(wrap){
        const errEl = wrap.querySelector('[data-cc-err]');
        if(errEl){ if(errEl.textContent !== error) errEl.textContent = error; errEl.style.display = error ? '' : 'none' }
        return;
      }
    }
    el.dataset.crawlKind = 'fail';
    el.innerHTML = `<div class="crawl-card fail" style="flex-direction:column;align-items:stretch;gap:10px">
      <div class="d-flex align-items-center gap-2">
        <i class="bi bi-x-circle-fill text-danger" style="font-size:1.5rem"></i>
        <div class="cc-body flex-grow-1">
          <div class="cc-title">${action.isDirect ? 'Download' : 'Crawl'} failed</div>
          <div class="cc-sub text-truncate" data-cc-err style="${error ? '' : 'display:none'}">${esc(error)}</div>
        </div>
      </div>
      <div class="d-flex gap-2 flex-wrap">
        <button class="pill-btn danger sm" onclick="DL.retry('${esc(id)}')"><i class="bi bi-arrow-repeat"></i> Retry</button>
        <a class="pill-btn telegram sm" href="${tgLink('track',id)}" rel="noopener"><i class="bi bi-telegram"></i> Get via bot</a>
        <button class="icon-btn sm" onclick="DL.remove('${esc(id)}')"><i class="bi bi-x-lg"></i></button>
      </div>
    </div>`;
  }
}
function startTrackPoller(tid){
  stopTrackPoller();
  const id = String(tid);

  const tick = async () => {
    const cur = currentPath().startsWith('/track/') ? currentPath().split('/')[2] : null;
    if(String(cur) !== id){ stopTrackPoller(); return }

    let st;
    try{ st = await apiCrawlStatus(id) }catch{ return }
    if(!st) return;

    const dl = DL.get(id);

    /* ── تکمیل شد: از st خودش استفاده کن (attachments تازه) ── */
    if(st.download_status === 'completed'){
      let it = null;
      if(hasAudio(st)){
        it = { wrapperType:'track', trackId:id, ...st };
        cacheItems([it]);
        _ftCache.set(id, {t:it, exp:Date.now()+_FT_TTL});
        _ftCachePrune();
      }

      if(it && currentPath().startsWith('/track/')){
        renderTrackPage(it);       // ← Play button به‌روز می‌شود
        reindexActionButtons();
        refreshLikes();
      }

      renderCrawlCard(it || getCached('track', id), st);

      /* اگر ذخیره (autosave) هنوز در جریان است، poller را نگه دار */
      if(dl && ['queued','crawling','saving'].includes(dl.status)) return;
      stopTrackPoller();
      return;
    }

    /* ── شکست خورد: کارت fail ── */
    if(st.download_status === 'failed' || st.download_status === 'stopped'){
      const c = getCached('track', id) || { trackId:id, trackName:'', attachments:{} };
      renderCrawlCard(c, st);
      stopTrackPoller();
      return;
    }

    /* ── در جریان: کارت pending با درصد واقعی از st ── */
    const c = getCached('track', id);
    if(c) renderCrawlCard(c, st);
  };

  tick();
  trackPoller = setInterval(tick, POLL_MS);
}/* ══ LYRICS ══════════════════════════════════════════════════════════════════ */
let syncedLyricsCache = {trackId:null, lines:null, synced:false, loading:false};
const numOrNull = v => { if(v == null) return null; const n = Number(v); return isFinite(n) ? n : null };
const INS_RE = /^(instrumental|no\s*lyrics?|no\s*lyrics?\s*available|lyrics?\s*not\s*available|lyrics?\s*not\s*found|not\s*found|instrumental\s*\/\s*not\s*found|instrumental\s*\/\s*(no\s*)?lyrics?|only\s*music|music\s*only|\[?\s*instrumental\s*\]?|\(\s*instrumental\s*\)|♪+\s*instrumental\s*♪*|♫+\s*instrumental\s*♫*|\.{3,}|-+|—+)$/i;
function isInsOnly(lines){
  if(!lines || !lines.length) return true;
  const j = lines.map(l => String(l.text||'').replace(/\[[^\]]*\]/g,'').replace(/\([^)]*\)/g,'').trim()).filter(Boolean).join(' ').replace(/\s+/g,' ').trim().toLowerCase();
  if(!j) return true;
  if(INS_RE.test(j)) return true;
  if(j.length <= 60){
    if(/instrumental/.test(j)) return true;
    if(/not\s*found/.test(j)) return true;
    if(/no\s*lyrics?/.test(j)) return true;
    if(/^\W*$/.test(j)) return true;
  }
  return false;
}
function parseLyricsPayload(r){
  let lines = [], rawText = '';
  const pt = l => numOrNull(l.time ?? l.startTime ?? l.start ?? l.timestamp ?? l.at ?? l.t ?? l.offset);
  const px = l => String(l.text ?? l.line ?? l.content ?? l.lyric ?? l.l ?? l.value ?? '');
  function ingest(n, d){
    if(n == null || d > 6) return;
    if(typeof n === 'string'){ if(!rawText) rawText = n; return }
    if(Array.isArray(n)){ if(!lines.length) lines = n.map(l => typeof l === 'string' ? {time:null, text:l} : {time:pt(l), text:px(l)}); return }
    if(typeof n !== 'object') return;
    if(n.text != null && typeof n.text === 'object'){ ingest(n.text, d+1); if(lines.length || rawText) return }
    if(typeof n.synced === 'string' && n.synced.trim()){ if(!rawText) rawText = n.synced; return }
    if(Array.isArray(n.synced) && n.synced.length){ if(!lines.length) lines = n.synced.map(l => ({time:pt(l), text:px(l)})); return }
    if(Array.isArray(n.lines) && n.lines.length){ if(!lines.length) lines = n.lines.map(l => ({time:pt(l), text:px(l)})); return }
    if(typeof n.plain === 'string' && n.plain.trim()){ if(!rawText) rawText = n.plain; return }
    if(typeof n.lyrics === 'string'){ if(!rawText) rawText = n.lyrics; return }
    if(typeof n.text === 'string'){ if(!rawText) rawText = n.text; return }
    if(typeof n.unsynced === 'string'){ if(!rawText) rawText = n.unsynced; return }
    if(Array.isArray(n.unsynced) && n.unsynced.length){ if(!lines.length) lines = n.unsynced.map(t => ({time:null, text:String(t)})); return }
  }
  const L = r?.lyrics || r?.result || r?.data || r;
  ingest(L, 0);
  if(!lines.length && !rawText && typeof r === 'string') rawText = r;
  if(!lines.length && rawText){
    const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, pa = [];
    for(const ln of String(rawText).split('\n')){
      re.lastIndex = 0;
      const ts = []; let m;
      while((m = re.exec(ln)) !== null){
        const mi = parseInt(m[1],10), se = parseInt(m[2],10),
              fr = m[3] ? parseInt(m[3].padEnd(3,'0').slice(0,3),10)/1e3 : 0;
        ts.push(mi*60 + se + fr);
      }
      const tx = ln.replace(re,'').trim();
      if(ts.length) for(const t of ts) pa.push({time:t, text:tx});
      else pa.push({time:null, text:tx});
    }
    lines = pa;
  }
  if(isInsOnly(lines)) return {lines:[], synced:false};
  const sy = lines.some(l => l.time != null);
  return {lines, synced:sy};
}
function lyricsFromItem(it){
  if(!it) return null;
  const lyr = it.lyrics || it.attachments?.lyrics;
  if(!lyr) return null;
  try{ const p = parseLyricsPayload(lyr); if(p && p.lines && p.lines.length) return p }catch{}
  return null;
}
async function loadLyrics(tid, item){
  const body = $('#lyricsBody'), badge = $('#lyricsBadge');
  if(badge) badge.style.display = 'none';
  const ids = String(tid);
  let it = item || getCached('track', ids);
  if(isCached(ids)){
    const e = await cacheGet(ids).catch(()=>null);
    if(e && e.meta && e.meta.lyrics){ it = it || {}; it.lyrics = e.meta.lyrics }
  }
  const fi = lyricsFromItem(it);
  if(fi){
    syncedLyricsCache = {trackId:ids, lines:fi.lines, synced:fi.synced, loading:false};
    if(body && String(tid) === String(lyricsTrackId)){
      if(badge) badge.style.display = fi.synced ? '' : 'none';
      renderLyricsInto(body, fi.lines, fi.synced);
    }
    return;
  }
  syncedLyricsCache = {trackId:ids, lines:[], synced:false, loading:false};
  if(body && String(tid) === String(lyricsTrackId)) renderLyricsInto(body, [], false);
}
function getEffScroller(c){
  if(c.scrollHeight > c.clientHeight+2) return c;
  let p = c.parentElement;
  while(p && p !== document.body && p !== document.documentElement){
    const s = getComputedStyle(p);
    if(/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight+2) return p;
    p = p.parentElement;
  }
  return c;
}
function scrollLyricIntoView(c, el){
  const d = c && c._lyricsData;
  if(d && performance.now() < (d.userScrollUntil||0)) return;
  const sc = getEffScroller(c); if(!sc) return;
  const cr = sc.getBoundingClientRect(), er = el.getBoundingClientRect(),
        delta = (er.top - cr.top) - (cr.height/2 - er.height/2),
        target = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, sc.scrollTop + delta));
  if(Math.abs(target - sc.scrollTop) > 1) sc.scrollTop = target;
}
function renderLyricsInto(c, lines, synced){
  if(!c) return;
  c._lyricsData = null;
  if(!lines || !lines.length){
    c.classList.remove('synced');
    c.innerHTML = `<div class="text-secondary" style="font-size:.85rem;padding:8px 0">No lyrics available for this track.</div>`;
    return;
  }
  const lang = getSettings().translationLang || 'en';
  if(synced){
    c.classList.add('synced');
    const fr = document.createDocumentFragment(), els = [], elByIdx = new Map();
    lines.forEach((l,i) => {
      const el = document.createElement('div');
      if(l.time == null){ el.className = 'lyric-line blank'; el.innerHTML = '&nbsp;' }
      else {
        el.className = 'lyric-line';
        el.innerHTML = `<span class="lyric-orig">${esc(l.text||'\u00A0')}</span>${lyricTranslationHtml(l.text, i)}`;
        el.dataset.time = l.time;
        el.addEventListener('click', () => {
          const t = parseFloat(el.dataset.time);
          if(!isFinite(t)) return;
          const d = c._lyricsData;
          if(d) d.userScrollUntil = performance.now() + 3500;
          try{ audio.currentTime = t }catch{}
          if(d){
            d.elByLineIdx.forEach((x,idx) => { x.classList.toggle('active', idx === i); x.classList.toggle('passed', idx < i) });
            d.activeIdx = i;
            requestAnimationFrame(() => {
              const sc = getEffScroller(c); if(!sc) return;
              const cr = sc.getBoundingClientRect(), er = el.getBoundingClientRect(),
                    delta = (er.top - cr.top) - (cr.height/2 - er.height/2),
                    target = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, sc.scrollTop + delta));
              if(Math.abs(target - sc.scrollTop) > 1) sc.scrollTop = target;
            });
          }
        });
        elByIdx.set(i, el); els.push(el);
      }
      fr.appendChild(el);
    });
    c.replaceChildren(fr);
    c._lyricsData = {lines, els, elByLineIdx:elByIdx, activeIdx:-1, userScrollUntil:0};
    if(!c._lyricsScrollBound){
      const mk = () => { const d = c._lyricsData; if(d) d.userScrollUntil = performance.now()+4000 };
      c.addEventListener('wheel', mk, {passive:true});
      c.addEventListener('touchmove', mk, {passive:true});
      c.addEventListener('mousedown', mk, {passive:true});
      c._lyricsScrollBound = true;
    }
    updateSyncedLyricsFor(c, true);
    c.querySelectorAll('.lyric-trans').forEach(el => { const txt = el.dataset.text||''; if(txt) loadLyricTranslation(el, txt, lang) });
  } else {
    c.classList.remove('synced');
    c.innerHTML = lines.map((l,i) => `<div class="lyric-line unsynced"><span class="lyric-orig">${esc(l.text||'')}</span>${lyricTranslationHtml(l.text, i)}</div>`).join('');
    c.querySelectorAll('.lyric-trans').forEach(el => { const txt = el.dataset.text||''; if(txt) loadLyricTranslation(el, txt, lang) });
  }
}
function updateSyncedLyricsFor(c, force){
  const d = c._lyricsData; if(!d || !d.lines.length) return;
  const t = audio.currentTime, lines = d.lines;
  let ai = -1;
  for(let i=0;i<lines.length;i++){
    const lt = lines[i].time;
    if(lt == null) continue;
    if(lt <= t+.08) ai = i;
    else break;
  }
  if(ai === d.activeIdx && !force) return;
  const pi = d.activeIdx;
  d.activeIdx = ai;
  if(pi < ai){
    const st = Math.max(0, pi);
    for(let i=st;i<ai;i++){
      const el = d.elByLineIdx.get(i);
      if(el && !el.classList.contains('passed')){ el.classList.add('passed'); el.classList.remove('active') }
    }
  } else if(pi > ai){
    for(let i=ai+1;i<=pi;i++){ const el = d.elByLineIdx.get(i); if(el) el.classList.remove('passed') }
    if(pi >= 0){ const el = d.elByLineIdx.get(pi); if(el) el.classList.remove('active') }
  }
  if(ai >= 0){
    const el = d.elByLineIdx.get(ai);
    if(el){
      if(!el.classList.contains('active')){ el.classList.remove('passed'); el.classList.add('active') }
      if(getSettings().autoScrollLyrics && performance.now() > (d.userScrollUntil||0)) scrollLyricIntoView(c, el);
    }
  }
}
function updateVisibleLyrics(){
  const pc = document.getElementById('lyricsBody');
  if(pc && pc.classList.contains('synced') && pc._lyricsData) updateSyncedLyricsFor(pc);
  const rpc = document.getElementById('rpLyricsBody');
  if(rpc && rpc.classList.contains('synced') && rpc._lyricsData) updateSyncedLyricsFor(rpc);
  if(fpTab === 'lyrics' && $('#full')?.classList.contains('show')){
    const fc = $('#fpTabBody')?.querySelector('.fp-lyrics-body');
    if(fc && fc._lyricsData && fc.classList.contains('synced')) updateSyncedLyricsFor(fc);
  }
}
function copyLyrics(){ const t = $('#lyricsBody')?.innerText || ''; if(!t) return; copyText(t) }
function copyText(t){
  const done = () => toast('Copied');
  if(navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done).catch(() => toast('Copy failed','danger'));
  else {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); done() }catch{ toast('Copy failed','danger') }
    ta.remove();
  }
}
async function shareUrl({title, text, url}){
  url = url || location.href;
  const p = {title:title||document.title, text:text||'', url};
  if(typeof navigator !== 'undefined' && typeof navigator.share === 'function'){
    try{
      const c = {title:p.title};
      if(p.text) c.text = p.text;
      if(p.url) c.url = p.url;
      await navigator.share(c);
      return true;
    }catch(e){ if(e && e.name === 'AbortError') return false }
  }
  try{ copyText(url); toast('Link copied to clipboard','success') }catch{}
  return false;
}

/* ══ PLAYER ══════════════════════════════════════════════════════════════════ */
const Player = {
  track:null, queue:[], index:-1, playing:false, shuffle:false, repeat:'off', seeking:false,
  source:'MusicMan', sleepTimer:null, sleepEnd:0, abRepeat:{a:null, b:null}, isPreview:false
};
const _extendState = {busy:false, added:0, maxPerSession:60}, FP_MAX_ITEMS = 150;
let fpTab = (() => { try{ return ls.get(KEY.fptab, 'now') }catch{ return 'now' } })();
if(!['now','queue','lyrics'].includes(fpTab)) fpTab = 'now';
function setFpTab(tab){
  if(!['now','queue','lyrics'].includes(tab)) return;
  if(fpTab === tab){ renderFpTabBody(); return }
  fpTab = tab;
  try{ ls.set(KEY.fptab, tab) }catch{}
  $$('#fpHeadTabs .fp-head-tab').forEach(b => b.classList.toggle('active', b.dataset.fpTab === tab));
  renderFpTabBody();
}
function renderPlayerNow(body){
  if(!body) return;
  const t = Player.track;
  if(!t){ body.innerHTML = PLAYER_EMPTY('bi-music-note','Nothing playing'); return }
  const art = getArtwork(t, 600) || t.artworkUrl || '', liked = isLiked(t.trackId),
        cur = fmtTime(audio.currentTime||0),
        dur = audio.duration && isFinite(audio.duration) ? fmtTime(audio.duration) : t.trackTimeMillis ? fmtTime(t.trackTimeMillis/1e3) : '0:00',
        pct = audio.duration && isFinite(audio.duration) ? audio.currentTime/audio.duration*100 : 0,
        dl = DL.get(t.trackId), action = dlActionFor(t);
  let dlI = `<i class="bi ${action.icon}"></i>`;
  if(isCached(t.trackId)) dlI = '<i class="bi bi-cloud-check-fill text-success"></i>';
  else if(dl && ['queued','crawling','saving'].includes(dl.status)) dlI = `<span class="spinner-border spinner-border-sm" style="width:14px;height:14px;border-width:2px"></span>`;
  else if(dl && dl.status === 'ready') dlI = '<i class="bi bi-cloud-download text-warning"></i>';
  const artistLine = t.artistId ? `<a class="fp-artist mm-link" href="${SCOPE}artist/${esc(t.artistId)}" data-link>${esc(t.artistName||'')}</a>` : `<div class="fp-artist">${esc(t.artistName||'')}</div>`,
        albumLine = t.collectionId ? `<div class="fp-artist" style="margin-top:2px;font-size:.76rem;opacity:.85"><a class="mm-link" href="${SCOPE}album/${esc(t.collectionId)}" data-link>${esc(t.collectionName||'')}</a></div>` : '',
        playIconCls = Player.playing ? 'bi-pause-fill' : Player.isPreview ? 'bi-play-circle' : 'bi-play-fill';
  body.innerHTML = `<div class="fp-body">${art ? `<img class="fp-art" src="${esc(art)}" decoding="async" alt="">` : `<div class="fp-art fp-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="fp-meta"><div class="fp-title">${esc(t.trackName||'Track')}${Player.isPreview?previewTagHtml():''}</div>${artistLine}${albumLine}</div><div class="fp-seek"><input class="mm-range fp-seek-input" type="range" min="0" max="1000" value="${Math.round(pct*10)}" style="--p:${pct}%"><div class="fp-times"><span class="fp-cur">${cur}</span><span class="fp-dur">${dur}</span></div><div style="display:flex;justify-content:center;margin-top:6px"><span class="ab-chip off" onclick="abToggle()"></span></div></div><div class="fp-controls"><button class="icon-btn ${Player.shuffle?'on':''}" onclick="toggleShuffle()"><i class="bi bi-shuffle"></i></button><button class="icon-btn lg" onclick="prevTrack()"><i class="bi bi-skip-start-fill"></i></button><button class="fp-play" onclick="togglePlay()"><i class="bi ${playIconCls} fp-play-icon"></i></button><button class="icon-btn lg" onclick="nextTrack()"><i class="bi bi-skip-end-fill"></i></button><button class="icon-btn ${Player.repeat!=='off'?'on':''}" onclick="cycleRepeat()"><i class="bi ${Player.repeat==='one'?'bi-repeat-1':'bi-repeat'}"></i></button></div><div class="fp-volume"><i class="bi bi-volume-mute"></i><input class="mm-range vol fp-vol-input" type="range" min="0" max="100" value="${Math.round(audio.volume*100)}" style="--p:${Math.round(audio.volume*100)}%"><i class="bi bi-volume-up"></i></div><div class="fp-actions"><button class="icon-btn like-btn ${liked?'liked':''} fp-like-btn" data-like="${esc(t.trackId)}" data-likes="${Number(t.likes)||0}" onclick="toggleLikeCurrent()"><i class="bi ${liked?'bi-heart-fill':'bi-heart'}"></i><span class="like-count">${Number(t.likes)>0?fmtCompact(t.likes):''}</span></button><button class="icon-btn fp-save-btn" onclick="saveCurrentTrack()">${dlI}</button><button class="icon-btn" onclick="openPlaylistPicker('${esc(t.trackId)}')"><i class="bi bi-plus-lg"></i></button><button class="icon-btn" onclick="tgStart('track','${esc(t.trackId)}')" title="Open in Telegram bot"><i class="bi bi-telegram"></i></button><button class="icon-btn" onclick="openSleepTimer()"><i class="bi bi-moon"></i></button><button class="icon-btn" onclick="abToggle()"><i class="bi bi-repeat"></i></button></div></div>`;
  wirePlayerNow(body);
  updateAbChip(body);
}
function wirePlayerNow(body){
  const seek = body.querySelector('.fp-seek-input');
  if(seek){
    seek.addEventListener('pointerdown', () => { Player.seeking = true });
    seek.addEventListener('pointerup', () => { Player.seeking = false });
    seek.addEventListener('input', e => {
      const p = Number(e.target.value)/10;
      e.target.style.setProperty('--p', p+'%');
      if(audio.duration && isFinite(audio.duration)){ const c = body.querySelector('.fp-cur'); if(c) c.textContent = fmtTime(p/100*audio.duration) }
    });
    seek.addEventListener('change', e => {
      if(audio.duration && isFinite(audio.duration)) audio.currentTime = Number(e.target.value)/1e3*audio.duration;
      Player.seeking = false;
    });
  }
  const vol = body.querySelector('.fp-vol-input');
  if(vol) vol.addEventListener('input', e => {
    const v = Number(e.target.value)/100;
    audio.volume = v; ls.set(KEY.vol, v);
    e.target.style.setProperty('--p', e.target.value+'%');
  });
}
function queueRow(tr, i, opts={}){
  const act = i === Player.index, art = getArtwork(tr, 100) || tr.artworkUrl || '',
        isPlaying = act && Player.playing, al = artistLink(tr, true),
        drag = opts.drag ? `<div class="q-drag" onclick="event.stopPropagation()"><button ${i===0?'disabled':''} onclick="moveQueueItem(${i},-1)"><i class="bi bi-chevron-up"></i></button><button ${i===Player.queue.length-1?'disabled':''} onclick="moveQueueItem(${i},1)"><i class="bi bi-chevron-down"></i></button></div>` : '',
        dragging = opts.drag ? ` draggable="true" data-qi="${i}"` : '',
        rem = opts.drag ? `<button class="icon-btn sm" onclick="event.stopPropagation();removeQueue(${i})"><i class="bi bi-x-lg"></i></button>` : '',
        ind = isPlaying ? `<span class="q-bars"><span></span><span></span><span></span><span></span></span>` : act ? `<i class="bi bi-play-fill text-primary"></i>` : '';
  return `<div class="q-row ${act?'active':''}"${dragging} onclick="jumpQueue(${i})">${drag}${art ? `<img src="${esc(art)}" class="row-art" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="flex-grow-1 min-w-0"><div class="row-title text-truncate">${esc(tr.trackName||'Track')}</div><div class="row-sub text-truncate">${al}</div></div>${ind}${rem}</div>`;
}
function attachQueueDnD(root){
  if(!root) return;
  let dragIdx = null;
  root.querySelectorAll('.q-row[draggable="true"]').forEach(el => {
    el.addEventListener('dragstart', e => {
      dragIdx = Number(el.dataset.qi); el.classList.add('dragging');
      try{ e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragIdx)) }catch{}
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); root.querySelectorAll('.q-row').forEach(x => x.classList.remove('drag-over')) });
    el.addEventListener('dragover', e => { e.preventDefault(); try{ e.dataTransfer.dropEffect = 'move' }catch{}; root.querySelectorAll('.q-row').forEach(x => x.classList.remove('drag-over')); el.classList.add('drag-over') });
    el.addEventListener('drop', e => {
      e.preventDefault();
      const from = dragIdx, to = Number(el.dataset.qi);
      if(from == null || isNaN(to) || from === to) return;
      const cur = Player.queue[Player.index], [m] = Player.queue.splice(from, 1);
      Player.queue.splice(to, 0, m);
      Player.index = Player.queue.indexOf(cur);
      renderFpTabBody(); updateRightPanel();
    });
  });
}
/* ══════════════════════════════════════════════════════════════════════════
   MOBILE FULL-PLAYER TAB RENDERER
   Three tabs: now / queue / lyrics. The queue tab mirrors the right panel:
   when the queue is empty, it shows suggestions via _mountQueueSuggestions()
   so both surfaces stay consistent (desktop + mobile).
   ══════════════════════════════════════════════════════════════════════════ */
function renderFpTabBody(){
  const body = $('#fpTabBody');
  if(!body) return;
  if(IS_DESKTOP()) return;

  const fp = $('#full');
  if(!fp || !fp.classList.contains('show')) return;

  if(!['now','queue','lyrics'].includes(fpTab)) fpTab = 'now';

  /* ── TAB: NOW PLAYING ── */
  if(fpTab === 'now'){
    renderPlayerNow(body);
  }

  /* ── TAB: QUEUE ── */
  else if(fpTab === 'queue'){
    const q = Player.queue;
    const items = q.length > FP_MAX_ITEMS ? q.slice(0, FP_MAX_ITEMS) : q;

    /* ── EMPTY QUEUE → show suggestions (change 3) ── */
    if(!q.length){
      _mountQueueSuggestions(body, 'fp');
    }
    /* ── POPULATED QUEUE → standard render ── */
    else {
      let h = `<div class="fp-list-head">
        <div class="fp-list-title">Now playing · ${q.length}</div>
        <div class="fp-list-actions">
          <button class="icon-btn sm" onclick="saveQueueAsPlaylist()" title="Save as playlist">
            <i class="bi bi-save"></i>
          </button>
          <button class="icon-btn sm" onclick="shuffleQueue()">
            <i class="bi bi-shuffle"></i>
          </button>
          <button class="icon-btn sm" onclick="clearQueue()">
            <i class="bi bi-trash3"></i>
          </button>
        </div>
      </div>`;

      h += items.map((tr, i) => queueRow(tr, i, { drag: true })).join('');

      if(q.length > FP_MAX_ITEMS){
        h += `<div class="text-center py-3 text-secondary" style="font-size:.72rem">+${q.length - FP_MAX_ITEMS} more</div>`;
      }

      const rec = getRecentlyPlayed()
        .filter(r => !q.some(t => String(t.trackId) === String(r.trackId)))
        .slice(0, 8);

      if(rec.length){
        h += `<div class="fp-list-head" style="margin-top:6px">
          <div class="fp-list-title">Recently played</div>
        </div>`;
        h += rec.map(r => {
          const art = r.artworkUrl || '';
          const al = artistLink(r, true);
          return `<div class="q-row" onclick="playById('${esc(r.trackId)}')">
            ${art
              ? `<img src="${esc(art)}" class="row-art" loading="lazy" decoding="async" alt="">`
              : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}
            <div class="flex-grow-1 min-w-0">
              <div class="row-title text-truncate">${esc(r.trackName||'Track')}</div>
              <div class="row-sub text-truncate">${al} · ${fmtAgo(r.at)}</div>
            </div>
          </div>`;
        }).join('');
      }

      body.innerHTML = h;
      attachQueueDnD(body);
    }
  }

  /* ── TAB: LYRICS ── */
  else {
    const t = Player.track;
    if(!t){
      body.innerHTML = PLAYER_EMPTY('bi-music-note-list', 'Nothing playing');
    } else {
      const id = String(t.trackId);

      const header = `<div class="fp-lyrics-head">
        <div class="fp-lyrics-title"><i class="bi bi-music-note-list"></i> Lyrics</div>
        <button class="icon-btn sm lyrics-trans-btn" id="fpLyricsTransBtn" onclick="openLyricsLangPopover(event)" aria-label="Translate lyrics" title="Translate lyrics">
          <i class="bi bi-translate"></i>
        </button>
        <button class="icon-btn sm" onclick="copyLyricsFp()" aria-label="Copy lyrics">
          <i class="bi bi-clipboard"></i>
        </button>
      </div>`;

      if(syncedLyricsCache.trackId !== id || syncedLyricsCache.loading){
        body.innerHTML = header + `<div class="fp-lyrics-empty"><span class="spinner-border spinner-border-sm me-2"></span> Loading lyrics…</div>`;
        ensureFpLyrics();
      }
      else if(!syncedLyricsCache.lines || !syncedLyricsCache.lines.length){
        body.innerHTML = header + PLAYER_EMPTY('bi-music-note-list', 'No lyrics available for this track.');
      }
      else {
        body.innerHTML = header + `<div class="fp-lyrics-body" style="font-size:calc(.86rem * var(--lyric-size,1))"></div>`;
        renderLyricsInto(body.querySelector('.fp-lyrics-body'), syncedLyricsCache.lines, syncedLyricsCache.synced);
      }

      requestAnimationFrame(() => {
        try { refreshLyricsTransBtn() } catch {}
      });
    }
  }

  /* Queue badge on the tab header */
  const b = $('#fpQueueBadge');
  if(b){
    b.textContent = Player.queue.length;
    b.classList.toggle('on', Player.queue.length > 0);
  }
}
window.copyLyricsFp = function(){
  const c = document.querySelector('#fpTabBody .fp-lyrics-body');
  if(!c) return;
  const t = c.innerText || '';
  if(t) copyText(t);
};
let rpMode = 'now';
function renderRpNow(){
  const body = document.getElementById('rpBody'); if(!body) return;
  const t = Player.track;
  if(!t){ body.innerHTML = PLAYER_EMPTY('bi-music-note','Nothing playing'); return }
  const art = getArtwork(t, 600) || t.artworkUrl || '', id = String(t.trackId),
        al = t.artistId ? `<a class="mm-link" href="${SCOPE}artist/${esc(t.artistId)}" data-link>${esc(t.artistName||'')}</a>` : `<div class="rp-now-artist">${esc(t.artistName||'')}</div>`,
        alb = t.collectionId ? `<div style="margin-top:6px;font-size:.76rem;color:var(--bs-secondary-color)"><a class="mm-link" href="${SCOPE}album/${esc(t.collectionId)}" data-link>${esc(t.collectionName||'')}</a></div>` : '',
        cached = isCached(id), dl = DL.get(id), action = dlActionFor(t);
  let dlBtn;
  if(cached) dlBtn = `<button onclick="exportCached('${esc(id)}')"><i class="bi bi-file-earmark-arrow-down" style="color:var(--bs-success)"></i>Saved</button>`;
  else if(dl && ['queued','crawling','saving'].includes(dl.status)){ const lb = dl.status === 'saving' ? 'Downloading' : 'Crawling'; dlBtn = `<button onclick="go('/library/downloads')"><span class="spinner-border spinner-border-sm" style="width:14px;height:14px;border-width:2px;color:var(--bs-info)"></span>${lb}</button>` }
  else if(dl && dl.status === 'ready') dlBtn = `<button onclick="DL.retry('${esc(id)}')"><i class="bi bi-cloud-download" style="color:var(--bs-warning)"></i>Save</button>`;
  else if(dl && dl.status === 'failed') dlBtn = `<button onclick="DL.retry('${esc(id)}')"><i class="bi bi-arrow-repeat" style="color:var(--bs-danger)"></i>Retry</button>`;
  else { const cls = action.isDirect ? '' : 'is-preview'; dlBtn = `<button onclick="saveCurrentTrack()" class="${cls}"><i class="bi ${action.icon}"></i>${action.label}</button>` }
  const playIcon = Player.playing ? 'bi-pause-fill' : Player.isPreview ? 'bi-play-circle' : 'bi-play-fill';
  body.innerHTML = `<div class="rp-now">${art ? `<img class="rp-now-art" src="${esc(art)}" decoding="async" alt="">` : '<div class="rp-now-art" style="display:flex;align-items:center;justify-content:center;color:var(--bs-secondary-color);font-size:3rem"><i class="bi bi-music-note"></i></div>'}<div class="rp-now-title">${esc(t.trackName||'Track')}${Player.isPreview?previewTagHtml():''}</div>${al}${alb}<div class="rp-quick"><button onclick="togglePlay()"><i class="bi ${playIcon}"></i>${Player.playing?'Pause':'Play'}</button><button onclick="toggleLikeCurrent()"><i class="bi ${isLiked(t.trackId)?'bi-heart-fill':'bi-heart'}"></i>Like</button>${dlBtn}<button onclick="tgStart('track','${esc(id)}')"><i class="bi bi-telegram"></i>Telegram</button></div></div><div class="rp-section-title">Recently played</div><div class="recent-rail">${getRecentlyPlayed().slice(0,8).map(r => { const a = r.artworkUrl||'', ral = artistLink(r, true); return `<div class="q-row" onclick="playById('${esc(r.trackId)}')">${a ? `<img src="${esc(a)}" class="row-art" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="flex-grow-1 min-w-0"><div class="row-title text-truncate">${esc(r.trackName||'Track')}</div><div class="row-sub text-truncate">${ral}</div></div></div>` }).join('')}</div>`;
}
/* ══════════════════════════════════════════════════════════════════════════
   QUEUE SUGGESTIONS — shown in the Queue tab when nothing is queued
   ══════════════════════════════════════════════════════════════════════════ */
const QUEUE_SUGGEST_TTL = 5 * 60 * 1000;
const _queueSuggestions = { items: [], source: null, loading: false, error: null, at: 0 };

async function loadQueueSuggestions(force = false){
  if(_queueSuggestions.loading) return _queueSuggestions.items;
  if(!force && _queueSuggestions.at && Date.now() - _queueSuggestions.at < QUEUE_SUGGEST_TTL){
    return _queueSuggestions.items;
  }

  _queueSuggestions.loading = true;
  try{
    let items = [], source = null;

    /* Defensive TDZ guard — MMMAuth is declared later in the file than
       some IIFEs that can trigger us. If we're inside the temporal dead
       zone, accessing MMAuth.user throws ReferenceError; catch and treat
       as signed-out so we fall back to popular tracks instead of
       breaking boot. */
    let signedIn = false;
    try { signedIn = !!(MMAuth && MMAuth.user); } catch { signedIn = false; }

    /* 1st choice: personalized recommendations */
    if(signedIn){
      try{
        const r = await apiCall('/recommendations?limit=20&offset=0');
        if(r.ok && r.data?.success && Array.isArray(r.data.results)){
          const recs = r.data.results.filter(t => itemType(t) === 'track');
          if(recs.length){ cacheItems(recs); items = recs; source = 'recommendations'; }
        }
      }catch{}
    }

    /* 2nd choice: popular tracks */
    if(!items.length){
      try{
        const po = await apiPopular(30);
        const pop = po.filter(i => itemType(i) === 'track').slice(0, 20);
        if(pop.length){ cacheItems(pop); items = pop; source = 'popular'; }
      }catch{}
    }

    _queueSuggestions.items = items;
    _queueSuggestions.source = source;
    _queueSuggestions.error = items.length ? null : 'No suggestions available';
    _queueSuggestions.at = Date.now();
    return items;
  }catch(e){
    _queueSuggestions.error = e.message || String(e);
    _queueSuggestions.at = Date.now();
    return [];
  }finally{
    _queueSuggestions.loading = false;
  }
}
function queueSuggestionsHtml(loading){
  const s = _queueSuggestions;
  const isRec = s.source === 'recommendations';
  const title = isRec ? 'Recommended for you' : 'Popular right now';
  const icon  = isRec ? 'bi-stars' : 'bi-fire';

  let h = `<div class="rp-section-title queue-sug-title">${title}</div>`;

  if(loading || (s.loading && !s.items.length)){
    h += `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>`;
    h += `<div class="text-center text-secondary" style="font-size:.72rem;padding:6px 6px 20px">Loading suggestions…</div>`;
    return h;
  }

  if(!s.items.length){
    h += `<div class="text-center text-secondary" style="font-size:.78rem;padding:20px 10px">${esc(s.error || 'Queue is empty')}</div>`;
    h += `<div class="text-center pb-3"><button class="pill-btn sm" onclick="refreshQueueSuggestions()"><i class="bi bi-arrow-repeat"></i> Try again</button></div>`;
    return h;
  }

  h += s.items.map((t, i) => suggestionRowHtml(t, i)).join('');
  return h;
}

function suggestionRowHtml(t, idx){
  const art = getArtwork(t, 100) || t.artworkUrl || '';
  const al  = artistLink(t, true);
  const dur = t.trackTimeMillis ? fmtTime(t.trackTimeMillis/1e3) : '';
  return `<div class="q-row" onclick="playSuggestionAt(${idx})">
    ${art ? `<img src="${esc(art)}" class="row-art" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}
    <div class="flex-grow-1 min-w-0">
      <div class="row-title text-truncate">${esc(t.trackName||'Track')}</div>
      <div class="row-sub text-truncate">${al}${dur?' · '+esc(dur):''}</div>
    </div>
    <i class="bi bi-play-fill" style="color:var(--bs-secondary-color);font-size:.95rem;flex:0 0 auto;margin-right:6px"></i>
  </div>`;
}

/* mode: 'rp' = right panel, 'fp' = mobile full player */
function _mountQueueSuggestions(body, mode){
  const s = _queueSuggestions;
  const fresh = s.at && (Date.now() - s.at < QUEUE_SUGGEST_TTL);

  if(fresh){ body.innerHTML = queueSuggestionsHtml(false); return }

  body.innerHTML = queueSuggestionsHtml(true);
  loadQueueSuggestions().then(() => {
    if(Player.queue.length) return;                 /* user played something */
    let b = null;
    if(mode === 'rp' && rpMode === 'queue') b = document.getElementById('rpBody');
    else if(mode === 'fp' && fpTab === 'queue' && $('#full')?.classList.contains('show')) b = $('#fpTabBody');
    if(b) b.innerHTML = queueSuggestionsHtml(false);
  });
}

window.playQueueSuggestions = function(){
  const items = _queueSuggestions.items;
  if(!items.length) return;
  Player.queue = items.slice();
  Player.index = 0;
  _extendState.added = 0;
  playItem(items[0], 'Recommendations');
  toast(`Playing ${items.length} ${_queueSuggestions.source === 'popular' ? 'popular' : 'recommended'} tracks`);
};

window.addQueueSuggestions = function(){
  const items = _queueSuggestions.items;
  if(!items.length) return;
  addAllToQueue(items);
};

window.playSuggestionAt = function(idx){
  const items = _queueSuggestions.items;
  if(!items.length || idx < 0 || idx >= items.length) return;
  Player.queue = items.slice();
  Player.index = idx;
  _extendState.added = 0;
  playItem(Player.queue[idx], 'Recommendations');
};

window.refreshQueueSuggestions = function(){
  _queueSuggestions.items = [];
  _queueSuggestions.source = null;
  _queueSuggestions.error = null;
  _queueSuggestions.at = 0;
  if(rpMode === 'queue') updateRightPanel();
  if(fpTab === 'queue' && $('#full')?.classList.contains('show')) renderFpTabBody();
};
/* ══════════════════════════════════════════════════════════════════════════
   RIGHT-PANEL QUEUE RENDERER
   — When the queue is non-empty: renders the standard scrollable list
     with drag-to-reorder, recently-played rail, and move/remove controls.
   — When the queue is empty: defers to _mountQueueSuggestions() which
     shows "Recommended for you" or "Popular right now" instead of a
     blank state. The suggestions render path is shared with the mobile
     full-player queue tab (see renderFpTabBody → 'queue').
   ══════════════════════════════════════════════════════════════════════════ */
function renderRpQueue(){
  const body = document.getElementById('rpBody');
  if(!body) return;

  const q = Player.queue;

  /* ── EMPTY QUEUE → show suggestions (change 2) ── */
  if(!q.length){
    _mountQueueSuggestions(body, 'rp');
    return;
  }

  /* ── POPULATED QUEUE → standard render ── */
  const items = q.length > FP_MAX_ITEMS ? q.slice(0, FP_MAX_ITEMS) : q;

  let h = `<div class="fp-list-head">
    <div class="fp-list-title">Queue · ${q.length}</div>
    <div class="fp-list-actions">
      <button class="icon-btn sm" onclick="saveQueueAsPlaylist()" title="Save as playlist">
        <i class="bi bi-save"></i>
      </button>
      <button class="icon-btn sm" onclick="shuffleQueue()" title="Shuffle">
        <i class="bi bi-shuffle"></i>
      </button>
      <button class="icon-btn sm" onclick="clearQueue()" title="Clear">
        <i class="bi bi-trash3"></i>
      </button>
    </div>
  </div>`;

  h += items.map((tr, i) => queueRow(tr, i, { drag: true })).join('');

  if(q.length > FP_MAX_ITEMS){
    h += `<div class="text-center py-3 text-secondary" style="font-size:.72rem">+${q.length - FP_MAX_ITEMS} more</div>`;
  }

  body.innerHTML = h;
  attachQueueDnD(body);
}
function renderRpLyrics(){
  const body = document.getElementById('rpBody'); if(!body) return;
  const t = Player.track;
  if(!t){ body.innerHTML = PLAYER_EMPTY('bi-music-note-list','Nothing playing'); return }
  const id = String(t.trackId);
  if(syncedLyricsCache.trackId !== id || syncedLyricsCache.loading){ body.innerHTML = `<div class="fp-lyrics-empty"><span class="spinner-border spinner-border-sm me-2"></span>Loading lyrics…</div>`; ensureFpLyrics(); return }
  if(!syncedLyricsCache.lines?.length){ body.innerHTML = PLAYER_EMPTY('bi-music-note-list','No lyrics available.'); return }
  body.innerHTML = '<div class="fp-lyrics-body" id="rpLyricsBody" style="font-size:calc(.86rem * var(--lyric-size,1))"></div>';
  renderLyricsInto(document.getElementById('rpLyricsBody'), syncedLyricsCache.lines, syncedLyricsCache.synced);
}
function renderRpInfo(){
  const body = document.getElementById('rpBody'); if(!body) return;
  const t = Player.track;
  if(!t){ body.innerHTML = PLAYER_EMPTY('bi-info-circle','Nothing playing'); return }
  const dur = t.trackTimeMillis ? fmtTime(t.trackTimeMillis/1e3) : audio.duration && isFinite(audio.duration) ? fmtTime(audio.duration) : '—',
        art = getArtwork(t, 600) || '',
        rows = [
          ['Title', esc(t.trackName||'—')],
          ['Artist', t.artistId ? `<a class="mm-link" href="${SCOPE}artist/${esc(t.artistId)}" data-link>${esc(t.artistName||'—')}</a>` : esc(t.artistName||'—')],
          ['Album', t.collectionId ? `<a class="mm-link" href="${SCOPE}album/${esc(t.collectionId)}" data-link>${esc(t.collectionName||'—')}</a>` : esc(t.collectionName||'—')],
          ['Duration', esc(dur)],
          ['Genre', esc(t.primaryGenreName||'—')],
          ['Released', t.releaseDate ? esc(new Date(t.releaseDate).toLocaleDateString()) : '—'],
          ['Track #', t.trackNumber ? String(t.trackNumber) : '—'],
          ['Track ID', esc(String(t.trackId||''))]
        ];
  body.innerHTML = `<div style="padding:8px 10px 0">${art ? `<img src="${esc(art)}" style="width:100%;border-radius:var(--r-lg);box-shadow:var(--el-3);margin-bottom:14px;aspect-ratio:1;object-fit:cover" loading="lazy" decoding="async" alt="">` : ''}${rows.map(([k,v]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 4px;border-bottom:1px solid var(--mm-divider);font-size:.8rem"><span style="color:var(--bs-secondary-color);font-weight:700">${k}</span><span style="text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${v}</span></div>`).join('')}<div class="d-flex gap-2 mt-3"><button class="pill-btn primary flex-fill justify-content-center" onclick="copyText(location.origin+'${BASE||''}/track/${esc(String(t.trackId))}')"><i class="bi bi-link-45deg"></i> Copy link</button><a class="pill-btn telegram flex-fill justify-content-center" href="${tgLink('track',t.trackId)}" rel="noopener"><i class="bi bi-telegram"></i></a></div></div>`;
}
/* Latch: true means "we've already auto-jumped to Queue for this empty
   period". Reset the moment a track loads, so a future logout / fresh
   boot will auto-jump again. */
let _rpAutoSwitchDone = false;

function updateRightPanel(){
  const body = document.getElementById('rpBody'); if(!body) return;

  /* ── AUTO-SWITCH (one-shot per empty period) ────────────────────────
     • Player.track truthy  → reset latch so next empty period re-triggers
     • !Player.track && !latch → jump to Queue once, set latch
     • !Player.track && latch → respect user's manual tab choice
     ─────────────────────────────────────────────────────────────────── */
  if(Player.track){
    if(_rpAutoSwitchDone) _rpAutoSwitchDone = false;
  } else if(!_rpAutoSwitchDone && rpMode !== 'queue'){
    rpMode = 'queue';
    _rpAutoSwitchDone = true;
    $$('#rpTabs .rp-tab').forEach(b => b.classList.toggle('active', b.dataset.rpTab === 'queue'));
  }

  if(rpMode === 'now') renderRpNow();
  else if(rpMode === 'lyrics') renderRpLyrics();
  else if(rpMode === 'info') renderRpInfo();
  else renderRpQueue();

  const b = $('#rpQueueBadge');
  if(b){ b.textContent = Player.queue.length; b.classList.toggle('on', Player.queue.length > 0) }
}
function syncPlayerUI(){
  const t = Player.track, mini = $('#mini');

  /* Single source of truth for player visibility — CSS keys off this. */
  document.body.classList.toggle('has-track', !!t);

  /* No mini element on desktop-only variants — still update the bar. */
  if(!mini){ syncPlayerBar(); updateRightPanel(); return; }

  if(!t){
    mini.classList.add('d-none');
    document.title = 'MusicMan';
    renderFpTabBody();
    syncPlayerBar();
    updateRightPanel();
    return;
  }

  mini.classList.remove('d-none');
  const art = getArtwork(t, 300) || t.artworkUrl || '',
        artS = getArtwork(t, 100) || t.artworkUrl || art,
        mi = $('#miniArt');
  if(artS){ mi.src = artS; mi.style.visibility = 'visible' }
  else { mi.removeAttribute('src'); mi.style.visibility = 'hidden' }
  const appBg = $('#appBg');
  if(appBg && art && getSettings().appBg) appBg.style.backgroundImage = `url("${art}")`;
  $('#miniTitle').innerHTML = esc(t.trackName||'Track') + (Player.isPreview ? previewTagHtml() : '');
  $('#miniArtist').textContent = t.artistName || '';
  const bg = $('#fpBg');
  if(bg) bg.style.backgroundImage = art ? `url("${art}")` : '';
  reindexActionButtons(); refreshLikes();
  renderFpTabBody();
  syncPlayIcons();
  syncSaveButton();
  updateMediaSession();
  document.title = `${t.trackName||'MusicMan'} · MusicMan`;
  syncPlayerBar();
  updateRightPanel();
  if(getSettings().accent === 'auto' && art) computeArtAccent(art).then(c => {
    if(c && Player.track && String(Player.track.trackId) === String(t.trackId) && getSettings().accent === 'auto') applyAccent(null, c);
  });
}
function syncPlayIcons(){
  const preparing = !!Player.preparing;
  const cls = preparing
    ? 'bi-arrow-repeat mm-spin'
    : Player.playing   ? 'bi-pause-fill'
    : Player.isPreview ? 'bi-play-circle'
    :                    'bi-play-fill';

  const m  = $('#miniPlayIcon'); if(m)  m.className  = `bi ${cls}`;
  const pb = $('#pbPlayIcon');   if(pb) pb.className = `bi ${cls}`;
  $$('.fp-play-icon').forEach(f => f.className = `bi ${cls} fp-play-icon`);

  const cur = Player.track ? String(Player.track.trackId) : null;
  $$('.row-item .row-play[data-play-id]').forEach(b => {
    const id = String(b.dataset.playId||''), it = b.closest('.row-item'),
          isCur = cur && id === cur, ic = b.querySelector('i'),
          isPreview = b.dataset.preview === '1';
    if(ic){
      const icCls = isCur && preparing
        ? 'bi-arrow-repeat mm-spin'
        : isCur && Player.playing ? 'bi-pause-fill'
        : isPreview ? 'bi-play-circle'
        : 'bi-play-fill';
      ic.className = `bi ${icCls}`;
    }
    b.classList.toggle('playing', !!isCur && Player.playing);
    b.classList.toggle('is-preview', isPreview);
    if(it) it.classList.toggle('playing', !!isCur);
  });

  const eq = $('#miniEq');
  if(eq) eq.classList.toggle('on', Player.playing);
  if(typeof syncPlayerBar === 'function') syncPlayerBar();
}
function syncSaveButton(){
  const id = Player.track?.trackId;
  $$('.fp-save-btn').forEach(b => {
    if(!id){ b.innerHTML = '<i class="bi bi-download"></i>'; return }
    if(isCached(id)){ b.innerHTML = '<i class="bi bi-cloud-check-fill text-success"></i>'; return }
    const dl = DL.get(id);
    if(dl && ['queued','crawling','saving'].includes(dl.status)){ b.innerHTML = `<span class="spinner-border spinner-border-sm" style="width:14px;height:14px;border-width:2px"></span>`; return }
    if(dl && dl.status === 'ready'){ b.innerHTML = '<i class="bi bi-cloud-download text-warning"></i>'; return }
    const a = dlActionFor(Player.track);
    b.innerHTML = `<i class="bi ${a.icon}"></i>`;
  });
}
function setSeekUI(pct){
  const b = $('#miniBar');
  if(b) b.style.width = pct+'%';
  const s = $('#pbSeek');
  if(s && !Player.seeking){ s.value = Math.round(pct*10); s.style.setProperty('--p', pct+'%') }
  const body = $('#fpTabBody');
  if(body){
    const fs = body.querySelector('.fp-seek-input');
    if(fs && !Player.seeking){ fs.value = Math.round(pct*10); fs.style.setProperty('--p', pct+'%') }
  }
}
audio.addEventListener('play', () => { Player.playing = true; syncPlayIcons(); syncSaveButton(); if(fpTab === 'queue') renderFpTabBody(); updateRightPanel(); statsStart() });
audio.addEventListener('pause', () => { Player.playing = false; syncPlayIcons(); if(fpTab === 'queue') renderFpTabBody(); updateRightPanel(); statsStop() });
audio.addEventListener('ended', () => onTrackEnded());
audio.addEventListener('loadedmetadata', () => { if(isFinite(audio.duration)) if(typeof syncPlayerBar === 'function') syncPlayerBar() });
let _trp = false, _llt = 0, _lpt = 0, _stt = 0;
audio.addEventListener('timeupdate', () => {
  if(_trp) return;
  _trp = true;
  requestAnimationFrame(() => {
    _trp = false;
    const d = audio.duration;
    if(!d || !isFinite(d)) return;
    const n = performance.now();
    if(n - _lpt >= PTICK){ _lpt = n; const pct = audio.currentTime/d*100; setSeekUI(pct); const c = $('#fpCur'); if(c) c.textContent = fmtTime(audio.currentTime); updateDesktopSeek(); updatePlayerTimesUI() }
    if(n - _llt >= LTICK){ _llt = n; updateVisibleLyrics() }
    if(n - _stt >= 5e3){ _stt = n; statsTick() }
  });
});
function updatePlayerTimesUI(){
  const t = fmtTime(audio.currentTime||0), d = audio.duration && isFinite(audio.duration) ? fmtTime(audio.duration) : null;
  ['#fpTabBody'].forEach(sel => {
    const root = document.querySelector(sel); if(!root) return;
    const c = root.querySelector('.fp-cur'); if(c) c.textContent = t;
    const du = root.querySelector('.fp-dur'); if(du && d) du.textContent = d;
  });
}
audio.addEventListener('error', () => {
  const src = audio.src;
  if(!src) return;
  if(src.startsWith('blob:') || src.startsWith('data:')) return;
  if(audio.error && audio.error.code === 1) return;        // MEDIA_ERR_ABORTED

  const t = Player.track;
  if(!t || !t.trackId){ toast('Playback error', 'danger'); return }

  const code = audio.error && audio.error.code;
  // 2 = NETWORK, 3 = DECODE — هر دو روی استریم بریده‌شده رخ می‌دهند
  if(code === 2 || code === 3){
    _tryResumeStream();
    return;
  }

  // بقیه کدها → UI دستی
  _resetStreamState();
  toastAction('Playback error', [
    {html:'<i class="bi bi-arrow-repeat"></i> Retry', class:'info', fn:()=>{
      try{
        const cur = audio.src;
        audio.src = ''; audio.load();
        audio.src = cur; audio.load();
        audio.play().catch(()=>{});
      }catch{}
    }},
    {html:'<i class="bi bi-telegram"></i> Telegram', class:'telegram', fn:()=>tgStart('track', t.trackId)}
  ], 'danger', 7e3);
});
function updateMediaSession(){
  if(!('mediaSession' in navigator)) return;
  const t = Player.track;
  if(!t){ try{ navigator.mediaSession.metadata = null }catch{}; return }
  const a = getArtwork(t, 512) || t.artworkUrl || '';
  try{
    navigator.mediaSession.metadata = new MediaMetadata({
      title:(Player.isPreview ? 'Preview · ' : '') + (t.trackName||'Track'),
      artist:t.artistName||'', album:t.collectionName||'MusicMan',
      artwork:a ? [{src:a, sizes:'512x512', type:'image/jpeg'}] : []
    });
  }catch{}
  try{
    navigator.mediaSession.playbackState = Player.playing ? 'playing' : 'paused';
    const H = (k,f) => { try{ navigator.mediaSession.setActionHandler(k, f) }catch{} };
    H('play', () => audio.play());
    H('pause', () => audio.pause());
    H('previoustrack', () => prevTrack());
    H('nexttrack', () => nextTrack());
    H('seekbackward', d => audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset||10)));
    H('seekforward', d => audio.currentTime = Math.min(audio.duration||0, audio.currentTime + (d.seekOffset||10)));
    H('seekto', d => { if(d.seekTime != null) audio.currentTime = d.seekTime });
    H('stop', () => audio.pause());
    if(audio.duration && isFinite(audio.duration)) navigator.mediaSession.setPositionState({duration:audio.duration, position:Math.min(audio.currentTime, audio.duration), playbackRate:1});
  }catch{}
}
['play','pause','loadedmetadata','ended'].forEach(e => audio.addEventListener(e, updateMediaSession));
let _mtk = 0;
audio.addEventListener('timeupdate', () => {
  const n = performance.now();
  if(n - _mtk < 1e3) return;
  _mtk = n;
  if('mediaSession' in navigator && audio.duration && isFinite(audio.duration)){
    try{ navigator.mediaSession.setPositionState({duration:audio.duration, position:Math.min(audio.currentTime, audio.duration), playbackRate:1}) }catch{}
  }
});
function persistQueue(){
  try{ ls.set(KEY.queue, {q:Player.queue.slice(0,150), i:Player.index, t:Player.track, sh:Player.shuffle, rp:Player.repeat}) }catch{}
}
async function loadTrackSourceForPlayback(t){
  if(!t?.trackId) return false;
  const id = String(t.trackId);
  try{
    if(isCached(id)){
      const e = await cacheGet(id);
      if(e?.blob){
        const u = URL.createObjectURL(e.blob);
        if(audio.dataset.blobUrl){ try{ URL.revokeObjectURL(audio.dataset.blobUrl) }catch{} }
        audio.dataset.blobUrl = u;
        audio.src = u;
        try{ audio.load() }catch{}
        return true;
      }
    }
    let url = getPlayable(t);
    if(!url){
      try{ const r = await apiLookup(id, 'song'), f = r.find(x => itemType(x) === 'track') || r[0]; if(f){ cacheItems([f]); Player.track = f; url = getPlayable(f) } }catch{}
    }
    if(!url) return false;
    if(audio.dataset.blobUrl){ try{ URL.revokeObjectURL(audio.dataset.blobUrl) }catch{}; delete audio.dataset.blobUrl }
    audio.src = proxyUrl(url);
    try{ audio.load() }catch{}
    return true;
  }catch{ return false }
}
async function restoreQueue(){
  const s = ls.get(KEY.queue, null);
  if(!s || !s.q || !s.q.length) return;
  Player.queue = s.q;
  Player.index = Math.max(0, Math.min(s.i||0, s.q.length-1));
  Player.shuffle = !!s.sh;
  Player.repeat = s.rp || 'off';
  const t = s.t || s.q[Player.index];
  if(!t?.trackId) return;
  Player.track = t;
  Player.isPreview = false;
  await loadTrackSourceForPlayback(t);
  syncPlayerUI();
}
['play','pause','ended','loadedmetadata'].forEach(e => audio.addEventListener(e, persistQueue));
let _ptk = 0;
audio.addEventListener('timeupdate', () => {
  const n = performance.now();
  if(n - _ptk < 4e3) return;
  _ptk = n; persistQueue();
});
window.addEventListener('beforeunload', () => { persistQueue(); statsStop() });
window.addEventListener('pagehide', () => { persistQueue(); statsStop() });
const _pn = new Audio();
_pn.preload = 'auto'; _pn.muted = true;
let _pk = '';
function preloadNext(){
  if(IS_LOW_END || Net.saveData || !Net.isFast) return;
  const q = Player.queue; if(q.length < 2) return;
  let ni = Player.index + 1;
  if(Player.shuffle){ ni = Math.floor(Math.random()*q.length); if(ni === Player.index) ni = (ni+1)%q.length }
  if(ni >= q.length){ if(Player.repeat !== 'all') return; ni = 0 }
  const n = q[ni];
  if(!n?.trackId) return;
  const k = String(n.trackId);
  if(_pk === k) return;
  _pk = k;
  if(isCached(k)) return;
  const u = getPlayable(n); if(!u) return;
  try{ _pn.src = proxyUrl(u) }catch{}
}
audio.addEventListener('loadedmetadata', preloadNext);
audio.addEventListener('play', preloadNext);
audio.addEventListener('ended', () => { _pk = '' });
audio.addEventListener('play', () => {
  if(Net.saveData || Net.isSlow) return;
  const q = Player.queue;
  if(!q.length) return;
  for(let i = 1; i <= 2; i++){
    const t = q[Player.index + i];
    if(!t) break;
    const a = getArtwork(t, 100);
    if(a) prefetchArtwork(a);
  }
}, {passive:true});
function showUnavailableSheet(id, item){
  const name = item?.trackName||'Track', artist = item?.artistName||'',
        dl = DL.get(id), busy = dl && ['queued','crawling','saving'].includes(dl.status),
        art = getArtwork(item, 100) || item?.artworkUrl || '', rows = [];
  if(busy) rows.push(`<button class="sheet-item" onclick="closeAllSheets(); go('/library/downloads')"><i class="bi bi-clock-history text-info"></i><span>Track is still being prepared<br><span class="sub">View progress in Downloads</span></span></button>`);
  rows.push(`<a class="sheet-item telegram" href="${tgLink('track',id)}" rel="noopener"><i class="bi bi-telegram"></i><span>Get on Telegram bot<br><span class="sub">Recommended for large files & full audio</span></span></a>`);
  rows.push(`<button class="sheet-item" onclick="closeAllSheets(); startCrawl('${esc(id)}')"><i class="bi bi-cloud-arrow-down text-primary"></i><span>Crawl on server<br><span class="sub">Might fail for very large files</span></span></button>`);
  rows.push(`<button class="sheet-item" onclick="closeAllSheets(); go('/track/${esc(id)}')"><i class="bi bi-info-circle"></i><span>Open track details</span></button>`);
  $('#sheetTrackBody').innerHTML = `<div class="d-flex align-items-center gap-3 px-3 pb-2 pt-1">${art ? `<img src="${esc(art)}" width="52" height="52" class="row-art" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="min-w-0"><div class="fw-bold text-truncate">Cannot play this track</div><div class="row-sub text-truncate">${esc(name)}${artist?' — '+esc(artist):''}</div></div></div><div class="px-3 pb-2"><div class="small text-secondary">This track's full audio isn't available right now. Use the Telegram bot to receive the file, or try crawling it on the server.</div></div><div class="px-2">${rows.join('')}</div>`;
  sheet('#sheetTrack').show();
}
let _playGen = 0;
async function playItem(item, source='MusicMan', myGen=++_playGen){
  if(!item || myGen !== _playGen) return;
  Player.source = source;
  Player.preparing = false; 
  const id = String(item.trackId||'');
  if(!id) return;
  if(source !== 'auto-extend' && source !== 'Radio') _extendState.added = 0;
  if(isCached(id)) return playCachedById(id, item, myGen);

  /* Resolve a playable URL. Try the item, then any cached copy of it,
     then a fresh lookup. */
  let ri = item, ru = getPlayable(item);
  if(!ru){
    const c = getCached('track', id);
    if(c){
      if(isCached(id)) return playCachedById(id, c, myGen);
      const u = getPlayable(c);
      if(u){ ri = c; ru = u }
    }
  }
  if(!ru){
    try{
      const r = await apiLookup(id, 'song');
      if(myGen !== _playGen) return;
      const f = r.find(x => itemType(x) === 'track') || r[0];
      if(f){
        cacheItems([f]);
        if(isCached(id)) return playCachedById(id, f, myGen);
        const u = getPlayable(f);
        if(u){ ri = f; ru = u }
      }
    }catch{}
  }
  if(myGen !== _playGen) return;
  if(!ru){
    const dl = DL.get(id);
    if(dl && ['queued','crawling','saving'].includes(dl.status)) toast('Still preparing — try again in a moment','info');
    else showUnavailableSheet(id, ri || item);
    return;
  }

  const po = !hasAudio(ri) && hasPreview(ri);

  /* Telegram Bot API files: the proxy responds 200 + Content-Length and
     then resets the socket mid-stream (net::ERR_CONNECTION_RESET). The
     <audio> element cannot survive that, but a plain fetch() of the same
     URL succeeds — which is exactly why the manual "open in browser →
     downloads the file" path works. Fetch the whole file into a Blob and
     play from blob: instead of streaming. */
  if(isStreamUnfriendly(ru)){
    return playItemViaBlob(ri, ru, po, myGen);
  }

  /* Normal streaming path — unchanged. */
  audio.pause();
  if(audio.dataset.blobUrl){ try{ URL.revokeObjectURL(audio.dataset.blobUrl) }catch{}; delete audio.dataset.blobUrl }
  try{ _pn.pause(); _pn.removeAttribute('src'); _pn.load() }catch{}
  _stream.lastGoodTime = 0;
  _stream.blobTried = false;
  _resetStreamState();
  _clearBlobUrl();
  audio.src = proxyUrl(ru);
  audio.load();
  const pp = audio.play();
  if(pp && typeof pp.catch === 'function') pp.catch(e => {
    if(myGen !== _playGen) return;
    if(!e || e.name === 'AbortError') return;
    if(e.name === 'NotAllowedError'){
      const once = () => {
        document.removeEventListener('touchstart', once, true);
        document.removeEventListener('click', once, true);
        if(Player.track === ri) audio.play().catch(()=>{});
      };
      document.addEventListener('touchstart', once, {capture:true, once:true, passive:true});
      document.addEventListener('click', once, {capture:true, once:true});
      toast('Tap to continue playback','info');
    } else toast('Cannot play: '+(e.message||''),'danger');
  });
  Player.track = ri;
  Player.isPreview = po;
  pushRecentlyPlayed(ri);
  setQueueFromItem(ri, id);
  syncPlayerUI();
  if(getSettings().autoSavePlayed && !isCached(id) && !DL.get(id) && hasAudio(ri)) setTimeout(() => {
    if(myGen === _playGen){ try{ DL.add(ri).catch(()=>{}) }catch{} }
  }, 800);
  if(po) toast('Preview playing - press crawl to get full track','info');
}
async function playPreviewById(id){
  const myGen = ++_playGen;
  id = String(id); if(!id) return;
  let it = getCached('track', id);
  if(!it){ try{ const r = await apiLookup(id, 'song'); if(myGen !== _playGen) return; it = r.find(x => itemType(x) === 'track') || r[0]; if(it) cacheItems([it]) }catch{} }
  if(myGen !== _playGen) return;
  if(!it){ toast('Track not found','danger'); return }
  const pu = getPreviewUrl(it);
  if(!pu){ toast('No preview available','warning'); return }
  audio.pause();
  if(audio.dataset.blobUrl){ try{ URL.revokeObjectURL(audio.dataset.blobUrl) }catch{}; delete audio.dataset.blobUrl }
  try{ _pn.pause(); _pn.removeAttribute('src'); _pn.load() }catch{}
  audio.src = pu;
  try{ audio.load() }catch{}
  const pp = audio.play();
  if(pp && typeof pp.catch === 'function') pp.catch(()=>{});
  Player.track = it; Player.isPreview = true;
  pushRecentlyPlayed(it); setQueueFromItem(it, id); syncPlayerUI();
  haptic(14); toast('Preview playing','info');
}
function setQueueFromItem(item, id){
  if(!id) return;
  const ex = Player.queue.findIndex(t => String(t.trackId) === id);
  if(ex >= 0){ Player.queue[ex] = item; Player.index = ex }
  else { Player.queue.push(item); Player.index = Player.queue.length-1 }
}
async function playTrackFromList(id){
  haptic(6);
  const cur = Player.track ? String(Player.track.trackId) : null;
  if(cur === String(id)){ togglePlay(); return }
  if(Array.isArray(_pageTracks) && _pageTracks.length && _pageTracks.some(t => String(t.trackId) === String(id))){
    Player.queue = [..._pageTracks];
    const idx = Player.queue.findIndex(t => String(t.trackId) === String(id));
    Player.index = idx >= 0 ? idx : 0;
    playItem(Player.queue[Player.index]);
    return;
  }
  playById(id);
}
async function playById(id){
  const myGen = ++_playGen;
  haptic(6);
  const c = isCached(id);
  let it = getCached('track', id);
  if(!it && c){ const e = await cacheGet(id).catch(()=>null); if(myGen !== _playGen) return; if(e && e.meta) it = {wrapperType:'track', trackId:id, ...e.meta} }
  if(!it){ try{ const r = await apiLookup(id, 'song'); if(myGen !== _playGen) return; it = r.find(x => itemType(x) === 'track') || r[0]; if(it) cacheItems([it]) }catch{} }
  if(myGen !== _playGen) return;
  if(!it && c) it = {wrapperType:'track', trackId:String(id), trackName:'Cached track', artistName:'', attachments:{}};
  if(!it){ toast('Track not found','danger'); return }
  return playItem(it, 'MusicMan', myGen);
}

async function playCachedById(id, fb, myGen=++_playGen){
  const e = await cacheGet(id);
  if(myGen !== _playGen) return;
  if(!e?.blob){ toast('Not available offline','danger'); return }
  Player.preparing = false;
  const m = e.meta||{}, u = URL.createObjectURL(e.blob);
  audio.pause();
  if(audio.dataset.blobUrl){ try{ URL.revokeObjectURL(audio.dataset.blobUrl) }catch{} }
  try{ _pn.pause(); _pn.removeAttribute('src'); _pn.load() }catch{}
  audio.dataset.blobUrl = u;
  audio.src = u;
  audio.play().catch(()=>{});
  const f = fb && fb.trackId ? fb : {
    wrapperType:'track', trackId:String(id), trackName:m.trackName||m.name||'Cached track',
    artistName:m.artist||m.artistName||'', artistId:m.artistId||'', collectionName:m.collectionName||m.album||'',
    collectionId:m.collectionId||'', primaryGenreName:m.primaryGenreName||'', releaseDate:m.releaseDate||'',
    trackTimeMillis:m.trackTimeMillis||0, lyrics:m.lyrics||null,
    attachments:m.attachments||{artworkUrls:m.artwork?[{url:m.artwork}]:[]}
  };
  Player.track = f; Player.isPreview = false;
  pushRecentlyPlayed(f); setQueueFromItem(f, String(id)); syncPlayerUI();
}
function togglePlay(){
  haptic(6);
  if(Player.preparing) return;                       // ← don't restart the fetch
  if(!audio.src){ if(Player.queue.length) playItem(Player.queue[Math.max(0, Player.index)] || Player.queue[0]); return }
  if(audio.paused) audio.play().catch(()=>{});
  else audio.pause();
}
function nextTrack(userInit=true){
  const q = Player.queue;
  if(!q.length) return;
  if(Player.repeat === 'one' && !userInit){ audio.currentTime = 0; audio.play().catch(()=>{}); return }
  let nx;
  if(Player.shuffle && q.length > 1){ do nx = Math.floor(Math.random()*q.length); while(nx === Player.index) }
  else {
    nx = Player.index + 1;
    if(nx >= q.length){
      if(Player.repeat === 'all') nx = 0;
      else { audio.pause(); audio.currentTime = 0; syncPlayIcons(); return }
    }
  }
  Player.index = nx;
  playItem(q[nx], Player.source);
}
function prevTrack(){
  if(audio.currentTime > 3){ audio.currentTime = 0; return }
  const q = Player.queue;
  if(!q.length) return;
  let pv = Player.index - 1;
  if(pv < 0) pv = Player.repeat === 'all' ? q.length-1 : 0;
  Player.index = pv;
  playItem(q[pv], Player.source);
}

/* ══ RELATED TRACKS + AUTO-EXTEND ════════════════════════════════════════════ */
const _relCache = new Map(), _REL_TTL = 6e5, _REL_MAX = 120;
async function fetchRelatedTracks(track, count=10){
  if(!track || !track.trackId) return [];
  const selfId = String(track.trackId), cacheKey = `${selfId}|${count}`, qSet = new Set();
  for(const t of Player.queue||[]){ const id = String(t?.trackId||''); if(id && id !== selfId) qSet.add(id) }
  const cached = _relCache.get(cacheKey);
  if(cached && cached.exp > Date.now()){
    const fresh = cached.items.filter(t => !qSet.has(String(t.trackId)));
    if(fresh.length >= Math.min(count, cached.items.length)) return fresh.slice(0, count);
  }
  try{
    const exclude = [...qSet].slice(0,80).join(','),
          qs = `id=${encodeURIComponent(selfId)}&count=${count*2}` + (exclude ? `&exclude=${encodeURIComponent(exclude)}` : '');
    const r = await apiCall(`/track/related?${qs}`), d = r.data||{};
    if(r.ok && d.success && Array.isArray(d.results) && d.results.length){
      const items = d.results;
      cacheItems(items);
      if(_relCache.size >= _REL_MAX) _relCache.delete(_relCache.keys().next().value);
      _relCache.set(cacheKey, {items, exp:Date.now()+_REL_TTL});
      return items.filter(t => !qSet.has(String(t.trackId))).slice(0, count);
    }
  }catch{}
  const [albumTracks, artistViews, artistAlbum, popular] = await Promise.all([
    track.collectionId ? apiLookup(track.collectionId, 'song').catch(()=>[]) : Promise.resolve([]),
    track.artistId ? apiArtistTracks(track.artistId, {page:1, limit:60, sort:'views'}).catch(()=>null) : Promise.resolve(null),
    track.artistId ? apiArtistTracks(track.artistId, {page:1, limit:60, sort:'album'}).catch(()=>null) : Promise.resolve(null),
    apiPopular(100).catch(()=>[])
  ]);
  const out = [], seen = new Set([selfId]),
        push = t => {
          if(!t || itemType(t) !== 'track') return false;
          const id = String(t.trackId||'');
          if(!id || seen.has(id)) return false;
          seen.add(id); out.push(t); return true;
        },
        sameAlbumId = track.collectionId ? String(track.collectionId) : '', cap = count*2;
  const albumList = (albumTracks||[]).filter(t => itemType(t) === 'track'),
        albumCap = Math.min(albumList.length, Math.max(2, Math.ceil(count/3)));
  let albumCount = 0;
  for(const t of albumList){ if(albumCount >= albumCap) break; if(push(t)) albumCount++ }
  for(const t of artistViews?.results||[]){ if(out.length >= cap) break; if(sameAlbumId && String(t.collectionId||'') === sameAlbumId) continue; push(t) }
  if(track.artistId) for(const l of getLikes()){
    if(out.length >= cap) break;
    if(String(l.artistId) !== String(track.artistId)) continue;
    push({wrapperType:'track', trackId:String(l.trackId), trackName:l.trackName, artistName:l.artistName, artistId:l.artistId, collectionName:l.collectionName, collectionId:l.collectionId, attachments:{artworkUrls:l.artworkUrl?[{url:l.artworkUrl}]:[]}});
  }
  if(track.artistId) for(const r of getRecentlyPlayed()){
    if(out.length >= cap) break;
    if(String(r.artistId) !== String(track.artistId)) continue;
    push({wrapperType:'track', trackId:String(r.trackId), trackName:r.trackName, artistName:r.artistName, artistId:r.artistId, collectionName:r.collectionName, collectionId:r.collectionId, attachments:{artworkUrls:r.artworkUrl?[{url:r.artworkUrl}]:[]}});
  }
  for(const t of artistAlbum?.results||[]){ if(out.length >= cap) break; if(sameAlbumId && String(t.collectionId||'') === sameAlbumId) continue; push(t) }
  if(track.primaryGenreName) for(const t of popular||[]){ if(out.length >= cap) break; if(itemType(t) !== 'track') continue; if(t.primaryGenreName !== track.primaryGenreName) continue; push(t) }
  for(const t of popular||[]){ if(out.length >= cap) break; push(t) }
  const snapshot = out.slice(0, cap);
  if(_relCache.size >= _REL_MAX) _relCache.delete(_relCache.keys().next().value);
  _relCache.set(cacheKey, {items:snapshot, exp:Date.now()+_REL_TTL});
  return snapshot.filter(t => !qSet.has(String(t.trackId))).slice(0, count);
}
async function autoExtendQueue(){
  if(_extendState.busy) return 0;
  const s = getSettings();
  if(!s.autoExtendQueue) return 0;
  if(_extendState.added >= _extendState.maxPerSession) return 0;
  const cur = Player.track;
  if(!cur || !cur.trackId) return 0;
  _extendState.busy = true;
  try{
    const want = Math.min(10, _extendState.maxPerSession - _extendState.added),
          related = await fetchRelatedTracks(cur, want);
    if(!related.length) return 0;
    let added = 0;
    for(const t of related){ Player.queue.push(t); added++ }
    _extendState.added += added;
    cacheItems(related);
    try{ renderFpTabBody() }catch{}
    try{ updateRightPanel() }catch{}
    try{ persistQueue() }catch{}
    if(added > 0){ haptic(8); toast(`Auto-extended · +${added} related track${added===1?'':'s'}`,'info') }
    return added;
  }catch(e){ console.warn('[autoExtend]', e); return 0 }
  finally{ _extendState.busy = false }
}
function maybeAutoExtend(){
  const s = getSettings();
  if(!s.autoExtendQueue) return;
  if(Player.repeat !== 'off' || Player.shuffle) return;
  const q = Player.queue;
  if(!q.length) return;
  if(Player.index >= q.length-2) autoExtendQueue().catch(()=>{});
}
audio.addEventListener('play', maybeAutoExtend);
async function onTrackEnded(){
  const s = getSettings();
  if(s.autoExtendQueue && Player.repeat === 'off' && !Player.shuffle){
    const q = Player.queue;
    if(Player.index >= q.length-1){
      const added = await autoExtendQueue();
      if(added > 0 && Player.index < Player.queue.length-1){ Player.index++; playItem(Player.queue[Player.index], 'auto-extend'); return }
    }
  }
  nextTrack(false);
}
function toggleShuffle(){
  Player.shuffle = !Player.shuffle;
  toast(Player.shuffle ? 'Shuffle on' : 'Shuffle off');
  if(fpTab === 'now') renderFpTabBody();
  updateRightPanel(); syncPlayerBar();
}
function cycleRepeat(){
  const o = ['off','all','one'];
  Player.repeat = o[(o.indexOf(Player.repeat)+1)%3];
  toast(Player.repeat === 'off' ? 'Repeat off' : Player.repeat === 'all' ? 'Repeat all' : 'Repeat one');
  if(fpTab === 'now') renderFpTabBody();
  updateRightPanel(); syncPlayerBar();
}
function openFullPlayer(tab){
  if(IS_DESKTOP()) return;
  if(!Player.track) return;
  const el = $('#full');
  el.classList.add('show');
  el.setAttribute('aria-hidden','false');
  if(tab && ['now','queue','lyrics'].includes(tab)) setFpTab(tab);
  else renderFpTabBody();
}
function closeFullPlayer(){
  const el = $('#full');
  if(!el || !el.classList.contains('show')) return;
  el.classList.remove('show');
  el.setAttribute('aria-hidden','true');
  el.style.transform = ''; el.style.opacity = '';
}
(function(){
  const fp = document.getElementById('full');
  if(!fp || fp.__ysw) return;
  fp.__ysw = 1;
  let sy = 0, dy = 0, dg = false;
  const reset = () => { fp.style.transition = ''; fp.style.transform = ''; fp.style.opacity = ''; dy = 0 };
  fp.addEventListener('touchstart', e => {
    if(e.touches.length !== 1) return;
    if(e.target.closest('input,textarea,select,button,a,.fp-head')) return;
    const body = fp.querySelector('.fp-tabbody');
    if(body && body.scrollTop > 0) return;
    dg = true; sy = e.touches[0].clientY; dy = 0;
    fp.style.transition = 'none';
  }, {passive:true});
  fp.addEventListener('touchmove', e => {
    if(!dg) return;
    const delta = e.touches[0].clientY - sy;
    if(delta <= 0){ if(dy !== 0){ dy = 0; fp.style.transform = ''; fp.style.opacity = '' } return }
    dy = delta;
    fp.style.transform = `translateY(${dy}px)`;
    fp.style.opacity = String(Math.max(.35, 1 - dy/520));
  }, {passive:true});
  const finish = c => {
    if(!dg) return;
    dg = false;
    const sc = !c && dy > 110;
    reset();
    if(sc) closeFullPlayer();
  };
  fp.addEventListener('touchend', () => finish(false), {passive:true});
  fp.addEventListener('touchcancel', () => finish(true), {passive:true});
})();
function saveQueueAsPlaylist(){
  if(!Player.queue.length){ toast('Queue is empty','warning'); return }
  askText('Save queue as playlist', 'Queue · '+new Date().toLocaleDateString(), 'Playlist name').then(n => {
    if(!n) return;
    const pl = createPlaylist(n);
    if(!pl) return;
    const all = getPlaylists(), p = all.find(x => x.id === pl.id);
    if(!p) return;
    const seen = new Set();
    for(const it of Player.queue){
      const id = String(it.trackId);
      if(!id || seen.has(id)) continue;
      seen.add(id); p.tracks.push(makeLikeEntry(it));
    }
    p.updatedAt = Date.now();
    savePlaylists(all);
    toast(`Saved ${p.tracks.length} tracks`);
    Notify.show('Playlist created', `${p.name} · ${p.tracks.length} tracks`, {category:'playlist'});
  });
}
function moveQueueItem(i, dir){
  const j = i + dir;
  if(j < 0 || j >= Player.queue.length) return;
  const q = Player.queue;
  [q[i], q[j]] = [q[j], q[i]];
  if(Player.index === i) Player.index = j;
  else if(Player.index === j) Player.index = i;
  renderFpTabBody(); updateRightPanel();
}
function shuffleQueue(){
  const q = Player.queue;
  if(q.length < 2) return;
  const c = Player.index >= 0 ? q[Player.index] : null;
  for(let i=q.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [q[i],q[j]] = [q[j],q[i]] }
  if(c) Player.index = q.indexOf(c);
  renderFpTabBody(); updateRightPanel();
  toast('Queue shuffled');
}
function jumpQueue(i){ if(i < 0 || i >= Player.queue.length) return; Player.index = i; playItem(Player.queue[i], Player.source) }
function removeQueue(i){
  if(i < 0 || i >= Player.queue.length) return;
  Player.queue.splice(i, 1);
  if(i < Player.index) Player.index--;
  else if(i === Player.index) Player.index = Math.min(Player.index, Player.queue.length-1);
  renderFpTabBody(); updateRightPanel();
}
function clearQueue(){
  Player.queue = Player.track ? [Player.track] : [];
  Player.index = Player.track ? 0 : -1;
  renderFpTabBody(); updateRightPanel();
  toast('Queue cleared');
}
let _lyricsInflight = new Set();
async function ensureFpLyrics(){
  const t = Player.track; if(!t) return;
  const id = String(t.trackId);
  if(syncedLyricsCache.trackId === id && syncedLyricsCache.lines !== null) return;
  if(_lyricsInflight.has(id)) return;
  _lyricsInflight.add(id);
  try{
    const ft = lyricsFromItem(t);
    if(ft){ syncedLyricsCache = {trackId:id, lines:ft.lines, synced:ft.synced, loading:false}; refreshPlayerLyricsUI(); return }
    if(isCached(id)){
      const e = await cacheGet(id).catch(()=>null);
      if(e && e.meta && e.meta.lyrics){
        const fc = parseLyricsPayload(e.meta.lyrics);
        if(fc && fc.lines.length){ syncedLyricsCache = {trackId:id, lines:fc.lines, synced:fc.synced, loading:false}; refreshPlayerLyricsUI(); return }
      }
    }
    const ci = getCached('track', id);
    if(ci && ci !== t){ const fc = lyricsFromItem(ci); if(fc){ syncedLyricsCache = {trackId:id, lines:fc.lines, synced:fc.synced, loading:false}; refreshPlayerLyricsUI(); return } }
    try{
      const r = await apiLookup(id, 'song'), f = r.find(x => itemType(x) === 'track') || r[0];
      if(f){
        cacheItems([f]);
        if(!Player.track || String(Player.track.trackId) !== id) return;
        Player.track = f;
        const ff = lyricsFromItem(f);
        if(ff){ syncedLyricsCache = {trackId:id, lines:ff.lines, synced:ff.synced, loading:false}; refreshPlayerLyricsUI(); return }
      }
    }catch{}
    syncedLyricsCache = {trackId:id, lines:[], synced:false, loading:false};
    refreshPlayerLyricsUI();
  } finally { _lyricsInflight.delete(id) }
}
function refreshPlayerLyricsUI(){
  if(fpTab === 'lyrics' && !IS_DESKTOP()) renderFpTabBody();
  if(IS_DESKTOP() && rpMode === 'lyrics') updateRightPanel();
}
async function saveCurrentTrack(){
  Notify.request();
  const t = Player.track;
  if(!t?.trackId){ toast('Nothing playing','warning'); return }
  const id = String(t.trackId);
  if(isCached(id)){ await exportCached(id); return }
  const dl = DL.get(id);
  if(dl && ['queued','crawling','saving'].includes(dl.status)){ toast('Already in progress','warning'); return }
  if(dl && dl.status === 'ready'){ DL.retry(id); return }
  const f = getCached('track', id) || t;
  await startCrawlInternal(id, null, f);
  syncSaveButton();
}
function toggleLikeCurrent(){ if(Player.track?.trackId) toggleLike(Player.track) }
async function playIds(csv){
  const ids = String(csv||'').split(',').map(s => s.trim()).filter(Boolean);
  if(!ids.length){ toast('Nothing to play'); return }
  toast('Loading…');
  const items = [];
  for(const id of ids){
    let it = getCached('track', id);
    if(!it){ try{ const r = await apiLookup(id, 'song'); it = r.find(x => itemType(x) === 'track') || r[0]; if(it) cacheItems([it]) }catch{} }
    if(!it && isCached(id)) it = {wrapperType:'track', trackId:String(id), trackName:'Cached track', artistName:'', attachments:{}};
    if(it) items.push(it);
  }
  if(!items.length){ toast('Could not load tracks','danger'); return }
  Player.queue = items; Player.index = 0; _extendState.added = 0;
  renderFpTabBody(); updateRightPanel();
  playItem(items[0], Player.source);
}
function addAllToQueue(items){
  const l = (items||[]).filter(it => it && it.trackId);
  if(!l.length){ toast('Nothing to add','warning'); return }
  let ad = 0;
  const ex = new Set(Player.queue.map(q => String(q.trackId)));
  for(const it of l){
    const id = String(it.trackId);
    if(ex.has(id)) continue;
    Player.queue.push(it); ex.add(id); ad++;
  }
  if(Player.index < 0 && Player.queue.length) Player.index = 0;
  renderFpTabBody(); updateRightPanel();
  haptic(8);
  toast(ad ? `Added ${ad} track${ad===1?'':'s'} to queue` : 'Already in queue', ad ? 'success' : 'warning');
}
function toggleLikeAll(items){
  if(!MMAuth.user){
    toastAction('Sign in to like tracks', [{html:'<i class="bi bi-box-arrow-in-right"></i> Sign in', class:'primary', fn:()=>openAuth()}], 'warning', 6e3);
    return;
  }
  const l = (items||[]).filter(it => it && it.trackId);
  if(!l.length){ toast('Nothing to like','warning'); return }
  const likes = getLikes(),
        ids = new Set(l.map(it => String(it.trackId))),
        all = l.every(it => likes.some(x => String(x.trackId) === String(it.trackId)));
  if(all){ const n = likes.filter(x => !ids.has(String(x.trackId))); ls.set(KEY.likes, n); toast(`Removed ${l.length} from Liked`) }
  else {
    const ex = new Set(likes.map(x => String(x.trackId)));
    let ad = 0;
    for(const it of l){ const id = String(it.trackId); if(ex.has(id)) continue; likes.unshift(makeLikeEntry(it)); ex.add(id); ad++ }
    ls.set(KEY.likes, likes);
    toast(ad ? `Liked ${ad} track${ad===1?'':'s'}` : 'Already liked');
  }
  haptic(12);
  reindexActionButtons(); refreshLikes();
  refreshPage();
  _recoHomeDirty = true;
  if(currentPath() === '/') refreshHomeRecommendations();
}
async function refreshPage(){
  const y = MAIN().scrollTop;
  try{ await route() }catch{}
  MAIN().scrollTop = y;
}

/* ══ TRACK MENU ══════════════════════════════════════════════════════════════ */
const menuCtx = {trackId:null, playlistId:null};
async function openTrackMenu(tid, pid){
  if(!tid) return;
  menuCtx.trackId = String(tid);
  menuCtx.playlistId = pid || null;
  menuCtx.item = null;
  let it = getCached('track', tid);
  if(!it){ try{ const r = await apiLookup(tid, 'song'); it = r.find(x => itemType(x) === 'track') || r[0]; if(it) cacheItems([it]) }catch{} }
  if(!it){ toast('Track not available','danger'); return }
  menuCtx.item = it;
  const id = String(tid), liked = isLiked(id), cached = isCached(id), dl = DL.get(id),
        art = getArtwork(it, 100), action = dlActionFor(it),
        previewable = hasPreview(it), playable = hasAudio(it) || cached, rows = [];
  if(playable) rows.push(`<button class="sheet-item" onclick="menuAction('play')"><i class="bi bi-play-fill text-success"></i><span>Play</span></button>`);
  if(previewable) rows.push(`<button class="sheet-item" onclick="menuAction('playPreview')"><i class="bi bi-play-circle" style="color:#ffa600"></i><span>Play preview</span></button>`);
  if(dl && ['queued','crawling','saving'].includes(dl.status)){
    rows.push(`<button class="sheet-item" onclick="menuAction('openDl')"><i class="bi ${action.icon} text-info"></i><span>View ${action.isDirect?'download':'crawl'} progress</span></button>`);
    rows.push(`<button class="sheet-item danger" onclick="menuAction('cancelDl')"><i class="bi bi-x-circle"></i><span>Cancel ${action.isDirect?'download':'crawl'}</span></button>`);
  }
  else if(dl && dl.status === 'ready') rows.push(`<button class="sheet-item" onclick="menuAction('saveReady')"><i class="bi bi-cloud-download text-warning"></i><span>Download now</span></button>`);
  else if(cached){
    rows.push(`<button class="sheet-item" onclick="menuAction('export')"><i class="bi bi-file-earmark-arrow-down text-primary"></i><span>Save as file</span></button>`);
    rows.push(`<button class="sheet-item danger" onclick="menuAction('uncache')"><i class="bi bi-trash3"></i><span>Remove offline copy</span></button>`);
  }
  else rows.push(`<button class="sheet-item" onclick="menuAction('download')"><i class="bi ${action.icon} text-primary"></i><span>${action.label}</span></button>`);
  if(!hasBaleAudio(it) && (hasAudio(it) || cached) && !(dl && ['queued','crawling','saving'].includes(dl.status))){
    rows.push(`<button class="sheet-item info" onclick="menuAction('crawl')"><i class="bi bi-cloud-arrow-down"></i><span>Crawl for Bale mirror</span></button>`);
  }
  rows.push(`<button class="sheet-item telegram" onclick="menuAction('telegram')"><i class="bi bi-telegram"></i><span>Open in Telegram bot</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('next')"><i class="bi bi-skip-end-fill"></i><span>Play next</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('queue')"><i class="bi bi-list-ul"></i><span>Add to queue</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('like')"><i class="bi ${liked?'bi-heart-fill text-danger':'bi-heart'}"></i><span>${liked?'Remove from Liked':'Add to Liked'}</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('note')"><i class="bi bi-journal-text"></i><span>${getNote(id)?'Edit note':'Add note'}</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('playlist')"><i class="bi bi-plus-circle"></i><span>Add to playlist</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('share')"><i class="bi bi-share"></i><span>Share with…</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('copyLink')"><i class="bi bi-link-45deg"></i><span>Copy link</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('shareTs')"><i class="bi bi-clock-history"></i><span>Share with timestamp</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('details')"><i class="bi bi-info-circle"></i><span>Track details</span></button>`);
  if(it.collectionId) rows.push(`<button class="sheet-item" onclick="menuAction('album')"><i class="bi bi-disc"></i><span>Go to album</span></button>`);
  if(it.artistId) rows.push(`<button class="sheet-item" onclick="menuAction('artist')"><i class="bi bi-person"></i><span>Go to artist</span></button>`);
  rows.push(`<button class="sheet-item" onclick="menuAction('radio')"><i class="bi bi-broadcast text-primary"></i><span>Track radio</span></button>`);
  if(it.artistId) rows.push(`<button class="sheet-item" onclick="menuAction('artistRadio')"><i class="bi bi-person-lines-fill text-info"></i><span>Artist radio</span></button>`);
  if(menuCtx.playlistId) rows.push(`<button class="sheet-item danger" onclick="menuAction('removeFromPl')"><i class="bi bi-x-circle"></i><span>Remove from playlist</span></button>`);
  $('#sheetTrackBody').innerHTML = `<div class="d-flex align-items-center gap-3 px-3 pb-3 pt-1">${art ? `<img src="${esc(art)}" width="52" height="52" class="row-art" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="min-w-0"><div class="fw-bold text-truncate">${esc(it.trackName||'Track')}</div><div class="row-sub text-truncate">${esc(it.artistName||'')}</div></div></div><div class="px-2">${rows.join('')}</div>`;
  sheet('#sheetTrack').show();
}
async function menuAction(action){
  const id = menuCtx.trackId, plId = menuCtx.playlistId;
  let it = menuCtx.item || getCached('track', id);
  const snap = it ? {...it} : null;
  sheet('#sheetTrack').hide();
  if(!id) return;
  if(action === 'share'){
    const url = location.origin + (BASE||'') + '/track/' + id,
          title = snap && snap.trackName || 'Track',
          text = snap ? `${title}${snap.artistName ? ' — '+snap.artistName : ''}` : title;
    await shareUrl({title, text, url});
    return;
  }
  if(action === 'shareTs'){
    const isCur = Player.track && String(Player.track.trackId) === String(id),
          t = isCur ? Math.floor(audio.currentTime) : 0,
          url = location.origin + (BASE||'') + '/track/' + id + (t ? `?t=${t}` : ''),
          title = snap && snap.trackName || 'Track',
          text = `${title}${snap && snap.artistName ? ' — '+snap.artistName : ''}${t ? ' @ '+fmtTime(t) : ''}`;
    await shareUrl({title, text, url});
    return;
  }
  if(!it){ try{ const r = await apiLookup(id, 'song'); it = r.find(x => itemType(x) === 'track') || r[0]; if(it) cacheItems([it]) }catch{} }
  switch(action){
    case 'details': closeFullPlayer(); go('/track/'+id); break;
    case 'play': playById(id); break;
    case 'playPreview': playPreviewById(id); break;
    case 'telegram': tgStart('track', id); break;
    case 'next': if(it){ Player.queue.splice(Player.index+1, 0, it); toast('Playing next'); renderFpTabBody(); updateRightPanel() } break;
    case 'queue': if(it){ if(Player.queue.some(t => String(t.trackId) === id)){ toast('Already in queue','warning'); return } Player.queue.push(it); if(Player.index < 0) Player.index = 0; toast('Added to queue'); renderFpTabBody(); updateRightPanel() } break;
    case 'copyLink': copyText(location.origin + (BASE||'') + '/track/' + id); break;
    case 'like': toggleLikeById(id); break;
    case 'note': closeFullPlayer(); editNote(id); break;
    case 'playlist': openPlaylistPicker(id); break;
    case 'download': if(it) await startCrawlInternal(id, null, it); break;
    case 'crawl': if(it) await startCrawlInternal(id, null, it, true); break;
    case 'saveReady': DL.retry(id); break;
    case 'export': await exportCached(id); break;
    case 'uncache': await removeCached(id); break;
    case 'openDl': closeFullPlayer(); go('/library/downloads'); break;
    case 'cancelDl': DL.remove(id); toast('Cancelled'); break;
    case 'album': if(it?.collectionId){ closeFullPlayer(); go('/album/'+it.collectionId) } break;
    case 'artist': if(it?.artistId){ closeFullPlayer(); go('/artist/'+it.artistId) } break;
    case 'radio': closeFullPlayer(); trackRadio(id); break;
    case 'artistRadio': if(it?.artistId){ closeFullPlayer(); artistRadio(it.artistId) } break;
    case 'removeFromPl': if(plId){ removeFromPlaylist(plId, id); toast('Removed') } break;
  }
}
function fpMoreMenu(){ if(IS_DESKTOP()) return; if(!Player.track?.trackId) return; openTrackMenu(Player.track.trackId) }
async function shareTrack(id, it){
  const url = location.origin + (BASE||'') + '/track/' + id,
        title = it?.trackName||'Track',
        text = `${title}${it?.artistName ? ' — '+it.artistName : ''}`;
  if(await shareUrl({title, text, url})) toast('Shared');
}
async function shareWithTimestamp(id, it){
  const isCur = Player.track && String(Player.track.trackId) === String(id),
        t = isCur ? Math.floor(audio.currentTime) : 0,
        url = location.origin + (BASE||'') + '/track/' + id + (t ? `?t=${t}` : ''),
        title = it?.trackName||'Track',
        text = `${title}${it?.artistName ? ' — '+it.artistName : ''}${t ? ' @ '+fmtTime(t) : ''}`;
  if(await shareUrl({title, text, url})) toast('Shared');
}

/* ══ PLAYLIST PICKER ═════════════════════════════════════════════════════════ */
let pickerItems = [];
function openPlaylistPicker(tid){
  const id = String(tid), c = getCached('track', id);
  if(c) return openPlaylistPickerForItems([c]);
  (async () => {
    try{ const r = await apiLookup(id, 'song'), it = r.find(x => itemType(x) === 'track') || r[0]; if(it){ cacheItems([it]); openPlaylistPickerForItems([it]) } else toast('Track not available','danger') }catch{ toast('Track not available','danger') }
  })();
}
function openPlaylistPickerForItems(items){
  pickerItems = (items||[]).filter(it => it && it.trackId);
  if(!pickerItems.length) return;
  const t = $('#sheetPlTitle');
  if(t) t.textContent = pickerItems.length > 1 ? `Add ${pickerItems.length} tracks to playlist` : 'Add to playlist';
  const pls = getPlaylists(), b = $('#sheetPlBody');
  if(!pls.length) b.innerHTML = `<div class="state mm-empty" style="padding:30px 20px"><i class="bi bi-music-note-list"></i><p>No playlists yet</p></div>`;
  else b.innerHTML = pls.map(p => {
    const c = p.tracks.find(t => t.artworkUrl)?.artworkUrl || '',
          badge = p.isPublic ? '<span class="badge-chip public"><i class="bi bi-globe"></i>Public</span>' : '<span class="badge-chip private"><i class="bi bi-lock"></i>Private</span>';
    return `<button class="sheet-item" onclick="pickPlaylist('${esc(p.id)}')">${c ? `<img src="${esc(c)}" width="42" height="42" class="row-art" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note-list"></i></div>`}<span class="flex-grow-1 min-w-0"><span class="d-block text-truncate fw-semibold">${esc(p.name)}</span><span class="sub">${p.tracks.length} track${p.tracks.length!==1?'s':''} · ${p.isPublic?'Public':'Private'}</span></span><i class="bi bi-plus-lg text-primary"></i></button>`;
  }).join('');
  sheet('#sheetPl').show();
}
async function pickPlaylist(pid){
  if(!pickerItems.length) return;
  const all = getPlaylists(), pl = all.find(p => p.id === pid);
  if(!pl) return;
  let ad = 0;
  const ex = new Set(pl.tracks.map(t => String(t.trackId)));
  for(const it of pickerItems){ const id = String(it.trackId); if(ex.has(id)) continue; pl.tracks.push(makeLikeEntry(it)); ex.add(id); ad++ }
  pl.updatedAt = Date.now();
  savePlaylists(all);
  sheet('#sheetPl').hide();
  haptic(10);
  toast(ad ? `Added ${ad} track${ad===1?'':'s'} to "${pl.name}"` : 'Already in playlist', ad ? 'success' : 'warning');
  if(pl.isPublic) syncPlaylistToServer(pid).catch(()=>{});
  pickerItems = [];
}
async function newPlaylistPrompt(){
  const plEl = $('#sheetPl'), fromPicker = plEl && plEl.classList.contains('show'),
        toAdd = fromPicker ? pickerItems.slice() : [];
  pickerItems = [];
  sheet('#sheetPl').hide();
  const n = await askText('New playlist', '', 'Playlist name');
  if(!n) return;
  const pl = createPlaylist(n);
  if(!pl) return;
  if(toAdd.length){
    const all = getPlaylists(), p = all.find(x => x.id === pl.id);
    if(p){
      const ex = new Set(p.tracks.map(t => String(t.trackId)));
      for(const it of toAdd){ const id = String(it.trackId); if(ex.has(id)) continue; p.tracks.push(makeLikeEntry(it)); ex.add(id) }
      p.updatedAt = Date.now();
      savePlaylists(all);
    }
  }
  if(currentPath().startsWith('/library/playlists')) go('/library/playlists/'+pl.id);
}

/* ══ CRAWL ═══════════════════════════════════════════════════════════════════ */
async function startCrawl(tid, btn, forceCrawl=false){
  Notify.request();
  const id = String(tid), it0 = getCached('track', id),
        action = it0 ? dlActionFor(it0) : {icon:'bi-cloud-arrow-down', label:'Crawl'};
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm" style="width:14px;height:14px;border-width:2px"></span>' }
  try{
    let it = it0;
    if(!it){ try{ const r = await apiLookup(tid, 'song'); it = r.find(x => itemType(x) === 'track') || r[0]; if(it) cacheItems([it]) }catch{} }
    if(!it){ toast('Track unavailable','danger'); return }
    await DL.add(it, undefined, undefined, forceCrawl);
    haptic(12);
    if(currentPath() === `/track/${tid}`){
      renderTrackPage(it);
      const st = await apiCrawlStatus(tid);
      renderCrawlCard(it, st);
      startTrackPoller(tid);
    }
  }catch(e){ toast(action.label+' failed: '+e.message,'danger') }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = forceCrawl ? '<i class="bi bi-cloud-arrow-down"></i> Crawl' : `<i class="bi ${action.icon}"></i> ${action.label}` } }
}
async function startCrawlInternal(tid, btn, known, forceCrawl=false){
  Notify.request();
  const it0 = known || getCached('track', tid),
        action = it0 ? dlActionFor(it0) : {icon:'bi-cloud-arrow-down', label:'Crawl'};
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm" style="width:14px;height:14px;border-width:2px"></span>' }
  try{ let it = it0 || await DL._fetchTrack(tid); if(!it){ toast('Track unavailable','danger'); return } await DL.add(it, undefined, undefined, forceCrawl) }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = forceCrawl ? '<i class="bi bi-cloud-arrow-down"></i> Crawl' : `<i class="bi ${action.icon}"></i> ${action.label}` } }
}
async function fetchAllArtistTracks(aid, onProgress){
  if(!aid) return [];
  const all = [], seen = new Set(),
        push = t => { const id = String(t?.trackId||''); if(!id || seen.has(id)) return; seen.add(id); all.push(t) };
  try{ const r = await apiLookup(aid, 'song'); r.filter(x => itemType(x) === 'track').forEach(push) }catch{}
  if(all.length === 0 || all.length < 30){
    const limit = 200;
    let page = 1, guard = 0;
    while(guard++ < 50){
      let res;
      try{ res = await apiArtistTracks(aid, {page, limit, sort:'album'}) }catch{ break }
      const tr = (res.results||[]).filter(t => itemType(t) === 'track');
      tr.forEach(push);
      if(onProgress) try{ onProgress(all.length) }catch{}
      if(!res.hasMore || tr.length < limit) break;
      page++;
    }
  }
  cacheItems(all);
  return all;
}
async function crawlAll(type, id, btn, forceSave=false){
  Notify.request();
  const orig = btn?.innerHTML;
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" style="width:14px;height:14px;border-width:2px"></span>Fetching…' }
  try{
    if(type === 'track'){ await apiQueueAdd({trackId:cleanId(id)}); toast('Queued'); haptic(12); return }
    if(type === 'collection' || type === 'album'){
      let album = getCached('collection', id);
      if(!album){ const r = await apiLookup(id, 'album'); album = r.find(x => itemType(x) === 'collection') || r[0]; if(album) cacheItems([album]) }
      const tracks = (await apiLookup(id, 'song')).filter(x => itemType(x) === 'track');
      cacheItems(tracks);
      const need = tracks.filter(t => !isCached(t.trackId));
      if(!need.length){ toast('All tracks already saved','success'); return }
      await DL.addBatch({subType:'album', sourceId:String(id), name:album?.collectionName||'Album', artist:album?.artistName||'', artwork:getArtwork(album, 100), tracks:need, forceSave});
      try{ await apiQueueAdd({albumId:cleanId(id)}) }catch{}
      toast(`${forceSave ? 'Downloading' : 'Crawling'} ${need.length} track${need.length!==1?'s':''}…`);
      Notify.show(`${forceSave?'Download':'Crawl'} started`, album?.collectionName||'Album', {category:'crawl'});
      haptic(12);
      if(currentPath() === `/album/${id}`) refreshPage();
      return;
    }
    if(type === 'artist'){
      const artist = getCached('artist', id), artistName = artist?.artistName || 'Artist',
            allTracks = await fetchAllArtistTracks(id, n => { if(btn) btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" style="width:14px;height:14px;border-width:2px"></span>${n} tracks…` });
      if(!allTracks.length){ toast('No tracks found for this artist','warning'); return }
      const need = allTracks.filter(t => !isCached(t.trackId));
      if(!need.length){ toast(`All ${allTracks.length} tracks already saved`,'success'); return }
      if(btn) btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" style="width:14px;height:14px;border-width:2px"></span>Queuing ${need.length}…`;
      await DL.addBatch({subType:'artist', sourceId:String(id), name:artistName, artist:'', artwork:getArtwork(artist, 100), tracks:need, forceSave});
      try{ await apiQueueAdd({artistId:cleanId(id)}) }catch{}
      toast(`${forceSave ? 'Downloading' : 'Crawling'} ${need.length} of ${allTracks.length} track${allTracks.length!==1?'s':''}…`);
      Notify.show(`${forceSave?'Download':'Crawl'} started`, `${artistName} · ${need.length} tracks`, {category:'crawl'});
      haptic(12);
      if(isLibDl()) updateDlLists();
    }
  }catch(e){ toast('Crawl failed: '+(e.message||e),'danger') }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = orig } }
}
async function removeCached(id){ await cacheDel(id); cachedIds.delete(String(id)); toast('Removed from offline'); refreshCurrentView() }
async function clearAllCache(){
  const ok = await askConfirm('Clear offline cache?', 'All downloaded tracks will be deleted.', 'Clear all');
  if(!ok) return;
  await cacheClear();
  cachedIds.clear();
  toast('Offline cache cleared');
  Notify.show('Offline cache cleared','',{category:'download'});
  updateSettingsSheet();
  if(isLibDl()) updateDlLists();
  if(isTrackRoute()){ const t = getCached('track', currentPath().split('/')[2]); if(t) renderCrawlCard(t, null) }
}
function refreshCurrentView(){ if(isLibDl()) updateDlLists(); else route() }
function scrollActiveLibTab(){
  requestAnimationFrame(() => {
    const on = document.querySelector('.lib-tabs .lt.on'); if(!on) return;
    const p = on.parentElement; if(!p) return;
    const t = on.offsetLeft - (p.clientWidth - on.offsetWidth)/2;
    p.scrollLeft = Math.max(0, t);
  });
}

/* ══ LIBRARY VIEWS ═══════════════════════════════════════════════════════════ */
function libraryTabs(a){
  const adl = DL.active().length + DL.ready().length + DL.activeBatches().length + DL.readyBatches().length,
        fol = getFollowed().length, lik = getLikes().length, pls = getPlaylists().length,
        it = (k,l,ic,b) => {
          const on = a === k ? ' on' : '', href = `${SCOPE}library/${k}`,
                bd = b !== undefined && b > 0 ? `<span class="lt-badge">${b}</span>` : '';
          return `<a href="${href}" data-link class="lt${on}"><i class="bi bi-${ic}"></i><span>${l}</span>${bd}</a>`;
        };
  return `<div class="lib-tabs">${it('likes','Liked','heart-fill',lik)+it('following','Following','people-fill',fol)+it('playlists','Lists','music-note-list',pls)+it('downloads','Offline','cloud-check-fill',adl)+it('stats','Stats','bar-chart-fill',null)+it('history','History','clock-history')}</div>`;
}
function likesToItems(){
  return getLikes().map(l => ({
    wrapperType:'track', trackId:l.trackId, trackName:l.trackName, artistName:l.artistName, artistId:l.artistId,
    collectionName:l.collectionName, collectionId:l.collectionId,
    attachments:{artworkUrls:l.artworkUrl?[{url:l.artworkUrl}]:[], audioUrls:isCached(l.trackId)?[{url:'local', quality:'320'}]:[]}
  }));
}
function viewLikes(){
  const likes = getLikes();
  let html = libraryTabs('likes');
  if(!likes.length) html += emptyState('heart','No liked songs yet','Tap the heart on any track to save it here.');
  else {
    const items = likesToItems();
    _pageTracks = items;
    const ids = items.map(x => x.trackId).join(','), firstId = items[0] ? String(items[0].trackId) : '';
    html += `<div class="d-flex align-items-center px-3 pt-4 pb-3"><div class="flex-grow-1 fw-bold">${likes.length} liked song${likes.length!==1?'s':''}</div><button class="pill-btn success" data-play-id="${esc(firstId)}" onclick="playIds('${esc(ids)}')"><i class="bi bi-play-fill"></i> Play all</button></div>`;
    html += items.map(t => trackRow(t)).join('');
  }
  MAIN().innerHTML = html;
  reindexActionButtons();
}
function viewFollowing(){
  _pageTracks = [];
  const l = getFollowed();
  let html = libraryTabs('following');
  if(!l.length) html += emptyState('person-check','Not following any artists','Follow artists to see them here.');
  else {
    html += `<div class="px-3 pt-4 pb-2"><div class="fw-bold">${l.length} artist${l.length!==1?'s':''}</div><div class="text-secondary" style="font-size:.74rem">Artists you follow</div></div><div class="mm-grid mm-grid-narrow">`;
    html += l.map(a => { const art = a.artwork||''; return `<a class="artist-item" href="${SCOPE}artist/${esc(a.artistId)}" data-link>${art ? `<img class="artist-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="artist-art artist-art-ph"><i class="bi bi-person-fill"></i></div>`}<div class="card-name text-truncate">${esc(a.artistName||'Artist')}</div><div class="card-sub text-truncate">${esc(a.primaryGenreName||'Artist')}</div></a>` }).join('');
    html += `</div>`;
  }
  MAIN().innerHTML = html;
  reindexActionButtons();
}
function getSmartPlaylists(){
  const s = getStats(), tracks = s.tracks||{}, likes = getLikes(),
        most = Object.entries(tracks).map(([id,v]) => ({id, ...v})).sort((a,b) => (b.ms||0)-(a.ms||0)),
        now = Date.now(),
        forgot = likes.filter(l => { const st = tracks[String(l.trackId)]; return !st || now-(st.lastAt||0) > 30*864e5 }),
        totalInLib = new Set([...Object.keys(tracks), ...likes.map(l => String(l.trackId))]).size,
        out = [];
  if(totalInLib > 0) out.push({key:'shuffle', name:'Shuffle All', count:totalInLib, icon:'shuffle', color:'primary', onclick:'playSmartShuffle()'});
  if(most.length > 0) out.push({key:'most', name:'Most Played', count:most.length, icon:'fire', color:'danger'});
  if(likes.length > 0) out.push({key:'recent', name:'Recently Added', count:likes.length, icon:'clock', color:'info'});
  if(forgot.length > 0) out.push({key:'forgot', name:'Forgotten Favorites', count:forgot.length, icon:'arrow-counterclockwise', color:'warning'});
  return out;
}
function smartRowHtml(sp){
  const attrs = sp.onclick ? `onclick="${sp.onclick}"` : `onclick="smartOpen('${sp.key}')"`,
        art = sp.art ? `<img class="row-art" src="${esc(sp.art)}" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph" style="background:rgba(var(--bs-${sp.color}-rgb),.18);color:var(--bs-${sp.color})"><i class="bi bi-${sp.icon}"></i></div>`;
  return `<div class="row-item" ${attrs} style="cursor:pointer">${art}<div class="row-info"><div class="min-w-0 flex-grow-1"><div class="row-title text-truncate">${esc(sp.name)}</div><div class="row-sub text-truncate">${sp.count} track${sp.count!==1?'s':''}</div></div><i class="bi bi-chevron-right text-secondary"></i></div></div>`;
}
function viewPlaylists(){
  _pageTracks = [];
  const pls = getPlaylists(), smart = getSmartPlaylists();
  let html = libraryTabs('playlists');
  if(smart.length){ html += `<h6 class="sec-title tight">Smart playlists</h6>`; html += smart.map(smartRowHtml).join('') }
  html += `<div class="d-flex align-items-center px-3 pt-4 pb-2"><div class="flex-grow-1 fw-bold">Your playlists</div><button class="pill-btn primary" onclick="newPlaylistPrompt()"><i class="bi bi-plus-lg"></i> New</button></div>`;
  if(!pls.length) html += emptyState('music-note-list','No playlists yet','Create one to organize your music.');
  else html += pls.map(pl => {
    const c = pl.tracks.find(t => t.artworkUrl)?.artworkUrl || '',
          badge = pl.isPublic ? '<span class="badge-chip public"><i class="bi bi-globe"></i>Public</span>' : '<span class="badge-chip private"><i class="bi bi-lock"></i>Private</span>';
    return `<a class="row-item" href="${SCOPE}library/playlists/${esc(pl.id)}" data-link>${c ? `<img class="row-art" src="${esc(c)}" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note-list"></i></div>`}<div class="row-info"><div class="min-w-0 flex-grow-1"><div class="row-title text-truncate">${esc(pl.name)} ${badge}</div><div class="row-sub text-truncate">${pl.tracks.length} track${pl.tracks.length!==1?'s':''}</div></div><i class="bi bi-chevron-right text-secondary"></i></div></a>`;
  }).join('');
  MAIN().innerHTML = html;
  reindexActionButtons();
}
function renderPlaylistDetail(pid){
  const pl = getPlaylists().find(p => p.id === pid);
  if(!pl){ MAIN().innerHTML = emptyState('music-note-list','Playlist not found'); return }
  setPageTitle(pl.name);
  const items = playlistToItems(pid);
  _pageTracks = items;
  const ids = items.map(x => String(x.trackId)).join(','), firstId = items[0] ? String(items[0].trackId) : '',
        badge = pl.isPublic ? '<span class="badge-chip public" style="vertical-align:middle"><i class="bi bi-globe"></i>Public</span>' : '<span class="badge-chip private" style="vertical-align:middle"><i class="bi bi-lock"></i>Private</span>';
  let html = `<div class="pb-4">${backBtn()}<div class="px-3 pt-1"><div class="d-flex align-items-center gap-2"><div style="font-size:1.35rem;font-weight:800;letter-spacing:-.02em" class="text-truncate flex-grow-1">${esc(pl.name)}</div>${badge}</div><div class="text-secondary" style="font-size:.8rem">${pl.tracks.length} track${pl.tracks.length!==1?'s':''}${pl.createdAt?` · ${fmtAgo(pl.createdAt)}`:''}</div></div>`;
  html += `<div class="lib-tabs">${items.length?`<button class="pill-btn success" data-play-id="${esc(firstId)}" onclick="playIds('${esc(ids)}')"><i class="bi bi-play-fill"></i> Play</button>`:''}${items.length?`<button class="pill-btn" onclick="addAllToQueue(playlistToItems('${esc(pid)}'))"><i class="bi bi-list-ul"></i> Queue</button>`:''}${pl.isPublic?`<button class="pill-btn" onclick="sharePlaylist('${esc(pid)}')"><i class="bi bi-share"></i> Share</button>`:''}<button class="icon-btn" style="background:rgba(var(--bs-body-color-rgb),.09)" onclick="playlistMore('${esc(pid)}')"><i class="bi bi-three-dots"></i></button></div>`;
  html += items.length ? items.map(t => trackRow(t, {playlistId:pid})).join('') : emptyState('music-note','This playlist is empty','Add songs from the ⋮ menu.');
  html += `</div>`;
  MAIN().innerHTML = html;
  reindexActionButtons();
}
function playlistMore(pid){
  const pl = getPlaylists().find(p => p.id === pid);
  if(!pl) return;
  const isPublic = !!pl.isPublic,
        r = [
          `<button class="sheet-item" onclick="closeAllSheets(); renamePlaylist('${esc(pid)}')"><i class="bi bi-pencil"></i><span>Rename playlist</span></button>`,
          `<button class="sheet-item" onclick="closeAllSheets(); togglePlaylistPublic('${esc(pid)}')"><i class="bi bi-${isPublic?'lock':'globe'}"></i><span>Make ${isPublic?'private':'public'}</span></button>`,
          isPublic ? `<button class="sheet-item" onclick="closeAllSheets(); editPlaylistMeta('${esc(pid)}')"><i class="bi bi-info-circle"></i><span>Edit description & cover</span></button>` : '',
          isPublic ? `<button class="sheet-item" onclick="closeAllSheets(); sharePlaylist('${esc(pid)}')"><i class="bi bi-share"></i><span>Share link</span></button>` : '',
          isPublic ? `<button class="sheet-item" onclick="closeAllSheets(); copyPlaylistLink('${esc(pid)}')"><i class="bi bi-link-45deg"></i><span>Copy public link</span></button>` : '',
          `<button class="sheet-item danger" onclick="closeAllSheets(); deletePlaylist('${esc(pid)}')"><i class="bi bi-trash3"></i><span>Delete playlist</span></button>`
        ].filter(Boolean);
  $('#sheetTrackBody').innerHTML = `<div class="px-3 pb-2 pt-1"><div class="fw-bold">Playlist actions</div></div><div class="px-2">${r.join('')}</div>`;
  sheet('#sheetTrack').show();
}
function playlistToItems(pid){
  const pl = getPlaylists().find(p => p.id === pid);
  if(!pl) return [];
  return pl.tracks.map(l => ({
    wrapperType:'track', trackId:l.trackId, trackName:l.trackName, artistName:l.artistName, artistId:l.artistId,
    collectionName:l.collectionName, collectionId:l.collectionId,
    attachments:{artworkUrls:l.artworkUrl?[{url:l.artworkUrl}]:[], audioUrls:isCached(l.trackId)?[{url:'local', quality:'320'}]:[]}
  }));
}
async function renamePlaylist(id){
  const pl = getPlaylists().find(p => p.id === id);
  if(!pl) return;
  const n = await askText('Rename playlist', pl.name, 'Playlist name');
  if(!n) return;
  const all = getPlaylists(), t = all.find(p => p.id === id);
  if(!t) return;
  t.name = n; t.updatedAt = Date.now();
  savePlaylists(all);
  if(t.isPublic) syncPlaylistToServer(id).catch(()=>{});
  if(isPlDet(id)) renderPlaylistDetail(id); else viewPlaylists();
  toast('Renamed');
}
async function deletePlaylist(id){
  const pl = getPlaylists().find(p => p.id === id);
  if(!pl) return;
  const ok = await askConfirm('Delete playlist?', `"${pl.name}" and its contents will be removed.`, 'Delete');
  if(!ok) return;
  if(pl.isPublic){ try{ await apiCall('/pl/delete', {method:'POST', body:JSON.stringify({id})}) }catch{} }
  savePlaylists(getPlaylists().filter(p => p.id !== id));
  toast('Playlist deleted');
  Notify.show('Playlist deleted', pl.name, {category:'playlist'});
  go('/library/playlists');
}
async function editPlaylistMeta(id){
  const pl = getPlaylists().find(p => p.id === id);
  if(!pl) return;
  const d = await askText('Description', pl.description||'', 'Short description (optional)');
  if(d === null) return;
  const c = await askText('Cover image URL', pl.cover||'', 'https://…');
  if(c === null) return;
  const all = getPlaylists(), t = all.find(p => p.id === id);
  if(!t) return;
  t.description = (d||'').slice(0,500);
  t.cover = (c||'').slice(0,500);
  t.updatedAt = Date.now();
  savePlaylists(all);
  if(t.isPublic) await syncPlaylistToServer(id).catch(()=>{});
  if(isPlDet(id)) renderPlaylistDetail(id);
  toast('Updated');
}
function togglePlaylistPublic(pid){
  const pl = getPlaylists().find(p => p.id === pid);
  if(!pl) return;
  if(!MMAuth.user){
    toastAction('Sign in to make playlists public', [{html:'<i class="bi bi-box-arrow-in-right"></i> Sign in', class:'primary', fn:()=>openAuth()}], 'warning', 6500);
    return;
  }
  if(pl.isPublic) unpublishPlaylist(pid);
  else publishPlaylist(pid);
}
async function publishPlaylist(pid){
  const pl = getPlaylists().find(p => p.id === pid);
  if(!pl) return;
  toast('Publishing…','info');
  const ok = await syncPlaylistToServer(pid);
  if(!ok) return;
  const all = getPlaylists(), t = all.find(p => p.id === pid);
  if(t){ t.isPublic = true; t.updatedAt = Date.now(); savePlaylists(all) }
  toast('Playlist is now public','success');
  Notify.show('Playlist published', pl.name, {category:'playlist'});
  if(isPlDet(pid)) renderPlaylistDetail(pid);
}
async function unpublishPlaylist(pid){
  try{
    const r = await apiCall('/pl/unpublish', {method:'POST', body:JSON.stringify({id:pid})});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Unpublish failed');
    const all = getPlaylists(), t = all.find(p => p.id === pid);
    if(t){ t.isPublic = false; t.updatedAt = Date.now(); savePlaylists(all) }
    toast('Playlist is now private');
    if(isPlDet(pid)) renderPlaylistDetail(pid);
  }catch(e){ toast('Unpublish failed: '+(e.message||e),'danger') }
}
async function syncPlaylistToServer(pid){
  const pl = getPlaylists().find(p => p.id === pid);
  if(!pl) return false;
  if(!MMAuth.user) return false;
  const tracks = (pl.tracks||[]).map(t => ({
    trackId:String(t.trackId), trackName:t.trackName, artistName:t.artistName, artistId:t.artistId,
    collectionName:t.collectionName, collectionId:t.collectionId, artworkUrl:t.artworkUrl
  }));
  try{
    const r = await apiCall('/pl/publish', {method:'POST', body:JSON.stringify({id:pl.id, name:pl.name, description:pl.description||'', cover:pl.cover||'', tracks})});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Publish failed');
    return true;
  }catch(e){ toast('Publish failed: '+(e.message||e),'danger'); return false }
}
function sharePlaylist(pid){
  const pl = getPlaylists().find(p => p.id === pid);
  if(!pl) return;
  if(!pl.isPublic){ toast('Make the playlist public first','warning'); return }
  const url = location.origin + (BASE||'') + '/p/' + encodeURIComponent(pid),
        text = `Check out my playlist "${pl.name}" on MusicMan`;
  shareUrl({title:pl.name, text, url});
}
function copyPlaylistLink(pid){
  const pl = getPlaylists().find(p => p.id === pid);
  if(!pl || !pl.isPublic){ toast('Make the playlist public first','warning'); return }
  copyText(location.origin + (BASE||'') + '/p/' + encodeURIComponent(pid));
}

/* ══ PUBLIC PLAYLIST / USER / ACCOUNT / SOCIAL ═══════════════════════════════ */
async function viewPublicPlaylist(pid){
  if(!pid){ MAIN().innerHTML = emptyState('music-note-list','Playlist not found'); return }
  setPageTitle('Playlist');
  try{
    const r = await apiCall('/pl/get/'+encodeURIComponent(pid)), d = r.data||{};
    if(!r.ok || !d.ok){ MAIN().innerHTML = emptyState('lock','Playlist not found','It may be private or no longer shared.'); return }
    const isAi = d.kind === 'ai';
    setPageTitle(d.name || (isAi ? 'AI Playlist' : 'Playlist'));
    const items = (d.tracks||[]).map(normalizePlaylistTrack).filter(Boolean);
    cacheItems(items);
    _pageTracks = items;
    const ids = items.map(x => String(x.trackId)).join(','), firstId = items[0] ? String(items[0].trackId) : '',
          owner = d.owner||{},
          ownerHref = owner.id && owner.id !== 'ai' ? `${SCOPE}u/${esc(owner.id)}` : '#',
          badge = isAi
            ? `<span class="badge-chip" style="background:rgba(var(--bs-${esc(d.color||'primary')}-rgb),.2);color:var(--bs-${esc(d.color||'primary')})"><i class="bi ${esc(d.icon||'bi-stars')}"></i> AI</span>`
            : `<span class="badge-chip public"><i class="bi bi-globe"></i>Public</span>`,
          ownerLine = isAi
            ? `<i class="bi ${esc(d.icon||'bi-stars')}"></i> ${esc(owner.name||'MusicMan AI')}`
            : `<a href="${ownerHref}" data-link class="mm-link">${owner.photo_url?`<img src="${esc(owner.photo_url)}" width="20" height="20" style="border-radius:50%;vertical-align:middle;margin-right:6px" alt="">`:''}${esc(owner.name||'User')}</a>`;
    let html = `<div class="pb-4">${backBtn()}<div class="px-3 pt-1"><div class="d-flex align-items-center gap-2"><div style="font-size:1.35rem;font-weight:800" class="text-truncate flex-grow-1">${esc(d.name||'Playlist')}</div>${badge}</div><div class="text-secondary d-flex align-items-center gap-2 mt-1 flex-wrap" style="font-size:.8rem">${ownerLine} · ${items.length} track${items.length!==1?'s':''}${!isAi?` · <i class="bi bi-eye"></i> ${d.views||0}`:''}${!isAi&&d.followers?` · <i class="bi bi-people"></i> ${d.followers}`:''}</div>${d.description?`<div class="text-secondary mt-2" style="font-size:.82rem;line-height:1.5;white-space:pre-wrap">${esc(d.description)}</div>`:''}</div>`;
    html += `<div class="lib-tabs">${items.length?`<button class="pill-btn success" data-play-id="${esc(firstId)}" onclick="playIds('${esc(ids)}')"><i class="bi bi-play-fill"></i> Play</button>`:''}${items.length?`<button class="pill-btn" onclick="addAllToQueue(_pageTracks)"><i class="bi bi-list-ul"></i> Queue</button>`:''}${!isAi&&!d.is_owner?`<button class="pill-btn ${d.is_following?'':'primary'}" id="plFollowBtn" onclick="togglePlFollow('${esc(pid)}',${d.is_following?'true':'false'})"><i class="bi ${d.is_following?'bi-check-lg':'bi-plus-lg'}"></i><span>${d.is_following?'Following':'Follow'}</span></button>`:''}<button class="icon-btn" style="background:rgba(var(--bs-body-color-rgb),.09)" onclick="copyText(location.href)"><i class="bi bi-link-45deg"></i></button>${!isAi&&d.is_owner?`<button class="icon-btn" style="background:rgba(var(--bs-body-color-rgb),.09)" onclick="go('/library/playlists/${esc(pid)}')"><i class="bi bi-pencil"></i></button>`:''}</div>`;
    html += items.length ? items.map(t => trackRow(t)).join('') : emptyState('music-note','This playlist is empty');
    html += `</div>`;
    MAIN().innerHTML = html;
    reindexActionButtons(); refreshLikes();
  }catch(e){ MAIN().innerHTML = errorState(e.message) }
}
async function togglePlFollow(pid, isFollowing){
  if(!MMAuth.user){
    toastAction('Sign in to follow playlists', [{html:'<i class="bi bi-box-arrow-in-right"></i> Sign in', class:'primary', fn:()=>openAuth()}], 'warning', 6e3);
    return;
  }
  const path = isFollowing ? '/pl/unfollow' : '/pl/follow';
  try{
    const r = await apiCall(path, {method:'POST', body:JSON.stringify({id:pid})});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Failed');
    toast(isFollowing ? 'Unfollowed' : 'Following');
    const btn = document.getElementById('plFollowBtn');
    if(btn){
      btn.classList.toggle('primary', isFollowing);
      btn.querySelector('i').className = `bi ${isFollowing?'bi-plus-lg':'bi-check-lg'}`;
      btn.querySelector('span').textContent = isFollowing ? 'Follow' : 'Following';
      btn.onclick = () => togglePlFollow(pid, !isFollowing);
    }
  }catch(e){ toast('Failed: '+(e.message||e),'danger') }
}
function profileTabs(uid, active, counts){
  const c = counts||{},
        items = [
          ['stats','Stats','bar-chart-fill',null],
          ['likes','Liked','heart-fill',c.likes||0],
          ['following','Following','people-fill',c.following||0],
          ['plays','Recent','clock-history',c.plays||0],
          ['playlists','Playlists','music-note-list',c.playlists||0]
        ];
  return `<div class="lib-tabs">${items.map(([k,l,i,b]) => {
    const on = active === k ? ' on' : '', bd = b && b > 0 ? `<span class="lt-badge">${b}</span>` : '';
    return `<a href="${SCOPE}u/${esc(uid)}/${k}" data-link class="lt${on}"><i class="bi bi-${i}"></i><span>${l}</span>${bd}</a>`;
  }).join('')}</div>`;
}
async function viewUserProfile(uid, tab){
  if(!uid){ MAIN().innerHTML = emptyState('person','User not found'); return }
  tab = ['stats','likes','following','plays','playlists'].includes(tab) ? tab : 'stats';
  setPageTitle('Profile');
  try{
    const r = await apiCall('/u/get/'+encodeURIComponent(uid)), d = r.data||{};
    if(!r.ok || !d.ok){ MAIN().innerHTML = emptyState('person','User not found'); return }
    const u = d.user||{}, pls = d.playlists||[], pd = d.public_data||null,
          isSelf = !!d.is_self, isPublic = d.is_public !== false;
    setPageTitle(u.username || u.first_name || 'Profile');
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'User '+u.id,
          avatar = u.photo_url ? `<img class="hero-art round" src="${esc(u.photo_url)}" loading="lazy" decoding="async" alt="">` : `<div class="hero-art hero-art-ph round"><i class="bi bi-person-fill"></i></div>`,
          joined = u.created_at ? new Date(u.created_at*1e3).toLocaleDateString(undefined, {year:'numeric', month:'short'}) : '',
          subParts = [];
    if(u.username) subParts.push('@'+esc(u.username));
    subParts.push(esc(MMAuth.providerLabel(u.provider||'')));
    if(joined) subParts.push('Joined '+joined);
    let html = `<div class="pb-4">${backBtn()}<div class="hero" style="padding-bottom:14px">${avatar}<div class="hero-title">${esc(name)}</div><div class="hero-sub">${subParts.join(' · ')}</div>${u.bio?`<div class="hero-sub" style="margin-top:10px;max-width:520px;white-space:pre-wrap;line-height:1.55">${esc(u.bio)}</div>`:''}${!isPublic?`<div class="hero-sub" style="margin-top:8px;color:var(--bs-warning)"><i class="bi bi-eye-slash"></i> ${isSelf?'Your profile is private':'Private profile'}</div>`:''}</div>`;
    html += `<div class="lib-tabs" style="padding-top:4px">`;
    if(!isSelf) html += `<button class="pill-btn ${u.is_following?'':'primary'}" id="userFollowBtn" onclick="toggleUserFollow('${esc(uid)}',${u.is_following?'true':'false'})"><i class="bi ${u.is_following?'bi-check-lg':'bi-plus-lg'}"></i><span>${u.is_following?'Following':'Follow'}</span></button>`;
    else html += `<button class="pill-btn primary" onclick="go('/account')"><i class="bi bi-pencil"></i> Edit profile</button>`;
    html += `<button class="pill-btn" onclick="shareUrl({ title:${JSON.stringify(name)}, text:'Check out ${esc(name).replace(/'/g,"\\'")} on MusicMan' })"><i class="bi bi-share"></i> Share</button>`;
    html += `<button class="icon-btn" style="background:rgba(var(--bs-body-color-rgb),.09)" onclick="userMore('${esc(uid)}')"><i class="bi bi-three-dots"></i></button></div>`;
    if(!isPublic && !isSelf){
      html += emptyState('lock','This profile is private','This user has chosen to hide their activity.') + `</div>`;
      MAIN().innerHTML = html;
      return;
    }
    const likes = Array.isArray(pd?.likes) ? pd.likes : [],
          following = Array.isArray(pd?.following) ? pd.following : [],
          plays = Array.isArray(pd?.plays) ? pd.plays : [],
          stats = pd?.stats || null;
    html += profileTabs(uid, tab, {likes:likes.length, following:following.length, plays:plays.length, playlists:pls.length});
    if(tab === 'stats'){
      if(stats && (stats.totalMs > 0 || stats.plays > 0 || stats.uniqueTracks > 0)){
        const mins = Math.round((stats.totalMs||0)/6e4), hours = Math.floor(mins/60), remMins = mins%60,
              totalStr = hours ? `${hours}<span style="font-size:.6em;opacity:.7">h</span> ${remMins}<span style="font-size:.6em;opacity:.7">m</span>` : `${mins}<span style="font-size:.6em;opacity:.7">m</span>`;
        html += `<div class="stat-grid cols-3" style="padding-top:16px"><div class="stat-card"><div class="n">${totalStr}</div><div class="l">Total listening</div></div><div class="stat-card"><div class="n">${(stats.plays||0).toLocaleString()}</div><div class="l">Total plays</div></div><div class="stat-card"><div class="n">${stats.uniqueTracks||0}</div><div class="l">Unique tracks</div></div></div>`;
        const days = stats.days||{}, dayKey = ts => new Date(ts).toISOString().slice(0,10), week = [], today = new Date();
        for(let i=6;i>=0;i--){ const dd = new Date(today); dd.setDate(dd.getDate()-i); const k = dayKey(dd.getTime()); week.push({k, label:dd.toLocaleDateString(undefined,{weekday:'short'}).slice(0,2), ms:days[k]||0}) }
        const weekMax = Math.max(1, ...week.map(w => w.ms));
        html += secTitle('Last 7 days') + `<div class="week-chart">${week.map(w => { const hh = Math.max(4, Math.round(w.ms/weekMax*76)); return `<div class="week-day"><div class="week-bar" style="height:${hh}px" title="${Math.round(w.ms/6e4)}m"></div><div class="week-lbl">${w.label}</div></div>` }).join('')}</div>`;
      } else html += emptyState('bar-chart','No listening stats yet', isSelf ? 'Play some tracks and check back here.' : 'This user has not listened to anything yet.');
      const topArtists = Array.isArray(stats?.topArtists) ? stats.topArtists : [];
      for(const a of topArtists){ if(!a.artwork && a.artistId){ const ca = getCached('artist', a.artistId); if(ca) a.artwork = getArtwork(ca, 300) || '' } }
      if(topArtists.length){
        html += secTitle(`Top artists · ${topArtists.length}`) + `<div class="mm-grid mm-grid-narrow">` + topArtists.map(a => {
          const art = a.artwork||'', minsA = Math.round(a.ms/6e4),
                dur = minsA < 1 ? '<1m' : minsA < 60 ? `${minsA}m` : `${Math.floor(minsA/60)}h ${minsA%60}m`,
                href = a.artistId ? `${SCOPE}artist/${esc(a.artistId)}` : `${SCOPE}search?q=${encodeURIComponent(a.name)}`;
          return `<a class="artist-item" href="${href}" data-link>${art ? `<img class="artist-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="artist-art artist-art-ph"><i class="bi bi-person-fill"></i></div>`}<div class="card-name text-truncate">${esc(a.name)}</div><div class="card-sub text-truncate">${dur} · ${a.count}×</div></a>`;
        }).join('') + `</div>`;
      }
      const topTracks = Array.isArray(stats?.topTracks) ? stats.topTracks : [];
      if(topTracks.length){
        html += secTitle('Top tracks');
        html += topTracks.slice(0,20).map(t => {
          const minsT = Math.round(t.ms/6e4), dur = minsT < 1 ? '<1m' : `${minsT}m`;
          return trackRow({wrapperType:'track', trackId:String(t.id), trackName:t.name, artistName:t.artist, artistId:t.artistId||'', attachments:{artworkUrls:t.artwork?[{url:t.artwork}]:[]}}, {extraSub:`${t.count}× · ${dur}`});
        }).join('');
      }
    } else if(tab === 'likes'){
      if(!likes.length) html += emptyState('heart', isSelf ? 'No liked songs yet' : 'No liked songs', 'Tap the heart on any track to save it here.');
      else {
        _pageTracks = likes.map(l => ({wrapperType:'track', trackId:String(l.trackId), trackName:l.trackName, artistName:l.artistName, artistId:l.artistId, collectionName:l.collectionName, collectionId:l.collectionId, attachments:{artworkUrls:l.artworkUrl?[{url:l.artworkUrl}]:[]}}));
        const firstId = _pageTracks[0] ? String(_pageTracks[0].trackId) : '';
        html += `<div class="d-flex align-items-center px-3 pt-4 pb-3"><div class="flex-grow-1 fw-bold">${likes.length} liked song${likes.length!==1?'s':''}</div><button class="pill-btn success" data-play-id="${esc(firstId)}" onclick="playIds(_pageTracks.map(t=>t.trackId).join(','))"><i class="bi bi-play-fill"></i> Play all</button></div>`;
        html += _pageTracks.map(t => trackRow(t)).join('');
      }
    } else if(tab === 'following'){
      if(!following.length) html += emptyState('people', isSelf ? 'Not following any artists' : 'Not following any artists');
      else {
        html += `<div class="px-3 pt-4 pb-2"><div class="fw-bold">${following.length} artist${following.length!==1?'s':''}</div><div class="text-secondary" style="font-size:.74rem">Artists ${isSelf?'you':(u.first_name||'this user')} follow</div></div><div class="mm-grid mm-grid-narrow">`;
        html += following.map(a => { const art = a.artwork||''; return `<a class="artist-item" href="${SCOPE}artist/${esc(a.artistId)}" data-link>${art ? `<img class="artist-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="artist-art artist-art-ph"><i class="bi bi-person-fill"></i></div>`}<div class="card-name text-truncate">${esc(a.artistName||'Artist')}</div>${a.primaryGenreName?`<div class="card-sub text-truncate">${esc(a.primaryGenreName)}</div>`:''}</a>` }).join('') + `</div>`;
      }
    } else if(tab === 'plays'){
      if(!plays.length) html += emptyState('clock-history','No recent plays yet');
      else {
        _pageTracks = plays.map(r => ({wrapperType:'track', trackId:String(r.trackId), trackName:r.trackName, artistName:r.artistName, artistId:r.artistId, collectionName:r.collectionName, collectionId:r.collectionId, attachments:{artworkUrls:r.artworkUrl?[{url:r.artworkUrl}]:[]}}));
        const firstId = _pageTracks[0] ? String(_pageTracks[0].trackId) : '';
        html += `<div class="d-flex align-items-center px-3 pt-4 pb-3"><div class="flex-grow-1 fw-bold">Recently played</div><button class="pill-btn success" data-play-id="${esc(firstId)}" onclick="playIds(_pageTracks.map(t=>t.trackId).join(','))"><i class="bi bi-play-fill"></i> Play all</button></div>`;
        html += _pageTracks.map(t => trackRow(t)).join('');
      }
    } else if(tab === 'playlists'){
      if(!pls.length) html += emptyState('music-note-list','No public playlists yet', isSelf ? 'Publish one from your library to show it here.' : 'This user has not published any playlists.');
      else {
        html += `<div class="px-3 pt-4 pb-2"><div class="fw-bold">${pls.length} public playlist${pls.length!==1?'s':''}</div></div><div class="mm-grid">` + pls.map(p => { const c = p.cover||''; return `<a class="card-item" href="${SCOPE}p/${esc(p.id)}" data-link>${c ? `<img class="card-art" src="${esc(c)}" loading="lazy" decoding="async" alt="">` : `<div class="card-art card-art-ph"><i class="bi bi-music-note-list"></i></div>`}<div class="card-name text-truncate">${esc(p.name)}</div><div class="card-sub text-truncate">${p.track_count||0} tracks · ${p.views||0} views</div></a>` }).join('') + `</div>`;
      }
    }
    html += `</div>`;
    MAIN().innerHTML = html;
    reindexActionButtons(); refreshLikes();
  }catch(e){ MAIN().innerHTML = errorState(e.message) }
}
function userMore(uid){
  const isSelf = MMAuth.user && String(MMAuth.user.id) === String(uid), rows = [];
  if(isSelf) rows.push(`<button class="sheet-item" onclick="closeAllSheets(); editProfileSheet()"><i class="bi bi-pencil"></i><span>Edit profile</span></button>`);
  rows.push(`<button class="sheet-item" onclick="closeAllSheets(); copyText(location.href)"><i class="bi bi-link-45deg"></i><span>Copy profile link</span></button>`);
  rows.push(`<button class="sheet-item" onclick="closeAllSheets(); viewUserProfile('${esc(uid)}')"><i class="bi bi-arrow-clockwise"></i><span>Refresh</span></button>`);
  if(isSelf) rows.push(`<button class="sheet-item danger" onclick="closeAllSheets(); MMAuth.logout()"><i class="bi bi-box-arrow-right"></i><span>Sign out</span></button>`);
  $('#sheetTrackBody').innerHTML = `<div class="px-3 pb-2 pt-1"><div class="fw-bold">Profile actions</div></div><div class="px-2">${rows.join('')}</div>`;
  sheet('#sheetTrack').show();
}
async function toggleUserFollow(uid, isFollowing){
  if(!MMAuth.user){
    toastAction('Sign in to follow users', [{html:'<i class="bi bi-box-arrow-in-right"></i> Sign in', class:'primary', fn:()=>openAuth()}], 'warning', 6e3);
    return;
  }
  const path = isFollowing ? '/u/unfollow' : '/u/follow';
  try{
    const r = await apiCall(path, {method:'POST', body:JSON.stringify({id:uid})});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Failed');
    toast(isFollowing ? 'Unfollowed' : 'Following');
    const btn = document.getElementById('userFollowBtn');
    if(btn){
      btn.classList.toggle('primary', isFollowing);
      btn.querySelector('i').className = `bi ${isFollowing?'bi-plus-lg':'bi-check-lg'}`;
      btn.querySelector('span').textContent = isFollowing ? 'Follow' : 'Following';
      btn.onclick = () => toggleUserFollow(uid, !isFollowing);
    }
  }catch(e){ toast('Failed: '+(e.message||e),'danger') }
}
async function viewAccountPage(){
  if(!MMAuth.user){ openAuth(); go('/'); return }
  const u = MMAuth.user, name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'User '+u.id,
        isPublic = u.is_public !== 0 && u.is_public !== false,
        avatar = u.photo_url ? `<img class="hero-art round" src="${esc(u.photo_url)}" alt="">` : `<div class="hero-art hero-art-ph round"><i class="bi bi-person-fill"></i></div>`,
        joined = u.created_at ? new Date(u.created_at*1e3).toLocaleDateString(undefined, {year:'numeric', month:'short'}) : '',
        subParts = [];
  if(u.username) subParts.push('@'+esc(u.username));
  subParts.push(esc(MMAuth.providerLabel(u.provider)));
  if(u.email) subParts.push(esc(u.email));
  if(joined) subParts.push('Joined '+joined);
  let html = `<div class="pb-4">${backBtn()}<div class="hero">${avatar}<div class="hero-title">${esc(name)}</div><div class="hero-sub">${subParts.join(' · ')}</div>${u.bio?`<div class="hero-sub" style="margin-top:10px;max-width:520px;white-space:pre-wrap;line-height:1.55">${esc(u.bio)}</div>`:''}${!isPublic?`<div class="hero-sub" style="margin-top:8px;color:var(--bs-warning)"><i class="bi bi-eye-slash"></i> Profile is private</div>`:''}</div>`;
  html += `<div class="lib-tabs"><button class="pill-btn primary" onclick="editProfileSheet()"><i class="bi bi-pencil"></i> Edit</button><button class="pill-btn" onclick="go('/u/${esc(u.id)}')"><i class="bi bi-person"></i> View profile</button><button class="icon-btn" style="background:rgba(var(--bs-body-color-rgb),.09)" onclick="accountMore()"><i class="bi bi-three-dots"></i></button></div>`;
  html += secTitle('Account');
  if(u.provider === 'email') html += `<div class="settings-row"><i class="bi bi-key"></i><div class="sr-body"><div class="sr-title">Password</div><div class="sr-sub">Change your password</div></div><div class="sr-control"><button class="pill-btn sm" onclick="changePasswordSheet()">Change</button></div></div>`;
  html += `<div class="settings-row"><i class="bi bi-shield"></i><div class="sr-body"><div class="sr-title">Sign out everywhere</div><div class="sr-sub">Ends all sessions on other devices</div></div><div class="sr-control"><button class="pill-btn warn sm" onclick="logoutAllDevices()">Sign out all</button></div></div><div class="settings-row"><i class="bi bi-box-arrow-right"></i><div class="sr-body"><div class="sr-title">Sign out</div><div class="sr-sub">Sign out on this device</div></div><div class="sr-control"><button class="pill-btn sm" onclick="MMAuth.logout()">Sign out</button></div></div>`;
  html += secTitle('Sync');
  const last = MMSync._lastTime ? fmtAgo(MMSync._lastTime) : '—', syncEnabled = MMSync.enabled();
  html += `<div class="sync-status-card"><i class="bi bi-${syncEnabled?(MMSync._lastError?'exclamation-circle text-danger':'cloud-check text-success'):'cloud-slash text-secondary'}"></i><div class="sc-body"><div class="sc-title">${syncEnabled?(MMSync._lastError?'Sync error':'Auto-sync enabled'):'Sync disabled'}</div><div class="sc-sub">${MMSync._lastError ? esc(MMSync._lastError) : `Last synced: ${last}`}</div></div><button class="pill-btn primary sm" onclick="MMAuth.syncNow()"><i class="bi bi-arrow-repeat"></i> Sync</button></div>`;
  html += secTitle('Danger zone');
  html += `<div class="settings-row"><i class="bi bi-trash3 text-danger"></i><div class="sr-body"><div class="sr-title text-danger">Delete account</div><div class="sr-sub">Permanently deletes your account and cloud data</div></div><div class="sr-control"><button class="pill-btn danger sm" onclick="deleteAccountSheet()">Delete</button></div></div>`;
  html += `</div>`;
  MAIN().innerHTML = html;
}
function accountMore(){
  const u = MMAuth.user||{},
        rows = [
          `<button class="sheet-item" onclick="closeAllSheets(); editProfileSheet()"><i class="bi bi-pencil"></i><span>Edit profile</span></button>`,
          `<button class="sheet-item" onclick="closeAllSheets(); go('/u/${esc(u.id)}')"><i class="bi bi-person"></i><span>View profile</span></button>`,
          `<button class="sheet-item" onclick="closeAllSheets(); MMAuth.syncNow()"><i class="bi bi-arrow-repeat"></i><span>Sync now</span></button>`,
          `<button class="sheet-item" onclick="closeAllSheets(); openSettings()"><i class="bi bi-gear"></i><span>Settings</span></button>`,
          `<button class="sheet-item danger" onclick="closeAllSheets(); MMAuth.logout()"><i class="bi bi-box-arrow-right"></i><span>Sign out</span></button>`
        ];
  $('#sheetTrackBody').innerHTML = `<div class="px-3 pb-2 pt-1"><div class="fw-bold">Account</div></div><div class="px-2">${rows.join('')}</div>`;
  sheet('#sheetTrack').show();
}
function editProfileSheet(){
  const u = MMAuth.user||{}, isPublic = u.is_public !== 0 && u.is_public !== false;
  $('#sheetTrackBody').innerHTML = `<div class="px-3 pb-2 pt-1"><div class="fw-bold">Edit profile</div></div><div class="px-3 pb-3"><input id="epFirst" class="form-control form-control-lg mb-2" placeholder="First name" value="${esc(u.first_name||'')}" style="border-radius:12px"><input id="epLast" class="form-control form-control-lg mb-2" placeholder="Last name" value="${esc(u.last_name||'')}" style="border-radius:12px"><input id="epPhoto" class="form-control mb-2" placeholder="Avatar URL" value="${esc(u.photo_url||'')}" style="border-radius:12px"><textarea id="epBio" class="form-control mb-3" rows="3" placeholder="Bio (max 400 chars)" style="border-radius:12px">${esc(u.bio||'')}</textarea><div class="settings-row" style="padding-left:2px;padding-right:2px"><i class="bi bi-${isPublic?'eye':'eye-slash'}"></i><div class="sr-body"><div class="sr-title">Public profile</div><div class="sr-sub">${isPublic?'Likes, following, recent plays & stats are shown publicly':'Your activity is hidden from others'}</div></div><div class="sr-control"><label class="mm-switch"><input type="checkbox" id="epPublic" ${isPublic?'checked':''}><span class="slider"></span></label></div></div><div class="d-flex gap-2 mt-3"><button class="pill-btn flex-fill justify-content-center" data-bs-dismiss="offcanvas">Cancel</button><button class="pill-btn primary flex-fill justify-content-center" onclick="saveProfile()">Save</button></div></div>`;
  sheet('#sheetTrack').show();
}
async function saveProfile(){
  const first = document.getElementById('epFirst').value.trim(),
        last = document.getElementById('epLast').value.trim(),
        photo = document.getElementById('epPhoto').value.trim(),
        bio = document.getElementById('epBio').value.trim(),
        isPublic = document.getElementById('epPublic')?.checked ? 1 : 0;
  try{
    const r = await apiCall('/auth/update-profile', {method:'POST', body:JSON.stringify({first_name:first, last_name:last, photo_url:photo, bio, is_public:isPublic})});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Failed');
    MMAuth.user = r.data.user;
    MMAuth.render();
    sheet('#sheetTrack').hide();
    toast('Profile updated','success');
    Notify.show('Profile updated','',{category:'auth'});
    if(currentPath() === '/account') viewAccountPage();
    else if(currentPath().startsWith('/u/')) viewUserProfile(r.data.user.id);
  }catch(e){ toast('Update failed: '+(e.message||e),'danger') }
}
function changePasswordSheet(){
  $('#sheetTrackBody').innerHTML = `<div class="px-3 pb-2 pt-1"><div class="fw-bold">Change password</div></div><div class="px-3 pb-3"><input id="cpCur" type="password" class="form-control form-control-lg mb-2" placeholder="Current password" style="border-radius:12px"><input id="cpNew" type="password" class="form-control form-control-lg mb-3" placeholder="New password" style="border-radius:12px"><div id="cpErr" class="text-danger small mb-2" style="min-height:1.1em"></div><div class="d-flex gap-2"><button class="pill-btn flex-fill justify-content-center" data-bs-dismiss="offcanvas">Cancel</button><button class="pill-btn primary flex-fill justify-content-center" onclick="savePassword()">Update</button></div></div>`;
  sheet('#sheetTrack').show();
}
async function savePassword(){
  const cur = document.getElementById('cpCur').value,
        nw = document.getElementById('cpNew').value,
        err = document.getElementById('cpErr');
  err.textContent = '';
  if(nw.length < 6){ err.textContent = 'New password must be at least 6 characters'; return }
  try{
    const r = await apiCall('/auth/change-password', {method:'POST', body:JSON.stringify({current:cur, new:nw})});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Failed');
    sheet('#sheetTrack').hide();
    toast('Password updated','success');
    Notify.show('Password updated','',{category:'auth'});
  }catch(e){ err.textContent = e.message || String(e) }
}
async function logoutAllDevices(){
  const ok = await askConfirm('Sign out all devices?', 'All sessions on other devices will be signed out.', 'Sign out all', 'primary');
  if(!ok) return;
  try{
    const r = await apiCall('/auth/logout-all', {method:'POST'});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Failed');
    toast('Signed out everywhere','success');
  }catch(e){ toast('Failed: '+(e.message||e),'danger') }
}
async function deleteAccountSheet(){
  const ok = await askConfirm('Delete account?', 'This will permanently delete your account, likes, playlists, and cloud data. This cannot be undone.', 'Continue');
  if(!ok) return;
  const t = await askText('Type DELETE to confirm', '', 'DELETE');
  if(t !== 'DELETE'){ toast('Cancelled'); return }
  try{
    const r = await apiCall('/auth/delete-account', {method:'POST', body:JSON.stringify({confirm:'DELETE'})});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Failed');
    MMAuth.user = null;
    MMAuth.render();
    toast('Account deleted','success');
    go('/');
  }catch(e){ toast('Delete failed: '+(e.message||e),'danger') }
}

/* ══ SOCIAL ══════════════════════════════════════════════════════════════════ */
const SOCIAL_TABS = [
  {key:'feed', label:'Feed', icon:'bi-house-door-fill'},
  {key:'following', label:'Following', icon:'bi-person-check-fill'},
  {key:'followers', label:'Followers', icon:'bi-people-fill'},
  {key:'discover', label:'Discover', icon:'bi-compass-fill'},
  {key:'playlists', label:'My Lists', icon:'bi-music-note-list'}
];
const feedTs = v => { v = Number(v)||0; return v > 0 && v < 1e12 ? v*1e3 : v };
function avatarHtml(url, initials, size=''){
  const cls = `avatar ${size}`.trim();
  if(url) return `<img class="${cls}" src="${esc(url)}" loading="lazy" decoding="async" alt="">`;
  return `<div class="${cls} avatar-ph">${esc(initials||'?')}</div>`;
}
function userInitials(u){ const n = (u.name||u.username||'?').trim(); return (n.match(/\S+/g)||['?']).slice(0,2).map(s => s[0].toUpperCase()).join('') }
function socialTabsHtml(active){
  return `<div class="lib-tabs social-tabs">${SOCIAL_TABS.map(t => { const on = t.key === active ? ' on' : ''; return `<a href="${SCOPE}social?tab=${t.key}" data-link class="lt${on}"><i class="bi ${t.icon}"></i><span>${t.label}</span></a>` }).join('')}</div>`;
}
function userRowHtml(u, opts={}){
  const name = u.name || 'User', uname = u.username ? '@'+u.username : '',
        bio = u.bio ? String(u.bio).slice(0,90) : '',
        sub = [uname, bio].filter(Boolean).join(' · ');
  let action = '';
  if(opts.showFollow){
    const following = !!u.is_following;
    action = `<button class="pill-btn ${following?'':'primary'} sm" data-ufollow="${esc(u.id)}" onclick="event.preventDefault();event.stopPropagation();socialToggleFollow('${esc(u.id)}',${following?'true':'false'})"><i class="bi ${following?'bi-check-lg':'bi-plus-lg'}"></i><span>${following?'Following':'Follow'}</span></button>`;
  }
  return `<div class="row-item"><a class="row-info" href="${SCOPE}u/${esc(u.id)}" data-link style="flex-grow:1">${avatarHtml(u.photo_url, userInitials(u))}<div class="min-w-0 flex-grow-1"><div class="row-title text-truncate">${esc(name)}</div><div class="row-sub text-truncate">${sub ? esc(sub) : '&nbsp;'}</div></div></a>${action}</div>`;
}
async function socialToggleFollow(uid, isFollowing){
  if(!MMAuth.user){
    toastAction('Sign in to follow users', [{html:'<i class="bi bi-box-arrow-in-right"></i> Sign in', class:'primary', fn:()=>openAuth()}], 'warning', 6e3);
    return;
  }
  const path = isFollowing ? '/u/unfollow' : '/u/follow';
  try{
    const r = await apiCall(path, {method:'POST', body:JSON.stringify({id:uid})});
    if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Failed');
    toast(isFollowing ? 'Unfollowed' : 'Following');
    haptic(8);
    $$(`[data-ufollow="${uid}"]`).forEach(b => {
      b.classList.toggle('primary', isFollowing);
      const i = b.querySelector('i'); if(i) i.className = `bi ${isFollowing?'bi-plus-lg':'bi-check-lg'}`;
      const s = b.querySelector('span'); if(s) s.textContent = isFollowing ? 'Follow' : 'Following';
      b.setAttribute('onclick', `event.preventDefault();event.stopPropagation();socialToggleFollow('${uid}',${!isFollowing})`);
    });
  }catch(e){ toast('Failed: '+(e.message||e),'danger') }
}
function feedItemHtml(item){
  if(!item || !item.type) return '';
  const u = item.user||{}, name = u.name||'User', ago = item.at ? esc(fmtAgo(feedTs(item.at))) : '',
        head = (v,i) => `<div class="feed-head">${avatarHtml(u.photo_url, userInitials(u))}<div class="feed-head-text"><a class="mm-link fw-bold" href="${SCOPE}u/${esc(u.id)}" data-link>${esc(name)}</a><span class="text-secondary">${v}</span><i class="bi ${i}"></i></div><span class="feed-time">${ago}</span></div>`;
  if(item.type === 'like' || item.type === 'play'){
    const t = item.track||{}, art = t.artworkUrl||'',
          v = item.type === 'like' ? 'liked' : 'played',
          i = item.type === 'like' ? 'bi-heart-fill text-danger' : 'bi-play-circle-fill text-success';
    return `<div class="feed-item">${head(v,i)}<div class="feed-preview"><a href="${SCOPE}track/${esc(t.trackId)}" data-link style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;color:inherit">${art ? `<img class="feed-preview-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="feed-preview-art feed-preview-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="feed-preview-body"><div class="feed-preview-title">${esc(t.trackName||'Track')}</div><div class="feed-preview-sub">${esc(t.artistName||'')}${t.collectionName?' · '+esc(t.collectionName):''}</div></div></a><button class="row-play" onclick="event.preventDefault();event.stopPropagation();playById('${esc(t.trackId)}')" aria-label="Play"><i class="bi bi-play-fill"></i></button></div></div>`;
  }
  if(item.type === 'follow'){
    const a = item.artist||{}, art = a.artwork||'';
    return `<div class="feed-item">${head('started following','bi-person-plus-fill text-primary')}<a class="feed-preview" href="${SCOPE}artist/${esc(a.artistId)}" data-link>${art ? `<img class="feed-preview-art round" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="feed-preview-art round feed-preview-art-ph"><i class="bi bi-person-fill"></i></div>`}<div class="feed-preview-body"><div class="feed-preview-title">${esc(a.artistName||'Artist')}</div><div class="feed-preview-sub">${esc(a.primaryGenreName||'Artist')}</div></div><i class="bi bi-chevron-right text-secondary"></i></a></div>`;
  }
  if(item.type === 'playlist'){
    const p = item.playlist||{}, art = p.cover||'';
    return `<div class="feed-item">${head('published a playlist','bi-music-note-list text-info')}<a class="feed-preview" href="${SCOPE}p/${esc(p.id)}" data-link>${art ? `<img class="feed-preview-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="feed-preview-art feed-preview-art-ph"><i class="bi bi-music-note-list"></i></div>`}<div class="feed-preview-body"><div class="feed-preview-title">${esc(p.name||'Playlist')}</div><div class="feed-preview-sub">${p.track_count||0} tracks · ${p.views||0} views</div></div><i class="bi bi-chevron-right text-secondary"></i></a></div>`;
  }
  if(item.type === 'note'){
    const n = item.note||{};
    return `<div class="feed-item">${head('wrote a note','bi-journal-text text-warning')}<div class="feed-note">${esc(n.text||'')}</div></div>`;
  }
  return '';
}
function socialEmptyFeedHtml(){
  return `<div class="state mm-empty"><i class="bi bi-people"></i><p class="fw-semibold text-body">Your feed is empty</p><p class="mt-1" style="font-size:.78rem">Follow some people to see their activity here</p><button class="pill-btn primary mt-3" onclick="go('/social?tab=discover')"><i class="bi bi-compass"></i> Discover people</button></div>`;
}
let _feedPage = 0, _feedHasMore = true, _feedLoading = false, _feedObserver = null, _feedItems = [];
function disconnectFeedObserver(){ if(_feedObserver){ try{ _feedObserver.disconnect() }catch{}; _feedObserver = null } }
async function socialLoadFeed(append=false){
  if(_feedLoading) return;
  if(!append && _feedPage > 0) return;
  if(append && !_feedHasMore) return;
  _feedLoading = true;
  const box = document.getElementById('feedList'), sent = document.getElementById('feedSentinel');
  if(!box){ _feedLoading = false; return }
  if(!append){ _feedPage = 0; _feedHasMore = true; _feedItems = []; box.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>` }
  try{
    const limit = 30, offset = _feedPage*limit,
          r = await apiCall(`/feed?limit=${limit}&offset=${offset}&scope=following`), d = r.data||{};
    if(!r.ok || !d.ok) throw new Error(d.error||'Failed to load feed');
    const items = Array.isArray(d.items) ? d.items : [];
    if(!append) box.innerHTML = '';
    if(!items.length && !append) box.innerHTML = socialEmptyFeedHtml();
    else { box.insertAdjacentHTML('beforeend', items.map(feedItemHtml).join('')); _feedItems = _feedItems.concat(items) }
    _feedHasMore = !!d.hasMore;
    _feedPage++;
  }catch(e){
    if(!append) box.innerHTML = `<div class="px-3 py-4 text-danger" style="font-size:.85rem">Failed to load feed: ${esc(e.message||e)}</div>`;
    _feedHasMore = false;
  }finally{
    _feedLoading = false;
    if(sent) sent.innerHTML = _feedHasMore ? `<div class="text-center py-3"><div class="spinner-border spinner-border-sm text-secondary" style="opacity:.4"></div></div>` : _feedItems.length ? `<div class="text-center py-3 text-secondary" style="font-size:.72rem">You're all caught up</div>` : '';
  }
}
function attachFeedObserver(){
  disconnectFeedObserver();
  const root = document.getElementById('main'), sent = document.getElementById('feedSentinel');
  if(!root || !sent) return;
  _feedObserver = new IntersectionObserver(es => {
    for(const en of es){
      if(!en.isIntersecting) continue;
      if(_feedLoading || !_feedHasMore) continue;
      socialLoadFeed(true);
    }
  }, {root, rootMargin:'500px 0px', threshold:.01});
  _feedObserver.observe(sent);
}
async function socialRenderFollowing(){
  const box = document.getElementById('socialTabBody'); if(!box) return;
  box.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>`;
  try{
    const r = await apiCall('/u/following?limit=200'), d = r.data||{};
    if(!r.ok || !d.ok) throw new Error(d.error||'Failed');
    const items = (Array.isArray(d.items) ? d.items : []).map(u => ({...u, is_following:true}));
    if(!items.length){ box.innerHTML = `<div class="state mm-empty"><i class="bi bi-person-plus"></i><p class="fw-semibold text-body">Not following anyone yet</p><p class="mt-1" style="font-size:.78rem">Find people to follow in Discover</p><button class="pill-btn primary mt-3" onclick="go('/social?tab=discover')"><i class="bi bi-compass"></i> Discover</button></div>`; return }
    box.innerHTML = `<div class="px-3 pt-3 pb-1"><div class="fw-bold">${items.length} user${items.length===1?'':'s'} you follow</div></div>` + items.map(u => userRowHtml(u, {showFollow:true})).join('');
  }catch(e){ box.innerHTML = `<div class="px-3 py-4 text-danger" style="font-size:.85rem">Failed: ${esc(e.message||e)}</div>` }
}
async function socialRenderFollowers(){
  const box = document.getElementById('socialTabBody'); if(!box) return;
  box.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>`;
  try{
    const r = await apiCall('/u/followers?limit=200'), d = r.data||{};
    if(!r.ok || !d.ok) throw new Error(d.error||'Failed');
    const items = Array.isArray(d.items) ? d.items : [];
    if(!items.length){
      box.innerHTML = `<div class="state mm-empty"><i class="bi bi-people"></i><p class="fw-semibold text-body">No followers yet</p><p class="mt-1" style="font-size:.78rem">Share your profile so people can find you</p><button class="pill-btn mt-3" onclick="copyText(location.origin + '${SCOPE}u/${esc(MMAuth.user.id)}'); toast('Profile link copied')"><i class="bi bi-link-45deg"></i> Copy profile link</button></div>`;
      return;
    }
    box.innerHTML = `<div class="px-3 pt-3 pb-1"><div class="fw-bold">${items.length} follower${items.length===1?'':'s'}</div></div>` + items.map(u => userRowHtml(u, {showFollow:true})).join('');
  }catch(e){ box.innerHTML = `<div class="px-3 py-4 text-danger" style="font-size:.85rem">Failed: ${esc(e.message||e)}</div>` }
}
function socialRenderDiscover(){
  const box = document.getElementById('socialTabBody'); if(!box) return;
  box.innerHTML = `<div class="social-search-wrap"><div class="search-box"><i class="bi bi-search"></i><input id="socialSearchInput" placeholder="Search users by name or username…" autocomplete="off" enterkeyhint="search"></div></div><div id="socialSearchResults"></div><div id="socialPopularPls"></div>`;
  const inp = document.getElementById('socialSearchInput');
  if(inp){
    let dt = null;
    inp.addEventListener('input', () => {
      if(dt) clearTimeout(dt);
      dt = setTimeout(async () => {
        const q = inp.value.trim(), res = document.getElementById('socialSearchResults');
        if(!res) return;
        if(q.length < 2){ res.innerHTML = ''; return }
        res.innerHTML = `<div class="text-center py-3"><div class="spinner-border spinner-border-sm text-secondary"></div></div>`;
        try{
          const r = await apiCall('/u/search?q='+encodeURIComponent(q)), d = r.data||{};
          if(!d.ok || !d.items?.length){ res.innerHTML = `<div class="px-3 py-3 text-secondary" style="font-size:.82rem">No users found for "${esc(q)}"</div>`; return }
          res.innerHTML = secTitle('Users') + d.items.map(u => userRowHtml(u, {showFollow:true})).join('');
        }catch{ res.innerHTML = '' }
      }, 200);
    });
  }
  (async () => {
    const host = document.getElementById('socialPopularPls'); if(!host) return;
    try{
      const r = await apiCall('/pl/list?type=user&limit=12'), d = r.data||{};
      if(!d.success || !d.items?.length) return;
      host.innerHTML = secTitle('Popular playlists') + `<div class="mm-grid">` + d.items.map(p => { const c = p.cover||''; return `<a class="card-item" href="${SCOPE}p/${esc(p.id)}" data-link>${c ? `<img class="card-art" src="${esc(c)}" loading="lazy" decoding="async" alt="">` : `<div class="card-art card-art-ph"><i class="bi bi-music-note-list"></i></div>`}<div class="card-name text-truncate">${esc(p.name)}</div><div class="card-sub text-truncate">${p.track_count||0} tracks · ${p.views||0} views</div></a>` }).join('') + `</div>`;
    }catch{}
  })();
}
function socialRenderMyPlaylists(){
  const box = document.getElementById('socialTabBody'); if(!box) return;
  const myPub = getPlaylists().filter(p => p.isPublic);
  if(!myPub.length){
    box.innerHTML = `<div class="state mm-empty"><i class="bi bi-globe"></i><p class="fw-semibold text-body">No public playlists</p><p class="mt-1" style="font-size:.78rem">Publish a playlist from your library to share it</p><button class="pill-btn primary mt-3" onclick="go('/library/playlists')"><i class="bi bi-music-note-list"></i> My playlists</button></div>`;
    return;
  }
  box.innerHTML = `<div class="px-3 pt-3 pb-1"><div class="fw-bold">${myPub.length} public playlist${myPub.length===1?'':'s'}</div></div><div class="mm-grid">` + myPub.map(p => { const c = p.cover || p.tracks.find(t => t.artworkUrl)?.artworkUrl || ''; return `<a class="card-item" href="${SCOPE}p/${esc(p.id)}" data-link>${c ? `<img class="card-art" src="${esc(c)}" loading="lazy" decoding="async" alt="">` : `<div class="card-art card-art-ph"><i class="bi bi-music-note-list"></i></div>`}<div class="card-name text-truncate">${esc(p.name)}</div><div class="card-sub text-truncate">${p.tracks.length} tracks</div></a>` }).join('') + `</div>`;
}
async function viewSocial(tab='feed'){
  _pageTracks = [];
  disconnectFeedObserver();
  if(!MMAuth.user){
    MAIN().innerHTML = `<div class="pb-4">${emptyState('people','Sign in to see your feed','Follow users and discover public playlists.')}<div class="px-3 pt-3"><button class="pill-btn primary w-100 justify-content-center" onclick="openAuth()"><i class="bi bi-box-arrow-in-right"></i> Sign in</button></div></div>`;
    return;
  }
  const validTabs = SOCIAL_TABS.map(t => t.key);
  if(!validTabs.includes(tab)) tab = 'feed';
  const me = MMAuth.user, name = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username || 'User '+me.id;
  MAIN().innerHTML = `<div class="pb-4"><div class="social-head">${avatarHtml(me.photo_url, MMAuth.initials(), 'avatar-lg')}<div class="social-head-text"><div class="social-head-name text-truncate">${esc(name)}</div><div class="social-head-sub">Your social hub</div></div><a class="icon-btn" href="${SCOPE}u/${esc(me.id)}" data-link title="My profile"><i class="bi bi-person"></i></a></div>${socialTabsHtml(tab)}<div id="socialTabBody"></div></div>`;
  if(tab === 'feed'){
    const body = document.getElementById('socialTabBody');
    if(body) body.innerHTML = `<div id="feedList"></div><div id="feedSentinel" class="feed-sentinel"></div>`;
    await socialLoadFeed(false);
    attachFeedObserver();
  }
  else if(tab === 'following') await socialRenderFollowing();
  else if(tab === 'followers') await socialRenderFollowers();
  else if(tab === 'discover') socialRenderDiscover();
  else if(tab === 'playlists') socialRenderMyPlaylists();
  reindexActionButtons();
  refreshLikes();
}

/* ══ STATS ═══════════════════════════════════════════════════════════════════ */
function viewStats(){
  const s = getStats(), tk = s.tracks||{}, days = s.days||{}, totalMs = s.totalMs||0, plays = s.plays||0,
        mins = Math.round(totalMs/6e4), hours = Math.floor(mins/60), remMins = mins%60,
        unique = Object.keys(tk).length,
        entries = Object.entries(tk).map(([id,v]) => ({id, ...v})),
        topTracks = [...entries].sort((a,b) => (b.ms||0)-(a.ms||0));
  const topArtists = (() => {
    const m = new Map();
    for(const t of entries){
      if(!t.artist) continue;
      const k = t.artist, cur = m.get(k) || {name:k, artistId:t.artistId||'', ms:0, count:0, artwork:''};
      cur.ms += t.ms||0; cur.count += t.count||0;
      if(t.artistArtwork) cur.artwork = t.artistArtwork;
      else if(!cur.artwork && t.artwork) cur.artwork = t.artwork;
      if(!cur.artwork && t.artistId){ const ca = getCached('artist', t.artistId); if(ca) cur.artwork = getArtwork(ca, 300) || '' }
      if(!cur.artistId && t.artistId) cur.artistId = t.artistId;
      m.set(k, cur);
    }
    return [...m.values()].sort((a,b) => b.ms-a.ms).slice(0,12);
  })();
  const dayKey = ts => new Date(ts).toISOString().slice(0,10),
        daySet = new Set(Object.keys(days));
  for(const t of entries) if(t.lastAt) daySet.add(dayKey(t.lastAt));
  for(const r of getRecentlyPlayed()) if(r.at) daySet.add(dayKey(r.at));
  let streak = 0; const d = new Date();
  for(;;){ if(daySet.has(dayKey(d.getTime()))){ streak++; d.setDate(d.getDate()-1) } else break }
  const week = [], today = new Date();
  for(let i=6;i>=0;i--){ const dd = new Date(today); dd.setDate(dd.getDate()-i); const k = dayKey(dd.getTime()); week.push({k, label:dd.toLocaleDateString(undefined,{weekday:'short'}).slice(0,2), ms:days[k]||0}) }
  const weekMax = Math.max(1, ...week.map(w => w.ms)),
        dlActive = DL.active().length + DL.activeBatches().length,
        dlReady = DL.ready().length + DL.readyBatches().length,
        dlFailed = DL.failed().length + DL.failedBatches().length,
        dlTotal = dlActive + dlReady + dlFailed;
  let h = libraryTabs('stats');
  h += `<div class="px-3 pt-4 pb-2"><div class="fw-bold">Your listening</div><div class="text-secondary" style="font-size:.8rem">All-time statistics</div></div>`;
  h += `<div class="stat-grid"><div class="stat-card"><div class="n">${hours?`${hours}<span style="font-size:.6em;opacity:.7">h</span> ${remMins}<span style="font-size:.6em;opacity:.7">m</span>`:`${mins}<span style="font-size:.6em;opacity:.7">m</span>`}</div><div class="l">Total listening</div></div><div class="stat-card"><div class="n">${plays.toLocaleString()}</div><div class="l">Total plays</div></div><div class="stat-card"><div class="n">${unique}</div><div class="l">Unique tracks</div></div><div class="stat-card"><div class="n">${streak>0?`${streak}<span style="font-size:.6em;opacity:.7">🔥</span>`:'—'}</div><div class="l">Day streak</div></div></div>`;
  if(dlTotal > 0){
    h += secTitle('Downloads');
    h += `<div class="stat-grid"><div class="stat-card" style="cursor:pointer" onclick="go('/library/downloads')"><div class="n text-info">${dlActive}</div><div class="l">In progress</div></div><div class="stat-card" style="cursor:pointer" onclick="go('/library/downloads')"><div class="n text-warning">${dlReady}</div><div class="l">Ready to save</div></div><div class="stat-card" style="cursor:pointer" onclick="go('/library/downloads')"><div class="n ${dlFailed>0?'text-danger':''}">${dlFailed}</div><div class="l">Failed</div></div><div class="stat-card" style="cursor:pointer" onclick="go('/library/downloads')"><div class="n">${cachedIds.size}</div><div class="l">Offline files</div></div></div>`;
  }
  h += secTitle('Last 7 days');
  h += `<div class="week-chart">${week.map(w => { const hh = Math.max(4, Math.round(w.ms/weekMax*76)); return `<div class="week-day"><div class="week-bar" style="height:${hh}px" title="${Math.round(w.ms/6e4)}m"></div><div class="week-lbl">${w.label}</div></div>` }).join('')}</div>`;
  if(!entries.length){
    h += emptyState('bar-chart','No stats yet','Play some tracks and check back here.');
    h += `<div class="px-3 pt-3"><button class="pill-btn w-100 justify-content-center" onclick="go('/')"><i class="bi bi-house-door"></i> Go to Home</button></div>`;
    MAIN().innerHTML = h;
    return;
  }
  if(topArtists.length){
    h += secTitle(`Top artists · ${topArtists.length}`);
    h += `<div class="mm-grid mm-grid-narrow">` + topArtists.map(a => {
      const art = a.artwork||'', minsA = Math.round(a.ms/6e4),
            dur = minsA < 1 ? '<1m' : minsA < 60 ? `${minsA}m` : `${Math.floor(minsA/60)}h ${minsA%60}m`,
            href = a.artistId ? `${SCOPE}artist/${esc(a.artistId)}` : `${SCOPE}search?q=${encodeURIComponent(a.name)}`;
      return `<a class="artist-item" href="${href}" data-link>${art ? `<img class="artist-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="artist-art artist-art-ph"><i class="bi bi-person-fill"></i></div>`}<div class="card-name text-truncate">${esc(a.name)}</div><div class="card-sub text-truncate">${dur} · ${a.count}×</div></a>`;
    }).join('') + `</div>`;
  }
  h += secTitle('Top tracks');
  h += topTracks.slice(0,30).map((t,i) => {
    const minsT = Math.round(t.ms/6e4), dur = minsT < 1 ? '<1m' : `${minsT}m`,
          trackObj = {trackId:t.id, trackName:t.name, artistName:t.artist, artistId:t.artistId||'', artworkUrl:t.artwork||''};
    return trackRow(trackObj, {extraSub:`${t.count}× · ${dur}`});
  }).join('');
  h += `<div class="px-3 pt-4 pb-2 d-flex gap-2"><button class="pill-btn flex-fill justify-content-center" onclick="go('/library/history')"><i class="bi bi-clock-history"></i> History</button><button class="pill-btn danger sm" onclick="resetStats(); viewStats()"><i class="bi bi-trash3"></i> Reset</button></div>`;
  MAIN().innerHTML = h;
  reindexActionButtons();
}
function viewHistory(){
  const r = getRecentlyPlayed(), stats = getStats().tracks||{};
  _pageTracks = r.map(x => ({wrapperType:'track', trackId:x.trackId, trackName:x.trackName, artistName:x.artistName, artistId:x.artistId, collectionName:x.collectionName, collectionId:x.collectionId, attachments:{artworkUrls:x.artworkUrl?[{url:x.artworkUrl}]:[]}}));
  let html = libraryTabs('history');
  if(!r.length) html += emptyState('clock-history','No history yet','Tracks you play appear here.');
  else {
    html += `<div class="d-flex align-items-center px-3 pt-4 pb-2"><div class="flex-grow-1 fw-bold">Recently played</div><button class="pill-btn sm" onclick="clearHistory()">Clear</button></div>`;
    html += r.map(x => {
      const s = stats[String(x.trackId)], pl = s ? ` · ${s.count}×` : '', al = artistLink(x, true);
      return `<div class="hist-row row-item"><button class="row-play" data-play-id="${esc(x.trackId)}" onclick="playById('${esc(x.trackId)}')"><i class="bi bi-play-fill"></i></button><a class="row-info" href="${SCOPE}track/${esc(x.trackId)}" data-link>${x.artworkUrl ? `<img class="row-art" src="${esc(x.artworkUrl)}" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="min-w-0 flex-grow-1"><div class="row-title text-truncate">${esc(x.trackName||'Track')}</div><div class="row-sub text-truncate">${al} · ${fmtAgo(x.at)}${pl}</div></div></a><button class="icon-btn sm" onclick="event.preventDefault();openTrackMenu('${esc(x.trackId)}')"><i class="bi bi-three-dots-vertical"></i></button></div>`;
    }).join('');
  }
  MAIN().innerHTML = html;
  reindexActionButtons();
}
function clearHistory(){
  ls.set(KEY.plays, []);
  toast('History cleared');
  Notify.show('History cleared','',{category:'misc'});
  viewHistory();
  try{ if(MMSync.enabled()) MMSync.push(true).catch(()=>{}) }catch{}
}
function smartOpen(kind){
  const s = getStats(), tracks = s.tracks||{}, likes = getLikes();
  let list = [], title = '';
  if(kind === 'most'){
    list = Object.entries(tracks).map(([id,v]) => ({id, ...v})).sort((a,b) => (b.ms||0)-(a.ms||0)).slice(0,50).map(t => ({wrapperType:'track', trackId:t.id, trackName:t.name, artistName:t.artist, attachments:{artworkUrls:t.artwork?[{url:t.artwork}]:[]}}));
    title = 'Most Played';
  } else if(kind === 'recent'){
    list = [...likes].sort((a,b) => (b.addedAt||0)-(a.addedAt||0)).slice(0,50).map(l => ({wrapperType:'track', trackId:l.trackId, trackName:l.trackName, artistName:l.artistName, artistId:l.artistId, attachments:{artworkUrls:l.artworkUrl?[{url:l.artworkUrl}]:[]}}));
    title = 'Recently Added';
  } else {
    const now = Date.now();
    list = likes.filter(l => { const st = tracks[String(l.trackId)]; return !st || now-(st.lastAt||0) > 30*864e5 }).map(l => ({wrapperType:'track', trackId:l.trackId, trackName:l.trackName, artistName:l.artistName, artistId:l.artistId, attachments:{artworkUrls:l.artworkUrl?[{url:l.artworkUrl}]:[]}}));
    title = 'Forgotten Favorites';
  }
  const ids = list.map(t => t.trackId).join(','), firstId = list[0] ? String(list[0].trackId) : '';
  let h = `<div class="pb-4">${backBtn()}<div class="px-3 pt-1"><div style="font-size:1.35rem;font-weight:800">${title}</div><div class="text-secondary" style="font-size:.8rem">${list.length} tracks</div></div>`;
  if(list.length) h += `<div class="lib-tabs"><button class="pill-btn success" data-play-id="${esc(firstId)}" onclick="playIds('${esc(ids)}')"><i class="bi bi-play-fill"></i> Play all</button><button class="pill-btn" onclick="addAllToQueue(_pageTracks)"><i class="bi bi-list-ul"></i> Queue</button></div>`;
  _pageTracks = list;
  h += list.length ? list.map(t => trackRow(t)).join('') : emptyState('music-note','Nothing here yet');
  h += `</div>`;
  MAIN().innerHTML = h;
  reindexActionButtons(); refreshLikes();
}

/* ══ DOWNLOADS VIEW ══════════════════════════════════════════════════════════ */
let dlUnsub = null;
function renderDownloads(){
  MAIN().innerHTML = libraryTabs('downloads') + `<div id="dlContent"><div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div></div>`;
  if(dlUnsub) dlUnsub();
  dlUnsub = DL.onChange(() => { if(isLibDl()) updateDlLists() });
  updateDlLists();
}
async function updateDlLists(forceFull=false){
  const wrap = $('#dlContent'); if(!wrap) return;
  const act = DL.active(), rdy = DL.ready(), fail = DL.failed(),
        actB = DL.activeBatches(), rdyB = DL.readyBatches(), failB = DL.failedBatches(),
        all = await cacheAll(), ts = all.reduce((s,e) => s+(e.size||0), 0);
  const ids = a => a.map(x => String(x.trackId)).join(','),
        sig = ['a:'+ids(act), 'ab:'+ids(actB), 'r:'+ids(rdy), 'rb:'+ids(rdyB), 'f:'+ids(fail), 'fb:'+ids(failB), 's:'+all.map(e => e.trackId).join(',')].join('|');
  if(!forceFull && wrap.dataset.dlSig === sig && wrap.querySelector('[data-dl-summary]')){ patchDlDynamic(act, actB, rdy, rdyB, fail, failB, ts, all); return }
  wrap.dataset.dlSig = sig;
  const totalAct = act.length + actB.length, totalRdy = rdy.length + rdyB.length, totalFail = fail.length + failB.length,
        hasAny = all.length || totalAct || totalRdy || totalFail;
  let html = '';
  if(hasAny){
    let remaining = act.length;
    for(const b of actB) remaining += Math.max(0, (b.trackCount||0) - (b.readyCount||0));
    let readyFiles = rdy.length;
    for(const b of rdyB) readyFiles += b.trackCount || 0;
    let pctSum = 0, pctN = 0;
    for(const it of act){ pctSum += it.percent||0; pctN++ }
    for(const b of actB){ pctSum += b.percent||0; pctN++ }
    const avgPct = pctN ? Math.round(pctSum/pctN) : 0;
    html += `<div data-dl-summary>`;
    html += `<div class="px-3 pt-4 pb-2"><div class="d-flex align-items-center gap-2"><div class="flex-grow-1 min-w-0"><div class="fw-bold">Offline & Downloads</div><div class="text-secondary" style="font-size:.74rem" data-dl-header-sub>${all.length} file${all.length!==1?'s':''} · ${fmtSize(ts)} saved${remaining?' · '+remaining+' pending':''}</div></div>${all.length?`<button class="icon-btn sm" onclick="exportAllCached()" title="Export all"><i class="bi bi-file-earmark-arrow-down"></i></button><button class="icon-btn sm text-danger" onclick="clearAllCache()" title="Clear all"><i class="bi bi-trash3"></i></button>`:''}</div></div>`;
    html += `<div class="stat-grid" style="padding:0 16px 8px"><div class="stat-card"><div class="n" data-dl-stat="saved">${all.length}</div><div class="l">Saved</div></div><div class="stat-card"><div class="n" style="font-size:1.05rem" data-dl-stat="size">${fmtSize(ts)}</div><div class="l">Total size</div></div>`;
    if(totalAct) html += `<div class="stat-card" style="cursor:pointer" onclick="dlScrollTo('active')"><div class="n text-info" data-dl-stat="progress">${totalAct}<span style="font-size:.5em;opacity:.75;font-weight:600"> · ${avgPct}%</span></div><div class="l">In progress</div></div>`;
    if(totalRdy) html += `<div class="stat-card" style="cursor:pointer" onclick="dlScrollTo('ready')"><div class="n text-warning" data-dl-stat="ready">${readyFiles||totalRdy}</div><div class="l">Ready file${readyFiles!==1?'s':''}</div></div>`;
    if(totalFail) html += `<div class="stat-card" style="cursor:pointer" onclick="dlScrollTo('failed')"><div class="n text-danger" data-dl-stat="failed">${totalFail}</div><div class="l">Failed</div></div>`;
    html += `</div>`;
    if(totalAct) html += `<div style="padding:2px 16px 12px" data-dl-overall><div class="d-flex align-items-center gap-2 mb-1" style="font-size:.72rem"><i class="bi bi-cloud-arrow-down text-info"></i><span class="text-info fw-bold" data-dl-overall-label>${remaining} track${remaining!==1?'s':''} remaining</span><span class="flex-grow-1"></span><span class="text-secondary fw-bold" data-dl-overall-pct>${avgPct}%</span></div>${progressHtml(avgPct, 'bg-info')}</div>`;
    html += `</div>`;
  }
  if(actB.length || act.length){
    html += `<div id="dl-sec-active">`;
    if(actB.length){ html += `<h6 class="sec-title tight">Albums / Artists · ${actB.length}</h6>`; html += actB.map(dlBatchRowHtml).join('') }
    if(act.length){ html += `<h6 class="sec-title tight">Tracks · ${act.length}</h6>`; html += act.map(it => dlRowHtml(it)).join('') }
    html += `</div>`;
  }
  if(rdyB.length || rdy.length){
    html += `<div id="dl-sec-ready">`;
    if(rdyB.length){ html += `<h6 class="sec-title tight">Ready batches · ${rdyB.length}</h6>`; html += rdyB.map(dlBatchRowHtml).join('') }
    if(rdy.length){ html += `<h6 class="sec-title tight">Ready tracks · ${rdy.length}</h6>`; html += rdy.map(it => dlRowHtml(it)).join('') }
    html += `</div>`;
  }
  if(failB.length || fail.length){
    html += `<div id="dl-sec-failed">`;
    if(failB.length){ html += `<h6 class="sec-title tight">Failed batches · ${failB.length}</h6>`; html += failB.map(dlBatchRowHtml).join('') }
    if(fail.length){ html += `<h6 class="sec-title tight">Failed tracks · ${fail.length}</h6>`; html += fail.map(it => dlRowHtml(it)).join('') }
    html += `</div>`;
  }
  if(!hasAny) html += emptyState('download','Nothing offline yet','Download a track from any menu.');
  else if(all.length){
    html += `<div id="dl-sec-saved">`;
    html += `<div class="d-flex align-items-center px-3 pt-4 pb-2"><div class="flex-grow-1 min-w-0"><div class="fw-bold">Available offline</div><div class="text-secondary" style="font-size:.74rem">${all.length} track${all.length!==1?'s':''} · ${fmtSize(ts)}</div></div></div>`;
    html += all.map(e => {
      const m = e.meta||{}, art = m.artwork || getArtwork({attachments:m.attachments}, 100) || '',
            id = String(e.trackId), pl = Player.track && String(Player.track.trackId) === id,
            al = artistLink({artistName:m.artist||m.artistName||'', artistId:m.artistId}, true);
      return `<div class="dl-row row-item"><button class="row-play ${pl&&Player.playing?'playing':''}" data-play-id="${esc(id)}" onclick="playCachedById('${esc(id)}')"><i class="bi ${pl&&Player.playing?'bi-pause-fill':'bi-play-fill'}"></i></button><a class="row-info" href="${SCOPE}track/${esc(id)}" data-link>${art ? `<img class="row-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="min-w-0 flex-grow-1"><div class="row-title text-truncate">${esc(m.name||m.trackName||id)}</div><div class="row-sub text-truncate">${al} · ${fmtSize(e.size||0)}</div></div></a><button class="icon-btn sm text-primary" onclick="exportCached('${esc(id)}')"><i class="bi bi-file-earmark-arrow-down"></i></button><button class="icon-btn sm text-danger" onclick="removeCached('${esc(id)}')"><i class="bi bi-trash3"></i></button></div>`;
    }).join('');
    html += `</div>`;
  }
  else html += `<div class="state" style="padding:20px 24px"><p style="font-size:.8rem">Nothing saved yet — start a download above.</p></div>`;
  wrap.innerHTML = html;
}
function dlTrackStatusLabel(it){ return {queued:'Queued', crawling:'Crawling', saving:'Downloading', ready:'Ready', failed:'Failed', paused:'Paused'}[it.status] || it.status }
function dlBatchStatusLabel(it){ const ready = it.readyCount||0, total = it.trackCount||0, pct = it.percent||0; return {queued:'Queued', crawling:`Crawling · ${ready}/${total}`, saving:`Downloading · ${pct}%`, ready:`Ready · ${ready}/${total}`, completed:'Saved', failed:`Failed · ${ready}/${total}`}[it.status] || it.status }
window.dlOpenRow = function(ev, el){
  if(!el) return;
  if(ev && ev.target && ev.target.closest('button,a,input,textarea,select')) return;
  const t = el.dataset.viewTarget; if(!t) return;
  go(t);
};
window.dlRowMenu = function(ev, el, kind){
  if(ev){ ev.preventDefault(); ev.stopPropagation() }
  if(!el) return;
  if(ev && ev.target && ev.target.closest && ev.target.closest('[data-play-id]')) return;
};
function patchDlDynamic(act, actB, rdy, rdyB, fail, failB, ts, all){
  const wrap = $('#dlContent'); if(!wrap) return;
  const find = id => wrap.querySelector(`[data-dl-id="${CSS.escape(String(id))}"]`);
  const patchProgress = (el, pct, status) => {
    const prog = el.querySelector('[data-dl-progress]'); if(!prog) return;
    const bar = prog.querySelector('div'); if(bar) bar.style.width = Math.max(0, Math.min(100, pct))+'%';
    prog.classList.toggle('saving', status === 'saving');
    prog.classList.toggle('ready', status === 'ready');
    prog.classList.toggle('error', status === 'failed' || status === 'paused');
  };
  const patchStatus = (el, label, cls) => { const s = el.querySelector('.dl-status'); if(s){ s.textContent = label; s.className = 'dl-status '+cls } };
  for(const it of act){
    const el = find(it.trackId); if(!el) continue;
    patchProgress(el, it.percent||0, it.status);
    patchStatus(el, dlTrackStatusLabel(it), {queued:'queued', crawling:'crawling', saving:'saving'}[it.status] || 'queued');
    if(it.status === 'saving' && it.totalBytes){
      const sub = el.querySelector('[data-dl-sub]');
      if(sub){ const al = it.artistName ? artistLink(it, true) : esc(it.artist||''); sub.innerHTML = `${al} · ${fmtSize(it.bytes||0)} / ${fmtSize(it.totalBytes)}` }
    }
  }
  for(const it of actB){
    const el = find(it.trackId); if(!el) continue;
    patchProgress(el, it.percent||0, it.status);
    patchStatus(el, dlBatchStatusLabel(it), {queued:'queued', crawling:'crawling', saving:'saving'}[it.status] || 'queued');
  }
  const sum = wrap.querySelector('[data-dl-summary]'); if(!sum) return;
  const totalAct = act.length + actB.length, totalRdy = rdy.length + rdyB.length, totalFail = fail.length + failB.length;
  let remaining = act.length;
  for(const b of actB) remaining += Math.max(0, (b.trackCount||0) - (b.readyCount||0));
  let readyFiles = rdy.length;
  for(const b of rdyB) readyFiles += b.trackCount||0;
  let pctSum = 0, pctN = 0;
  for(const it of act){ pctSum += it.percent||0; pctN++ }
  for(const b of actB){ pctSum += b.percent||0; pctN++ }
  const avgPct = pctN ? Math.round(pctSum/pctN) : 0;
  const setStat = (key, val) => { const el = sum.querySelector(`[data-dl-stat="${key}"]`); if(el) el.innerHTML = val };
  setStat('saved', String(all.length));
  setStat('size', fmtSize(ts));
  if(totalAct) setStat('progress', `${totalAct}<span style="font-size:.5em;opacity:.75;font-weight:600"> · ${avgPct}%</span>`);
  if(totalRdy) setStat('ready', String(readyFiles||totalRdy));
  if(totalFail) setStat('failed', String(totalFail));
  const hs = sum.querySelector('[data-dl-header-sub]');
  if(hs) hs.textContent = `${all.length} file${all.length!==1?'s':''} · ${fmtSize(ts)} saved${remaining?' · '+remaining+' pending':''}`;
  const overall = sum.querySelector('[data-dl-overall]');
  if(overall){
    const lbl = overall.querySelector('[data-dl-overall-label]');
    if(lbl) lbl.textContent = `${remaining} track${remaining!==1?'s':''} remaining`;
    const pctEl = overall.querySelector('[data-dl-overall-pct]');
    if(pctEl) pctEl.textContent = avgPct+'%';
    const bar = overall.querySelector('.progress-bar');
    if(bar) bar.style.width = avgPct+'%';
  }
}
window.dlScrollTo = function(sec){ const el = document.getElementById('dl-sec-'+sec); if(el) el.scrollIntoView({behavior:'smooth', block:'start'}) };
function dlBatchRowHtml(it){
  const ready = it.readyCount||0, total = it.trackCount||0, pct = it.percent||0,
        act = ['queued','crawling','saving'].includes(it.status),
        rdy = it.status === 'ready', fail = it.status === 'failed',
        section = act ? 'active' : rdy ? 'ready' : fail ? 'failed' : 'completed',
        lb = dlBatchStatusLabel(it),
        lc = {queued:'queued', crawling:'crawling', saving:'saving', ready:'ready', failed:'error'}[it.status] || 'queued',
        subTypeLabel = it.subType === 'artist' ? 'Artist' : 'Album',
        sub = [subTypeLabel, it.artist||'', `${total} track${total!==1?'s':''}`].filter(Boolean).join(' · '),
        art = it.artwork||'',
        viewTarget = it.subType === 'artist' ? `/artist/${esc(it.sourceId)}` : `/album/${esc(it.sourceId)}`;
  let ra = '';
  if(act) ra = `<button class="icon-btn sm text-danger" onclick="event.stopPropagation();DL.remove('${esc(it.trackId)}')" title="Cancel"><i class="bi bi-x-lg"></i></button>`;
  else if(rdy){
  if(it.subType === 'artist'){
    ra = `<button class="pill-btn primary sm" onclick="event.stopPropagation();go('/artist/${esc(it.sourceId)}')"><i class="bi bi-eye"></i> View</button><button class="icon-btn sm text-danger" onclick="event.stopPropagation();DL.remove('${esc(it.trackId)}')" title="Dismiss"><i class="bi bi-x-lg"></i></button>`;
  } else {
    ra = `<button class="pill-btn success sm" onclick="event.stopPropagation();saveBatch('${esc(it.trackId)}')"><i class="bi bi-download"></i> Save</button><button class="icon-btn sm text-danger" onclick="event.stopPropagation();DL.remove('${esc(it.trackId)}')" title="Dismiss"><i class="bi bi-x-lg"></i></button>`;
  }
}
  else if(fail) ra = `<button class="pill-btn danger sm" onclick="event.stopPropagation();DL.retry('${esc(it.trackId)}')"><i class="bi bi-arrow-repeat"></i></button><button class="icon-btn sm" onclick="event.stopPropagation();DL.remove('${esc(it.trackId)}')"><i class="bi bi-x-lg"></i></button>`;
  return `<div class="dl-row" data-dl-id="${esc(it.trackId)}" data-dl-kind="batch" data-dl-section="${section}" data-view-target="${esc(viewTarget)}" style="cursor:pointer" onclick="dlOpenRow(event,this)" oncontextmenu="dlRowMenu(event,this,'batch');return false">${art ? `<img class="row-art" src="${esc(art)}" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-disc"></i></div>`}<div class="dl-body"><div class="d-flex align-items-center gap-2 mb-1"><div class="dl-title text-truncate flex-grow-1 min-w-0">${esc(it.name||'Batch')}</div><span class="dl-status ${lc}">${lb}</span></div><div class="dl-sub text-truncate" data-dl-sub>${esc(sub)}</div>${act||rdy?`<div class="dl-progress ${it.status==='saving'?'saving':it.status==='ready'?'ready':''}" data-dl-progress><div style="width:${pct}%"></div></div>`:''}${fail&&it.error?`<div class="dl-sub text-danger text-truncate">${esc(it.error)}</div>`:''}</div>${ra}</div>`;
}
window.saveBatch = async function(batchId){
  Notify.request();
  const batch = DL.get(batchId); if(!batch) return;
  toast('Saving '+batch.name+'…');
  DL.update(batchId, {status:'saving', percent:0});
  await DL._saveBatch(batch);
};
function dlRowHtml(it){
  const act = ['queued','crawling','saving'].includes(it.status),
        rdy = it.status === 'ready', fail = ['failed','paused'].includes(it.status),
        section = act ? 'active' : rdy ? 'ready' : fail ? 'failed' : 'completed',
        lb = dlTrackStatusLabel(it),
        lc = {queued:'queued', crawling:'crawling', saving:'saving', ready:'ready', failed:'error', paused:'error'}[it.status] || 'queued',
        pct = it.percent||0,
        pc = fail ? 'error' : it.status === 'saving' ? 'saving' : it.status === 'ready' ? 'ready' : '';
  let ra = '';
  if(act) ra = `<button class="icon-btn sm text-danger" onclick="event.stopPropagation();DL.remove('${esc(it.trackId)}')"><i class="bi bi-x-lg"></i></button>`;
  else if(rdy) ra = `<button class="pill-btn success sm" onclick="event.stopPropagation();DL.retry('${esc(it.trackId)}')"><i class="bi bi-download"></i> Save</button><button class="icon-btn sm text-danger" onclick="event.stopPropagation();DL.remove('${esc(it.trackId)}')"><i class="bi bi-x-lg"></i></button>`;
  else if(fail) ra = `<button class="pill-btn danger sm" onclick="event.stopPropagation();DL.retry('${esc(it.trackId)}')"><i class="bi bi-arrow-repeat"></i> Retry</button><button class="icon-btn sm" onclick="event.stopPropagation();DL.remove('${esc(it.trackId)}')"><i class="bi bi-x-lg"></i></button>`;
  const si = it.status === 'saving' && it.totalBytes ? `${fmtSize(it.bytes||0)} / ${fmtSize(it.totalBytes)}` : '',
        al = it.artistName ? artistLink(it, true) : esc(it.artist||'');
  return `<div class="dl-row" data-dl-id="${esc(it.trackId)}" data-dl-kind="track" data-dl-section="${section}" data-view-target="/track/${esc(it.trackId)}" style="cursor:pointer" onclick="dlOpenRow(event,this)" oncontextmenu="dlRowMenu(event,this,'track');return false">${it.artwork ? `<img class="row-art" src="${esc(it.artwork)}" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-music-note"></i></div>`}<div class="dl-body"><div class="d-flex align-items-center gap-2 mb-1"><div class="dl-title text-truncate flex-grow-1 min-w-0">${esc(it.name)}</div><span class="dl-status ${lc}">${lb}</span></div><div class="dl-sub text-truncate" data-dl-sub>${al}${si?' · '+si:''}</div>${act||rdy?`<div class="dl-progress ${pc}" data-dl-progress><div style="width:${pct}%"></div></div>`:''}${fail&&it.error?`<div class="dl-sub text-danger text-truncate">${esc(it.error)}</div>`:''}</div>${ra}</div>`;
}

/* ══ SETTINGS ════════════════════════════════════════════════════════════════ */
function openSettings(){ sheet('#sheetSettings').show(); updateSettingsSheet() }
function _onSetThemeClick(e){
  const b = e.target.closest('button[data-val]'); if(!b) return;
  setSetting('theme', b.dataset.val);
  $$('#setTheme button').forEach(x => x.classList.toggle('on', x === b));
}
function _onSetAnimationsChange(e){ setSetting('animations', e.target.checked) }
function _onSetAutoThemeChange(e){ setSetting('autoTheme', e.target.checked); autoTheme() }
function _onSetAppBgChange(e){ setSetting('appBg', e.target.checked) }
function _onSetAutoSaveAfterCrawlChange(e){ setSetting('autoSaveAfterCrawl', e.target.checked) }
function _onSetAutoSavePlayedChange(e){ setSetting('autoSavePlayed', e.target.checked); toast(e.target.checked ? 'Auto-save played tracks on' : 'Auto-save played tracks off') }
function _onSetSaveDataChange(e){
  const on = e.target.checked;
  setSetting('saveData', on);
  _syncSaveDataAttr();
  toast(on ? 'Save-data mode on · smaller images' : 'Save-data mode off');
  if(on) try{ Notify.show('Save-data mode', 'Images will load at reduced quality to save bandwidth.', {category:'misc', always:true}) }catch{}
}
function _onSetAutoExtendQueueChange(e){ setSetting('autoExtendQueue', e.target.checked); toast(e.target.checked ? 'Auto-extend queue on' : 'Auto-extend queue off') }
function _onSetCrossfadeClick(e){
  const b = e.target.closest('button[data-val]'); if(!b) return;
  setSetting('crossfade', Number(b.dataset.val));
  $$('#setCrossfade button').forEach(z => z.classList.toggle('on', z === b));
}
function _onSetSleepFadeChange(e){ setSetting('sleepFade', e.target.checked) }
function _onSetAutoScrollChange(e){ setSetting('autoScrollLyrics', e.target.checked) }
function _onSetAutoRetryChange(e){ setSetting('autoRetry', e.target.checked) }
function _onSetLyricsTranslationChange(e){ setSetting('lyricsTranslation', e.target.checked); refreshCurrentView() }
function _onSetTranslationTargetChange(e){ setSetting('translationLang', e.target.value); toast('Translating to '+e.target.value); refreshCurrentView() }
function _onSetTranslationSourceChange(e){ setSetting('translationSourceLang', e.target.value); refreshCurrentView() }
function _onSetSyncEnabledChange(e){ setSetting('syncEnabled', e.target.checked); updateSettingsSheet(); if(e.target.checked && MMAuth.user) MMSync.bootstrap().catch(()=>{}) }
function _onSetNotifyDownloadsChange(e){ setSetting('notifyDownloads', e.target.checked) }
function _onSetNotifyCrawlChange(e){ setSetting('notifyCrawl', e.target.checked) }
function _onSetNotifySyncChange(e){ setSetting('notifySync', e.target.checked) }
function _onSetNotifyAuthChange(e){ setSetting('notifyAuth', e.target.checked) }
function _onSetNotifyPlaylistChange(e){ setSetting('notifyPlaylist', e.target.checked) }
const _SETTING_EVENTS = [
  ['#setTheme','click',_onSetThemeClick],
  ['#setAnimations','change',_onSetAnimationsChange],
  ['#setAutoTheme','change',_onSetAutoThemeChange],
  ['#setAppBg','change',_onSetAppBgChange],
  ['#setAutoSaveAfterCrawl','change',_onSetAutoSaveAfterCrawlChange],
  ['#setAutoSavePlayed','change',_onSetAutoSavePlayedChange],
  ['#setSaveData','change',_onSetSaveDataChange],
  ['#setAutoExtendQueue','change',_onSetAutoExtendQueueChange],
  ['#setCrossfade','click',_onSetCrossfadeClick],
  ['#setSleepFade','change',_onSetSleepFadeChange],
  ['#setAutoScroll','change',_onSetAutoScrollChange],
  ['#setAutoRetry','change',_onSetAutoRetryChange],
  ['#setLyricsTranslation','change',_onSetLyricsTranslationChange],
  ['#setTranslationTarget','change',_onSetTranslationTargetChange],
  ['#setTranslationSource','change',_onSetTranslationSourceChange],
  ['#setSyncEnabled','change',_onSetSyncEnabledChange],
  ['#setNotifyDownloads','change',_onSetNotifyDownloadsChange],
  ['#setNotifyCrawl','change',_onSetNotifyCrawlChange],
  ['#setNotifySync','change',_onSetNotifySyncChange],
  ['#setNotifyAuth','change',_onSetNotifyAuthChange],
  ['#setNotifyPlaylist','change',_onSetNotifyPlaylistChange]
];
function _wireSettingEvents(){
  for(const [sel, ev, fn] of _SETTING_EVENTS){
    const el = $(sel);
    if(!el || el.__mmWired) continue;
    el.__mmWired = true;
    el.addEventListener(ev, fn);
  }
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wireSettingEvents, {once:true});
else _wireSettingEvents();
async function updateSettingsSheet(){
  _wireSettingEvents();
  const s = getSettings();
  $$('#setTheme button').forEach(b => b.classList.toggle('on', b.dataset.val === s.theme));
  const an = $('#setAnimations'); if(an) an.checked = !!s.animations;
  const at = $('#setAutoTheme'); if(at) at.checked = !!s.autoTheme;
  const abg = $('#setAppBg'); if(abg) abg.checked = !!s.appBg;
  const asac = $('#setAutoSaveAfterCrawl'); if(asac) asac.checked = !!s.autoSaveAfterCrawl;
  const asap = $('#setAutoSavePlayed'); if(asap) asap.checked = !!s.autoSavePlayed;
  const asd = $('#setSaveData'); if(asd) asd.checked = !!s.saveData;
  const aeq = $('#setAutoExtendQueue'); if(aeq) aeq.checked = !!s.autoExtendQueue;
  const cf = $('#setCrossfade');
  if(cf){ const c = String(s.crossfade ?? 0); cf.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.val === c)) }
  const sf = $('#setSleepFade'); if(sf) sf.checked = s.sleepFade !== false;
  const as = $('#setAutoScroll'); if(as) as.checked = !!s.autoScrollLyrics;
  const ar = $('#setAutoRetry'); if(ar) ar.checked = !!s.autoRetry;
  const lt = $('#setLyricsTranslation'); if(lt) lt.checked = s.lyricsTranslation !== false;
  const tt = $('#setTranslationTarget'); if(tt) tt.value = s.translationLang || 'en';
  const ts = $('#setTranslationSource'); if(ts) ts.value = s.translationSourceLang || 'en';
  const sy = $('#setSyncEnabled'); if(sy) sy.checked = s.syncEnabled !== false;
  const nd = $('#setNotifyDownloads'); if(nd) nd.checked = s.notifyDownloads !== false;
  const nc = $('#setNotifyCrawl'); if(nc) nc.checked = s.notifyCrawl !== false;
  const ns = $('#setNotifySync'); if(ns) ns.checked = s.notifySync !== false;
  const na = $('#setNotifyAuth'); if(na) na.checked = s.notifyAuth !== false;
  const np = $('#setNotifyPlaylist'); if(np) np.checked = s.notifyPlaylist !== false;
  const syi = $('#setSyncInfo');
  if(syi){
    if(!MMAuth.user) syi.textContent = 'Sign in to sync';
    else if(!MMSync.enabled()) syi.textContent = 'Sync is off';
    else if(MMSync._lastError) syi.textContent = 'Last error: '+MMSync._lastError;
    else syi.textContent = 'Synced with your account';
  }
  const acc = $('#accentRow');
  if(acc){
    const cur = s.accent || 'purple',
          autoBtn = `<button class="accent-dot auto ${cur === 'auto' ? 'on' : ''}" data-accent="auto" aria-label="Auto"><i class="bi bi-magic"></i></button>`,
          rest = Object.entries(ACCENTS).filter(([k,v]) => k !== 'auto' && v).map(([k,[a,b]]) => `<button class="accent-dot ${k === cur ? 'on' : ''}" data-accent="${k}" style="background:linear-gradient(135deg,${a},${b})" aria-label="${k}"></button>`).join('');
    acc.innerHTML = autoBtn + rest;
    if(!acc.__w){
      acc.__w = 1;
      acc.addEventListener('click', e => {
        const b = e.target.closest('[data-accent]'); if(!b) return;
        const n = b.dataset.accent;
        setSetting('accent', n);
        applySettings();
        acc.querySelectorAll('.accent-dot').forEach(d => d.classList.toggle('on', d === b));
        haptic(8);
      });
    }
  }
  const bh = $('#backupHost');
  if(bh && !bh.__w){
    bh.__w = 1;
    bh.innerHTML = `<div class="settings-row"><i class="bi bi-box-arrow-up"></i><div class="sr-body"><div class="sr-title">Export backup</div><div class="sr-sub">Download likes, playlists & settings</div></div><div class="sr-control"><button class="pill-btn primary sm" onclick="exportData()"><i class="bi bi-download"></i> Export</button></div></div><div class="settings-row"><i class="bi bi-box-arrow-in-down"></i><div class="sr-body"><div class="sr-title">Import backup</div><div class="sr-sub">Restore from a JSON file</div></div><div class="sr-control"><button class="pill-btn sm" onclick="importData()"><i class="bi bi-upload"></i> Import</button></div></div><div class="settings-row"><i class="bi bi-arrow-clockwise"></i><div class="sr-body"><div class="sr-title">Force refresh app</div><div class="sr-sub">Clear cache & reload all assets</div></div><div class="sr-control"><button class="pill-btn warn sm" onclick="forceRefresh()"><i class="bi bi-arrow-repeat"></i> Refresh</button></div></div>`;
  }
  try{ const all = await cacheAll(), total = all.reduce((s,e) => s+(e.size||0), 0), ci = $('#setCacheInfo'); if(ci) ci.textContent = all.length ? `${all.length} tracks · ${fmtSize(total)}` : 'Empty' }catch{}
  try{
    const est = await getStorageEstimate(), qi = $('#setQuotaInfo');
    if(qi){
      if(est && est.quota){ const pct = Math.round(est.usage/est.quota*100); qi.textContent = `${fmtSize(est.usage)} of ${fmtSize(est.quota)} (${pct}%)` }
      else qi.textContent = 'Not supported';
    }
  }catch{}
  const ri = $('#setRecentInfo');
  if(ri){ const n = ls.get(KEY.recent,[]).length; ri.textContent = n ? `${n} item${n!==1?'s':''}` : 'Empty' }
  if(window.MMAuth) MMAuth.render();
}
window.forceRefresh = async function(){
  toast('Reloading fresh sources…','info');
  try{
    if('caches' in window){ const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))) }
    if('serviceWorker' in navigator){ const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())) }
    const bust = Date.now();
    const targets = [...document.querySelectorAll('script[src]'), ...document.querySelectorAll('link[rel="stylesheet"][href]')];
    await Promise.all(targets.map(el => {
      const raw = el.getAttribute('src') || el.getAttribute('href');
      if(!raw || /^(data|blob):/i.test(raw)) return;
      try{ const u = new URL(raw, location.href); u.searchParams.set('_v', bust); return fetch(u.toString(), {cache:'no-store', credentials:'same-origin'}).catch(()=>{}) }catch{ return }
    }));
  }catch(e){ console.warn('[forceRefresh]', e) }
  try{ const url = new URL(location.href); url.searchParams.set('_v', Date.now()); location.replace(url.toString()) }
  catch{ try{ location.reload() }catch{} }
};
async function resetAppData(){
  const ok = await askConfirm('Reset all data?', 'Likes, playlists, downloads, settings and recents will be erased.', 'Reset everything');
  if(!ok) return;
  Object.values(KEY).forEach(k => ls.remove(k));
  try{ await cacheClear() }catch{}
  cachedIds.clear();
  toast('All data reset');
  Notify.show('All data reset','',{category:'misc'});
  sheet('#sheetSettings').hide();
  applySettings();
  go('/');
}
async function checkForUpdate(){
  try{
    if('serviceWorker' in navigator){
      const rs = await navigator.serviceWorker.getRegistrations();
      for(const r of rs) await r.update();
      toast('Checking for updates…','success');
    } else toast('Service worker not supported','warning');
  }catch{ toast('Update check failed','danger') }
}
function updateOnlineBanner(){
  const b = $('#offlineBanner'); if(!b) return;
  b.classList.toggle('on', !navigator.onLine);
  const p = $('#netPill'); if(p) p.classList.toggle('off', !navigator.onLine);
  if(!navigator.onLine && MMSync.enabled()) MMSync.updateIndicator('off');
}
window.addEventListener('online', () => {
  updateOnlineBanner();
  Notify.show('Back online', 'Connection restored', {category:'misc', always:true});
  if(MMSync.enabled()) MMSync.push(true).catch(()=>{});
});
window.addEventListener('offline', () => {
  updateOnlineBanner();
  Notify.show('You are offline', 'Some features may not work', {category:'misc', variant:'warning', always:true});
});
/* React to connection quality changes */
(function(){
  const c = Net.conn;
  if(!c || !c.addEventListener) return;
  let lastSave = Net.saveData, lastSlow = Net.isSlow;
  const onChange = () => {
    const s = Net.saveData, sl = Net.isSlow;
    const changed = (s !== lastSave) || (sl !== lastSlow);
    lastSave = s; lastSlow = sl;
    _syncSaveDataAttr();
    if(!changed) return;
    if(s || sl){
      toast('Slow connection detected · using smaller images','warning');
      _imgPrefetched.clear();
      if(typeof refreshPage === 'function') refreshPage();
    }
  };
  try{ c.addEventListener('change', onChange) }catch{}
})();
function openSyncStatus(){
  const b = $('#syncBody'); if(!b) return;
  if(!MMAuth.user){
    b.innerHTML = `<div class="state mm-empty" style="padding:30px 24px"><i class="bi bi-cloud-slash"></i><p>Not signed in</p><p class="mt-1" style="font-size:.78rem">Sign in to sync your library across devices</p><button class="pill-btn primary mt-3" onclick="sheet('#sheetSync').hide(); openAuth()"><i class="bi bi-box-arrow-in-right"></i> Sign in</button></div>`;
    sheet('#sheetSync').show();
    return;
  }
  const enabled = MMSync.enabled(), last = MMSync._lastTime ? fmtAgo(MMSync._lastTime) : '—';
  b.innerHTML = `<div class="px-3 pt-2 pb-3"><div class="sync-status-card" style="margin:0"><i class="bi bi-${enabled?(MMSync._lastError?'exclamation-circle text-danger':'cloud-check text-success'):'cloud-slash text-secondary'}"></i><div class="sc-body"><div class="sc-title">${enabled?(MMSync._lastError?'Last sync had an error':'Everything is synced'):'Sync disabled'}</div><div class="sc-sub">${MMSync._lastError ? esc(MMSync._lastError) : `Last successful: ${last}`}</div></div></div><div class="d-flex gap-2 mt-3"><button class="pill-btn primary flex-fill justify-content-center" onclick="MMAuth.syncNow()"><i class="bi bi-arrow-repeat"></i> Sync now</button><button class="pill-btn flex-fill justify-content-center" onclick="go('/account'); sheet('#sheetSync').hide()"><i class="bi bi-person"></i> Account</button></div><div class="settings-row mt-3" style="padding-left:0"><i class="bi bi-${enabled?'toggle-on text-success':'toggle-off'}"></i><div class="sr-body"><div class="sr-title">Enable sync</div><div class="sr-sub">Send changes to the cloud</div></div><div class="sr-control"><label class="mm-switch"><input type="checkbox" id="syncSheetToggle" ${enabled?'checked':''}><span class="slider"></span></label></div></div><div class="text-secondary mt-2" style="font-size:.74rem;line-height:1.5">Sync includes: liked songs, playlists, followed artists, listening history, stats, and notes.</div></div>`;
  sheet('#sheetSync').show();
  const tg = document.getElementById('syncSheetToggle');
  if(tg) tg.addEventListener('change', e => { setSetting('syncEnabled', e.target.checked); openSyncStatus(); if(e.target.checked) MMSync.bootstrap().catch(()=>{}) });
}

/* ══ PWA INSTALL ═════════════════════════════════════════════════════════════ */
let deferredInstall = null;
function isStandalone(){
  return window.matchMedia?.('(display-mode: standalone)').matches ||
         window.matchMedia?.('(display-mode: fullscreen)').matches ||
         window.navigator.standalone === true;
}
function showInstallButton(){
  if(!isStandalone()){
    const b = $('#installBtn'); if(b) b.style.display = '';
    const sb = $('#sbInstall'); if(sb) sb.style.display = '';
  }
}
function hideInstallButton(){
  const b = $('#installBtn'); if(b) b.style.display = 'none';
  const sb = $('#sbInstall'); if(sb) sb.style.display = 'none';
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; showInstallButton() });
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  hideInstallButton();
  toast('MusicMan installed','success');
  Notify.show('MusicMan installed', 'Ready for offline use', {category:'misc'});
});
async function promptInstall(){
  if(deferredInstall){ try{ deferredInstall.prompt(); await deferredInstall.userChoice }catch{}; deferredInstall = null; hideInstallButton(); return }
  const ua = navigator.userAgent||'',
        isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
        body = $('#installBody');
  if(isIOS) body.innerHTML = `<div class="install-step"><div class="n">1</div><div class="t">Open in <b>Safari</b>.</div></div><div class="install-step"><div class="n">2</div><div class="t">Tap <b>Share</b> <i class="bi bi-box-arrow-up"></i>.</div></div><div class="install-step"><div class="n">3</div><div class="t">Tap <b>"Add to Home Screen"</b>.</div></div><div class="install-step"><div class="n">4</div><div class="t">Confirm and launch from your home screen.</div></div>`;
  else body.innerHTML = `<div class="install-step"><div class="n">1</div><div class="t">Open browser menu (<i class="bi bi-three-dots-vertical"></i>).</div></div><div class="install-step"><div class="n">2</div><div class="t">Choose <b>"Install app"</b> or <b>"Add to Home screen"</b>.</div></div><div class="install-step"><div class="n">3</div><div class="t">Confirm to install.</div></div><p class="text-secondary mt-2" style="font-size:.76rem">If not visible, ensure HTTPS and reload once.</p>`;
  sheet('#sheetInstall').show();
}
function initInstallButton(){
  if(isStandalone()) return;
  const ua = navigator.userAgent||'',
        isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if(isIOS) showInstallButton();
}
function openShortcuts(){
  const grid = $('#shortcutGrid'); if(!grid) return;
  const rows = [
    ['Space','Play / pause'], ['→ / ←','Seek ±5s'], ['N','Next track'], ['P','Previous track'],
    ['S','Toggle shuffle'], ['R','Cycle repeat'], ['L','Like current'], ['A','A-B repeat'],
    ['J','Toggle full player (mobile)'], ['/','Focus search'], ['?','This help'], ['Esc','Close overlays']
  ];
  grid.innerHTML = rows.map(([k,d]) => `<div class="shortcut-row"><kbd>${k}</kbd><span>${d}</span></div>`).join('');
  $('#shortcutOverlay').classList.add('on');
}
function closeShortcuts(){ const el = $('#shortcutOverlay'); if(el) el.classList.remove('on') }
document.addEventListener('keydown', e => {
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target.tagName;
  if(t === 'INPUT' || t === 'TEXTAREA'){ if(e.key === 'Escape') e.target.blur(); return }
  if(e.key === '?'){ openShortcuts(); return }
  if(e.code === 'Space'){ e.preventDefault(); togglePlay(); return }
  if(e.key === 'ArrowRight' && audio.duration && isFinite(audio.duration)) audio.currentTime = Math.min(audio.currentTime + 5, audio.duration);
  if(e.key === 'ArrowLeft' && audio.duration && isFinite(audio.duration)) audio.currentTime = Math.max(audio.currentTime - 5, 0);
  if(e.key === 'n' || e.key === 'N') nextTrack();
  if(e.key === 'p' || e.key === 'P') prevTrack();
  if(e.key === 's' || e.key === 'S') toggleShuffle();
  if(e.key === 'r' || e.key === 'R') cycleRepeat();
  if(e.key === 'l' || e.key === 'L') toggleLikeCurrent();
  if(e.key === 'a' || e.key === 'A') abToggle();
  if(e.key === 'j' || e.key === 'J'){ if(IS_DESKTOP()) return; if($('#full')?.classList.contains('show')) closeFullPlayer(); else openFullPlayer() }
  if(e.key === '/'){ e.preventDefault(); $('#searchInput')?.focus() }
  if(e.key === 'Escape'){ closeShortcuts(); if($('#full')?.classList.contains('show')) closeFullPlayer() }
});
if('serviceWorker' in navigator) window.addEventListener('load', () => {
  const had = navigator.serviceWorker.controller;
  navigator.serviceWorker.register(SCOPE+'sw.js', {scope:SCOPE})
    .then(reg => { const chk = () => { try{ reg.update().catch(()=>{}) }catch{} }; setTimeout(chk, 3e3); setInterval(chk, 36e5) })
    .catch(()=>{});
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(refreshing) return;
    refreshing = true;
    if(had){
      try{ toast('Updating to latest version…','info') }catch{}
      setTimeout(() => { try{ const url = new URL(location.href); url.searchParams.set('_r', Date.now()); location.replace(url.toString()) }catch{ try{ location.reload() }catch{} } }, 700);
    }
  });
});
function syncSidebarNav(){
  const path = currentPath();
  document.querySelectorAll('.sb-link').forEach(el => el.classList.remove('active'));
  const setA = sel => { const el = document.querySelector(sel); if(el) el.classList.add('active') };
  if(path === '/') setA('.sb-link[data-nav="home"]');
  else if(path.startsWith('/search')) setA('.sb-link[data-nav="search"]');
  else if(path.startsWith('/social')) setA('.sb-link[data-nav="social"]');
  else if(path === '/library/likes') setA('.sb-link[data-lib="likes"]');
  else if(path === '/library/following') setA('.sb-link[data-lib="following"]');
  else if(path.startsWith('/library/playlists')) setA('.sb-link[data-lib="playlists"]');
  else if(path === '/library/downloads') setA('.sb-link[data-lib="downloads"]');
  else if(path === '/library/stats') setA('.sb-link[data-lib="stats"]');
  else if(path === '/library/history') setA('.sb-link[data-lib="history"]');
}
function renderSidebarPlaylists(){
  const el = document.getElementById('sbPlaylists'); if(!el) return;
  const pls = getPlaylists();
  if(!pls.length){ el.innerHTML = '<div style="padding:6px 14px;font-size:.76rem;color:var(--bs-secondary-color)">No playlists yet</div>'; return }
  const cur = currentPath();
  el.innerHTML = pls.map(p => {
    const active = cur === '/library/playlists/'+p.id ? ' active' : '', ic = p.isPublic ? 'bi-globe' : 'bi-music-note-list';
    return `<a href="${SCOPE}library/playlists/${esc(p.id)}" data-link class="sb-link${active}"><i class="bi ${ic}"></i><span>${esc(p.name)}</span></a>`;
  }).join('');
}
function syncPlayerBar(){
  if(!IS_DESKTOP()) return;
  const t = Player.track,
        pbArt = document.getElementById('pbArt'),
        pbTitle = document.getElementById('pbTitle'),
        pbArtist = document.getElementById('pbArtist'),
        pbLikeBtn = document.getElementById('pbLikeBtn'),
        pbLike = document.getElementById('pbLike'),
        pbPlayIcon = document.getElementById('pbPlayIcon'),
        pbShuffleBtn = document.getElementById('pbShuffleBtn'),
        pbRepeatBtn = document.getElementById('pbRepeatBtn'),
        pbDur = document.getElementById('pbDur');
  if(!t){
    if(pbArt){ pbArt.removeAttribute('src'); pbArt.style.opacity = '.25' }
    if(pbTitle) pbTitle.textContent = '—';
    if(pbArtist) pbArtist.textContent = '—';
    if(pbLike) pbLike.className = 'bi bi-heart';
    if(pbLikeBtn) pbLikeBtn.classList.remove('liked');
    if(pbPlayIcon) pbPlayIcon.className = 'bi bi-play-fill';
    return;
  }
  const art = getArtwork(t, 300) || t.artworkUrl || '';
  if(pbArt){ if(art){ pbArt.src = art; pbArt.style.opacity = '1' } else { pbArt.removeAttribute('src'); pbArt.style.opacity = '.25' } }
  if(pbTitle) pbTitle.innerHTML = `<a class="mm-link" href="${SCOPE}track/${esc(t.trackId)}" data-link style="color:inherit">${esc(t.trackName||'')}</a>${Player.isPreview?previewTagHtml():''}`;
  if(pbArtist){ if(t.artistId) pbArtist.innerHTML = `<a class="mm-link" href="${SCOPE}artist/${esc(t.artistId)}" data-link style="color:inherit">${esc(t.artistName||'')}</a>`; else pbArtist.textContent = t.artistName || '' }
  const liked = isLiked(t.trackId);
  if(pbLike) pbLike.className = `bi ${liked ? 'bi-heart-fill' : 'bi-heart'}`;
  if(pbLikeBtn) pbLikeBtn.classList.toggle('liked', liked);
  if(pbPlayIcon) pbPlayIcon.className = `bi ${Player.playing ? 'bi-pause-fill' : Player.isPreview ? 'bi-play-circle' : 'bi-play-fill'}`;
  if(pbShuffleBtn) pbShuffleBtn.classList.toggle('on', Player.shuffle);
  if(pbRepeatBtn){
    pbRepeatBtn.classList.toggle('on', Player.repeat !== 'off');
    const i = pbRepeatBtn.querySelector('i');
    if(i) i.className = `bi ${Player.repeat === 'one' ? 'bi-repeat-1' : 'bi-repeat'}`;
  }
  if(pbDur && audio.duration && isFinite(audio.duration)) pbDur.textContent = fmtTime(audio.duration);
}
function updateDesktopSeek(){
  if(!IS_DESKTOP()) return;
  const seek = document.getElementById('pbSeek');
  if(!seek || Player.seeking) return;
  if(!audio.duration || !isFinite(audio.duration)) return;
  const pct = audio.currentTime/audio.duration*100;
  seek.value = Math.round(pct*10);
  seek.style.setProperty('--p', pct+'%');
  const cur = document.getElementById('pbCur'); if(cur) cur.textContent = fmtTime(audio.currentTime);
  const dur = document.getElementById('pbDur'); if(dur) dur.textContent = fmtTime(audio.duration);
}
function setRpMode(mode){
  rpMode = mode;
  $$('#rpTabs .rp-tab').forEach(b => b.classList.toggle('active', b.dataset.rpTab === mode));
  updateRightPanel();
}
(function initDesktopPlayerBar(){
  const seek = document.getElementById('pbSeek'), wrap = document.getElementById('pbSeekWrap'), tip = document.getElementById('pbTip');
  if(seek){
    seek.addEventListener('pointerdown', () => { Player.seeking = true });
    seek.addEventListener('pointerup', () => { Player.seeking = false });
    seek.addEventListener('input', e => {
      const p = Number(e.target.value)/10;
      e.target.style.setProperty('--p', p+'%');
      if(audio.duration && isFinite(audio.duration)){ const c = document.getElementById('pbCur'); if(c) c.textContent = fmtTime(p/100*audio.duration) }
    });
    seek.addEventListener('change', e => { if(audio.duration && isFinite(audio.duration)) audio.currentTime = Number(e.target.value)/1e3*audio.duration; Player.seeking = false });
  }
  if(wrap && tip){
    wrap.addEventListener('pointermove', e => {
      if(!audio.duration || !isFinite(audio.duration)) return;
      const r = wrap.getBoundingClientRect(), x = Math.max(0, Math.min(1, (e.clientX - r.left)/r.width));
      tip.textContent = fmtTime(x*audio.duration);
      tip.style.left = x*100+'%';
      tip.classList.add('on');
    });
    wrap.addEventListener('pointerleave', () => tip.classList.remove('on'));
  }
  const vol = document.getElementById('pbVol');
  if(vol){
    vol.value = Math.round(audio.volume*100);
    vol.style.setProperty('--p', vol.value+'%');
    vol.addEventListener('input', e => { const v = Number(e.target.value)/100; audio.volume = v; ls.set(KEY.vol, v); e.target.style.setProperty('--p', e.target.value+'%') });
  }
  $$('#rpTabs .rp-tab').forEach(b => b.addEventListener('click', () => setRpMode(b.dataset.rpTab)));

  /* ─────────────────────────────────────────────────────────────────
     DEFERRED INITIAL SYNC
     `const MMAuth = {...}` and `const MMSync = {...}` are declared
     later in this same file. Any path through updateRightPanel →
     renderRpQueue → _mountQueueSuggestions → loadQueueSuggestions
     reads MMAuth.user, which throws a TDZ ReferenceError if we call
     it here (during script parse, before MMAuth is initialized).

     queueMicrotask runs its callback AFTER the current synchronous
     execution finishes — that means after the entire script body,
     including `const MMAuth = …` — so by the time this fires, all
     module-level consts exist. Guaranteed safe.
     ───────────────────────────────────────────────────────────────── */
  queueMicrotask(() => {
    setRpMode(Player.track ? 'now' : 'queue');
    renderSidebarPlaylists();
    syncPlayerBar();
    syncSidebarNav();
  });
})();
window.addEventListener('resize', () => { syncPlayerBar() }, {passive:true});

/* ══ SYNC ════════════════════════════════════════════════════════════════════ */
const MMSync = {
  _pushTimer:null, _pulling:false, _pushing:false, _lastError:'', _lastTime:0, _online:true,
  enabled(){ return !!MMAuth.user && getSettings().syncEnabled !== false },
  snapshot(){ const out = {}; for(const k of SYNC_KEYS) out[k] = ls.get(KEY_FOR[k], null); return out },
  schedule(){
    if(!this.enabled()) return;
    if(this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => { this._pushTimer = null; this.push().catch(()=>{}) }, 2200);
  },
  updateIndicator(state, text){
    const el = document.getElementById('syncPill'); if(!el) return;
    if(!MMAuth.user){ el.style.display = 'none'; return }
    el.style.display = '';
    const map = {synced:{i:'bi-cloud-check', c:'', t:'Synced'}, syncing:{i:'bi-arrow-repeat', c:'', t:'Syncing…'}, error:{i:'exclamation-circle', c:'text-danger', t:'Sync error'}, off:{i:'bi-cloud-slash', c:'text-secondary', t:'Sync off'}},
          s = map[state] || map.synced;
    el.innerHTML = `<i class="bi ${s.i} ${s.c}"></i><span>${text||s.t}</span>`;
    el.title = s.t;
  },
  async push(force=false){
    if(!this.enabled() && !force) return {ok:false, reason:'disabled'};
    if(!navigator.onLine) return {ok:false, reason:'offline'};
    if(this._pushing) return {ok:false, reason:'busy'};
    this._pushing = true;
    this.updateIndicator('syncing');
    try{
      const data = this.snapshot(), r = await apiCall('/sync', {method:'POST', body:JSON.stringify({data})});
      if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Sync failed');
      this._lastError = ''; this._lastTime = Date.now();
      this.updateIndicator('synced');
      try{ const s = getSettings(); s._lastSync = this._lastTime; ls.set(KEY.settings, s) }catch{}
      Notify.show('Sync complete','',{category:'sync', silent:true});
      return {ok:true};
    }catch(e){
      this._lastError = e.message || String(e);
      this.updateIndicator('error');
      return {ok:false, error:this._lastError};
    }finally{ this._pushing = false }
  },
  async pull(mergeIntoLocal=true){
    if(!this.enabled()) return {ok:false, reason:'disabled'};
    if(!navigator.onLine) return {ok:false, reason:'offline'};
    if(this._pulling) return {ok:false, reason:'busy'};
    this._pulling = true;
    this.updateIndicator('syncing');
    try{
      const r = await apiCall('/sync');
      if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Pull failed');
      const remote = r.data.data || {};
      if(mergeIntoLocal){
        for(const k of SYNC_KEYS){
          const localV = ls.get(KEY_FOR[k], null), remoteV = remote[k],
                merged = this.mergeValue(k, localV, remoteV);
          if(merged !== null && merged !== undefined) _lsSet(KEY_FOR[k], merged);
        }
      }
      this._lastError = ''; this._lastTime = Date.now();
      this.updateIndicator('synced');
      return {ok:true, data:remote};
    }catch(e){
      this._lastError = e.message || String(e);
      this.updateIndicator('error');
      return {ok:false, error:this._lastError};
    }finally{ this._pulling = false }
  },
  mergeValue(k, local, remote){
    const arr = v => Array.isArray(v) ? v : v == null ? [] : null,
          obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    if(k === 'likes' || k === 'following'){
      const l = arr(local)||[], r = arr(remote)||[], map = new Map(),
            keyf = k === 'likes' ? x => String(x?.trackId||'') : x => String(x?.artistId||''),
            timef = k === 'likes' ? x => Number(x?.addedAt||0) : x => Number(x?.followedAt||0);
      for(const x of r){ const kk = keyf(x); if(kk) map.set(kk, x) }
      for(const x of l){ const kk = keyf(x); if(!kk) continue; const cur = map.get(kk); if(!cur || timef(x) > timef(cur)) map.set(kk, x) }
      return [...map.values()].sort((a,b) => timef(b)-timef(a));
    }
    if(k === 'pls'){
      const l = arr(local)||[], r = arr(remote)||[], map = new Map();
      for(const x of r){ const kk = x?.id; if(kk) map.set(kk, JSON.parse(JSON.stringify(x))) }
      for(const x of l){
        const kk = x?.id; if(!kk) continue;
        const cur = map.get(kk);
        if(!cur){ map.set(kk, JSON.parse(JSON.stringify(x))); continue }
        const seen = new Set((cur.tracks||[]).map(t => String(t.trackId)));
        for(const t of x.tracks||[]){ const tid = String(t.trackId); if(!seen.has(tid)){ cur.tracks.push(t); seen.add(tid) } }
        if((x.updatedAt||0) > (cur.updatedAt||0)){
          cur.name = x.name || cur.name;
          cur.isPublic = !!x.isPublic || !!cur.isPublic;
          cur.description = x.description || cur.description;
          cur.cover = x.cover || cur.cover;
          cur.updatedAt = x.updatedAt;
        }
      }
      return [...map.values()];
    }
    if(k === 'plays'){
      const l = arr(local)||[], r = arr(remote)||[], map = new Map(),
            keyf = x => String(x?.trackId||''), timef = x => Number(x?.at||0);
      for(const x of [...l, ...r]){ const kk = keyf(x); if(!kk) continue; const cur = map.get(kk); if(!cur || timef(x) > timef(cur)) map.set(kk, x) }
      return [...map.values()].sort((a,b) => timef(b)-timef(a)).slice(0,30);
    }
    if(k === 'recent'){
      const l = arr(local)||[], r = arr(remote)||[], seen = new Set(), out = [];
      for(const x of [...l, ...r]){ const s = String(x||''); if(!s || seen.has(s)) continue; seen.add(s); out.push(s) }
      return out.slice(0,12);
    }
    if(k === 'notes'){
      const l = obj(local)||{}, r = obj(remote)||{}, out = {...r};
      for(const [kk,v] of Object.entries(l)){ const cur = out[kk]; if(!cur || Number(v?.at||0) > Number(cur?.at||0)) out[kk] = v }
      return out;
    }
    if(k === 'stats'){
      const l = obj(local)||{}, r = obj(remote)||{}, out = {totalMs:0, plays:0, tracks:{}, days:{}};
      out.totalMs = Math.max(Number(l.totalMs)||0, Number(r.totalMs)||0);
      out.plays = Math.max(Number(l.plays)||0, Number(r.plays)||0);
      const tks = {...(r.tracks||{})};
      for(const [id,v] of Object.entries(l.tracks||{})){
        const cur = tks[id];
        if(!cur) tks[id] = v;
        else tks[id] = {...cur, ...v, ms:Math.max(Number(cur.ms)||0, Number(v.ms)||0), count:Math.max(Number(cur.count)||0, Number(v.count)||0), lastAt:Math.max(Number(cur.lastAt)||0, Number(v.lastAt)||0)};
      }
      out.tracks = tks;
      out.days = {...(r.days||{})};
      for(const [d,ms] of Object.entries(l.days||{})) out.days[d] = Math.max(Number(out.days[d])||0, Number(ms)||0);
      return out;
    }
    return local ?? remote;
  },
  async bootstrap(){
    if(!this.enabled()) return;
    const res = await this.pull(true);
    if(res.ok){
      try{ _sc = null }catch{}
      try{ renderSidebarPlaylists() }catch{}
      try{ if(typeof refreshLikes === 'function'){ reindexActionButtons(); refreshLikes() } }catch{}
      try{ if(typeof refreshFollowButtons === 'function') refreshFollowButtons() }catch{}
      try{ if(isLibLikes() || isLibPl() || isLibFoll() || isLibHist() || isLibStats() || isLibDl()) route() }catch{}
    }
  }
};
async function clearUserDataOnLogout(){
  ['likes','pls','following','recent','plays','notes','stats'].forEach(k => { try{ ls.remove(KEY[k]) }catch{} });
  try{ ls.remove(KEY.queue) }catch{}
  try{ _sc = null }catch{}
  try{ await cacheClear() }catch{}
  try{ cachedIds.clear() }catch{}
  try{ itemCache.clear() }catch{}
  try{ _ftCache.clear() }catch{}
  try{ _relCache.clear() }catch{}
  try{ _sgc.clear() }catch{}
  try{ _transCache.clear() }catch{}
  try{ _transInflight.clear() }catch{}
  try{ _detectedPerTrack.clear() }catch{}
  try{ _artTintCache.clear() }catch{}
  try{ _wikiCache.clear(); _wikiInflight.clear() }catch{}
  try{ _likeCountCache.clear() }catch{}
  try{ disconnectTrackSectionObs() }catch{}
  try{ _homeCache = null; _homeRendered = false }catch{}
  try{ _recoHomeCache = null; _recoHomeDirty = true }catch{}
  try{
    Player.queue = []; Player.index = -1; Player.shuffle = false; Player.repeat = 'off';
    Player.track = null; Player.isPreview = false;
    try{
      audio.pause();
      if(audio.dataset.blobUrl){ try{ URL.revokeObjectURL(audio.dataset.blobUrl) }catch{}; delete audio.dataset.blobUrl }
      audio.removeAttribute('src'); audio.load();
    }catch{}
    renderFpTabBody(); updateRightPanel(); syncPlayerBar();
    document.body.classList.remove('has-track');
      
  }catch{}
  try{ renderSidebarPlaylists() }catch{}
  try{ reindexActionButtons(); refreshLikes(); refreshFollowButtons() }catch{}
  try{ updateDownloadBadges() }catch{}
  try{ updateMediaSession() }catch{}
}

/* ══ AUTH ════════════════════════════════════════════════════════════════════ */
const MMAuth = {
  user: window.__MM_USER__ || null,
  providers: PROVIDERS,
  loading: false,
  _emailMode: 'login',
  __dirty: false,
  displayName(){
    const u = this.user; if(!u) return '';
    const n = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
    return n || u.username || u.email || 'User '+u.id;
  },
  initials(){
    const n = this.displayName();
    return (n.match(/\S+/g)||['?']).slice(0,2).map(s => s[0].toUpperCase()).join('');
  },
  providerLabel(p){ return {telegram:'Telegram', google:'Google', email:'Email'}[p] || p },
  async refresh(){
    try{
      const r = await apiCall('/auth/me');
      this.user = r.data.user || null;
      if(r.data.providers) this.providers = r.data.providers;
      this.render();
    }catch{}
    this.__authResolved = true;
  },
  async handleTelegram(u){
    try{
      const r = await apiCall('/auth/telegram', {method:'POST', body:JSON.stringify(u||{})});
      if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Login failed');
      await this._onLoginSuccess(r.data.user);
    }catch(e){ toast('Login failed: '+(e.message||e),'danger') }
  },
  async handleGoogleCredential(credential){
    try{
      const r = await apiCall('/auth/google', {method:'POST', body:JSON.stringify({credential})});
      if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Google sign-in failed');
      await this._onLoginSuccess(r.data.user);
    }catch(e){ toast('Google sign-in failed: '+(e.message||e),'danger') }
  },
  async emailSubmit(){
    if(this.loading) return;
    const email = (document.getElementById('authEmail')?.value||'').trim(),
          password = document.getElementById('authPassword')?.value || '',
          first = (document.getElementById('authFirstName')?.value||'').trim(),
          errEl = document.getElementById('authEmailError');
    if(errEl) errEl.textContent = '';
    if(!email || !password){ if(errEl) errEl.textContent = 'Email and password are required.'; return }
    if(this._emailMode === 'register' && password.length < 6){ if(errEl) errEl.textContent = 'Password must be at least 6 characters.'; return }
    this.loading = true;
    const btn = document.getElementById('authEmailSubmit'), orig = btn?.innerHTML;
    if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Please wait…' }
    try{
      const path = this._emailMode === 'register' ? '/auth/register' : '/auth/login',
            body = this._emailMode === 'register' ? {email, password, first_name:first} : {email, password},
            r = await apiCall(path, {method:'POST', body:JSON.stringify(body)});
      if(!r.ok || !r.data.ok) throw new Error(r.data.error||'Authentication failed');
      await this._onLoginSuccess(r.data.user);
    }catch(e){ if(errEl) errEl.textContent = e.message || String(e) }
    finally{ this.loading = false; if(btn){ btn.disabled = false; btn.innerHTML = orig } }
  },
  _setEmailMode(mode){ this._emailMode = mode === 'register' ? 'register' : 'login'; this.openSheet() },
  async _onLoginSuccess(user){
    this.user = user;
    this.render();
    toast(`Welcome, ${this.displayName()}!`,'success');
    Notify.show('Welcome back!', `Signed in as ${this.displayName()}`, {category:'auth'});
    haptic(14);
    try{ sheet('#sheetLogin').hide() }catch{}
    try{ _recoHomeCache = null; _recoHomeDirty = true }catch{}
    try{ await MMSync.bootstrap(); await MMSync.push(true) }catch{}
    try{ refreshPage() }catch{}
  },
  async logout(){
    document.querySelector('#sheetLogin')?.classList.remove('show');
    const ok = await askConfirm('Sign out?', 'Your data stays on the server and returns on next sign-in. Local likes, playlists, history, following, stats and all offline downloads will be cleared from this device.', 'Sign out');
    if(!ok) return;
    try{ await apiCall('/auth/logout', {method:'POST'}) }catch{}
    this.user = null;
    try{ await clearUserDataOnLogout() }catch{}
    this.render();
    toast('Signed out');
    Notify.show('Signed out','',{category:'auth'});
    try{ sheet('#sheetLogin').hide() }catch{}
    try{ _recoHomeCache = null; _recoHomeDirty = true }catch{}
    try{ refreshPage() }catch{}
  },
  async syncNow(){
    if(!this.user){ toast('Sign in to sync','warning'); return }
    toast('Syncing…','info');
    const res = await MMSync.pull(true);
    if(res.ok){ await MMSync.push(true); toast('Synced','success'); try{ refreshPage() }catch{} }
    else toast('Sync failed: '+(res.error||''),'danger');
  },
  render(){
    const ab = document.getElementById('authBtn');
    if(ab){
      ab.style.display = '';
      if(this.user && this.user.photo_url) ab.innerHTML = `<img src="${esc(this.user.photo_url)}" alt="">`;
      else if(this.user){ ab.innerHTML = `<i class="bi bi-person-check-fill"></i>`; ab.classList.add('on') }
      else { ab.innerHTML = `<i class="bi bi-person-circle"></i>`; ab.classList.remove('on') }
    }
    const sb = document.getElementById('sbAuth');
    if(sb){
      sb.style.display = '';
      if(this.user && this.user.photo_url) sb.innerHTML = `<img class="sb-auth-avatar" src="${esc(this.user.photo_url)}" alt=""><span class="text-truncate">${esc(this.displayName())}</span>`;
      else if(this.user) sb.innerHTML = `<i class="bi bi-person-check-fill"></i><span class="text-truncate">${esc(this.displayName())}</span>`;
      else sb.innerHTML = `<i class="bi bi-person-plus"></i><span>Sign in</span>`;
    }
    const so = document.getElementById('sbSignout');
    if(so) so.style.display = this.user ? '' : 'none';
    const host = document.getElementById('accountHost');
    if(host) this.renderAccountHost(host);
    if(this.user) MMSync.updateIndicator('synced');
    else MMSync.updateIndicator('off');
  },
  renderAccountHost(host){
    if(!HAS_DB){ host.innerHTML = `<div class="settings-row"><i class="bi bi-exclamation-triangle text-warning"></i><div class="sr-body"><div class="sr-title">Accounts are unavailable</div><div class="sr-sub">The server could not open the SQLite database.</div></div></div>`; return }
    if(!this.user){
      host.innerHTML = `<div class="settings-row"><i class="bi bi-person-circle"></i><div class="sr-body"><div class="sr-title">Not signed in</div><div class="sr-sub">Sign in to sync across devices</div></div><div class="sr-control"><button class="pill-btn primary sm" onclick="openAuth()"><i class="bi bi-box-arrow-in-right"></i> Sign in</button></div></div>`;
      return;
    }
    const u = this.user,
          av = u.photo_url ? `<img src="${esc(u.photo_url)}" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex:0 0 auto">` : `<div style="width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--bs-primary),var(--bs-info));color:#fff;font-weight:800">${esc(this.initials())}</div>`,
          sub = [];
    if(u.email) sub.push(esc(u.email));
    else if(u.username) sub.push('@'+esc(u.username));
    else sub.push('ID '+esc(u.id));
    sub.push(this.providerLabel(u.provider));
    host.innerHTML = `<div class="settings-row">${av}<div class="sr-body"><div class="sr-title">${esc(this.displayName())}</div><div class="sr-sub">${sub.join(' · ')}</div></div><div class="sr-control"><button class="pill-btn sm" onclick="go('/account')"><i class="bi bi-person"></i> Account</button><button class="pill-btn sm" onclick="MMAuth.syncNow()"><i class="bi bi-arrow-repeat"></i></button><button class="pill-btn danger sm" onclick="MMAuth.logout()"><i class="bi bi-box-arrow-right"></i></button></div></div>`;
  },
  openSheet(){
    const body = document.getElementById('loginBody'); if(!body) return;
    if(!HAS_DB){
      body.innerHTML = `<div class="px-3 py-4 text-center"><i class="bi bi-exclamation-triangle text-warning" style="font-size:2rem"></i><div class="fw-bold mt-2">Accounts unavailable</div><div class="text-secondary mt-1" style="font-size:.82rem">The server could not create the SQLite database.</div></div>`;
      sheet('#sheetLogin').show();
      return;
    }
    if(this.user){ this._renderAccountView(body); sheet('#sheetLogin').show(); return }
    this._renderSignInView(body);
    sheet('#sheetLogin').show();
  },
  _renderSignInView(body){
    const reg = this._emailMode === 'register', hasSocial = this.providers.telegram || this.providers.google;
    let html = `<div class="px-3 pb-3">`;
    html += `<div class="auth-hero"><div class="auth-hero-icon"><i class="bi ${reg?'bi-person-plus':'bi-person-check'}"></i></div><div class="auth-hero-title">${reg?'Create your account':'Welcome to MusicMan'}</div><div class="auth-hero-sub">${hasSocial?'Sign in or create an account to sync your library.':'Sign in with your email to sync your library.'}</div></div>`;
    if(hasSocial){
      if(this.providers.telegram) html += `<div class="auth-provider telegram" id="authTgProvider"><div class="auth-provider-visual"><i class="bi bi-telegram"></i><span>Continue with Telegram</span></div><div class="auth-provider-hit" id="tgWidgetHost"></div></div>`;
      if(this.providers.google) html += `<div class="auth-provider google" id="authGgProvider"><div class="auth-provider-visual"><i class="bi bi-google"></i><span>Continue with Google</span></div><div class="auth-provider-hit" id="googleBtnHost"></div></div>`;
      html += `<div class="auth-divider"><div></div><span>OR</span><div></div></div>`;
    }
    html += `<div class="auth-chip-row"><button class="chip ${!reg?'on':''}" onclick="MMAuth._setEmailMode('login')">Sign in</button><button class="chip ${reg?'on':''}" onclick="MMAuth._setEmailMode('register')">Create account</button></div>`;
    if(reg) html += `<input id="authFirstName" class="form-control form-control-lg mb-2" placeholder="Your name" autocomplete="given-name" style="border-radius:12px">`;
    html += `<input id="authEmail" type="email" class="form-control form-control-lg mb-2" placeholder="Email" autocomplete="email" style="border-radius:12px">`;
    html += `<input id="authPassword" type="password" class="form-control form-control-lg mb-2" placeholder="Password" autocomplete="${reg?'new-password':'current-password'}" style="border-radius:12px">`;
    html += `<div id="authEmailError" class="text-danger small mb-2" style="min-height:1.1em"></div>`;
    html += `<button id="authEmailSubmit" class="pill-btn primary w-100 justify-content-center" onclick="MMAuth.emailSubmit()" style="padding:12px"><i class="bi ${reg?'bi-person-plus':'bi-box-arrow-in-right'}"></i> ${reg?'Create account':'Sign in'}</button>`;
    html += `<div class="text-secondary mt-3" style="font-size:.72rem;text-align:center;line-height:1.5">${reg?'Your likes, playlists and settings will be synced to your account.':'Sign in with your existing account to restore your library.'}</div></div>`;
    body.innerHTML = html;
    document.getElementById('authPassword')?.addEventListener('keydown', e => { if(e.key === 'Enter') this.emailSubmit() });
    if(this.providers.telegram) this._mountTelegramWidget();
    if(this.providers.google) this._mountGoogleButton();
  },
  _renderAccountView(body){
    const u = this.user, name = this.displayName(), sub = [];
    if(u.email) sub.push(esc(u.email));
    else if(u.username) sub.push('@'+esc(u.username));
    sub.push(this.providerLabel(u.provider));
    const av = u.photo_url ? `<img class="auth-avatar" src="${esc(u.photo_url)}" alt="">` : `<div class="auth-avatar-ph">${esc(this.initials())}</div>`;
    body.innerHTML = `<div class="px-3 pb-3"><div class="d-flex align-items-center gap-3 mb-3" style="padding:6px 4px">${av}<div class="min-w-0 flex-grow-1"><div class="fw-bold text-truncate" style="font-size:1.05rem;letter-spacing:-.01em">${esc(name)}</div><div class="text-secondary text-truncate" style="font-size:.78rem">${sub.join(' · ')}</div></div></div><div class="d-flex flex-wrap gap-2 mb-2"><button class="pill-btn primary flex-fill justify-content-center" onclick="sheet('#sheetLogin').hide();go('/account')"><i class="bi bi-person-gear"></i> Manage account</button><button class="pill-btn flex-fill justify-content-center" onclick="MMAuth.syncNow()"><i class="bi bi-arrow-repeat"></i> Sync now</button></div><button class="pill-btn danger w-100 justify-content-center" onclick="MMAuth.logout()"><i class="bi bi-box-arrow-right"></i> Sign out</button></div>`;
  },
  _mountTelegramWidget(){
    const host = document.getElementById('tgWidgetHost');
    if(!host || !this.providers.telegram) return;
    host.replaceChildren();
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', TG_BOT);
    s.setAttribute('data-size','large');
    s.setAttribute('data-radius','14');
    s.setAttribute('data-onauth','onTelegramAuth(user)');
    s.setAttribute('data-request-access','write');
    s.setAttribute('data-userpic','false');
    host.appendChild(s);
  },
  _mountGoogleButton(){
    const host = document.getElementById('googleBtnHost');
    if(!host || !this.providers.google || !GOOGLE_CLIENT_ID){
      if(host) host.innerHTML = `<div class="text-secondary" style="font-size:.8rem">Google sign-in is not configured.</div>`;
      return;
    }
    const boot = () => {
      if(!window.google?.accounts?.id) return;
      try{
        google.accounts.id.initialize({client_id:GOOGLE_CLIENT_ID, callback:resp => { if(resp?.credential) this.handleGoogleCredential(resp.credential) }, auto_select:false, cancel_on_tap_outside:true});
        const w = Math.max(240, Math.min(400, host.offsetWidth || 300));
        google.accounts.id.renderButton(host, {theme:'filled_black', size:'large', shape:'pill', text:'continue_with', logo_alignment:'left', width:w});
      }catch{ host.innerHTML = `<div class="text-danger small">Google sign-in failed to load.</div>` }
    };
    if(window.google?.accounts?.id){ boot(); return }
    if(!document.getElementById('gsi-script')){
      const s = document.createElement('script');
      s.id = 'gsi-script';
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true; s.onload = boot;
      document.head.appendChild(s);
    } else {
      const t = setInterval(() => { if(window.google?.accounts?.id){ clearInterval(t); boot() } }, 120);
      setTimeout(() => clearInterval(t), 6e3);
    }
  }
};
window.MMAuth = MMAuth;
window.onTelegramAuth = function(user){ try{ window.MMAuth.handleTelegram(user) }catch(e){ console.error(e) } };
window.openAuth = function(){ MMAuth.openSheet() };

/* Long-press preview */
(function(){
  let t = null, triggered = false, x0 = 0, y0 = 0;
  const cancel = () => { if(t){ clearTimeout(t); t = null } };
  document.addEventListener('pointerdown', e => {
    if(e.pointerType === 'mouse' && e.button !== 0) return;
    const btn = e.target.closest('[data-play-id]'); if(!btn) return;
    const id = btn.dataset.playId; if(!id) return;
    x0 = e.clientX; y0 = e.clientY; triggered = false; cancel();
    t = setTimeout(() => {
      t = null; triggered = true;
      try{ if(Player.track && String(Player.track.trackId) === String(id) && !Player.isPreview) return; playPreviewById(id) }catch{}
      try{ haptic(12) }catch{}
    }, 500);
  }, {passive:true});
  document.addEventListener('pointermove', e => {
    if(!t) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if(dx*dx + dy*dy > 225) cancel();
  }, {passive:true});
  document.addEventListener('pointerup', cancel, {passive:true});
  document.addEventListener('pointercancel', cancel, {passive:true});
  document.addEventListener('click', e => { if(!triggered) return; triggered = false; e.preventDefault(); e.stopPropagation() }, true);
  document.addEventListener('contextmenu', e => { if(triggered){ e.preventDefault(); e.stopPropagation() } }, true);
})();

/* ══ BOOT ════════════════════════════════════════════════════════════════════ */
(async function boot(){
  detectSafeAreas();
  Progress.init();
  applySettings();
  updateOnlineBanner();
  initInstallButton();
  autoTheme();
  if(window.__INITIAL_DATA__ && itemId(window.__INITIAL_DATA__)) cacheItems([window.__INITIAL_DATA__]);
  DL.load();
  resumeDownloadPolling();
DL.onChange(() => {
  updateDownloadBadges();
  syncSaveButton();

  if(isTrackRoute()){
    const id = currentPath().split('/')[2];
    const dl = DL.get(id);
    const it = getCached('track', id);
    if(!it || !dl) return;

    if(dl.status === 'ready' || dl.status === 'completed'){
      /* فقط برای همین track (نه برای batch): یک‌بار status تازه بگیر
         تا Play button از «Crawl» به «Play» تغییر کند */
      apiCrawlStatus(id).then(st => {
        if(!st || !currentPath().startsWith('/track/')) return;
        if(hasAudio(st)){
          const fresh = { wrapperType:'track', trackId:id, ...st };
          cacheItems([fresh]);
          _ftCache.set(id, {t:fresh, exp:Date.now()+_FT_TTL});
          renderTrackPage(fresh);
          reindexActionButtons(); refreshLikes();
        }
        renderCrawlCard(it, st);
      }).catch(() => renderCrawlCard(it, null));
    } else {
      renderCrawlCard(it, null);
    }
  }
  if(isLibDl()) updateDlLists();
});
  updateDownloadBadges();
  try{ await refreshCacheIndex() }catch{}
  try{ await restoreQueue() }catch{}
  try{ syncPlayerUI() }catch{}
  try{ MMAuth.render() }catch{}
  if(!location.pathname || location.pathname === BASE) try{ history.replaceState(null, '', SCOPE) }catch{}
  MMAuth.refresh().catch(()=>{});
  await route();
  reindexActionButtons();
  refreshLikes();
  refreshFollowButtons();
  updateMediaSession();
  renderSidebarPlaylists();
  if(MMAuth.user && MMSync.enabled()) MMSync.bootstrap().catch(()=>{});
  setInterval(() => { if(!document.hidden && Player.track) updateMediaSession() }, 5e3);
  document.addEventListener('visibilitychange', () => { if(!document.hidden && MMSync.enabled() && !MMSync._pulling) MMSync.pull(true).catch(()=>{}) });
  setInterval(() => { if(!document.hidden && MMSync.enabled() && !MMSync._pushing) MMSync.push(true).catch(()=>{}) }, 12e4);
})();
window.addEventListener('error', e => console.error('[MusicMan]', e.error || e.message));
window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  if(r && /AbortError|NotAllowedError|not-allowed/i.test(String(r.name||r.message||''))) { e.preventDefault(); return }
  console.warn('[MusicMan unhandled]', r);
});

/* Swipe-to-dismiss for sheets */
(function(){
  function attach(el){
    if(!el || el.__sd) return;
    el.__sd = 1;
    let sy = 0, dy = 0, st = 0, active = false;
    el.addEventListener('touchstart', e => {
      if(e.touches.length !== 1) return;
      if(e.target.closest('input,textarea,select,[data-no-swipe]')) return;
      sy = e.touches[0].clientY; dy = 0; st = performance.now(); active = true;
      el.style.transition = 'none';
    }, {passive:true});
    el.addEventListener('touchmove', e => {
      if(!active) return;
      const delta = e.touches[0].clientY - sy;
      if(delta <= 0){ if(dy !== 0){ dy = 0; el.style.transform = ''; el.style.opacity = '' } return }
      if(delta < 6) return;
      const scroller = e.target.closest('[data-scroll],.sheet-scroll,div[style*="overflow-y"]');
      if(scroller){ if(scroller.scrollTop > 0){ active = false; el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; dy = 0; return } }
      dy = delta;
      const eff = dy <= 80 ? dy : 80 + (dy - 80)*.35;
      el.style.transform = `translateY(${eff}px)`;
      el.style.opacity = String(Math.max(.35, 1 - eff/520));
    }, {passive:true});
    el.addEventListener('touchend', () => {
      if(!active) return;
      active = false;
      const dt = Math.max(1, performance.now() - st), vel = dy/dt, shouldClose = dy > 80 || vel > .5;
      el.style.transition = 'transform .25s var(--mm-ease), opacity .25s';
      el.style.transform = ''; el.style.opacity = '';
      if(shouldClose){ try{ bootstrap.Offcanvas.getInstance(el)?.hide() }catch{}; haptic(8) }
      setTimeout(() => { el.style.transition = ''; dy = 0 }, 280);
    }, {passive:true});
    el.addEventListener('touchcancel', () => {
      active = false;
      el.style.transition = 'transform .2s';
      el.style.transform = ''; el.style.opacity = ''; dy = 0;
      setTimeout(() => { el.style.transition = '' }, 220);
    }, {passive:true});
  }
  const scan = () => document.querySelectorAll('.offcanvas.mm-sheet').forEach(attach);
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  document.addEventListener('show.bs.offcanvas', e => { if(e.target.classList && e.target.classList.contains('mm-sheet')) setTimeout(() => attach(e.target), 20) });
})();

/* Pull-to-refresh */
(function(){
  'use strict';
  const PULL_THRESHOLD = 68, MAX_PULL = 120, RESISTANCE = .55, DIR_LOCK_PX = 10,
        SKIP_SELECTOR = '.offcanvas, .full-player, .modal, .app-bar, .app-bottom, .mini, .player-bar, input, textarea, select, [contenteditable="true"]';
  let ctx = null, ind = null;
  function getScrollInfo(t){
    let deepest = null, anyScrolled = false, p = t;
    while(p && p !== document.body && p !== document.documentElement){
      if(p.nodeType === 1){
        const s = getComputedStyle(p);
        if((s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight+1){
          if(!deepest) deepest = p;
          if(p.scrollTop > 0) anyScrolled = true;
        }
      }
      p = p.parentElement;
    }
    return {deepest, anyScrolled};
  }
  function shouldSkip(t){ return !t || t.nodeType !== 1 || !!t.closest(SKIP_SELECTOR) }
  function ensure(){
    if(ind && ind.isConnected) return ind;
    ind = document.createElement('div');
    ind.id = 'mmPtr';
    ind.setAttribute('aria-hidden','true');
    ind.innerHTML = '<svg class="mmptr-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="mmptr-track" cx="22" cy="22" r="20"></circle><circle class="mmptr-arc" cx="22" cy="22" r="20"></circle></svg><i class="bi bi-arrow-down"></i>';
    document.body.appendChild(ind);
    return ind;
  }
  function anchorTop(){
    const host = document.querySelector('.app-main') || document.getElementById('main');
    if(!host) return 70;
    return Math.max(10, host.getBoundingClientRect().top + 10);
  }
  function place(pull){
    const el = ensure();
    el.style.top = anchorTop() + 'px';
    const p = Math.min(1, pull/PULL_THRESHOLD);
    el.style.opacity = String(Math.min(1, .15 + p*.95));
    const offset = -34 + Math.min(32, pull*.5);
    el.style.transform = `translate(-50%, ${offset}px) scale(${.7 + p*.3})`;
    const arc = el.querySelector('.mmptr-arc');
    if(arc){ const C = 2*Math.PI*20; arc.style.strokeDashoffset = String(C*(1-p)) }
    el.classList.toggle('ready', pull >= PULL_THRESHOLD);
  }
  function reset(){
    if(!ind) return;
    ind.classList.remove('loading','ready','success');
    ind.style.opacity = ''; ind.style.transform = '';
    const arc = ind.querySelector('.mmptr-arc'); if(arc) arc.style.strokeDashoffset = '';
    const ic = ind.querySelector('i'); if(ic) ic.className = 'bi bi-arrow-down';
  }
  function startLoading(){
    const el = ensure();
    el.classList.add('loading'); el.classList.remove('ready','success');
    el.style.opacity = '1'; el.style.transform = 'translate(-50%, 0) scale(1)';
    const ic = el.querySelector('i'); if(ic) ic.className = 'bi bi-arrow-repeat';
  }
  function showSuccess(){
    const el = ind; if(!el) return;
    el.classList.remove('loading','ready'); el.classList.add('success');
    el.style.opacity = '1'; el.style.transform = 'translate(-50%, 0) scale(1)';
    const ic = el.querySelector('i'); if(ic) ic.className = 'bi bi-check-lg';
  }
  async function runRefresh(){
    if(typeof refreshPage === 'function') return refreshPage();
    if(typeof route === 'function') return route();
  }
  document.addEventListener('touchstart', e => {
    if(e.touches.length !== 1) return;
    if(shouldSkip(e.target)) return;
    const info = getScrollInfo(e.target);
    if(!info.deepest || info.anyScrolled) return;
    ctx = {x:e.touches[0].clientX, y:e.touches[0].clientY, lock:null, armed:true, pull:0, hit:false};
  }, {passive:true});
  document.addEventListener('touchmove', e => {
    if(!ctx || !ctx.armed) return;
    if(e.touches.length !== 1){ ctx.armed = false; reset(); return }
    const dx = e.touches[0].clientX - ctx.x, dy = e.touches[0].clientY - ctx.y;
    if(!ctx.lock){
      if(Math.abs(dx) < DIR_LOCK_PX && Math.abs(dy) < DIR_LOCK_PX) return;
      ctx.lock = Math.abs(dy) >= Math.abs(dx) ? 'v' : 'h';
      if(ctx.lock === 'h' || dy <= 0){ ctx.armed = false; return }
    }
    if(dy <= 0){ ctx.armed = false; reset(); return }
    const eff = dy <= MAX_PULL ? dy : MAX_PULL + (dy - MAX_PULL)*.28, resisted = eff*RESISTANCE;
    ctx.pull = resisted;
    place(resisted);
    const over = resisted >= PULL_THRESHOLD;
    if(over && !ctx.hit){ ctx.hit = true; try{ haptic && haptic(8) }catch{} }
    else if(!over && ctx.hit) ctx.hit = false;
  }, {passive:true});
  document.addEventListener('touchend', async () => {
    const c = ctx; ctx = null;
    if(!c){ reset(); return }
    if(c.armed && c.pull >= PULL_THRESHOLD){
      startLoading();
      try{ haptic && haptic(14) }catch{}
      const t0 = performance.now();
      try{ await runRefresh() }catch(err){ console.warn('[PTR]', err) }
      const elapsed = performance.now() - t0;
      if(elapsed < 400) await new Promise(r => setTimeout(r, 400 - elapsed));
      showSuccess();
      await new Promise(r => setTimeout(r, 520));
    }
    reset();
  }, {passive:true});
  document.addEventListener('touchcancel', () => { ctx = null; reset() }, {passive:true});
})();

/* Virtual keyboard viewport */
(function(){
  const root = document.documentElement, vv = window.visualViewport;
  let raf = 0;
  const update = () => {
    if(raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const w = vv ? vv.width : window.innerWidth, h = vv ? vv.height : window.innerHeight;
      root.style.setProperty('--vvw', Math.round(w)+'px');
      root.style.setProperty('--vvh', Math.round(h)+'px');
      const kbOpen = window.innerHeight - h > 120;
      root.classList.toggle('kb-open', kbOpen);
      const widthShrunk = window.innerWidth - w > 40;
      root.classList.toggle('vv-narrow', widthShrunk);
    });
  };
  update();
  if(vv){ vv.addEventListener('resize', update); vv.addEventListener('scroll', update) }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  document.addEventListener('focusin', () => setTimeout(update, 80));
  document.addEventListener('focusout', () => setTimeout(update, 80));
})();

/* Sticky-bar compression on scroll */
(function(){
  const main = document.getElementById('main');
  if(!main) return;
  let bar = null, wrap = null, raf = 0;
  const refreshRefs = () => { bar = document.querySelector('.app-bar'); wrap = document.querySelector('.search-wrap') };
  refreshRefs();
  main.addEventListener('scroll', () => {
    if(raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const s = main.scrollTop > 6;
      if(bar) bar.classList.toggle('mm-scrolled', s);
      if(wrap) wrap.classList.toggle('mm-scrolled', s);
    });
  }, {passive:true});
  document.addEventListener('mm:route', refreshRefs);
})();

/* Context menus */
(function(){
  'use strict';
  document.addEventListener('dragstart', e => { const t = e.target; if(t && t.tagName === 'IMG') e.preventDefault() }, true);
  document.addEventListener('contextmenu', e => { if(e.target && e.target.tagName === 'IMG' && !extractItem(e.target)) e.preventDefault() }, true);
  function extractItem(el){
    if(!el || el.nodeType !== 1) return null;
    const rowItem = el.closest('.row-item[data-track-id]');
    if(rowItem) return {kind:'track', id:String(rowItem.getAttribute('data-track-id')||'')};
    const artistItem = el.closest('.artist-item');
    if(artistItem){ const href = artistItem.getAttribute('href')||'', m = href.match(/\/artist\/([^\/?#]+)/); if(m) return {kind:'artist', id:decodeURIComponent(m[1])} }
    const cardItem = el.closest('.card-item');
    if(cardItem){ const href = cardItem.getAttribute('href')||''; let m = href.match(/\/album\/([^\/?#]+)/); if(m) return {kind:'album', id:decodeURIComponent(m[1])}; m = href.match(/\/track\/([^\/?#]+)/); if(m) return {kind:'track', id:decodeURIComponent(m[1])} }
    const a = el.closest('a[href]');
    if(a){ const href = a.getAttribute('href')||''; let m = href.match(/\/track\/([^\/?#]+)/); if(m) return {kind:'track', id:decodeURIComponent(m[1])}; m = href.match(/\/album\/([^\/?#]+)/); if(m) return {kind:'album', id:decodeURIComponent(m[1])}; m = href.match(/\/artist\/([^\/?#]+)/); if(m) return {kind:'artist', id:decodeURIComponent(m[1])} }
    return null;
  }
  function openContext(info){
    if(!info || !info.id) return;
    try{
      if(info.kind === 'track') openTrackMenu(info.id);
      else if(info.kind === 'album') openAlbumContextMenu(info.id);
      else if(info.kind === 'artist') openArtistContextMenu(info.id);
    }catch(e){ console.warn('[ctx]', e) }
  }
  document.addEventListener('contextmenu', e => {
    const t = e.target;
    if(t && t.nodeType === 1 && t.closest('[data-play-id]')){ e.preventDefault(); e.stopPropagation(); return }
    const info = extractItem(t); if(!info) return;
    e.preventDefault(); e.stopPropagation();
    openContext(info);
  }, true);
  let lpTimer = null, lpX = 0, lpY = 0, lpInfo = null, lpFired = false;
  const LONG_MS = 480, MOVE_TOL = 14;
  document.addEventListener('touchstart', e => {
    if(e.touches.length !== 1) return;
    const t = e.target;
    if(t.closest('input,textarea,select,button,.icon-btn,[data-play-id],[data-no-context],.fp-controls,.mini-play,.player-bar')) return;
    const info = extractItem(t); if(!info) return;
    lpInfo = info; lpX = e.touches[0].clientX; lpY = e.touches[0].clientY; lpFired = false;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => { lpTimer = null; lpFired = true; try{ navigator.vibrate && navigator.vibrate(15) }catch{}; openContext(lpInfo) }, LONG_MS);
  }, {passive:true});
  document.addEventListener('touchmove', e => {
    if(!lpTimer) return;
    const dx = e.touches[0].clientX - lpX, dy = e.touches[0].clientY - lpY;
    if(dx*dx + dy*dy > MOVE_TOL*MOVE_TOL){ clearTimeout(lpTimer); lpTimer = null }
  }, {passive:true});
  document.addEventListener('touchend', e => {
    if(lpTimer){ clearTimeout(lpTimer); lpTimer = null }
    if(lpFired){ e.preventDefault(); e.stopPropagation(); lpFired = false }
  }, true);
  document.addEventListener('touchcancel', () => { if(lpTimer){ clearTimeout(lpTimer); lpTimer = null } lpFired = false }, {passive:true});
  window.openAlbumContextMenu = async function(id){
    if(!id) return;
    let a = getCached('collection', id);
    if(!a){ try{ const r = await apiLookup(id, 'album'); a = r.find(x => itemType(x) === 'collection') || r[0]; if(a) cacheItems([a]) }catch{} }
    if(!a){ toast('Album not available','danger'); return }
    const art = getArtwork(a, 100)||'',
          rows = [
            `<button class="sheet-item" onclick="closeAllSheets(); albumPlayAll('${esc(id)}')"><i class="bi bi-play-fill text-success"></i><span>Play album</span></button>`,
            `<button class="sheet-item" onclick="closeAllSheets(); albumQueueAll('${esc(id)}')"><i class="bi bi-list-ul"></i><span>Add to queue</span></button>`,
            `<button class="sheet-item info" onclick="closeAllSheets(); crawlAll('collection','${esc(id)}',this,false)"><i class="bi bi-cloud-arrow-down"></i><span>Crawl album</span></button>`,
            `<button class="sheet-item" onclick="closeAllSheets(); shareAlbum('${esc(id)}')"><i class="bi bi-share"></i><span>Share</span></button>`,
            `<button class="sheet-item" onclick="closeAllSheets(); copyText(location.origin + '${BASE||''}/album/${esc(id)}')"><i class="bi bi-link-45deg"></i><span>Copy link</span></button>`,
            `<button class="sheet-item" onclick="closeAllSheets(); go('/album/${esc(id)}')"><i class="bi bi-info-circle"></i><span>Open album</span></button>`,
            `<button class="sheet-item telegram" onclick="closeAllSheets(); tgStart('album','${esc(id)}')"><i class="bi bi-telegram"></i><span>Open in Telegram bot</span></button>`
          ].join('');
    $('#sheetTrackBody').innerHTML = `<div class="d-flex align-items-center gap-3 px-3 pb-3 pt-1">${art ? `<img src="${esc(art)}" width="52" height="52" class="row-art" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph"><i class="bi bi-disc"></i></div>`}<div class="min-w-0"><div class="fw-bold text-truncate">${esc(a.collectionName||'Album')}</div><div class="row-sub text-truncate">${esc(a.artistName||'')}</div></div></div><div class="px-2">${rows}</div>`;
    sheet('#sheetTrack').show();
  };
  window.openArtistContextMenu = async function(id){
    if(!id) return;
    let a = getCached('artist', id);
    if(!a){ try{ const r = await apiLookup(id, 'musicArtist'); a = r.find(x => itemType(x) === 'artist') || r[0]; if(a) cacheItems([a]) }catch{} }
    if(!a){ toast('Artist not available','danger'); return }
    const followed = isFollowed(id), art = getArtwork(a, 100)||'',
          rows = [
            `<button class="sheet-item" onclick="closeAllSheets(); artistRadio('${esc(id)}')"><i class="bi bi-broadcast text-primary"></i><span>Start radio</span></button>`,
            `<button class="sheet-item ${followed?'':'primary'}" data-follow="${esc(id)}" data-followers="${Number(a.followers)||0}" onclick="closeAllSheets(); toggleFollow('${esc(id)}','${esc(art)}')"><i class="bi ${followed?'bi-check-lg':'bi-plus-lg'}"></i><span class="follow-label">${followed?'Unfollow':'Follow'}</span>${Number(a.followers)>0?`<span class="follow-count" style="margin-left:auto;font-size:.72rem;opacity:.7;font-weight:800">${fmtCompact(a.followers)}</span>`:''}</button>`,
            `<button class="sheet-item info" onclick="closeAllSheets(); crawlAll('artist','${esc(id)}',this,false)"><i class="bi bi-cloud-arrow-down"></i><span>Crawl artist</span></button>`,
            `<button class="sheet-item" onclick="closeAllSheets(); shareArtist('${esc(id)}')"><i class="bi bi-share"></i><span>Share</span></button>`,
            `<button class="sheet-item" onclick="closeAllSheets(); copyText(location.origin + '${BASE||''}/artist/${esc(id)}')"><i class="bi bi-link-45deg"></i><span>Copy link</span></button>`,
            `<button class="sheet-item" onclick="closeAllSheets(); go('/artist/${esc(id)}')"><i class="bi bi-info-circle"></i><span>Open artist</span></button>`,
            `<button class="sheet-item telegram" onclick="closeAllSheets(); tgStart('artist','${esc(id)}')"><i class="bi bi-telegram"></i><span>Open in Telegram bot</span></button>`
          ].join('');
    $('#sheetTrackBody').innerHTML = `<div class="d-flex align-items-center gap-3 px-3 pb-3 pt-1">${art ? `<img src="${esc(art)}" width="52" height="52" class="row-art" style="border-radius:50%" loading="lazy" decoding="async" alt="">` : `<div class="row-art row-art-ph" style="border-radius:50%"><i class="bi bi-person-fill"></i></div>`}<div class="min-w-0"><div class="fw-bold text-truncate">${esc(a.artistName||'Artist')}</div><div class="row-sub text-truncate">${esc(a.primaryGenreName||'Artist')}</div></div></div><div class="px-2">${rows}</div>`;
    sheet('#sheetTrack').show();
  };
  window.albumPlayAll = async function(id){
    try{ const tracks = (await apiLookup(id, 'song')).filter(x => itemType(x) === 'track'); if(!tracks.length){ toast('No tracks','warning'); return } cacheItems(tracks); Player.queue = tracks; Player.index = 0; Player.shuffle = false; renderFpTabBody(); updateRightPanel(); playItem(tracks[0], 'Album') }catch{ toast('Failed to load album','danger') }
  };
  window.albumQueueAll = async function(id){
    try{ const tracks = (await apiLookup(id, 'song')).filter(x => itemType(x) === 'track'); if(!tracks.length){ toast('No tracks','warning'); return } cacheItems(tracks); addAllToQueue(tracks) }catch{ toast('Failed','danger') }
  };
  window.shareAlbum = function(id){
    const a = getCached('collection', id)||{}, url = location.origin + (BASE||'') + '/album/' + id,
          title = a.collectionName||'Album', text = `${title}${a.artistName?' — '+a.artistName:''}`;
    shareUrl({title, text, url});
  };
  window.shareArtist = function(id){
    const a = getCached('artist', id)||{}, url = location.origin + (BASE||'') + '/artist/' + id,
          title = a.artistName || 'Artist';
    shareUrl({title, text:title + ' on MusicMan', url});
  };
})();

/* Download long-press context */
(function(){
  'use strict';
  let t = null, x0 = 0, y0 = 0, rowEl = null, fired = false;
  const MOVE_TOL = 14, LONG_MS = 480;
  document.addEventListener('touchstart', e => {
    if(e.touches.length !== 1) return;
    const row = e.target.closest('[data-dl-id]'); if(!row) return;
    if(e.target.closest('button,a,input,textarea,select')) return;
    rowEl = row; fired = false; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    clearTimeout(t);
    t = setTimeout(() => {
      t = null; fired = true;
      try{ navigator.vibrate && navigator.vibrate(15) }catch{}
      const kind = rowEl.dataset.dlKind || 'track', id = rowEl.dataset.dlId;
      if(kind === 'batch'){ const it = DL.get(id); if(it){ if(it.subType === 'artist') openArtistContextMenu(it.sourceId); else openAlbumContextMenu(it.sourceId) } }
      else openTrackMenu(id);
    }, LONG_MS);
  }, {passive:true});
  document.addEventListener('touchmove', e => {
    if(!t) return;
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
    if(dx*dx + dy*dy > MOVE_TOL*MOVE_TOL){ clearTimeout(t); t = null }
  }, {passive:true});
  document.addEventListener('touchend', e => {
    if(t){ clearTimeout(t); t = null }
    if(fired){ e.preventDefault(); e.stopPropagation(); fired = false }
  }, true);
  document.addEventListener('touchcancel', () => { if(t){ clearTimeout(t); t = null } fired = false }, {passive:true});
})();