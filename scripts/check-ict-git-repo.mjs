#!/usr/bin/env node
// check-ict-git-repo.mjs — 检查赛题作品目录 git 仓库是否允许提交（ICT 专用，无 sync-src）
//
// SKILL.md Step 2 的「目标目录 git 检查」入口：读 workDir 的 .git + origin（不联网抓取），
// 剥离凭证后调后端 A3 `POST /open-api-guest/v1/gallery/competition/git-check`（免鉴权，复用
// skill api.mjs 的 GALLERY_API_HOST / --prefix open-api-guest）判定「示例仓库红线」。
// 判定完全来自后端配置（单一事实源），本脚本不做本地 host+path 规则副本。
//
// 用法:
//   node check-ict-git-repo.mjs <workDir>
//   node check-ict-git-repo.mjs <workDir> --api <api.mjs>
//
// stdout / 退出码:
//   exit 0:
//     #gitUrl=<https://… .git>   #allowed=1   （可提交；gitUrl 为剥离凭证后的安全 URL）
//   exit 1:
//     #gitAbsent=1               该目录无 .git / 非 git 仓库（提示改选已建远程仓库的目录）
//     #gitNoOrigin=1             有 .git 但未配置 origin 远程（本地扩展：可由 init-git-remote.mjs 自动建仓强推；
//                                上游 2026-09-30 起并入 #error=1，本仓库保留该分支供本地 CLI 使用）
//     #exampleRepo=1 frag=<host/path> gitUrl=<url>  （命中示例仓库红线，提示重选目录）
//     #error=1 …                 其他失败（git 读取失败 / A3 请求失败等）
//   exit 2: 参数错误

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let workDir = "";
let api = path.join(thisDir, "api.mjs");
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") {
    console.log(`check-ict-git-repo.mjs — 检查赛题目录 git 仓库是否允许提交

用法:
  node check-ict-git-repo.mjs <workDir> [--api <api.mjs>]

说明:
  读 workDir 的 .git + origin（本地），剥凭证后调 A3 git-check 判定示例仓库红线；
  判定规则由后端配置（ICT_FORBIDDEN_GIT_HOST_PATHS）唯一决定，本脚本不复制规则。

stdout（exit 0=放行 / 1=不放行或失败 / 2=参数错误）:
  #gitUrl=<https://…> #allowed=1
  #gitAbsent=1 | #gitNoOrigin=1 | #exampleRepo=1 frag=<host/path> | #error=1 …`);
    process.exit(0);
  } else if (a === "--api") api = argv[++i];
  else if (!workDir) workDir = a;
  else { console.error(`❌ 未知参数: ${a}`); process.exit(2); }
}
if (!workDir) { console.error("❌ 用法: node check-ict-git-repo.mjs <workDir>"); process.exit(2); }
if (!existsSync(workDir) || !existsSync(path.join(workDir, ".git"))) {
  console.log("#gitAbsent=1");
  console.error(`ℹ️ ${workDir} 无 .git 目录（非 git 仓库）。赛题作品需提交到您自己的 git 远程仓库后提交；请改选已建仓目录。`);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", ["-C", workDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let rawUrl;
try {
  rawUrl = git(["remote", "get-url", "origin"]);
} catch (e) {
  // 本地扩展（上游已并入 #error=1）：区分「无 origin」与「读取失败」，
  // 供本地 CLI --git-url 走 init-git-remote.mjs 自动建仓强推。
  const msg = (e.stderr?.toString() || e.message || "").trim();
  if (/No such remote|does not appear to be a git repository|no such remote/i.test(msg) || !msg) {
    console.log("#gitNoOrigin=1");
    console.error(
      `ℹ️ ${workDir} 的 git 仓库未配置 origin 远程（或读取失败）。` +
        `\n   可提供 git 地址（ssh/https，如 git@gitcode.com:<ns>/<repo>.git），由 init-git-remote.mjs 自动` +
        `\n   git init / remote add / 提交 / 强制推送，并把 origin 改回 https；无需重新选择目录。`,
    );
    process.exit(1);
  }
  console.log("#error=1");
  console.error(`❌ 读取 git origin 失败：${workDir}\n${msg}`);
  process.exit(1);
}

// 剥凭证 + ssh/git→https 自动派生 + 硬校验（与 read-git-info/strip-git-credential 同语义）
// 本地扩展：origin 为 ssh/git 协议时自动派生成 https 形态，避免"须 https:// 开头"误拦（A3 只接受 https）
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
let safeUrl = rawUrl.replace(/^(https?:\/\/)[^/@]+@/, "$1");
const converted = sshToHttps(safeUrl);
if (converted) safeUrl = converted;
if (!safeUrl.startsWith("https://") || !safeUrl.endsWith(".git") || safeUrl.includes("@")) {
  console.log("#error=1");
  console.error(`❌ gitUrl 不合规（须 https:// 开头、.git 结尾、无内嵌凭证；ssh/git 形态会自动转为 https）: ${safeUrl}`);
  process.exit(1);
}

// 调后端 A3（open-api-guest 免鉴权，无需 STS）
let out;
try {
  out = execFileSync(process.execPath, [api, "POST", "/v1/gallery/competition/git-check",
    "--prefix", "open-api-guest", "--json", JSON.stringify({ gitUrl: safeUrl })],
    { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  const errOut = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  console.log("#error=1");
  console.error(`❌ A3 git-check 请求失败：${workDir}\n${errOut || (e.message || "")}`);
  process.exit(1);
}

const nlIdx = out.indexOf("\n");
const statusLine = nlIdx >= 0 ? out.slice(0, nlIdx) : out;
const body = nlIdx >= 0 ? out.slice(nlIdx + 1) : "";
let resp;
try { resp = JSON.parse(body); } catch { resp = null; }
if (!statusLine.includes("200") || !resp?.data) {
  console.log("#error=1");
  process.stdout.write(out || "A3 git-check 响应解析失败\n");
  process.exit(1);
}

const d = resp.data;
if (d.allowed === false) {
  console.log(`#exampleRepo=1 frag=${d.host ?? ""}${d.pathPrefix ?? ""} gitUrl=${safeUrl}`);
  console.error(
    `ℹ️ 该目录代码仓库（${safeUrl}）命中平台示例/演示仓库（${d.host ?? ""}${d.pathPrefix ?? ""}），示例仓库不能作为赛题作品提交。` +
    `\n   请回到【选择项目目录】步骤，重新选择您自己开发的赛题作品目录后提交；请勿 fork/拆分/另推示例仓库内容作为个人作品提交。`,
  );
  process.exit(1);
}
console.log(`#gitUrl=${safeUrl}`);
console.log("#allowed=1");
process.exit(0);