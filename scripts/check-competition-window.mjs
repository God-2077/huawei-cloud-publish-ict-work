#!/usr/bin/env node
// check-competition-window.mjs — ICT 大赛实验窗口预检（客户端 fail-early，服务端兜底 fail-closed）
//
// 默认窗口（与服务端 competitionRoutes.ts 常量一致）:
//   start = 2026-09-18T00:00:00+08:00
//   end   = 2026-11-08T23:59:59+08:00
// 服务端优先按活动(training_camp)起止时间，缺失 fallback 全局常量；本脚本用全局常量作客户端预检，
// 可通过 --start/--end 覆盖（如已从活动详情取得更精确窗口）。
//
// 用法:
//   node check-competition-window.mjs [--start <iso|date>] [--end <iso|date>]
//
// 成功(窗口内) exit 0，stdout: `#window=open remainingDays=<n>`（消息走 stderr）
// 失败(窗口外) exit 1，stdout: `#window=closed reason=<before|after>`（stderr 含说明）
// 参数错误 exit 2。

// ===== 实验窗口（服务端 COMPETITION_WINDOW_START/END 同源） =====
const DEFAULT_START = "2026-09-18T00:00:00+08:00";
const DEFAULT_END = "2026-11-08T23:59:59+08:00";

function parseArgs(argv) {
  const cli = { start: DEFAULT_START, end: DEFAULT_END };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(`check-competition-window.mjs — ICT 大赛实验窗口预检

用法:
  node check-competition-window.mjs [--start <iso|date>] [--end <iso|date>]

默认窗口: start=${DEFAULT_START}  end=${DEFAULT_END}
  （与服务端全局常量一致；服务端优先按活动起止时间，--start/--end 用于覆盖）

stdout: #window=open remainingDays=<n>   （exit 0）
        #window=closed reason=<before|after>（exit 1）
`);
      process.exit(0);
    } else if (a === "--start") cli.start = argv[++i];
    else if (a === "--end") cli.end = argv[++i];
    else {
      console.error(`❌ 未知参数: ${a}`);
      process.exit(2);
    }
  }
  return cli;
}

const cli = parseArgs(process.argv.slice(2));
const start = new Date(cli.start);
const end = new Date(cli.end);
if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
  console.error(`❌ 窗口起止时间不合法: start=${cli.start} end=${cli.end}`);
  process.exit(2);
}

const now = new Date();
if (now < start) {
  const days = Math.ceil((start.getTime() - now.getTime()) / 86400000);
  console.log("#window=closed reason=before");
  console.error(`⏳ 实验窗口未开始（${start.toISOString()} 后开启，剩余约 ${days} 天）。提交将被服务端拒绝，无需生成产物。`);
  process.exit(1);
}
if (now > end) {
  console.log("#window=closed reason=after");
  console.error(`⏹ 实验窗口已截止（${end.toISOString()}）。已无法提交/重提，停止发布。`);
  process.exit(1);
}
const remainingDays = Math.ceil((end.getTime() - now.getTime()) / 86400000);
console.log(`#window=open remainingDays=${remainingDays}`);
console.error(`✅ 实验窗口内（剩余约 ${remainingDays} 天），可提交 AI 赛题作品。`);
process.exit(0);