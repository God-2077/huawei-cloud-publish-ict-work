# IAM Policies

## Overview

本 skill 在运行前需要确认调用方的华为云账号身份（Domain ID / 账号名），并基于用户 AK/SK
生成最小权限 STS 临时凭证以调用平台开放接口。所需 IAM 权限仅限**查询用户信息**，不包含任何
资源写操作（Create / Update / Delete）。

## Required IAM Permissions

| 操作 | 权限动作 | 说明 |
|------|----------|------|
| 查询用户信息 | `iam:users:get` | 经 `hcloud IAM`（`KeystoneListAuthDomains` 等）解析账号身份 |
| 校验调用方身份 | `sts:getCallerIdentity` | 生成 STS 临时凭证、网关解析账号身份所需 |

## IAM Policy JSON（最小权限）

```json
{
  "Version": "1.1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "iam:users:get",
        "sts:getCallerIdentity"
      ],
      "Resource": ["*"]
    }
  ]
}
```

## 安全说明

- 永久 AK/SK 仅存本地（环境变量），不上传、不落盘明文。
- 每次运行生成 900s 有效期的 STS 临时凭证，经请求头传递；401 时自动续期。
- 遵循最小权限原则：仅查询用户信息，不做任何资源写操作。
- 不涉及任何华为云资源创建、修改或删除。