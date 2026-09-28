#!/usr/bin/env bash
# setup-env.sh — 设置 Git Bash 下所需环境变量（必须 source 执行）
#   source <skill>/scripts/setup-env.sh
#
# 背景: Git Bash（MSYS2）会自动把以 / 开头的参数按 POSIX 路径转成 Windows 路径
#   （如 /v1/gallery/... → C:/Program Files/Git/v1/gallery/...，path 含空格触发 undici
#   "unescaped characters" 校验失败）。对 api.mjs / check-version.mjs 等一切带 / 前缀参数的脚本均适用。
#   本文件在 MSYS 环境且未设 MSYS_NO_PATHCONV 时置 1，PowerShell/CMD 无需。
# 参考: 同级 huawei-cloud-publish-work-to-gallery/scripts/setup-env.sh（同款机制，两处独立）

if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "⚠️  请用 source 执行: source $0" && return 1 2>/dev/null || exit 1
fi

if [ -n "${MSYSTEM:-}${MSYS:-}" ] && [ "${MSYS_NO_PATHCONV:-0}" != "1" ]; then
  export MSYS_NO_PATHCONV=1
  echo "✅ MSYS_NO_PATHCONV=1"
fi