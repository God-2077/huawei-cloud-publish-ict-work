---
name: huawei-cloud-publish-ict-work
description: |
  Submit a competition work to the Huawei ICT Contest experiment platform (华为 ICT 大赛·实验赛题平台), preparing the
  git repository info/work name and submitting for async auto-judging (判题) of an AI problem (云赛项 AI 赛题), where the
  result (passed/failed) is returned later by the judging program and refreshed in the problem panel.
  Use this skill whenever the user wants to push, submit, or upload work to the ICT competition — casual phrasings like
  "提交大赛作品", "推送ICT赛题作品", "把作品投到ICT大赛", "提交AI赛题去判题", as well as formal ones like
  "submit ICT competition work", "publish AI problem solution to the contest", "push work for judging".
  Do NOT use for regular gallery publishing (投稿陈列馆/训练营 without competition context) — use huawei-cloud-publish-work-to-gallery.
  Do NOT use for judging itself, viewing scores/ranking, or platform browsing without submit intent.
metadata:
  tags: huawei-cloud,ict-competition,ai-problem,submit,gallery,university operations platform
  version: 2026.09.28.001
---

# Publish ICT Competition Work

提交作品至华为 ICT 大赛·实验赛题平台（AI 赛题判题闭环）。**优先调用内置脚本**（单入口、fail-fast、自带 `--help`），报错才查 [references/ict-error-codes.md](references/ict-error-codes.md)。

> **2026-09-17 简化**：提交只需 `workName`/`gitUrl`/`gitBranch`（A1 不再收集封面/详情/envUrl），提交后**不轮询判题**——判题由平台程序异步进行，结果在做题面板更新。
>
> 共享辅助脚本（`read-git-info.mjs`、`ensure-user-tool.mjs`、`ensure-user-bindir.mjs`、git 凭证等）为 **vendored 副本**，头部 `sync-src:` 指向源路径；改动须同步同源两端。

## Pipeline

```
Step 0 (domainID, STS creds) → Step 1 (problemId, trainingCampId, window) → Step 2 (workDir + A3 git 红线检查) → Step 3 (gitUrl, gitBranch, workName) → Step 4 (submit)
```

**变量贯穿**：`workName`/`problemId`/`trainingCampId`/`domainID` 在最早步骤确定后作为变量传递全流程，禁止硬编码。

**执行模型**：① **脚本契约优先**——按 stdout 成功信号判定，成功路径零源码读取；失败才 `脚本提示 → ict-error-codes → grep 脚本源码` 逐级查 ② 网络超时统一 3s ③ `detect-env.mjs` 确定平台后按平台差异执行 ④ 合并无依赖的 bash 调用：用 `;` 串联进一条命令 ⑤ **需用户交互的命令（如 GitCode OAuth 授权）一律把链接/二维码原样展示给用户，禁止用 agent 内置浏览器/工具（browser_use_open 等）代开**——脚本本地已起回调服务器，用户在任意浏览器授权后脚本自动拿到 token，agent 全程不需要浏览器。

## 脚本契约速查

| 步骤 | 脚本/命令 | 成功信号（exit 0 且） | 失败（exit 1；2=参数错） |
|------|-----------|----------------------|--------------------------|
| 0 | `resolve-domain.mjs [--hcloud <exe>]` | stdout `#domain=<id> name=<name>` | exit 1=hcloud 失败（stderr 含排查指引） |
| 0 | `gen_sts.py --account <domainID>` | 写 `sts-creds.json`（含 `_refresh`） | 见 troubleshooting 同源指引 |
| 前置 | `check-version.mjs`（读取自身 name/version，调平台 `open-api-guest /v1/gallery/skills/status` 判定） | exit 0 且首行 `status=ok`/`status=skip`（平台不可达亦 skip，不拦截） | exit 1（`status=outdated` + 平台下发升级文案）→ 原样提示升级，停止提交；已登记技能的版本比对与「缺失/无法解析版本即视为过时」均由平台判定 |
| 前置 | `api.mjs GET /v1/gallery/competition/camps --creds-file <json>` | stdout 首行 `#status=200`（连通性+STS 正常） | 超时/拒连 → 排查网络/凭证 |
| 1 | `list-problems.mjs [--creds-file <json>]` | `#problem <n> <problemId> <trainingCampId> <name> [window=… status=…]` | exit 1（`#none`/非 200）→ 提示无可用 AI 赛题 |
| 1 | `check-competition-window.mjs --start <所选赛题 startsAt> --end <endsAt>` | `#window=open remainingDays=<n>` | exit 1（`#window=closed reason=before/after`）→ 停止，告知窗口起止 |
| 2 | `scan-workdirs.mjs --dir <workRoot>` | `#candidate <n> <abs>`（workspace=一级子目录 + 项目递归命中并集；direct=根本身）或 `#none`（exit 0，转手动输入） | exit 2=参数错误 |
| 2 | `check-ict-git-repo.mjs <workDir>` | `#gitUrl=<https://… .git>` `#allowed=1` | exit 1= `#exampleRepo=1`（示例仓库，重选目录）/ `#gitAbsent=1`（非 git 仓库）/ `#gitNoOrigin=1`（无 origin 远程）/ `#error=1`（URL 不合规或 A3 失败） |
| 2 | `init-git-remote.mjs <workDir> --remote <ssh\|https> [--branch <name>] [--dry-run]` | `#gitUrl=<https… .git>` `#gitBranch=<分支>` `#pushed=1`（`git init` 过附 `#initialized=1`；`--dry-run` 出 `#dryRun=1`） | exit 1= `#error=1 reason=<init\|commit\|remote\|push\|set-url>`（stderr 附原始输出）；exit 2=URL/参数不合法（须 ssh 或 https、`.git` 结尾、无内嵌凭证） |
| 3 | `strip-git-credential.mjs "<rawUrl>"` | stdout=安全 URL（https:// 开头、.git 结尾、无 `@`） | 非 https/非 .git/含 `@` → 停止 |
| 3 | `read-git-info.mjs <workDir>` | `#gitUrl=<https://… .git>` `#gitBranch=<分支>`（已核对远端确有该分支） | exit 1=非 git 仓库 / 无 origin / detached HEAD / URL 不合规 / `#branchAbsent=1`（远端不存在该分支——本地/远端分支名分叉，转述 stderr 指引：`git push -u origin <branch>` 或改用远端已有分支；网络/凭证原因无法核对时 stderr 警告但不拦截） |
| 3 | `ensure-gitcode-credential.mjs` | `#credential=found`（有凭证）或 `#credential=missing`（无凭证，走 OAuth） | exit 0；无手动备选 |
| 3 | `gitcode-oauth.ensure.mjs --start` | `#oauth=ready`（有 token）/ `#oauth=started session_id=<id> login_url=<url>`（stdout 立即返回，二维码走 stderr） | 缺失 `#oauth=absent` exit 1；失败 `#oauth=failed reason=…` exit 1 |
| 3 | `gitcode-oauth.ensure.mjs --wait <session_id> [--timeout <秒>]` | `#oauth=done`（token 已写 `~/.gitcode/auth.toml`） | `#oauth=failed reason=timeout\|finish\|…` exit 1 |
| 前置 | `ensure-user-bindir.mjs` | `#bindir=<abs> level=…`（选定+创建用户级工具目录并写 PATH）；`--print-path` 输出用户 PATH 原始串 | exit 1=无可写目录 |
| 前置 | `ensure-user-tool.mjs --tool gitcode-oauth` | `#tool=gitcode-oauth path=<abs> source=cache\|path\|probe\|bindir\|installed`；`--print [--tool <t>]` 读 `tools-index.json` | exit 1=解析/安装失败 |
| 3 | `extract-workname.mjs <workDir>` | `#name=<name> source=<来源>` | exit 1=workDir 不存在 |
| 4 | `build-submit-params.mjs --out … --problem-id … --training-camp … --work-name … --git-url … --git-branch … --creds <sts-creds.json>` | `#params=<absPath>`（注入 STS 凭证 + 自动 Idempotency-Key） | exit 1=creds 缺失；exit 2=参数错/字段缺 |
| 4 | `submit-ict-work.mjs <utf8-params.json>` | `#status=201`（输出 submissionId/attemptNo/judgeStatus/workId/workUrl） | 409/403 等失败 → 原样输出完整响应 |

> 鉴权前置：提交身份由 **APIG 网关注入 `X-Domain-Id`**，gallery 反查 `accountId`——先 `resolve-domain.mjs` 得 `domainID`，`gen_sts.py` 生成最小权限 STS（X-Tmp-Ak/X-Tmp-Sk/X-Security-Token），经 open-api-public 网关鉴权；未装/未配置 → [troubleshooting#domain-id-resolution-issues](../huawei-cloud-publish-work-to-gallery/references/troubleshooting.md#domain-id-resolution-issues)。
>
> **Git Bash 前置**：Windows Git Bash 下先 `source <skill>/scripts/setup-env.sh`（防 MSYS 把 `/v1/…` 转成 `C:/.../v1/…`）。PowerShell/CMD 无需。

---

## Core Workflow

### Step 0: 解析 IAM Domain & 生成 STS 凭证

1. **告知用户**（生成凭证=同意）：将创建 IAM 自委托 `SELF_VERIFY` 生成 STS 临时凭证（900s），永久 AK/SK 留本地不上传。
2. `resolve-domain.mjs` → `domainID`；`gen_sts.py --account <domainID>` → `credsFile`（契约见上表）。
3. 输出 `已获取 IAM Domain ID: <id>`。

**Output:** `domainID`、`credsFile`。

### Step 1: 赛题发现（A0）

1. `list-problems.mjs` 拉全量赛题 → `#problem <n>` 候选（契约见上表）。
2. **列出所有赛题供用户选择**：**展示全部** AI 赛题 `1) <赛题名>`（对应 `#problem <n>`，含 `window=… status=…` 标注），**不省略、不按窗口过滤**；用户回序号选择 → `problemId` 与关联 `trainingCampId`（一题一活动，**禁止手改**）。
3. **窗口预检（对所选赛题）**：选定后用 `check-competition-window.mjs` 按其 `startsAt/endsAt` 判定；窗口外停止并告知（不影响第 2 步展示全部）。
4. **身份说明**：告知提交将以网关注入的账号身份进行。

**Output:** `problemId`、`trainingCampId`、`windowStart`、`windowEnd`。

### Step 2: Select Work Directory

> **⚠️ 必须由用户确认选定**：目录是识别结果，**绝不自行代选**。无 `#candidate` 时也须请用户明确给出/确认目录后才继续。

1. `pwd` 取用户工作目录 → `scan-workdirs.mjs --dir <workRoot>` → `#candidate <n>`（契约见上表）。
2. **向用户列出候选并等其确认**：展示 `1) <目录>`… → 用户回序号、或直接输入路径、或明确说用某目录；**得到用户明确选择后才定为 `workDir`**。
3. 手动输入兜底：候选不符 / `#none` / 指定任意目录，均请用户输入（`#none` 不拦截、不擅自指定）。
4. **git 红线检查（提交之初即查，接口判定）**：对用户确认的 `workDir` 跑 `check-ict-git-repo.mjs <workDir>`（内部读 `.git` origin → 调 A3 git-check，判定规则以**后端配置**为准）：
   - `#exampleRepo=1` → 脚本 stderr 已给出完整红线提示，**转述并且唯一处置是回到本步骤请用户重新选择「赛题作品目录」**；禁止继续后续步骤，禁止 fork、禁止拆分/另推示例仓库内容为个人仓库提交（红线规则见 [ict-error-codes.md](references/ict-error-codes.md) `GIT_URL_EXAMPLE_REPO`）。
   - `#gitAbsent=1` / `#gitNoOrigin=1` → 该目录无 `.git` 或 git 仓库无 `origin`。**优先询问用户提供一个 git 地址（ssh/https，如 `git@gitcode.com:<ns>/<repo>.git`）**：有则调 `init-git-remote.mjs <workDir> --remote <url>`（自动 `git init`/`remote add`/`git add -A`+提交/`git push -u --force`，成功后把 origin 改回 https），随后重跑 `check-ict-git-repo.mjs` 复核；复核 `#exampleRepo=1` → 红线停止并回 Step 2。用户不留地址 / 非交互无 `--git-url` → 请用户改选已建仓目录。
   - `#error=1` → 提示本地 URL 不合规或 A3 请求失败，按 stderr 排查后重试（不阻塞用户换目录）。
   - `#allowed=1` → 记录 `safeUrl = #gitUrl`，进入 Step 3。
5. 路径校验：存在且为目录即可作 `workDir`；命名与 git 信息在 Step 3。

**Output:** `workDir`（须用户确认）、`safeUrl`。

### Step 3: Git Repository Info & Work Name

1. **红线复核（URL 可能变化时）**：若 `#allowed=1` 后 gitUrl 无变化（Step 2 已判定放行）可跳过；若用户手工改过 origin / 输入了自定义 URL，先重跑 `check-ict-git-repo.mjs <workDir>` 复核（同 Step 2.4 判定，命中示例仓库 → 回 Step 2）。
2. `read-git-info.mjs <workDir>` 一步取 gitUrl/gitBranch（含 git 仓库自检 + 凭证剥离 + **远端分支核对**，契约见上表）；其输出的 gitUrl 与 `safeUrl` 比对，不一致以 `read-git-info` 为准并重跑 A3 判定。`#branchAbsent=1` → 转述 stderr 指引（先推送该分支或改用远端已有分支），修复后重跑本步骤。
3. **凭证排查**：`ensure-gitcode-credential.mjs`；无凭证走 `gitcode-oauth.ensure.mjs` 两阶段授权（`--start`→`--wait`，契约见上表）——**授权链接/二维码原样展示给用户**（禁止 agent 内置浏览器代开）。**若 read-git-info 已能读到 origin**（已有凭证）可跳过 OAuth。
4. **命名**：`extract-workname.mjs <workDir>`。`source=dirname` 时 agent 可合成/修改（<30 字符）。

> 红线：示例仓库**不可提交**——唯一处置是回 Step 2 更换「赛题作品目录」（禁止 fork/拆分/另推，规则见 [ict-error-codes.md](references/ict-error-codes.md) `GIT_URL_EXAMPLE_REPO`）。

**Output:** `gitUrl`、`gitBranch`、`workName`。

### Step 4: Submit to Competition

1. 宣示 `开始提交 ICT 大赛作品「${workName}」（赛题 ${problemId}）`。
2. `build-submit-params.mjs` 装配参数 JSON（注入 sts-creds.json 凭证 + 计算 Idempotency-Key）→ `submit-ict-work.mjs`（契约见上表）。Idempotency-Key 默认自动生成；重提必须 `--idempotency-key` 传**新键**；**提交无需任何产物（已删封面/详情/门禁）**。
3. **201** → 提交成功。取 `submissionId`/`attemptNo`/`judgeStatus`/`workUrl`，清理临时文件。
4. **失败处置（提交未 201）**：`submit-ict-work.mjs` 已在 stderr 输出中文原因 + 处置指引，**面向用户直接转述**，策略见 [ict-error-codes.md](references/ict-error-codes.md)。终态/门槛/占用（409/403/400）：`PROBLEM_TRACK_MISMATCH` 且已在 ICT 侧换赛道仍被拦 → 提示落地页「我的参赛状态」点「刷新组队信息」（`?refresh=1`）后重提；`GIT_URL_EXAMPLE_REPO` → 清理临时文件 + 回 Step 2 更换「赛题作品目录」（红线规则见 error-codes）。参数类/rate limit/系统错误 → 告知 `<msg>（<code>）`，保留临时文件，按表处理后可重试。
5. **重提（判题未通过场景）**：仅需新 Idempotency-Key（`ict-submit-${problemId}-${Date.now()}`）重新 `submit-ict-work.mjs`。

**结束语（判题为异步，不轮询）**：

```
✅ 提交成功：作品「${workName}」已提交赛题 ${problemId}（submissionId=${submissionId}）。
    作品详情：${workUrl}
    判题由平台程序异步进行，结果会在做题面板更新，请稍后在页面查看。
```

---

## References

| Document | 用途 | 何时读 |
|----------|------|--------|
| [ict-api-spec.md](references/ict-api-spec.md) | A0/A1 契约、字段、响应、鉴权 | Step 1/4 解析响应与组参 |
| [ict-error-codes.md](references/ict-error-codes.md) | 全部错误码 + 处理策略 | API 返回非 2xx 时查表 |
| [ict-competition-rules.md](references/ict-competition-rules.md) | 报名门槛/窗口/重提/身份规则 + 与普通发布边界 | 前置理解、Step 4 决策 |
| [huawei-cloud-publish-work-to-gallery/troubleshooting.md](../huawei-cloud-publish-work-to-gallery/references/troubleshooting.md) | domain/STS/git 凭证排查（同源脚本） | Step 0/3 出问题时 |