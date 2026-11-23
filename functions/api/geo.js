// ⚠️ 這個檔案是 `node relay/build.mjs` 自動產生的，不要直接改。
// 要改請改 App 倉庫 relay/src/pages_geo.js 與 relay/lib/，再重新產生。

// 跑車人生 熱區地名查詢（Cloudflare Pages Functions）
// 網址：https://app.realway.com.tw/api/geo?k=25.04,121.51|25.05,121.52（一次最多 20 格；格子 key＝約 1 公里格子的中心點）
// 只讀 KV 快取、只登記「待查」，自己不連 OpenStreetMap（Pages Function 沒辦法保證全體合計每秒 1 次）。
// 真正去問 OSM 的只有排程 Worker（paoche-roads-worker 的 /geo，每 3 分鐘一輪、每筆隔 1.15 秒、自訂 User-Agent）。
// 回應：{ok:true, names:{key:地名}, none:[查過沒有名稱的 key], wait:[還在排隊的 key]}；遠端關閉時 {ok:true, off:true}。
// App 只送格子 key（不是實際上車位置），不送帳本、不送任何裝置編號。遠端關閉：KV 鍵 geo:off 設成 1。
// 需要的設定：KV 綁定 ROADS_KV（跟 /api/roads 同一個）。

// ===== 熱區地名查詢（relay/lib/geo.js）=====
// 手機只問自家 /api/geo（pages_geo.js），自己不連 OpenStreetMap。流程：
//   手機 ─格子 key（約 1 公里）→ /api/geo ─ 命中 KV 快取 → 回地名（全體使用者共用）
//                                          └ 沒命中 → 登記到「待查清單」（一個 KV 鍵，不是一格一鍵）
//   排程（paoche-roads-cron 每 3 分鐘叫 paoche-roads-worker 的 /geo）→ geoRound：每輪最多 25 筆，
//   每筆之間 ≥1.15 秒、自訂 User-Agent，向 OSM Nominatim 查，結果寫回快取。
//   全體對 OSM 的請求只有這一個地方，所以合計一定 ≤1 次／秒（OSM 官方使用政策）。
// 遠端關閉：KV 鍵 geo:off 設成 1 → /api/geo 回 {off:true}、排程也不查；改 KV 值立刻生效，不用重新部署。
// 不事先掃整個台灣（OSM 禁止系統性網格查詢）：只查「真的有司機開到熱區統計」的格子。
// 這個檔案不依賴 roads_core.js（build 不會把路況那一大包塞進 /api/geo）。

const GEO_OFF_KEY = 'geo:off';
const GEO_PEND_KEY = 'geo:pend:v1';       // { v:1, q:{ key:{ t:登記時間, a:失敗次數 } } }
const GEO_ASK_KEY = 'geo:ask:v1';         // /api/geo 寫：{ v:1, days:{ 日期:{ r:請求, h:命中, m:沒命中, n:查過但沒有名稱 } } }
const GEO_OSM_KEY = 'geo:osm:v1';         // 排程寫：{ v:1, runUntil, backoffUntil, last, days:{ 日期:{ q, ok, empty, fail, w } } }
const GEO_NAME_KEY = k => 'geo:n:' + k;   // { n:地名（空字串＝OSM 查過沒有名稱）, t:查詢時間 }
const GEO_UA = 'paoche-ledger/1.0 (+https://app.realway.com.tw/privacy.html)';
const GEO_MAX_ASK = 20;            // 手機一次最多問幾格
const GEO_PEND_MAX = 400;          // 待查清單上限（滿了新的先不收，手機之後會再問）
const GEO_ROUND_MAX = 25;          // 排程每輪最多查幾筆
const GEO_GAP_MS = 1150;           // 相鄰兩次對 OSM 的請求至少隔這麼久（官方上限 1 次／秒）
const GEO_DAY_CAP = 1500;          // 一天最多對 OSM 查幾筆（也限制 KV 寫入）
const GEO_TRY_MAX = 4;             // 同一格失敗幾次就先放棄（記成「查不到」一小時）
const GEO_NAME_TTL = 365 * 86400;  // 有名稱的快取保留一年（OSM 要求要快取，也讓名稱慢慢更新）
const GEO_EMPTY_TTL = 14 * 86400;  // 「查過沒有名稱」保留兩週
const GEO_GIVEUP_TTL = 3600;       // 連續失敗放棄的格子：一小時內不再排隊
const GEO_TIMEOUT_MS = 8000;
const GEO_LOCK_MS = 150000;        // 一輪最長 2.5 分鐘；防止兩輪重疊

const KEY_RE = /^(-?\d{1,3})\.(\d{2}),(-?\d{1,3})\.(\d{2})$/;
// 只收台灣本島＋離島大致範圍的格子（也擋掉亂填的）
function validGeoKey(k) {
  const m = KEY_RE.exec(String(k));
  if (!m) return false;
  const lat = +(m[1] + '.' + m[2]), lng = +(m[3] + '.' + m[4]);
  return lat >= 21.7 && lat <= 25.5 && lng >= 118.0 && lng <= 122.2;
}
function parseGeoKeys(s) {
  const out = [];
  String(s || '').split('|').forEach(k => { k = k.trim(); if (out.length < GEO_MAX_ASK && out.indexOf(k) < 0 && validGeoKey(k)) out.push(k); });
  return out;
}
function geoOff(v) { return !!v && String(v).trim() !== '' && !/^(0|false|off|no)$/i.test(String(v).trim()); }
const geoDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);   // 台灣日期

// 跟 App 原本的 placeLabel 同一套：OSM address → 「區 路名一帶」「區 里」
function geoLabel(a) {
  if (!a || typeof a !== 'object') return '';
  const s = x => (typeof x === 'string' ? x : '');
  const dist = s(a.suburb) || s(a.city_district) || s(a.district) || s(a.town) || s(a.city) || '';
  let t;
  if (a.village) t = (dist + ' ' + s(a.village) + (a.road ? ' · ' + s(a.road) : '')).trim();
  else if (a.road) t = (dist + ' ' + s(a.road) + '一帶').trim();
  else t = (dist + ' ' + (s(a.neighbourhood) || s(a.quarter) || '')).trim();
  return t.replace(/[\u0000-\u001f<>]/g, '').slice(0, 60);
}

function prune(days, keep) {
  const ks = Object.keys(days).sort();
  while (ks.length > keep) delete days[ks.shift()];
}

// ---------- /api/geo 用 ----------
// 回傳 { off:true } 或 { names:{key:name}, none:[key], wait:[key] }
async function geoAsk(kv, keys, now) {
  let off = null;
  try { off = await kv.get(GEO_OFF_KEY); } catch (e) {}
  if (geoOff(off)) return { off: true };
  const got = await Promise.all(keys.map(async k => { try { return await kv.get(GEO_NAME_KEY(k), 'json'); } catch (e) { return undefined; } }));
  const names = {}, none = [], miss = [];
  keys.forEach((k, i) => {
    const v = got[i];
    if (v && typeof v.n === 'string') { if (v.n) names[k] = v.n; else none.push(k); }
    else miss.push(k);
  });
  if (miss.length) {
    let pend = null;
    try { pend = await kv.get(GEO_PEND_KEY, 'json'); } catch (e) {}
    if (!pend || pend.v !== 1 || !pend.q) pend = { v: 1, q: {} };
    let added = 0;
    for (const k of miss) {
      if (pend.q[k]) continue;
      if (Object.keys(pend.q).length >= GEO_PEND_MAX) break;
      pend.q[k] = { t: now, a: 0 }; added++;
    }
    if (added) { try { await kv.put(GEO_PEND_KEY, JSON.stringify(pend)); } catch (e) {} }   // 只有真的有新格子才寫
  }
  return { names, none, wait: miss, hit: Object.keys(names).length + none.length, miss: miss.length, nn: none.length };
}

// 命中率計數：每台伺服器先記在記憶體，最多每分鐘寫一次 KV（數字是約略值：同時寫會漏幾筆，只給每週看趨勢）
const acc = { r: 0, h: 0, m: 0, n: 0 };
let lastFlush = 0;
function geoCount(r) { acc.r++; acc.h += r.hit || 0; acc.m += r.miss || 0; acc.n += r.nn || 0; }
async function geoFlush(kv, now) {
  if (!acc.r || now - lastFlush < 60000) return false;
  lastFlush = now;
  const add = { r: acc.r, h: acc.h, m: acc.m, n: acc.n };
  acc.r = acc.h = acc.m = acc.n = 0;
  try {
    let s = await kv.get(GEO_ASK_KEY, 'json');
    if (!s || s.v !== 1 || !s.days) s = { v: 1, days: {} };
    const d = geoDay(now), x = s.days[d] || (s.days[d] = { r: 0, h: 0, m: 0, n: 0 });
    x.r += add.r; x.h += add.h; x.m += add.m; x.n += add.n;
    prune(s.days, 14);
    await kv.put(GEO_ASK_KEY, JSON.stringify(s));
    return true;
  } catch (e) { return false; }
}

// ---------- 排程用：唯一會打 OSM 的地方 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function osmReverse(key, fetchFn) {
  const p = key.split(',');
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=zh-TW&lat=' + p[0] + '&lon=' + p[1];
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), GEO_TIMEOUT_MS) : null;
  try {
    const r = await fetchFn(url, { headers: { 'User-Agent': GEO_UA, 'Accept': 'application/json', 'Accept-Language': 'zh-TW' }, signal: ctl ? ctl.signal : undefined });
    if (r.status === 429 || r.status === 403 || r.status === 503) { const e = new Error('osm ' + r.status); e.stop = true; throw e; }   // 被限流或擋下：整輪停，不硬打
    if (!r.ok) throw new Error('osm ' + r.status);
    const j = await r.json();
    return geoLabel(j && j.address);
  } finally { if (timer) clearTimeout(timer); }
}

// opts：fetchFn（測試用）、sleepFn（測試用）、nowFn
async function geoRound(env, now, opts) {
  opts = opts || {};
  const kv = env.ROADS_KV;
  if (!kv) return { skipped: 'nokv' };
  const fetchFn = opts.fetchFn || ((u, o) => fetch(u, o)), wait = opts.sleepFn || sleep, clock = opts.nowFn || Date.now;
  let off = null;
  try { off = await kv.get(GEO_OFF_KEY); } catch (e) {}
  if (geoOff(off)) return { off: true };
  let pend = null;
  try { pend = await kv.get(GEO_PEND_KEY, 'json'); } catch (e) { return { skipped: 'kvread' }; }
  if (!pend || pend.v !== 1 || !pend.q || !Object.keys(pend.q).length) return { n: 0 };   // 沒有待查：不寫任何 KV

  let st = null;
  try { st = await kv.get(GEO_OSM_KEY, 'json'); } catch (e) { return { skipped: 'kvread' }; }
  if (!st || st.v !== 1) st = { v: 1, days: {} };
  if (!st.days) st.days = {};
  if (st.runUntil && st.runUntil > now) return { skipped: 'running' };
  if (st.backoffUntil && st.backoffUntil > now) return { skipped: 'backoff', until: st.backoffUntil };
  const day = geoDay(now), dd = st.days[day] || (st.days[day] = { q: 0, ok: 0, empty: 0, fail: 0, w: 0 });
  if (dd.q >= GEO_DAY_CAP) return { skipped: 'daycap' };
  st.runUntil = now + GEO_LOCK_MS;
  try { await kv.put(GEO_OSM_KEY, JSON.stringify(st)); dd.w++; } catch (e) { return { skipped: 'kvwrite' }; }

  const keys = Object.keys(pend.q).filter(validGeoKey).sort((a, b) => pend.q[a].t - pend.q[b].t).slice(0, Math.min(GEO_ROUND_MAX, GEO_DAY_CAP - dd.q));
  const res = { n: 0, ok: 0, empty: 0, fail: 0, stopped: null };
  let lastReq = 0;
  for (const k of keys) {
    const gap = GEO_GAP_MS - (clock() - lastReq);
    if (lastReq && gap > 0) await wait(gap);
    lastReq = clock();
    res.n++; dd.q++;
    try {
      const name = await osmReverse(k, fetchFn);
      await kv.put(GEO_NAME_KEY(k), JSON.stringify({ n: name, t: clock() }), { expirationTtl: name ? GEO_NAME_TTL : GEO_EMPTY_TTL });
      dd.w++;
      delete pend.q[k];
      if (name) { res.ok++; dd.ok++; } else { res.empty++; dd.empty++; }
    } catch (e) {
      res.fail++; dd.fail++;
      const it = pend.q[k]; if (it) it.a = (it.a || 0) + 1;
      if (e && e.stop) {
        res.stopped = String(e.message).slice(0, 40);
        st.backoffUntil = clock() + (/429|403/.test(e.message) ? 3600000 : 900000);   // 被限流：1 小時；503：15 分鐘
        break;
      }
      if (it && it.a >= GEO_TRY_MAX) {   // 這格一直失敗：先記「查不到」一小時，免得手機一直問、佇列一直卡住
        try { await kv.put(GEO_NAME_KEY(k), JSON.stringify({ n: '', t: clock() }), { expirationTtl: GEO_GIVEUP_TTL }); dd.w++; } catch (e2) {}
        delete pend.q[k];
      }
    }
  }
  const left = Object.keys(pend.q).length;
  try { await kv.put(GEO_PEND_KEY, JSON.stringify(pend)); dd.w++; } catch (e) {}
  st.runUntil = 0;
  st.last = { at: now, n: res.n, ok: res.ok, empty: res.empty, fail: res.fail, left, stop: res.stopped };
  prune(st.days, 14);
  try { await kv.put(GEO_OSM_KEY, JSON.stringify(st)); } catch (e) {}
  res.left = left;
  return res;
}

// ---------- 統計頁用：讀出幾個監看數字 ----------
async function geoStats(kv, now) {
  const get = async k => { try { return await kv.get(k, 'json'); } catch (e) { return null; } };
  let off = null;
  try { off = await kv.get(GEO_OFF_KEY); } catch (e) {}
  const [pend, ask, osm] = await Promise.all([get(GEO_PEND_KEY), get(GEO_ASK_KEY), get(GEO_OSM_KEY)]);
  const day = geoDay(now), a = (ask && ask.days && ask.days[day]) || { r: 0, h: 0, m: 0, n: 0 }, o = (osm && osm.days && osm.days[day]) || { q: 0, ok: 0, empty: 0, fail: 0, w: 0 };
  const week = { h: 0, m: 0 };
  if (ask && ask.days) for (let i = 0; i < 7; i++) { const x = ask.days[geoDay(now - i * 86400000)]; if (x) { week.h += x.h; week.m += x.m; } }
  return {
    off: geoOff(off), pending: pend && pend.q ? Object.keys(pend.q).length : 0,
    today: { req: a.r, hit: a.h, miss: a.m, none: a.n, osm: o.q, ok: o.ok, empty: o.empty, fail: o.fail, writes: o.w },
    hitRateToday: a.h + a.m ? a.h / (a.h + a.m) : null, hitRateWeek: week.h + week.m ? week.h / (week.h + week.m) : null,
    last: osm && osm.last || null, backoffUntil: osm && osm.backoffUntil > now ? osm.backoffUntil : 0,
    askDays: ask && ask.days || {}, osmDays: osm && osm.days || {}
  };
}

// ===== 主程式 =====
const ORIGINS = ['https://app.realway.com.tw', 'https://welson0986.github.io', 'https://localhost', 'capacitor://localhost', 'http://localhost'];

function cors(req) {
  const o = req.headers.get('Origin');
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
  if (o && ORIGINS.indexOf(o) >= 0) { h['Access-Control-Allow-Origin'] = o; h['Access-Control-Allow-Methods'] = 'GET, OPTIONS'; h['Access-Control-Max-Age'] = '86400'; }
  return h;
}
const reply = (req, status, obj) => new Response(JSON.stringify(obj), { status, headers: cors(req) });

export async function onRequest(context) {
  const req = context.request, env = context.env || {};
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'GET') return reply(req, 405, { ok: false, err: 'method' });
  if (!env.ROADS_KV) return reply(req, 503, { ok: false, err: 'kv' });
  const keys = parseGeoKeys(new URL(req.url).searchParams.get('k'));
  if (!keys.length) return reply(req, 400, { ok: false, err: 'key' });
  const now = Date.now();
  const r = await geoAsk(env.ROADS_KV, keys, now);
  if (r.off) return reply(req, 200, { ok: true, off: true });
  geoCount(r);
  if (context.waitUntil) context.waitUntil(geoFlush(env.ROADS_KV, now));
  return reply(req, 200, { ok: true, names: r.names, none: r.none, wait: r.wait });
}
