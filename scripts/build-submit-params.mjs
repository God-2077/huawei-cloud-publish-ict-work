#!/usr/bin/env node
// build-submit-params.mjs — 装配 submit-ict-work.mjs 的 UTF-8 提交参数 JSON
// ICT 大赛专用（与其他 skill 无共享，无 sync-src）。
//
// 背景:
//   SKILL.md Step 4 原由 agent 手工把 sts-creds.json 的三字段（accessKeyId/secretAccessKey/securityToken）
//   与 _refresh 抄进提交参数 JSON——手抄超长 token 易出错/截断。本脚本一步生成：
//     * 读 sts-creds.json（Step 0 产物）注入凭证
//     * 计算 Idempotency-Key（可覆盖）
//     * 写 UTF-8 无 BOM 的 params.json（供 submit-ict-work.mjs）
// v2026-09-30 目标校验（防错投）：
//     * --problem-name 必填：与 Step 1 目标锁（.ict-target.json）三方一致校验，禁止静默改投
//     * 调 A0（camps?problemId=）交叉校验 problemId ↔ 赛题名 / trainingCampId，杜绝 ID 行级混淆
//     * 目标锁带 createdAt，超过 STS 凭证有效期（900s）视为过期作废 → 新提交仅做 A0 校验
//
// 用法:
//   node build-submit-params.mjs \
//     --out <params.json> --problem-id <id> --training-camp <id> --problem-name <name> \
//     --work-name <name> --git-url <url> --git-branch <branch> \
//     --creds sts-creds.json [--api <api.mjs>] [--lock-file <f>] \
//     [--domain-id <id>] [--idempotency-key <key>] [--no-refresh]
//
// stdout:
//   #params=<absPath>
//
// 退出码: 0=成功; 1=creds 缺失/A0 校验失败; 2=参数错/锁不一致/名称或活动不匹配

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cli = { out: null, problemId: null, trainingCamp: null, problemName: null, workName: null, gitUrl: null, gitBranch: null, creds: null, domainId: null, idem: null, noRefresh: false, api: path.join(thisDir, "api.mjs"), lockFile: null };
const help = `build-submit-params.mjs — 装配 submit 参数 JSON

用法:
  node build-submit-params.mjs --out <json> --problem-id <id> --training-camp <id> --problem-name <name> \\
    --work-name <name> --git-url <url> --git-branch <branch> --creds <sts-creds.json> \\
    [--api <api.mjs>] [--lock-file <f>] [--domain-id <id>] [--idempotency-key <key>] [--no-refresh]

选项:
  --out <json>            输出参数文件（必填）
  --problem-id <id>       赛题 ID（Step 1 #selected 取得，必填）
  --training-camp <id>    活动 ID（Step 1 #selected 取得，必填）
  --problem-name <name>   赛题名（Step 1 #selected 的 name，必填；与目标锁 + A0 交叉校验）
  --work-name <name>      作品名（≤30 字符，必填）
  --git-url <url>         git clone 地址（https:// + .git，必填）
  --git-branch <branch>   分支名（必填）
  --creds <file>          Step 0 的 sts-creds.json（必填）
  --api <f>               api.mjs 路径（默认同目录副本，A0 校验用）
  --lock-file <f>         目标锁路径（默认同 --creds 目录 .ict-target.json；缺失则跳过锁校验）
  --domain-id <id>        透传 X-Domain-Id（仅本地/联调）
  --idempotency-key <key> 默认 ict-submit-<problemId>-<Date.now()>；重提务必传新键
  --no-refresh            不带 _refresh（跳过 401 自动刷新元数据）

stdout: #params=<absPath>
退出码: 0=成功; 1=creds 缺失/A0 校验失败; 2=参数错/锁不一致/名称或活动不匹配`;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") { console.log(help); process.exit(0); }
  else if (a === "--out") cli.out = argv[++i];
  else if (a === "--problem-id") cli.problemId = argv[++i];
  else if (a === "--training-camp") cli.trainingCamp = argv[++i];
  else if (a === "--problem-name") cli.problemName = argv[++i];
  else if (a === "--work-name") cli.workName = argv[++i];
  else if (a === "--git-url") cli.gitUrl = argv[++i];
  else if (a === "--git-branch") cli.gitBranch = argv[++i];
  else if (a === "--creds") cli.creds = argv[++i];
  else if (a === "--api") cli.api = argv[++i];
  else if (a === "--lock-file") cli.lockFile = argv[++i];
  else if (a === "--domain-id") cli.domainId = argv[++i];
  else if (a === "--idempotency-key") cli.idem = argv[++i];
  else if (a === "--no-refresh") cli.noRefresh = true;
  else { console.error(`❌ 未知参数: ${a}`); process.exit(2); }
}

// 本地扩展：错误提示按真实 CLI 参数名输出（上游此处对 problemName 会打印成 --problemName）
const OPT_NAME = { out: "out", problemId: "problem-id", trainingCamp: "training-camp", problemName: "problem-name", workName: "work-name", gitUrl: "git-url", gitBranch: "git-branch", creds: "creds" };
for (const [k, v] of Object.entries({ out: cli.out, problemId: cli.problemId, trainingCamp: cli.trainingCamp, problemName: cli.problemName, workName: cli.workName, gitUrl: cli.gitUrl, gitBranch: cli.gitBranch, creds: cli.creds })) {
  if (!v) { console.error(`❌ 缺少必要参数 --${OPT_NAME[k]}`); console.error(help); process.exit(2); }
}
if (cli.workName.length > 30) { console.error("❌ workName ≤30 字符"); process.exit(2); }
// 本地扩展：gitUrl 为 ssh/git 协议时自动派生成 https 形态（平台只接受 https://… .git），不再因 origin 是 ssh 而报错
function sshToHttps(url) {
  let m = url.match(/^[^@\s/]+@([^:\s/]+):(\S+\.git)$/);
  if (m) {
    const pathPart = m[2].replace(/^[^@\s/]*@/, "");
    return `https://${m[1]}/${pathPart}`;
  }
  m = url.match(/^(?:ssh|git):\/\/(?:[^@\s/]+@)?([^/\s:]+)(?::\d+)?\/(\S+\.git)$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}
const httpsUrl = sshToHttps(cli.gitUrl) ?? cli.gitUrl.replace(/^(https?:\/\/)[^/@]+@/, "$1");
if (httpsUrl !== cli.gitUrl) {
  console.error(`ℹ️ gitUrl 为 ssh/git 协议，已自动转为 https 提交：${httpsUrl}`);
  cli.gitUrl = httpsUrl;
}
if (!cli.gitUrl.startsWith("https://") || !cli.gitUrl.endsWith(".git") || cli.gitUrl.includes("@")) {
  console.error(`❌ gitUrl 不合规（须 https:// + .git + 无凭证；ssh/git 形态会自动转为 https）: ${cli.gitUrl}`); process.exit(2);
}

/// ---- 目标锁一致性（禁静默改投）----
// 过期锁（> STS 凭证有效期 900s）视为作废 → 跳过锁校验（新一次提交流程），仍走 A0 校验。
const LOCK_STALE_MS = 900_000;
function lockIsStale(lock) {
  if (!lock?.createdAt || typeof lock.createdAt !== "string") return false; // 旧格式无时间戳 → 视为有效
  const t = Date.parse(lock.createdAt);
  return Number.isFinite(t) && Date.now() - t > LOCK_STALE_MS;
}
function defaultLockFile() {
  return path.join(path.dirname(path.resolve(cli.creds)), ".ict-target.json");
}
const lockPath = cli.lockFile ?? defaultLockFile();
let lock = null;
try {
  const raw = readFileSync(lockPath, "utf8");
  lock = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
} catch { /* 锁缺失/损坏 → 跳过锁校验（仍走 A0 校验）*/ }
if (lock?.problemId && !lockIsStale(lock)) {
  const diffs = [];
  if (lock.problemId !== cli.problemId) diffs.push(`problemId=${lock.problemId}`);
  if (lock.trainingCampId && lock.trainingCampId !== cli.trainingCamp) diffs.push(`trainingCampId=${lock.trainingCampId}`);
  if (lock.name && lock.name.trim() !== cli.problemName.trim()) diffs.push(`name="${lock.name}"`);
  if (diffs.length) {
    console.error(`❌ 提交目标已锁定为赛题 ${lock.number ?? "?"}「${lock.name ?? ""}」（${diffs.join(", ")}），与传入参数不一致。`);
    console.error(`   禁止改投其他赛题。如用户确需改投：回 Step 1 重新 list-problems --select，并经用户确认后加 --force 后重新生成参数。`);
    process.exit(2);
  }
}

/// ---- A0 交叉校验：problemId ↔ 赛题名 / trainingCampId ----
let raw;
try {
  raw = execFileSync(process.execPath, [cli.api, "GET", "/v1/gallery/competition/camps", "--query", `problemId=${encodeURIComponent(cli.problemId)}`, "--creds-file", cli.creds], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  console.error(`❌ A0 校验失败（无法验证 problemId）：${out.split("\n")[0] || "调用 api.mjs 失败"}`);
  process.exit(1);
}
const statusLine = raw.split("\n")[0] ?? "";
let obj = null;
try {
  const resp = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
  obj = resp?.data?.items?.[0] ?? resp?.data ?? null;
} catch { /* 非 JSON → obj 留空 */ }
if (!obj || typeof obj.name !== "string" || !statusLine.includes("200")) {
  console.error(`❌ problemId ${cli.problemId} 未在 A0 查询到赛题（PROBLEM_UNAVAILABLE），拒绝构建参数。`);
  console.error(`   请回 Step 1 用 list-problems.mjs --select 确认目标赛题（禁止改投其他赛题，除非用户明确同意）。`);
  process.exit(2);
}
if (obj.name.trim() !== cli.problemName.trim()) {
  console.error(`❌ problemId ${cli.problemId} 对应赛题为「${obj.name}」，与 --problem-name「${cli.problemName}」不一致，拒绝构建参数。`);
  console.error(`   请回 Step 1 核对 list-problems --select 所选目标（禁止改投其他赛题，除非用户明确同意）。`);
  process.exit(2);
}
if (obj.trainingCampId && obj.trainingCampId !== cli.trainingCamp) {
  console.error(`❌ trainingCampId 与 problemId 对应活动不一致（A0 返回 ${obj.trainingCampId}），拒绝构建参数。`);
  process.exit(2);
}

let creds;
try {
  // 兼容 UTF-8 BOM（PowerShell `Set-Content -Encoding UTF8` 5.1 会写 BOM）
  let credsRaw = readFileSync(cli.creds, "utf8");
  if (credsRaw.charCodeAt(0) === 0xfeff) credsRaw = credsRaw.slice(1);
  creds = JSON.parse(credsRaw);
} catch (e) {
  console.error(`❌ 读取 sts-creds.json 失败: ${cli.creds}（${e instanceof Error ? e.message : e}）`);
  process.exit(1);
}
const { accessKeyId, secretAccessKey, securityToken, _refresh } = creds;
if (!accessKeyId || !secretAccessKey || !securityToken) {
  console.error("❌ sts-creds.json 缺 accessKeyId/secretAccessKey/securityToken");
  process.exit(1);
}

const params = {
  idempotencyKey: cli.idem ?? `ict-submit-${cli.problemId}-${Date.now()}`,
  problemId: cli.problemId,
  trainingCampId: cli.trainingCamp,
  workName: cli.workName,
  gitUrl: cli.gitUrl,
  gitBranch: cli.gitBranch,
};
if (cli.domainId) params.domainId = cli.domainId;
params.accessKeyId = accessKeyId;
params.secretAccessKey = secretAccessKey;
params.securityToken = securityToken;
if (!cli.noRefresh && _refresh && _refresh.accountId && _refresh.agencyUrn && _refresh.region) params._refresh = _refresh;

try {
  writeFileSync(cli.out, JSON.stringify(params, null, 2), "utf8"); // 无 BOM
} catch (e) {
  console.error(`❌ 写入参数文件失败: ${cli.out}（${e instanceof Error ? e.message : e}）`);
  process.exit(1);
}
console.log(`#params=${path.resolve(cli.out)}`);
process.exit(0);