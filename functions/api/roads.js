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

// ---------- 位置判斷（2026-11-22：交接_路況位置判斷與地區標籤）----------
// 警廣對沒辦法精確定位的通報會塞「預設座標」（例如台北 25.0911,121.5598 一個點就 70 筆、台1線起點在台北徐州路）。
// 同一個座標（小數 4 位）被這麼多筆不同通報共用 → 當成「位置不確定」：座標不給（App 不顯示「看路況」），也不推播。
const DEFAULT_PT_MIN = 8;
// 交通部 TDX 會轉載警廣的通報（機關代碼 A15030000H，來源寫「警廣」）：內容跟我們直接讀的警廣一樣，
// 但沒有區名、熱心聽眾變成像官方、更新時間被刷新、座標也是預設的 → 不收（2026-11-22 Welson 同意）
const PBS_AGENCY = 'A15030000H';
function isPbsCopy(x) { return String((x && x.EventID) || '').indexOf(PBS_AGENCY) === 0 || String((x && x.Source) || '').trim() === '警廣'; }
/* TOWN_NAMES_START（tools/make_town_data.mjs 產生，不要手改）*/
// 來源：內政部國土測繪中心「鄉鎮市區界線」（政府資料開放授權條款第 1 版）
const TOWN_NAMES = {
  tpe: '中山區,中正區,信義區,內湖區,北投區,南港區,士林區,大同區,大安區,文山區,松山區,萬華區',
  ntpc: '三峽區,三芝區,三重區,中和區,五股區,八里區,土城區,坪林區,平溪區,新店區,新莊區,板橋區,林口區,樹林區,永和區,汐止區,泰山區,淡水區,深坑區,烏來區,瑞芳區,石碇區,石門區,萬里區,蘆洲區,貢寮區,金山區,雙溪區,鶯歌區',
  tyc: '中壢區,八德區,大園區,大溪區,平鎮區,復興區,新屋區,桃園區,楊梅區,蘆竹區,觀音區,龍潭區,龜山區',
  kel: '七堵區,中山區,中正區,仁愛區,信義區,安樂區,暖暖區',
  ila: '三星鄉,五結鄉,冬山鄉,南澳鄉,員山鄉,壯圍鄉,大同鄉,宜蘭市,礁溪鄉,羅東鎮,蘇澳鎮,頭城鎮',
  hsz: '北區,東區,香山區,五峰鄉,北埔鄉,寶山鄉,尖石鄉,峨眉鄉,新埔鎮,新豐鄉,橫山鄉,湖口鄉,竹北市,竹東鎮,芎林鄉,關西鎮',
  mlc: '三灣鄉,三義鄉,公館鄉,卓蘭鎮,南庄鄉,大湖鄉,後龍鎮,泰安鄉,獅潭鄉,竹南鎮,苑裡鎮,苗栗市,西湖鄉,通霄鎮,造橋鄉,銅鑼鄉,頭份市,頭屋鄉',
  txg: '中區,北區,北屯區,南區,南屯區,后里區,和平區,外埔區,大安區,大甲區,大肚區,大里區,大雅區,太平區,新社區,東勢區,東區,梧棲區,沙鹿區,清水區,潭子區,烏日區,石岡區,神岡區,西區,西屯區,豐原區,霧峰區,龍井區',
  chw: '二林鎮,二水鄉,伸港鄉,北斗鎮,和美鎮,員林市,埔心鄉,埔鹽鄉,埤頭鄉,大城鄉,大村鄉,彰化市,永靖鄉,溪州鄉,溪湖鎮,田中鎮,田尾鄉,社頭鄉,福興鄉,秀水鄉,竹塘鄉,線西鄉,芬園鄉,花壇鄉,芳苑鄉,鹿港鎮',
  nto: '中寮鄉,仁愛鄉,信義鄉,南投市,名間鄉,國姓鄉,埔里鎮,水里鄉,竹山鎮,草屯鎮,集集鎮,魚池鄉,鹿谷鄉',
  yun: '二崙鄉,元長鄉,北港鎮,口湖鄉,古坑鄉,四湖鄉,土庫鎮,大埤鄉,崙背鄉,斗六市,斗南鎮,東勢鄉,林內鄉,水林鄉,臺西鄉,莿桐鄉,虎尾鎮,褒忠鄉,西螺鎮,麥寮鄉',
  cyi: '東區,西區,中埔鄉,六腳鄉,大埔鄉,大林鎮,太保市,布袋鎮,新港鄉,朴子市,東石鄉,梅山鄉,民雄鄉,水上鄉,溪口鄉,番路鄉,竹崎鄉,義竹鄉,阿里山鄉,鹿草鄉',
  tnn: '七股區,下營區,中西區,仁德區,佳里區,六甲區,北區,北門區,南化區,南區,善化區,大內區,學甲區,安南區,安定區,安平區,官田區,將軍區,山上區,左鎮區,後壁區,新化區,新市區,新營區,東區,東山區,柳營區,楠西區,歸仁區,永康區,玉井區,白河區,西港區,關廟區,鹽水區,麻豆區,龍崎區',
  khh: '三民區,仁武區,內門區,六龜區,前金區,前鎮區,大寮區,大樹區,大社區,小港區,岡山區,左營區,彌陀區,新興區,旗山區,旗津區,杉林區,林園區,桃源區,梓官區,楠梓區,橋頭區,永安區,湖內區,燕巢區,田寮區,甲仙區,美濃區,苓雅區,茂林區,茄萣區,路竹區,那瑪夏區,阿蓮區,鳥松區,鳳山區,鹽埕區,鼓山區',
  pif: '三地門鄉,九如鄉,佳冬鄉,來義鄉,內埔鄉,南州鄉,屏東市,崁頂鄉,恆春鎮,新園鄉,新埤鄉,春日鄉,東港鎮,枋寮鄉,枋山鄉,林邊鄉,泰武鄉,滿州鄉,潮州鎮,牡丹鄉,獅子鄉,琉球鄉,瑪家鄉,竹田鄉,萬丹鄉,萬巒鄉,車城鄉,里港鄉,長治鄉,霧臺鄉,高樹鄉,鹽埔鄉,麟洛鄉',
  hun: '光復鄉,卓溪鄉,吉安鄉,壽豐鄉,富里鄉,新城鄉,玉里鎮,瑞穗鄉,秀林鄉,花蓮市,萬榮鄉,豐濱鄉,鳳林鎮',
  ttt: '卑南鄉,大武鄉,太麻里鄉,延平鄉,成功鎮,東河鄉,池上鄉,海端鄉,綠島鄉,臺東市,蘭嶼鄉,達仁鄉,金峰鄉,長濱鄉,關山鎮,鹿野鄉',
  '_phc': '七美鄉,望安鄉,湖西鄉,白沙鄉,西嶼鄉,馬公市',
  '_kmn': '烈嶼鄉,烏坵鄉,金城鎮,金寧鄉,金沙鎮,金湖鎮',
  '_lcc': '北竿鄉,南竿鄉,東引鄉,莒光鄉'
};
/* TOWN_NAMES_END */
// 縣市簡稱（說明文字常這樣寫：「過桃園」「彰化出口」「台中系統」）；澎湖、金門、連江沒有路況城市，只用來認「別的縣市」
const COUNTY_WORDS = {
  tpe: ['臺北', '台北', '北市交', '北市警', '北市府'], ntpc: ['新北'], tyc: ['桃園'], kel: ['基隆'], ila: ['宜蘭'], hsz: ['新竹'], mlc: ['苗栗'],
  txg: ['臺中', '台中'], chw: ['彰化'], nto: ['南投'], yun: ['雲林'], cyi: ['嘉義'], tnn: ['臺南', '台南'], khh: ['高雄'], pif: ['屏東'],
  hun: ['花蓮'], ttt: ['臺東', '台東'], _phc: ['澎湖'], _kmn: ['金門'], _lcc: ['連江', '馬祖']
};
// 交流道、地標（不是區名的）：只用來認「是我選的城市」（收），不拿來排除
const PLACE_WORDS = {
  tpe: ['圓山', '建國高架', '堤頂', '環東', '市民大道', '水源快速', '新生高架', '洲美快速', '大直'],
  ntpc: ['安坑', '碧潭', '三鶯', '大漢', '環快'],
  tyc: ['南崁', '機場系統', '內壢', '幼獅', '高原', '大湳', '埔心', '航廈', '航站', '桃園機場']
};
// 區名後面接這些字就是路名、學校、地名，不算（中和路、復興北路、光復橋、觀音山、石門水庫、三民國中）
const NOT_PLACE = /^[東西南北中一二三四五六七八九十]{0,2}(?:路|街|巷|弄|大道|橋|里|村|國|高|山|水)/;
let townIdx = null;
// 每個縣市的區名：全台唯一才算（中山區、信義區、東區好幾個縣市都有，不算）；不帶「區鄉鎮市」的寫法（楊梅、中壢）也算，但後面接路名的不算
// → { 縣市代號: [{ w: 字, np: 要檢查後面是不是路名 }] }
function towns() {
  if (townIdx) return townIdx;
  const all = {}, stems = {};
  // 東區、中區這種方位區名常出現在單位名稱（新工處中區工務所在台北、公路局北區養護工程分局），不拿來判斷
  for (const k in TOWN_NAMES) String(TOWN_NAMES[k] || '').split(',').filter(t => t && !/^[東西南北中]區$/.test(t)).forEach(t => {
    const stem = t.length > 2 ? t.slice(0, -1) : t;
    (all[t] = all[t] || new Set()).add(k); (stems[stem] = stems[stem] || new Set()).add(k);
  });
  townIdx = {};
  for (const t in all) if (all[t].size === 1) { const k = [...all[t]][0]; (townIdx[k] = townIdx[k] || []).push({ w: t }); }
  for (const s in stems) if (stems[s].size === 1 && s.length >= 2 && !all[s]) { const k = [...stems[s]][0]; (townIdx[k] = townIdx[k] || []).push({ w: s, np: 1 }); }
  return townIdx;
}
// 「往台北」「台北方向」是方向，不是事件在台北（掃描時判斷：「往」後面 4 個字內、或地名後面 4 個字內有「方向」的不算）
const STOP = /[\s.,，。、:：()（）+＋*~～\-]/;
const placeCache = new Map();
// sel 選的城市 → 用「前兩個字」查的表：{ 兩個字的字碼: [{ w, own, np, nx }] }（一個大 regex 每筆要 7 µs，Worker CPU 不夠）
// own＝選的城市代號（別的縣市是 null）；np＝後面接路名不算；nx＝前一個字是「新」不算（「新北」不是「北市」）。
// first：第一個字有沒有可能是地名開頭（大部分的字不是，直接跳過）；memo：同一筆算過就記在這個 Symbol 欄位（不會寫進快照 JSON）
// Worker 同一台機器會重複用
function placeMap(sel) {
  const key = sel.slice().sort().join(',');
  let m = placeCache.get(key);
  if (m) return m;
  const T = towns();
  m = new Map();
  m.first = new Uint8Array(65536); m.memo = Symbol(key);
  const add = (w, own, np, nx, k) => { const h = w.charCodeAt(0) * 65536 + w.charCodeAt(1); m.first[w.charCodeAt(0)] = 1; if (!m.has(h)) m.set(h, []); m.get(h).push({ w, own: own ? k : null, np, nx }); };
  for (const k in COUNTY_WORDS) {
    const own = sel.indexOf(k) >= 0;
    COUNTY_WORDS[k].forEach(w => add(w, own, 0, k === 'tpe' ? 1 : 0, k));
    (T[k] || []).forEach(t => add(t.w, own, t.np, 0, k));
    if (own && PLACE_WORDS[k]) PLACE_WORDS[k].forEach(w => add(w, true, 0, 0, k));
  }
  placeCache.set(key, m);
  return m;
}
// 說明文字（不含地區欄：國道、省道的地區欄是路線名，例如「(台北楓港)-台１線」，不是事件在哪）＋通報單位
function placeText(e) { return (e.tx || '') + ' ' + (e.tx2 || '') + ' ' + (typeof e.so === 'string' ? e.so : (e.so || []).join(' ')); }
// 'own'：寫了選的城市（或它的區、交流道）；'other'：只寫了別的縣市；null：都沒寫。m 可以先用 placeMap(sel) 拿好
function placeOf(e, sel, m) { const v = placeScan(e, sel, m); return v && v !== 'other' ? 'own' : v; }
// 寫到的是選的哪一個城市（代號）；沒寫到選的城市 → null。給 App 標「台北·位置不確定」用
function placeCity(e, sel, m) { const v = placeScan(e, sel, m); return v && v !== 'other' ? v : null; }
function placeScan(e, sel, m) {
  m = m || placeMap(sel);
  const got = e[m.memo];
  if (got !== undefined) return got;
  return (e[m.memo] = scanPlace(placeText(e), m));
}
function scanPlace(t, m) {
  const first = m.first;
  let other = false, dir = -1;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] === '往') { dir = i + 4; continue; }   // 往台北、往三重機車道
    if (i <= dir && STOP.test(t[i])) dir = -1;
    if (!first[t.charCodeAt(i)]) continue;
    const list = m.get(t.charCodeAt(i) * 65536 + t.charCodeAt(i + 1));
    if (!list) continue;
    for (const p of list) {
      if (p.w.length > 2 && !t.startsWith(p.w, i)) continue;
      if (p.nx && t[i - 1] === '新') continue;
      if (p.np && NOT_PLACE.test(t.substr(i + p.w.length, 4))) continue;
      if (i <= dir || t.substr(i + p.w.length, 4).indexOf('方向') >= 0) continue;
      if (p.own) return p.own;   // 選的城市代號
      other = true;
    }
  }
  return other ? 'other' : null;
}
function boxHit(sel, e) { const la = e.uc ? e.qa : e.la, lo = e.uc ? e.qo : e.lo; return sel.some(k => inBox(k, la, lo)); }
// 這一筆屬不屬於選的城市：
//   地區欄有縣市（「桃園市-楊梅區」）→ 看縣市。
//   沒有（國道、省道、路名）→ 說明寫了選的城市就收、只寫了別的縣市就不收；都沒寫 → 看座標落在城市範圍內
//   （預設座標的也是看那個座標，但標「位置不確定」）。
function cityHit(e, sel, m) {
  if (e.c) return sel.indexOf(e.c) >= 0;
  const p = placeOf(e, sel, m);
  if (p) return p === 'own';
  return boxHit(sel, e);
}
// 先用便宜的條件篩（警廣每輪 1000 筆，整理文字前先丟掉明顯不要的）：有縣市看縣市；位置不確定的都要看文字；其他要落在範圍內
function prePick(sel) { return e => e.c ? sel.indexOf(e.c) >= 0 : (e.uc || boxHit(sel, e)); }
function picker(sel) { const pre = prePick(sel), m = placeMap(sel), f = e => pre(e) && cityHit(e, sel, m); f.pre = pre; return f; }
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
// 資料來源留下的測試資料（2026-11-20 紅米實測看到施工第一則「全區道路APP測試」），不給司機看
// 只認「APP／系統／平台／資料＋測試」「測試資料／測試用／測試案件」或整段以「測試」開頭，一般施工、號誌維修不受影響
const TEST_ITEM = /(APP|App|app|系統|平台|資料)\s*測試|測試\s*(資料|用|案件|事件|帳號)|^\s*測試/;
function isTestItem(ar, tx) { return TEST_ITEM.test(String(ar || '')) || TEST_ITEM.test(String(tx || '')); }
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
// 預設座標：整份警廣資料裡，同一個點（小數 4 位）有 DEFAULT_PT_MIN 筆以上不同通報
// 用原始座標字串比（預設座標每筆都一字不差；不用先轉數字，省 CPU）
function ptKey(y, x) { return y && x ? y + ',' + x : null; }
// 先只數緯度（便宜），緯度夠多的才再看經度
function defaultPoints(result) {
  const ny = new Map(), n = {}, out = {};
  result = result || [];
  for (const x of result) { const y = x.y1; if (y) ny.set(y, (ny.get(y) || 0) + 1); }
  for (const x of result) { if ((ny.get(x.y1) || 0) < DEFAULT_PT_MIN) continue; const k = ptKey(x.y1, x.x1); if (k) n[k] = (n[k] || 0) + 1; }
  for (const k in n) if (n[k] >= DEFAULT_PT_MIN) out[k] = n[k];
  return out;
}
function parsePbs(text, now, pick) {
  const d = JSON.parse(text), list = [], res = (d && d.result) || [], dflt = defaultPoints(res);
  res.forEach(x => {
    const m = twTime(x.modDttm) || twTime((x.happendate || '') + ' ' + (x.happentime || ''));
    if (!m || !x.UID) return;
    const ty = String(x.roadtype || '其他');
    if (!freshItem({ ty, m }, now)) return;
    const it = { id: 'p' + x.UID, s: 'pbs', ty, la: r5(num(x.y1)), lo: r5(num(x.x1)), m: m, c: cityOfName(x.areaNm) };
    // 位置不確定：座標不給 App（qa／qo 只給篩選看範圍，回給 App 前拿掉）
    if (dflt[ptKey(x.y1, x.x1)]) { it.uc = 1; it.qa = it.la; it.qo = it.lo; it.la = it.lo = null; }
    if (pick && pick.pre && !pick.pre(it)) return;
    // 沒有縣市的先用原始文字判斷要不要（認地名不需要整理過的文字），不要的就不用整理
    if (pick && !it.c) { it.tx = String(x.comment || ''); it.so = String(x.srcdetail || ''); if (!pick(it)) return; }
    it.ar = cleanText(x.areaNm).slice(0, 60); it.tx = cleanText(x.comment); it.so = cleanText(x.srcdetail).slice(0, 40); it.di = cleanText(x.direction).slice(0, 10);
    if (isTestItem(it.ar, it.tx)) return;
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
    if (!m || !x.EventID || isPbsCopy(x)) return;
    const ll = lonLat(x.Positions);
    const imp = x.Impact || {}, dur = imp.Duration && [].concat(imp.Duration)[0];
    const end = isoTime(x.ExpireTime) || (dur && isoTime(dur.DurationEndTime)) || null;
    let ty = TDX_TYPE[x.EventType] || '其他';
    if (x.EventSubType === 805) ty = '號誌故障';
    if (!freshItem({ ty, m, end }, now)) return;
    const c = cityKey || tdxCity(x.Location);
    const it = { c, la: r5(ll[0]), lo: r5(ll[1]) };
    if (pick && pick.pre && !pick.pre(it)) return;
    // TDX 的說明有時夾著系統內部編號（例如「事故-17951081390001654222000112124」），12 位以上的純數字對司機沒用，拿掉
    it.tx = cleanText([x.EventTitle, x.Description].filter((v, i, a) => v && a.indexOf(v) === i).join(' ').replace(/[-_#:：]?\d{12,}/g, ''));
    it.so = cleanText(x.Source).slice(0, 40);
    if (pick && !pick(it)) return;
    const ar = cleanText(tdxArea(x.Location)).slice(0, 60);
    if (isTestItem(ar, it.tx)) return;
    list.push({ id: 't' + x.EventID, s: 'tdx', ty, st: x.EventSubType || null, ar, tx: it.tx, la: it.la, lo: it.lo, m, so: it.so, c, end: end });
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
    // 位置不確定的沒有座標（距離算不出來），不會跟別筆合併
    if (!hit) { out.push({ id: it.id, ids: [it.id], ty: it.ty, st: it.st || null, ar: it.ar || '', tx: it.tx || '', tx2: '', la: it.la, lo: it.lo, m: it.m, srcs: [it.s], so: [it.so || ''].filter(Boolean), c: it.c || null, di: it.di || '', uc: it.uc ? 1 : 0, qa: it.qa, qo: it.qo }); return; }
    hit.ids.push(it.id); hit.srcs.push(it.s);
    if (!hit.c && it.c) hit.c = it.c;
    if (!hit.di && it.di) hit.di = it.di;
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
  uc: '位置不確定（警廣預設座標，不推）',
  neg: '有「解除、未、預計、明日、今晚、預告」等字眼',
  aux: '只有火災、翻覆、多車等字，沒有寫到影響行車',
  workClose: '施工封路（列重大候選，不推）',
  tenMin: '10 分鐘內已推過一批（只更新摘要）',
  dayCap: '今天已滿 5 批（只更新摘要）'
};

function newDay() {
  return { runs: 0, fails: { pbs: 0, tdx: 0 }, batches: 0, events: 0, hours: new Array(24).fill(0), cand: [], peak: { n: 0, at: 0 },
    why: { baseline: 0, stale: 0, listener: 0, uc: 0, neg: 0, aux: 0, workClose: 0, tenMin: 0, dayCap: 0 }, dups: 0, cleared: 0, cleared60: 0, samples: [], negs: [] };
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
    day.why[why] = (day.why[why] || 0) + 1;   // 新加的原因（例如 uc）在升級當天的舊統計裡還沒有這一格
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
    // 位置不確定（警廣預設座標、說明裡也沒寫在哪個縣市以外）：清單照列，推播只推位置可信的
    if (e.uc && !e.c) return once(ids, 'uc', e);
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
  // push：這一輪「新變成重大、而且新鮮」的事件（還沒套虛擬司機的 10 分鐘、每天 5 批）；真推播（push.js）對每位司機各自再套一次
  return { state, day, cands: cands.length, push: cands.map(c => c.e) };
}

// ===== 抓一輪雙北＋寫快照＋只記錄不推播（relay/lib/refresh.js）=====
// 兩個地方會跑這一輪：
//   1. 排程（每 3 分鐘）：paoche-roads-cron 叫 paoche-roads-worker（指定在台灣機房跑）去抓。
//   2. 備援：有司機打開 App、快照裡的警廣超過 5 分鐘沒更新時，網站中繼順便跑一輪（網站一定在司機附近的機房）。
// KV 寫入：每輪只寫 1 次快照＋TDX Token 約每天 1 次；同一天寫到 900 次就停寫（免費上限 1,000）。

const WRITE_CAP = 900;
const SLACK = 30 * 1000;          // 排程時間會有幾秒誤差，提早 30 秒也算到期
const TOKEN_RETRY = 30 * MIN;     // 要 Token 失敗後 30 分鐘內不再向 TDX 要（被擋 429 時越要越擋）；這段時間每輪仍會看 KV 有沒有網站分享的
const APP_REFRESH_AFTER = 5 * MIN;   // 快照裡警廣超過這麼久沒成功 → 有人打開 App 時網站補抓
const APP_REFRESH_GAP = 3 * MIN;     // 網站補抓之間至少隔這麼久

async function snapTdxToken(env, now, force, cnt, snap) {
  if (!force) { const tk = await readToken(env.ROADS_KV, now); if (tk && tk !== snap.badTk) return tk; }
  if (snap.tkFail && now - snap.tkFail.at < TOKEN_RETRY) throw new Error(snap.tkFail.err + ' wait');
  let tk;
  try { tk = await fetchTdxToken(env); } catch (e) { snap.tkFail = { at: now, err: errText(e) }; throw e; }
  snap.tkFail = null;
  if (cnt.ok()) await saveToken(env.ROADS_KV, tk, now);
  return tk;
}

// opts：by＝'cron' 或 'app'；colo＝在哪個機房跑（只是記下來看）；pbsWait＝警廣等幾毫秒；
//       load＝{ pbs(), tdx(ep, cityKey) } 換掉預設的抓法（網站用它已經抓好、快取著的資料，不重抓）
async function runOnce(env, now, opts) {
  opts = opts || {};
  const kv = env.ROADS_KV;
  if (!kv) throw new Error('no ROADS_KV');
  let snap = null;
  try { snap = await kv.get(SNAP_KEY, 'json'); } catch (e) {}
  if (!snap || snap.v !== 1) snap = { v: 1, at: 0, runs: 0, src: {}, sim: {}, w: { day: '', n: 0 } };
  const today = twDay(now);
  if (snap.w.day !== today) snap.w = { day: today, n: 0 };
  const cnt = { ok: () => snap.w.n < WRITE_CAP && ++snap.w.n > 0 };
  const pick = picker(SNAP_CITIES);

  // 這輪要抓哪些
  const tdxOn = !!(env.TDX_CLIENT_ID && env.TDX_CLIENT_SECRET);
  const want = { pbs: [FAST, null] };
  if (tdxOn) Object.assign(want, tdxWant(SNAP_CITIES));
  for (const k in snap.src) if (!want[k]) delete snap.src[k];   // 拿掉金鑰後，舊的 TDX 資料不再留
  const due = Object.keys(want).filter(k => { const s = snap.src[k]; return !s || !s.ok || !s.okAt || now - s.okAt >= want[k][0] * 1000 - SLACK; });

  // 恢復判斷要看抓之前的狀態
  const downLong = {};
  due.forEach(k => { const s = snap.src[k]; downLong[k] = !!(s && s.okAt && now - s.okAt > 15 * MIN && !s.ok); });

  // 幾個網址同時要 Token：只取一次；過期（401）時也只重取一次
  let tkP = null, forced = null;
  const token = force => force ? (forced || (forced = tkP = snapTdxToken(env, now, true, cnt, snap))) : (tkP || (tkP = snapTdxToken(env, now, false, cnt, snap)));
  const load = opts.load || {
    pbs: async () => parsePbs(await fetchPbs(opts.pbsWait), now, pick),
    tdx: async (k, cityKey) => {
      const tk0 = await token(false);
      let r = await fetchTdxRaw(k, tk0);
      if (r.status === 401) { snap.badTk = tk0; r = await fetchTdxRaw(k, await token(true)); }   // Token 過期：重取一次
      if (!r.json) throw new Error('tdx ' + r.status);
      return parseTdx(r.json, cityKey, now, pick);
    }
  };
  const results = await Promise.all(due.map(async k => {
    try {
      const items = k === 'pbs' ? await load.pbs() : await load.tdx(k, want[k][1]);
      return { k, items: items.filter(pick) };
    } catch (e) { return { k, err: errText(e) }; }
  }));

  const fresh = {}, base = {};
  results.forEach(r => {
    const old = snap.src[r.k] || {};
    if (r.err) { snap.src[r.k] = { ok: false, at: now, okAt: old.okAt || null, err: r.err, fails: (old.fails || 0) + 1, items: old.items || [], by: opts.by || null }; return; }
    snap.src[r.k] = { ok: true, at: now, okAt: now, err: null, fails: 0, items: r.items, by: opts.by || null };
    fresh[r.k] = true;
    if (!old.okAt || downLong[r.k]) base[r.k === 'pbs' ? 'pbs' : 'tdx'] = true;
  });

  // 只記錄不推播：只用「這輪抓到的」和「還在有效期內」的來源，不從失敗來源的舊資料產生新提醒
  let items = [];
  for (const k in snap.src) {
    const s = snap.src[k];
    if (s.ok && (fresh[k] || now - s.okAt < want[k][0] * 1000 + 10 * MIN)) items = items.concat(s.items);
  }
  const r = simulate(snap.sim, mergeSources(items), now, { pbs: !!base.pbs, tdx: !!base.tdx });
  snap.sim = r.state;
  // 真推播（乙批）：只有綁了 D1 的那支（paoche-roads-worker）會推；網站的備援輪沒有 push.js，也沒綁 D1，不推。
  // 推播出錯絕不影響快照
  if (env.PUSH_DB && typeof pushRound === 'function') {
    try { snap.push = await pushRound(env, r.push, now, snap.push); } catch (e) { snap.push = snap.push || null; if (snap.push && snap.push.days && snap.push.days[today]) snap.push.days[today].err = errText(e); }
  }
  results.forEach(x => { if (x.err) r.day.fails[x.k === 'pbs' ? 'pbs' : 'tdx']++; });
  const by = opts.by === 'app' ? 'app' : 'cron';
  r.day.by = r.day.by || { cron: 0, app: 0 };
  r.day.by[by]++;

  snap.at = now; snap.runs++; snap.tdxOn = tdxOn;
  snap.last = { by, colo: opts.colo ? String(opts.colo).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : null, at: now };
  if (by === 'app') snap.pg = now;
  if (!cnt.ok()) return { wrote: false, due, snap };
  await kv.put(SNAP_KEY, JSON.stringify(snap));
  return { wrote: true, due, snap };
}

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
// Token 先看 KV 裡有沒有（排程 Worker 或別台中繼拿過的），沒有才向 TDX 要，要到也放進 KV 給大家用
let badTk = null, shared = false;
async function tdxToken(env) {
  const v = await cached('tdx-token', TOKEN_TTL, async () => {
    const now = Date.now(), kvTk = await readToken(env.ROADS_KV, now);
    if (kvTk && kvTk !== badTk) return { ok: true, at: now, tk: kvTk };
    const tk = await fetchTdxToken(env);
    await saveToken(env.ROADS_KV, tk, now);
    return { ok: true, at: now, tk };
  });
  if (!(v && v.ok)) throw new Error((v && v.err) || 'token');   // 把真正原因（例如 token 401）往上傳
  // 手上這張是快取裡的（KV 還沒有）→ 分享進 KV 給排程用（2026-11-20：排程一直要 Token 被 TDX 擋 429）
  if (!shared && env.ROADS_KV && v.tk !== badTk && Date.now() - v.at < TOKEN_TTL * 1000) {
    shared = true;
    if (!(await readToken(env.ROADS_KV, Date.now()))) await saveToken(env.ROADS_KV, v.tk, v.at);
  }
  return v.tk;
}
async function loadTdx(ep, env, cityKey) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tk = await tdxToken(env), r = await fetchTdxRaw(ep, tk);
    if (r.status === 401 && attempt === 0) { badTk = tk; await forget('tdx-token'); continue; }
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
async function readSnapRaw(env) {
  if (!env.ROADS_KV) return null;
  try { const s = await env.ROADS_KV.get(SNAP_KEY, { type: 'json', cacheTtl: 60 }); return s && s.v === 1 ? s : null; } catch (e) { return null; }
}
function usableSnap(s, now) { return s && s.at && now - s.at <= SNAP_MAX_AGE ? s : null; }   // Worker 停了 → 自己抓

// ---------- 備援：有人打開 App、快照裡的警廣太久沒更新 → 順便跑一輪寫快照（用剛剛抓好、快取著的資料，不重抓）----------
let refreshing = false;
function needRefresh(raw, now) {
  if (!raw) return true;
  const pbsAt = (raw.src && raw.src.pbs && raw.src.pbs.okAt) || 0;
  return now - pbsAt > APP_REFRESH_AFTER && now - (raw.pg || 0) > APP_REFRESH_GAP;
}
function pagesLoad(env) {
  const want = tdxWant(SNAP_CITIES);
  const use = g => { if (!(g && g.ok)) throw new Error((g && g.err) || 'fail'); return g.items; };
  return {
    pbs: async () => use(await cached('pbs', FAST, loadPbs)),
    tdx: async (ep, cityKey) => use(await cached('tdx:' + ep, want[ep][0], () => loadTdx(ep, env, cityKey)))
  };
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
  const raw = inSnap.length ? await readSnapRaw(env) : null;
  let snap = usableSnap(raw, now), fs = null;
  // 快照裡警廣沒有可用的資料、或 TDX 開著卻一個都沒有 → 這次雙北也自己抓（App 不會因為 Worker 抓不到而空白）
  if (snap) { fs = fromSnap(snap, inSnap, now); if (!fs.pbs.ok || (fs.tdxOn && !fs.tdx.some(g => g.ok))) { snap = null; fs = null; } }
  const parts = [];
  if (fs) parts.push(fs);
  const liveSel = snap ? others : sel;
  if (liveSel.length) parts.push(await live(liveSel, env));
  if (inSnap.length && env.ROADS_KV && !refreshing && needRefresh(raw, now) && context.waitUntil) {
    refreshing = true;
    const job = runOnce(env, now, { by: 'app', colo: req.cf && req.cf.colo, load: pagesLoad(env) }).catch(() => {}).then(() => { refreshing = false; });
    context.waitUntil(job);
  }

  // 合併：同一筆（例如國道在台北和桃園的範圍都有）只留一筆
  const byId = {};
  parts.forEach(p => p.items.forEach(it => { if (!byId[it.id] || byId[it.id].m < it.m) byId[it.id] = it; }));
  // c（縣市代號）留給 App 標地區；qa／qo 是預設座標，只給篩選用，不給 App（App 只看 uc＝位置不確定）
  // pc：沒有縣市名的，說明或通報單位寫到的是選的哪個城市（App 標「台北·位置不確定」、不會被它用座標當成別的縣市藏掉）
  const items = Object.keys(byId).map(k => {
    const o = Object.assign({}, byId[k]);
    delete o.qa; delete o.qo;
    if (!o.c) { delete o.c; const pc = placeCity(o, sel); if (pc) o.pc = pc; }
    return o;
  });
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
