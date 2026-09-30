// 排程程式：向 TDX 取資料並存成檔案（由 GitHub Actions 執行）
import { mkdir, writeFile } from "node:fs/promises";

const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const BASE = "https://tdx.transportdata.tw/api/basic";
const ROUTES = {
  vd:   "/v2/Road/Traffic/Live/VD/Highway",
  cctv: "/v2/Road/Traffic/CCTV/Highway",
  news: "/v2/Road/Traffic/Live/News/Highway",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 遇到 429 就等一下再試，最多 3 次
async function call(url, options) {
  let res;
  for (let i = 0; i < 3; i++) {
    res = await fetch(url, options);
    if (res.status !== 429) return res;
    await sleep(15000);
  }
  return res;
}

// ---- 只保留蘇花需要的資料，檔案變小、網站載入更快 ----

// CCTV：只留台9線 100K～180K，且只留網站用得到的欄位
function trimCctv(json) {
  const KEEP = ["CCTVID", "RoadID", "RoadName", "RoadDirection", "LocationMile", "VideoImageURL", "SurveillanceDescription"];
  const list = (json.CCTVs || [])
    .filter((c) => {
      if (c.RoadID !== "300090") return false;
      const km = parseInt(String(c.LocationMile || ""), 10);
      return km >= 100 && km <= 180;
    })
    .map((c) => Object.fromEntries(KEEP.map((k) => [k, c[k]])));
  return { UpdateTime: json.UpdateTime, CCTVs: list };
}

// VD：只留台9線（VDID 含 0090），與網站的篩選條件一致
function trimVd(json) {
  const list = (json.VDLives || []).filter((v) => v.VDID && v.VDID.includes("0090"));
  return { ...json, VDLives: list };
}

const TRIMMERS = {
  cctv: { fn: trimCctv, count: (j) => j.CCTVs.length },
  vd:   { fn: trimVd,   count: (j) => j.VDLives.length },
};

await mkdir("data", { recursive: true });
const status = { updated: new Date().toISOString(), results: {} };

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
  status.results.token = tokenRes.status + " " + (await tokenRes.text());
} else {
  const { access_token } = await tokenRes.json();
  status.results.token = "ok";
  for (const [name, path] of Object.entries(ROUTES)) {
    try {
      const res = await call(`${BASE}${path}?$format=JSON&$top=5000`, {
        headers: { authorization: "Bearer " + access_token },
      });
      if (!res.ok) {
        status.results[name] = res.status + " " + (await res.text()).slice(0, 300);
        continue;
      }

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        status.results[name] = "invalid json"; // 不是合法 JSON，保留舊檔
        continue;
      }

      let out = text;
      const trimmer = TRIMMERS[name];
      if (trimmer) {
        const trimmed = trimmer.fn(json);
        const n = trimmer.count(trimmed);
        status.results[name + "_kept"] = n;
        if (n > 0) out = JSON.stringify(trimmed); // 篩完是空的就存原始資料，避免網站變空白
      }

      await writeFile(`data/${name}.json`, out); // 成功才覆蓋舊檔
      status.results[name] = "ok";
    } catch (e) {
      status.results[name] = "error " + e;
    }
  }
}

await writeFile("data/status.json", JSON.stringify(status, null, 2));
console.log(JSON.stringify(status, null, 2));

// 只檢查抓取結果（忽略 xxx_kept 這類數字），有失敗就讓 Actions 顯示紅色 ✗
const failed = Object.entries(status.results).some(([k, v]) => !k.endsWith("_kept") && v !== "ok");
if (failed) process.exitCode = 1;
