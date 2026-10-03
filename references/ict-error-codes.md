# Error Codes — ICT 大赛作品提交（GALLERY.COMPETITION.* 及其他）

> **何时读本文件**：A0/A1 返回非 2xx 时按错误码查表定位。响应统一 `{ success, code, message, httpStatus }`。

## GALLERY.COMPETITION.*（ICT 专属）

| Code | HTTP | 含义 | 处理 |
|------|------|------|------|
| `GALLERY.COMPETITION.PROBLEM_UNAVAILABLE` | 404 | 赛题不存在或非 AI 题 | `list-problems.mjs` 重查；确认 problemId 来自 A0 |
| `GALLERY.COMPETITION.CAMP_MISMATCH` | 400 | trainingCampId 与该题对应活动不一致 | 用 A0 返回的 `trainingCampId` 重新提交，禁止手工改 |
| `GALLERY.COMPETITION.NOT_REGISTERED` | 403 | 提交人未报名该赛项（teamStatus≠4 / 非 T106 / 赛道不在 B210/B209） | 告知用户去 ICT 平台完成报名或确认赛道，停止提交 |
| `GALLERY.COMPETITION.NOT_STARTED` | 403 | 实验未开始（窗口开始前） | 提示 09-18 后开放，停止提交 |
| `GALLERY.COMPETITION.WINDOW_EXPIRED` | 409 | 提交/重提超出窗口 | 提示已截止（2026-11-08），停止提交 |
| `GALLERY.COMPETITION.ALREADY_PASSED` | 409 | 该题已判题通过（终态），不可再提交 | 提示已在做题面板可见，停止提交 |
| `GALLERY.COMPETITION.JUDGING` | 409 | 该题判题中，不可重复提交 | 提示等判题结果回传后再看状态 |
| `GALLERY.COMPETITION.PROBLEM_TRACK_MISMATCH` | 403 | 报名赛道 ≠ 赛题 `track`（双向对称拦截，D-22 ✅ 2026-09-16 落地；如 basic_software/B210 账号提交 cloud AI 题） | 提示用户切换赛道后重提，或改用与赛题同赛道的报名账号。**更换赛道后仍被拦**：A1 读取 gallery 侧 `registration_caches` 缓存，不实时回源--需在落地页 `/gallery/competition`「我的参赛状态」栏点击「刷新组队信息」（C1 `?refresh=1` 回源）后再重提 |
| `GALLERY.COMPETITION.SUBMISSION_NOT_FOUND` | 404 | 判题回传的提交记录不存在 | 内部错误，无需用户侧处理 |

## 通用错误（复用现网）

| Code | HTTP | 含义 | 处理 |
|------|------|------|------|
| `GALLERY.PARAM.MISSING` | 400 | 缺必填字段 | 核对 JSON 必填键（problemId/trainingCampId/workName/gitUrl/gitBranch/idempotencyKey） |
| `GALLERY.PARAM.INVALID` | 400 | 字段格式非法 | 校验 gitBranch/gitUrl 格式 |
| `GALLERY.PARAM.GIT_URL_INVALID` | 400 | gitUrl 非 https:// + .git | 修正 gitUrl |
| `GALLERY.PARAM.GIT_URL_DOMAIN_FORBIDDEN` | 400 | gitUrl 域名不在白名单 | 托管到 gitcode/gitee/github 等 |
| `GALLERY.PARAM.GIT_URL_EXAMPLE_REPO` | 400 | gitUrl 命中 ICT 示例仓库红线（host+path,配置 `ICT_FORBIDDEN_GIT_HOST_PATHS`）；`reason` 附命中片段 | 该代码仓库属于平台示例/演示仓库，**不能**作为赛题作品提交。提示用户：**唯一处置是回到「选择项目目录」步骤重新选择**自己开发的赛题作品目录后提交；**禁止** fork 示例仓库、**禁止**拆分/另推示例内容为个人仓库提交、**禁止**提供此类变通建议（均非自研，仍会被拦）。当前提交参数不可复用，清理本次临时文件（`submit-params.json`/`sts-creds.json`） |
| `GALLERY.IDEMPOTENCY.CONFLICT` | 409 | 同幂等键不同请求体 | **重提/改名后必须用新 Idempotency-Key**（`ict-submit-<domainId>-<timestamp>`） |
| `GALLERY.AUTH.UNAUTHORIZED` | 401 | 身份/凭证无效 | 网关后确认网关正常注入 `X-Domain-Id`；本地联调检查 `domainId` 参数/STS 凭证过期 |
| `GALLERY.WORK.PUBLISH_RATE_LIMITED` | 429 | 提交过于频繁 | 等 `Retry-After` 窗口再试 |
| `GALLERY.SYSTEM.INTERNAL` | 500 | 服务内部异常 | 30s 后重试；3 次失败带 requestId 报障 |

## 处理策略

```
1. 从 api.mjs 输出取 #status 与响应体 → 提取 code/message/httpStatus。
2. 查上表：可恢复（改参数/窗口/换幂等键/重试）→ 按表处置后重提；
   ALREADY_PASSED / NOT_REGISTERED / WINDOW_EXPIRED / 政策类 → 告知用户并停止本次提交流程，不自动重试。
3. 未识别错误码 → 原样呈现给用户并报障。
```

**铁律（2026-09-30）：任何失败码都不触发自动换题。** 目标赛题在 Step 1 `--select` 选定后即锁定（目标锁 `.ict-target.json`）；任何 A1 业务拒绝（含窗口/报名/赛道/终态）一律只转述用户 + 停止本次提交，**禁止擅自改投其他赛题**。用户确需改投 → 回 Step 1 重新 `list-problems.mjs --select`（`#selected-locked` 时加 `--force`）并经用户明确确认后才可继续——否则 `build-submit-params.mjs` 的目标锁一致性校验会拒绝构建参数。锁超过 STS 凭证有效期（900s）自动作废，跨次独立提交无需 `--force`。