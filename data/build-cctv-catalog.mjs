// 建立「蘇花攝影機清單」：只呼叫 TDX 一次 CCTV API，
// 輸出 data/cctv-catalog.json（網頁使用）與 data/cctv-catalog-status.json（檢查用）
//   - 台9線（蘇花改）：100K～187K
//   - 台9丁線（舊蘇花公路）：全部里程
// 網頁直接用清單裡的 url 載入公路局影像，載入影像不扣 TDX 點數。
import { mkdir, writeFile } from "node:fs/promises";

const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const URL_CCTV = "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Highway?$format=JSON&$top=5000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, options) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
      if (res.status !== 429) return res;
      last = res;
    } catch (e) { last = e; }
    await sleep(10000);
  }
  if (last instanceof Response) return last;
  throw last;
}
const parseMile = (s) => { const m = String(s || "").match(/(\d+)\s*K\s*\+?\s*(\d*)/i); return m ? +m[1] + (m[2] ? +m[2] / 1000 : 0) : NaN; };

// 判斷是否台9丁線：路名、影像網址（T9D-）、說明，任一符合即算
const isOld = (c) => /^台9丁/.test(String(c.RoadName || "")) || /\/T9D-/i.test(String(c.VideoImageURL || "")) || /台9丁/.test(String(c.SurveillanceDescription || ""));
// 方向：影像網址有 (S)/(N) 時以它為準（TDX 的 RoadDirection 偶有與實際相反的資料）
const dirOf = (c) => { const m = String(c.VideoImageURL || "").match(/\(([NS])\)\/snapshot/); return m ? m[1] : c.RoadDirection; };

function classify(c) {
  const km = parseMile(c.LocationMile);
  if (!Number.isFinite(km) || !c.VideoImageURL) return null;
  if (isOld(c)) return "台9丁線";
  if ((String(c.RoadID) === "300090" || String(c.RoadName) === "台9線") && km >= 100 && km <= 187) return "台9線";
  return null;
}

await mkdir("data", { recursive: true });
const status = { updated: new Date().toISOString() };
const fail = async (msg) => { status.error = msg; await writeFile("data/cctv-catalog-status.json", JSON.stringify(status, null, 2)); process.exit(1); };

const tokenRes = await call(TOKEN_URL, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.TDX_ID, client_secret: process.env.TDX_SECRET }),
});
if (!tokenRes.ok) await fail("token " + tokenRes.status);
const { access_token } = await tokenRes.json();

const res = await call(URL_CCTV, { headers: { authorization: "Bearer " + access_token } });
if (!res.ok) await fail("cctv " + res.status);
const json = JSON.parse(await res.text());
const all = json.CCTVs || [];

// 診斷：台9 開頭的路名、以及影像網址含 T9D- 的紀錄，TDX 裡實際叫什麼
const names = {};
all.forEach((c) => { const n = String(c.RoadName || ""); if (/^台9/.test(n)) { const k = `${c.RoadID}|${n}`; names[k] = (names[k] || 0) + 1; } });
const t9dUrl = all.filter((c) => /\/T9D-/i.test(String(c.VideoImageURL || "")));
const t9dUrlNames = {};
t9dUrl.forEach((c) => { const k = `${c.RoadID}|${c.RoadName}`; t9dUrlNames[k] = (t9dUrlNames[k] || 0) + 1; });

const cameras = [];
all.forEach((c) => {
  const road = classify(c);
  if (!road) return;
  const km = parseMile(c.LocationMile);
  cameras.push({
    id: c.CCTVID,
    road,
    dir: dirOf(c),
    rawDir: c.RoadDirection,
    mile: String(c.LocationMile || "").replace(/\s/g, ""),
    km: Math.round(km * 1000) / 1000,
    url: c.VideoImageURL,
    desc: c.SurveillanceDescription || "",
    lat: c.PositionLat ?? null,
    lon: c.PositionLon ?? null,
  });
});
cameras.sort((a, b) => a.road.localeCompare(b.road) || a.km - b.km || String(a.dir).localeCompare(String(b.dir)));

const byRoad = {}, byDir = {};
cameras.forEach((c) => { byRoad[c.road] = (byRoad[c.road] || 0) + 1; const k = c.road + "|" + c.dir; byDir[k] = (byDir[k] || 0) + 1; });

status.totalFromTdx = all.length;
status.kept = cameras.length;
status.byRoad = byRoad;
status.byRoadDir = byDir;
status.dirCorrected = cameras.filter((c) => c.dir !== c.rawDir).map((c) => `${c.road} ${c.mile} ${c.rawDir}->${c.dir}`);
status.expected = "參考：live.traffictw.com 蘇花公路頁共 176 支，約為 台9丁線 70 + 台9線 105";
status.tdxRoadNames = names;
status.t9dUrlCount = t9dUrl.length;
status.t9dUrlRoadNames = t9dUrlNames;
status.sampleOld = cameras.filter((c) => c.road === "台9丁線").slice(0, 3);
if (!byRoad["台9丁線"]) status.warning = "找不到台9丁線：請看 tdxRoadNames 與 t9dUrlRoadNames，把內容貼給我調整篩選規則";

await writeFile("data/cctv-catalog.json", JSON.stringify({ updated: status.updated, cameras }));
await writeFile("data/cctv-catalog-status.json", JSON.stringify(status, null, 2));
console.log(JSON.stringify(status, null, 2));
