#!/usr/bin/env node
// init-git-remote.mjs — 作品目录无 .git / 无 origin 时：git init + remote + 提交 + 强推 + 改回 https
//
// 背景:
//   ICT 赛题作品必须托管在自己的 git 远程仓库。有时用户拿到的作品目录既没有 .git 也没有远程
//   地址，只能手工 git init / git remote add / commit / push，且赛题平台只认 https://… .git 的
//   gitUrl。本脚本把这条路一次封装：用户给一个 git 地址（ssh 或 https），脚本自动
//     git init（缺 .git 时）→ remote add/set-url origin → git add -A + commit（无提交历史/有改动时）
//     → git push -u --force origin <分支>（同名分支，强制覆盖）→ git remote set-url origin <https 版>
//   强推凭证完全交给 git 自身（ssh key / credential helper），脚本不额外处理；push 失败原样上报。
//
// 用法:
//   node init-git-remote.mjs <workDir> --remote <url> [--branch <name>] [--dry-run]
//   node init-git-remote.mjs --help
//
// --remote 支持:
//   git@<host>:<ns>/<repo>.git          （scp 式 ssh）
//   ssh://git@<host>/<ns>/<repo>.git    （ssh:// 协议式，可带 :端口）
//   git://<host>/<ns>/<repo>.git        （git:// 协议式）
//   https://<host>/<ns>/<repo>.git      （已是 https，原样使用）
//   其余（非 .git 结尾 / 含内嵌凭证 / 非上述形态）→ 参数错误
//
// stdout / 退出码:
//   exit 0:
//     #gitUrl=<https://… .git>  #gitBranch=<分支>  #pushed=1  [ #initialized=1 ]
//     （--dry-run: #dryRun=1，只打印将执行的命令，不落盘不推送）
//   exit 1: #error=1 reason=<init|commit|remote|push|set-url>（stderr 附原始输出）
//   exit 2: 参数错误

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const COMMIT_MSG = "chore: init ICT competition work";

const HELP = `init-git-remote.mjs — 无 .git/无 origin 时自动初始化并强推作品仓库

用法:
  node init-git-remote.mjs <workDir> --remote <url> [--branch <name>] [--dry-run]

--remote 支持:
  git@<host>:<ns>/<repo>.git          （scp 式 ssh）
  ssh://git@<host>/<ns>/<repo>.git    （ssh:// 协议式，可带 :端口）
  git://<host>/<ns>/<repo>.git        （git:// 协议式）
  https://<host>/<ns>/<repo>.git      （已是 https，原样使用）

行为:
  1. 校验/转换 URL，派生 https://… .git 形态
  2. 缺 .git 时 git init；配置 origin（add 或 set-url）
  3. 无提交历史或有未提交改动时 git add -A + commit
  4. git push -u --force origin <分支>（同名分支；凭证交给 git 自身）
  5. 推送成功后 git remote set-url origin <https 版>
  6. stdio 非交互（stdin=ignore），凭证缺失时 git 快速失败并原样上报

stdout（exit 0=成功 / 1=失败 / 2=参数错误）:
  #gitUrl=<https://… .git>  #gitBranch=<分支>  #pushed=1  [ #initialized=1 ]
  #dryRun=1（--dry-run：仅打印将执行的命令）
  #error=1 reason=<init|commit|remote|push|set-url>`;

// ---- 参数 ----
const argv = process.argv.slice(2);
let workDir = "";
let remoteUrl = "";
let branchArg = "";
let dryRun = false;
let help = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const eq = a.indexOf("=");
  let val = null;
  let key = a;
  if (a.startsWith("--") && eq > 2) { key = a.slice(0, eq); val = a.slice(eq + 1); }
  const next = () => (val !== null ? val : argv[++i]);
  if (key === "-h" || key === "--help") help = true;
  else if (key === "--remote") remoteUrl = next() || "";
  else if (key === "--branch") branchArg = next() || "";
  else if (key === "--dry-run") dryRun = true;
  else if (!workDir && !key.startsWith("--")) workDir = a;
  else { console.error(`❌ 未知参数: ${a}\n${HELP}`); process.exit(2); }
}

if (help) { console.log(HELP); process.exit(0); }
if (!workDir || !remoteUrl) {
  console.error("❌ 用法: node init-git-remote.mjs <workDir> --remote <url> [--branch <name>] [--dry-run]");
  process.exit(2);
}
if (!existsSync(workDir)) { console.error(`❌ workDir 不存在: ${workDir}`); process.exit(2); }

// ---- URL 校验与 https 派生 ----
function normalizeRemote(url) {
  // scp 式: git@host:ns/repo.git
  let m = url.match(/^[^@\s/]+@([^:\s/]+):(\S+\.git)$/);
  if (m) {
    const pathPart = m[2].replace(/^[^@\s/]*@/, ""); // 顺带剥离 ssh 形态里的 user:pass@
    return { remote: url, https: `https://${m[1]}/${pathPart}` };
  }
  // ssh:// 协议式: ssh://git@host[:port]/ns/repo.git；git:// 协议式: git://host/ns/repo.git
  m = url.match(/^(?:ssh|git):\/\/(?:[^@\s/]+@)?([^/\s:]+)(?::\d+)?\/(\S+\.git)$/);
  if (m) return { remote: url, https: `https://${m[1]}/${m[2]}` };
  // 已是 https
  if (/^https:\/\/[^\s@]+\.git$/.test(url)) return { remote: url, https: url };
  return null;
}

const norm = normalizeRemote(remoteUrl.trim());
if (!norm) {
  console.error(`❌ --remote 不合规（须 ssh 或 https、以 .git 结尾、无内嵌凭证）: ${remoteUrl}`);
  process.exit(2);
}
// https 二次硬校验（与 strip-git-credential 同门禁）
if (!norm.https.startsWith("https://") || !norm.https.endsWith(".git") || norm.https.includes("@")) {
  console.error(`❌ 无法派生合规的 https gitUrl: ${norm.https}`);
  process.exit(2);
}

// ---- git 执行封装 ----
function run(args) {
  return execFileSync("git", ["-C", workDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
  }).trim();
}
function tryRun(args) {
  try { return { ok: true, out: run(args), err: "" }; }
  catch (e) { return { ok: false, out: (e.stdout?.toString() || "").trim(), err: (e.stderr?.toString() || e.message || "").trim() }; }
}
function fail(reason, detail) {
  console.log(`#error=1 reason=${reason}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const inited = !existsSync(path.join(workDir, ".git"));

/** 分支名：--branch 或当前 HEAD（须在 git init 之后调用；fresh init 的未诞生分支也能读到） */
function detectBranch() {
  if (branchArg) return branchArg;
  const b = tryRun(["symbolic-ref", "--short", "HEAD"]);
  const name = b.ok && b.out ? b.out.split(/\r?\n/)[0].trim() : "";
  return name || "main";
}

// ---- dry-run：只打印计划（未 init 时分支名为预估，可能随 git init.defaultBranch 变化） ----
if (dryRun) {
  const branch = detectBranch();
  console.log(`#gitUrl=${norm.https}`);
  console.log(`#gitBranch=${branch}`);
  console.log("#dryRun=1");
  console.error(`[dry-run] 将执行（workDir=${workDir}）：`);
  if (inited) console.error(`  git init`);
  console.error(`  git remote add/set-url origin ${norm.remote}`);
  console.error(`  git add -A && git commit -m "${COMMIT_MSG}"（无历史或有改动时）`);
  console.error(`  git push -u --force origin ${branch}`);
  console.error(`  git remote set-url origin ${norm.https}`);
  process.exit(0);
}

// ---- 1. git init ----
if (inited) {
  const r = tryRun(["init"]);
  if (!r.ok) fail("init", `${r.err}\n${r.out}`);
}

// ---- 2. 分支（在 init 之后确定；--branch 时切换/创建） ----
const branch = detectBranch();
if (branchArg) {
  const r = tryRun(["checkout", "-B", branch]);
  if (!r.ok) fail("init", `切换到分支 ${branch} 失败：\n${r.err}\n${r.out}`);
}

// ---- 3. origin（add 或 set-url） ----
const remotes = tryRun(["remote"]);
const hasOrigin = remotes.ok && remotes.out.split(/\r?\n/).map((s) => s.trim()).includes("origin");
{
  const r = tryRun(hasOrigin ? ["remote", "set-url", "origin", norm.remote] : ["remote", "add", "origin", norm.remote]);
  if (!r.ok) fail("remote", `${r.err}\n${r.out}`);
}

// ---- 4. 提交（无 HEAD 或有改动） ----
const idArgs = [];
const hasEmail = tryRun(["config", "user.email"]);
const hasName = tryRun(["config", "user.name"]);
if (!(hasEmail.ok && hasEmail.out)) idArgs.push("-c", "user.email=ict-work@local");
if (!(hasName.ok && hasName.out)) idArgs.push("-c", "user.name=ICT-Work");

const headOk = tryRun(["rev-parse", "--verify", "HEAD"]).ok;
const dirty = tryRun(["status", "--porcelain"]);
const needsCommit = !headOk || (dirty.ok && dirty.out.length > 0);
if (needsCommit) {
  const a = tryRun(["add", "-A"]);
  if (!a.ok) fail("commit", `${a.err}\n${a.out}`);
  const c = tryRun([...idArgs, "commit", "-m", COMMIT_MSG]);
  if (!c.ok) {
    const head2 = tryRun(["rev-parse", "--verify", "HEAD"]);
    if (!head2.ok) fail("commit", `创建初始提交失败：\n${c.err}\n${c.out}`);
  }
}

// ---- 5. 强推同名分支 ----
{
  const p = tryRun(["push", "-u", "--force", "origin", branch]);
  if (!p.ok) fail("push", `强制推送失败（origin=${norm.remote}，branch=${branch}）：\n${p.err}\n${p.out}`);
}

// ---- 6. origin 改回 https ----
{
  const r = tryRun(["remote", "set-url", "origin", norm.https]);
  if (!r.ok) fail("set-url", `${r.err}\n${r.out}`);
}

console.log(`#gitUrl=${norm.https}`);
console.log(`#gitBranch=${branch}`);
console.log("#pushed=1");
if (inited) console.log("#initialized=1");
process.exit(0);
