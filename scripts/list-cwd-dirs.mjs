#!/usr/bin/env node
// list-cwd-dirs.mjs — 列出「当前目录视角」的候选作品目录（ICT 大赛专用；与其他 skill 无共享，无 sync-src）
//
// 背景:
//   SKILL.md Step 2 除 scan-projects.mjs（需代码指示文件，纯文档目录扫不到）外，
//   增加「当前目录」兜底视角：当前用户工作目录里可能就是待提交作品，或装着多个候选作品目录。
//   本脚本单入口输出一层子目录 + 当前目录是否含文件，供 agent 列给用户选择。
//
// 判定:
//   mode=workspace : 当前目录一级**不含项目标记**（无 .git/README/指示文件等）→ 视为「容器/工作区」，
//                    候选 = 一级子文件夹（无论是否有 loose 的 .md/.txt/配置等普通文件；适配 /root/workspace 场景）。
//   mode=direct    : 当前目录一级**含项目标记**（.git 目录 / README / package.json 等指示文件）→ 当前目录
//                    本身即作品目录（候选=当前目录，子目录仅参考，防 packages/src 误扫）。
//   空文件夹排除 : 子目录递归（限深 3）实质为空（无任何作品文件/非空子目录）→ 不作为候选；
//                  子目录全为空时即使当前目录无项目标记也坍回 direct（无容器候选可给）。
//
// 用法:
//   node list-cwd-dirs.mjs [--dir <path>]    默认 process.cwd()（= shell 的 pwd）
//   node list-cwd-dirs.mjs --help
//
// stdout:
//   #cwd=<abs>
//   #mode=workspace|direct
//   #candidate <n> <absPath>   （带序号的可选候选：workspace=各实质非空子目录；direct=当前目录本身；
//                              #mode=workspace 时另输出 #subdir 供参考）
//   #subdir <n> <absPath>      （仅 workspace，参考用）
//
// 退出码: 0=成功; 2=参数错误

import fs from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  process.stdout.setDefaultEncoding?.("utf8");
  process.stderr.setDefaultEncoding?.("utf8");
}

const args = process.argv.slice(2);
let dir = process.cwd();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dir") dir = args[++i] ?? dir;
  else if (a === "-h" || a === "--help") {
    console.log(`list-cwd-dirs.mjs — 列出当前目录视角的候选作品目录

用法:
  node list-cwd-dirs.mjs [--dir <path>]    默认 process.cwd()

stdout:
  #cwd=<abs>
  #mode=workspace|direct   workspace=仅子目录（候选=子文件夹）；direct=含文件（候选=当前目录）
  #candidate <n> <absPath>  带序号的可选候选（供用户按序号选择）
  #subdir <n> <absPath>     子目录（workspace 时输出，参考）

退出码: 0=成功; 2=参数错误`);
    process.exit(0);
  }
}

let abs;
try {
  abs = path.resolve(dir);
  if (!fs.statSync(abs).isDirectory()) {
    console.error(`❌ 不是目录: ${abs}`);
    process.exit(2);
  }
} catch {
  console.error(`❌ 目录不存在或不可读: ${dir}`);
  process.exit(2);
}

let entries;
try {
  entries = fs.readdirSync(abs, { withFileTypes: true });
} catch (e) {
  console.error(`❌ 目录读取失败: ${abs}（${e instanceof Error ? e.message : e}）`);
  process.exit(2);
}

// 项目标记：一级目录含这些即视为「作品目录本身」（direct），否则视为容器/工作区（workspace，列子目录）。
// 注意 workspace 判定不看是否含普通文件——/root/workspace 即便有 loose .md/.txt 也应列一级子目录。
const PROJECT_MARKERS = new Set([
  "README.md", "readme.md", "README.MD",
  ".git", ".gitignore", ".gitlab-ci.yml",
  "package.json", "pom.xml", "build.gradle", "requirements.txt",
  "pyproject.toml", "setup.py", "Cargo.toml", "go.mod",
  "Dockerfile", "Makefile", "index.html",
]);
// 子目录：排除隐藏目录与常见资源目录（node_modules/.git/dist 等作品无关项）
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".idea", ".vscode",
  ".opencode", ".codeartsdoer", "__pycache__", "resources", "images", "assets",
]);

/// 目录是否「实质为空」（无作品内容，不应作为候选）：排除隐藏项与 EXCLUDE_DIRS 后，
/// 递归检查（限深 3）——没有任何文件且子目录也全空 = 空文件夹。
function hasSubstance(dir, depth = 0) {
  if (depth > 3) return true // 兜底：过深按有内容处理，避免误滤
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return true // 不可读按有内容处理
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    if (EXCLUDE_DIRS.has(e.name)) continue
    if (e.isFile()) return true
    if (e.isDirectory() && hasSubstance(path.join(dir, e.name), depth + 1)) return true
  }
  return false
}

const hasMarker = entries.some((e) => PROJECT_MARKERS.has(e.name));
const subdirs = entries
  .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !EXCLUDE_DIRS.has(e.name))
  .map((e) => path.join(abs, e.name))
  .filter((p) => hasSubstance(p)) // 排除空文件夹（递归实质为空）
  .sort();

// 无项目标记 → 容器（workspace，列子目录；即使有 loose 文件）；有项目标记 → 作品本身（direct）。
// 子目录全为空且无标记时坍回 direct（无容器候选可给），当前目录本身可作候选。
const mode = hasMarker ? "direct" : subdirs.length > 0 ? "workspace" : "direct";

// 候选清单（带序号，供用户直接按序号选择）：
//   workspace → 候选 = 各实质非空子目录；direct → 候选 = 当前目录本身
const candidates = mode === "workspace" ? subdirs : [abs];

console.log(`#cwd=${abs}`);
console.log(`#mode=${mode}`);
if (mode === "workspace") subdirs.forEach((p, i) => console.log(`#subdir ${i + 1} ${p}`)); // 参考
candidates.forEach((p, i) => console.log(`#candidate ${i + 1} ${p}`)); // 带序号候选（供选择）
process.exit(0);