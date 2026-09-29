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
      if (res.ok) {
        await writeFile(`data/${name}.json`, await res.text()); // 成功才覆蓋舊檔
        status.results[name] = "ok";
      } else {
        status.results[name] = res.status + " " + (await res.text()).slice(0, 300);
      }
    } catch (e) {
      status.results[name] = "error " + e;
    }
  }
}

await writeFile("data/status.json", JSON.stringify(status, null, 2));
console.log(JSON.stringify(status, null, 2));
const failed = Object.values(status.results).some((v) => v !== "ok");
if (failed) process.exitCode = 1; // 有任何一項失敗就讓 Actions 顯示紅色 ✗
