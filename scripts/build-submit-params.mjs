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
//
// 用法:
//   node build-submit-params.mjs \
//     --out <params.json> --problem-id <id> --training-camp <id> \
//     --work-name <name> --git-url <url> --git-branch <branch> \
//     --creds sts-creds.json [--domain-id <id>] [--idempotency-key <key>] [--no-refresh]
//
// stdout:
//   #params=<absPath>
//
// 退出码: 0=成功; 1=creds 缺失/字段缺; 2=参数错误

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const argv = process.argv.slice(2);
const cli = { out: null, problemId: null, trainingCamp: null, workName: null, gitUrl: null, gitBranch: null, creds: null, domainId: null, idem: null, noRefresh: false };
const help = `build-submit-params.mjs — 装配 submit 参数 JSON

用法:
  node build-submit-params.mjs --out <json> --problem-id <id> --training-camp <id> \\
    --work-name <name> --git-url <url> --git-branch <branch> --creds <sts-creds.json> \\
    [--domain-id <id>] [--idempotency-key <key>] [--no-refresh]

选项:
  --out <json>            输出参数文件（必填）
  --problem-id <id>       赛题 ID（A0 取得，必填）
  --training-camp <id>    活动 ID（A0 取得，必填）
  --work-name <name>      作品名（≤30 字符，必填）
  --git-url <url>         git clone 地址（https:// + .git，必填）
  --git-branch <branch>   分支名（必填）
  --creds <file>          Step 0 的 sts-creds.json（必填）
  --domain-id <id>        透传 X-Domain-Id（仅本地/联调）
  --idempotency-key <key> 默认 ict-submit-<problemId>-<Date.now()>；重提务必传新键
  --no-refresh            不带 _refresh（跳过 401 自动刷新元数据）

stdout: #params=<absPath>
退出码: 0=成功; 1=creds 缺失/字段缺; 2=参数错误`;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") { console.log(help); process.exit(0); }
  else if (a === "--out") cli.out = argv[++i];
  else if (a === "--problem-id") cli.problemId = argv[++i];
  else if (a === "--training-camp") cli.trainingCamp = argv[++i];
  else if (a === "--work-name") cli.workName = argv[++i];
  else if (a === "--git-url") cli.gitUrl = argv[++i];
  else if (a === "--git-branch") cli.gitBranch = argv[++i];
  else if (a === "--creds") cli.creds = argv[++i];
  else if (a === "--domain-id") cli.domainId = argv[++i];
  else if (a === "--idempotency-key") cli.idem = argv[++i];
  else if (a === "--no-refresh") cli.noRefresh = true;
  else { console.error(`❌ 未知参数: ${a}`); process.exit(2); }
}

for (const [k, v] of Object.entries({ out: cli.out, problemId: cli.problemId, trainingCamp: cli.trainingCamp, workName: cli.workName, gitUrl: cli.gitUrl, gitBranch: cli.gitBranch, creds: cli.creds })) {
  if (!v) { console.error(`❌ 缺少必要参数 --${k}`); console.error(help); process.exit(2); }
}
if (cli.workName.length > 30) { console.error("❌ workName ≤30 字符"); process.exit(2); }
if (!cli.gitUrl.startsWith("https://") || !cli.gitUrl.endsWith(".git") || cli.gitUrl.includes("@")) {
  console.error(`❌ gitUrl 不合规（https:// + .git + 无凭证）: ${cli.gitUrl}`); process.exit(2);
}

let creds;
try {
  // 兼容 UTF-8 BOM（PowerShell `Set-Content -Encoding UTF8` 5.1 会写 BOM）
  let raw = readFileSync(cli.creds, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  creds = JSON.parse(raw);
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