// tools/push_data.js —— 将本地 data/*.json 直推 GitHub Pages 镜像（快进提交，不重写历史）
// 用途：① 本地播种真实数据（打破"镜像里只有反推值"的死循环）；② 供 GitHub Actions 每 15 分钟
//       生成真实数据后推送（平台沙箱墙了东财，Actions 跑在 GitHub Runner 上可通东财）。
// 与 deploy_github.js 的区别：只推 data/，不动 dist-ghpages。
const fs = require("fs");
const path = require("path");

// 优先用显式 GH_TOKEN（本地播种/平台兜底）；在 GitHub Actions 中回退到自动提供的 GITHUB_TOKEN
// （需 workflow 授予 contents: write 权限，且 main 分支未保护）。
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO = "metal-price-monitor";
const OWNER = "zsyong2026";
const API = "https://api.github.com";
const DATA_DIR = path.join(__dirname, "..", "data");

async function api(method, url, body) {
  const r = await fetch(API + url, {
    method,
    headers: Object.assign({ Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  if (!r.ok) throw new Error(method + " " + url + " -> HTTP " + r.status + " " + t.slice(0, 200));
  return j;
}

async function main() {
  if (!TOKEN) throw new Error("缺少 GH_TOKEN");
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) throw new Error("data/ 为空");
  console.log("[push_data] 待推送文件:", files.join(", "));
  const entries = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(DATA_DIR, f));
    const b = await api("POST", "/repos/" + OWNER + "/" + REPO + "/git/blobs", { content: buf.toString("base64"), encoding: "base64" });
    entries.push({ path: "data/" + f, mode: "100644", type: "blob", sha: b.sha });
  }
  async function pushTree(attempt) {
    const refNow = await api("GET", "/repos/" + OWNER + "/" + REPO + "/git/ref/heads/main");
    const baseCommit = refNow.object.sha;
    const baseInfo = await api("GET", "/repos/" + OWNER + "/" + REPO + "/git/commits/" + baseCommit);
    const tree = await api("POST", "/repos/" + OWNER + "/" + REPO + "/git/trees", { base_tree: baseInfo.tree.sha, tree: entries });
    const commit = await api("POST", "/repos/" + OWNER + "/" + REPO + "/git/commits", {
      message: "data: 真实数据推送 " + new Date().toISOString(), tree: tree.sha, parents: [baseCommit],
    });
    try {
      await api("PATCH", "/repos/" + OWNER + "/" + REPO + "/git/refs/heads/main", { sha: commit.sha });
      return commit.sha;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log("   ! ref 已前进，重试：" + e.message.slice(0, 80));
      return pushTree(attempt + 1);
    }
  }
  const sha = await pushTree(1);
  console.log("[push_data] 已推送 data/ (commit=" + sha.slice(0, 8) + ")");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
