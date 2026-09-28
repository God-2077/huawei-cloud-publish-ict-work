# ICT 大赛规则摘要（提交前置知识）

> 来源：`openspec/changes/add-ict-competition/prd.md`（v0.6.0）与 `specs/02-接口文档.md`。本文件只摘录 skill 提交作品需要遵守的规则；管理台/用户侧页面规则不在此列。

## 一、核心闭环

云赛项 20 道 AI 赛题走「实践中心做题 → **本 skill 提交** → gallery 建作品(待判) → 判题 agent 异步判题 → 结果回传」闭环。判题通过 +20 分，通过后作品公开展示。

## 二、提交前置门槛（三条件，均须满足）

| 门槛 | 值 | 判定来源 |
|------|-----|---------|
| 组队状态 | `teamStatus=4`（参赛成功） | 报名缓存（由 ICT 接口拉取） |
| 赛事类型 | `compCategory=T106`（实践赛） | 同上 |
| 赛道 | `trackCode∈{B210基础软件, B209云}` | B208 网络 / innovation 创新赛拦截 |

不满足 → 服务端返回 `GALLERY.COMPETITION.NOT_REGISTERED`。基础软件赛道（B210）理论上无 AI 题（全 lab），实际只云赛道（B209）有 20 道 AI 题可提交。

## 三、实验窗口与重提规则

- **实验有效完成窗口**：2026-09-18 00:00 ~ 2026-11-08 24:00（+08:00）。提交/重提须在窗口内；截止后拒绝（`WINDOW_EXPIRED`）。
- **AI 题一题一活动**：每个 AI 题对应一个 gallery 训练营活动（`theme=ict_competition`），提交时 `trainingCampId` 必须由 A0 按 `problemId` 取得并一致（`CAMP_MISMATCH` 防错挂）。
- **重提**：判题**未通过**允许不限次重提（窗口内），`attemptNo` 递增；判题**通过即终态**不可再提交（`ALREADY_PASSED`）；判题**中**不可重复提交（`JUDGING`）。
- **计分**：固定每题 20 分，通过与否只由判题结果决定（与质量/用时无关）。

## 四、判题语义（skill 交互要点）

- 提交接口返回 `judgeStatus=pending`，判题结果为**异步回传**（内部通道），30 分钟无回传置 failed。
- gallery 不存判题 skill 映射：提交传 `problemId`，判题方自行路由对应判题 skill。
- **作品可见性**：待判/未通过作品仅提交人本人可见；判题通过后公开展示（游客可看可赞）。

## 五、身份与账号（敏感字段红线）

- 提交身份 = 网关 `X-Domain-Id` → 反查 `accountId(normal_users.id)` → 匹配报名缓存。**禁止**把 `domainId` 当 `accountId` 用。
- 日志红线（AGENTS.md）：`domainId`/`userId`/`userName`/`domainName` 输出前必须 `anonymize()`；`accountId` 非敏感可明文。

## 六、与普通发布（huawei-cloud-publish-work-to-gallery）的边界

| 维度 | huawei-cloud-publish-work-to-gallery | 本 skill（huawei-cloud-publish-ict-work） |
|------|------------------------|------------------------------|
| 目标 | 陈列馆/训练营普通作品投稿 | ICT 大赛 AI 赛题提交（判题闭环） |
| 活动来源 | 用户从 camps 列表自选 | A0 按 problemId 自动确定 |
| 终态语义 | pending_review → 人工审核 | pending → 异步判题 |
| 积分 | 有（每日限一次） | **无**（2026-09-17 白名单机制移除，A1 不领取积分；积分领取仅普通作品发布通道） |