# huawei-cloud-publish-ict-work

华为 ICT 大赛·实验赛题平台「作品提交」交互式 CLI —— 面向人类的一键式提交工具。

核心文件：[`cli.mjs`](cli.mjs)（编排层）+ [`scripts/`](scripts/)（原子脚本）+ [`SKILL.md`](SKILL.md)（技能/流程规范文档）。

---

## 这个项目做什么

把「把作品提交到 ICT 大赛并进入异步判题」的整条链路包成一个可交互的命令行程序：

```
Step 0 解析 IAM Domain + 生成 STS 临时凭证
   → Step 1 赛题发现 + 目标锁定（problemId / trainingCampId / name / 窗口预检）
   → Step 2 作品目录扫描 + git 红线检查（平台接口判定）
   → Step 3 git 仓库信息（gitUrl / gitBranch）与作品名
   → Step 4 提交（目标锁一致性 + A0 交叉校验 → submit → submissionId）
```

> **2026-09-30 目标锁定（防错投）**：Step 1 选定赛题后由 `list-problems.mjs --select` 写入**目标锁**
> `.ict-target.json`，`problemId`/`trainingCampId`/赛题名一律取自脚本回传的 `#selected` 结构化行
> （`#problem` 行已不再输出 ID，禁止手抄）。Step 4 的 `build-submit-params.mjs` 会校验目标锁并与
> A0 交叉校验 ID ↔ 赛题名/活动。**任何失败只转述并停止，绝不自动改投其他赛题**；锁带 `createdAt`，
> 超过 STS 凭证有效期（900s）自动作废。

`cli.mjs` 本身**不重写业务逻辑**：它通过子进程调用同目录的 `scripts/*.mjs`，解析这些脚本稳定的 stdout 契约（`#key=value` / `#problem` / `#candidate`），在缺参时交互式提问补全。想单步调用、接入自动化、或排查某一步时，也可直接运行对应脚本（`node scripts/<name>.mjs --help`）。

判题为**异步**：提交成功后平台程序后台判题，结果在做题面板更新，本工具不做轮询。

## 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js | ≥ 18（使用了 `node:readline/promises`、`node:fs` 等现代 API） |
| Python 3 | 仅 Step 0 生成 STS 凭证用到（`scripts/gen_sts.py`）；复用 `--creds-file` 时可不需要 |
| `hcloud` | 华为云 CLI，用于解析 IAM Domain（未安装时用 `--hcloud <exe>` 指定路径） |
| git | 读取/初始化作品仓库（Step 2/3），需要有对应远端仓库（GitCode/GitHub 等） |
| 网络 | 需可访问大赛开放接口 |

> Windows Git Bash 用户：先 `source scripts/setup-env.sh`，防止 MSYS 把 `/v1/...` 路径改写成 `C:/...`。PowerShell / CMD 无需。

## 快速开始

```bash
# 全交互模式（推荐首次使用）
node cli.mjs

# 查看帮助
node cli.mjs --help
```

常用参数（缺省全部交互式提问）：

```bash
node cli.mjs \
  --problem-id <id> \           # 指定赛题 ID（须配 --training-camp）
  --problem-name <name> \       # 赛题名（配合 --problem-id 时启用目标锁定 + 交叉校验，推荐）
  --training-camp <id> \        # 指定活动 ID
  --work-dir <path> \           # 指定作品目录（跳过候选扫描）
  --work-name <name> \          # 作品名（≤30 字符）
  --git-url <url> \             # 覆盖 git 地址；ssh/https 均可，目录无 .git 时自动 init + 强推
  --git-branch <name> \         # 覆盖分支
  --region cn-north-4 \         # hcloud 区域
  --creds-file <json> \         # 复用已有 sts-creds.json（跳过 Step 0 的 STS 生成）
  --yes                         # 自动确认所有确认项
  --non-interactive             # 非交互（必须提供 --problem-id/--training-camp/--work-dir）
```

退出码：`0` = 成功；`1` = 失败/取消；`2` = 参数错误。

人机提示（进度、警告、二维码/授权链接）走 **stderr**，最终成功结果块走 **stdout**——方便脚本只取结果。

## 目录结构

```
cli.mjs                 交互式编排层（核心文件）
SKILL.md                技能定义与全流程规范（脚本契约速查表在这里）
references/             接口规格、错误码、赛事规则
  ict-api-spec.md
  ict-error-codes.md
  ict-competition-rules.md
  iam-policies.md
scripts/                原子脚本（各自可独立调用，多数支持 --help）
  resolve-domain.mjs        Step 0 解析 IAM Domain
  gen_sts.py                Step 0 生成 900s STS 临时凭证
  list-problems.mjs         Step 1 拉取赛题列表；--select <n> / --select-name <kw> 选定目标并写目标锁
  check-competition-window.mjs  Step 1 赛题窗口预检
  scan-workdirs.mjs         Step 2 扫描候选作品目录
  check-ict-git-repo.mjs    Step 2 git 红线检查（调平台 A3 接口；#gitNoOrigin=1 为本地扩展分支）
  init-git-remote.mjs       Step 2 无仓库时 init + 提交 + 强推（本地扩展，上游无此脚本）
  read-git-info.mjs         Step 3 读取 gitUrl/gitBranch（含远端分支核对）
  strip-git-credential.mjs  URL 凭证剥离
  extract-workname.mjs      Step 3 从目录提取作品名
  ensure-gitcode-credential.mjs / gitcode-oauth.ensure.mjs  GitCode 凭证/OAuth
  ensure-user-tool.mjs / ensure-user-bindir.mjs  用户级工具与 PATH 保障
  build-submit-params.mjs   Step 4 装配提交参数（目标锁一致性 + A0 交叉校验 + 注入凭证/Idempotency-Key）
  submit-ict-work.mjs       Step 4 提交
  api.mjs                   通用 API 调用（STS 头注入 / 401 自动刷新）
  detect-env.mjs / check-version.mjs / list-cwd-dirs.mjs / scan-projects.mjs
  install-hcloud.ps1 / setup-env.sh
```

脚本契约（每步的成功/失败 stdout 信号）见 [`SKILL.md`](SKILL.md) 的「脚本契约速查」表。

## 安全说明

- 提交身份由 **APIG 网关注入 `X-Domain-Id`**，本地以 IAM 自委托 `SELF_VERIFY` 生成 **900s 临时 STS 凭证**；永久 AK/SK 始终留在本地，不会上传。临时凭证落在临时目录，进程退出即清理。
- `gitUrl` 在提交前经 `strip-git-credential.mjs` 剥离 `user:pass@` / `token@` 凭证段，**不会把内嵌凭证提交到平台**。
- GitCode OAuth 采用本机回调方案（`127.0.0.1:7654`），授权链接与二维码**原样展示给用户**，token 写入 `~/.gitcode/auth.toml`（权限 `0600`）。
- 仓库内不包含任何硬编码的 AK/SK/Token。
- 示例/演示仓库命中平台红线不可提交，唯一处置是回到 Step 2 更换作品目录（详见 [`references/ict-error-codes.md`](references/ict-error-codes.md)）。

## 常见问题

| 现象 | 处置 |
|---|---|
| 解析 Domain 失败 | 检查 `hcloud` 是否安装并已配置：`hcloud configure list`，或用 `--hcloud` 指定可执行文件 |
| 找不到 python3/python | 安装 Python 3，或用 `--creds-file` 复用已生成的 `sts-creds.json` |
| `#exampleRepo=1` | 作品目录命中示例仓库红线，回到 Step 2 更换目录 |
| `#gitAbsent=1` / `#gitNoOrigin=1` | 目录无 `.git` 或无 origin，用 `--git-url` 提供 git 地址自动初始化推送 |
| `#selected-locked number=… problemId=…` | 目标锁（`.ict-target.json`，默认在 `--creds-file` 同目录）已指向其他赛题：确认改投才可加 `--force`；锁超过 900s 自动作废，也可直接删除该锁文件 |
| `--problem-name` 不一致 / `PROBLEM_UNAVAILABLE` | 目标锁或 A0 校验拒绝构建参数：回 Step 1 重新选择赛题，**不要改投到其他赛题** |
| 提交非 201 | 按 [`references/ict-error-codes.md`](references/ict-error-codes.md) 对应错误码处理 |
| 提示「技能已过时」（`status=outdated`） | 平台按 `SKILL.md` frontmatter 的 `metadata.version` 比对。官方升级命令：`npx skills add https://gitcode.com/Lingxi-HandsOn/gallery.git --skill huawei-cloud-publish-ict-work -y` |

## 版本与上游同步

- 技能版本写在 [`SKILL.md`](SKILL.md) frontmatter 的 `metadata.version`（当前 `2026.09.30.001`），提交前
  [`cli.mjs`](cli.mjs) 会调 `scripts/check-version.mjs` 向平台确认；平台判定过时则**拦截提交**。
- 上游源：`https://gitcode.com/Lingxi-HandsOn/gallery.git` 的 `skills/huawei-cloud-publish-ict-work/`。
- 本目录 = 上游技能文件 + 本地扩展（`cli.mjs`、`scripts/init-git-remote.mjs`、`README.md`、`LICENSE`）。
  同步上游时按文件整体覆盖，并保留 `check-ict-git-repo.mjs` 的 `#gitNoOrigin=1` 分支与 `SKILL.md`
  中对应的两处本地扩展说明（上游 2026-09-30 起已将该场景并入 `#error=1`）。

## 与「普通投稿陈列馆」的区别

本工具**仅用于 ICT 大赛 AI 赛题的作品提交与判题**。普通陈列馆/训练营投稿（无竞赛上下文）请使用 `huawei-cloud-publish-work-to-gallery`。

## License

[MIT](LICENSE) © 2026 Kissablecho (God-2077)
