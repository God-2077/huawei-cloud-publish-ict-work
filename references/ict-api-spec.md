# API Specification — ICT 大赛作品提交（本 skill 专用）

> 承接 `openspec/changes/add-ict-competition/specs/02-接口文档.md` 的 A0/A1/A2/A3 契约（面向**机器提交**的本 skill）。普通作品发布（`/open-api-public/v1/gallery/works`）走另一 skill `huawei-cloud-publish-work-to-gallery`，本文件不覆盖。

## 前缀与鉴权

| 接口 | URI | 鉴权 |
|------|-----|------|
| A0 查询 ICT 专属活动 | `GET /open-api-public/v1/gallery/competition/camps` | open-api-public（APIG AKSK / STS，凭证经 `X-Tmp-Ak`/`X-Tmp-Sk`/`X-Security-Token` 头） |
| A1 提交 AI 赛题作品 | `POST /open-api-public/v1/gallery/competition/works` | 同上 + 网关注入身份头 `X-Domain-Id`（服务端据此反查 accountId） |
| A2 查询提交状态（轮询） | `GET /open-api-public/v1/gallery/competition/submissions/{submissionId}` | 同上 + `X-Domain-Id`（只能查本人提交，越权 404） |
| A3 检查 git 可提交性（预检） | `POST /open-api-guest/v1/gallery/competition/git-check` | 免鉴权（open-api-guest Agent 前缀，无 STS） |

- **身份链路（R16/R10）**：skill 先本地生成**最小权限 STS 临时凭证**（`gen_sts.py` → `sts-creds.json`），经 `X-Tmp-Ak`/`X-Tmp-Sk`/`X-Security-Token` 头发给网关；网关解析出 domainId 并注入 `X-Domain-Id`；gallery 用 `X-Domain-Id` 反查 `normal_users.id`（accountId）定位参赛人，**不经请求 body 传身份**。
- **本地/网关后联调**：可用 `--header "X-Domain-Id: <domainId>"` 透传测试身份（`submit-ict-work.mjs` 的 `domainId` 参数）。生产环境由网关注入，勿在 body 手传。
- 所有接口经本 skill 副本 `scripts/api.mjs` 调用（连接超时 3s，stdout 首行 `#status=<code>`；`--creds-file` 注入 STS 头，401 自动刷新）。

## A0 查询 ICT 专属活动（提交前调用）

**GET** `/open-api-public/v1/gallery/competition/camps`

- 不传 `problemId` → 返回全部 ICT 专属活动列表（本 skill 的 `list-problems.mjs` 走此路径）。
- 传 `problemId` → 返回单个活动（`{trainingCampId, problemId, name}`）。
- 逻辑：按题查 `competition_problem.trainingCampId`，校验 `theme=ict_competition` 且 `status=published`。

**成功（列表）**：

```json
{ "success": true, "code": "GALLERY.SUCCESS", "data": { "items": [
  { "trainingCampId": "camp-xxx", "problemId": "p123", "name": "AI 云原生开发·题目 01",
    "startsAt": "2026-09-18", "endsAt": "2026-11-08", "status": "published" }
] } }
```

- `trainingCampId`：提交 A1 时回填的必填字段（一题一活动，由 A0 取得，**不得用户自选**）。
- `startsAt`/`endsAt`/`status`：活动窗口与状态（`training_camps`）——技能侧窗口预检用，**以活动实际窗口为准**，服务端提交时仍 fail-closed 兜底。

## A1 提交 AI 赛题作品

**POST** `/open-api-public/v1/gallery/competition/works`，`Content-Type: multipart/form-data`

**Headers**：

| Header | 必填 | 说明 |
|--------|------|------|
| `Idempotency-Key` | 否 | 幂等键（8-128 字符）。同 key+同 body 重试返回原结果；同 key+异 body → 409 |
| `X-Domain-Id` | 是（网关注入） | 身份；缺失 → 400 `GALLERY.PARAM.MISSING` |

**Form fields**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `trainingCampId` | string | 是 | 从 A0 按 problemId 取得（一题一活动），必须等于该题对应活动 |
| `problemId` | string | 是 | 赛题标识（`competition_problem.id`） |
| `workName` | string | 是 | 作品名称（≤30 字符） |
| `gitUrl` | string | 是 | `https://` 开头、`.git` 结尾，域名白名单 + SSRF 校验 |
| `gitBranch` | string | 是 | 常规分支字符（字母/数字/`_`/`-`/`.`/`/`），1-250 |

> **2026-09-17 简化**：不再收集 `image`（封面）/`detail`（详情 zip）/`envUrl`（环境地址）。作品详情不展示封面（后续展示逻辑调整），无在线隧道。

**业务校验**：

| 校验 | 失败码 |
|------|--------|
| problemId 不能为空 | `GALLERY.PARAM.MISSING` |
| 赛题存在且 `type=ai` | `GALLERY.COMPETITION.PROBLEM_UNAVAILABLE` |
| `trainingCampId` == 该题 `trainingCampId` | `GALLERY.COMPETITION.CAMP_MISMATCH` |
| 已报名（teamStatus=4 + compCategory=T106 + trackCode∈{B210,B209}） | `GALLERY.COMPETITION.NOT_REGISTERED` |
| 报名赛道（trackCode 映射）== 赛题 `track`（双向对称拦截） | `GALLERY.COMPETITION.PROBLEM_TRACK_MISMATCH` |
| 提交在实验窗口内（优先活动起止，缺失 fallback 全局默认窗口） | `GALLERY.COMPETITION.WINDOW_EXPIRED` / `NOT_STARTED` |
| 该题已判题通过（终态）→ 不可再提交 | `GALLERY.COMPETITION.ALREADY_PASSED` |
| 该题判题中 → 不可重复提交 | `GALLERY.COMPETITION.JUDGING` |

**成功（201）**：

```json
{ "success": true, "code": "GALLERY.SUCCESS", "data": {
  "submission": {
    "submissionId": "s1", "problemId": "p123", "attemptNo": 1,
    "judgeStatus": "pending", "workId": "work-1", "workUrl": "https://gallery/works/work-1"
  }
} }
```

> **无积分字段（2026-09-17 移除白名单机制）**：A1 不再即时领取成长积分，201 响应 **无 `reward`**——积分领取仅普通作品发布通道（`claimPublishRewardAfterPublish`，每日限一次）。skill 侧不提示积分。

> **异步语义**：`judgeStatus=pending`，判题程序异步判题（2026-09-15 起拉取模式：gallery 不推送，判题方主动拉取 `/inner/v1/gallery/competition/judge/pending` 待判列表，判完经内部 `/inner/.../judge-callback` 回传后更新为 `passed`/`failed`）。**提交成功 ≠ 判题通过**，skill 提示"已提交，判题异步进行，结果在做题面板更新"，**不再轮询 A2**。

**主要失败码**：`GALLERY.PARAM.*` / `GALLERY.IDEMPOTENCY.CONFLICT` / `GALLERY.PARAM.GIT_URL_EXAMPLE_REPO`（示例仓库红线，见 A3）/ `GALLERY.COMPETITION.PROBLEM_UNAVAILABLE` / `CAMP_MISMATCH` / `NOT_REGISTERED` / `NOT_STARTED` / `WINDOW_EXPIRED` / `ALREADY_PASSED` / `JUDGING` / `GALLERY.AUTH.UNAUTHORIZED`。完整表见 [ict-error-codes.md](ict-error-codes.md)。

## A3 检查 git 仓库是否允许提交（提交前预检）

**POST** `/open-api-guest/v1/gallery/competition/git-check`（免鉴权，本 skill 经 `api.mjs --prefix open-api-guest` 调用）

- 纯静态校验：gitUrl 格式/域名白名单 + **ICT 示例仓库红线**（host+path 精确匹配，配置 `ICT_FORBIDDEN_GIT_HOST_PATHS`）。
- 用途：`check-ict-git-repo.mjs` 在 **Step 2 选定目录后**即调本接口判定示例仓库；A1 提交时服务端仍做同样强制校验（最后兜底）。
- **Body（JSON）**：`{ "gitUrl": "https://gitcode.com/Lingxi-HandsOn/demo.git" }`
- **成功（200）**：
  - 允许：`{ success:true, data:{ allowed:true } }`
  - 禁止：`{ success:true, data:{ allowed:false, host:"gitcode.com", pathPrefix:"/Lingxi-HandsOn", reason:"gitcode.com/Lingxi-HandsOn", hint:"该代码仓库属于平台示例/演示仓库，不能作为赛题作品提交。请在项目目录选择步骤重新选择您自己开发的赛题作品目录后提交；请勿 fork、拆分或另推示例仓库内容为个人作品提交" } }`
- **失败（400）**：`GALLERY.PARAM.MISSING`（缺 gitUrl）/ `GALLERY.PARAM.GIT_URL_*`（格式/域名）。

## A2 查询 AI 赛题提交状态（提交后轮询判题结果）

**GET** `/open-api-public/v1/gallery/competition/submissions/{submissionId}`

- **鉴权**：open-api-public STS + 网关注入 `X-Domain-Id`；**只能查本人提交**，越权/不存在 → 404 `GALLERY.COMPETITION.SUBMISSION_NOT_FOUND`。
- **语义**：A1 为**异步判题**（回 201 即返回，不等待判题）；判题结果由判题方经 `/inner/*` 回传更新。本接口供 skill **轮询**判题状态到终态。

**成功（200）**：

```json
{ "success": true, "code": "GALLERY.SUCCESS", "data": {
  "submission": {
    "submissionId": "s1", "problemId": "p123", "attemptNo": 1,
    "judgeStatus": "pending | passed | failed",
    "failureReason": "…（failed 时承载）",
    "workId": "work-1", "workUrl": "https://gallery/works/work-1"
  }
} }
```

- `judgeStatus=pending` → 判题中，继续轮询；`passed`（终态，作品公开展示）/ `failed`（终态，窗口内可重提）。
- `failureReason`：判题失败原因（R20），`failed` 时展示给提交人。

**主要失败码**：`GALLERY.PARAM.MISSING`（缺 X-Domain-Id）/ `GALLERY.AUTH.UNAUTHORIZED`（身份反查不到）/ `GALLERY.COMPETITION.SUBMISSION_NOT_FOUND`（404，不存在或非本人）。