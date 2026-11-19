// ⚠️ 這個檔案是 `node relay/build.mjs` 自動產生的，不要直接改。
// 要改請改 App 倉庫 relay/src/pages_roads_stats.js 與 relay/lib/，再重新產生。

// 跑車人生 路況提醒「只記錄不推播」統計頁（Cloudflare Pages Functions）
// 網址：https://app.realway.com.tw/api/roads-stats（只給威爾森看）
// 用瀏覽器打開會跳出帳號密碼框：帳號隨便填，密碼是 Cloudflare Secret「ROADS_STATS_KEY」。
// 沒設定這個 Secret 時一律拒絕。加 ?format=json 回原始數字。

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
async function get(url, init, ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || TIMEOUT_MS);
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
// ms：等多久算逾時。排程 Worker 不一定在台灣的機房跑，警廣 460 KB 傳過去可能比較慢，給長一點
async function fetchPbs(ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || TIMEOUT_MS);
  try {
    const res = await fetch(PBS_URL, { signal: ctl.signal, headers: { 'Accept': '*/*' } });   // 警廣回 text/plain，只收 JSON 會被拒（406）
    if (!res.ok) throw new Error('pbs ' + res.status);
    return await res.text();   // 讀完內容才算數（逾時也要算到這裡）
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('pbs timeout');
    throw e;
  } finally { clearTimeout(t); }
}
// Pages 中繼和排程 Worker 共用 KV 裡的同一張 TDX Token（少向 TDX 要 Token，避免被擋 429）
async function readToken(kv, now) {
  if (!kv) return null;
  try { const t = await kv.get(TOKEN_KEY, 'json'); return t && t.tk && t.until > now ? t.tk : null; } catch (e) { return null; }
}
async function saveToken(kv, tk, now) {
  if (!kv) return;
  try { await kv.put(TOKEN_KEY, JSON.stringify({ tk, until: now + 23 * HOUR })); } catch (e) {}
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

// ===== 「只記錄不推播」模擬（relay/lib/alert_sim.js）=====
// 每輪照定案規格第三節的規則算「如果現在推，會推什麼」，只記在統計裡，不推給任何人。
// 模擬一位「雙北司機」：台北＋新北都勾、一直在上班、沒設不打擾時段（每小時的數字可以自己對照上班時段看）。

const FRESH_MS = 15 * MIN;          // 新鮮：來源更新時間在 15 分鐘內
const GAP_MS = 10 * MIN;            // 每位司機 10 分鐘最多 1 批
const DAY_CAP = 5;                  // 每天最多 5 批
const BASELINE_GAP = 15 * MIN;      // 隔這麼久沒跑（剛上線、服務恢復）→ 先把現有的記為已看過，不推
const KEEP_DAYS = 8;
const STAGE = { major: 2, acc: 1, gen: 0, work: 0, done: 0 };

const WHY_NAMES = {
  baseline: '啟動基準（剛開始或服務恢復，現有的先記為已看過）',
  stale: '不新鮮（來源更新超過 15 分鐘）',
  listener: '只有熱心聽眾（列「待確認」，不推）',
  neg: '有「解除、未、預計、明日、今晚、預告」等字眼',
  aux: '只有火災、翻覆、多車等字，沒有寫到影響行車',
  workClose: '施工封路（列重大候選，不推）',
  tenMin: '10 分鐘內已推過一批（只更新摘要）',
  dayCap: '今天已滿 5 批（只更新摘要）'
};

function newDay() {
  return { runs: 0, fails: { pbs: 0, tdx: 0 }, batches: 0, events: 0, hours: new Array(24).fill(0), cand: [], peak: { n: 0, at: 0 },
    why: { baseline: 0, stale: 0, listener: 0, neg: 0, aux: 0, workClose: 0, tenMin: 0, dayCap: 0 }, dups: 0, cleared: 0, cleared60: 0, samples: [], negs: [] };
}
function short(e) { return ((e.ar ? e.ar + '｜' : '') + (e.tx || e.tx2 || '')).slice(0, 60); }

// state：上一輪留下的 { lastRun, seen, drv, days }；events：這一輪「有新抓到」的來源合併後的事件
// base：這一輪剛恢復的來源（{pbs:true} 之類），只來自這些來源的事件當成啟動基準
function simulate(state, events, now, base) {
  state = state || {};
  const seen = state.seen || (state.seen = {});
  const days = state.days || (state.days = {});
  const today = twDay(now);
  const day = days[today] || (days[today] = newDay());
  const startup = !state.lastRun || now - state.lastRun > BASELINE_GAP;
  base = base || {};
  day.runs++;

  const once = (ids, why, e) => {
    if (ids.some(id => seen[id] && seen[id].w && seen[id].w.indexOf(why) >= 0)) return;
    day.why[why]++;
    ids.forEach(id => { if (seen[id]) (seen[id].w = seen[id].w || []).push(why); });
    if (why === 'neg') { day.negs.push({ at: now, tx: short(e) }); if (day.negs.length > 10) day.negs.shift(); }
  };

  const cands = [];
  events.forEach(e => {
    const ids = e.ids || [e.id];
    let prev = -1;
    ids.forEach(id => { if (seen[id] && seen[id].st > prev) prev = seen[id].st; });
    const c = classify(e), stage = STAGE[c.lv];
    if (prev < 0 && e.srcs.length > 1) day.dups++;
    ids.forEach(id => {
      const s = seen[id] || (seen[id] = { st: -1, f: now });
      s.st = Math.max(s.st, stage, prev); s.l = now;
    });
    if (c.lv === 'done') {
      // 推過之後被標成已排除：算「已排除仍被選中」
      const p = ids.map(id => seen[id]).find(s => s.p && !s.cl);
      if (p) { day.cleared++; if (now - p.p <= 60 * MIN) day.cleared60++; ids.forEach(id => { seen[id].cl = 1; }); }
      return;
    }
    if (c.why) once(ids, c.why, e);
    if (c.lv !== 'major' || prev >= 2) return;
    if (startup || e.srcs.every(s => base[s])) return once(ids, 'baseline', e);
    if (now - e.m > FRESH_MS) return once(ids, 'stale', e);
    cands.push({ e, ids });
  });

  if (cands.length) {
    cands.sort((a, b) => b.e.m - a.e.m);
    cands.forEach(() => day.cand.push(now));
    // 最密集的 10 分鐘（推播限制之前的候選數）
    for (let i = 0, j = 0; i < day.cand.length; i++) {
      while (day.cand[i] - day.cand[j] >= GAP_MS) j++;
      if (i - j + 1 > day.peak.n) day.peak = { n: i - j + 1, at: day.cand[j] };
    }
    const drv = state.drv || (state.drv = { day: today, n: 0, last: 0 });
    if (drv.day !== today) { drv.day = today; drv.n = 0; }
    if (drv.last && now - drv.last < GAP_MS) cands.forEach(c => once(c.ids, 'tenMin', c.e));
    else if (drv.n >= DAY_CAP) cands.forEach(c => once(c.ids, 'dayCap', c.e));
    else {
      drv.last = now; drv.n++;
      day.batches++; day.events += cands.length; day.hours[twHour(now)]++;
      cands.forEach(c => c.ids.forEach(id => { seen[id].p = now; }));
      day.samples.push({ at: now, main: short(cands[0].e), more: cands.length - 1 });
      if (day.samples.length > 30) day.samples.shift();
    }
  }

  // 整理：2 天沒再出現的事件忘掉；統計留 8 天
  for (const id in seen) if (now - (seen[id].l || 0) > 2 * DAY) delete seen[id];
  Object.keys(days).sort().slice(0, -KEEP_DAYS).forEach(k => { delete days[k]; });
  state.lastRun = now;
  return { state, day, cands: cands.length };
}

// ===== 主程式 =====
const SRC_NAMES = { pbs: '警廣', 'City/Taipei': 'TDX 台北市', 'City/NewTaipei': 'TDX 新北市（每小時）', Freeway: 'TDX 國道', Highway: 'TDX 省道' };

function same(a, b) {   // 比對密碼：長度不同也照樣比完，不給猜長度的機會
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function authed(req, key) {
  const h = req.headers.get('Authorization') || '';
  if (!/^Basic /i.test(h)) return false;
  let raw = '';
  try { raw = atob(h.slice(6).trim()); } catch (e) { return false; }
  const i = raw.indexOf(':');
  return i >= 0 && same(raw.slice(i + 1), key);
}
const HEAD = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (ms, now) => ms ? Math.round((now - ms) / 60000) + ' 分鐘前' : '從來沒有';

function page(snap, now) {
  const sim = snap.sim || {}, days = sim.days || {}, keys = Object.keys(days).sort().reverse();
  let h = '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>路況提醒統計</title>' +
    '<style>body{font:15px/1.6 system-ui,sans-serif;margin:0 auto;max-width:760px;padding:12px 16px;color:#222;background:#fff}h1{font-size:20px}h2{font-size:17px;margin-top:22px;border-bottom:1px solid #ddd}' +
    'table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}.bad{color:#c00;font-weight:700}.ok{color:#080}.bar{display:inline-block;background:#e67e22;height:10px}.muted{color:#777;font-size:13px}' +
    '@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#444}.muted{color:#aaa}}</style></head><body>';
  h += '<h1>🚦 路況提醒・只記錄不推播</h1>';
  h += '<p class="muted">模擬一位台北＋新北都勾、一直在上班的司機：照定案規則「如果現在推會推什麼」。<b>沒有推給任何人。</b>時間都是台灣時間。</p>';
  h += '<h2>Worker 狀態</h2><p>最後一次執行：<b>' + twHm(snap.at) + '</b>（' + ago(snap.at, now) + '）' + (now - snap.at > 10 * 60000 ? ' <span class="bad">超過 10 分鐘沒跑，請檢查 Worker 排程</span>' : ' <span class="ok">正常</span>') +
    '　累計執行 ' + (snap.runs || 0) + ' 次　今天寫入 KV ' + ((snap.w && snap.w.day === twDay(now)) ? snap.w.n : 0) + ' 次（上限 1,000）</p>';
  h += '<table><tr><th>來源</th><th>最後成功</th><th>這一輪</th><th>連續失敗</th><th>雙北筆數</th></tr>';
  for (const k in snap.src) {
    const s = snap.src[k];
    h += '<tr><td>' + esc(SRC_NAMES[k] || k) + '</td><td>' + twHm(s.okAt) + '（' + ago(s.okAt, now) + '）</td><td>' + (s.ok ? '<span class="ok">成功</span>' : '<span class="bad">失敗 ' + esc(s.err) + '</span>') + '</td><td>' + (s.fails || 0) + '</td><td>' + (s.items ? s.items.length : 0) + '</td></tr>';
  }
  if (!snap.tdxOn) h += '<tr><td colspan="5" class="bad">Worker 沒有設定 TDX 金鑰，只抓警廣</td></tr>';
  h += '</table>';

  h += '<h2>每天</h2><table><tr><th>日期</th><th>會推幾批</th><th>候選件數</th><th>最密集 10 分鐘</th><th>重複件（警廣＋TDX 同一件）</th><th>推了之後被排除（1 小時內）</th><th>來源失敗次數</th></tr>';
  keys.forEach(k => {
    const d = days[k];
    h += '<tr><td>' + k + '</td><td><b>' + d.batches + '</b></td><td>' + d.cand.length + '</td><td>' + d.peak.n + (d.peak.n ? '（' + twHm(d.peak.at) + ' 起）' : '') + '</td><td>' + d.dups + '</td><td>' + d.cleared + '（' + d.cleared60 + '）</td><td>警廣 ' + d.fails.pbs + '・TDX ' + d.fails.tdx + '</td></tr>';
  });
  h += '</table>';

  keys.slice(0, 2).forEach(k => {
    const d = days[k], max = Math.max(1, ...d.hours);
    h += '<h2>' + k + ' 每小時批數</h2><table>';
    d.hours.forEach((n, i) => { h += '<tr><td style="width:60px">' + String(i).padStart(2, '0') + ':00</td><td style="width:40px">' + n + '</td><td><span class="bar" style="width:' + Math.round(n / max * 300) + 'px"></span></td></tr>'; });
    h += '</table><h2>' + k + ' 被壓掉的原因（每件只算一次）</h2><table>';
    for (const w in WHY_NAMES) h += '<tr><td>' + WHY_NAMES[w] + '</td><td style="width:60px">' + (d.why[w] || 0) + '</td></tr>';
    h += '</table>';
    if (d.samples.length) {
      h += '<h2>' + k + ' 會推的內容（最近 30 批）</h2><table>';
      d.samples.slice().reverse().forEach(s => { h += '<tr><td style="width:60px">' + twHm(s.at) + '</td><td>' + esc(s.main) + (s.more ? '　<b>另有 ' + s.more + ' 則</b>' : '') + '</td></tr>'; });
      h += '</table>';
    }
    if (d.negs.length) {
      h += '<h2>' + k + ' 因為「解除、未、預計…」字眼沒算重大的例子</h2><table>';
      d.negs.slice().reverse().forEach(s => { h += '<tr><td style="width:60px">' + twHm(s.at) + '</td><td>' + esc(s.tx) + '</td></tr>'; });
      h += '</table>';
    }
  });
  return h + '<p class="muted">這頁每次打開都是最新的；Worker 每 3 分鐘更新一次。</p></body></html>';
}

export async function onRequest(context) {
  const req = context.request, env = context.env || {};
  if (req.method !== 'GET') return new Response('method', { status: 405, headers: HEAD });
  const key = env.ROADS_STATS_KEY ? String(env.ROADS_STATS_KEY).trim() : '';
  if (!key) return new Response('統計網址還沒設定密碼（Cloudflare Secret ROADS_STATS_KEY）', { status: 503, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, HEAD) });
  if (!authed(req, key)) return new Response('需要密碼', { status: 401, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="roads-stats", charset="UTF-8"' }, HEAD) });
  if (!env.ROADS_KV) return new Response('還沒綁定 KV（ROADS_KV）', { status: 503, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, HEAD) });
  let snap = null;
  try { snap = await env.ROADS_KV.get(SNAP_KEY, 'json'); } catch (e) {}
  if (!snap) return new Response('還沒有資料：Worker 可能還沒跑過（排程每 3 分鐘一次）', { status: 200, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, HEAD) });
  const now = Date.now();
  if (new URL(req.url).searchParams.get('format') === 'json') {
    const src = {};
    for (const k in snap.src) { const s = snap.src[k]; src[k] = { ok: s.ok, at: s.at, okAt: s.okAt, err: s.err, fails: s.fails, n: s.items ? s.items.length : 0 }; }
    return new Response(JSON.stringify({ at: snap.at, runs: snap.runs, writes: snap.w, tdxOn: snap.tdxOn, src, days: (snap.sim && snap.sim.days) || {} }), { status: 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, HEAD) });
  }
  return new Response(page(snap, now), { status: 200, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, HEAD) });
}
