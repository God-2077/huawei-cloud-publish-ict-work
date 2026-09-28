#!/usr/bin/env node
// submit-ict-work.mjs — ICT 大赛 AI 赛题作品提交封装（Windows UTF-8 参数绕开 PowerShell 编码，fail-stop）
//
// 调 A1 POST /open-api-public/v1/gallery/competition/works（经本目录副本 api.mjs）：
//   - multipart 表单：trainingCampId/problemId/workName/gitUrl/gitBranch（2026-09-17 简化：无封面/详情/envUrl）
//   - Idempotency-Key 幂等（与服务端去重一致）
//   - 身份：生产由 APIG 网关注入 X-Domain-Id（经 STS 凭证解析）；本地/网关后联调可用 domainId 参数经 --header 透传
//   - 凭证：accessKeyId/secretAccessKey/securityToken **必填**（Step 0 sts-creds.json）落盘为 creds 文件（不经 argv，
//     规避超长 token 截断）；含 _refresh 元数据时启用 401 自动刷新（复用 api.mjs --auto-refresh）
//   - 积分：A1 不领取成长积分（2026-09-17 白名单机制移除），201 响应无 reward 字段
//
// 用法: node submit-ict-work.mjs <utf8-params.json> [--max-age <秒>]
// 退出码: 0=提交成功(201); 1=校验/提交失败; 2=参数错误

import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
if (isWin) {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cli = { json: null, api: path.join(thisDir, "api.mjs"), maxAge: 0 };

const PARAMS_SCHEMA_HELP = `提交参数 JSON 仅识别以下 key（脚本直接解构，key 名写错会报「缺少必要字段」）：

{
  "idempotencyKey":  "<ict-submit-<problemId>-<Date.now()>> 幂等键，必填（一题一提交唯一；重提时用新键）",
  "problemId":       "<赛题 ID（A0 查询所得）>                      必填",
  "trainingCampId":  "<A0 按 problemId 返回的活动 ID>              必填",
  "workName":        "<作品名称>                                   必填",
  "gitUrl":          "<git clone 地址，https:// 开头 .git 结尾>     必填",
  "gitBranch":       "<分支名>                                    必填",
  "domainId":        "<调用方 domainId，透传 X-Domain-Id>           可选（仅本地/网关后联调）",
  "accessKeyId":     "<STS 临时凭证 AK，Step 0 落盘 sts-creds.json> 必填（生成本 skill 身份）",
  "secretAccessKey": "<STS 临时凭证 SK>                            必填",
  "securityToken":   "<STS Security Token>                        必填",
  "_refresh":        "{accountId, agencyUrn, region} 401 自动刷新  可选"
}`;

const VALID_PARAM_KEYS = new Set([
  "idempotencyKey", "problemId", "trainingCampId", "workName",
  "gitUrl", "gitBranch", "domainId",
  "accessKeyId", "secretAccessKey", "securityToken", "_refresh",
]);

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") {
    console.log("用法: node submit-ict-work.mjs <utf8-params.json> [--api <api.mjs>]");
    console.log(PARAMS_SCHEMA_HELP);
    process.exit(0);
  } else if (a === "--api") cli.api = argv[++i];
  else if (a === "--params") cli.json = argv[++i];
  else if (!cli.json) cli.json = argv[i];
}
if (!cli.json) {
  console.error("用法: node submit-ict-work.mjs <utf8-params.json> [--api <api.mjs>]");
  process.exit(2);
}

// 兼容 UTF-8 BOM（PowerShell `Set-Content -Encoding UTF8` 5.1 会写 BOM → JSON.parse 报错）
let paramsRaw = readFileSync(cli.json, "utf8");
if (paramsRaw.charCodeAt(0) === 0xfeff) paramsRaw = paramsRaw.slice(1);
const p = JSON.parse(paramsRaw);
const {
  idempotencyKey, problemId, trainingCampId, workName,
  gitUrl, gitBranch,
  domainId, accessKeyId, secretAccessKey, securityToken, _refresh,
} = p;

const unknownKeys = Object.keys(p).filter((k) => !VALID_PARAM_KEYS.has(k));
if (unknownKeys.length) {
  console.error(`❌ 参数 JSON 含未知 key: ${unknownKeys.join(", ")}`);
  console.error(PARAMS_SCHEMA_HELP);
  process.exit(2);
}
const REQUIRED_FIELDS = ["idempotencyKey", "problemId", "trainingCampId", "workName",
  "gitUrl", "gitBranch", "accessKeyId", "secretAccessKey", "securityToken"];
const missing = REQUIRED_FIELDS.filter((k) => !p[k]);
if (missing.length) {
  console.error(`❌ 参数 JSON 缺少必要字段: ${missing.join(", ")}`);
  console.error(PARAMS_SCHEMA_HELP);
  process.exit(2);
}

if (!workName || workName.length > 30) {
  console.error("❌ workName 必填且 ≤30 字符（真题库同名作品占名，见 clash 排查）");
  process.exit(2);
}

// 构造请求参数（args）
const args = [cli.api, "POST", "/v1/gallery/competition/works",
  "--idempotency-key", idempotencyKey,
  "--form", `trainingCampId=${trainingCampId}`,
  "--form", `problemId=${problemId}`,
  "--form", `workName=${workName}`,
  "--form", `gitUrl=${gitUrl}`,
  "--form", `gitBranch=${gitBranch}`];

if (domainId) args.push("--header", `X-Domain-Id: ${domainId}`);

// 凭证落盘 → api.mjs --creds-file（不经 argv）; 含 _refresh 时启用 401 自动刷新
let credsFile = "";
if (accessKeyId && secretAccessKey && securityToken) {
  credsFile = path.join(os.tmpdir(), `ict-sts-creds-${process.pid}.json`);
  const credsObj = { accessKeyId, secretAccessKey, securityToken };
  if (_refresh && _refresh.accountId && _refresh.agencyUrn && _refresh.region) credsObj._refresh = _refresh;
  try {
    writeFileSync(credsFile, JSON.stringify(credsObj), "utf8");
  } catch (e) {
    console.error(`无法写临时凭证文件: ${e.message}`); process.exit(2);
  }
  args.push("--creds-file", credsFile);
  if (_refresh) args.push("--auto-refresh");
}

console.log(`提交 ICT 大赛作品「${workName}」（赛题 ${problemId}）...`);

// ===== 失败操作指引（stderr，不污染 stdout 契约）=====
// 原则：失败原因的**中文文案**以服务端响应原样透传（competition 错误体 `reason`，其余 `message`/`reason`），
// skill 不再重复定义同一份文案（避免与服务端不一致）。
// 这里仅保留服务端给不出的「下一步操作指引」——A1 校验读 gallery 侧 registration_caches 缓存，不实时回源 ICT；
// 用户在 ICT 侧换赛道/重组队后缓存未更新 → 403，须在落地页刷新组队信息（C1 ?refresh=1 回源）后再提交。
const SITE_HOST = process.env.GALLERY_API_HOST || "gallery.developer.huaweicloud.com";
const SITE_PROTO = (process.env.GALLERY_API_PROTOCOL || "https").toLowerCase();
const SITE_URL = `${SITE_PROTO}://${SITE_HOST}`;

// code → 操作指引（不重复 `reason`，只给服务端给不了的下一步动作）
function operationGuideFor(code) {
  switch (code) {
    case "GALLERY.PARAM.GIT_URL_EXAMPLE_REPO":
      return [
        "该代码仓库属于平台示例/演示仓库，不能作为赛题作品提交。",
        "请回到【选择项目目录】步骤，重新选择您自己开发的赛题作品目录后提交。",
        "请勿 fork 示例仓库、请勿拆分/另推示例内容为个人仓库后提交（仍需提交自研作品）。",
      ].join(" ");
    case "GALLERY.COMPETITION.PROBLEM_TRACK_MISMATCH":
    case "GALLERY.COMPETITION.NOT_REGISTERED":
      return `若你已在 ICT 平台更换赛道/重新组队，本平台报名缓存可能未更新，请到 ${SITE_URL}/gallery/competition 落地页「我的参赛状态」栏点击「刷新组队信息」按钮重新拉取，确认赛道后重新提交。`;
    case "GALLERY.COMPETITION.ALREADY_PASSED":
      return `请到 ${SITE_URL}/gallery/competition/problems 做题面板查看判题结果。`;
    case "GALLERY.COMPETITION.JUDGING":
      return "请等待判题结果回传后在做题面板查看。";
    case "GALLERY.COMPETITION.CAMP_MISMATCH":
      return "trainingCampId 须为 A0 接口按 problemId 返回的活动，请用其重新提交。";
    case "GALLERY.IDEMPOTENCY.CONFLICT":
      return "请重新生成参数（新 Idempotency-Key）后重试。";
    case "GALLERY.AUTH.UNAUTHORIZED":
      return "请重新生成 STS 临时凭证（gen_sts.py）后重试。";
    case "GALLERY.WORK.PUBLISH_RATE_LIMITED":
      return "提交过于频繁被限流，请稍后重试。";
    default:
      return "";
  }
}

// 解析 api.mjs 原始输出（`#status=<code>` + JSON body），透传服务端原因 + 按 code 补操作指引（stderr）
// 仅吃 stdout（api.mjs 响应体）；stderr 的「STS 自动刷新」等日志不参与解析，避免污染 JSON。
function emitFailureHint(rawOut) {
  let code = "";
  let reason = "";
  try {
    const jsonMatch = rawOut.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const resp = JSON.parse(jsonMatch[0]);
      code = resp?.code ?? "";
      reason = resp?.reason ?? resp?.message ?? "";
    }
  } catch {
    /* 非 JSON 响应不解析 */
  }
  const detail = reason || code || "请参照上方响应排查";
  const guide = operationGuideFor(code);
  if (guide) console.error(`❌ 提交被拒绝（${code}）：${detail}\n   ${guide}`);
  else console.error(`❌ 提交被拒绝（${code}）：${detail}`);
}

try {
  const raw = execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const nlIdx = raw.indexOf("\n");
  const statusLine = nlIdx >= 0 ? raw.slice(0, nlIdx) : raw;
  const body = nlIdx >= 0 ? raw.slice(nlIdx + 1) : "";
  if (statusLine.includes("201")) {
    try {
      const resp = JSON.parse(body);
      const s = resp?.data?.submission;
      console.log(`#status=201`);
      console.log(`submissionId=${s?.submissionId ?? ""}`);
      console.log(`problemId=${s?.problemId ?? problemId}`);
      console.log(`attemptNo=${s?.attemptNo ?? ""}`);
      console.log(`judgeStatus=${s?.judgeStatus ?? ""}`);
      console.log(`workId=${s?.workId ?? ""}`);
      console.log(`workUrl=${s?.workUrl ?? ""}`);
    } catch {
      process.stdout.write(raw);
    }
  } else {
    // 非 201（2xx 但非 201，如 202/200）：原样输出完整响应供排查，stderr 输出中文原因 + 处置指引，exit 1
    process.stdout.write(raw);
    emitFailureHint(raw);
    try { if (credsFile) unlinkSync(credsFile); } catch {}
    console.error("提交未返回 201（预期创建成功状态码）");
    process.exit(1);
  }
  try { if (credsFile) unlinkSync(credsFile); } catch {}
  process.exit(0);
} catch (e) {
  const raw = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  process.stdout.write(e.stdout?.toString() || "");
  emitFailureHint(raw);
  try { if (credsFile) unlinkSync(credsFile); } catch {}
  console.error("提交失败（api.mjs 非 2xx 或异常）");
  process.exit(1);
}