// ═══════════════════════════════════════════════════════════════════════════
//  Telegram Music Bot — Cloudflare Workers Edition (v5.9)
//  ── v5.9 ──
//  · NEW: forward-based file_id resolution (fixes "wrong file identifier")
//  · NEW: KV cache for forwarded file_ids (30 day TTL)
//  · FIX: inline audio works again (was: file_id from different bot token)
//  · Removed dependence on broken API telegramFileId
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_BOT_TOKEN='8891774006:AAEH1nT8L9HFnOF9AN9yLSqg8MrYDxZBz08';
const API_BASE_URL='https://3rah.ir/mm/api',API_TIMEOUT=20000;
const SOURCE_CHAT_ID='-1004499922541';
const STORAGE_CHAT_ID='-1004499922541';
const WEB_BASE='https://mm.3rah.ir',BOT_USERNAME='musicman_official_bot';
const LYRICS_IV_RHASH='50ad07e0386935';
const LYRICS_IV_TRACK=(id)=>`https://mm.3rah.ir/track/${id}`;
const lyricsIvUrl=(id)=>`https://t.me/iv?url=${encodeURIComponent(LYRICS_IV_TRACK(id))}&rhash=${LYRICS_IV_RHASH}`;
const ADMIN_ID=null;
const TRACKS_PER_PAGE=7,SEARCH_PER_PAGE=7,FAVS_PER_PAGE=7,QUEUE_PER_PAGE=7,MAX_SEARCH_LENGTH=100;
const FOOTER="\n\n@musicman_official\n@musicman_official_bot",FILEID_CACHE_TTL=30*24*3600;
const DEFAULT_SETTINGS={audioMode:'audio',compact:true,showDurations:true,preferredQuality:'auto',showCopyButton:true,inlineAudios:true,notifyOnDownload:true,showLyricsInCaption:true};
const SEARCH_ENTITY_CODES={all:'a',song:'s',album:'l',artist:'r'};
const SEARCH_ENTITY_FROM_CODE={a:'all',s:'song',l:'album',r:'artist'};
const SEARCH_ENTITY_LABELS={all:'🎵 All',song:'🎶 Songs',album:'💿 Albums',artist:'👤 Artists'};
const SEARCH_ENTITY_TO_API={song:'song',album:'album',artist:'musicArtist'};
const ACTIVE_DL_STATUSES=['pending','downloading','paused'];

const REQUIRED_CHANNELS=[
  {id:'@musicman_official', url:'https://t.me/musicman_official', label:'📢 MusicMan'},
  {id:'@invalid_sounds',    url:'https://t.me/invalid_sounds',    label:'📢 Invalid Sounds'}
];

const BROADCAST_HASHTAG='#musicman';
const BROADCAST_SOURCE_CHANNEL='@musicman_official';
const FOOTER_MARK_A='@musicman_official';
const FOOTER_MARK_B='@musicman_official_bot';
const TEXT_LIMIT=4096,CAPTION_LIMIT=1024;

let ENV={},BOT_TOKEN=DEFAULT_BOT_TOKEN;

const LOG_ENABLED = true;
const LOG_VERBOSE = false;
const LOG_INLINE  = true;

function blog(level,message,context){
  if(!LOG_ENABLED)return;
  let line=`[${level}] ${message}`;
  if(context!==undefined){
    try{line+=' | '+JSON.stringify(context);}catch{line+=' | [unstringifiable]';}
  }
  console.log(line);
}
function blogInline(message,context){if(LOG_ENABLED&&LOG_INLINE)blog('DEBUG','[INLINE] '+message,context);}

const esc=(t)=>t==null?'':String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const truncate=(t,len)=>{const c=Array.from(String(t));return c.length<=len?String(t):c.slice(0,Math.max(1,len-1)).join('')+'…';};
const withFooter=(t)=>t+FOOTER;
function buildKeyboard(buttons,options={}){const kb=Array.isArray(buttons)?buttons.map(r=>Array.isArray(r)?r.slice():r):[];if(!options.noClose)kb.push([{text:'✖️ Close',callback_data:'close'}]);return{inline_keyboard:kb};}
function fmtDuration(ms){const secs=Math.floor((ms||0)/1000);if(!secs)return'';return`${String(Math.floor(secs/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;}
function shortSha(str){let h=0;for(let i=0;i<str.length;i++)h=(h*31+str.charCodeAt(i))|0;return Math.abs(h).toString(36).slice(0,8);}
function yearOf(item){const m=String(item?.releaseDate||'').match(/^(\d{4})/);return m?m[1]:'';}
const webTrackLink=(id)=>`${WEB_BASE}/track/${id}`;
const webArtistLink=(id)=>`${WEB_BASE}/artist/${id}`;
const webAlbumLink=(id)=>`${WEB_BASE}/album/${id}`;
const botDeepLink=(type,id)=>`https://t.me/${BOT_USERNAME}?start=${type}_${id}`;
const shareUrl=(url,text)=>`https://t.me/share/url?url=${encodeURIComponent(url||'')}&text=${encodeURIComponent(text||'')}`;
const copyLinkButton=(label,text)=>({text:label,copy_text:{text}});
function b64encode(str){const bytes=new TextEncoder().encode(str);let bin='';for(const b of bytes)bin+=String.fromCharCode(b);return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function b64decode(b64){let s=b64.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const bin=atob(s);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return new TextDecoder().decode(bytes);}
function parseMusicmanLink(text){if(!text)return null;const s=String(text);let m=s.match(/(?:https?:\/\/)?(?:www\.)?mm\.3rah\.ir\/(track|album|artist)\/([A-Za-z0-9_\-]+)/i);if(m)return{type:m[1].toLowerCase(),id:m[2]};m=s.match(/t\.me\/musicman_official_bot\?start=(track|album|artist)_([A-Za-z0-9_\-]+)/i);if(m)return{type:m[1].toLowerCase(),id:m[2]};return null;}
const kvAvailable=()=>!!(ENV&&ENV.MUSIC_KV);
async function kvGet(key,fallback=null){if(!kvAvailable())return fallback;try{const raw=await ENV.MUSIC_KV.get(key,'json');return raw??fallback;}catch(e){blog('WARN',`kvGet ${key}: ${e.message}`);return fallback;}}
async function kvPut(key,value,ttl=null){if(!kvAvailable())return;try{await ENV.MUSIC_KV.put(key,JSON.stringify(value),ttl?{expirationTtl:ttl}:undefined);}catch(e){blog('WARN',`kvPut ${key}: ${e.message}`);}}
const kvDelete=async(key)=>{if(kvAvailable())try{await ENV.MUSIC_KV.delete(key);}catch{}};
const getUserSettings=async(userId)=>({...DEFAULT_SETTINGS,...((await kvGet(`u:${userId}:settings`,{}))||{})});
const setUserSettings=(userId,s)=>kvPut(`u:${userId}:settings`,s);
const updateUserSettings=async(userId,patch)=>{const n={...(await getUserSettings(userId)),...patch};await setUserSettings(userId,n);return n;};
const getFavorites=(userId)=>kvGet(`u:${userId}:favs`,[]);
async function setFavorites(userId,list){if(list.length>200)list=list.slice(-200);await kvPut(`u:${userId}:favs`,list);}
async function toggleFavorite(userId,trackId,meta){const list=await getFavorites(userId);const idx=list.findIndex(x=>String(x.id)===String(trackId));if(idx>=0){list.splice(idx,1);await setFavorites(userId,list);return false;}list.push({id:String(trackId),name:meta?.name||'',artist:meta?.artist||'',ts:Date.now()});await setFavorites(userId,list);return true;}
const isFavorite=async(userId,trackId)=>(await getFavorites(userId)).some(x=>String(x.id)===String(trackId));
async function pushHistory(userId,entry){if(!kvAvailable())return;const list=await kvGet(`u:${userId}:hist`,[]);const filtered=list.filter(x=>String(x.id)!==String(entry.id));filtered.push({...entry,ts:Date.now()});if(filtered.length>50)filtered.splice(0,filtered.length-50);await kvPut(`u:${userId}:hist`,filtered);}
const getHistory=(userId)=>kvGet(`u:${userId}:hist`,[]);

async function trackUser(userId){
  if(userId==null||!kvAvailable())return;
  try{
    const uid=String(userId);
    const list=await kvGet('broadcast:users',[]);
    const arr=Array.isArray(list)?list:[];
    if(!arr.includes(uid)){
      arr.push(uid);
      if(arr.length>50000)arr.splice(0,arr.length-50000);
      await kvPut('broadcast:users',arr);
    }
  }catch(e){blog('WARN',`trackUser: ${e.message}`);}
}
async function broadcastToAll(sourceChatId,sourceMessageId){
  if(!kvAvailable()){blog('WARN','Broadcast skipped: no KV');return;}
  const users=await kvGet('broadcast:users',[]);
  if(!Array.isArray(users)||users.length===0){blog('INFO','Broadcast: no users');return;}
  blog('INFO',`Broadcast start → ${users.length} users`);
  const blocked=[];let sent=0,failed=0;
  const batchSize=25;
  for(let i=0;i<users.length;i+=batchSize){
    const batch=users.slice(i,i+batchSize);
    const results=await Promise.all(batch.map(async uid=>{
      try{
        const r=await tgRequest('copyMessage',{chat_id:uid,from_chat_id:sourceChatId,message_id:sourceMessageId});
        if(r&&r.ok)return{ok:true,uid};
        const desc=String(r?.description||'').toLowerCase();
        const isBlocked=desc.includes('blocked')||desc.includes('deactivated')||desc.includes('chat not found')||desc.includes('user not found');
        return{ok:false,uid,blocked:isBlocked};
      }catch(e){return{ok:false,uid,blocked:false};}
    }));
    for(const r of results){if(r.ok)sent++;else{failed++;if(r.blocked)blocked.push(String(r.uid));}}
    if(i+batchSize<users.length)await new Promise(res=>setTimeout(res,1000));
  }
  if(blocked.length>0){const remaining=users.filter(u=>!blocked.includes(String(u)));try{await kvPut('broadcast:users',remaining);}catch{}}
  blog('INFO',`Broadcast done: sent=${sent} failed=${failed} removed=${blocked.length}`);
}
function isBroadcastSource(postChat){
  if(!postChat)return false;
  const wanted=String(BROADCAST_SOURCE_CHANNEL||REQUIRED_CHANNELS[0].id||'').trim().toLowerCase();
  if(!wanted)return false;
  const username=String(postChat.username||'').toLowerCase();
  if(wanted.startsWith('@'))return username&&username===wanted.slice(1);
  return String(postChat.id||'')===wanted;
}
function hasFooter(text){if(!text)return true;const t=String(text).replace(/\s+$/,'');const tail=t.slice(-200);return tail.includes(FOOTER_MARK_A)&&tail.includes(FOOTER_MARK_B);}
function appendFooterWithLimit(text,limit){
  const body=String(text==null?'':text).replace(/\s+$/,'');
  if(hasFooter(body))return null;
  if(body.length+FOOTER.length<=limit)return body+FOOTER;
  const room=Math.max(1,limit-FOOTER.length-1);
  return body.slice(0,room)+'…'+FOOTER;
}
async function ensureChannelFooter(post){
  try{
    const hasText=typeof post.text==='string'&&post.text.length>0;
    const hasCaption=typeof post.caption==='string'&&post.caption.length>0;
    const hasMedia=!!(post.photo||post.video||post.document||post.audio||post.voice||post.animation);
    if(hasText){
      const newText=appendFooterWithLimit(post.text,TEXT_LIMIT);
      if(newText){
        const params={chat_id:post.chat.id,message_id:post.message_id,text:newText};
        if(Array.isArray(post.entities)&&post.entities.length>0)params.entities=post.entities;
        const r=await tgRequest('editMessageText',params);
        if(!r||!r.ok)blog('WARN',`footer edit (text) failed: ${r&&r.description}`);
      }
    } else if(hasCaption){
      const newCaption=appendFooterWithLimit(post.caption,CAPTION_LIMIT);
      if(newCaption){
        const params={chat_id:post.chat.id,message_id:post.message_id,caption:newCaption};
        if(Array.isArray(post.caption_entities)&&post.caption_entities.length>0)params.caption_entities=post.caption_entities;
        const r=await tgRequest('editMessageCaption',params);
        if(!r||!r.ok)blog('WARN',`footer edit (caption) failed: ${r&&r.description}`);
      }
    } else if(hasMedia){
      const cap=FOOTER.replace(/^\s+/,'');
      const r=await tgRequest('editMessageCaption',{chat_id:post.chat.id,message_id:post.message_id,caption:cap});
      if(!r||!r.ok)blog('WARN',`footer add (caption) failed: ${r&&r.description}`);
    }
  }catch(e){blog('WARN',`ensureChannelFooter: ${e.message}`);}
}

const getUserQueue=(userId)=>kvGet(`u:${userId}:queue`,[]);
async function setUserQueue(userId,list){if(list.length>100)list=list.slice(-100);await kvPut(`u:${userId}:queue`,list);}
async function appendUserQueue(userId,entries){const list=await getUserQueue(userId);const seen=new Set(list.map(x=>String(x.id)));for(const e of entries){const k=String(e.id);if(seen.has(k)){const i=list.findIndex(x=>String(x.id)===k);if(i>=0)list[i]={...list[i],...e};}else{list.push(e);seen.add(k);}}await setUserQueue(userId,list);}

// ═══════════════════════════════════════════════════════════════════════════
//  FILE-ID CACHE
// ═══════════════════════════════════════════════════════════════════════════
async function cacheAudioFileId(trackId,fileId){
  if(!trackId||!fileId)return;
  await kvPut(`fid:${trackId}`,{fileId,ts:Date.now()},FILEID_CACHE_TTL);
}
async function getCachedAudioFileId(trackId){
  if(!kvAvailable())return null;
  try{
    const v=await kvGet(`fid:${trackId}`,null);
    return (v&&v.fileId)||null;
  }catch(e){blog('ERROR','getCachedAudioFileId failed',{trackId,err:e.message});return null;}
}

// ═══════════════════════════════════════════════════════════════════════════
//  🔥 v5.9 — FORWARD-BASED file_id RESOLUTION
//  Because API file_ids come from a different bot, they can't be used.
//  We forward the source message to get a fresh file_id valid for OUR bot,
//  then cache it in KV.
// ═══════════════════════════════════════════════════════════════════════════
async function forwardForFileId(messageId, fromChat, toChat) {
  try{
    const r = await tgRequest('forwardMessage', {
      chat_id: toChat,
      from_chat_id: fromChat,
      message_id: String(messageId)
    });
    if(!r || !r.ok || !r.result){
      blog('WARN','forwardForFileId failed',{messageId, desc:r&&r.description});
      return { fileId:null, newMessageId:null };
    }
    const m = r.result;
    const audio = m.audio || m.document || m.voice || null;
    const fileId = audio?.file_id || null;
    return { fileId, newMessageId: m.message_id || null, filename: audio?.file_name || null };
  }catch(e){
    blog('WARN','forwardForFileId exception',{messageId, err:e.message});
    return { fileId:null, newMessageId:null };
  }
}

async function ensureValidFileIds(items){
  const fileIdMap = new Map();
  const trackItems = [];
  for(const item of items){
    if((item.wrapperType||'track') !== 'track') continue;
    const trackId = String(item.trackId||'');
    if(!trackId) continue;
    const audioUrls = telegramAudioMirrors((item.attachments && item.attachments.audioUrls) || []);
    if(!audioUrls.length) continue;
    trackItems.push({ item, trackId });
  }
  if(trackItems.length === 0) return fileIdMap;

  // Step 1: KV cache lookups (parallel)
  const kvResults = await Promise.all(trackItems.map(async ({trackId}) => {
    const cached = await getCachedAudioFileId(trackId);
    return { trackId, cached };
  }));
  const needForward = [];
  for(const {trackId, cached} of kvResults){
    if(cached) fileIdMap.set(trackId, cached);
    else needForward.push(trackId);
  }

  blogInline('ensureValidFileIds',{
    totalTracks: trackItems.length,
    fromKV: fileIdMap.size,
    toForward: needForward.length
  });

  if(needForward.length === 0) return fileIdMap;

  // Step 2: forward messages in parallel (limit 5)
  const needSet = new Set(needForward);
  const toForward = trackItems.filter(t => needSet.has(t.trackId));

  await mapLimit(toForward, 5, async ({item, trackId}) => {
    const audioUrls = telegramAudioMirrors((item.attachments && item.attachments.audioUrls) || []);
    for(const au of audioUrls){
      const msgId = au.telegramMessageId || au.telegram_message_id
        || extractMessageIdFromUrl(au.telegramFileUrl||au.url);
      if(!msgId) continue;
      const storageChat = STORAGE_CHAT_ID || SOURCE_CHAT_ID;
      if(!storageChat || !SOURCE_CHAT_ID) break;

      const { fileId, newMessageId, filename } = await forwardForFileId(msgId, SOURCE_CHAT_ID, storageChat);

      if(fileId){
        fileIdMap.set(trackId, fileId);
        await cacheAudioFileId(trackId, fileId);
        persistFileId(trackId,fileId,{messageId:msgId,quality:au.quality,filename});
        blogInline('file_id cached from forward',{trackId, fileIdLen: fileId.length});
        if(newMessageId){
          ctx_waitUntil(tgRequest('deleteMessage',{chat_id:storageChat,message_id:newMessageId}).catch(()=>{}));
        }
        return;
      }
    }
  });

  blogInline('ensureValidFileIds done',{resolved: fileIdMap.size, total: trackItems.length});
  return fileIdMap;
}

const RL_BUCKET=new Map(),RL_WINDOW_MS=30000,RL_MAX=25;
function rateLimited(userId){const now=Date.now();const arr=(RL_BUCKET.get(userId)||[]).filter(t=>now-t<RL_WINDOW_MS);if(arr.length>=RL_MAX){RL_BUCKET.set(userId,arr);return true;}arr.push(now);RL_BUCKET.set(userId,arr);return false;}

const MEMBERSHIP_CACHE=new Map(),MEMBERSHIP_TTL_MS=10*60*1000;
async function checkMembership(userId){
  const cached=MEMBERSHIP_CACHE.get(userId);
  if(cached&&(Date.now()-cached.ts)<MEMBERSHIP_TTL_MS)return cached;
  const missing=[];
  for(const ch of REQUIRED_CHANNELS){
    try{
      const r=await tgRequest('getChatMember',{chat_id:ch.id,user_id:userId});
      if(!r||!r.ok){
        const desc=String(r?.description||'').toLowerCase();
        if(desc.includes('not found')||desc.includes('participant'))missing.push(ch);
        continue;
      }
      const status=r.result?.status||'left';
      const allowed=['creator','administrator','member'].includes(status);
      if(!allowed)missing.push(ch);
    }catch(e){blog('ERROR',`checkMembership: ${e.message}`);}
  }
  const res={ok:missing.length===0,status:missing.length===0?'member':'left',missing,ts:Date.now()};
  MEMBERSHIP_CACHE.set(userId,res);
  return res;
}
async function sendJoinRequired(chatId,editMessageId=null,missing=null){
  const channels=(Array.isArray(missing)&&missing.length>0)?missing:REQUIRED_CHANNELS;
  const plural=channels.length>1;
  let text=`🔒 <b>Join Required</b>\n\nTo use this bot, please join our channel${plural?'s':''} first:\n\n`;
  for(const ch of channels)text+=`👉 ${ch.url}\n`;
  text+=`\nAfter joining, tap "✅ I Joined" below.`+FOOTER;
  const buttons=channels.map(ch=>[{text:ch.label||'📢 Join Channel',url:ch.url}]);
  buttons.push([{text:'✅ I Joined — Verify',callback_data:'chk_join'}]);
  const kb=JSON.stringify(buildKeyboard(buttons));
  if(editMessageId){
    const r=await tgRequest('editMessageText',{chat_id:chatId,message_id:editMessageId,text,parse_mode:'HTML',reply_markup:kb});
    if(r&&r.ok)return;
  }
  await tgRequest('sendMessage',{chat_id:chatId,text,parse_mode:'HTML',reply_markup:kb,disable_web_page_preview:true});
}

function cacheGet(cache,key,ttl){const hit=cache.get(key);if(!hit)return null;if(Date.now()-hit.ts>ttl){cache.delete(key);return null;}cache.delete(key);cache.set(key,hit);return hit.value;}
function cacheSet(cache,max,key,value){if(cache.size>=max){const first=cache.keys().next().value;if(first!==undefined)cache.delete(first);}cache.set(key,{value,ts:Date.now()});}
const __apiCache=new Map();const API_CACHE_TTL=30*1000;const API_CACHE_MAX=400;
const __trackCache=new Map();const TRACK_CACHE_TTL=5*60*1000;const TRACK_CACHE_MAX=600;
const __searchCache=new Map();const SEARCH_CACHE_TTL=60*1000;const SEARCH_CACHE_MAX=300;

async function mapLimit(items,limit,fn){
  const arr=Array.from(items);
  const out=new Array(arr.length);
  let next=0;
  const workers=Array.from({length:Math.max(1,Math.min(limit,arr.length||1))},async()=>{
    while(true){
      const i=next++;
      if(i>=arr.length)return;
      try{out[i]=await fn(arr[i],i);}catch(e){blog('WARN',`mapLimit: ${e.message}`);out[i]=null;}
    }
  });
  await Promise.all(workers);
  return out;
}

async function tgRequest(method,params={}){
  const form=new URLSearchParams();
  for(const[k,v]of Object.entries(params)){
    if(v===null||v===undefined)continue;
    form.append(k,typeof v==='object'?JSON.stringify(v):String(v));
  }
  try{
    const res=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:'POST',body:form});
    const data=await res.json().catch(()=>null);
    if(!res.ok||!data||!data.ok)blog('ERROR',`TG ${method} FAIL (${res.status})`,data||{});
    return data;
  }catch(e){blog('ERROR',`TG ${method}: ${e.message}`);return null;}
}
const chatAction=(chatId,action='typing')=>tgRequest('sendChatAction',{chat_id:chatId,action}).catch(()=>{});

async function apiRequest(endpoint,params={},method='GET'){
  const headers={Accept:'application/json','Platform':'telegram'};
  let url=API_BASE_URL+endpoint;
  const options={method,headers};
  if(method==='GET'&&Object.keys(params).length>0){const qs=new URLSearchParams();for(const[k,v]of Object.entries(params))qs.append(k,String(v));url+='?'+qs.toString();}
  else if(method==='POST'){headers['Content-Type']='application/json';options.body=JSON.stringify(params);}
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),API_TIMEOUT);
  try{
    const res=await fetch(url,{...options,signal:controller.signal});
    clearTimeout(timer);
    const text=await res.text();
    let data=null;try{data=JSON.parse(text);}catch{}
    if(res.status>=400)return data||{success:false,error:`HTTP ${res.status}`};
    return data||{success:false,error:'Invalid JSON'};
  }
  catch(e){clearTimeout(timer);blog('ERROR',`API ${endpoint}: ${e.message}`);return{success:false,error:'Network error'};}
}
async function apiRequestCached(endpoint,params={},ttl=API_CACHE_TTL){
  const key=endpoint+'?'+JSON.stringify(params);
  const hit=cacheGet(__apiCache,key,ttl);
  if(hit!==null&&hit!==undefined)return hit;
  const data=await apiRequest(endpoint,params,'GET');
  if(data&&!data.error)cacheSet(__apiCache,API_CACHE_MAX,key,data);
  return data;
}

async function fetchTrack(trackId){
  const k=String(trackId);
  const hit=cacheGet(__trackCache,k,TRACK_CACHE_TTL);
  if(hit!==null&&hit!==undefined)return hit;
  try{
    const r=await apiRequestCached('/lookup',{id:k,entity:'song'});
    const t=(r.results||[])[0]||null;
    cacheSet(__trackCache,TRACK_CACHE_MAX,k,t);
    return t;
  }catch{return null;}
}
async function checkTracksInQueue(trackIds,userId=null){
  const out=new Map();
  const ids=(Array.isArray(trackIds)?trackIds:[trackIds]).map(String).filter(Boolean);
  if(ids.length===0)return out;
  const uid=userId!=null?String(userId):null;
  try{
    const r=await apiRequest('/download/batch-status',{ids:ids.join(',')});
    const items=(r&&r.success&&r.items)||{};
    for(const tid of ids){
      const it=items[String(tid)];
      if(it&&it.found){
        const targets=Array.isArray(it.telegramTargets)?it.telegramTargets:[];
        const inQueue=ACTIVE_DL_STATUSES.includes(it.download_status);
        const inQueueForUser=inQueue&&uid!==null&&targets.some(t=>{const tu=t.userId!=null?String(t.userId):null;const tc=t.chatId!=null?String(t.chatId):null;return tu===uid||tc===uid;});
        out.set(String(tid),{inQueue,inQueueForUser,status:it.download_status,downloadId:it.download_id??null,targets});
      }else{out.set(String(tid),{inQueue:false,inQueueForUser:false,status:null,downloadId:null,targets:[]});}
    }
  }catch(e){blog('WARN',`checkTracksInQueue failed: ${e.message}`);}
  return out;
}

const upgradeArtwork=(url100)=>url100?url100.replace(/\/\d+x\d+bb\./,'/600x600bb.'):'';

function pickBestArtwork(artworkUrls){
  if(!artworkUrls||artworkUrls.length===0)return null;
  let mirrorBest=null,mirrorScore=-1,itunesBest=null,itunesScore=-1;
  for(const a of artworkUrls){
    const url=a.url||'';if(!url)continue;
    const size=String(a.size||'');
    let score;
    if(size==='original')score=100000;
    else if(size==='mirror')score=50000;
    else if(/^\d+x\d+$/.test(size))score=parseInt(size.split('x')[0],10)||0;
    else if(/^\d+$/.test(size))score=parseInt(size,10)||0;
    else score=0;
    if(a.source==='itunes'){if(score>itunesScore){itunesScore=score;itunesBest=url;}}
    else{if(score>mirrorScore){mirrorScore=score;mirrorBest=url;}}
  }
  if(mirrorBest)return mirrorBest;
  return itunesBest?itunesBest.replace(/\/\d+x\d+bb\./,'/500x500bb.'):null;
}

function parseAudioSource(url){
  url=String(url).trim();let m;
  if((m=url.match(/api\.telegram\.org\/(?:file\/)?bot[^/]+\/(.+)$/i))){
    const last=m[1].trim();
    if(/^\d+$/.test(last)&&last.length<=12)return{type:'message_id',value:parseInt(last,10)};
    if(last.length>20)return{type:'file_id',value:last};
    return{type:'unknown',value:last};
  }
  if(/^\d+$/.test(url)&&url.length<=12)return{type:'message_id',value:parseInt(url,10)};
  if(/^[A-Za-z0-9_\-]{20,}$/.test(url))return{type:'file_id',value:url};
  try{new URL(url);return{type:'url',value:url};}catch{return{type:'unknown',value:url};}
}

function isTelegramAudioMirror(audio){
  if(!audio||typeof audio!=='object')return false;
  const source=String(audio.source||audio.platform||'').toLowerCase();
  const url=String(audio.url||'').toLowerCase();
  return ['telegram','tg','telegram_bot'].includes(source)
    || isTelegramBotFileUrl(audio.url)
    || /(?:^|\/\/)(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i.test(url)
    || url.startsWith('tg://')
    || url.startsWith('telegram://')
    || !!audio.telegramFileId
    || !!audio.telegramMessageId;
}
function isTelegramBotFileUrl(value){
  try{
    const url=new URL(String(value||''));
    return url.protocol==='https:'
      && url.hostname.toLowerCase()==='api.telegram.org'
      && /^\/file\/bot[^/]+\/.+$/i.test(url.pathname);
  }catch{return false;}
}
function telegramAudioMirrors(audioUrls){
  return Array.isArray(audioUrls)?audioUrls.filter(isTelegramAudioMirror):[];
}
function isBaleAudioMirror(audio){
  if(!audio||typeof audio!=='object')return false;
  const source=String(audio.source||audio.platform||'').toLowerCase();
  const url=String(audio.baleFileUrl||audio.url||'').toLowerCase();
  return ['bale','balethon'].includes(source)
    || url.startsWith('bale://')
    || url.includes('bale.ai/')
    || url.includes('ble.ir/')
    || !!audio.baleFileId;
}

function pickBestAudio(audioUrls,preferred='auto'){
  audioUrls=telegramAudioMirrors(audioUrls);
  if(audioUrls.length===0)return null;
  let best=null,bestScore=-Infinity;
  for(const a of audioUrls){
    const q=parseInt(a.quality||0,10);
    let s=q;
    if(preferred==='high')s+=q*2;
    if(preferred==='low')s-=q;
    if(s>bestScore){bestScore=s;best=a;}
  }
  return best;
}

function extractFileIdFromSendResult(r){if(!r||!r.ok||!r.result)return null;const m=r.result;return m.audio?.file_id||m.voice?.file_id||m.document?.file_id||null;}
function extractMessageIdFromUrl(rawUrl){
  if(!rawUrl)return null;
  const s=String(rawUrl).trim();
  const m=s.match(/api\.telegram\.org\/(?:file\/)?bot[^/]+\/(\d+)$/i);
  if(m)return m[1];
  if(/^\d+$/.test(s)&&s.length<=12)return s;
  try{
    const url=new URL(s);
    if(['t.me','www.t.me','telegram.me','www.telegram.me','telegram.dog','www.telegram.dog'].includes(url.hostname.toLowerCase())){
      const last=url.pathname.split('/').filter(Boolean).pop();
      if(last&&/^\d+$/.test(last))return last;
    }
  }catch{}
  return null;
}
function persistFileId(trackId,fileId,extra={}){
  if(!trackId||!fileId)return;
  cacheAudioFileId(trackId,fileId).catch(()=>{});
  const payload={platform:'telegram',trackId:String(trackId),fileId:String(fileId)};
  if(extra.messageId)payload.messageId=String(extra.messageId);
  if(extra.quality)payload.quality=String(extra.quality);
  if(extra.filename)payload.filename=String(extra.filename);
  const p=(async()=>{
    try{
      const file=await tgRequest('getFile',{file_id:String(fileId)});
      const filePath=file&&file.ok&&file.result&&file.result.file_path;
      if(filePath)payload.filePath=String(filePath);
      if(!payload.filename&&filePath)payload.filename=String(filePath).split('/').pop();
      const saved=await apiRequest('/file/save',payload,'POST');
      if(!saved||saved.success!==true)blog('WARN',`persistFileId failed: ${(saved&&saved.error)||'API did not save file details'}`);
    }catch(e){blog('WARN',`persistFileId failed: ${e&&e.message}`);}
  })();
  ctx_waitUntil(p);
}
async function extractFileIdViaForward(messageId,storageChatId){
  if(!messageId||!storageChatId)return{fileId:null,newMessageId:null};
  return forwardForFileId(messageId, SOURCE_CHAT_ID, storageChatId);
}

async function sendAudioToUser(chatId,audioUrl,opts={}){
  let parsed=parseAudioSource(audioUrl);
  const thumb=opts.thumbnail||undefined,title=opts.title||undefined,performer=opts.performer||undefined,asDoc=opts.mode==='document',trackId=opts.trackId;
  let sourceMessageId=opts.sourceMessageId||null;
  if(!sourceMessageId){
    if(parsed.type==='message_id')sourceMessageId=String(parsed.value);
    else if(parsed.type==='url')sourceMessageId=extractMessageIdFromUrl(parsed.value);
  }
  if(sourceMessageId)parsed={type:'message_id',value:String(sourceMessageId)};
  const persistMeta={messageId:sourceMessageId,quality:opts.quality||null};
  const remember=(fid)=>persistFileId(trackId,fid,persistMeta);
  chatAction(chatId,asDoc?'upload_document':'upload_audio');

  if(parsed.type==='file_id'){
    if(asDoc){
      const r=await tgRequest('sendDocument',{chat_id:chatId,document:parsed.value,thumbnail:thumb,caption:opts.caption});
      if(r&&r.ok){const fid=extractFileIdFromSendResult(r);if(fid)remember(fid);return{success:true,method:'sendDocument'};}
    }
    let r=await tgRequest('sendAudio',{chat_id:chatId,audio:parsed.value,thumbnail:thumb,title,performer,caption:opts.caption});
    if(r&&r.ok){const fid=extractFileIdFromSendResult(r);if(fid)remember(fid);return{success:true,method:'sendAudio'};}
    r=await tgRequest('sendDocument',{chat_id:chatId,document:parsed.value,thumbnail:thumb,caption:opts.caption});
    if(r&&r.ok){const fid=extractFileIdFromSendResult(r);if(fid)remember(fid);return{success:true,method:'sendDocument'};}
    return{success:false,error:'file_id rejected'};
  }
  if(parsed.type==='message_id'){
    if(!SOURCE_CHAT_ID)return{success:false,error:'SOURCE_CHAT_ID not configured'};
    const copyP=tgRequest('copyMessage',{chat_id:chatId,from_chat_id:SOURCE_CHAT_ID,message_id:parsed.value});
    const fidP=(trackId&&STORAGE_CHAT_ID)?extractFileIdViaForward(parsed.value,STORAGE_CHAT_ID):Promise.resolve({fileId:null,newMessageId:null});
    const[copyRes,probeRes]=await Promise.all([copyP,fidP]);
    if(probeRes.fileId&&trackId)remember(probeRes.fileId);
    if(probeRes.newMessageId){ctx_waitUntil(tgRequest('deleteMessage',{chat_id:STORAGE_CHAT_ID,message_id:probeRes.newMessageId}).catch(()=>{}));}
    if(copyRes&&copyRes.ok)return{success:true,method:'copyMessage',fileId:probeRes.fileId||null};
    return{success:false,error:'copy failed: '+((copyRes&&copyRes.description)||'?')};
  }
  if(parsed.type==='url'){
    if(asDoc){
      const rd=await tgRequest('sendDocument',{chat_id:chatId,document:parsed.value,thumbnail:thumb,caption:opts.caption});
      if(rd&&rd.ok){const fid=extractFileIdFromSendResult(rd);if(fid)remember(fid);return{success:true,method:'sendDocument'};}
    }
    const r=await tgRequest('sendAudio',{chat_id:chatId,audio:parsed.value,thumbnail:thumb,title,performer,caption:opts.caption});
    if(r&&r.ok){const fid=extractFileIdFromSendResult(r);if(fid)remember(fid);return{success:true,method:'sendAudio'};}
    return{success:false,error:'URL failed'};
  }
  return{success:false,error:'Unknown source'};
}
function extractLyricsText(lyrics){
  if(!lyrics)return null;
  const text=lyrics.text;
  if(text===null||text===undefined)return null;
  if(typeof text==='object'&&!Array.isArray(text)&&text.plain!==undefined)return String(text.plain).trim();
  if(Array.isArray(text))return text.filter(t=>typeof t==='string').join('\n').trim();
  if(typeof text==='string')return text.trim();
  return null;
}

async function navigatePage(chatId,editMessageId,text,photoUrl,buttons,opts={}){
  const loadingText=opts.loadingText||'⏳ <i>Loading…</i>';
  const action=opts.action||'typing';
  let fullText=withFooter(text);
  const kb=JSON.stringify(buildKeyboard(buttons));
  if(photoUrl&&Array.from(fullText).length>1024)photoUrl=null;
  chatAction(chatId,action);

  if(!editMessageId){
    const lr=await tgRequest('sendMessage',{chat_id:chatId,text:loadingText,parse_mode:'HTML'});
    if(lr&&lr.ok)editMessageId=lr.result.message_id;
  }

  if(editMessageId){
    if(photoUrl){
      const media={type:'photo',media:photoUrl,caption:fullText,parse_mode:'HTML'};
      const r=await tgRequest('editMessageMedia',{chat_id:chatId,message_id:editMessageId,media:JSON.stringify(media),reply_markup:kb});
      if(r&&r.ok)return;
      blog('WARN','editMessageMedia failed',{description:r&&r.description});
    }else{
      const r=await tgRequest('editMessageText',{chat_id:chatId,message_id:editMessageId,text:fullText,parse_mode:'HTML',reply_markup:kb,disable_web_page_preview:true});
      if(r&&r.ok)return;
      if(r&&r.description==='Bad Request: message is not modified')return;
    }
    await tgRequest('deleteMessage',{chat_id:chatId,message_id:editMessageId});
  }

  if(photoUrl){
    chatAction(chatId,'upload_photo');
    const r=await tgRequest('sendPhoto',{chat_id:chatId,photo:photoUrl,caption:fullText,parse_mode:'HTML',reply_markup:kb});
    if(r&&r.ok)return;
  }
  await tgRequest('sendMessage',{chat_id:chatId,text:fullText,parse_mode:'HTML',reply_markup:kb,disable_web_page_preview:true});
}

async function sendNotice(chatId,text,extraButtons=[]){
  chatAction(chatId,'typing');
  await tgRequest('sendMessage',{chat_id:chatId,text:withFooter(text),parse_mode:'HTML',reply_markup:JSON.stringify(buildKeyboard(extraButtons)),disable_web_page_preview:true});
}
async function encodeSearchCb(query,offset=0,entity='all'){
  const code=SEARCH_ENTITY_CODES[entity]||'a';
  const b64=b64encode(query);
  const inline=`s~${b64}~${code}~${offset}`;
  if(inline.length<=64)return inline;
  if(kvAvailable()){
    const hash=shortSha(query+'|'+entity);
    await kvPut(`sc:${hash}`,{q:query,e:entity},3600);
    return`s~.${hash}~${code}~${offset}`;
  }
  return`s~${b64encode(Array.from(query).slice(0,30).join(''))}~${code}~${offset}`;
}
async function decodeSearchCb(data){
  if(data.startsWith('s_')){
    const rest=data.slice(2);const pos=rest.lastIndexOf('_');
    if(pos===-1)return null;
    const offset=parseInt(rest.slice(pos+1),10)||0;
    let query='';try{query=b64decode(rest.slice(0,pos));}catch{return null;}
    return{query,entity:'all',offset};
  }
  if(!data.startsWith('s~'))return null;
  const parts=data.split('~');
  if(parts.length<4)return null;
  const[,payload,code,offsetStr]=parts;
  const offset=parseInt(offsetStr,10)||0;
  const entity=SEARCH_ENTITY_FROM_CODE[code]||'all';
  if(payload.startsWith('.')){
    const stored=await kvGet(`sc:${payload.slice(1)}`,null);
    if(!stored)return null;
    return{query:stored.q,entity:stored.e||entity,offset};
  }
  let query='';try{query=b64decode(payload);}catch{return null;}
  return{query,entity,offset};
}

// ═══════════════════ MENUS ═══════════════════
async function handleStart(chatId,messageId=null,userId=null){
  const text=`🎵 <b>MusicMan</b>\n<i>Search · stream · save — inside Telegram.</i>\n\n🔍 <b>Search</b> — just type any name\n🎶 Filter by <b>Songs</b>, <b>Albums</b>, or <b>Artists</b>\n⚡ Try inline: <code>@${BOT_USERNAME} adele</code>`;
  const buttons=[[{text:'🔥 Popular',callback_data:'p_0'},{text:'✨ Fresh',callback_data:'f_0'}],[{text:'🎲 Random',callback_data:'rnd'},{text:'⭐ Favourites',callback_data:'fav_list_0'}],[{text:'🕘 Recent',callback_data:'hist_0'}],[{text:'⚙️ Settings',callback_data:'settings'},{text:'📊 Stats',callback_data:'cmd_stats'}],[{text:'❓ Help',callback_data:'cmd_help'}]];
  await navigatePage(chatId,messageId,text,null,buttons,{loadingText:'⏳ <i>Loading menu…</i>'});
}
async function handleHelp(chatId,messageId=null){
  const text=`❓ <b>Help & Commands</b>\n\n<b>🔍 Search & browse</b>\n• Just type a name to search\n• Filter by <b>Songs · Albums · Artists</b>\n• <code>/search &lt;query&gt;</code>\n• <code>/popular</code> · <code>/fresh</code> · <code>/random</code>\n\n<b>📚 Your library</b>\n• <code>/favorites</code> — saved tracks ⭐\n• <code>/recent</code> — recently viewed\n• <code>/settings</code> — preferences\n\n<b>⬇️ Downloads</b>\n• Track page → <b>⬇️ Download (queue)</b>\n• Album page → <b>⬇️ Download Album</b>\n• Artist page → <b>🕷 Crawl</b>\n\n<b>🚀 Inline mode</b>\n• <code>@${BOT_USERNAME} your query</code>\n• Paste a <code>mm.3rah.ir</code> link\n• Track results show lyrics preview + IV link\n\n<b>💡 Tips</b>\n• Save tracks with ⭐ to build your library\n• Use 🎲 Shuffle on artist / album pages\n• Every page has 🌐 Web & 📋 Copy link`;
  const buttons=[[{text:'🔥 Popular',callback_data:'p_0'},{text:'🎲 Random',callback_data:'rnd'}],[{text:'⚙️ Settings',callback_data:'settings'},{text:'🏠 Main Menu',callback_data:'cmd_start'}]];
  await navigatePage(chatId,messageId,text,null,buttons,{loadingText:'⏳ <i>Loading help…</i>'});
}
async function handleSearch(chatId,query,offset=0,editMessageId=null,userId=null,entity='all'){
  query=String(query).trim();
  const chars=Array.from(query);
  if(chars.length>MAX_SEARCH_LENGTH)query=chars.slice(0,MAX_SEARCH_LENGTH).join('');
  if(Array.from(query).length<2){await sendNotice(chatId,'Please enter at least 2 characters.');return;}
  const settingsP=userId?getUserSettings(userId):Promise.resolve(DEFAULT_SETTINGS);
  const limit=SEARCH_PER_PAGE;
  const apiParams={term:query,limit,offset};
  const backendEntity=SEARCH_ENTITY_TO_API[entity];
  if(backendEntity)apiParams.entity=backendEntity;
  const[settings,response]=await Promise.all([settingsP,apiRequestCached('/search',apiParams,SEARCH_CACHE_TTL)]);
  const rawItems=(response&&response.results)||[];
  const weight=(it)=>{const w=it.wrapperType||'track';return w==='track'?0:w==='collection'?1:w==='artist'?2:3;};
  const items=rawItems.slice().sort((a,b)=>weight(a)-weight(b));
  const filterRows=await Promise.all([
    Promise.all(['all','song'].map(async key=>({text:(entity===key?'✅ ':'')+SEARCH_ENTITY_LABELS[key],callback_data:await encodeSearchCb(query,0,key)}))),
    Promise.all(['album','artist'].map(async key=>({text:(entity===key?'✅ ':'')+SEARCH_ENTITY_LABELS[key],callback_data:await encodeSearchCb(query,0,key)})))
  ]);
  if(items.length===0){
    const filterLabel=entity!=='all'?` · ${SEARCH_ENTITY_LABELS[entity]}`:'';
    await navigatePage(chatId,editMessageId,`❌ <b>No results</b> for: <i>${esc(query)}</i>${filterLabel}\n\nTry a different filter or query.`,null,[...filterRows,[{text:'🎲 Try Random',callback_data:'rnd'}],[{text:'🏠 Main Menu',callback_data:'cmd_start'}]],{loadingText:'🔍 <i>Searching…</i>'});
    return;
  }
  const page=Math.floor(offset/limit)+1;
  const startNum=offset+1;
  const endNum=offset+items.length;
  const hasNext=items.length>=limit;
  const hasPrev=offset>0;
  let text=`🔍 <b>Search:</b> <i>${esc(query)}</i>\n`;
  if(entity!=='all')text+=`🎯 Filter: <b>${SEARCH_ENTITY_LABELS[entity]}</b>\n`;
  text+=`📄 Page <b>${page}</b> · ${startNum}–${endNum}${hasNext?'+':''}\n\n`;
  const buttons=[];
  let i=offset+1;
  for(const item of items){
    const w=item.wrapperType||'track';
    const id=item.trackId??item.collectionId??item.artistId??'';
    if(!id){i++;continue;}
    const name=item.trackName??item.collectionName??item.artistName??'Unknown';
    const artist=item.artistName||'';
    const yr=yearOf(item);
    const dur=settings.showDurations?fmtDuration(parseInt(item.trackTimeMillis||0,10)):'';
    let icon,cb;
    if(w==='artist'){icon='👤';cb=`a_${id}`;}
    else if(w==='collection'){icon='💿';cb=`l_${id}`;}
    else{icon='🎵';cb=`t_${id}`;}
    text+=`<b>${i}.</b> ${icon} <b>${esc(truncate(name,55))}</b>`;
    if(w==='track'&&artist&&artist!==name)text+=` — <i>${esc(truncate(artist,40))}</i>`;
    if((w==='collection'||w==='artist')&&yr)text+=` (${yr})`;
    if(dur)text+=` <code>${dur}</code>`;
    text+='\n';
    let label;
    if(w==='track'){const a=artist?` · ${truncate(artist,18)}`:'';const d=dur?` · ${dur}`:'';label=`${i}. ${icon} ${truncate(name,26)}${a}${d}`;}
    else if(w==='collection'){const a=artist?` · ${truncate(artist,18)}`:'';const y=yr?` · ${yr}`:'';label=`${i}. ${icon} ${truncate(name,26)}${a}${y}`;}
    else{const g=item.primaryGenreName?` · ${truncate(item.primaryGenreName,14)}`:'';label=`${i}. ${icon} ${truncate(name,26)}${g}`;}
    buttons.push([{text:label,callback_data:cb}]);
    i++;
  }
  buttons.push(...filterRows);
  const navParts=await Promise.all([
    hasPrev?encodeSearchCb(query,0,entity):null,
    hasPrev?encodeSearchCb(query,Math.max(0,offset-limit),entity):null,
    hasNext?encodeSearchCb(query,offset+limit,entity):null
  ]);
  const navRow=[];
  if(hasPrev){navRow.push({text:'⏮',callback_data:navParts[0]});navRow.push({text:'⬅️ Prev',callback_data:navParts[1]});}
  if(hasNext)navRow.push({text:'Next ➡️',callback_data:navParts[2]});
  if(navRow.length>0)buttons.push(navRow);
  buttons.push([{text:'🏠 Main Menu',callback_data:'cmd_start'}]);
  await navigatePage(chatId,editMessageId,text,null,buttons,{loadingText:'🔍 <i>Searching…</i>'});
}

async function handleViewArtist(chatId,artistId,editMessageId=null,userId=null){
  const[lookupA,topResp,lookupB]=await Promise.all([
    apiRequestCached('/lookup',{id:artistId,entity:'album'}),
    apiRequestCached('/artist/tracks',{id:artistId,limit:3,offset:0}).catch(()=>({results:[]})),
    apiRequestCached('/lookup',{id:artistId,entity:'musicArtist'}).catch(()=>({results:[]}))
  ]);
  let artist=null;const albums=[];
  for(const r of(lookupA.results||[])){const w=r.wrapperType||'';if(w==='artist'&&!artist)artist=r;else if(w==='collection')albums.push(r);}
  if(!artist)artist=(lookupB.results||[]).find(r=>(r.wrapperType||'')==='artist')||null;
  if(!artist){await navigatePage(chatId,editMessageId,"❌ Artist not found.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const topTracks=topResp.results||[];
  const name=artist.artistName||'Unknown';const genre=artist.primaryGenreName||'';const country=artist.country||'';
  const artistArtworks=(artist.attachments&&artist.attachments.artworkUrls)||[];
  const artistNonItunes=artistArtworks.filter(a=>(a.source||'')!=='itunes');
  let artworkUrl=pickBestArtwork(artistNonItunes);
  if(!artworkUrl){for(const t of topTracks){const best=pickBestArtwork((t.attachments&&t.attachments.artworkUrls)||[]);if(best){artworkUrl=best;break;}}}
  if(!artworkUrl){for(const album of albums){const best=pickBestArtwork([{url:album.artworkUrl100||'',size:'100x100',source:'itunes'}]);if(best){artworkUrl=best;break;}}}
  if(!artworkUrl)artworkUrl=pickBestArtwork(artistArtworks);
  let text=`👤 <b>${esc(name)}</b>\n\n`;
  if(genre)text+=`🎸 ${esc(genre)}\n`;
  if(country)text+=`🌍 ${esc(country)}\n`;
  if(albums.length>0)text+=`💿 ${albums.length} albums\n`;
  if(topTracks.length>0){text+=`\n<b>✨ Top tracks</b>\n`;for(const t of topTracks)text+=`• ${esc(truncate(t.trackName||'Unknown',50))}\n`;}
  const buttons=[];
  for(const t of topTracks)buttons.push([{text:`🎵 ${truncate(t.trackName||'Unknown',38)}`,callback_data:`t_${t.trackId}`}]);
  buttons.push([{text:topTracks.length>0?'➕ More tracks':'🎵 Tracks',callback_data:`at_${artistId}_0`},{text:'💿 Albums',callback_data:`aa_${artistId}_0`}]);
  buttons.push([{text:'🎲 Shuffle play',callback_data:`shf_${artistId}`},{text:'🕷 Crawl',callback_data:`ca_${artistId}`}]);
  buttons.push([{text:'🌐 Web',url:webArtistLink(artistId)},{text:'🚀 Open in Bot',url:botDeepLink('artist',artistId)}]);
  buttons.push([{text:'📤 Share',url:shareUrl(webArtistLink(artistId),`${name} on MusicMan`)},copyLinkButton('📋 Copy link',webArtistLink(artistId))]);
  buttons.push([{text:'🏠 Main Menu',callback_data:'cmd_start'}]);
  await navigatePage(chatId,editMessageId,text,artworkUrl,buttons,{loadingText:'👤 <i>Loading artist…</i>'});
}
async function handleArtistShuffle(chatId,artistId,userId){
  const r=await apiRequestCached('/artist/tracks',{id:artistId,limit:20,offset:0});
  const list=r.results||[];
  if(list.length===0){await sendNotice(chatId,'❌ No tracks to shuffle.');return;}
  const pick=list[Math.floor(Math.random()*list.length)];
  await sendNotice(chatId,`🎲 Playing a random track: <b>${esc(pick.trackName||'Unknown')}</b>`);
  await handleViewTrack(chatId,String(pick.trackId),null,userId);
}

async function handleCrawlArtist(chatId, artistId, userId){
  const artistIdStr=String(artistId);
  const pageLimit=50;
  const [nameRes, firstTracks, albumsLookup] = await Promise.all([
    apiRequestCached('/lookup',{id:artistIdStr,entity:'musicArtist'}).catch(()=>({results:[]})),
    apiRequestCached('/artist/tracks',{id:artistIdStr,limit:pageLimit,offset:0}).catch(()=>({results:[]})),
    apiRequestCached('/lookup',{id:artistIdStr,entity:'album'}).catch(()=>({results:[]}))
  ]);
  let artistName=artistIdStr;
  for(const x of (nameRes.results||[])){
    if((x.wrapperType||'')==='artist'&&x.artistName){artistName=x.artistName;break;}
  }
  const allTrackIds=new Set();
  const firstList=firstTracks.results||[];
  for(const t of firstList){if(t&&t.trackId!=null)allTrackIds.add(String(t.trackId));}
  if(firstList.length>=pageLimit){
    let offset=pageLimit,guard=0;
    while(guard++<40){
      let r;
      try{r=await apiRequestCached('/artist/tracks',{id:artistIdStr,limit:pageLimit,offset});}
      catch{r=null;}
      const list=(r&&r.results)||[];
      if(list.length===0)break;
      for(const t of list){if(t&&t.trackId!=null)allTrackIds.add(String(t.trackId));}
      if(list.length<pageLimit)break;
      offset+=pageLimit;
    }
  }
  const albumIds=[];
  for(const item of (albumsLookup.results||[])){
    if((item.wrapperType||'')==='collection'&&item.collectionId!=null){
      const aid=String(item.collectionId);
      if(!albumIds.includes(aid))albumIds.push(aid);
    }
  }
  if(albumIds.length===0){
    try{
      const lk2=await apiRequestCached('/lookup',{id:artistIdStr,entity:'song'});
      for(const item of (lk2.results||[])){
        if((item.wrapperType||'')==='collection'&&item.collectionId!=null){
          const aid=String(item.collectionId);
          if(!albumIds.includes(aid))albumIds.push(aid);
        }
        if((item.wrapperType||'')==='track'&&item.trackId!=null)allTrackIds.add(String(item.trackId));
      }
    }catch{}
  }
  await mapLimit(albumIds,6,async(albId)=>{
    let aoff=0,aguard=0;
    while(aguard++<20){
      let r;
      try{r=await apiRequestCached('/lookup',{id:albId,entity:'song',limit:pageLimit,offset:aoff});}
      catch{r=null;}
      const items=(r&&r.results)||[];
      if(items.length===0)break;
      let added=0;
      for(const it of items){
        if((it.wrapperType||'')==='track'&&it.trackId!=null){allTrackIds.add(String(it.trackId));added++;}
      }
      if(items.length<pageLimit||added===0)break;
      aoff+=pageLimit;
    }
  });
  const trackIds=Array.from(allTrackIds);
  let queuedCount=0,failed=false;
  if(trackIds.length>0){
    const batchSize=50;
    for(let i=0;i<trackIds.length;i+=batchSize){
      const batch=trackIds.slice(i,i+batchSize);
      const r=await apiRequest('/download/add',{trackId:batch.join(','),skipExisting:true,skipCompleted:true},'POST');
      if(!r||!r.success){failed=true;break;}
      queuedCount+=batch.length;
    }
  }
  let doneText;
  if(trackIds.length===0){doneText=`⚠️ <b>No tracks found</b>\n\n👤 ${esc(artistName)}`;}
  else if(failed){doneText=`⚠️ <b>Request partially registered</b>\n\n👤 ${esc(artistName)}\n\n📥 ${queuedCount} of ${trackIds.length} tracks were registered before an error occurred.`;}
  else{doneText=`✅ <b>Request registered</b>\n\n👤 <b>${esc(artistName)}</b>\n\n📥 <b>${queuedCount}</b> tracks added to the download queue.\n\n<i>The files will be saved to the database shortly.</i>`;}
  await tgRequest('sendMessage',{chat_id:chatId,text:doneText+FOOTER,parse_mode:'HTML',reply_markup:JSON.stringify(buildKeyboard([[{text:'👤 Open artist',callback_data:`a_${artistIdStr}`}]]))});
}

async function handleArtistTracks(chatId,artistId,offset=0,editMessageId=null,userId=null){
  const settingsP=userId?getUserSettings(userId):Promise.resolve(DEFAULT_SETTINGS);
  const limit=TRACKS_PER_PAGE;
  const[settings,response]=await Promise.all([settingsP,apiRequestCached('/artist/tracks',{id:artistId,limit,offset})]);
  if(!response.results||response.results.length===0){
    await navigatePage(chatId,editMessageId,"❌ No tracks found for this artist.",null,[[{text:'🔙 Artist',callback_data:`a_${artistId}`}],[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);
    return;
  }
  const tracks=response.results;
  const artistName=tracks[0].artistName||'';
  const total=parseInt(response.total??tracks.length,10);
  const hasMore=!!response.hasMore;
  const page=Math.floor(offset/limit)+1;
  let text=`🎵 <b>Tracks${artistName?' by '+esc(artistName):''}</b>\n📄 Page <b>${page}</b> · ${offset+1}–${offset+tracks.length} of ${total}\n\n`;
  const buttons=[];
  let i=offset+1;
  for(const t of tracks){
    const name=t.trackName||'Unknown';
    const dur=settings.showDurations?fmtDuration(parseInt(t.trackTimeMillis||0,10)):'';
    buttons.push([{text:`${i}. ${truncate(name,34)}${dur?' · '+dur:''}`,callback_data:`t_${t.trackId}`}]);
    i++;
  }
  const navRow=[];
  if(offset>0)navRow.push({text:'⏮',callback_data:`at_${artistId}_0`});
  if(offset>0)navRow.push({text:'⬅️',callback_data:`at_${artistId}_${Math.max(0,offset-limit)}`});
  if(hasMore)navRow.push({text:'➡️',callback_data:`at_${artistId}_${offset+limit}`});
  if(navRow.length>0)buttons.push(navRow);
  buttons.push([{text:'🔙 Artist',callback_data:`a_${artistId}`},{text:'🏠 Menu',callback_data:'cmd_start'}]);
  await navigatePage(chatId,editMessageId,text,null,buttons,{loadingText:'🎵 <i>Loading tracks…</i>'});
}
async function handleArtistAlbums(chatId,artistId,offset=0,editMessageId=null){
  const response=await apiRequestCached('/lookup',{id:artistId,entity:'album'});
  let artistName='';const albums=[];
  for(const r of(response.results||[])){
    const w=r.wrapperType||'';
    if(w==='artist')artistName=r.artistName||'';
    else if(w==='collection')albums.push(r);
  }
  if(albums.length===0){
    await navigatePage(chatId,editMessageId,"❌ No albums found for this artist.",null,[[{text:'🔙 Artist',callback_data:`a_${artistId}`}],[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);
    return;
  }
  const limit=TRACKS_PER_PAGE;
  const slice=albums.slice(offset,offset+limit);
  const total=albums.length;
  const hasMore=(offset+limit)<total;
  const page=Math.floor(offset/limit)+1;
  let text=`💿 <b>Albums${artistName?' by '+esc(artistName):''}</b>\n📄 Page <b>${page}</b> · ${offset+1}–${offset+slice.length} of ${total}\n\n`;
  const buttons=[];
  let i=offset+1;
  for(const album of slice){
    const yr=yearOf(album);
    let label=`${i}. ${truncate(album.collectionName||'Unknown',28)}`;
    if(yr)label+=` (${yr})`;
    buttons.push([{text:label,callback_data:`l_${album.collectionId}`}]);
    i++;
  }
  const navRow=[];
  if(offset>0)navRow.push({text:'⏮',callback_data:`aa_${artistId}_0`});
  if(offset>0)navRow.push({text:'⬅️',callback_data:`aa_${artistId}_${Math.max(0,offset-limit)}`});
  if(hasMore)navRow.push({text:'➡️',callback_data:`aa_${artistId}_${offset+limit}`});
  if(navRow.length>0)buttons.push(navRow);
  buttons.push([{text:'🔙 Artist',callback_data:`a_${artistId}`},{text:'🏠 Menu',callback_data:'cmd_start'}]);
  await navigatePage(chatId,editMessageId,text,null,buttons,{loadingText:'💿 <i>Loading albums…</i>'});
}

async function handleViewAlbum(chatId,collectionId,offset=0,editMessageId=null,userId=null){
  const settingsP=userId?getUserSettings(userId):Promise.resolve(DEFAULT_SETTINGS);
  const[settings,songRes,albumRes]=await Promise.all([
    settingsP,
    apiRequestCached('/lookup',{id:collectionId,entity:'song'}).catch(()=>({results:[]})),
    apiRequestCached('/lookup',{id:collectionId,entity:'album'}).catch(()=>({results:[]}))
  ]);
  let album=null;const tracks=[];
  for(const r of(songRes.results||[])){const w=r.wrapperType||'';if(w==='collection'&&!album)album=r;else if(w==='track')tracks.push(r);}
  if(!album){for(const r of(albumRes.results||[])){if((r.wrapperType||'')==='collection'){album=r;break;}}}
  if(!album){await navigatePage(chatId,editMessageId,"❌ Album not found.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const name=album.collectionName||'Unknown';
  const artist=album.artistName||'';
  const genre=album.primaryGenreName||'';
  const date=String(album.releaseDate||'').slice(0,10);
  const count=parseInt(album.trackCount??tracks.length,10);
  const artistId=album.artistId||'';
  const yr=yearOf(album);
  let artworkUrl=null;
  for(const t of tracks){const best=pickBestArtwork((t.attachments&&t.attachments.artworkUrls)||[]);if(best){artworkUrl=best;break;}}
  if(!artworkUrl)artworkUrl=pickBestArtwork([{url:album.artworkUrl100||album.artworkUrl60||'',size:'100x100',source:'itunes'}]);
  let text=`💿 <b>${esc(name)}</b>\n\n`;
  if(artist)text+=`👤 ${esc(artist)}\n`;
  if(genre)text+=`🎸 ${esc(genre)}\n`;
  if(yr)text+=`📅 ${yr}\n`;
  if(date&&!yr)text+=`📅 ${esc(date)}\n`;
  if(count)text+=`🎵 ${count} tracks\n`;
  const limit=TRACKS_PER_PAGE;
  const total=tracks.length;
  const slice=tracks.slice(offset,offset+limit);
  const hasMore=(offset+limit)<total;
  const page=Math.floor(offset/limit)+1;
  if(total>0){
    text+=`\n📋 <b>Track list</b> — Page ${page} · ${offset+1}–${offset+slice.length} of ${total}\n`;
    for(let i=0;i<slice.length;i++){
      const t=slice[i];
      const dur=settings.showDurations?fmtDuration(parseInt(t.trackTimeMillis||0,10)):'';
      text+=`${offset+i+1}. ${esc(truncate(t.trackName||'Unknown',60))}${dur?' <code>'+dur+'</code>':''}\n`;
    }
  }else text+=`\n❌ No tracks available.\n`;
  const buttons=[];
  let i=offset+1;
  for(const t of slice){
    const dur=settings.showDurations?fmtDuration(parseInt(t.trackTimeMillis||0,10)):'';
    buttons.push([{text:`${i}. ${truncate(t.trackName||'Unknown',30)}${dur?' · '+dur:''}`,callback_data:`t_${t.trackId}`}]);
    i++;
  }
  const navRow=[];
  if(offset>0)navRow.push({text:'⏮',callback_data:`l_${collectionId}_0`});
  if(offset>0)navRow.push({text:'⬅️',callback_data:`l_${collectionId}_${Math.max(0,offset-limit)}`});
  if(hasMore)navRow.push({text:'➡️',callback_data:`l_${collectionId}_${offset+limit}`});
  if(navRow.length>0)buttons.push(navRow);
  if(total>0)buttons.push([{text:`⬇️ Download Album (${total})`,callback_data:`dq_${collectionId}`},{text:'🎲 Shuffle',callback_data:`shfl_${collectionId}`}]);
  buttons.push([{text:'🌐 Web',url:webAlbumLink(collectionId)},{text:'🚀 Open in Bot',url:botDeepLink('album',collectionId)}]);
  const bottom=[];
  if(settings.showCopyButton)bottom.push(copyLinkButton('📋 Copy link',webAlbumLink(collectionId)));
  bottom.push({text:'📤 Share',url:shareUrl(webAlbumLink(collectionId),`${name}${artist?' — '+artist:''}`)});
  buttons.push(bottom);
  const navRow2=[];
  if(artistId)navRow2.push({text:'👤 Artist',callback_data:`a_${artistId}`});
  navRow2.push({text:'🏠 Menu',callback_data:'cmd_start'});
  buttons.push(navRow2);
  await navigatePage(chatId,editMessageId,text,artworkUrl,buttons,{loadingText:'💿 <i>Loading album…</i>'});
}
async function handleAlbumShuffle(chatId,collectionId,userId){
  const r=await apiRequestCached('/lookup',{id:collectionId,entity:'song'});
  const tracks=(r.results||[]).filter(x=>(x.wrapperType||'')==='track');
  if(tracks.length===0){await sendNotice(chatId,'❌ No tracks to shuffle.');return;}
  const pick=tracks[Math.floor(Math.random()*tracks.length)];
  await sendNotice(chatId,`🎲 Playing a random track: <b>${esc(pick.trackName||'Unknown')}</b>`);
  await handleViewTrack(chatId,String(pick.trackId),null,userId);
}
async function handleViewTrack(chatId,trackId,editMessageId=null,userId=null){
  const tasks=[fetchTrack(trackId)];
  if(userId&&kvAvailable()){tasks.push(getUserSettings(userId),isFavorite(userId,trackId).catch(()=>false));}
  else{tasks.push(Promise.resolve(DEFAULT_SETTINGS),Promise.resolve(false));}
  const[track,settings,isFav]=await Promise.all(tasks);
  if(!track){await navigatePage(chatId,editMessageId,"❌ Track not found.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const name=track.trackName||'Unknown';
  const artist=track.artistName||'';
  const album=track.collectionName||'';
  const genre=track.primaryGenreName||'';
  const artistId=track.artistId||'';
  const collectionId=track.collectionId||'';
  const time=parseInt(track.trackTimeMillis||0,10);
  const yr=yearOf(track);
  const attachments=track.attachments||{};
  const artworkUrls=attachments.artworkUrls||[];
  const audioUrls=telegramAudioMirrors(attachments.audioUrls||[]);
  const baleMirror=(attachments.audioUrls||[]).find(isBaleAudioMirror);
  const previewUrl=attachments.previewUrl||track.previewUrl||null;
  const lyrics=attachments.lyrics||null;
  const artworkUrl=pickBestArtwork(artworkUrls);
  let text=`🎵 <b>${esc(name)}</b>\n`;
  if(artist)text+=`👤 ${esc(artist)}\n`;
  if(album&&album!==name)text+=`💿 ${esc(album)}\n`;
  if(genre)text+=`🎸 ${esc(genre)}\n`;
  if(yr)text+=`📅 ${yr}\n`;
  if(time)text+=`⏱ ${fmtDuration(time)}\n`;
  if(baleMirror){
    const baleFileUrl=baleMirror.baleFileUrl||baleMirror.url||'';
    if(baleFileUrl)text+=`🔗 Bale file: <code>${esc(baleFileUrl)}</code>\n`;
  }
  const hasAudio=audioUrls.length>0;
  const hasLyrics=lyrics&&extractLyricsText(lyrics)!==null;
  const hasCover=!!artworkUrl;
  const hasPreview=!!previewUrl;
  if(userId)ctx_waitUntil(pushHistory(userId,{id:String(trackId),name,artist}).catch(()=>{}));
  const buttons=[];
  const actionRow=[];
  if(hasAudio)actionRow.push({text:'🎧 Play',callback_data:`ta_${trackId}`});
  if(hasPreview&&!hasAudio)actionRow.push({text:'▶️ Preview',callback_data:`pv_${trackId}`});
  if(hasLyrics)actionRow.push({text:'📜 Lyrics',callback_data:`tl_${trackId}`});
  if(hasCover)actionRow.push({text:'🖼 Cover',callback_data:`tc_${trackId}`});
  if(actionRow.length>0)buttons.push(actionRow);
  const row2=[];
  if(userId&&kvAvailable())row2.push({text:isFav?'⭐ Saved':'⭐ Save',callback_data:`fav_${trackId}`});
  row2.push({text:'📤 Share',url:shareUrl(webTrackLink(trackId),`${name}${artist?' — '+artist:''}`)});
  if(settings.showCopyButton)row2.push(copyLinkButton('📋 Copy link',webTrackLink(trackId)));
  if(row2.length>0)buttons.push(row2);
  if(!hasAudio)buttons.push([{text:'⬇️ Download (queue)',callback_data:`tq_${trackId}`}]);
  buttons.push([{text:'🌐 Web',url:webTrackLink(trackId)},{text:'🚀 Open in Bot',url:botDeepLink('track',trackId)}]);
  const navRow=[];
  if(artistId)navRow.push({text:'👤 Artist',callback_data:`a_${artistId}`});
  if(collectionId)navRow.push({text:'💿 Album',callback_data:`l_${collectionId}`});
  navRow.push({text:'🏠 Menu',callback_data:'cmd_start'});
  buttons.push(navRow);
  await navigatePage(chatId,editMessageId,text,artworkUrl,buttons,{loadingText:'🎵 <i>Loading track…</i>'});
}
async function handleTrackAudio(chatId,trackId,userId=null){
  const[track,settings]=await Promise.all([fetchTrack(trackId),userId?getUserSettings(userId):Promise.resolve(DEFAULT_SETTINGS)]);
  if(!track){await sendNotice(chatId,"❌ Track not found.");return;}
  const audioUrls=telegramAudioMirrors((track.attachments&&track.attachments.audioUrls)||[]);
  if(audioUrls.length===0){await sendNotice(chatId,"❌ No audio source available for this track.");return;}
  const artworkUrl=pickBestArtwork((track.attachments&&track.attachments.artworkUrls)||[]);
  const best=pickBestAudio(audioUrls,settings.preferredQuality);
  const sourceMessageId=best.telegramMessageId||extractMessageIdFromUrl(best.telegramFileUrl||best.url);
  const telegramSource=sourceMessageId||best.telegramFileUrl||best.url;
  const r=await sendAudioToUser(chatId,telegramSource,{thumbnail:artworkUrl,title:track.trackName||'Unknown',performer:track.artistName||'',mode:settings.audioMode,trackId:String(trackId),quality:best.quality||null,sourceMessageId});
  if(!r.success)await sendNotice(chatId,`❌ Send failed: ${esc(r.error||'Unknown')}`);
}
async function handleTrackPreview(chatId,trackId){
  const track=await fetchTrack(trackId);
  if(!track){await sendNotice(chatId,"❌ Track not found.");return;}
  const previewUrl=(track.attachments&&track.attachments.previewUrl)||track.previewUrl;
  if(!previewUrl){await sendNotice(chatId,"❌ Preview unavailable.");return;}
  chatAction(chatId,'upload_audio');
  const r=await tgRequest('sendAudio',{chat_id:chatId,audio:previewUrl,title:(track.trackName||'Preview')+' (30s preview)',performer:track.artistName||''});
  if(!r||!r.ok)await sendNotice(chatId,"❌ Preview could not be sent.");
}
async function handleTrackLyrics(chatId,trackId){
  chatAction(chatId,'typing');
  const[response,track]=await Promise.all([apiRequestCached('/lyrics/get',{id:trackId},5*60*1000),fetchTrack(trackId)]);
  if(!response||!response.success){await sendNotice(chatId,"❌ Lyrics not found for this track.");return;}
  let lyricsText=extractLyricsText({type:response.type||'unsynced',text:response.lyrics})||'';
  if(lyricsText===''){await sendNotice(chatId,"❌ Lyrics empty.");return;}
  const trackName=(track&&track.trackName)||'';
  const artistName=(track&&track.artistName)||'';
  let header="📜 <b>Lyrics</b>";
  if(trackName){header+="\n🎵 "+esc(trackName);if(artistName)header+=" — "+esc(artistName);}
  header+="\n\n";
  const maxBody=4000-header.length-FOOTER.length;
  if(Array.from(lyricsText).length>maxBody)lyricsText=Array.from(lyricsText).slice(0,maxBody).join('')+"\n… (truncated)";
  await tgRequest('sendMessage',{chat_id:chatId,text:header+esc(lyricsText)+FOOTER,parse_mode:'HTML',disable_web_page_preview:true,reply_markup:JSON.stringify(buildKeyboard(track?[[{text:'🎵 Open track',callback_data:`t_${trackId}`}],[{text:'🌐 Web',url:webTrackLink(trackId)}]]:[]))});
}
async function handleTrackCover(chatId,trackId){
  const track=await fetchTrack(trackId);
  if(!track){await sendNotice(chatId,"❌ Track not found.");return;}
  const artworkUrl=pickBestArtwork((track.attachments&&track.attachments.artworkUrls)||[]);
  if(!artworkUrl){await sendNotice(chatId,"❌ No cover available.");return;}
  let caption=`🖼 <b>${esc(track.trackName||'')}</b>`;
  if(track.artistName)caption+=`\n👤 ${esc(track.artistName)}`;
  caption+=FOOTER;
  const kb=JSON.stringify(buildKeyboard([[{text:'🎵 Open track',callback_data:`t_${trackId}`}]]));
  chatAction(chatId,'upload_photo');
  let r=await tgRequest('sendDocument',{chat_id:chatId,document:artworkUrl,caption,parse_mode:'HTML',reply_markup:kb});
  if(r&&r.ok)return;
  r=await tgRequest('sendPhoto',{chat_id:chatId,photo:artworkUrl,caption,parse_mode:'HTML',reply_markup:kb});
  if(r&&r.ok)return;
  await sendNotice(chatId,`❌ Failed to send cover.\nURL: <code>${esc(artworkUrl)}</code>`);
}
async function handleTrackFavorite(chatId,trackId,userId,messageId=null){
  if(!kvAvailable()){await sendNotice(chatId,"⚠️ Favourites require KV storage.");return;}
  let meta={name:'',artist:''};
  try{const t=await fetchTrack(trackId);if(t)meta={name:t.trackName||'',artist:t.artistName||''};}catch{}
  await toggleFavorite(userId,trackId,meta);
  await handleViewTrack(chatId,trackId,messageId,userId);
}
async function handleTrackQueue(chatId,trackId,userId){
  const trackIdStr=String(trackId);
  const t=await fetchTrack(trackIdStr);
  if(t){
    const audioUrls=telegramAudioMirrors((t.attachments&&t.attachments.audioUrls)||[]);
    if(audioUrls.length>0){
      await tgRequest('sendMessage',{chat_id:chatId,text:"ℹ️ This track already has an audio file — no need to queue a download."+FOOTER,reply_markup:JSON.stringify(buildKeyboard([[{text:'🎧 Play it',callback_data:`ta_${trackIdStr}`}]]))});
      return;
    }
  }
  const map=await checkTracksInQueue([trackIdStr],userId);
  const info=map.get(trackIdStr);
  if(info&&info.inQueueForUser){
    const statusLabel=info.status==='pending'?'waiting in queue':info.status==='downloading'?'currently downloading':info.status==='paused'?'paused':info.status;
    await tgRequest('sendMessage',{chat_id:chatId,text:`⏳ You already added this track to the download queue (${esc(statusLabel)}). Please wait for it to finish.`+FOOTER,reply_markup:JSON.stringify(buildKeyboard([]))});
    return;
  }
  const trackName=t?(t.trackName||'Unknown'):trackIdStr;
  const artistName=t?(t.artistName||''):'';
  const initText=`⏳ <b>Preparing…</b>\n\n🎵 ${esc(trackName)}\n${artistName?`👤 ${esc(artistName)}\n`:''}\n🔄 Stage: Waiting in queue`+FOOTER;
  chatAction(chatId,'typing');
  const msgRes=await tgRequest('sendMessage',{chat_id:chatId,text:initText,parse_mode:'HTML',reply_markup:JSON.stringify(buildKeyboard([]))});
  if(!msgRes||!msgRes.ok)return;
  const statusMessageId=msgRes.result.message_id;
  const r=await apiRequest('/download/add',{trackId:trackIdStr,telegramUserId:String(userId),telegramMessageId:String(statusMessageId),telegramChatId:String(chatId)},'POST');
  if(!r||!r.success){
    await tgRequest('editMessageText',{chat_id:chatId,message_id:statusMessageId,text:`❌ Failed to add to queue: ${esc((r&&r.error)||'Unknown')}`+FOOTER,parse_mode:'HTML',reply_markup:JSON.stringify(buildKeyboard([]))});
  }else if(kvAvailable()){
    ctx_waitUntil(appendUserQueue(userId,[{id:trackIdStr,name:trackName,artist:artistName,ts:Date.now()}]));
  }
}

async function handleAlbumQueue(chatId,collectionId,userId){
  const collectionIdStr=String(collectionId);
  const lookup=await apiRequestCached('/lookup',{id:collectionIdStr,entity:'song'});
  let album=null;const tracks=[];
  for(const r of(lookup.results||[])){const w=r.wrapperType||'';if(w==='collection'&&!album)album=r;else if(w==='track')tracks.push(r);}
  if(!album||tracks.length===0){
    await tgRequest('sendMessage',{chat_id:chatId,text:`❌ Album not found or has no tracks.`+FOOTER,reply_markup:JSON.stringify(buildKeyboard([]))});
    return;
  }
  const albumName=album.collectionName||'Unknown Album';
  const artistName=album.artistName||'';
  const total=tracks.length;
  const immediateTracks=[];
  let queuedTrackIds=[];
  const queuedEntries=[];
  for(const t of tracks){
    const tid=String(t.trackId||'');if(!tid)continue;
    const audioUrls=telegramAudioMirrors((t.attachments&&t.attachments.audioUrls)||[]);
    if(audioUrls.length>0)immediateTracks.push(t);
    else{queuedTrackIds.push(tid);queuedEntries.push({id:tid,name:t.trackName||'',artist:t.artistName||'',ts:Date.now()});}
  }
  let alreadyQueuedByUser=[];
  if(queuedTrackIds.length>0){
    const map=await checkTracksInQueue(queuedTrackIds,userId);
    const filtered=[];
    for(const tid of queuedTrackIds){const info=map.get(String(tid));if(info&&info.inQueueForUser)alreadyQueuedByUser.push(tid);else filtered.push(tid);}
    queuedTrackIds=filtered;
  }
  let initText=`⬇️ <b>Album download</b>\n\n💿 ${esc(albumName)}\n${artistName?`👤 ${esc(artistName)}\n`:''}🎵 ${total} tracks\n`;
  if(immediateTracks.length>0)initText+=`⚡ Already available: ${immediateTracks.length}\n`;
  if(queuedTrackIds.length>0)initText+=`📥 To download: ${queuedTrackIds.length}\n`;
  if(alreadyQueuedByUser.length>0)initText+=`⏳ You already queued (skipped): ${alreadyQueuedByUser.length}\n`;
  initText+=`\n⏳ Starting…`+FOOTER;
  chatAction(chatId,'upload_audio');
  const msgRes=await tgRequest('sendMessage',{chat_id:chatId,text:initText,parse_mode:'HTML',reply_markup:JSON.stringify(buildKeyboard([[{text:'💿 Open album',callback_data:`l_${collectionIdStr}`}]]))});
  if(!msgRes||!msgRes.ok)return;
  const statusMessageId=msgRes.result.message_id;
  if(immediateTracks.length>0){
    const settings=await getUserSettings(userId);
    await mapLimit(immediateTracks,3,async(t)=>{await deliverAlbumTrack(userId,chatId,t,settings);});
  }
  if(queuedTrackIds.length>0){
    const r=await apiRequest('/download/add',{trackId:queuedTrackIds.join(','),skipExisting:true,skipCompleted:true,telegramUserId:String(userId),telegramMessageId:String(statusMessageId),telegramChatId:String(chatId)},'POST');
    if(!r||!r.success){
      await tgRequest('editMessageText',{chat_id:chatId,message_id:statusMessageId,text:`❌ Failed to queue album: ${esc((r&&r.error)||'Unknown')}`+FOOTER,parse_mode:'HTML',reply_markup:JSON.stringify(buildKeyboard([]))});
    }else if(kvAvailable()){
      const validEntries=queuedEntries.filter(e=>queuedTrackIds.includes(e.id));
      ctx_waitUntil(appendUserQueue(userId,validEntries));
    }
  }else{
    const sentNow=immediateTracks.length;
    const skipped=alreadyQueuedByUser.length;
    let sum=`✅ <b>Album ready</b>\n\n💿 ${esc(albumName)}\n`;
    if(sentNow>0)sum+=`📤 Sent: ${sentNow}\n`;
    if(skipped>0)sum+=`⏳ Already in your queue: ${skipped}\n`;
    sum+=`🎵 Total: ${total}`+FOOTER;
    await tgRequest('editMessageText',{chat_id:chatId,message_id:statusMessageId,text:sum,parse_mode:'HTML',reply_markup:JSON.stringify(buildKeyboard([[{text:'💿 Open album',callback_data:`l_${collectionIdStr}`}]]))});
  }
}
async function deliverAlbumTrack(userId,chatId,track,settings){
  const audioUrls=telegramAudioMirrors((track.attachments&&track.attachments.audioUrls)||[]);
  if(audioUrls.length===0)return false;
  if(!settings)settings=await getUserSettings(userId);
  const artworkUrl=pickBestArtwork((track.attachments&&track.attachments.artworkUrls)||[]);
  const best=pickBestAudio(audioUrls,settings.preferredQuality);
  if(!best||!best.url)return false;
  const sourceMessageId=best.telegramMessageId||extractMessageIdFromUrl(best.telegramFileUrl||best.url);
  const telegramSource=sourceMessageId||best.telegramFileUrl||best.url;
  const sent=await sendAudioToUser(chatId,telegramSource,{thumbnail:artworkUrl,title:track.trackName||'Unknown',performer:track.artistName||'',mode:settings.audioMode,trackId:String(track.trackId),quality:best.quality||null,sourceMessageId});
  return!!(sent&&sent.success);
}

async function handleFavorites(chatId,userId,offset=0,editMessageId=null){
  if(!kvAvailable()){await navigatePage(chatId,editMessageId,"⚠️ Favourites require KV storage.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const list=(await getFavorites(userId)).slice().reverse();
  if(list.length===0){await navigatePage(chatId,editMessageId,"☆ <b>No favourites yet</b>\n\nOpen any track and tap ⭐ Save.",null,[[{text:'🔥 Popular',callback_data:'p_0'}],[{text:'🏠 Main Menu',callback_data:'cmd_start'}]],{loadingText:'⭐ <i>Loading favourites…</i>'});return;}
  const limit=FAVS_PER_PAGE;const slice=list.slice(offset,offset+limit);const total=list.length;const hasMore=(offset+limit)<total;const page=Math.floor(offset/limit)+1;
  let text=`⭐ <b>Your Favourites</b> (${total})\n📍 Page ${page} · ${offset+1}–${offset+slice.length}\n\n`;
  const buttons=[];
  for(let i=0;i<slice.length;i++){const f=slice[i];text+=`${offset+i+1}. <b>${esc(truncate(f.name||'Unknown',50))}</b>${f.artist?` — <i>${esc(truncate(f.artist,40))}</i>`:''}\n`;buttons.push([{text:`🎵 ${truncate(f.name||f.id,26)}${f.artist?' · '+truncate(f.artist,18):''}`,callback_data:`t_${f.id}`}]);}
  const navRow=[];
  if(offset>0)navRow.push({text:'⏮',callback_data:`fav_list_0`});
  if(offset>0)navRow.push({text:'⬅️',callback_data:`fav_list_${Math.max(0,offset-limit)}`});
  if(hasMore)navRow.push({text:'➡️',callback_data:`fav_list_${offset+limit}`});
  if(navRow.length>0)buttons.push(navRow);
  buttons.push([{text:'🏠 Main Menu',callback_data:'cmd_start'}]);
  await navigatePage(chatId,editMessageId,text,null,buttons,{loadingText:'⭐ <i>Loading favourites…</i>'});
}
async function handleHistory(chatId,userId,offset=0,editMessageId=null){
  if(!kvAvailable()){await navigatePage(chatId,editMessageId,"⚠️ Recent requires KV storage.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const list=(await getHistory(userId)).slice().reverse();
  if(list.length===0){await navigatePage(chatId,editMessageId,"🕘 <b>No recent tracks yet</b>\n\nSearch for something to get started.",null,[[{text:'🔥 Popular',callback_data:'p_0'}],[{text:'🏠 Main Menu',callback_data:'cmd_start'}]],{loadingText:'🕘 <i>Loading history…</i>'});return;}
  const limit=FAVS_PER_PAGE;const slice=list.slice(offset,offset+limit);const total=list.length;const hasMore=(offset+limit)<total;const page=Math.floor(offset/limit)+1;
  let text=`🕘 <b>Recently Viewed</b> (${total})\n📍 Page ${page} · ${offset+1}–${offset+slice.length}\n\n`;
  const buttons=[];
  for(let i=0;i<slice.length;i++){const f=slice[i];text+=`${offset+i+1}. <b>${esc(truncate(f.name||'Unknown',50))}</b>${f.artist?` — <i>${esc(truncate(f.artist,40))}</i>`:''}\n`;buttons.push([{text:`🎵 ${truncate(f.name||f.id,26)}${f.artist?' · '+truncate(f.artist,18):''}`,callback_data:`t_${f.id}`}]);}
  const navRow=[];
  if(offset>0)navRow.push({text:'⏮',callback_data:`hist_0`});
  if(offset>0)navRow.push({text:'⬅️',callback_data:`hist_${Math.max(0,offset-limit)}`});
  if(hasMore)navRow.push({text:'➡️',callback_data:`hist_${offset+limit}`});
  if(navRow.length>0)buttons.push(navRow);
  buttons.push([{text:'🏠 Main Menu',callback_data:'cmd_start'}]);
  await navigatePage(chatId,editMessageId,text,null,buttons,{loadingText:'🕘 <i>Loading history…</i>'});
}
async function handleRandom(chatId,editMessageId=null){
  const seeds=['a','e','i','o','u','s','m','l','love','music','sun','night'];
  const r=await apiRequestCached('/search',{term:seeds[Math.floor(Math.random()*seeds.length)],limit:20,offset:0},SEARCH_CACHE_TTL);
  const list=r.results||[];
  if(list.length===0){await navigatePage(chatId,editMessageId,"🎲 Nothing found, try again.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const track=list[Math.floor(Math.random()*list.length)];
  const id=track.trackId??track.collectionId??track.artistId;
  const w=track.wrapperType||'track';
  if(w==='artist')return handleViewArtist(chatId,id,editMessageId);
  if(w==='collection')return handleViewAlbum(chatId,id,0,editMessageId);
  return handleViewTrack(chatId,id,editMessageId);
}
async function handlePopular(chatId,offset=0,editMessageId=null,userId=null){
  const[settings,r]=await Promise.all([userId?getUserSettings(userId):Promise.resolve(DEFAULT_SETTINGS),apiRequestCached('/popular',{limit:SEARCH_PER_PAGE,offset},SEARCH_CACHE_TTL)]);
  if(!r.results||r.results.length===0){await navigatePage(chatId,editMessageId,"❌ No popular tracks.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const limit=SEARCH_PER_PAGE;const page=Math.floor(offset/limit)+1;const hasNext=r.results.length>=limit;
  let text=`🔥 <b>Popular Tracks</b>\n📄 Page ${page}\n\n`;
  const buttons=[];let i=offset+1;
  for(const item of r.results){
    const name=item.trackName||'Unknown';const artist=item.artistName||'';const views=item.views||0;
    const dur=settings.showDurations?fmtDuration(parseInt(item.trackTimeMillis||0,10)):'';
    text+=`${i}. 🎵 <b>${esc(name)}</b>${artist?` — <i>${esc(artist)}</i>`:''}${dur?` <code>${dur}</code>`:''}${views?` (👁 ${views})`:''}\n`;
    buttons.push([{text:`${i}. 🎵 ${truncate(name,26)}${artist?' · '+truncate(artist,16):''}${dur?' · '+dur:''}`,callback_data:`t_${item.trackId}`}]);
    i++;
  }
  const navRow=[];
  if(offset>0)navRow.push({text:'⏮',callback_data:`p_0`});
  if(offset>0)navRow.push({text:'⬅️',callback_data:`p_${Math.max(0,offset-limit)}`});
  if(hasNext)navRow.push({text:'➡️',callback_data:`p_${offset+limit}`});
  if(navRow.length>0)buttons.push(navRow);
  buttons.push([{text:'🏠 Main Menu',callback_data:'cmd_start'}]);
  await navigatePage(chatId,editMessageId,text,null,buttons,{loadingText:'🔥 <i>Loading popular…</i>'});
}
async function handleFresh(chatId,offset=0,editMessageId=null,userId=null){
  const[settings,r]=await Promise.all([userId?getUserSettings(userId):Promise.resolve(DEFAULT_SETTINGS),apiRequestCached('/fresh',{limit:SEARCH_PER_PAGE,offset},SEARCH_CACHE_TTL)]);
  if(!r.results||r.results.length===0){await navigatePage(chatId,editMessageId,"❌ No fresh tracks.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const limit=SEARCH_PER_PAGE;const page=Math.floor(offset/limit)+1;const hasNext=r.results.length>=limit;
  let text=`✨ <b>Fresh Tracks</b>\n📄 Page ${page}\n\n`;
  const buttons=[];let i=offset+1;
  for(const item of r.results){
    const name=item.trackName||'Unknown';const artist=item.artistName||'';
    const dur=settings.showDurations?fmtDuration(parseInt(item.trackTimeMillis||0,10)):'';
    text+=`${i}. 🎵 <b>${esc(name)}</b>${artist?` — <i>${esc(artist)}</i>`:''}${dur?` <code>${dur}</code>`:''}\n`;
    buttons.push([{text:`${i}. 🎵 ${truncate(name,26)}${artist?' · '+truncate(artist,16):''}${dur?' · '+dur:''}`,callback_data:`t_${item.trackId}`}]);
    i++;
  }
  const navRow=[];
  if(offset>0)navRow.push({text:'⏮',callback_data:`f_0`});
  if(offset>0)navRow.push({text:'⬅️',callback_data:`f_${Math.max(0,offset-limit)}`});
  if(hasNext)navRow.push({text:'➡️',callback_data:`f_${offset+limit}`});
  if(navRow.length>0)buttons.push(navRow);
  buttons.push([{text:'🏠 Main Menu',callback_data:'cmd_start'}]);
  await navigatePage(chatId,editMessageId,text,null,buttons,{loadingText:'✨ <i>Loading fresh…</i>'});
}
async function handleStats(chatId,editMessageId=null){
  const r=await apiRequestCached('/stats',{},60*1000);
  let text="📊 <b>Database Statistics</b>\n\n";
  if(!r){text+="❌ Could not fetch stats.";}
  else{
    const tc=r.track_count??0,ac=r.artist_count??0,alc=r.album_count??0,lc=r.lyrics_count??0;
    text+=`🎵 Tracks: <b>${tc.toLocaleString?.()||tc}</b>\n👤 Artists: <b>${ac.toLocaleString?.()||ac}</b>\n💿 Albums: <b>${alc.toLocaleString?.()||alc}</b>\n📜 Lyrics: <b>${lc.toLocaleString?.()||lc}</b>\n`;
    if(r.file_count!=null)text+=`📦 Audio files: <b>${r.file_count}</b>\n`;
    if(r.updated_at)text+=`\n🕒 Updated: <code>${esc(String(r.updated_at))}</code>`;
  }
  await navigatePage(chatId,editMessageId,text,null,[[{text:'🔄 Refresh',callback_data:'cmd_stats'},{text:'🏠 Menu',callback_data:'cmd_start'}]],{loadingText:'📊 <i>Loading stats…</i>'});
}
async function handleSettings(chatId,userId,editMessageId=null){
  if(!kvAvailable()){await navigatePage(chatId,editMessageId,"⚙️ <b>Settings</b>\n\nKV storage is not bound.",null,[[{text:'🏠 Main Menu',callback_data:'cmd_start'}]]);return;}
  const s=await getUserSettings(userId);
  let text="⚙️ <b>Settings</b>\n\n";
  text+=`🎧 Audio mode: <b>${s.audioMode==='document'?'Document':'Audio'}</b>\n`;
  text+=`📦 Compact list: <b>${s.compact?'On':'Off'}</b>\n`;
  text+=`⏱ Show durations: <b>${s.showDurations?'On':'Off'}</b>\n`;
  text+=`🎚 Quality preference: <b>${s.preferredQuality.toUpperCase()}</b>\n`;
  text+=`📋 Copy-link button: <b>${s.showCopyButton?'On':'Off'}</b>\n`;
  text+=`🎵 Inline audio: <b>${s.inlineAudios?'On':'Off'}</b>\n`;
  text+=`📜 Lyrics in inline captions: <b>${s.showLyricsInCaption?'On':'Off'}</b>\n`;
  text+=`🔔 Download notifications: <b>${s.notifyOnDownload?'On':'Off'}</b>\n`;
  const buttons=[
    [{text:(s.audioMode==='audio'?'✅ ':'')+'🎧 Audio',callback_data:'set_mode_audio'},{text:(s.audioMode==='document'?'✅ ':'')+'📄 Doc',callback_data:'set_mode_document'}],
    [{text:(s.compact?'✅ ':'')+'📦 Compact',callback_data:'set_compact_toggle'},{text:(s.showDurations?'✅ ':'')+'⏱ Durations',callback_data:'set_dur_toggle'}],
    [{text:(s.preferredQuality==='auto'?'✅ ':'')+'🎚 Auto',callback_data:'set_quality_auto'},{text:(s.preferredQuality==='high'?'✅ ':'')+'High',callback_data:'set_quality_high'},{text:(s.preferredQuality==='low'?'✅ ':'')+'Low',callback_data:'set_quality_low'}],
    [{text:(s.showCopyButton?'✅ ':'')+'📋 Copy',callback_data:'set_copy_toggle'},{text:(s.inlineAudios?'✅ ':'')+'🎵 Inline',callback_data:'set_inline_toggle'}],
    [{text:(s.showLyricsInCaption?'✅ ':'')+'📜 Lyrics in captions',callback_data:'set_lyrics_toggle'}],
    [{text:(s.notifyOnDownload?'✅ ':'')+'🔔 Notify',callback_data:'set_notify_toggle'},{text:'♻️ Reset',callback_data:'set_reset'}],
    [{text:'🏠 Main Menu',callback_data:'cmd_start'}]
  ];
  await navigatePage(chatId,editMessageId,text,null,buttons,{loadingText:'⚙️ <i>Loading settings…</i>'});
}
async function handleSetMode(chatId,userId,mode,mid=null){if(kvAvailable()){await updateUserSettings(userId,{audioMode:mode==='document'?'document':'audio'});await handleSettings(chatId,userId,mid);}}
async function handleSetCompact(chatId,userId,mid=null){if(kvAvailable()){const s=await getUserSettings(userId);await updateUserSettings(userId,{compact:!s.compact});await handleSettings(chatId,userId,mid);}}
async function handleSetDurations(chatId,userId,mid=null){if(kvAvailable()){const s=await getUserSettings(userId);await updateUserSettings(userId,{showDurations:!s.showDurations});await handleSettings(chatId,userId,mid);}}
async function handleSetQuality(chatId,userId,q,mid=null){if(kvAvailable()){await updateUserSettings(userId,{preferredQuality:['auto','high','low'].includes(q)?q:'auto'});await handleSettings(chatId,userId,mid);}}
async function handleSetCopy(chatId,userId,mid=null){if(kvAvailable()){const s=await getUserSettings(userId);await updateUserSettings(userId,{showCopyButton:!s.showCopyButton});await handleSettings(chatId,userId,mid);}}
async function handleSetInline(chatId,userId,mid=null){if(kvAvailable()){const s=await getUserSettings(userId);await updateUserSettings(userId,{inlineAudios:!s.inlineAudios});await handleSettings(chatId,userId,mid);}}
async function handleSetNotify(chatId,userId,mid=null){if(kvAvailable()){const s=await getUserSettings(userId);await updateUserSettings(userId,{notifyOnDownload:!s.notifyOnDownload});await handleSettings(chatId,userId,mid);}}
async function handleSetLyricsCaption(chatId,userId,mid=null){if(kvAvailable()){const s=await getUserSettings(userId);await updateUserSettings(userId,{showLyricsInCaption:!s.showLyricsInCaption});await handleSettings(chatId,userId,mid);}}
async function handleSetReset(chatId,userId,mid=null){if(kvAvailable()){await setUserSettings(userId,{...DEFAULT_SETTINGS});await handleSettings(chatId,userId,mid);}}

async function dispatchCallback(data,chatId,messageId,userId){
  switch(data){
    case'close':{const r=await tgRequest('deleteMessage',{chat_id:chatId,message_id:messageId});if(!r||!r.ok)await tgRequest('editMessageReplyMarkup',{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}});return;}
    case'cmd_start':await handleStart(chatId,messageId,userId);return;
    case'cmd_stats':await handleStats(chatId,messageId);return;
    case'cmd_help':await handleHelp(chatId,messageId);return;
    case'rnd':await handleRandom(chatId,messageId);return;
    case'settings':await handleSettings(chatId,userId,messageId);return;
    case'set_mode_audio':await handleSetMode(chatId,userId,'audio',messageId);return;
    case'set_mode_document':await handleSetMode(chatId,userId,'document',messageId);return;
    case'set_compact_toggle':await handleSetCompact(chatId,userId,messageId);return;
    case'set_dur_toggle':await handleSetDurations(chatId,userId,messageId);return;
    case'set_quality_auto':await handleSetQuality(chatId,userId,'auto',messageId);return;
    case'set_quality_high':await handleSetQuality(chatId,userId,'high',messageId);return;
    case'set_quality_low':await handleSetQuality(chatId,userId,'low',messageId);return;
    case'set_copy_toggle':await handleSetCopy(chatId,userId,messageId);return;
    case'set_inline_toggle':await handleSetInline(chatId,userId,messageId);return;
    case'set_notify_toggle':await handleSetNotify(chatId,userId,messageId);return;
    case'set_lyrics_toggle':await handleSetLyricsCaption(chatId,userId,messageId);return;
    case'set_reset':await handleSetReset(chatId,userId,messageId);return;
    case'chk_join':{MEMBERSHIP_CACHE.delete(userId);const check=await checkMembership(userId);if(check.ok){await sendNotice(chatId,'✅ Membership verified!');await handleStart(chatId,messageId,userId);}else await sendJoinRequired(chatId,messageId,check.missing);return;}
  }
  if(data.startsWith('s_')||data.startsWith('s~')){const decoded=await decodeSearchCb(data);if(!decoded){await sendNotice(chatId,'⚠️ This search has expired — please search again.');return;}await handleSearch(chatId,decoded.query,decoded.offset,messageId,userId,decoded.entity);return;}
  if(data.startsWith('at_')){const rest=data.slice(3),idx=rest.lastIndexOf('_');await handleArtistTracks(chatId,idx===-1?rest:rest.slice(0,idx),idx===-1?0:parseInt(rest.slice(idx+1),10),messageId,userId);return;}
  if(data.startsWith('aa_')){const rest=data.slice(3),idx=rest.lastIndexOf('_');await handleArtistAlbums(chatId,idx===-1?rest:rest.slice(0,idx),idx===-1?0:parseInt(rest.slice(idx+1),10),messageId);return;}
  if(data.startsWith('ca_')){await handleCrawlArtist(chatId,data.slice(3),userId);return;}
  if(data.startsWith('shf_')){await handleArtistShuffle(chatId,data.slice(4),userId);return;}
  if(data.startsWith('shfl_')){await handleAlbumShuffle(chatId,data.slice(5),userId);return;}
  if(data.startsWith('fav_list_')){await handleFavorites(chatId,userId,parseInt(data.slice(9),10)||0,messageId);return;}
  if(data.startsWith('fav_')){await handleTrackFavorite(chatId,data.slice(4),userId,messageId);return;}
  if(data.startsWith('hist_')){await handleHistory(chatId,userId,parseInt(data.slice(5),10)||0,messageId);return;}
  if(data.startsWith('pv_')){await handleTrackPreview(chatId,data.slice(3));return;}
  if(data.startsWith('ta_')){await handleTrackAudio(chatId,data.slice(3),userId);return;}
  if(data.startsWith('tl_')){await handleTrackLyrics(chatId,data.slice(3));return;}
  if(data.startsWith('tc_')){await handleTrackCover(chatId,data.slice(3));return;}
  if(data.startsWith('tq_')){await handleTrackQueue(chatId,data.slice(3),userId);return;}
  if(data.startsWith('dq_')){await handleAlbumQueue(chatId,data.slice(3),userId);return;}
  if(data.startsWith('p_')){await handlePopular(chatId,parseInt(data.slice(2),10)||0,messageId,userId);return;}
  if(data.startsWith('f_')){await handleFresh(chatId,parseInt(data.slice(2),10)||0,messageId,userId);return;}
  if(data.startsWith('a_')){await handleViewArtist(chatId,data.slice(2),messageId,userId);return;}
  if(data.startsWith('l_')){const rest=data.slice(2),idx=rest.lastIndexOf('_');let id=rest,off=0;if(idx!==-1){const tail=rest.slice(idx+1);if(/^\d+$/.test(tail)){id=rest.slice(0,idx);off=parseInt(tail,10);}}await handleViewAlbum(chatId,id,off,messageId,userId);return;}
  if(data.startsWith('t_')){await handleViewTrack(chatId,data.slice(2),messageId,userId);return;}
  await sendNotice(chatId,"⚠️ Unknown action. Use /start to begin.");
}

async function handleDeepLink(chatId,payload,userId){
  if(payload.startsWith('track_')){const id=payload.slice(6);if(id){await handleViewTrack(chatId,id,null,userId);return true;}}
  if(payload.startsWith('album_')){const id=payload.slice(6);if(id){await handleViewAlbum(chatId,id,0,null,userId);return true;}}
  if(payload.startsWith('artist_')){const id=payload.slice(7);if(id){await handleViewArtist(chatId,id,null,userId);return true;}}
  if(payload==='inline_help'){await handleHelp(chatId);return true;}
  return false;
}

function buildInlineCaption(item,w,webUrl,trackId){
  const name=item.trackName??item.collectionName??item.artistName??'Unknown';
  const artist=item.artistName||'';
  const album=item.collectionName||'';
  const genre=item.primaryGenreName||'';
  const country=item.country||'';
  const yr=yearOf(item);
  const dur=fmtDuration(item.trackTimeMillis||0);
  let qualityLabel='';
  if(w==='track'){
    const audioUrls=telegramAudioMirrors((item.attachments&&item.attachments.audioUrls)||[]);
    if(audioUrls.length>0){let bestQ=0;for(const a of audioUrls){const q=parseInt(a.quality||0,10);if(q>bestQ)bestQ=q;}if(bestQ>0)qualityLabel=`${bestQ} kbps`;}
  }
  let caption='';
  if(w==='track'){
    caption+=`🎵 <b>Title:</b> ${esc(name)}\n`;
    if(artist)caption+=`🎤 <b>Artist:</b> ${esc(artist)}\n`;
    if(album&&album!==name)caption+=`💿 <b>Album:</b> ${esc(album)}\n`;
    if(yr)caption+=`📅 <b>Release:</b> ${yr}\n`;
    if(genre)caption+=`🎸 <b>Genre:</b> ${esc(genre)}\n`;
    if(dur)caption+=`⏱️ <b>Duration:</b> ${dur}\n`;
    if(qualityLabel)caption+=`📀 <b>Quality:</b> ${qualityLabel}\n`;
  } else if(w==='collection'){
    caption+=`💿 <b>Album:</b> ${esc(name)}\n`;
    if(artist)caption+=`🎤 <b>Artist:</b> ${esc(artist)}\n`;
    const trackCount=parseInt(item.trackCount||0,10);
    if(yr)caption+=`📅 <b>Release:</b> ${yr}\n`;
    if(genre)caption+=`🎸 <b>Genre:</b> ${esc(genre)}\n`;
    if(trackCount)caption+=`🎵 <b>Tracks:</b> ${trackCount}\n`;
  } else {
    caption+=`👤 <b>Artist:</b> ${esc(name)}\n`;
    if(genre)caption+=`🎸 <b>Genre:</b> ${esc(genre)}\n`;
    if(country)caption+=`🌍 <b>Country:</b> ${esc(country)}\n`;
  }
  caption=caption.replace(/\n+$/,'')+'\n\n'+FOOTER;
  return caption;
}
function buildInlineTitle(item,w){
  const name=item.trackName??item.collectionName??item.artistName??'Unknown';
  const artist=item.artistName||'';
  if(w==='track')return artist&&artist!==name?`🎵 ${truncate(name,45)} — ${truncate(artist,25)}`:`🎵 ${truncate(name,60)}`;
  if(w==='collection')return artist?`💿 ${truncate(name,45)} — ${truncate(artist,25)}`:`💿 ${truncate(name,60)}`;
  return`👤 ${truncate(name,60)}`;
}
function buildInlineDescription(item,w){
  const name=item.trackName??item.collectionName??item.artistName??'Unknown';
  const artist=item.artistName||'';
  const album=item.collectionName||'';
  const genre=item.primaryGenreName||'';
  const country=item.country||'';
  const yr=yearOf(item);
  const trackCount=parseInt(item.trackCount||0,10);
  const dur=fmtDuration(item.trackTimeMillis||0);
  if(w==='track'){
    const parts=[];
    if(artist&&artist!==name)parts.push(`👤 ${truncate(artist,26)}`);
    if(album&&album!==name)parts.push(`💿 ${truncate(album,26)}`);
    if(dur)parts.push(`⏱ ${dur}`);
    if(yr)parts.push(`📅 ${yr}`);
    if(genre)parts.push(`🎸 ${truncate(genre,16)}`);
    const hasLyrics=!!extractLyricsText(item.attachments&&item.attachments.lyrics);
    parts.push(hasLyrics?'📜 Lyrics':'📜 IV');
    return parts.join('  ·  ')||'Track';
  }
  if(w==='collection'){
    const parts=[];
    if(artist)parts.push(`👤 ${truncate(artist,26)}`);
    if(yr)parts.push(`📅 ${yr}`);
    if(trackCount)parts.push(`🎵 ${trackCount} tracks`);
    if(genre)parts.push(`🎸 ${truncate(genre,16)}`);
    return parts.join('  ·  ')||'Album';
  }
  const parts=[];
  if(genre)parts.push(`🎸 ${truncate(genre,22)}`);
  if(country)parts.push(`🌍 ${country}`);
  return parts.join('  ·  ')||'Artist';
}

// ═══════════════════════════════════════════════════════════════════════════
//  buildInlineResult — uses fileIdMap (from ensureValidFileIds)
// ═══════════════════════════════════════════════════════════════════════════
async function buildInlineResult(item,source,settings,fileIdMap){
  const w=item.wrapperType||'track';
  const id=item.trackId??item.collectionId??item.artistId;
  if(!id)return null;

  const allowAudio = !settings || settings.inlineAudios !== false;

  const artworkUrls=(item.attachments&&item.attachments.artworkUrls)||[];
  let art=artworkUrls.length>0?pickBestArtwork(artworkUrls):null;
  if(!art&&item.artworkUrl100)art=upgradeArtwork(item.artworkUrl100);
  else if(!art&&item.artworkUrl60)art=upgradeArtwork(item.artworkUrl60);
  const thumb=item.artworkUrl60||item.artworkUrl100||art;
  const name=item.trackName??item.collectionName??item.artistName??'Unknown';
  const artist=item.artistName||'';
  const durSec=Math.round(parseInt(item.trackTimeMillis||0,10)/1000)||undefined;

  let webUrl,deepLink,resultId;
  if(w==='artist'){webUrl=webArtistLink(id);deepLink=botDeepLink('artist',id);resultId=`art_${id}`;}
  else if(w==='collection'){webUrl=webAlbumLink(id);deepLink=botDeepLink('album',id);resultId=`alb_${id}`;}
  else{webUrl=webTrackLink(id);deepLink=botDeepLink('track',id);resultId=`trk_${id}`;}

  const showLyrics=!!(settings&&settings.showLyricsInCaption);
  const caption=buildInlineCaption(item,w,webUrl,showLyrics?String(id):null);
  const title=buildInlineTitle(item,w);
  const description=buildInlineDescription(item,w);
  const keyboard={inline_keyboard:[[{text:'🚀 Open in Bot',url:deepLink},{text:'🌐 Web',url:webUrl}]]};

  if(w==='track' && allowAudio){
    const trackId=String(id);
    const inlineFileId = (fileIdMap && fileIdMap.get(trackId)) || await getCachedAudioFileId(trackId);

    if(inlineFileId){
      blogInline('audio result',{trackId,fileIdLen: inlineFileId.length});
      return{
        type:'audio',id:`aud_${id}`,audio_file_id:inlineFileId,
        title:name,performer:artist||undefined,audio_duration:durSec,
        caption,parse_mode:'HTML',reply_markup:keyboard
      };
    }
    // No valid file_id → fall through to article
    blogInline('no file_id → article',{trackId});
  }

  return{
    type:'article',id:resultId,title,description,
    thumbnail_url:thumb||undefined,
    input_message_content:{message_text:caption,parse_mode:'HTML',disable_web_page_preview:false},
    reply_markup:keyboard
  };
}

async function handleInlineQuery(inlineQuery){
  let q=(inlineQuery.query||'').trim();
  const userId=inlineQuery.from?.id;
  blogInline('query received',{id:inlineQuery.id,from:userId,qHead:String(q).slice(0,60),qLen:q.length});

  if(userId){
    const membership=await checkMembership(userId);
    if(!membership.ok){
      const miss=(membership.missing&&membership.missing.length)?membership.missing:REQUIRED_CHANNELS;
      const listText=miss.map(c=>`👉 ${c.url}`).join('\n');
      const joinRow=miss.map(c=>({text:c.label||'📢 Join',url:c.url}));
      joinRow.push({text:'🤖 Open Bot',url:`https://t.me/${BOT_USERNAME}`});
      await tgRequest('answerInlineQuery',{
        inline_query_id:inlineQuery.id,
        results:[{type:'article',id:'join_required',title:'🔒 Channel membership required',description:`Please join our channel${miss.length>1?'s':''} to use this bot`,input_message_content:{message_text:`🔒 To use this bot, please join below:\n\n${listText}`},reply_markup:{inline_keyboard:[joinRow]}}],
        cache_time:5,is_personal:true
      });
      return;
    }
  }

  const settings = userId ? await getUserSettings(userId) : {...DEFAULT_SETTINGS};
  blogInline('settings',{userId,inlineAudios:settings.inlineAudios,quality:settings.preferredQuality});

  if(Array.from(q).length>MAX_SEARCH_LENGTH)q=Array.from(q).slice(0,MAX_SEARCH_LENGTH).join('');

  const mmLink=parseMusicmanLink(q);
  if(mmLink){
    blogInline('deep-link path',{type:mmLink.type,id:mmLink.id});
    const lookup=await apiRequestCached('/lookup',{id:mmLink.id,entity:mmLink.type==='artist'?'musicArtist':(mmLink.type==='album'?'album':'song')});
    const items=lookup.results||[];
    const fileIdMap = await ensureValidFileIds(items);
    const results=[];const seen=new Set();
    for(const item of items){
      const res=await buildInlineResult(item,'link',settings,fileIdMap);
      if(!res||seen.has(res.id))continue;
      seen.add(res.id);results.push(res);
      if(results.length>=5)break;
    }
    if(results.length===0){
      await tgRequest('answerInlineQuery',{inline_query_id:inlineQuery.id,results:[],cache_time:10,switch_pm_text:'❌ Link not found — open bot',switch_pm_parameter:'inline_help'});
      return;
    }
    await tgRequest('answerInlineQuery',{inline_query_id:inlineQuery.id,results,cache_time:30,is_personal:true});
    return;
  }

  if(Array.from(q).length<2){
    await tgRequest('answerInlineQuery',{inline_query_id:inlineQuery.id,results:[],cache_time:5,switch_pm_text:'🔍 Type a song, artist, or album name…',switch_pm_parameter:'inline_help'});
    return;
  }

  const response = await apiRequestCached('/search',{term:q,limit:30,offset:0},SEARCH_CACHE_TTL);
  const items=(response&&response.results)||[];
  blogInline('api search raw',{query:truncate(q,40),rawCount:items.length});

  // ═══════════════════════════════════════════════════════════════
  //  🔥 STEP 1: Resolve valid file_ids (KV or forward)
  // ═══════════════════════════════════════════════════════════════
  const fileIdMap = await ensureValidFileIds(items);

  // ═══════════════════════════════════════════════════════════════
  //  STEP 2: Build results using resolved file_ids
  // ═══════════════════════════════════════════════════════════════
  const results=[];const seen=new Set();
  let audioCount=0,articleCount=0;
  for(const item of items){
    try{
      const res=await buildInlineResult(item,'backend',settings,fileIdMap);
      if(!res||seen.has(res.id))continue;
      seen.add(res.id);results.push(res);
      if(res.type==='audio')audioCount++;else articleCount++;
    }catch(e){
      blog('ERROR','buildInlineResult item failed',{itemId:item&&(item.trackId??item.collectionId??item.artistId),err:e.message});
    }
  }

  blogInline('results summary',{query:truncate(q,40),total:results.length,audio:audioCount,article:articleCount});

  if(results.length===0){
    await tgRequest('answerInlineQuery',{inline_query_id:inlineQuery.id,results:[],cache_time:5,switch_pm_text:`❌ No results for "${q}" — open bot`,switch_pm_parameter:'inline_help'});
    return;
  }

  const r=await tgRequest('answerInlineQuery',{
    inline_query_id:inlineQuery.id,
    results:results.slice(0,50),
    cache_time:10,
    is_personal:true
  });
  if(r&&r.ok) blog('INFO','inline sent',{total:results.length,audio:audioCount,article:articleCount});
  else blog('WARN','inline failed',{desc:r&&r.description,audioCount});
}

async function handleBroadcast(chatId,userId,args){
  if(!ADMIN_ID||Number(userId)!==Number(ADMIN_ID)){await sendNotice(chatId,'🚫 Not authorized.');return;}
  if(!args||!args.trim()){await sendNotice(chatId,'Usage: /broadcast <text>');return;}
  if(!kvAvailable()){await sendNotice(chatId,'⚠️ KV required.');return;}
  const users=await kvGet('broadcast:users',[]);
  await sendNotice(chatId,`📣 Sending to ${Array.isArray(users)?users.length:0} users…`);
  ctx_waitUntil((async()=>{
    const blocked=[];let sent=0;
    const batchSize=25;
    for(let i=0;i<users.length;i+=batchSize){
      const batch=users.slice(i,i+batchSize);
      const res=await Promise.all(batch.map(async uid=>{
        try{
          const r=await tgRequest('sendMessage',{chat_id:uid,text:args,parse_mode:'HTML',disable_web_page_preview:true});
          if(r&&r.ok)return{ok:true};
          const d=String(r?.description||'').toLowerCase();
          if(d.includes('blocked')||d.includes('deactivated')||d.includes('chat not found')||d.includes('user not found'))blocked.push(String(uid));
          return{ok:false};
        }catch{return{ok:false};}
      }));
      sent+=res.filter(r=>r.ok).length;
      if(i+batchSize<users.length)await new Promise(r=>setTimeout(r,1000));
    }
    if(blocked.length>0){const remaining=users.filter(u=>!blocked.includes(String(u)));try{await kvPut('broadcast:users',remaining);}catch{}}
    await sendNotice(chatId,`✅ Broadcast done — sent: ${sent}, removed: ${blocked.length}`);
  })());
}

async function handleChannelPost(post){
  try{
    if(!isBroadcastSource(post.chat))return;
    await ensureChannelFooter(post);
    const text=post.text||post.caption||'';
    const tag=BROADCAST_HASHTAG.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const hasTag=new RegExp(tag+'(\\b|\\s|$)','i').test(text);
    if(hasTag){blog('INFO',`Broadcast trigger: msg=${post.message_id}`);await broadcastToAll(post.chat.id,post.message_id);}
  }catch(e){blog('ERROR',`handleChannelPost: ${e.message}`);}
}

async function processUpdate(update){
  const anyUserId=update.message?.from?.id||update.edited_message?.from?.id||update.callback_query?.from?.id||update.inline_query?.from?.id||update.chosen_inline_result?.from?.id;
  if(anyUserId)ctx_waitUntil(trackUser(anyUserId));

  if(update.channel_post){ctx_waitUntil(handleChannelPost(update.channel_post));return;}

  if(update.inline_query){try{await handleInlineQuery(update.inline_query);}catch(e){blog('FATAL','inline: '+e.message,{stack:e.stack});}return;}
  if(update.chosen_inline_result){blog('INFO','chosen',{id:update.chosen_inline_result.result_id});return;}
  if(update.message&&update.message.text){
    const chatId=update.message.chat.id;const userId=update.message.from.id;const text=update.message.text;
    if(rateLimited(userId)){await sendNotice(chatId,'⏳ Slow down a bit — too many actions.');return;}
    const membership=await checkMembership(userId);
    if(!membership.ok){await sendJoinRequired(chatId,null,membership.missing);return;}
    const mmLink=parseMusicmanLink(text);
    if(mmLink){
      if(mmLink.type==='track')await handleViewTrack(chatId,mmLink.id,null,userId);
      else if(mmLink.type==='album')await handleViewAlbum(chatId,mmLink.id,0,null,userId);
      else if(mmLink.type==='artist')await handleViewArtist(chatId,mmLink.id,null,userId);
      return;
    }
    if(text.startsWith('/')){
      const spaceIdx=text.indexOf(' ');
      const cmd=(spaceIdx===-1?text:text.slice(0,spaceIdx)).replace(/@\w+$/,'');
      const args=spaceIdx===-1?'':text.slice(spaceIdx+1);
      switch(cmd){
        case'/start':{if(args&&await handleDeepLink(chatId,args.trim(),userId))break;await handleStart(chatId,null,userId);break;}
        case'/help':await handleHelp(chatId);break;
        case'/popular':case'/top':await handlePopular(chatId,0,null,userId);break;
        case'/fresh':await handleFresh(chatId,0,null,userId);break;
        case'/random':await handleRandom(chatId);break;
        case'/stats':await handleStats(chatId);break;
        case'/favorites':case'/favourites':await handleFavorites(chatId,userId);break;
        case'/recent':await handleHistory(chatId,userId);break;
        case'/settings':await handleSettings(chatId,userId);break;
        case'/broadcast':await handleBroadcast(chatId,userId,args);break;
        case'/search':if(args==='')await sendNotice(chatId,'Usage: /search &lt;query&gt;');else await handleSearch(chatId,args,0,null,userId,'all');break;
        default:await sendNotice(chatId,'❓ Unknown command. Try /help');
      }
    }else{
      await handleSearch(chatId,text,0,null,userId,'all');
    }
    return;
  }
  if(update.callback_query){
    const cb=update.callback_query;const chatId=cb.message.chat.id;const messageId=cb.message.message_id;const userId=cb.from.id;const data=cb.data||'';
    tgRequest('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
    if(rateLimited(userId))return;
    if(data!=='chk_join'&&data!=='close'){
      const membership=await checkMembership(userId);
      if(!membership.ok){await sendJoinRequired(chatId,messageId,membership.missing);return;}
    }
    await dispatchCallback(data,chatId,messageId,userId);
  }
}

let __ctx=null;
function ctx_waitUntil(promise){if(__ctx&&__ctx.waitUntil)__ctx.waitUntil(promise);else promise.catch(e=>blog('ERROR','waitUntil: '+e.message));}

export default{
  async fetch(request,env,ctx){
    ENV=env||{};
    BOT_TOKEN=(env&&env.BOT_TOKEN)||DEFAULT_BOT_TOKEN;
    __ctx=ctx;

    if(request.method==='GET'){
      const u=new URL(request.url);
      const pathname=u.pathname;

      // ═══════════════════════════════════════════════════════════════
      //  🔥 DEBUG: /debug-forward?msg=10327 — test forward + get file_id
      // ═══════════════════════════════════════════════════════════════
      if(pathname==='/debug-forward'){
        const msgId=u.searchParams.get('msg')||'10327';
        const target=u.searchParams.get('to')||STORAGE_CHAT_ID||SOURCE_CHAT_ID;
        const r=await tgRequest('forwardMessage',{
          chat_id:target,from_chat_id:SOURCE_CHAT_ID,message_id:String(msgId)
        });
        let fileId=null,newMsgId=null;
        if(r&&r.ok&&r.result){
          fileId=r.result.audio?.file_id||r.result.document?.file_id||r.result.voice?.file_id||null;
          newMsgId=r.result.message_id||null;
          if(newMsgId){
            ctx_waitUntil(tgRequest('deleteMessage',{chat_id:target,message_id:newMsgId}).catch(()=>{}));
          }
        }
        return new Response(JSON.stringify({
          from:SOURCE_CHAT_ID,to:target,msgId,
          forwardResponse:{ok:r&&r.ok,error:r&&r.description||null},
          extractedFileId:fileId,
          fileIdLen:fileId?fileId.length:0,
          deletedMsgId:newMsgId
        },null,2),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
      }

      if(pathname==='/debug-inline'){
        const term=u.searchParams.get('q')||'yann tiersen';
        const raw=await apiRequest('/search',{term,limit:10,offset:0},'GET');
        const items=(raw&&raw.results)||[];
        const settings={...DEFAULT_SETTINGS};
        const fileIdMap = await ensureValidFileIds(items);
        const built=[];
        for(const item of items){
          try{
            const r=await buildInlineResult(item,'backend',settings,fileIdMap);
            if(!r)continue;
            built.push({
              type:r.type,id:r.id,title:r.title||null,
              hasAudioFileId:!!r.audio_file_id,
              audioFileIdLen:r.audio_file_id?r.audio_file_id.length:0,
              audioFileIdHead:r.audio_file_id?r.audio_file_id.slice(0,35):null
            });
          }catch(e){built.push({type:'error',error:e.message});}
        }
        return new Response(JSON.stringify({
          term, rawCount:items.length, builtCount:built.length,
          audioCount:built.filter(x=>x.type==='audio').length,
          articleCount:built.filter(x=>x.type==='article').length,
          fileIdMapSize:fileIdMap.size,
          built
        },null,2),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
      }

      if(pathname==='/debug-send'){
        const chatId=u.searchParams.get('chat_id');
        if(!chatId)return new Response(JSON.stringify({error:'add ?chat_id=YOUR_ID'}),{status:400,headers:{'content-type':'application/json'}});
        const term=u.searchParams.get('q')||'yann tiersen';
        const raw=await apiRequest('/search',{term,limit:10,offset:0},'GET');
        const items=(raw&&raw.results)||[];
        const fileIdMap = await ensureValidFileIds(items);
        let track=null;
        for(const it of items){
          if(it.wrapperType==='track' && fileIdMap.has(String(it.trackId))){track=it;break;}
        }
        if(!track)return new Response(JSON.stringify({error:'no track with file_id resolved'}),{status:404,headers:{'content-type':'application/json'}});
        const fileId=fileIdMap.get(String(track.trackId));
        const r=await tgRequest('sendAudio',{chat_id:chatId,audio:fileId,title:track.trackName||'Unknown',performer:track.artistName||''});
        return new Response(JSON.stringify({
          trackName:track.trackName,fileIdHead:fileId.slice(0,50),fileIdLen:fileId.length,
          telegramResponse:r
        },null,2),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
      }

      return new Response(JSON.stringify({
        ok:true,bot:BOT_USERNAME,version:'5.9',kv:kvAvailable(),
        debugEndpoints:['/debug-forward?msg=10327','/debug-inline?q=yann tiersen','/debug-send?chat_id=YOUR_TG_ID&q=yann tiersen'],
        sourceChat:SOURCE_CHAT_ID,storageChat:STORAGE_CHAT_ID,
        botTokenHead:BOT_TOKEN.slice(0,12)+'…',
        time:new Date().toISOString()
      },null,2),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
    }

    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    let update;try{update=await request.json();}catch{return new Response('OK',{status:200});}
    ctx.waitUntil((async()=>{try{await processUpdate(update);blog('INFO','═══ OK ═══');}catch(e){blog('FATAL','Exception: '+e.message,{stack:e.stack});}})());
    return new Response('OK',{status:200});
  }
};