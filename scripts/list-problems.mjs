#!/usr/bin/env node
// list-problems.mjs — 查询 ICT 大赛全部 AI 赛题（调 A0 GET /open-api-public/v1/gallery/competition/camps）
// 经副本 api.mjs 发起 REST，解析 data.items 投影为可选行；供 agent 向用户展示赛题列表并选择 problemId。
//
// 用法:
//   node list-problems.mjs [--api <api.mjs>] [--creds-file <json>] [--header "Name: v"]
//
// 成功 exit 0，stdout:
//   #status=<code>
//   #problem <n> <problemId> <trainingCampId> <name> [window=<start>~<end> status=<s>]   （A0 返回窗口字段时附带）
//   空列表 exit 1: `#none`（当前无可用 AI 赛题）
//   请求失败 exit 1: 原样输出 api.mjs 响应（首行 #status）
// 参数错误 exit 2。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));
function printHelp() {
  console.log(`list-problems.mjs — 查询 ICT 大赛全部 AI 赛题（A0 /competition/camps）

用法:
  node list-problems.mjs [--api <api.mjs>] [--creds-file <json>] [--header "Name: v"]

选项:
  --api <f>            api.mjs 路径（默认同目录副本）
  --creds-file <json>  STS 凭证文件，透传 api.mjs（open-api-public 前缀需要）
  --header "N: v"      额外请求头（如 X-Domain-Id），可叠加

stdout: #status=<code> 开头；随后每行 #problem <n> <problemId> <trainingCampId> <name>
退出码: 0=成功; 1=无赛题或请求失败; 2=参数错误`);
}

const argv = process.argv.slice(2);
const cli = { api: path.join(thisDir, "api.mjs"), headers: [], creds: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  else if (a === "--api") cli.api = argv[++i];
  else if (a === "--creds-file") cli.creds = argv[++i];
  else if (a === "--header") cli.headers.push(argv[++i]);
  else { console.error(`❌ 未知参数: ${a}`); process.exit(2); }
}

const baseArgs = [cli.api, "GET", "/v1/gallery/competition/camps"];
if (cli.creds) baseArgs.push("--creds-file", cli.creds);
for (const h of cli.headers) baseArgs.push("--header", h);

let raw;
try {
  raw = execFileSync(process.execPath, baseArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  process.stdout.write(out || "调用 api.mjs 失败\n");
  process.exit(1);
}

const nlIdx = raw.indexOf("\n");
const statusLine = nlIdx >= 0 ? raw.slice(0, nlIdx) : raw;
const body = nlIdx >= 0 ? raw.slice(nlIdx + 1) : "";

let resp;
try {
  resp = JSON.parse(body);
} catch {
  process.stdout.write(raw);
  process.exit(1);
}
if (statusLine.includes("200") && Array.isArray(resp?.data?.items)) {
  const items = resp.data.items;
  if (items.length === 0) {
    console.log("#status=200");
    console.log("#none");
    console.error("当前没有任何可提交的 ICT 大赛 AI 赛题。");
    process.exit(1);
  }
  console.log(statusLine);
  const seen = new Set();
  let n = 0;
  for (const it of items) {
    const pid = it.problemId ?? "";
    if (seen.has(pid)) continue;
    seen.add(pid);
    n++;
    const win = it.startsAt || it.endsAt ? ` window=${it.startsAt ?? "?"}~${it.endsAt ?? "?"} status=${it.status ?? "?"}` : "";
    console.log(`#problem ${n} ${pid} ${it.trainingCampId ?? ""} ${it.name ?? ""}${win}`);
  }
  console.error(`共 ${n} 道 AI 赛题。`);
  process.exit(0);
}
// 非 200 / 结构不符 → 原样输出供排查
process.stdout.write(raw);
process.exit(1);