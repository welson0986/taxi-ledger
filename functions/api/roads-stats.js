// ⚠️ 這個檔案是 `node relay/build.mjs` 自動產生的，不要直接改。
// 要改請改 App 倉庫 relay/src/pages_roads_stats.js 與 relay/lib/，再重新產生。

// 跑車人生 路況提醒「只記錄不推播」統計頁（Cloudflare Pages Functions）
// 網址：https://app.realway.com.tw/api/roads-stats（只給 Welson 看）
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

// 2026-11-24 起：排程 Worker 每 3 分鐘抓全國，依縣市分桶，分「北中南東」四區存進 KV（方案丙，Cloudflare 付費方案）。
//   roads:state:v2      Worker 與統計頁用：各來源健康與全國資料、模擬推播、推播、KV 寫入次數、TDX 點數。網站中繼不讀。
//   roads:reg:{N,C,S,E}:v2  網站中繼用：那一區縣市的資料（每個來源一段，含最後成功時間）。
// 舊的 roads:snap:v1（只有雙北）在切換觀察期間照寫，給還沒換新版的網站中繼用；觀察 24 小時後再決定要不要停寫、刪掉。
const SNAP_KEY = 'roads:snap:v1';
const STATE_KEY = 'roads:state:v2';
const REG_KEY = r => 'roads:reg:' + r + ':v2';
const TOKEN_KEY = 'roads:tdx-token';
// 模擬推播與真推播只有雙北（本案不擴大推播範圍）
const SNAP_CITIES = ['tpe', 'ntpc'];
const REGIONS = { N: ['tpe', 'ntpc', 'tyc', 'kel', 'ila', 'hsz', 'mlc'], C: ['txg', 'chw', 'nto', 'yun'], S: ['cyi', 'tnn', 'khh', 'pif'], E: ['hun', 'ttt'] };
const REGION_OF = {};
for (const r in REGIONS) REGIONS[r].forEach(k => { REGION_OF[k] = r; });

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
  yun:  { names: ['雲林縣'], box: [23.44, 23.87, 120.00, 120.75], tdx: [] },   // 11/24 照鄉鎮界線放大（原本 10% 面積在框外）
  cyi:  { names: ['嘉義市', '嘉義縣'], box: [23.20, 23.65, 120.10, 120.90], tdx: [['City/ChiayiCounty', SLOW], ['City/Chiayi', SLOW]] },
  tnn:  { names: ['臺南市', '台南市'], box: [22.88, 23.42, 120.03, 120.66], tdx: [['City/Tainan', FAST]] },
  khh:  { names: ['高雄市'], box: [22.47, 23.47, 120.17, 121.05], tdx: [['City/Kaohsiung', FAST]] },
  pif:  { names: ['屏東縣'], box: [21.89, 22.89, 120.40, 120.92], tdx: [['City/PingtungCounty', FAST]] },
  hun:  { names: ['花蓮縣'], box: [23.10, 24.38, 121.00, 121.78], tdx: [] },   // 11/24 放大（原本 25%：秀林、卓溪、萬榮西邊山區在框外）
  ttt:  { names: ['臺東縣', '台東縣'], box: [22.00, 23.45, 120.74, 121.60], tdx: [] }   // 11/24 放大（原本 3%：蘭嶼、南端）
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
// 2026-11-24 中南東交流道、地標別名：只放全台確定唯一的，跟區名一樣「收也拿來排除」（寫「高科」的國1 通報不會出現在基隆、新北）
const ALIAS_WORDS = {
  khh: ['高科', '鼎金', '五甲', '路科'], tnn: ['大灣', '烏山頭'], chw: ['快官', '漢寶'], nto: ['霧社', '日月潭', '清境'],
  pif: ['墾丁', '楓港', '大鵬灣'], ttt: ['知本'], hun: ['太魯閣', '七星潭']
};
// 這幾個區名（去掉「區鄉鎮」的寫法）別處也常用（新北石門 vs 花蓮台11線石門、台東成功 vs 彰化「成功至快官」、高雄橋頭 vs 一般「橋頭」、
// 嘉義新港 vs 苗栗台72線「新港路段」）→ 跟 PLACE_WORDS 一樣只用來收、不拿來排除
const WEAK_STEMS = ['石門', '成功', '橋頭', '新港'];
// 地名出現在這些字裡面不算（11/24 中南部驗證找到的誤認）：國3「中寮隧道」在高雄、台20「梅山口」在高雄、台61「大安平面」、科技執法、太魯閣號列車
const NOT_PLACE_IN = ['中寮隧道', '梅山口', '大安平面', '高科技', '太魯閣號'];
// 地名前一個字是這些就不算：「台28線西向」不是彰化線西
const NOT_AFTER = { '線西': /[0-9０-９甲乙丙]/ };
// 區名後面接這些字就是路名、學校、地名，不算（中和路、復興北路、光復橋、觀音山、石門水庫、三民國中）
// 「路段」不是路名（「北上路竹路段」是路竹那一段，11/24 修正）
const NOT_PLACE = /^[東西南北中一二三四五六七八九十]{0,2}(?:路(?!段)|街|巷|弄|大道|橋|里|村|國|高|山|水)/;
let townIdx = null;
// 每個縣市的區名：全台唯一才算（中山區、信義區、東區好幾個縣市都有，不算）；不帶「區鄉鎮市」的寫法（楊梅、中壢）也算，但後面接路名的不算
// → { 縣市代號: [{ w: 字, np: 要檢查後面是不是路名, weak: 只收不排除 }] }
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
  for (const s in stems) if (stems[s].size === 1 && s.length >= 2 && !all[s]) { const k = [...stems[s]][0]; (townIdx[k] = townIdx[k] || []).push(WEAK_STEMS.indexOf(s) >= 0 ? { w: s, np: 1, weak: 1 } : { w: s, np: 1 }); }
  return townIdx;
}
// 「往台北」「台北方向」是方向，不是事件在台北（掃描時判斷：「往」後面 4 個字內、或地名後面 4 個字內有「方向」的不算）
const STOP = /[\s.,，。、:：()（）+＋*~～\-]/;
// 一個字的所有「不算」例外：[整串, 地名在整串裡的位置]
function notIn(w) {
  const out = [];
  NOT_PLACE_IN.forEach(s => { const o = s.indexOf(w); if (o >= 0) out.push([s, o]); });
  return out.length ? out : null;
}
// 查表用的一筆：w 字、k 縣市、np 後面接路名不算、nx 前一個字是「新」不算（「新北」不是「北市」）、weak 只收不排除、ex 例外、pa 前一個字
function wordEntry(w, k, np, nx, weak) { return { w, k, np, nx, weak, ex: notIn(w), pa: NOT_AFTER[w] || null }; }
// 「t 的第 i 個字開始是 p.w」而且算數（scanPlace 與 scanAll 共用，規則只寫一次）
function wordAt(t, i, p, dir) {
  if (p.w.length > 2 && !t.startsWith(p.w, i)) return false;
  if (p.nx && t[i - 1] === '新') return false;
  if (p.pa && i > 0 && p.pa.test(t[i - 1])) return false;
  if (p.ex) for (const [s, o] of p.ex) if (i >= o && t.startsWith(s, i - o)) return false;
  if (p.np && NOT_PLACE.test(t.substr(i + p.w.length, 4))) return false;
  if (i <= dir || t.substr(i + p.w.length, 4).indexOf('方向') >= 0) return false;
  return true;
}
// 每個縣市要認的字（weak＝只收不排除，其他＝收也排除）
function wordsOf(k) {
  const T = towns(), out = [];
  COUNTY_WORDS[k].forEach(w => out.push(wordEntry(w, k, 0, k === 'tpe' ? 1 : 0, 0)));
  (T[k] || []).forEach(t => out.push(wordEntry(t.w, k, t.np || 0, 0, t.weak || 0)));
  (ALIAS_WORDS[k] || []).forEach(w => out.push(wordEntry(w, k, 0, 0, 0)));
  (PLACE_WORDS[k] || []).forEach(w => out.push(wordEntry(w, k, 0, 0, 1)));
  return out;
}
function addWord(m, p, extra) { const h = p.w.charCodeAt(0) * 65536 + p.w.charCodeAt(1); m.first[p.w.charCodeAt(0)] = 1; if (!m.has(h)) m.set(h, []); m.get(h).push(Object.assign({}, p, extra)); }
const placeCache = new Map();
// sel 選的城市 → 用「前兩個字」查的表：{ 兩個字的字碼: [{ w, own, … }] }（一個大 regex 每筆要 7 µs，Worker CPU 不夠）
// own＝選的城市代號（別的縣市是 null）。只收不排除的字（weak）只有選的城市才放。
// first：第一個字有沒有可能是地名開頭（大部分的字不是，直接跳過）；memo：同一筆算過就記在這個 Symbol 欄位（不會寫進快照 JSON）
// Worker 同一台機器會重複用
function placeMap(sel) {
  const key = sel.slice().sort().join(',');
  let m = placeCache.get(key);
  if (m) return m;
  m = new Map();
  m.first = new Uint8Array(65536); m.memo = Symbol(key);
  for (const k in COUNTY_WORDS) {
    const own = sel.indexOf(k) >= 0;
    wordsOf(k).forEach(p => { if (own || !p.weak) addWord(m, p, { own: own ? k : null }); });
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
      if (!wordAt(t, i, p, dir)) continue;
      if (p.own) return p.own;   // 選的城市代號
      other = true;
    }
  }
  return other ? 'other' : null;
}
// 警廣的預設座標如果整點落在別的縣市框裡，用這張表指定它其實是哪個縣市（11/24：台中市區通報的預設點在彰化框裡）
// 用原始座標字串（y1,x1）比
const DEFAULT_PT_CITY = { '24.2,120.52': 'txg' };
// 篩選用的座標：位置不確定的用預設座標（qa／qo），預設點有指定縣市（qc）的只算那個縣市
function boxOf(k, e) { return e.uc ? (e.qc ? e.qc === k : inBox(k, e.qa, e.qo)) : inBox(k, e.la, e.lo); }
function boxHit(sel, e) { return sel.some(k => boxOf(k, e)); }
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

// ---------- 全國一次分桶（2026-11-24）----------
// 結果跟「每個縣市各跑一次 picker([k])」完全一樣（測試逐筆比對），但說明文字只掃一次：
// 掃的時候記下寫到哪些縣市（會排除的、只收的分開記），再對 17 個縣市一次判斷。
const CITY_KEYS = Object.keys(CITIES);
const CBIT = {}; Object.keys(COUNTY_WORDS).forEach((k, i) => { CBIT[k] = 1 << i; });   // 17 縣市＋澎金馬（別的縣市也要認）
let allWords = null;
function allPlaceMap() {
  if (allWords) return allWords;
  const m = new Map(); m.first = new Uint8Array(65536);
  for (const k in COUNTY_WORDS) wordsOf(k).forEach(p => addWord(m, p, { b: CBIT[k] }));
  return (allWords = m);
}
function scanAll(t) {
  const m = allPlaceMap(), first = m.first;
  let dir = -1, strong = 0, weak = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] === '往') { dir = i + 4; continue; }
    if (i <= dir && STOP.test(t[i])) dir = -1;
    if (!first[t.charCodeAt(i)]) continue;
    const list = m.get(t.charCodeAt(i) * 65536 + t.charCodeAt(i + 1));
    if (!list) continue;
    for (const p of list) if (wordAt(t, i, p, dir)) { if (p.weak) weak |= p.b; else strong |= p.b; }
  }
  return [strong, weak];
}
// 這一筆屬於哪些縣市（代號清單，可能 0 個、1 個或好幾個）
function cityList(e) {
  if (e.c) return CITIES[e.c] ? [e.c] : [];
  let boxes = 0;
  for (const k of CITY_KEYS) if (boxOf(k, e)) boxes |= CBIT[k];
  if (!boxes && !e.uc) return [];
  const sw = scanAll(placeText(e)), strong = sw[0], weak = sw[1], out = [];
  for (const k of CITY_KEYS) {
    const b = CBIT[k];
    if (!e.uc && !(boxes & b)) continue;              // 跟 prePick 一樣：不是位置不確定的，要先落在範圍內
    if ((strong | weak) & b) out.push(k);              // 寫到這個縣市
    else if (!strong && (boxes & b)) out.push(k);      // 沒寫到任何會排除的縣市 → 看座標
  }
  return out;
}
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
// 警廣的「停車場滿場通報」（11/24 紅米實測看到「長安國小地下停車場.已滿場」）：給開自用車找車位的人看的，不是路況，不給司機看
const PARKING_FULL = /停車場.{0,30}(已|將)?滿(場|位)/;
function isParkingFull(so, tx) { return /停車場滿場/.test(String(so || '')) || PARKING_FULL.test(String(tx || '')); }
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
// pick＝'all'：全國都整理，每筆加上 cs（屬於哪些縣市），一個縣市都不屬於的不留（排程 Worker 用）
// mile（排程 Worker 才給，relay/lib/freeway.js milePoint）：國道通報有寫「在 N 公里」就照里程放位置，蓋掉警廣的點（11/24）
function parsePbs(text, now, pick, mile) {
  const d = JSON.parse(text), list = [], res = (d && d.result) || [], dflt = defaultPoints(res), all = pick === 'all';
  res.forEach(x => {
    const m = twTime(x.modDttm) || twTime((x.happendate || '') + ' ' + (x.happentime || ''));
    if (!m || !x.UID) return;
    const ty = String(x.roadtype || '其他');
    if (!freshItem({ ty, m }, now)) return;
    const it = { id: 'p' + x.UID, s: 'pbs', ty, la: r5(num(x.y1)), lo: r5(num(x.x1)), m: m, c: cityOfName(x.areaNm) };
    // 位置不確定：座標不給 App（qa／qo 只給篩選看範圍，回給 App 前拿掉）
    if (dflt[ptKey(x.y1, x.x1)]) { it.uc = 1; it.qa = it.la; it.qo = it.lo; it.la = it.lo = null; const qc = DEFAULT_PT_CITY[ptKey(x.y1, x.x1)]; if (qc) it.qc = qc; }
    if (mile && !it.c && String(x.areaNm || '').indexOf('國道') >= 0) {
      const p = mile(x.areaNm, x.direction, x.comment);
      if (p) { it.la = p[0]; it.lo = p[1]; it.mk = 1; delete it.uc; delete it.qa; delete it.qo; delete it.qc; }
    }
    if (all) {
      // 全國：沒有縣市的先用原始文字分桶，一個縣市都不屬於就不用整理；整理後再分一次，兩次都有的才算（跟以前「Worker 用原始文字、網站用整理過的文字」各篩一次一樣）
      let cs0 = null;
      if (!it.c) { it.tx = String(x.comment || ''); it.so = String(x.srcdetail || ''); cs0 = cityList(it); if (!cs0.length) return; }
      it.ar = cleanText(x.areaNm).slice(0, 60); it.tx = cleanText(x.comment); it.so = cleanText(x.srcdetail).slice(0, 40); it.di = cleanText(x.direction).slice(0, 10);
      if (isTestItem(it.ar, it.tx) || isParkingFull(it.so, it.tx)) return;
      it.cs = cs0 ? cityList(it).filter(k => cs0.indexOf(k) >= 0) : cityList(it);
      if (it.cs.length) list.push(it);
      return;
    }
    if (pick && pick.pre && !pick.pre(it)) return;
    // 沒有縣市的先用原始文字判斷要不要（認地名不需要整理過的文字），不要的就不用整理
    if (pick && !it.c) { it.tx = String(x.comment || ''); it.so = String(x.srcdetail || ''); if (!pick(it)) return; }
    it.ar = cleanText(x.areaNm).slice(0, 60); it.tx = cleanText(x.comment); it.so = cleanText(x.srcdetail).slice(0, 40); it.di = cleanText(x.direction).slice(0, 10);
    if (isTestItem(it.ar, it.tx) || isParkingFull(it.so, it.tx)) return;
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
// 回 { status, json, calls, bytes }；400 時改取全部欄位（欄位名稱不被接受時）
// calls／bytes 給 TDX 點數估算用（bytes 是解壓後的大小，比 TDX 實際計的只多不少）
async function fetchTdxRaw(ep, tk) {
  const head = { 'Authorization': 'Bearer ' + tk, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' };
  let calls = 1;
  let res = await get(TDX_BASE + ep + '?%24select=' + encodeURIComponent(TDX_SELECT) + '&%24format=JSON', { headers: head });
  if (res.status === 400) { calls++; res = await get(TDX_BASE + ep + '?%24format=JSON', { headers: head }); }
  if (!res.ok) return { status: res.status, json: null, calls, bytes: 0 };
  const buf = await res.arrayBuffer();
  return { status: res.status, json: JSON.parse(new TextDecoder().decode(buf)), calls, bytes: buf.byteLength };
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
// 每筆加上 cs（屬於哪些縣市），一個縣市都不屬於的不留（TDX 全國分桶用）
function withCities(list) { return list.filter(it => (it.cs = cityList(it)).length > 0); }
// 要問哪些 TDX 網址：{ 'City/Taipei': [多久一次, 城市代號或 null], ... }
function tdxWant(sel) {
  const want = {};
  sel.forEach(k => CITIES[k].tdx.forEach(e => { want[e[0]] = [e[1], k]; }));
  TDX_ROADS.forEach(e => { want[e[0]] = [e[1], null]; });
  return want;
}

// ---------- TDX 點數（銅級每月 200 點；預算預設 120 點；Worker 與統計頁共用）----------
// 點數＝呼叫次數 ÷ 1,500 ＋ 資料量(MB) ÷ 150（11/23 對過會員中心的數字）
const TDX_BUDGET_DEFAULT = 120;
function tdxPoints(u) { return u ? u.calls / 1500 + u.bytes / 1e6 / 150 : 0; }
function tdxBudget(env) { const b = parseFloat(env && env.TDX_BUDGET); return b > 0 ? b : TDX_BUDGET_DEFAULT; }
// 'off'＝手動停用（Cloudflare 變數 TDX_OFF=1）；'pause'＝本月已用 95%，暫停 TDX 只抓警廣；'slow'＝已用 85%，每 3 分鐘的改成每小時
function tdxMode(env, u) {
  if (String((env && env.TDX_OFF) || '').trim() === '1') return 'off';
  const pts = tdxPoints(u), b = tdxBudget(env);
  if (pts >= 0.95 * b) return 'pause';
  if (pts >= 0.85 * b) return 'slow';
  return 'normal';
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
const SRC_NAMES = { pbs: '警廣', Freeway: 'TDX 國道', Highway: 'TDX 省道', token: 'TDX 要 Token' };
for (const k in CITIES) CITIES[k].tdx.forEach(e => { SRC_NAMES[e[0]] = 'TDX ' + (e[0] === 'City/ChiayiCounty' ? '嘉義縣' : e[0] === 'City/Chiayi' ? '嘉義市' : CITIES[k].names[0]); });
const CITY_NAMES = {}; for (const k in CITIES) CITY_NAMES[k] = CITIES[k].names[0].replace(/^臺/, '台').replace(/[市縣]$/, '');
const MODE_NAMES = { normal: '<span class="ok">正常</span>', slow: '<span class="bad">降頻（本月已用 85%：每 3 分鐘的改成每小時）</span>', pause: '<span class="bad">暫停（本月已用 95%：只抓警廣）</span>', off: '<span class="bad">手動停用（Cloudflare 變數 TDX_OFF=1）</span>', nokey: '<span class="bad">Worker 沒有設定 TDX 金鑰，只抓警廣</span>' };
const kb = b => Math.round((b || 0) / 1024).toLocaleString('en-US') + ' KB';
const pt = u => tdxPoints(u).toFixed(1);
// TDX 點數：今天、本月、上個月；各來源呼叫數與資料量
function tdxHtml(snap) {
  const u = snap.tdx;
  if (!u) return '';
  const b = snap.budget || tdxBudget({}), used = tdxPoints(u);
  let h = '<h2>TDX 點數（估算）</h2><p>模式：' + (MODE_NAMES[snap.mode] || '—') + '<br>本月（' + esc(u.mon) + '）：<b>' + pt(u) + ' 點</b> ／ 預算 ' + b + ' 點（' + Math.round(used / b * 100) + '%）' +
    '　呼叫 ' + u.calls.toLocaleString('en-US') + ' 次、' + kb(u.bytes) + '<br>今天：' + pt(u.day) + ' 點（呼叫 ' + u.day.calls + ' 次、' + kb(u.day.bytes) + '）' +
    (u.prev ? '<br>上個月（' + esc(u.prev.mon) + '）：' + pt(u.prev) + ' 點' : '') + '</p>';
  h += '<table><tr><th>來源</th><th>本月呼叫</th><th>本月資料量</th><th>平均每次</th><th>本月點數</th></tr>';
  Object.keys(u.ep).sort((x, y) => tdxPoints(u.ep[y]) - tdxPoints(u.ep[x])).forEach(k => {
    const e = u.ep[k];
    h += '<tr><td>' + esc(SRC_NAMES[k] || k) + '</td><td>' + e.calls.toLocaleString('en-US') + '</td><td>' + kb(e.bytes) + '</td><td>' + (e.calls ? kb(e.bytes / e.calls) : '—') + '</td><td>' + pt(e) + '</td></tr>';
  });
  h += '</table><p class="muted">點數＝呼叫次數÷1,500＋資料量(MB)÷150。資料量用解壓後的大小，只會比 TDX 實際計的多。每月仍要對照 TDX 會員中心的實際用量。' +
    '收到 TDX「已使用 80%」的信：先看上表哪個來源用最多，再到 Cloudflare 後台 paoche-roads-worker 設變數 TDX_OFF=1（停用）或調 TDX_BUDGET。</p>';
  return h;
}
// 各縣市筆數（全國資料依縣市分桶的結果；國道、省道跨縣市的會算進每個縣市）
function cityHtml(snap) {
  const n = {}, uc = {};
  for (const k in CITIES) { n[k] = 0; uc[k] = 0; }
  for (const s in snap.src) (snap.src[s].items || []).forEach(it => (it.cs || []).forEach(c => { if (c in n) { n[c]++; if (it.uc) uc[c]++; } }));
  let h = '<h2>各縣市筆數</h2><table><tr><th>區</th><th>縣市（筆數／其中位置不確定）</th></tr>';
  const RN = { N: '北', C: '中', S: '南', E: '東' };
  for (const r in REGIONS) h += '<tr><td>' + RN[r] + '</td><td>' + REGIONS[r].map(k => CITY_NAMES[k] + ' ' + n[k] + (uc[k] ? '／' + uc[k] : '')).join('　') + '</td></tr>';
  return h + '</table>';
}

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

const pct = x => x == null ? '—' : Math.round(x * 100) + '%';
// 國道車速（高公局路段旅行時間，跟雪隧同一個檔）
function fwHtml(x, now) {
  if (!x) return '';
  const items = (x.d && x.d.items) || [], slow = items.filter(i => i.v < 60).length, jam = items.filter(i => i.v < 40).length;
  return '<h2>🛣️ 國道車速（高公局交通資料庫）</h2><p>最後成功：<b>' + twHm(x.okAt) + '</b>（' + ago(x.okAt, now) + '）　這一輪：' + (x.ok ? '<span class="ok">成功</span>' : '<span class="bad">失敗 ' + esc(x.err) + '</span>') +
    '　資料時間 ' + twHm(x.d && x.d.at) + '<br>全台 ' + (x.n || 0) + ' 段：時速 60 以下 <b>' + slow + '</b> 段（其中 40 以下 ' + jam + ' 段）、60～79 有 ' + (items.length - slow) + ' 段' +
    (x.unk ? '　<span class="bad">對照表沒有的路段 ' + x.unk + ' 段（高公局換了路段版本，要重跑 tools/make_fw_sections.mjs）</span>' : '') + '</p>' +
    '<p class="muted">停用：Cloudflare 後台 paoche-roads-worker 設變數 FW_OFF=1（App 就不顯示國道分頁）。</p>';
}
// 雪隧（高公局 VD＋路段旅行時間，每 3 分鐘；不吃 TDX 點數）
function hxHtml(x, now) {
  if (!x) return '';
  const d = x.d || {}, row = (name, o) => o ? '<tr><td>' + name + '</td><td>' + (o.L == null ? '—' : o.L) + '／' + (o.R == null ? '—' : o.R) + '</td><td>' + o.n + '／' + o.of + (o.n < o.of * 0.6 ? ' <span class="bad">不到 6 成</span>' : '') + '</td><td>' + (o.vl + o.vr) + '</td><td>' + (o.tt ? Math.round(o.tt / 60) + ' 分（' + o.v + ' km/h）' : '—') + '</td></tr>' : '';
  let h = '<h2>🏔️ 雪隧（坪林—頭城，高公局交通資料庫）</h2><p>最後成功：<b>' + twHm(x.okAt) + '</b>（' + ago(x.okAt, now) + '）　這一輪：' + (x.ok ? '<span class="ok">成功</span>' + (x.err ? '（部分失敗 ' + esc(x.err) + '）' : '') : '<span class="bad">失敗 ' + esc(x.err) + '</span>') +
    '　連續失敗 ' + (x.fails || 0) + '　資料時間 ' + twHm(d.at) + (x.info ? '　讀了約 ' + Math.round(x.info.chars / 1024) + ' K 字、找到 ' + x.info.found + '／44 組' : '') + '</p>';
  h += '<table><tr><th>方向</th><th>左／右線 km/h</th><th>可用偵測器</th><th>這分鐘車數</th><th>整段</th></tr>' + row('往宜蘭（南下）', d.S) + row('往台北（北上）', d.N) + '</table>';
  return h + '<p class="muted">停用：Cloudflare 後台 paoche-roads-worker 設變數 HX_OFF=1（App 就不顯示雪隧卡片）。</p>';
}
function geoHtml(g, now) {
  if (!g) return '';
  const t = g.today, l = g.last;
  let h = '<h2>📍 熱區地名查詢（OpenStreetMap）</h2>';
  h += '<table><tr><th>開關</th><td>' + (g.off ? '<span class="bad">已關閉（KV 鍵 geo:off）：不回地名、不查 OSM</span>' : '<span class="ok">開啟中</span>') + '</td></tr>' +
    '<tr><th>今天快取命中率</th><td><b>' + pct(g.hitRateToday) + '</b>（命中 ' + t.hit + '、沒命中 ' + t.miss + '；手機來問 ' + t.req + ' 次）　近 7 天：<b>' + pct(g.hitRateWeek) + '</b>　<span class="muted">約略值</span></td></tr>' +
    '<tr><th>待查清單</th><td><b>' + g.pending + '</b> 格' + (g.pending > 300 ? ' <span class="bad">快滿了（上限 400）</span>' : '') + '</td></tr>' +
    '<tr><th>今天打 OSM 次數</th><td><b>' + t.osm + '</b>（有名稱 ' + t.ok + '、沒名稱 ' + t.empty + '、失敗 ' + t.fail + '；上限 1,500）　今天這項寫入 KV ' + t.writes + ' 次</td></tr>' +
    '<tr><th>最近一輪</th><td>' + (l ? twHm(l.at) + '（' + ago(l.at, now) + '）：查 ' + l.n + '、成功 ' + l.ok + '、失敗 ' + l.fail + '、剩 ' + l.left + (l.stop ? ' <span class="bad">被 OSM 擋（' + esc(l.stop) + '）</span>' : '') : '還沒跑過') +
    (g.backoffUntil ? ' <span class="bad">暫停到 ' + twHm(g.backoffUntil) + '</span>' : '') + '</td></tr></table>';
  h += '<p class="muted">關閉：到 Cloudflare 後台 KV（ROADS_KV）新增鍵 geo:off、值填 1，立刻生效；刪掉或改 0 就恢復。對 OSM 的請求只有排程 Worker 會送，每筆隔 1.15 秒。</p>';
  return h;
}

function page(snap, now, geo) {
  const sim = snap.sim || {}, days = sim.days || {}, keys = Object.keys(days).sort().reverse();
  let h = '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>路況提醒統計</title>' +
    '<style>body{font:15px/1.6 system-ui,sans-serif;margin:0 auto;max-width:760px;padding:12px 16px;color:#222;background:#fff}h1{font-size:20px}h2{font-size:17px;margin-top:22px;border-bottom:1px solid #ddd}' +
    'table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}.bad{color:#c00;font-weight:700}.ok{color:#080}.bar{display:inline-block;background:#e67e22;height:10px}.muted{color:#777;font-size:13px}' +
    '@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#444}.muted{color:#aaa}}</style></head><body>';
  h += '<h1>🚦 路況提醒・只記錄不推播</h1>';
  h += '<p class="muted">模擬一位台北＋新北都勾、一直在上班的司機：照定案規則「如果現在推會推什麼」。<b>沒有推給任何人。</b>時間都是台灣時間。</p>';
  h += '<h2>Worker 狀態</h2><p>最後一次執行：<b>' + twHm(snap.at) + '</b>（' + ago(snap.at, now) + '）' + (now - snap.at > 10 * 60000 ? ' <span class="bad">超過 10 分鐘沒跑，請檢查 Worker 排程</span>' : ' <span class="ok">正常</span>') +
    '　由' + (snap.last ? (snap.last.by === 'app' ? '「有人打開 App」備援' : '排程') + '跑' + (snap.last.colo ? '，機房 <b>' + esc(snap.last.colo) + '</b>' : '') : '—') +
    '　累計執行 ' + (snap.runs || 0) + ' 次　今天寫入 KV ' + ((snap.w && snap.w.day === twDay(now)) ? snap.w.n : 0) + ' 次（付費方案每月含 100 萬次）</p>';
  h += '<p class="muted">機房代號：TPE 台北、KHH 高雄；其他（例如 HKG、NRT、SIN、LAX）是國外機房。</p>';
  h += '<table><tr><th>來源</th><th>多久抓一次</th><th>最後成功</th><th>這一輪</th><th>連續失敗</th><th>' + (snap.v === 2 ? '全國筆數' : '雙北筆數') + '</th></tr>';
  for (const k in snap.src) {
    const s = snap.src[k];
    h += '<tr><td>' + esc(SRC_NAMES[k] || k) + '</td><td>' + (s.p ? (s.p <= FAST ? '3 分鐘' : '每小時') : '—') + '</td><td>' + twHm(s.okAt) + '（' + ago(s.okAt, now) + '）</td><td>' + (s.ok ? '<span class="ok">成功</span>' : '<span class="bad">失敗 ' + esc(s.err) + '</span>') + '</td><td>' + (s.fails || 0) + '</td><td>' + (s.items ? s.items.length : 0) + '</td></tr>';
  }
  if (!snap.tdxOn) h += '<tr><td colspan="6" class="bad">' + (snap.mode && snap.mode !== 'nokey' ? 'TDX 目前沒抓：' + (MODE_NAMES[snap.mode] || '') : 'Worker 沒有設定 TDX 金鑰，只抓警廣') + '</td></tr>';
  h += '</table>';
  h += hxHtml(snap.hx, now) + fwHtml(snap.fw, now);
  if (snap.v === 2) h += cityHtml(snap) + tdxHtml(snap);

  h += '<h2>每天</h2><table><tr><th>日期</th><th>會推幾批</th><th>候選件數</th><th>最密集 10 分鐘</th><th>重複件（警廣＋TDX 同一件）</th><th>推了之後被排除（1 小時內）</th><th>來源失敗次數</th><th>排程／App 備援 跑幾輪</th></tr>';
  keys.forEach(k => {
    const d = days[k];
    h += '<tr><td>' + k + '</td><td><b>' + d.batches + '</b></td><td>' + d.cand.length + '</td><td>' + d.peak.n + (d.peak.n ? '（' + twHm(d.peak.at) + ' 起）' : '') + '</td><td>' + d.dups + '</td><td>' + d.cleared + '（' + d.cleared60 + '）</td><td>警廣 ' + d.fails.pbs + '・TDX ' + d.fails.tdx + '</td><td>' + (d.by ? d.by.cron + '／' + d.by.app : '—') + '</td></tr>';
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
  return h + geoHtml(geo, now) + '<p class="muted">這頁每次打開都是最新的；Worker 每 3 分鐘更新一次。</p></body></html>';
}

export async function onRequest(context) {
  const req = context.request, env = context.env || {};
  if (req.method !== 'GET') return new Response('method', { status: 405, headers: HEAD });
  const key = env.ROADS_STATS_KEY ? String(env.ROADS_STATS_KEY).trim() : '';
  if (!key) return new Response('統計網址還沒設定密碼（Cloudflare Secret ROADS_STATS_KEY）', { status: 503, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, HEAD) });
  if (!authed(req, key)) return new Response('需要密碼', { status: 401, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="roads-stats", charset="UTF-8"' }, HEAD) });
  if (!env.ROADS_KV) return new Response('還沒綁定 KV（ROADS_KV）', { status: 503, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, HEAD) });
  // 2026-11-24 起讀新的狀態（全國）；新版 Worker 還沒部署時讀舊快照（雙北）
  let snap = null;
  try { snap = await env.ROADS_KV.get(STATE_KEY, 'json'); } catch (e) {}
  if (!snap) { try { snap = await env.ROADS_KV.get(SNAP_KEY, 'json'); } catch (e) {} }
  let geo = null;
  try { geo = await geoStats(env.ROADS_KV, Date.now()); } catch (e) {}
  if (!snap) return new Response('還沒有資料：Worker 可能還沒跑過（排程每 3 分鐘一次）', { status: 200, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, HEAD) });
  const now = Date.now();
  if (new URL(req.url).searchParams.get('format') === 'json') {
    const src = {};
    for (const k in snap.src) { const s = snap.src[k]; src[k] = { ok: s.ok, at: s.at, okAt: s.okAt, err: s.err, fails: s.fails, p: s.p || null, n: s.items ? s.items.length : 0 }; }
    const tdx = snap.tdx ? { mon: snap.tdx.mon, points: +tdxPoints(snap.tdx).toFixed(2), today: +tdxPoints(snap.tdx.day).toFixed(2), calls: snap.tdx.calls, bytes: snap.tdx.bytes, ep: snap.tdx.ep, prev: snap.tdx.prev || null } : null;
    return new Response(JSON.stringify({ v: snap.v, at: snap.at, last: snap.last || null, runs: snap.runs, writes: snap.w, tdxOn: snap.tdxOn, mode: snap.mode || null, budget: snap.budget || null, tdx, src, hx: snap.hx || null, fw: snap.fw ? { ok: snap.fw.ok, at: snap.fw.at, okAt: snap.fw.okAt, err: snap.fw.err, n: snap.fw.n, unk: snap.fw.unk, slow: ((snap.fw.d && snap.fw.d.items) || []).length } : null, days: (snap.sim && snap.sim.days) || {}, geo }), { status: 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, HEAD) });
  }
  return new Response(page(snap, now, geo), { status: 200, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, HEAD) });
}
