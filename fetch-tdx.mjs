import { mkdir, writeFile } from "node:fs/promises";

const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const BASE = "https://tdx.transportdata.tw/api/basic";
const ROUTES = {
  vd:   "/v2/Road/Traffic/Live/VD/Highway",
  cctv: "/v2/Road/Traffic/CCTV/Highway",
  news: "/v2/Road/Traffic/Live/News/Highway",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 網路逾時／429 都重試，最多 4 次；全部失敗才往外丟錯
async function call(url, options) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (res.status !== 429) return res;
      last = res;
    } catch (e) {
      last = e;
    }
    if (i < 3) await sleep(8000);
  }
  if (last instanceof Response) return last;
  throw last;
}

// 蘇花範圍：台9線 100K～180K
const KM_MIN = 100;
const KM_MAX = 180;
const kmOf = (t) => { const m = String(t || "").match(/(\d{2,3})K/); return m ? parseInt(m[1], 10) : null; };

// CCTV：只留台9線 100K～180K，且只留網站用得到的欄位
function trimCctv(json) {
  const KEEP = ["CCTVID", "RoadID", "RoadName", "RoadDirection", "LocationMile", "VideoImageURL", "SurveillanceDescription"];
  const list = (json.CCTVs || [])
    .filter((c) => {
      if (c.RoadID !== "300090") return false;
      const km = parseInt(String(c.LocationMile || ""), 10);
      return km >= KM_MIN && km <= KM_MAX;
    })
    .map((c) => Object.fromEntries(KEEP.map((k) => [k, c[k]])));
  return { UpdateTime: json.UpdateTime, CCTVs: list };
}

// VD：只留台9線（VDID 含 0090）且里程 100～180
function trimVd(json) {
  const list = (json.VDLives || []).filter((v) => {
    const m = (v.VDID || "").match(/-0090-(\d{3})-/);
    return m && +m[1] >= KM_MIN && +m[1] <= KM_MAX;
  });
  return { ...json, VDLives: list };
}

// News：國5 路況專區（網站卡片要用）＋ 蘇花路段（台9線 100K～180K、台9丁、蘇花）
function trimNews(json) {
  const list = (json.Newses || []).filter((item) => {
    const title = item.Title || "";
    if (title.includes("國5路況專區")) return true;
    if (title.includes("台9丁") || title.includes("蘇花")) return true;
    if (!title.includes("台9")) return false;
    const km = kmOf(title);
    return km !== null && km >= KM_MIN && km <= KM_MAX;
  });
  return { ...json, Newses: list };
}

const TRIMMERS = {
  cctv: { fn: trimCctv, count: (j) => j.CCTVs.length },
  vd:   { fn: trimVd,   count: (j) => j.VDLives.length },
  news: { fn: trimNews, count: (j) => j.Newses.length },
};

await mkdir("data", { recursive: true });

const status = { updated: new Date().toISOString(), results: {}, kept: {} };

let authProblem = false; // 金鑰／帳號問題（真的要處理）
let httpFails = 0;       // TDX 有回應但回錯誤碼的次數

if (!process.env.TDX_ID || !process.env.TDX_SECRET) {
  status.results.token = "missing TDX_ID or TDX_SECRET";
  authProblem = true;
} else {
  let accessToken = null;
  try {
    const tokenRes = await call(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.TDX_ID,
        client_secret: process.env.TDX_SECRET,
      }),
    });
    if (!tokenRes.ok) {
      status.results.token = tokenRes.status + " " + (await tokenRes.text()).slice(0, 300);
      if ([400, 401, 403].includes(tokenRes.status)) authProblem = true;
    } else {
      accessToken = (await tokenRes.json()).access_token;
      status.results.token = "ok";
    }
  } catch (e) {
    // 連不上 TDX（逾時等）：保留舊資料，下一輪再試
    status.results.token = "network error " + (e?.cause?.code || e);
  }

  if (accessToken) {
    for (const [name, path] of Object.entries(ROUTES)) {
      await sleep(1500); // 請求之間間隔，降低被限流的機會
      try {
        const res = await call(`${BASE}${path}?$format=JSON&$top=5000`, {
          headers: { authorization: "Bearer " + accessToken },
        });
        if (!res.ok) {
          status.results[name] = res.status + " " + (await res.text()).slice(0, 300);
          httpFails++;
          continue;
        }

        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          status.results[name] = "invalid json"; // 保留舊檔
          continue;
        }

        const trimmer = TRIMMERS[name];
        const trimmed = trimmer.fn(json);
        const n = trimmer.count(trimmed);

        // 診斷：記錄 TDX 實際回傳了什麼
        const rawList = json.VDLives || json.CCTVs || json.Newses || [];
        status.raw = status.raw || {};
        status.raw[name] = {
          tdxUpdateTime: json.UpdateTime || null,
          total: rawList.length,
        };
        if (name === "vd") {
          const r9 = rawList.filter((v) => String(v.VDID || "").includes("-0090-"));
          const kms = [...new Set(
            r9.map((v) => (String(v.VDID).match(/-0090-(\d{3})-/) || [])[1]).filter(Boolean).map(Number)
          )].sort((a, b) => a - b);
          status.raw.vd.has0090 = r9.length;
          status.raw.vd.kms = kms;                               // 台9線偵測器的里程分佈
          status.raw.vd.sample0090 = r9.slice(0, 5).map((v) => v.VDID);
          status.raw.vd.statusCount = r9.reduce((a, v) => { a[v.Status] = (a[v.Status] || 0) + 1; return a; }, {});
        }

        status.kept[name] = n;

        // 篩完是空的：視為異常，保留舊檔（news 本來就可能沒有通報）
        if (n === 0 && name !== "news") {
          status.results[name] = "empty after trim";
          continue;
        }

        await writeFile(`data/${name}.json`, JSON.stringify(trimmed));
        status.results[name] = "ok";
      } catch (e) {
        status.results[name] = "network error " + (e?.cause?.code || e);
      }
    }
  }
}

await writeFile("data/status.json", JSON.stringify(status, null, 2));
console.log(JSON.stringify(status, null, 2));

// 只有「金鑰有問題」或「TDX 三份資料都回錯誤碼」才讓 Actions 顯示紅色 ✗。
// 偶爾連不上 TDX 屬暫時狀況：保留舊資料，網站在資料超過 20 分鐘時會自己顯示警告。
if (authProblem || httpFails === 3) process.exitCode = 1;
