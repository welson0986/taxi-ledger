// ⚠️ 這個檔案是 `node relay/build.mjs` 自動產生的，不要直接改。
// 要改請改 App 倉庫 relay/src/pages_roads.js 與 relay/lib/，再重新產生。

// 跑車人生 官方路況快報 中繼（Cloudflare Pages Functions）
// 網址：https://app.realway.com.tw/api/roads?city=tpe,ntpc
//
// 做的事（2026-11-24 起全縣市都一樣）：
//   1. 讀排程 Worker 每 3 分鐘存進 KV 的分區資料（北中南東，只讀選的縣市所在的那幾區），自己不去抓。
//   2. 分區資料超過 12 分鐘沒更新（Worker 停了）、或裡面的警廣太久沒成功時：只自己抓警廣（公開資料、不用點數，
//      同一台機器 3 分鐘內只抓一次）。**這裡完全不呼叫 TDX**——TDX 點數只由排程 Worker 用，用量固定、可預算，
//      不會因為使用者變多被燒光。
//   3. 整理成精簡的 JSON，只回 App 要的城市。App 只送城市代號，不送位置、不送帳本。
// 這裡沒有任何金鑰；也不讀、不寫 TDX Token。
// 用量：Pages Functions 跟 Workers 同一個付費方案（每月 1,000 萬次請求）；App 每打開一次快報算 1 次、讀 KV 1～2 次。

// ===== 路況共用程式（relay/lib/roads_core.js）=====
// Pages 中繼（/api/roads、/api/roads-stats）和排程 Worker 都用這一份。
// 不要直接改 relay/functions/ 或 relay/worker/ 裡的檔案：那些是 `node relay/build.mjs` 自動產生的。

const PBS_URL = 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata';
const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_BASE = 'https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/';
const TDX_SELECT = 'EventID,EventTitle,Description,EventType,EventSubType,Positions,Location,Impact,Source,PublishTime,LastUpdateTime,ExpireTime';
// FAST＝每 3 分鐘、MID＝每 15 分鐘（11/25 起省道、宜蘭）、SLOW＝每小時
const FAST = 180, MID = 900, SLOW = 3600, FAIL = 60, TOKEN_TTL = 23 * 3600;
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
  ila:  { names: ['宜蘭縣'], box: [24.30, 24.99, 121.30, 121.96], tdx: [['City/YilanCounty', MID]] },   // 11/25 改每 15 分鐘：只有零星施工；先觀察原始筆數一週
  hsz:  { names: ['新竹市', '新竹縣'], box: [24.43, 24.95, 120.88, 121.42], tdx: [] },
  mlc:  { names: ['苗栗縣'], box: [24.25, 24.75, 120.62, 121.27], tdx: [['City/MiaoliCounty', SLOW]] },
  txg:  { names: ['臺中市', '台中市'], box: [23.99, 24.45, 120.46, 121.45], tdx: [['City/Taichung', FAST]] },
  chw:  { names: ['彰化縣'], box: [23.78, 24.21, 120.23, 120.70], tdx: [] },
  nto:  { names: ['南投縣'], box: [23.44, 24.25, 120.60, 121.35], tdx: [] },
  yun:  { names: ['雲林縣'], box: [23.44, 23.87, 120.00, 120.75], tdx: [] },   // 11/24 照鄉鎮界線放大（原本 10% 面積在框外）
  cyi:  { names: ['嘉義市', '嘉義縣'], box: [23.20, 23.65, 120.10, 120.90], tdx: [['City/ChiayiCounty', SLOW], ['City/Chiayi', SLOW]] },
  tnn:  { names: ['臺南市', '台南市'], box: [22.88, 23.42, 120.03, 120.66], tdx: [['City/Tainan', FAST]] },
  khh:  { names: ['高雄市'], box: [22.47, 23.47, 120.17, 121.05], tdx: [['City/Kaohsiung', FAST]] },
  pif:  { names: ['屏東縣'], box: [21.89, 22.89, 120.40, 120.92], tdx: [['City/PingtungCounty', SLOW]] },   // 11/25 改每小時：11/24 實測 733 筆全是道路施工
  hun:  { names: ['花蓮縣'], box: [23.10, 24.38, 121.00, 121.78], tdx: [] },   // 11/24 放大（原本 25%：秀林、卓溪、萬榮西邊山區在框外）
  ttt:  { names: ['臺東縣', '台東縣'], box: [22.00, 23.45, 120.74, 121.60], tdx: [] }   // 11/24 放大（原本 3%：蘭嶼、南端）
};
// 省道 11/25 改每 15 分鐘：留下來的都是 0 筆（大多是轉載警廣），但可能有公路局自己的通報（坍方、封路），先觀察原始筆數一週
const TDX_ROADS = [['Freeway', FAST], ['Highway', MID]];
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
// 回 { status, json, calls, bytes, est }；400 時改取全部欄位（欄位名稱不被接受時）
// calls／bytes 給 TDX 點數估算用。TDX 計費用的是「傳輸（壓縮後）」大小（11/25 對過會員中心：平均每次 10～16 KB），
// 不是解壓後的大小（台北約 276 KB、屏東約 390 KB，大 20～30 倍；11/24 以前這樣記，會在月中誤觸 85% 降頻）。
//   有 content-length 標頭 → 用它（est＝false）；
//   讀不到（分段傳送、或 Cloudflare 自動解壓時拿掉）→ 解壓後大小 × TDX_ZIP_RATIO（est＝true，統計頁標「估計」）。
// Workers 的 fetch 會自動解壓，拿不到壓縮後的原始位元組，所以沒有「自己數壓縮後位元組」這一層。
const TDX_ZIP_RATIO = 0.04;   // 11/25 實測：壓縮後約 10.8 KB ÷ 解壓後約 270 KB
function wireBytes(res, rawLen) {
  const cl = parseInt(res && res.headers && res.headers.get('content-length'), 10);
  if (cl >= 0 && isFinite(cl) && (cl > 0 || !rawLen)) return { bytes: cl, est: false };
  return { bytes: Math.round((rawLen || 0) * TDX_ZIP_RATIO), est: true };
}
async function fetchTdxRaw(ep, tk) {
  const head = { 'Authorization': 'Bearer ' + tk, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' };
  let calls = 1;
  let res = await get(TDX_BASE + ep + '?%24select=' + encodeURIComponent(TDX_SELECT) + '&%24format=JSON', { headers: head });
  if (res.status === 400) { calls++; res = await get(TDX_BASE + ep + '?%24format=JSON', { headers: head }); }
  if (!res.ok) return { status: res.status, json: null, calls, bytes: 0, est: false };
  const buf = await res.arrayBuffer(), w = wireBytes(res, buf.byteLength);
  return { status: res.status, json: JSON.parse(new TextDecoder().decode(buf)), calls, bytes: w.bytes, est: w.est };
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
// rc（可不給）：記原始筆數 n、其中轉載警廣 pbs、非轉載的來源名稱 so（最多 3 個），給統計頁看「是不是全是轉載」
function parseTdx(d, cityKey, now, pick, rc) {
  const src = Array.isArray(d) ? d : ((d && (d.Items || d.LiveEvents || d.Events)) || []), list = [];
  if (rc) rc.n = src.length;
  src.forEach(x => {
    if (isPbsCopy(x)) { if (rc) rc.pbs++; return; }
    if (rc) { const so = cleanText(x && x.Source).slice(0, 20); if (so && rc.so.indexOf(so) < 0 && rc.so.length < 3) rc.so.push(so); }
    const m = isoTime(x.LastUpdateTime) || isoTime(x.PublishTime);
    if (!m || !x.EventID) return;
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
// 點數＝呼叫次數 ÷ 1,500 ＋ 壓縮後資料量(MB) ÷ 150；MB＝KB ÷ 1,024＝位元組 ÷ 1,048,576
// （11/25 用會員中心 11/20～11/24 五天逐日代入，全部吻合到小數第 3 位；例：11/24＝2,468÷1,500＋26,771÷1,024÷150＝1.819）
const TDX_BUDGET_DEFAULT = 120;
function tdxPoints(u) { return u ? u.calls / 1500 + u.bytes / 1048576 / 150 : 0; }
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

// ===== 程式內限速＋統計頁密碼鎖定（relay/lib/ratelimit.js，2026-11-25）=====
// 為什麼在程式裡做：realway.com.tw 的 DNS 在 GoDaddy，Cloudflare 帳號沒有 Zone，後台的速率限制規則設不了（決定不搬網域）。
// 注意：被擋的請求還是算 1 次 Pages Functions 請求（程式已經被叫醒了）；這裡省的是後面的 KV 讀寫、熱區待查清單、OSM 每日額度。
//
// 一、限速（/api/roads、/api/geo、/api/roads-stats）：
//   Pages Functions 不能直接用 Cloudflare 的「Rate Limiting」功能，所以透過 Service binding（變數名稱 RATE_LIMITER）
//   去問另一支小 Worker paoche-ratelimit（relay/src/ratelimit.js），它用 Rate Limiting 計數：同一來源 10 秒超過 50 次 → 擋。
//   每個網址各算各的；每個 Cloudflare 機房各自計算（官方說是近似值），擋「單一來源用程式狂打」夠用。
//   一律「放行優先」：沒綁定、小 Worker 壞了、0.3 秒沒回 → 照常服務，路況不會因為限速停掉。
//
// 二、統計頁密碼鎖定（只有 /api/roads-stats）：同一來源 10 分鐘內密碼錯 3 次 → 鎖 15 分鐘（鎖定期間連正確密碼也回 429）。
//   用 KV（ROADS_KV）記：只有「輸錯」才寫，鎖住後不再寫，所以一個來源每 15 分鐘最多寫 3 次。依來源分開算，別人亂試不會鎖到 Welson。
//
// 「來源」＝CF-Connecting-IP；IPv6 用前 64 位元（同一台手機會換後半段）。IP 不存原文：
//   限速用一般雜湊；鎖定用「統計頁密碼＋IP」雜湊（沒有密碼就算不回 IP），KV 鍵 stats:lock:v1:<雜湊>，到期自動刪除。

const RL_WAIT_MS = 300;                 // 問小 Worker 最多等多久，超過就放行
const RL_RETRY_S = 10;                  // 被擋時告訴 App 幾秒後再試（跟限速的 10 秒一致）
const LOCK_FAILS = 3;                   // 錯幾次就鎖（11/25 定：3 次）
const LOCK_WINDOW_MS = 10 * 60000;      // 幾分鐘內的錯誤才算
const LOCK_MS = 15 * 60000;             // 鎖多久
const LOCK_KEY = tag => 'stats:lock:v1:' + tag;

// IPv6 展開成 8 段、取前 4 段（/64）；IPv4 原樣；IPv4 對應的 IPv6（::ffff:1.2.3.4）當 IPv4
function ipSource(ip) {
  ip = String(ip || '').trim().toLowerCase();
  if (!ip) return '';
  if (ip.indexOf(':') < 0) return ip;
  if (ip.indexOf('.') >= 0) return ip.slice(ip.lastIndexOf(':') + 1);
  const halves = ip.split('::');
  const left = halves[0] ? halves[0].split(':') : [], right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? Math.max(0, 8 - left.length - right.length) : 0;
  const all = left.concat(Array(fill).fill('0'), right).slice(0, 8);
  return all.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}
async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
// 來源代號（32 個十六進位字）：salt 不同，同一個 IP 的代號就不同
async function ipTag(req, salt) {
  const src = ipSource(req.headers.get('CF-Connecting-IP')) || 'noip';
  return sha('paoche|' + salt + '|' + src);
}

// ---------- 一、限速 ----------
// 回 true＝放行、false＝擋（只有小 Worker 明確回 {ok:false} 才擋）
async function rateOk(env, req, route) {
  const svc = env && env.RATE_LIMITER;
  if (!svc || typeof svc.fetch !== 'function') return true;
  let timer;
  try {
    const k = route + ':' + await ipTag(req, 'rl');
    const ask = svc.fetch('https://paoche-ratelimit/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k }) })
      .then(r => r.ok ? r.json() : null, () => null);
    const late = new Promise(res => { timer = setTimeout(() => res(null), RL_WAIT_MS); });
    const j = await Promise.race([ask, late]);
    return !(j && j.ok === false);
  } catch (e) { return true; } finally { clearTimeout(timer); }
}
const RATE_BODY = { ok: false, err: 'rate', msg: '請求太頻繁，請 10 秒後再試' };

// ---------- 二、統計頁密碼鎖定 ----------
// 讀這個來源的紀錄：{ f:[輸錯的時間], u:鎖到幾點（0＝沒鎖）}
async function lockRead(kv, tag, now) {
  let r = null;
  try { r = await kv.get(LOCK_KEY(tag), 'json'); } catch (e) {}
  if (!r || typeof r !== 'object') r = {};
  const f = (Array.isArray(r.f) ? r.f : []).filter(t => typeof t === 'number' && now - t < LOCK_WINDOW_MS && t <= now);
  return { f, u: typeof r.u === 'number' && r.u > now ? r.u : 0, had: !!(r.f && r.f.length) || !!r.u };
}
// 記一次輸錯；回傳鎖到幾點（0＝還沒鎖）
async function lockFail(kv, tag, rec, now) {
  const f = rec.f.concat(now);
  const locked = f.length >= LOCK_FAILS;
  const val = locked ? { f: [], u: now + LOCK_MS } : { f, u: 0 };
  const ttl = Math.ceil((locked ? LOCK_MS : LOCK_WINDOW_MS) / 1000) + 60;   // KV 到期最少 60 秒；到期自動刪除
  try { await kv.put(LOCK_KEY(tag), JSON.stringify(val), { expirationTtl: ttl }); } catch (e) {}
  return val.u;
}
// 密碼對了：清掉之前輸錯的紀錄（有紀錄才動 KV）
async function lockClear(kv, tag, rec) {
  if (!rec.had) return;
  try { if (typeof kv.delete === 'function') await kv.delete(LOCK_KEY(tag)); } catch (e) {}
}
const lockMinutes = (u, now) => Math.max(1, Math.ceil((u - now) / 60000));

// ===== 主程式 =====
// 限速（2026-11-25）：Service binding RATE_LIMITER（paoche-ratelimit）；同一來源 10 秒超過 50 次回 429，沒綁定就不限速（見 relay/lib/ratelimit.js）。
// App 收到 429 會顯示「連不上」但保留已顯示的路況，不會清空。

// 只接受這些來源的網頁讀取：網站、舊網址、App（Android／iOS 的內建網頁）
const ORIGINS = ['https://app.realway.com.tw', 'https://welson0986.github.io', 'https://localhost', 'capacitor://localhost', 'http://localhost'];
const REG_MAX_AGE = 12 * MIN;
const HX_CITIES = ['tpe', 'ntpc', 'ila'];   // 雪隧卡片給這三個城市（北宜往返）

// ---------- 快取：這台伺服器的記憶體＋Cloudflare 快取（只給備援的警廣用）----------
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
  if (inflight.has(key)) return inflight.get(key);   // 同一台機器同時只抓一次
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
// 備援：全國警廣（跟 Worker 同一套分桶，每筆帶 cs）
async function loadPbs() { return { ok: true, at: Date.now(), items: parsePbs(await fetchPbs(), Date.now(), 'all') }; }

// ---------- 讀分區 ----------
async function readReg(env, r) {
  if (!env.ROADS_KV) return null;
  try { const s = await env.ROADS_KV.get(REG_KEY(r), { type: 'json', cacheTtl: 60 }); return s && s.v === 2 ? s : null; } catch (e) { return null; }
}
// 一個來源在分區裡的狀態：上一輪失敗但還有上次成功的資料 → 照樣給，標 stale（App 會寫「先顯示 hh:mm 的」）
function snapSrc(s, now) {
  if (!s || !s.okAt) return { ok: false, at: null, stale: false, use: false, err: s && s.err };
  const use = now - s.okAt <= (s.p || FAST) * 1000 + HOUR;
  return { ok: use, at: s.okAt, stale: use && !s.ok, use, err: s.ok ? null : s.err };
}

// ---------- 回應 ----------
function cors(req) {
  const o = req.headers.get('Origin');
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
  if (o && ORIGINS.indexOf(o) >= 0) { h['Access-Control-Allow-Origin'] = o; h['Access-Control-Allow-Methods'] = 'GET, OPTIONS'; h['Access-Control-Max-Age'] = '86400'; }
  return h;
}
function reply(req, status, obj) { return new Response(JSON.stringify(obj), { status, headers: cors(req) }); }
function tooMany(req) { const h = cors(req); h['Retry-After'] = String(RL_RETRY_S); return new Response(JSON.stringify(RATE_BODY), { status: 429, headers: h }); }

export async function onRequest(context) {
  const req = context.request, env = context.env || {};
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'GET') return reply(req, 405, { ok: false, err: 'method' });
  if (!(await rateOk(env, req, 'roads'))) return tooMany(req);   // 擋在讀 KV、備援抓警廣之前
  const url = new URL(req.url);
  const sel = [...new Set(String(url.searchParams.get('city') || '').split(',').map(s => s.trim()).filter(k => Object.prototype.hasOwnProperty.call(CITIES, k)))];
  if (!sel.length) return reply(req, 400, { ok: false, err: 'city' });

  const now = Date.now();
  const regs = [...new Set(sel.map(k => REGION_OF[k]))];
  const raws = await Promise.all(regs.map(r => readReg(env, r)));
  const got = {};
  regs.forEach((r, i) => { const x = raws[i]; got[r] = x && now - x.at <= REG_MAX_AGE ? x : null; });   // Worker 停了 → 不用
  const inSel = it => it.cs && it.cs.some(k => sel.indexOf(k) >= 0);
  let items = [];

  // 警廣：每一區都能用就讀分區；有一區不能用 → 只自己抓警廣
  let pbs = { ok: false, at: null, stale: false };
  const ps = regs.map(r => got[r] && snapSrc(got[r].src.pbs, now));
  if (ps.every(p => p && p.use)) {
    regs.forEach(r => { items = items.concat(got[r].src.pbs.items.filter(inSel)); });
    pbs = { ok: true, at: Math.min(...ps.map(p => p.at)), stale: ps.some(p => p.stale) };
  } else {
    const g = await cached('pbs', FAST, loadPbs);
    if (g && g.ok) { items = items.concat(g.items.filter(inSel)); pbs = { ok: true, at: g.at, stale: false }; }
  }

  // TDX：只讀分區（縣市端點在它那一區；國道、省道每區各放自己縣市的那部分，所以選了幾區就讀幾區）
  const want = tdxWant(sel), tdx = [];
  let tdxOn = false;
  for (const ep in want) {
    const cityKey = want[ep][1], from = cityKey ? [REGION_OF[cityKey]] : regs;
    let st = null;
    from.forEach(r => {
      const x = got[r];
      if (!x) { if (env.ROADS_KV) { st = st || { ok: false, at: null, stale: false, err: 'worker' }; tdxOn = true; } return; }   // Worker 停了：標 TDX 讀不到（不自己抓）；沒綁 KV＝沒有 TDX
      if (!x.tdxOn) return;   // 沒金鑰、暫停或停用：不列 TDX
      tdxOn = true;
      const t = snapSrc(x.src[ep], now);
      if (t.use) items = items.concat(x.src[ep].items.filter(inSel));
      if (!st || (!st.ok && t.ok)) st = { ok: t.ok, at: t.at, stale: t.stale, err: t.err || (x.src[ep] ? null : 'none') };
    });
    if (st) tdx.push(st);
  }

  // 合併：同一筆（例如國道在台北和桃園都有、或同時在兩區）只留一筆
  const byId = {};
  items.forEach(it => { if (!byId[it.id] || byId[it.id].m < it.m) byId[it.id] = it; });
  // c（縣市代號）留給 App 標地區；qa／qo／qc 是預設座標、cs 是分桶結果，只給篩選用，不給 App（App 只看 uc＝位置不確定）
  // pc：沒有縣市名的，說明或通報單位寫到的是選的哪個城市（App 標「台北·位置不確定」、不會被它用座標當成別的縣市藏掉）
  const out = Object.keys(byId).map(k => {
    const o = Object.assign({}, byId[k]);
    delete o.qa; delete o.qo; delete o.qc; delete o.cs;
    if (!o.c) { delete o.c; const pc = placeCity(o, sel); if (pc) o.pc = pc; }
    return o;
  });
  // 雪隧（坪林—頭城）：選了台北、新北或宜蘭才給；只讀北區裡 Worker 算好的（這裡不抓高公局）。
  // 北區讀不到（Worker 停了）→ ok:false；北區裡沒有 hx（Worker 還是舊版或 HX_OFF）→ 不給，App 就不顯示卡片
  let hx;
  if (sel.some(k => HX_CITIES.indexOf(k) >= 0)) {
    const n = got[REGION_OF.ila];
    if (!n) hx = env.ROADS_KV ? { ok: false } : undefined;
    else if (n.hx) hx = n.hx.d ? { ok: !!n.hx.ok, at: n.hx.d.at, S: n.hx.d.S, N: n.hx.d.N } : { ok: false };
  }
  // 國道車速：只讀分區裡 Worker 整理好的慢路段（這裡不抓高公局）。選的縣市經過的才給、同一段只給一次、最慢的排前面。
  // 分區讀不到（Worker 停了）→ ok:false；分區都沒有 fw（Worker 還是舊版或 FW_OFF）→ 不給，App 就不顯示國道分頁
  let fw;
  if (regs.some(r => got[r] && got[r].fw) || (env.ROADS_KV && regs.some(r => !got[r]))) {
    const parts = regs.map(r => got[r] && got[r].fw);
    if (parts.some(x => !x)) fw = { ok: false };
    else {
      const seen = {}, list = [];
      parts.forEach(x => ((x.d && x.d.items) || []).forEach(it => { if (!seen[it.id] && it.cs.some(c => sel.indexOf(c) >= 0)) { seen[it.id] = 1; const o = Object.assign({}, it); delete o.cs; list.push(o); } }));
      list.sort((a, b) => a.v - b.v);
      const ats = parts.filter(x => x.d && x.d.at).map(x => x.d.at);
      fw = parts.every(x => x.d) ? { ok: parts.every(x => x.ok), at: ats.length ? Math.min(...ats) : null, items: list } : { ok: false };
    }
  }
  const tdxOk = tdxOn && tdx.length > 0 && tdx.every(g => g.ok);
  const bad = tdx.find(g => !g.ok || g.err);
  const ats = tdx.filter(g => g.ok && g.at).map(g => g.at);
  const live = regs.every(r => got[r]);
  return reply(req, 200, {
    ok: pbs.ok || tdx.some(g => g.ok), v: 1, t: now, cities: sel, snap: live ? Math.min(...regs.map(r => got[r].at)) : null,
    src: {
      pbs,
      tdx: { on: tdxOn, ok: tdxOk, part: tdxOn && !tdxOk && tdx.some(g => g.ok), at: ats.length ? Math.max(...ats) : null, err: bad ? errText(bad.err || 'fail') : null, stale: tdx.some(g => g.stale) }
    },
    items: out,
    hx,
    fw
  });
}
