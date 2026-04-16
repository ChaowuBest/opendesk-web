#!/usr/bin/env bash
#
# GitCode API 回报脚本
# 用法：
#   gitcode-notify.sh comment <body>
#   gitcode-notify.sh comment-with-logs <success|failure|aborted>
#
# 环境变量（由 Jenkinsfile 注入）：
#   GITCODE_TOKEN       - GitCode Personal Access Token
#   GITCODE_API_BASE    - API 基址，如 https://api.gitcode.com/api/v5
#   GITCODE_OWNER       - 仓库 Owner
#   GITCODE_REPO        - 仓库名
#   PR_NUMBER           - PR 编号 (iid)
#   PR_COMMIT_SHA       - PR 最新 commit SHA（可选，用于 commit comment 回退）
#   CI_LOG_DIR          - 构建日志目录
#   BUILD_URL           - Jenkins 构建页面 URL
#
# 注意：GitCode 不支持 Commit Status API (/statuses/:sha)，
# 因此所有回报均通过 PR Comment 实现。

set -euo pipefail

ACTION="${1:?用法: gitcode-notify.sh <comment|comment-with-logs> ...}"
shift

MAX_LOG_LINES=80

log() { echo "[gitcode-notify] $*"; }

: "${GITCODE_TOKEN:?需要设置 GITCODE_TOKEN}"
: "${GITCODE_API_BASE:?需要设置 GITCODE_API_BASE}"
: "${GITCODE_OWNER:?需要设置 GITCODE_OWNER}"
: "${GITCODE_REPO:?需要设置 GITCODE_REPO}"

REPO_API="${GITCODE_API_BASE}/repos/${GITCODE_OWNER}/${GITCODE_REPO}"

# ────────────────────────────────────────────────────────────
#  将字符串转义为 JSON 安全的值（不含外层引号）
#  处理：反斜杠、双引号、换行、回车、制表符
# ────────────────────────────────────────────────────────────
json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

# ────────────────────────────────────────────────────────────
#  发 PR 评论
#  POST /api/v5/repos/:owner/:repo/pulls/:number/comments
# ────────────────────────────────────────────────────────────
post_pr_comment() {
    local body="$1"

    if [[ -z "${PR_NUMBER:-}" ]]; then
        log "跳过: PR_NUMBER 未设置（非 PR 触发？）"
        fallback_commit_comment "${body}"
        return 0
    fi

    log "发布 PR #${PR_NUMBER} 评论"

    local escaped
    escaped=$(json_escape "${body}")
    local payload="{\"access_token\":\"${GITCODE_TOKEN}\",\"body\":\"${escaped}\"}"

    local url="${REPO_API}/pulls/${PR_NUMBER}/comments"
    log "POST ${url}"

    local response_body http_code
    response_body=$(mktemp)
    http_code=$(curl -s -w "%{http_code}" -o "${response_body}" \
        -X POST "${url}" \
        -H "Content-Type: application/json" \
        -d "${payload}")

    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
        log "PR 评论发布成功 (HTTP ${http_code})"
    else
        log "警告: PR 评论 API 返回 HTTP ${http_code}"
        log "响应: $(cat "${response_body}")"
        log "尝试 commit comment 回退..."
        fallback_commit_comment "${body}"
    fi
    rm -f "${response_body}"
}

# ── 回退：通过 commit comment 报告 ──
fallback_commit_comment() {
    local body="$1"

    if [[ -z "${PR_COMMIT_SHA:-}" ]]; then
        log "跳过回退: PR_COMMIT_SHA 未设置"
        return 0
    fi

    log "回退到 commit comment (sha=${PR_COMMIT_SHA:0:8})"

    local escaped
    escaped=$(json_escape "${body}")
    local payload="{\"access_token\":\"${GITCODE_TOKEN}\",\"body\":\"${escaped}\"}"

    local url="${REPO_API}/commits/${PR_COMMIT_SHA}/comments"

    local response_body http_code
    response_body=$(mktemp)
    http_code=$(curl -s -w "%{http_code}" -o "${response_body}" \
        -X POST "${url}" \
        -H "Content-Type: application/json" \
        -d "${payload}")

    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
        log "Commit comment 发布成功 (HTTP ${http_code})"
    else
        log "警告: Commit comment API 也返回 HTTP ${http_code}"
        log "响应: $(cat "${response_body}")"
    fi
    rm -f "${response_body}"
}

# ────────────────────────────────────────────────────────────
#  从日志文件中提取尾部内容
# ────────────────────────────────────────────────────────────
extract_log_tail() {
    local log_file="$1"
    local label="$2"
    local max_lines="${3:-${MAX_LOG_LINES}}"

    if [[ ! -f "${log_file}" ]]; then
        return
    fi

    local total_lines
    total_lines=$(wc -l < "${log_file}")

    local snippet
    snippet=$(tail -n "${max_lines}" "${log_file}")

    local truncation_note=""
    if [[ "${total_lines}" -gt "${max_lines}" ]]; then
        truncation_note="(仅显示最后 ${max_lines} 行，共 ${total_lines} 行)"
    fi

    cat <<BLOCK

<details>
<summary>${label} ${truncation_note}</summary>

\`\`\`
${snippet}
\`\`\`

</details>
BLOCK
}

# ────────────────────────────────────────────────────────────
#  组装带日志的 PR 评论
#  comment-with-logs <success|failure|aborted>
# ────────────────────────────────────────────────────────────
read_status_file() {
    local status_file="$1"
    local default="$2"

    if [[ -f "${status_file}" ]]; then
        cat "${status_file}"
    else
        echo "${default}"
    fi
}

status_to_emoji() {
    local status="$1"
    case "${status}" in
        success) echo "✅ 通过" ;;
        failure) echo "❌ 失败" ;;
        skipped) echo "⏭️ 跳过" ;;
        *)       echo "❓ 未知" ;;
    esac
}

comment_with_logs() {
    local result="$1"
    local log_dir="${CI_LOG_DIR:-ci-logs}"
    local build_url="${BUILD_URL:-}"

    local status_build status_test header

    status_build=$(status_to_emoji "$(read_status_file "${log_dir}/build.status" "unknown")")
    status_test=$(status_to_emoji "$(read_status_file "${log_dir}/test.status" "unknown")")

    case "${result}" in
        success)
            header="## ✅ CI 构建通过"
            ;;
        failure)
            header="## ❌ CI 构建失败"
            ;;
        aborted)
            header="## ⚠️ CI 已取消"
            status_build="⚠️ 已取消"
            status_test="⚠️ 已取消"
            ;;
    esac

    local body="${header}

| 阶段 | 结果 |
|------|------|
| Build | ${status_build} |
| Test  | ${status_test} |
"

    if [[ "${result}" == "success" ]]; then
        body+="
所有阶段通过。"
        body+="$(extract_log_tail "${log_dir}/test.log" "📋 测试日志" 20)"
    else
        body+="$(extract_log_tail "${log_dir}/npm-install.log" "📦 npm install 日志" 40)"
        body+="$(extract_log_tail "${log_dir}/build.log" "🔨 构建日志")"
        body+="$(extract_log_tail "${log_dir}/test.log" "🧪 测试日志")"
    fi

    if [[ -n "${build_url}" ]]; then
        body+="

---
[查看完整日志](${build_url}console)"
    fi

    post_pr_comment "${body}"
}

# ── 路由 ──
case "${ACTION}" in
    comment)
        post_pr_comment "$*"
        ;;
    comment-with-logs)
        comment_with_logs "${1:?缺少 result (success|failure|aborted)}"
        ;;
    *)
        echo "未知操作: ${ACTION}" >&2
        echo "用法: gitcode-notify.sh <comment|comment-with-logs> ..." >&2
        exit 1
        ;;
esac
