// 跑車人生 官方路況快報 中繼（Cloudflare Pages Functions）
// 網址：https://app.realway.com.tw/api/roads?city=tpe,ntpc
//
// 做的事：
//   1. 向「警察廣播電臺即時路況」開放資料取全國最新 1000 筆（不用金鑰）。
//   2. 向交通部 TDX「道路事件」取即時事件（要金鑰；金鑰只放在 Cloudflare 的環境變數
//      TDX_CLIENT_ID、TDX_CLIENT_SECRET，程式裡沒有）。沒設定金鑰時只回警廣。
//   3. 整理成精簡的 JSON，只回 App 要的城市。
// App 只送城市代號（例如 tpe），不送位置、不送帳本。
//
// 為了不給資料來源添麻煩、也省 TDX 點數：
//   - 只有在有人來問、而且手上的資料過期時才去取：警廣與 TDX 主要城市 3 分鐘、
//     TDX 只有施工／災害的城市 1 小時。取到的放在 Cloudflare 快取。
//   - TDX 的 Access Token 有效 24 小時，快取約 23 小時才重取（官方使用原則）。
//   - 取失敗時 1 分鐘內不再重試。
// 免費額度：Pages Functions 跟 Workers 共用每天 100,000 次請求；App 每打開一次快報算 1 次。

const PBS_URL = 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata';
const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_BASE = 'https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/';
const TDX_SELECT = 'EventID,EventTitle,Description,EventType,EventSubType,Positions,Location,Impact,Source,PublishTime,LastUpdateTime,ExpireTime';
const FAST = 180, SLOW = 3600, FAIL = 60, TOKEN_TTL = 23 * 3600;
const DAY = 86400000;
const TIMEOUT_MS = 12000;

// 只接受這些來源的網頁讀取：網站、舊網址、App（Android／iOS 的內建網頁）
const ORIGINS = ['https://app.realway.com.tw', 'https://welson0986.github.io', 'https://localhost', 'capacitor://localhost', 'http://localhost'];

// 城市：跟 App「我主要跑」同一套代號。names＝地區欄開頭；box＝[南, 北, 西, 東]（約略範圍，給國道、省道用）；
// tdx＝要問的 TDX 縣市即時事件與多久問一次
const CITIES = {
  tpe:  { names: ['臺北市', '台北市'], box: [24.96, 25.21, 121.45, 121.67], tdx: [['City/Taipei', FAST]] },
  ntpc: { names: ['新北市'], box: [24.67, 25.30, 121.28, 122.01], tdx: [['City/NewTaipei', SLOW]] },
  tyc:  { names: ['桃園市', '桃園縣'], box: [24.59, 25.12, 120.98, 121.48], tdx: [['City/Taoyuan', SLOW]] },
  kel:  { names: ['基隆市'], box: [25.04, 25.20, 121.62, 121.82], tdx: [] },
  ila:  { names: ['宜蘭縣'], box: [24.30, 24.99, 121.30, 121.96], tdx: [['City/YilanCounty', FAST]] },
  hsz:  { names: ['新竹市', '新竹縣'], box: [24.43, 24.95, 120.88, 121.42], tdx: [] },
  mlc:  { names: ['苗栗縣'], box: [24.25, 24.75, 120.62, 121.27], tdx: [['City/MiaoliCounty', SLOW]] },
  txg:  { names: ['臺中市', '台中市'], box: [23.99, 24.45, 120.46, 121.45], tdx: [['City/Taichung', FAST]] },
  chw:  { names: ['彰化縣'], box: [23.78, 24.21, 120.23, 120.70], tdx: [] },
  nto:  { names: ['南投縣'], box: [23.44, 24.25, 120.60, 121.35], tdx: [] },
  yun:  { names: ['雲林縣'], box: [23.50, 23.85, 120.13, 120.75], tdx: [] },
  cyi:  { names: ['嘉義市', '嘉義縣'], box: [23.20, 23.65, 120.10, 120.90], tdx: [['City/ChiayiCounty', SLOW], ['City/Chiayi', SLOW]] },
  tnn:  { names: ['臺南市', '台南市'], box: [22.88, 23.42, 120.03, 120.66], tdx: [['City/Tainan', FAST]] },
  khh:  { names: ['高雄市'], box: [22.47, 23.47, 120.17, 121.05], tdx: [['City/Kaohsiung', FAST]] },
  pif:  { names: ['屏東縣'], box: [21.89, 22.89, 120.40, 120.92], tdx: [['City/PingtungCounty', FAST]] },
  hun:  { names: ['花蓮縣'], box: [23.10, 24.38, 121.28, 121.75], tdx: [] },
  ttt:  { names: ['臺東縣', '台東縣'], box: [22.25, 23.45, 120.75, 121.55], tdx: [] }
};
const TDX_ROADS = [['Freeway', FAST], ['Highway', FAST]];
const TDX_TYPE = { 1: '事故', 2: '道路施工', 3: '阻塞', 4: '交通管制', 5: '其他', 6: '災害', 7: '交通管制', 8: '交通障礙' };

// ---------- 快取：這台伺服器的記憶體＋Cloudflare 快取 ----------
const mem = new Map(), inflight = new Map();
async function cached(key, ttl, load) {
  const now = Date.now(), m = mem.get(key);
  if (m && now < m.until) return m.val;
  const ck = new Request('https://roads-relay.cache/' + encodeURIComponent(key));
  const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
  if (cache) {
    try {
      const hit = await cache.match(ck);
      if (hit) {
        const val = await hit.json(), until = +hit.headers.get('x-until') || now + FAIL * 1000;
        mem.set(key, { val, until });
        return val;
      }
    } catch (e) {}
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let val, life;
    try { val = await load(); life = ttl; } catch (e) { val = { ok: false, at: Date.now(), err: String(e && e.message || e).slice(0, 80) }; life = FAIL; }
    const until = Date.now() + life * 1000;
    mem.set(key, { val, until });
    if (cache) {
      try { await cache.put(ck, new Response(JSON.stringify(val), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + life, 'x-until': String(until) } })); } catch (e) {}
    }
    return val;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}
function forget(key) {
  mem.delete(key);
  if (typeof caches !== 'undefined' && caches.default) { try { return caches.default.delete(new Request('https://roads-relay.cache/' + encodeURIComponent(key))); } catch (e) {} }
}
async function get(url, init) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, init || {})); } finally { clearTimeout(t); }
}

// ---------- 共用整理 ----------
function cleanText(s) { return String(s == null ? '' : s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400); }
// 台灣時間 "2026-11-19 20:34:18.093" → 毫秒
function twTime(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600000;
}
// ISO 時間（有時區就照時區，沒有就當台灣時間）
function isoTime(s) {
  if (!s) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) { const t = Date.parse(s); return isNaN(t) ? null : t; }
  return twTime(s);
}
function cityOfName(s) {
  s = String(s || '');
  for (const k in CITIES) if (CITIES[k].names.some(n => s.indexOf(n) === 0)) return k;
  return null;
}
function inBox(k, la, lo) { const b = CITIES[k].box; return la != null && lo != null && la >= b[0] && la <= b[1] && lo >= b[2] && lo <= b[3]; }
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
// TDX 的點位字串格式沒有公開範例：找第一組「經度 118～123、緯度 21～27」的數字，順序不拘
function lonLat(s) {
  const n = String(s || '').match(/-?\d+(?:\.\d+)?/g) || [];
  for (let i = 0; i + 1 < n.length; i++) {
    const a = +n[i], b = +n[i + 1];
    if (a >= 118 && a <= 123 && b >= 21 && b <= 27) return [b, a];
    if (b >= 118 && b <= 123 && a >= 21 && a <= 27) return [a, b];
  }
  return [null, null];
}
function r5(n) { return n == null ? null : Math.round(n * 1e5) / 1e5; }
// 太舊的先丟掉，回給 App 的資料小一點（App 會再照顯示規則篩一次）
function fresh(it, now) {
  if (it.end && it.end > now) return true;
  return now - it.m <= (it.ty === '道路施工' ? 8 * DAY : 2 * DAY);
}

// ---------- 警廣 ----------
async function loadPbs() {
  const res = await get(PBS_URL, { headers: { 'Accept': '*/*' } });   // 警廣回 text/plain，只收 JSON 會被拒（406）
  if (!res.ok) throw new Error('pbs ' + res.status);
  const d = JSON.parse(await res.text());
  const now = Date.now(), seen = {}, items = [];
  (d && d.result || []).forEach(x => {
    const m = twTime(x.modDttm) || twTime((x.happendate || '') + ' ' + (x.happentime || ''));
    if (!m || !x.UID) return;
    const la = num(x.y1), lo = num(x.x1);
    const it = { id: 'p' + x.UID, s: 'pbs', ty: String(x.roadtype || '其他'), ar: cleanText(x.areaNm).slice(0, 60), tx: cleanText(x.comment), la: r5(la), lo: r5(lo), m: m, so: cleanText(x.srcdetail).slice(0, 40), di: cleanText(x.direction).slice(0, 10), c: cityOfName(x.areaNm) };
    if (!fresh(it, now)) return;
    if (seen[it.id] && seen[it.id].m >= m) return;   // 同一個 UID 只留最新的
    seen[it.id] = it;
  });
  for (const k in seen) items.push(seen[k]);
  return { ok: true, at: now, items };
}

// ---------- TDX ----------
async function tdxToken(env) {
  const v = await cached('tdx-token', TOKEN_TTL, async () => {
    const body = 'grant_type=client_credentials&client_id=' + encodeURIComponent(String(env.TDX_CLIENT_ID).trim()) + '&client_secret=' + encodeURIComponent(String(env.TDX_CLIENT_SECRET).trim());   // 貼上時多的空白、換行去掉
    const res = await get(TDX_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new Error('token ' + res.status);
    const j = await res.json();
    if (!j.access_token) throw new Error('token none');
    return { ok: true, at: Date.now(), tk: j.access_token };
  });
  if (!(v && v.ok)) throw new Error((v && v.err) || 'token');   // 把真正原因（例如 token 401）往上傳
  return v.tk;
}
function tdxArea(L) {
  L = L || {};
  const fe = L.FreeExpressHighway && [].concat(L.FreeExpressHighway)[0];
  if (fe && fe.Road) return [fe.Road, fe.Direction, fe.SectionStart && fe.SectionEnd ? fe.SectionStart + '～' + fe.SectionEnd : (fe.SectionStart || fe.Interchange || '')].filter(Boolean).join(' ');
  const rw = L.CityRoad && L.CityRoad.Roadways && L.CityRoad.Roadways[0];
  if (rw) return [(rw.City || '') + (rw.Town ? '-' + rw.Town : ''), rw.Road].filter(Boolean).join(' ');
  if (L.Intersection) return [L.Intersection.City, (L.Intersection.Roads || []).map(r => (r && (r.Road || r.Name)) || r).filter(x => typeof x === 'string').join('、')].filter(Boolean).join(' ');
  if (L.Address) return [L.Address.City, L.Address.Town, L.Address.Road].filter(Boolean).join(' ');
  if (L.Place && L.Place.POI) return L.Place.POI;
  return L.Other || '';
}
function tdxCity(L) {
  L = L || {};
  const rw = L.CityRoad && L.CityRoad.Roadways && L.CityRoad.Roadways[0];
  return cityOfName((rw && rw.City) || (L.Intersection && L.Intersection.City) || (L.Address && L.Address.City) || '');
}
async function loadTdx(ep, env, cityKey) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tk = await tdxToken(env);
    if (!tk) throw new Error('token');
    const head = { 'Authorization': 'Bearer ' + tk, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' };
    let res = await get(TDX_BASE + ep + '?%24select=' + encodeURIComponent(TDX_SELECT) + '&%24format=JSON', { headers: head });
    if (res.status === 400) res = await get(TDX_BASE + ep + '?%24format=JSON', { headers: head });   // 欄位名稱不被接受時改取全部
    if (res.status === 401 && attempt === 0) { await forget('tdx-token'); continue; }
    if (!res.ok) throw new Error('tdx ' + res.status);
    const d = await res.json();
    const list = Array.isArray(d) ? d : (d.Items || d.LiveEvents || d.Events || []);
    const now = Date.now(), items = [];
    list.forEach(x => {
      const m = isoTime(x.LastUpdateTime) || isoTime(x.PublishTime);
      if (!m || !x.EventID) return;
      const ll = lonLat(x.Positions);
      const imp = x.Impact || {}, dur = imp.Duration && [].concat(imp.Duration)[0];
      const end = isoTime(x.ExpireTime) || (dur && isoTime(dur.DurationEndTime)) || null;
      let ty = TDX_TYPE[x.EventType] || '其他';
      if (x.EventSubType === 805) ty = '號誌故障';
      const tx = cleanText([x.EventTitle, x.Description].filter((v, i, a) => v && a.indexOf(v) === i).join(' '));
      const it = { id: 't' + x.EventID, s: 'tdx', ty, st: x.EventSubType || null, ar: cleanText(tdxArea(x.Location)).slice(0, 60), tx, la: r5(ll[0]), lo: r5(ll[1]), m, so: cleanText(x.Source).slice(0, 40), c: cityKey || tdxCity(x.Location), end: end };
      if (fresh(it, now)) items.push(it);
    });
    return { ok: true, at: now, items };
  }
  throw new Error('tdx 401');
}

// ---------- 回應 ----------
function cors(req) {
  const o = req.headers.get('Origin');
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
  if (o && ORIGINS.indexOf(o) >= 0) { h['Access-Control-Allow-Origin'] = o; h['Access-Control-Allow-Methods'] = 'GET, OPTIONS'; h['Access-Control-Max-Age'] = '86400'; }
  return h;
}
function reply(req, status, obj) { return new Response(JSON.stringify(obj), { status, headers: cors(req) }); }

export async function onRequest(context) {
  const req = context.request, env = context.env || {};
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'GET') return reply(req, 405, { ok: false, err: 'method' });
  const url = new URL(req.url);
  const sel = [...new Set(String(url.searchParams.get('city') || '').split(',').map(s => s.trim()).filter(k => Object.prototype.hasOwnProperty.call(CITIES, k)))];
  if (!sel.length) return reply(req, 400, { ok: false, err: 'city' });

  const tdxOn = !!(env.TDX_CLIENT_ID && env.TDX_CLIENT_SECRET);
  const jobs = [cached('pbs', FAST, loadPbs)];
  const eps = [];
  if (tdxOn) {
    const want = {};
    sel.forEach(k => CITIES[k].tdx.forEach(e => { want[e[0]] = [e[1], k]; }));
    TDX_ROADS.forEach(e => { want[e[0]] = [e[1], null]; });
    for (const ep in want) { eps.push(ep); jobs.push(cached('tdx:' + ep, want[ep][0], () => loadTdx(ep, env, want[ep][1]))); }
  }
  const got = await Promise.all(jobs);
  const pbs = got[0], tdx = got.slice(1);
  const pick = it => it.c ? sel.indexOf(it.c) >= 0 : sel.some(k => inBox(k, it.la, it.lo));
  let items = [];
  got.forEach(g => { if (g && g.ok) items = items.concat(g.items.filter(pick)); });
  items = items.map(it => { const o = Object.assign({}, it); delete o.c; return o; });
  const tdxOk = tdxOn && tdx.length > 0 && tdx.every(g => g && g.ok);
  const tdxAt = tdx.filter(g => g && g.ok).reduce((a, g) => Math.max(a, g.at), 0) || null;
  // 失敗原因只留英數字（例如 token 401、tdx 429），不會含金鑰
  const bad = tdx.find(g => !(g && g.ok)), tdxErr = bad ? String((bad && bad.err) || 'fail').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 30) : null;
  return reply(req, 200, {
    ok: !!(pbs && pbs.ok) || tdx.some(g => g && g.ok), v: 1, t: Date.now(), cities: sel,
    src: { pbs: { ok: !!(pbs && pbs.ok), at: pbs && pbs.ok ? pbs.at : null }, tdx: { on: tdxOn, ok: tdxOk, part: tdxOn && !tdxOk && tdx.some(g => g && g.ok), at: tdxAt, err: tdxErr } },
    items
  });
}
