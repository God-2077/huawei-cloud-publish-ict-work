#!/usr/bin/env node
// scan-workdirs.mjs — ICT 大赛作品目录统一检索（单入口：合并「工作目录视角」+「项目目录递归」两组候选）
// 专用脚本（与其他 skill 无共享，无 sync-src）。
//
// 背景:
//   SKILL.md Step 2 原来由 agent 分别跑 list-cwd-dirs.mjs（当前目录子文件夹候选）和
//   scan-projects.mjs（递归代码项目候选）并自行合并，二者输出格式不同（#candidate vs #project），
//   且 scan-projects 要求 README/指示文件——纯文档目录（仅 .md/.txt）扫不到。
//   本脚本将两组检索编排为一次调用，统一输出带序号的 #candidate <n>，agent 只需展示并让用户回序号。
//
// 候选来源（按依赖顺序，均以目标为根）:
//   1. 工作目录视角：list-cwd-dirs.mjs —— cwd 一级子文件夹（workspace 模式）或 cwd 本身
//     （direct 模式）。模式判据 = cwd 是否含**项目标记**（.git/README/package.json 等）：
//     direct（含标记，本身即作品目录）或 workspace（无标记，容器/工作区——即便有 loose .md/.txt 也列子目录，
//     适配 Linux /root/workspace）。
//   2. 项目目录递归：scan-projects.mjs —— 递归 README/指示文件命中的项目根（代码项目）；
//     兼扫 CodeArts 沙箱。对纯文档目录可能扫不到，不影响（第 1 路已覆盖）。
//
//   合并策略（防误扫）:
//     mode=direct   （cwd 含项目标记，本身即作品目录）→ 候选 = cwd 本身，**不跑项目递归**——
//                    否则会把项目内部子目录（packages/*、src/* 等）误列为独立作品候选。
//     mode=workspace（cwd 无标记、容器/工作区）        → 候选 = cwd 子目录 + 项目递归命中，去重合并。
//
// 用法:
//   node scan-workdirs.mjs [--dir <path>]    默认 process.cwd()
//   node scan-workdirs.mjs --help
//
// stdout:
//   #candidate <n> <absPath>     （带序号候选：direct=cwd 本身；workspace=子目录 + 项目递归并集）
//   无任何候选时输出一行 `#none`（exit 0，不阻断——仍可手动输入目录）
//
// 退出码: 0=成功（含无候选；无候选时 SKILL 转入手动输入）; 2=参数错误

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const CWD_SCRIPT = path.join(thisDir, "list-cwd-dirs.mjs");
const PROJ_SCRIPT = path.join(thisDir, "scan-projects.mjs");

const args = process.argv.slice(2);
let dir = process.cwd();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dir") dir = args[++i] ?? dir;
  else if (a === "-h" || a === "--help") {
    console.log(`scan-workdirs.mjs — ICT 大赛作品目录统一检索（单入口）

用法:
  node scan-workdirs.mjs [--dir <path>]    默认 process.cwd()

候选来源:
  1. 工作目录视角 list-cwd-dirs.mjs（direct: cwd 本身；workspace: cwd 下实质非空子文件夹）
  2. 项目目录递归 scan-projects.mjs（仅 workspace 时运行，避免完整项目内部子目录被误列为候选）

stdout:
  #candidate <n> <absPath>
  无候选时输出 #none（exit 0，转入手动输入）

退出码: 0=成功（含无候选）; 2=参数错误`);
    process.exit(0);
  }
}

// 运行子脚本并解析候选/模式；允许 exit 1（无候选），仅参数类 exit 2 视为错误
function runScript(script, flagDir) {
  const cmd = [script, "--dir", flagDir];
  let raw;
  try {
    raw = execFileSync(process.execPath, cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.status === 2) {
      const msg = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
      console.error(`❌ ${path.basename(script)} 参数错误：\n${msg}`);
      process.exit(2);
    }
    raw = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  }
  const mode = (raw.match(/^#mode=(\S+)/m) || [])[1] ?? undefined;
  const candidates = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^#candidate\s+\d+\s+(.+)$/) || line.match(/^#project\s+\d+\s+(\S+)\s+\S+.*$/);
    if (m) candidates.push(path.resolve(m[1]));
  }
  return { mode, candidates };
}

// 目录一级是否有实质内容（有候选价值）：含任意非隐藏文件，或含任一非空子目录
function hasLocalCandidates(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue
      if (e.isFile()) return true
      if (e.isDirectory()) {
        try {
          if (fs.readdirSync(path.join(dir, e.name)).length > 0) return true
        } catch { /* 不可读忽略 */ }
      }
    }
  } catch { return false }
  return false
}

let abs;
try {
  abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error("not exist");
} catch {
  console.error(`❌ 目录不存在: ${dir}`);
  process.exit(2);
}

// 健壮性兜底：若当前扫描根本身不含任何候选内容（例如 agent 误 cd 到脚本目录），
// 尝试回退到常见工作区根（取首个存在的）。兜底仅限 Linux CodeArts 沙箱 /root/workspace——
// Windows 无约定工作区根（用户存放目录不可控），不兜底，以 cwd/--dir 为准（最终可 #none 转手动输入）。
const FALLBACK_ROOTS = process.platform === "win32" ? [] : ["/root/workspace"];
if (!hasLocalCandidates(abs) && abs !== "/root/workspace") {
  const found = FALLBACK_ROOTS.find((r) => r && fs.existsSync(r));
  if (found) abs = found;
}

// 1) 工作目录视角：先取 mode 与候选
const cwd = runScript(CWD_SCRIPT, abs);
const pool = [...cwd.candidates];
if (cwd.mode !== "direct") {
  // 2) workspace（纯容器）：cwd 子目录 + 项目递归命中合并，去重
  const proj = runScript(PROJ_SCRIPT, abs);
  pool.push(...proj.candidates);
}
// direct 模式：cwd 本身即作品目录，跳过项目递归，避免项目内部子目录被误认作候选

const seen = new Set();
const all = [];
for (const p of pool) {
  if (seen.has(p)) continue;
  seen.add(p);
  all.push(p);
}
all.sort();

if (all.length === 0) {
  console.log("#none");
  console.error("未检索到候选作品目录。可直接让用户输入要提交的目录路径。");
  process.exit(0);
}

all.forEach((p, i) => console.log(`#candidate ${i + 1} ${p}`));
process.exit(0);