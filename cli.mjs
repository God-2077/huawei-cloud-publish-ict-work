#!/usr/bin/env node
// cli.mjs — ICT 大赛·实验赛题平台作品提交 · 面向人类的交互式 CLI
//
// 本文件是「编排层」：不重写业务逻辑，通过子进程调用同目录 scripts/*，
// 解析其 `#key=value` / `#problem` / `#selected` / `#candidate` stdout 契约，交互式走完
// Step 0→4（解析 Domain/STS → 选赛题并锁定目标 → 选作品目录 → git 信息/作品名 → 提交）。
//
// 用法:
//   node cli.mjs [选项]
//
// 选项（可选，缺省全部交互式提问）:
//   --problem-id <id>       指定赛题 ID（须配 --training-camp）
//   --problem-name <name>   指定赛题名（配合 --problem-id 时用于目标锁定与交叉校验）
//   --training-camp <id>    指定活动 ID
//   --work-dir <path>       指定作品目录（跳过候选扫描）
//   --work-name <name>      指定作品名（≤30 字符）
//   --git-url <url>         覆盖 git clone 地址；可传 ssh 或 https（目录无 .git/origin 时用于自动
//                           init+强推，见下）；已建仓且 URL 有变时会另行做示例仓库红线检查
//   --git-branch <name>     覆盖 git 分支（远端存在性由后端兜底校验）
//   --region <r>            hcloud 区域（默认 cn-north-4）
//   --hcloud <exe>          hcloud 可执行文件路径
//   --creds-file <json>     复用已有 sts-creds.json（跳过 Step 0 的 STS 生成）
//   --yes                   自动确认所有确认项
//   --non-interactive       非交互（必须提供 --problem-id/--training-camp/--work-dir）
//   -h, --help              显示帮助
//
// 人机提示走 stderr；最终成功结果块走 stdout。
// 退出码: 0=成功; 1=失败/取消; 2=参数错误

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dirname, "scripts");
const INVOCATION_CWD = process.cwd();

// ===== 选项解析 =====
const FLAGS = {
  problemId: null,
  problemName: null,
  trainingCamp: null,
  workDir: null,
  workName: null,
  gitUrl: null,
  gitBranch: null,
  region: "cn-north-4",
  hcloud: null,
  credsFile: null,
  yes: false,
  nonInteractive: false,
  forceSelect: false,
  help: false,
};

const HELP = `cli.mjs — ICT 大赛作品提交 · 交互式 CLI

用法:
  node cli.mjs [选项]

选项（缺省全部交互式提问）:
  --problem-id <id>       指定赛题 ID（须配 --training-camp；赛题列表行已不再输出 ID）
  --problem-name <name>   指定赛题名（配合 --problem-id 时用于目标锁定与交叉校验，推荐）
  --training-camp <id>    指定活动 ID
  --work-dir <path>       指定作品目录（跳过候选扫描）
  --work-name <name>      指定作品名（≤30 字符）
  --git-url <url>         覆盖 git clone 地址；可传 ssh 或 https（如 git@gitcode.com:ns/repo.git）。
                          作品目录无 .git/origin 时，用该地址自动 git init+提交+强制推送，
                          随后把 origin 改回 https://… .git
  --git-branch <name>     覆盖 git 分支（远端存在性由后端兜底校验）
  --region <r>            hcloud 区域（默认 cn-north-4）
  --hcloud <exe>          hcloud 可执行文件路径
  --creds-file <json>     复用已有 sts-creds.json（跳过 Step 0 的 STS 生成）
  --yes                   自动确认所有确认项
  --non-interactive       非交互（必须提供 --problem-id、--training-camp，以及 --work-dir）
  -h, --help              显示帮助

目标锁定:
  Step 1 选定赛题后即写目标锁（本次运行唯一目标），ID/活动/赛题名一律取自脚本回传的
  #selected 结构化行，禁止手抄；后续任何失败都不自动改投其他赛题。改投须重新选择并经
  用户确认（脚本层加 --force）。

环境/作品要求:
  - 环境必须已配置好 \`hcloud\` 命令，或提供 \`--hcloud 可执行文件路径\` 选项。
  - 作品目录建议配置好 git 仓库与 git 远程仓库；若无 .git/无 origin，可在选目录步骤提供
    git 地址（ssh/https），CLI 会自动初始化并强制推送到该仓库（凭证交给 git 自身）。

退出码: 0=成功; 1=失败/取消; 2=参数错误`;

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let val = null;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 2) {
      val = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const next = () => (val !== null ? val : argv[++i]);
    switch (a) {
      case "-h":
      case "--help": FLAGS.help = true; break;
      case "--problem-id": FLAGS.problemId = next(); break;
      case "--problem-name": FLAGS.problemName = next(); break;
      case "--training-camp": FLAGS.trainingCamp = next(); break;
      case "--work-dir": FLAGS.workDir = next(); break;
      case "--work-name": FLAGS.workName = next(); break;
      case "--git-url": FLAGS.gitUrl = next(); break;
      case "--git-branch":
      case "--branch": FLAGS.gitBranch = next(); break;
      case "--region": FLAGS.region = next() || FLAGS.region; break;
      case "--hcloud": FLAGS.hcloud = next(); break;
      case "--creds-file": FLAGS.credsFile = next(); break;
      case "--yes": FLAGS.yes = true; break;
      case "--non-interactive": FLAGS.nonInteractive = true; break;
      default: console.error(`❌ 未知参数: ${argv[i]}\n${HELP}`); process.exit(2);
    }
  }
}

// ===== 进程与临时文件 =====
const TMP = mkdtempSync(path.join(tmpdir(), "ict-cli-"));
let TMP_CLEANED = false;
function cleanup() {
  if (TMP_CLEANED) return;
  TMP_CLEANED = true;
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

// ===== 交互 =====
let rl = null;
let FINISHED = false; // 正常流程结束后置真，用于区分主动 close 与 stdin EOF
function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input, output });
    rl.on("close", () => {
      if (!FINISHED) {
        console.error("\n输入已结束（stdin 关闭/EOF），已取消。");
        process.exit(1);
      }
    });
  }
  return rl;
}
function closeRl() {
  try { rl?.close(); } catch {}
  rl = null;
}
process.on("SIGINT", () => {
  FINISHED = true;
  closeRl();
  console.error("\n已取消。");
  process.exit(130);
});

async function ask(question, defVal = "") {
  if (FLAGS.nonInteractive) return defVal;
  const suffix = defVal ? ` [${defVal}]` : "";
  const ans = await getRl().question(`${question}${suffix}: `);
  const t = ans.trim();
  return t || defVal;
}
async function confirm(question, def = true) {
  if (FLAGS.yes || FLAGS.nonInteractive) return true;
  const ans = await getRl().question(`${question} ${def ? "[Y/n]" : "[y/N]"}: `);
  const t = ans.trim().toLowerCase();
  if (!t) return def;
  return t === "y" || t === "yes";
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  FINISHED = true;
  closeRl();
  process.exit(1);
}
function relay(stderr) {
  if (stderr && stderr.trim()) console.error(stderr.trimEnd());
}

// ===== 子进程编排 =====
function runScript(name, args = [], timeoutMs = 0) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(SCRIPTS, name), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs || undefined,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: (e.stdout || "").toString(),
      stderr: (e.stderr || "").toString(),
    };
  }
}

function runPy(scriptName, args, timeoutMs = 0) {
  const candidates = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []]]
    : [["python3", []], ["python", []]];
  for (const [bin, pre] of candidates) {
    const res = spawnSync(bin, [...pre, path.join(SCRIPTS, scriptName), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs || undefined,
    });
    if (res.error && res.error.code === "ENOENT") continue;
    return { code: res.status ?? 1, stdout: res.stdout || "", stderr: res.stderr || "" };
  }
  return { code: 127, stdout: "", stderr: "未找到 python3/python，无法生成 STS 凭证（gen_sts.py 需要 Python 3）。" };
}

// ===== stdout 契约解析 =====
// `#problem <n> <name> [window=… status=…]`（2026-09-30 起**不含 ID**，ID 只经 `#selected` 取得）
function parseProblems(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^#problem\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    let rest = m[2];
    let win = null;
    const wm = rest.match(/\s+window=(\S+)\s+status=(\S+)\s*$/);
    if (wm) {
      win = { window: wm[1], status: wm[2] };
      rest = rest.slice(0, wm.index);
    }
    out.push({ n: Number(m[1]), name: rest.trim(), win });
  }
  return out;
}
// `#selected number=<n> problemId=<pid> trainingCampId=<camp> name=<name>`（name 为末字段，可缺省）
function parseSelected(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^#selected\s+(.*)$/);
    if (!m) continue;
    const t = m[1];
    const num = firstMatch(t, /number=(\S+)/);
    const pid = firstMatch(t, /problemId=(\S+)/);
    const camp = firstMatch(t, /trainingCampId=(\S+)/);
    const name = (t.match(/name=(.*)$/) || [, ""])[1].trim();
    if (pid) return { n: Number(num) || 0, problemId: pid, trainingCampId: camp, name };
  }
  return null;
}
function parseCandidates(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^#candidate\s+(\d+)\s+(.+)$/);
    if (m) out.push({ n: Number(m[1]), dir: m[2].trim() });
  }
  return out;
}
function firstMatch(stdout, re, group = 1) {
  const m = stdout.match(re);
  return m ? m[group] : "";
}

// ===== 步骤实现 =====

// ssh / git 协议 git 地址 → https 形态（scp 式、ssh:// 协议式、git:// 协议式；无法识别返回 null）。
// 用途：① 把用户提供的 ssh --git-url 与 origin 的 https 形态对齐；② origin 本身是 ssh 时自动派生 https 提交。
function sshToHttps(url) {
  if (typeof url !== "string") return null;
  let m = url.match(/^[^@\s/]+@([^:\s/]+):(\S+\.git)$/);
  if (m) {
    const pathPart = m[2].replace(/^[^@\s/]*@/, ""); // 顺带剥离 ssh 形态里的 user:pass@
    return `https://${m[1]}/${pathPart}`;
  }
  m = url.match(/^(?:ssh|git):\/\/(?:[^@\s/]+@)?([^/\s:]+)(?::\d+)?\/(\S+\.git)$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

// Step 2 辅助：git 红线检查（读 workDir origin + A3 判定）
async function pickWorkDir() {
  let dir = FLAGS.workDir ? path.resolve(FLAGS.workDir) : null;
  while (true) {
    if (!dir) {
      if (FLAGS.nonInteractive) fail("非交互模式必须提供 --work-dir");
      const scan = runScript("scan-workdirs.mjs", ["--dir", INVOCATION_CWD], 20000);
      const cands = parseCandidates(scan.stdout);
      if (cands.length) {
        console.error("检测到以下候选作品目录：");
        for (const c of cands) console.error(`  ${c.n}) ${c.dir}`);
      } else {
        relay(scan.stderr);
        console.error("未检索到候选作品目录，请手动输入。");
      }
      const ans = await ask("请选择序号或输入目录路径", cands[0]?.dir || "");
      if (/^\d+$/.test(ans)) {
        const hit = cands.find((c) => c.n === Number(ans));
        if (!hit) { console.error("序号无效，请重试。"); continue; }
        dir = hit.dir;
      } else {
        dir = path.resolve(ans);
      }
      if (!existsSync(dir)) { console.error(`目录不存在：${dir}`); dir = null; continue; }
    }

    const chk = runScript("check-ict-git-repo.mjs", [dir], 30000);
    if (chk.code === 0 && /#allowed=1/.test(chk.stdout)) {
      const safeUrl = firstMatch(chk.stdout, /#gitUrl=(\S+)/);
      return { workDir: dir, safeUrl };
    }

    // 目录无 .git（#gitAbsent=1）或无 origin（#gitNoOrigin=1）：允许提供 git 地址自动建仓强推
    if (/#gitAbsent=1/.test(chk.stdout) || /#gitNoOrigin=1/.test(chk.stdout)) {
      relay(chk.stderr);
      let remote = FLAGS.gitUrl;
      if (!remote) {
        if (FLAGS.nonInteractive) {
          fail("作品目录无 .git/无 origin，非交互模式需用 --git-url 提供 git 地址（ssh/https）。");
        }
        remote = await ask(
          "请输入 git 地址（ssh/https，如 git@gitcode.com:ns/repo.git），将自动初始化并强制推送；留空则重新选择目录",
          "",
        );
      }
      if (remote) {
        console.error(`正在初始化并强制推送到：${remote}`);
        const init = runScript("init-git-remote.mjs", [dir, "--remote", remote], 300000);
        relay(init.stderr);
        if (init.code === 0 && /#pushed=1/.test(init.stdout)) {
          const chk2 = runScript("check-ict-git-repo.mjs", [dir], 30000);
          if (chk2.code === 0 && /#allowed=1/.test(chk2.stdout)) {
            const safeUrl = firstMatch(chk2.stdout, /#gitUrl=(\S+)/);
            FLAGS.gitUrl = safeUrl; // 归一为 https，避免 Step 3 对 ssh 地址误判
            return { workDir: dir, safeUrl };
          }
          relay(chk2.stderr);
          if (/#exampleRepo=1/.test(chk2.stdout)) {
            fail("推送到的仓库命中平台示例仓库红线，不能作为赛题作品提交，请重新选择作品目录。");
          }
        } else {
          console.error("git 初始化/推送失败。");
        }
      }
    } else {
      relay(chk.stderr);
    }

    if (FLAGS.nonInteractive) fail("git 红线检查未通过，无法继续。");
    if (!(await confirm("是否重新选择作品目录？", true))) fail("已取消。");
    dir = null;
  }
}

// Step 3 辅助：对用户自定义 gitUrl 走 A3 免鉴权红线检查
// ssh/git 形态先自动派生 https（平台只接受 https://… .git），不再直接报「须为 https:// 开头」。
function checkGitUrlRemote(url) {
  const httpsUrl = sshToHttps(url) || String(url).replace(/^(https?:\/\/)[^/@]+@/, "$1");
  if (httpsUrl !== url) console.error(`ℹ️ gitUrl 为 ssh/git 协议，已自动转为 https 提交：${httpsUrl}`);
  if (!/^https:\/\/[^\s@]+\.git$/.test(httpsUrl)) {
    return { ok: false, reason: "gitUrl 须为 https:// 开头、.git 结尾、且不含内嵌凭证（ssh/git 形态会自动转为 https）" };
  }
  const r = runScript("api.mjs", ["POST", "/v1/gallery/competition/git-check",
    "--prefix", "open-api-guest", "--json", JSON.stringify({ gitUrl: httpsUrl })], 20000);
  const statusLine = r.stdout.split(/\r?\n/)[0] || "";
  const body = r.stdout.slice(r.stdout.indexOf("\n") + 1);
  let resp = null;
  try { resp = JSON.parse(body); } catch {}
  if (!statusLine.includes("200") || !resp?.data) {
    return { ok: false, reason: "A3 git-check 请求失败", raw: r.stdout + r.stderr };
  }
  if (resp.data.allowed === false) {
    return { ok: false, reason: `命中平台示例/演示仓库红线（${resp.data.host ?? ""}${resp.data.pathPrefix ?? ""}），不能作为赛题作品提交` };
  }
  return { ok: true, gitUrl: httpsUrl };
}

// Step 3 辅助：GitCode 凭证（缺失时走两阶段 OAuth，原样展示链接+二维码）
async function ensureGitCredential() {
  const cred = runScript("ensure-gitcode-credential.mjs", [], 15000);
  if (/#credential=found/.test(cred.stdout)) return;
  if (FLAGS.nonInteractive) {
    console.error("⚠️ 未检测到 GitCode 凭证，非交互模式跳过 OAuth 授权。");
    return;
  }
  console.error("未检测到 GitCode 凭证。");
  if (!(await confirm("是否现在进行 GitCode OAuth 授权？（用于访问/推送私有仓库）", true))) return;

  const st = runScript("gitcode-oauth.ensure.mjs", ["--start"], 200000);
  if (/#oauth=ready/.test(st.stdout)) { console.error("✅ GitCode 凭证已就绪。"); return; }
  if (/#oauth=absent/.test(st.stdout)) { relay(st.stderr); console.error("⚠️ GitCode OAuth 工具缺失，跳过授权（提交可能仍可进行）。"); return; }
  if (!/#oauth=started/.test(st.stdout)) { relay(st.stderr); console.error("⚠️ GitCode 授权启动失败，跳过。"); return; }

  // 二维码/链接原样展示给用户，绝不代开
  relay(st.stderr);
  const sid = firstMatch(st.stdout, /session_id=(\S+)/);
  const loginUrl = firstMatch(st.stdout, /login_url=(\S+)/);
  console.error(`\n请在浏览器打开以下链接完成授权：\n  ${loginUrl}\n`);
  if (!FLAGS.nonInteractive) await ask("完成授权后按回车继续等待轮询", "");
  console.error("正在等待授权完成…（最长 300s）");
  const wt = runScript("gitcode-oauth.ensure.mjs", ["--wait", sid], 330000);
  if (/#oauth=done/.test(wt.stdout)) console.error("✅ GitCode 授权成功（token 已写入 ~/.gitcode/auth.toml）。");
  else { relay(wt.stderr); console.error("⚠️ GitCode 授权未完成，继续后续步骤（可稍后重试）。"); }
}

// ===== 主流程 =====
async function main() {
  parseArgs(process.argv.slice(2));
  if (FLAGS.help) { console.log(HELP); process.exit(0); }
  if (FLAGS.nonInteractive && (!FLAGS.problemId || !FLAGS.trainingCamp || !FLAGS.workDir)) {
    fail("非交互模式必须提供 --problem-id、--training-camp、--work-dir");
  }

  console.error("华为 ICT 大赛·实验赛题平台 · 作品提交交互式 CLI");

  // ---- 前置：技能版本检查（平台不可达不拦截） ----
  const ver = runScript("check-version.mjs");
  if (/status=outdated/.test(ver.stdout)) {
    console.error(ver.stdout.trim());
    fail("当前技能版本已过时，请按上方提示升级后再提交。");
  }

  // ---- Step 0：解析 IAM Domain & 生成 STS 凭证 ----
  console.error("\n=== Step 0/4 · 解析 IAM Domain & 生成 STS 临时凭证 ===");
  let domainID = "";
  let credsFile = FLAGS.credsFile ? path.resolve(FLAGS.credsFile) : "";

  if (credsFile) {
    if (!existsSync(credsFile)) fail(`--creds-file 不存在: ${credsFile}`);
    console.error(`复用已有 STS 凭证：${credsFile}`);
  } else {
    const domArgs = [];
    if (FLAGS.hcloud) domArgs.push("--hcloud", FLAGS.hcloud);
    if (FLAGS.region) domArgs.push("--region", FLAGS.region);
    const dom = runScript("resolve-domain.mjs", domArgs, 20000);
    domainID = firstMatch(dom.stdout, /#domain=(\S+)/);
    if (dom.code !== 0 || !domainID) { relay(dom.stderr); fail("解析 IAM Domain ID 失败。"); }
    console.error(`已获取 IAM Domain ID: ${domainID}`);

    const ok = await confirm("将创建 IAM 自委托 SELF_VERIFY 生成 900s STS 临时凭证（永久 AK/SK 留本地，不上传），是否继续？", true);
    if (!ok) fail("已取消。");

    credsFile = path.join(TMP, "ict-sts-creds.json");
    const pyArgs = ["--account", domainID, "--creds-out", credsFile, "--sh-out", path.join(TMP, "ict-sts-creds.sh")];
    if (FLAGS.region) pyArgs.push("--region", FLAGS.region);
    if (FLAGS.hcloud) pyArgs.push("--hcloud", FLAGS.hcloud);
    const sts = runPy("gen_sts.py", pyArgs, 60000);
    if (sts.code !== 0 || !existsSync(credsFile)) {
      relay(sts.stdout); relay(sts.stderr);
      fail("生成 STS 临时凭证失败。");
    }
    console.error("✅ STS 临时凭证已生成。");
  }

  // ---- Step 1：赛题发现 + 目标锁定（#selected，禁止手抄 ID） ----
  console.error("\n=== Step 1/4 · 赛题发现 ===");
  // 目标锁：本次运行唯一目标。用 TMP 下的固定路径（随进程清理），并显式传给
  // list-problems（写锁）与 build-submit-params（校验锁），两边路径必须一致。
  const lockFile = path.join(TMP, ".ict-target.json");
  let problems = [];
  const lp = runScript("list-problems.mjs", ["--creds-file", credsFile], 30000);
  if (lp.code === 0) problems = parseProblems(lp.stdout);
  else {
    relay(lp.stderr);
    if (!(FLAGS.problemId && FLAGS.trainingCamp)) fail("无法获取赛题列表，请检查网络/凭证后重试。");
    console.error("⚠️ 赛题列表获取失败，改用命令行指定的赛题。");
  }

  if (problems.length) {
    console.error("可用 AI 赛题：");
    for (const p of problems) console.error(`  ${p.n}) ${p.name}${p.win?.status ? `（${p.win.status}）` : ""}`);
  }

  let problemId = FLAGS.problemId || "";
  let trainingCampId = FLAGS.trainingCamp || "";
  let problemName = FLAGS.problemName || "";

  // 两种入口：
  //  A. 交互：展示全部赛题 → 用户回序号 → `list-problems.mjs --select <n>` 写目标锁并回传 #selected
  //  B. 命令行：--problem-id 必须配 --training-camp；若再给 --problem-name 且列表可用，
  //     则用 --select-name 复核并写锁（推荐，可享「ID↔赛题名↔活动」交叉校验）
  let targetNumber = 0;
  let selectArgs = null;
  if (problemId) {
    if (!trainingCampId) {
      fail("--problem-id 需同时提供 --training-camp（赛题列表行已不再输出 problemId，无法反查活动）。");
    }
    if (problems.length && problemName) {
      selectArgs = ["--select-name", problemName, "--creds-file", credsFile, "--lock-file", lockFile];
    } else {
      console.error("⚠️ 未提供 --problem-name（或赛题列表不可用）：跳过目标锁定与赛题名交叉校验，仅用命令行传入的 problemId/trainingCampId。");
    }
  } else {
    if (FLAGS.nonInteractive) fail("非交互模式必须提供 --problem-id 与 --training-camp。");
    if (!problems.length) fail("当前无可用 AI 赛题。");
    while (true) {
      const ans = await ask("请选择赛题序号", "1");
      const hit = problems.find((p) => p.n === Number(ans));
      if (hit) { targetNumber = hit.n; break; }
      console.error("序号无效，请重试。");
    }
    selectArgs = ["--select", String(targetNumber), "--creds-file", credsFile, "--lock-file", lockFile];
  }

  // 目标锁定：由脚本写锁并回传唯一权威的 #selected 结构化行（禁止手抄 ID）
  if (selectArgs) {
    while (true) {
      const args = [...selectArgs];
      if (FLAGS.forceSelect) args.push("--force");
      const sel = runScript("list-problems.mjs", args, 30000);
      const picked = parseSelected(sel.stdout);
      if (picked) {
        problemId = picked.problemId;
        trainingCampId = picked.trainingCampId || trainingCampId;
        problemName = picked.name || problemName;
        if (!targetNumber) targetNumber = picked.n;
        break;
      }
      relay(sel.stderr);
      if (/#selected-locked/.test(sel.stdout)) {
        const locked = sel.stdout.match(/#selected-locked[^\n]*/)?.[0] || "";
        if (locked) console.error(locked);
        if (FLAGS.nonInteractive) fail("目标锁指向其他赛题；非交互模式不会自动改投，请清理目标锁后重试。");
        if (!(await confirm("目标锁指向其他赛题，是否改投到本次所选赛题？", false))) {
          fail("已取消（未改投）。禁止静默改投其他赛题。");
        }
        FLAGS.forceSelect = true;
        continue;
      }
      if (/#selected-none/.test(sel.stdout)) fail("赛题选择失败：序号越界或名称无匹配，请重新选择。");
      if (/#selected-ambiguous/.test(sel.stdout)) fail("赛题名匹配到多道题，请改用序号选择。");
      fail("目标锁定失败（未取得 #selected 结构化行），请检查赛题列表与凭证后重试。");
    }
    console.error(`本次目标：序号 ${targetNumber || "?"}／赛题「${problemName}」／problemId=${problemId} — 本步骤起目标即锁定，后续失败不自动改投。`);
  }
  console.error(`已选择赛题：problemId=${problemId} trainingCampId=${trainingCampId}${problemName ? ` name=${problemName}` : ""}`);

  // 窗口预检（有精确起止则覆盖默认）
  const wArgs = [];
  const winHit = problems.find((p) => p.n === targetNumber);
  if (winHit?.win) {
    const [s, e] = winHit.win.window.split("~");
    if (s && s !== "?") wArgs.push("--start", s);
    if (e && e !== "?") wArgs.push("--end", e);
  }
  const win = runScript("check-competition-window.mjs", wArgs, 10000);
  relay(win.stderr);
  if (!/#window=open/.test(win.stdout)) fail("当前不在实验窗口内，停止提交。");

  // ---- Step 2：选择作品目录 ----
  console.error("\n=== Step 2/4 · 选择赛题作品目录 ===");
  const { workDir, safeUrl } = await pickWorkDir();
  console.error(`已选作品目录：${workDir}`);
  console.error(`仓库地址（已剥离凭证）：${safeUrl || "（未解析）"}`);

  // ---- Step 3：Git 信息与作品名 ----
  console.error("\n=== Step 3/4 · Git 仓库信息与作品名 ===");
  // 用户可能用 ssh 形态提供 --git-url；此处先归一为 https 形态（提交/红线检查都只认 https）
  if (FLAGS.gitUrl) FLAGS.gitUrl = sshToHttps(FLAGS.gitUrl) || FLAGS.gitUrl;
  let gitUrl = FLAGS.gitUrl;
  let gitBranch = FLAGS.gitBranch;
  if (!gitUrl || !gitBranch) {
    while (true) {
      const gi = runScript("read-git-info.mjs", [workDir], 30000);
      if (gi.code === 0) {
        // read-git-info 已做 ssh/git→https 自动派生与凭证剥离
        gitUrl = gitUrl || firstMatch(gi.stdout, /#gitUrl=(\S+)/);
        gitBranch = gitBranch || firstMatch(gi.stdout, /#gitBranch=(\S+)/);
        break;
      }
      relay(gi.stderr);
      if (FLAGS.nonInteractive) fail("读取 git 信息失败。");
      if (!(await confirm("修复后重试读取 git 信息？", true))) fail("已取消。");
    }
  }
  // 兼容手工/旧脚本传入的 ssh 形态（例如 --git-url 未被上面的分支覆盖时）
  let gitUrlChanged = false;
  if (gitUrl) {
    const httpsGitUrl = sshToHttps(gitUrl);
    if (httpsGitUrl && httpsGitUrl !== gitUrl) {
      console.error(`ℹ️ gitUrl 为 ssh/git 协议，已自动转为 https 提交：${httpsGitUrl}`);
      gitUrl = httpsGitUrl;
      gitUrlChanged = true;
    }
  }
  // 仅在 gitUrl 与 Step 2 已放行的 safeUrl 不一致时重跑 A3 红线检查（与旧行为一致，避免多余网络阻断）
  if (gitUrl && (gitUrlChanged || gitUrl !== safeUrl)) {
    const chk = checkGitUrlRemote(gitUrl);
    if (!chk.ok) {
      if (chk.raw) relay(chk.raw);
      fail(`gitUrl 未通过红线检查：${chk.reason}`);
    }
    if (chk.gitUrl) gitUrl = chk.gitUrl;
  }
  console.error(`gitUrl=${gitUrl}`);
  console.error(`gitBranch=${gitBranch}`);

  await ensureGitCredential();

  let workName = FLAGS.workName;
  if (!workName) {
    const ex = runScript("extract-workname.mjs", [workDir], 10000);
    const def = firstMatch(ex.stdout, /#name=(.*?)(?:\s+source=|$)/).slice(0, 30);
    const source = firstMatch(ex.stdout, /source=(\S+)/);
    if (source && source !== "dirname") console.error(`从作品目录提取到作品名（来源 ${source}）：${def}`);
    workName = await ask("请输入作品名（≤30 字符）", def);
    while (!workName || workName.length > 30) {
      console.error("作品名需 1-30 字符。");
      workName = await ask("请输入作品名（≤30 字符）", def.slice(0, 30));
    }
  }
  if (!workName || workName.length > 30) fail("作品名需 1-30 字符。");
  console.error(`作品名：${workName}`);

  // ---- Step 4：提交 ----
  console.error("\n=== Step 4/4 · 提交 ===");
  console.error(`即将提交：作品「${workName}」→ 赛题 ${problemId}${problemName ? `「${problemName}」` : ""}（活动 ${trainingCampId}）`);
  console.error(`  gitUrl=${gitUrl}`);
  console.error(`  gitBranch=${gitBranch}`);
  if (!(await confirm("确认提交？", true))) fail("已取消。");

  const paramsFile = path.join(TMP, "ict-params.json");
  while (true) {
    const bpArgs = [
      "--out", paramsFile,
      "--problem-id", problemId,
      "--training-camp", trainingCampId,
      "--work-name", workName,
      "--git-url", gitUrl,
      "--git-branch", gitBranch,
      "--creds", credsFile,
      "--lock-file", lockFile,
    ];
    // --problem-name 为上游必填（目标锁一致性 + A0 ID↔赛题名/活动交叉校验）；
    // 仅在「列表不可用且未提供 --problem-name」的逃生路径下省略。
    if (problemName) bpArgs.push("--problem-name", problemName);
    const bp = runScript("build-submit-params.mjs", bpArgs, 20000);
    if (bp.code !== 0) {
      relay(bp.stderr);
      const msg = bp.stdout.match(/(PROBLEM_[A-Z_]+|GIT_[A-Z_]+)/)?.[1] || "";
      fail(`装配提交参数失败${msg ? `（${msg}）` : ""}：目标锁定后本次运行不再改投其他赛题；如需改投，请重新运行并回 Step 1 重新选择。`);
    }

    const sub = runScript("submit-ict-work.mjs", [paramsFile], 60000);
    if (/#status=201/.test(sub.stdout) || /submissionId=/.test(sub.stdout)) {
      const submissionId = firstMatch(sub.stdout, /submissionId=(\S+)/);
      const workUrl = firstMatch(sub.stdout, /workUrl=(\S+)/);
      console.log(`\n✅ 提交成功：作品「${workName}」已提交赛题 ${problemId}（submissionId=${submissionId}）。`);
      if (workUrl) console.log(`    作品详情：${workUrl}`);
      console.log("    判题由平台程序异步进行，结果会在做题面板更新，请稍后在页面查看。");
      break;
    }

    relay(sub.stderr);
    if (sub.stdout.trim()) console.error(sub.stdout.trim());
    if (FLAGS.nonInteractive) fail("提交失败。");
    if (!(await confirm("提交未成功，是否重试？（将生成新的 Idempotency-Key）", true))) fail("已放弃提交。");
  }

  FINISHED = true;
  closeRl();
}

main().catch((e) => {
  console.error(`\n❌ 异常: ${e && e.message}`);
  FINISHED = true;
  closeRl();
  process.exit(1);
});
