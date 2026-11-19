// ⚠️ 這個檔案是 `node relay/build.mjs` 自動產生的，不要直接改。
// 要改請改 App 倉庫 relay/src/pages_roads.js 與 relay/lib/，再重新產生。

// 跑車人生 官方路況快報 中繼（Cloudflare Pages Functions）
// 網址：https://app.realway.com.tw/api/roads?city=tpe,ntpc
//
// 做的事：
//   1. 台北（tpe）、新北（ntpc）：讀排程 Worker 每 3 分鐘存進 KV 的快照，自己不去抓。
//      快照超過 12 分鐘沒更新（Worker 停了）或還沒設定 KV 時，改回自己抓，App 不會斷。
//   2. 其他縣市：跟以前一樣，有人來問、手上的資料過期時才去取：
//      警廣與 TDX 主要城市 3 分鐘、TDX 只有施工／災害的城市 1 小時，放在 Cloudflare 快取。
//   3. 整理成精簡的 JSON，只回 App 要的城市。App 只送城市代號，不送位置、不送帳本。
// 金鑰只放在 Cloudflare 的 Secrets（TDX_CLIENT_ID、TDX_CLIENT_SECRET），程式裡沒有。
// 免費額度：Pages Functions 跟 Workers 共用每天 100,000 次請求；App 每打開一次快報算 1 次。

// ===== 路況共用程式（relay/lib/roads_core.js）=====
// Pages 中繼（/api/roads、/api/roads-stats）和排程 Worker 都用這一份。
// 不要直接改 relay/functions/ 或 relay/worker/ 裡的檔案：那些是 `node relay/build.mjs` 自動產生的。

const PBS_URL = 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata';
const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_BASE = 'https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/';
const TDX_SELECT = 'EventID,EventTitle,Description,EventType,EventSubType,Positions,Location,Impact,Source,PublishTime,LastUpdateTime,ExpireTime';
const FAST = 180, SLOW = 3600, FAIL = 60, TOKEN_TTL = 23 * 3600;
const DAY = 86400000, MIN = 60000, HOUR = 3600000;
const TIMEOUT_MS = 12000;

// 雙北由排程 Worker 每 3 分鐘抓好存進 KV；這個 key 是那份快照
const SNAP_KEY = 'roads:snap:v1';
const TOKEN_KEY = 'roads:tdx-token';
const SNAP_CITIES = ['tpe', 'ntpc'];

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

// ---------- 連外 ----------
async function get(url, init) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, init || {})); } finally { clearTimeout(t); }
}
// 失敗原因只留英數字（例如 token 401、tdx 429），不會含金鑰
function errText(e) { return String((e && e.message) || e || 'fail').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 30) || 'fail'; }

// ---------- 整理 ----------
function cleanText(s) { return String(s == null ? '' : s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400); }
// 台灣時間 "2026-11-19 20:34:18.093" → 毫秒
function twTime(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * HOUR;
}
// ISO 時間（有時區就照時區，沒有就當台灣時間）
function isoTime(s) {
  if (!s) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) { const t = Date.parse(s); return isNaN(t) ? null : t; }
  return twTime(s);
}
// 城市名都是 3 個字：用前 3 個字查表（警廣每輪 1000 筆，逐一比對太花時間）
const NAME3 = {};
for (const k in CITIES) CITIES[k].names.forEach(n => { NAME3[n] = k; });
function cityOfName(s) { return NAME3[String(s || '').slice(0, 3)] || null; }
function inBox(k, la, lo) { const b = CITIES[k].box; return la != null && lo != null && la >= b[0] && la <= b[1] && lo >= b[2] && lo <= b[3]; }
// 這一筆屬不屬於選的城市：地區欄有城市就看城市，沒有（國道、省道）就看座標
function picker(sel) { return it => it.c ? sel.indexOf(it.c) >= 0 : sel.some(k => inBox(k, it.la, it.lo)); }
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
function freshItem(it, now) {
  if (it.end && it.end > now) return true;
  return now - it.m <= (it.ty === '道路施工' ? 8 * DAY : 2 * DAY);
}
// 同一個編號只留最新的一筆（警廣 UID、TDX EventID；TDX 同一件會重複出現很多次，2026-11-20 實測 699 筆只有 164 件）
function keepNewest(list) {
  const seen = {}, out = [];
  list.forEach(it => { if (!seen[it.id] || seen[it.id].m < it.m) seen[it.id] = it; });
  for (const k in seen) out.push(seen[k]);
  return out;
}

// ---------- 警廣 ----------
// pick：只要某些城市時先篩（排程 Worker 只要雙北），省下整理其他 700 多筆文字的時間
function parsePbs(text, now, pick) {
  const d = JSON.parse(text), list = [];
  (d && d.result || []).forEach(x => {
    const m = twTime(x.modDttm) || twTime((x.happendate || '') + ' ' + (x.happentime || ''));
    if (!m || !x.UID) return;
    const ty = String(x.roadtype || '其他');
    if (!freshItem({ ty, m }, now)) return;
    const it = { id: 'p' + x.UID, s: 'pbs', ty, la: r5(num(x.y1)), lo: r5(num(x.x1)), m: m, c: cityOfName(x.areaNm) };
    if (pick && !pick(it)) return;
    it.ar = cleanText(x.areaNm).slice(0, 60); it.tx = cleanText(x.comment); it.so = cleanText(x.srcdetail).slice(0, 40); it.di = cleanText(x.direction).slice(0, 10);
    list.push(it);
  });
  return keepNewest(list);
}
async function fetchPbs() {
  const res = await get(PBS_URL, { headers: { 'Accept': '*/*' } });   // 警廣回 text/plain，只收 JSON 會被拒（406）
  if (!res.ok) throw new Error('pbs ' + res.status);
  return res.text();
}

// ---------- TDX ----------
async function fetchTdxToken(env) {
  const body = 'grant_type=client_credentials&client_id=' + encodeURIComponent(String(env.TDX_CLIENT_ID).trim()) + '&client_secret=' + encodeURIComponent(String(env.TDX_CLIENT_SECRET).trim());   // 貼上時多的空白、換行去掉
  const res = await get(TDX_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error('token ' + res.status);
  const j = await res.json();
  if (!j.access_token) throw new Error('token none');
  return j.access_token;
}
// 回 { status, json }；400 時改取全部欄位（欄位名稱不被接受時）
async function fetchTdxRaw(ep, tk) {
  const head = { 'Authorization': 'Bearer ' + tk, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' };
  let res = await get(TDX_BASE + ep + '?%24select=' + encodeURIComponent(TDX_SELECT) + '&%24format=JSON', { headers: head });
  if (res.status === 400) res = await get(TDX_BASE + ep + '?%24format=JSON', { headers: head });
  if (!res.ok) return { status: res.status, json: null };
  return { status: res.status, json: await res.json() };
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
function parseTdx(d, cityKey, now, pick) {
  const src = Array.isArray(d) ? d : ((d && (d.Items || d.LiveEvents || d.Events)) || []), list = [];
  src.forEach(x => {
    const m = isoTime(x.LastUpdateTime) || isoTime(x.PublishTime);
    if (!m || !x.EventID) return;
    const ll = lonLat(x.Positions);
    const imp = x.Impact || {}, dur = imp.Duration && [].concat(imp.Duration)[0];
    const end = isoTime(x.ExpireTime) || (dur && isoTime(dur.DurationEndTime)) || null;
    let ty = TDX_TYPE[x.EventType] || '其他';
    if (x.EventSubType === 805) ty = '號誌故障';
    if (!freshItem({ ty, m, end }, now)) return;
    const c = cityKey || tdxCity(x.Location);
    if (pick && !pick({ c, la: r5(ll[0]), lo: r5(ll[1]) })) return;
    // TDX 的說明有時夾著系統內部編號（例如「事故-17951081390001654222000112124」），12 位以上的純數字對司機沒用，拿掉
    const tx = cleanText([x.EventTitle, x.Description].filter((v, i, a) => v && a.indexOf(v) === i).join(' ').replace(/[-_#:：]?\d{12,}/g, ''));
    list.push({ id: 't' + x.EventID, s: 'tdx', ty, st: x.EventSubType || null, ar: cleanText(tdxArea(x.Location)).slice(0, 60), tx, la: r5(ll[0]), lo: r5(ll[1]), m, so: cleanText(x.Source).slice(0, 40), c, end: end });
  });
  return keepNewest(list);
}
// 要問哪些 TDX 網址：{ 'City/Taipei': [多久一次, 城市代號或 null], ... }
function tdxWant(sel) {
  const want = {};
  sel.forEach(k => CITIES[k].tdx.forEach(e => { want[e[0]] = [e[1], k]; }));
  TDX_ROADS.forEach(e => { want[e[0]] = [e[1], null]; });
  return want;
}

// ---------- 警廣＋TDX 合併（跟 App 的 rnMerge 同一套）----------
// 300 公尺內、更新時間差 30 分鐘內、同一類、不同來源 → 同一件
const GROUP = { '事故': 'acc', '阻塞': 'jam', '道路施工': 'work', '交通管制': 'ctl' };
function dist(a, b) {
  if (a.la == null || a.lo == null || b.la == null || b.lo == null) return Infinity;
  const dy = (a.la - b.la) * 110540, dx = (a.lo - b.lo) * 111320 * Math.cos(a.la * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}
function mergeSources(items) {
  const out = [];
  keepNewest(items || []).sort((a, b) => (b.m - a.m) || (a.id < b.id ? -1 : 1)).forEach(it => {
    const g = GROUP[it.ty] || 'obs';
    let hit = null;
    for (let i = 0; i < out.length && !hit; i++) {
      const e = out[i];
      if (e.srcs.indexOf(it.s) < 0 && (GROUP[e.ty] || 'obs') === g && Math.abs(e.m - it.m) <= 30 * MIN && dist(e, it) <= 300) hit = e;
    }
    if (!hit) { out.push({ id: it.id, ids: [it.id], ty: it.ty, st: it.st || null, ar: it.ar || '', tx: it.tx || '', tx2: '', la: it.la, lo: it.lo, m: it.m, srcs: [it.s], so: [it.so || ''].filter(Boolean) }); return; }
    hit.ids.push(it.id); hit.srcs.push(it.s);
    if (it.so && hit.so.indexOf(it.so) < 0) hit.so.push(it.so);
    if (it.s === 'pbs') { hit.tx2 = hit.tx; hit.tx = it.tx || hit.tx; if (it.ar) hit.ar = it.ar; } else hit.tx2 = it.tx || '';
    if (it.m > hit.m) hit.m = it.m;
    if (it.st && !hit.st) hit.st = it.st;
  });
  return out;
}

// ---------- 篩選規則（定案規格第三節）----------
// 已排除：「已排除」等字，或警廣開頭的「*1939新北交大:排除*」寫法
const DONE_WORDS = ['已排除', '已修復', '已移除', '已恢復', '已解除'];
const DONE_NOTE = /\*[^*]{0,30}(排除|恢復|結束|解除|移除|修復|處理完畢)[^*]{0,20}\*/;
// 有這些字就「不算重大」（例：已解除封路、未封路、明日凌晨封路）—— App 的 RN_NOT_MAJOR 同一套
const NOT_MAJOR_WORDS = ['解除', '已排除', '未', '預計', '明日', '明天', '今晚', '預告'];
// 明確封路／封閉／無法通行／主要道路嚴重阻斷（主要橋梁、隧道封閉也是這些字）
const CLOSE_WORDS = ['封路', '封閉', '無法通行', '禁止通行', '道路中斷', '交通中斷', '全線阻斷', '雙向阻斷', '雙向管制'];
// 輔助：要搭配「影響行車」才算重大
const AUX_WORDS = ['火災', '翻覆', '多車', '受困', '傷亡', '坍方', '淹水', '停電', '火燒車'];
// 「影響行車」只認嚴重的寫法；單純「佔用內側車道」不算（先記錄一週看實際數字再調）
const IMPACT_WORDS = ['全部車道', '所有車道', '全線', '雙向', '回堵', '改道', '中斷', '阻斷'];
const has = (t, ws) => ws.some(w => t.indexOf(w) >= 0);
function isDone(t) { return has(t, DONE_WORDS) || DONE_NOTE.test(t); }
// 只有熱心聽眾（沒有官方單位、沒有 TDX）
function listenerOnly(e) {
  if (e.srcs.indexOf('tdx') >= 0) return false;
  const so = e.so.join('+');
  return /熱心聽眾/.test(so) && so.replace(/熱心聽眾/g, '').replace(/[+＋、,，\s]/g, '') === '';
}
// 回 { lv: 'major'|'acc'|'gen'|'work'|'done', why: 壓掉的原因（沒有就 null）}
function classify(e) {
  const t = (e.tx || '') + ' ' + (e.tx2 || '');
  if (isDone(t)) return { lv: 'done', why: null };
  const close = has(t, CLOSE_WORDS), aux = has(t, AUX_WORDS) || e.ty === '災害' || e.st === 105, impact = has(t, IMPACT_WORDS), neg = has(t, NOT_MAJOR_WORDS);
  if (e.ty === '道路施工') return { lv: 'work', why: close && !neg ? 'workClose' : null };
  const majorish = close || (aux && impact);
  const accType = e.ty === '事故' || e.ty === '交通障礙' || e.st === 303 || e.st === 304;
  if (majorish && !neg) return listenerOnly(e) ? { lv: 'acc', why: 'listener' } : { lv: 'major', why: null };
  const why = majorish ? 'neg' : (aux ? 'aux' : null);
  return { lv: accType || aux ? 'acc' : 'gen', why };
}

// ---------- 台灣時間 ----------
function twDay(ms) { return new Date(ms + 8 * HOUR).toISOString().slice(0, 10); }
function twHour(ms) { return new Date(ms + 8 * HOUR).getUTCHours(); }
function twHm(ms) { return ms ? new Date(ms + 8 * HOUR).toISOString().slice(11, 16) : '—'; }

// ===== 主程式 =====
// 只接受這些來源的網頁讀取：網站、舊網址、App（Android／iOS 的內建網頁）
const ORIGINS = ['https://app.realway.com.tw', 'https://welson0986.github.io', 'https://localhost', 'capacitor://localhost', 'http://localhost'];
const SNAP_MAX_AGE = 12 * MIN;

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

// ---------- 自己抓（其他縣市；快照不能用時雙北也走這裡）----------
async function loadPbs() { return { ok: true, at: Date.now(), items: parsePbs(await fetchPbs(), Date.now()) }; }
async function tdxToken(env) {
  const v = await cached('tdx-token', TOKEN_TTL, async () => ({ ok: true, at: Date.now(), tk: await fetchTdxToken(env) }));
  if (!(v && v.ok)) throw new Error((v && v.err) || 'token');   // 把真正原因（例如 token 401）往上傳
  return v.tk;
}
async function loadTdx(ep, env, cityKey) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchTdxRaw(ep, await tdxToken(env));
    if (r.status === 401 && attempt === 0) { await forget('tdx-token'); continue; }
    if (!r.json) throw new Error('tdx ' + r.status);
    return { ok: true, at: Date.now(), items: parseTdx(r.json, cityKey, Date.now()) };
  }
  throw new Error('tdx 401');
}
async function live(sel, env) {
  const tdxOn = !!(env.TDX_CLIENT_ID && env.TDX_CLIENT_SECRET);
  const jobs = [cached('pbs', FAST, loadPbs)];
  if (tdxOn) {
    const want = tdxWant(sel);
    for (const ep in want) jobs.push(cached('tdx:' + ep, want[ep][0], () => loadTdx(ep, env, want[ep][1])));
  }
  const got = await Promise.all(jobs), pbs = got[0], tdx = got.slice(1), pick = picker(sel);
  let items = [];
  got.forEach(g => { if (g && g.ok) items = items.concat(g.items.filter(pick)); });
  return {
    items,
    pbs: { ok: !!(pbs && pbs.ok), at: pbs && pbs.ok ? pbs.at : null },
    tdx: tdx.map(g => ({ ok: !!(g && g.ok), at: g && g.ok ? g.at : null, err: g && !g.ok ? errText(g.err) : null })),
    tdxOn
  };
}

// ---------- 讀快照（台北、新北）----------
async function readSnap(env, now) {
  if (!env.ROADS_KV) return null;
  let s = null;
  try { s = await env.ROADS_KV.get(SNAP_KEY, { type: 'json', cacheTtl: 60 }); } catch (e) { return null; }
  if (!s || s.v !== 1 || !s.at || now - s.at > SNAP_MAX_AGE) return null;   // Worker 停了 → 自己抓
  return s;
}
// 一個來源在快照裡的狀態：上一輪失敗但還有上次成功的資料 → 照樣給，標 stale（App 會寫「先顯示 hh:mm 的」）
function snapSrc(s, period, now) {
  if (!s || !s.okAt) return { ok: false, at: null, stale: false, use: false, err: s && s.err };
  const use = now - s.okAt <= period * 1000 + HOUR;
  return { ok: use, at: s.okAt, stale: use && !s.ok, use, err: s.ok ? null : s.err };
}
function fromSnap(snap, sel, now) {
  const pick = picker(sel), want = tdxWant(SNAP_CITIES);
  const p = snapSrc(snap.src.pbs, FAST, now);
  let items = p.use ? snap.src.pbs.items.filter(pick) : [];
  const tdx = [];
  if (snap.tdxOn) for (const ep in want) {
    const t = snapSrc(snap.src[ep], want[ep][0], now);
    if (t.use) items = items.concat(snap.src[ep].items.filter(pick));
    tdx.push({ ok: t.ok, at: t.at, stale: t.stale, err: t.err || null });
  }
  return { items, pbs: { ok: p.ok, at: p.at, stale: p.stale }, tdx, tdxOn: !!snap.tdxOn };
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

  const now = Date.now();
  const inSnap = sel.filter(k => SNAP_CITIES.indexOf(k) >= 0), others = sel.filter(k => SNAP_CITIES.indexOf(k) < 0);
  const snap = inSnap.length ? await readSnap(env, now) : null;
  const parts = [];
  if (snap) parts.push(fromSnap(snap, inSnap, now));
  const liveSel = snap ? others : sel;
  if (liveSel.length) parts.push(await live(liveSel, env));

  // 合併：同一筆（例如國道在台北和桃園的範圍都有）只留一筆
  const byId = {};
  parts.forEach(p => p.items.forEach(it => { if (!byId[it.id] || byId[it.id].m < it.m) byId[it.id] = it; }));
  const items = Object.keys(byId).map(k => { const o = Object.assign({}, byId[k]); delete o.c; return o; });
  const pbsOk = parts.every(p => p.pbs.ok), tdxOn = parts.some(p => p.tdxOn);
  const tdx = [].concat(...parts.map(p => p.tdx));
  const tdxOk = tdxOn && tdx.length > 0 && tdx.every(g => g.ok);
  const bad = tdx.find(g => !g.ok || g.err);
  const at = list => list.filter(g => g.ok && g.at).reduce((a, g) => Math.max(a, g.at), 0) || null;
  return reply(req, 200, {
    ok: parts.some(p => p.pbs.ok) || tdx.some(g => g.ok), v: 1, t: now, cities: sel, snap: snap ? snap.at : null,
    src: {
      pbs: { ok: pbsOk, at: parts.filter(p => p.pbs.ok).reduce((a, p) => a == null ? p.pbs.at : Math.min(a, p.pbs.at), null), stale: parts.some(p => p.pbs.stale) },
      tdx: { on: tdxOn, ok: tdxOk, part: tdxOn && !tdxOk && tdx.some(g => g.ok), at: at(tdx), err: bad ? errText(bad.err || 'fail') : null, stale: tdx.some(g => g.stale) }
    },
    items
  });
}
