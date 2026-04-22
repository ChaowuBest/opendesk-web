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
#  同时剥离 ANSI 颜色码与其他 0x00-0x1F 控制字符，避免 body
#  中混入控制字符触发 GitCode 的 JSON 解析 400。
# ────────────────────────────────────────────────────────────
json_escape() {
    local s="$1"
    # 先用 Python/awk 剥离 ANSI 转义序列与控制字符，保留常见空白
    if command -v python3 >/dev/null 2>&1; then
        s=$(printf '%s' "$s" | python3 -c '
import re, sys
text = sys.stdin.read()
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
sys.stdout.write(text)
')
    else
        s=$(printf '%s' "$s" | sed -E $'s/\x1b\\[[0-9;?]*[a-zA-Z]//g' | tr -d '\000-\010\013\014\016-\037\177')
    fi
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
    # GitCode API v5 要求 access_token 作为 query 参数，body 只放业务字段
    local payload="{\"body\":\"${escaped}\"}"

    local url="${REPO_API}/pulls/${PR_NUMBER}/comments?access_token=${GITCODE_TOKEN}"
    # 日志里不打印带 token 的完整 URL
    log "POST ${REPO_API}/pulls/${PR_NUMBER}/comments"

    local response_body http_code
    response_body=$(mktemp)
    http_code=$(curl -s -w "%{http_code}" -o "${response_body}" \
        -X POST "${url}" \
        -H "Content-Type: application/json;charset=UTF-8" \
        -H "Accept: application/json" \
        --data-binary "${payload}")

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
    local payload="{\"body\":\"${escaped}\"}"

    local url="${REPO_API}/commits/${PR_COMMIT_SHA}/comments?access_token=${GITCODE_TOKEN}"

    local response_body http_code
    response_body=$(mktemp)
    http_code=$(curl -s -w "%{http_code}" -o "${response_body}" \
        -X POST "${url}" \
        -H "Content-Type: application/json;charset=UTF-8" \
        -H "Accept: application/json" \
        --data-binary "${payload}")

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

extract_failed_cases_from_jest_json() {
    local json_file="$1"
    local label="$2"
    local max_cases="${3:-20}"

    if [[ ! -f "${json_file}" ]]; then
        return
    fi

    local cases
    if ! cases=$(node - "${json_file}" "${max_cases}" <<'NODE'
const fs = require('fs');

const file = process.argv[2];
const maxCases = Number(process.argv[3] || 20);

function cleanMessage(msg) {
  if (!msg) return '';
  const noAnsi = String(msg).replace(/\u001b\[[0-9;]*m/g, '');
  const line = noAnsi
    .split('\n')
    .map((x) => x.trim())
    .find(Boolean) || '';
  return line.replace(/^Error:\s*/, '').trim();
}

try {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const failed = [];

  for (const suite of report.testResults || []) {
    const suiteFile = suite.name || suite.testFilePath || 'unknown-file';
    for (const test of suite.assertionResults || []) {
      if (test.status !== 'failed') continue;
      const fullName = [...(test.ancestorTitles || []), test.title].filter(Boolean).join(' > ');
      const summary = cleanMessage((test.failureMessages || [])[0] || '');
      failed.push({ suiteFile, fullName: fullName || '(unnamed test)', summary });
    }
  }

  if (!failed.length) process.exit(0);

  const shown = failed.slice(0, maxCases);
  for (const item of shown) {
    const filePart = `(${item.suiteFile})`;
    if (item.summary) {
      console.log(`- ${item.fullName} ${filePart} => ${item.summary}`);
    } else {
      console.log(`- ${item.fullName} ${filePart}`);
    }
  }

  if (failed.length > maxCases) {
    console.log(`- ... 其余 ${failed.length - maxCases} 个失败用例已省略`);
  }
} catch (error) {
  process.stderr.write(`[gitcode-notify] 解析 Jest 结果失败: ${error.message}\n`);
  process.exit(2);
}
NODE
); then
        return
    fi

    if [[ -z "${cases}" ]]; then
        return
    fi

    cat <<BLOCK

<details>
<summary>${label}</summary>

${cases}

</details>
BLOCK
}

extract_failed_cases_from_test_log() {
    local log_file="$1"
    local label="$2"
    local max_cases="${3:-20}"

    if [[ ! -f "${log_file}" ]]; then
        return
    fi

    local cases
    cases=$(grep -E '^[[:space:]]*● ' "${log_file}" | sed -E 's/^[[:space:]]*●[[:space:]]*/- /' | head -n "${max_cases}" || true)

    if [[ -z "${cases}" ]]; then
        return
    fi

    cat <<BLOCK

<details>
<summary>${label}</summary>

${cases}

</details>
BLOCK
}

# ────────────────────────────────────────────────────────────
#  合并多个 Jest JSON 结果，输出单一失败用例块
#  用法：extract_failed_cases_combined <label> <max_cases> <json1> [json2 ...]
# ────────────────────────────────────────────────────────────
extract_failed_cases_combined() {
    local label="$1"
    local max_cases="$2"
    shift 2

    local files=()
    for f in "$@"; do
        [[ -f "$f" ]] && files+=("$f")
    done
    [[ ${#files[@]} -eq 0 ]] && return

    local cases
    if ! cases=$(node - "${max_cases}" "${files[@]}" <<'NODE'
const fs = require('fs');

const maxCases = Number(process.argv[2] || 20);
const files = process.argv.slice(3);

function cleanMessage(msg) {
  if (!msg) return '';
  const noAnsi = String(msg).replace(/\u001b\[[0-9;]*m/g, '');
  const line = noAnsi
    .split('\n')
    .map((x) => x.trim())
    .find(Boolean) || '';
  return line.replace(/^Error:\s*/, '').trim();
}

const failed = [];
for (const file of files) {
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const suite of report.testResults || []) {
      const suiteFile = suite.name || suite.testFilePath || 'unknown-file';
      for (const test of suite.assertionResults || []) {
        if (test.status !== 'failed') continue;
        const fullName = [...(test.ancestorTitles || []), test.title].filter(Boolean).join(' > ');
        const summary = cleanMessage((test.failureMessages || [])[0] || '');
        failed.push({ suiteFile, fullName: fullName || '(unnamed test)', summary });
      }
    }
  } catch (error) {
    process.stderr.write(`[gitcode-notify] 解析 ${file} 失败: ${error.message}\n`);
  }
}

if (!failed.length) process.exit(0);

const shown = failed.slice(0, maxCases);
for (const item of shown) {
  const filePart = `(${item.suiteFile})`;
  if (item.summary) {
    console.log(`- ${item.fullName} ${filePart} => ${item.summary}`);
  } else {
    console.log(`- ${item.fullName} ${filePart}`);
  }
}

if (failed.length > maxCases) {
  console.log(`- ... 其余 ${failed.length - maxCases} 个失败用例已省略`);
}
NODE
); then
        return
    fi

    [[ -z "${cases}" ]] && return

    cat <<BLOCK

<details>
<summary>${label}</summary>

${cases}

</details>
BLOCK
}

# ────────────────────────────────────────────────────────────
#  合并多个文本日志，从测试输出里抓取失败用例（回退）
#  用法：extract_failed_cases_from_test_log_combined <label> <max_cases> <log1> [log2 ...]
# ────────────────────────────────────────────────────────────
extract_failed_cases_from_test_log_combined() {
    local label="$1"
    local max_cases="$2"
    shift 2

    local tmp
    tmp=$(mktemp)
    local any=0
    for f in "$@"; do
        if [[ -f "$f" ]]; then
            cat "$f" >> "$tmp"
            any=1
        fi
    done

    if [[ "$any" -eq 0 ]]; then
        rm -f "$tmp"
        return
    fi

    local cases
    cases=$(grep -E '^[[:space:]]*● ' "$tmp" | sed -E 's/^[[:space:]]*●[[:space:]]*/- /' | head -n "${max_cases}" || true)
    rm -f "$tmp"

    [[ -z "${cases}" ]] && return

    cat <<BLOCK

<details>
<summary>${label}</summary>

${cases}

</details>
BLOCK
}

# ────────────────────────────────────────────────────────────
#  合并多个日志文件，输出单一日志尾部块
#  用法：extract_combined_log_tail <label> <max_lines> <file1> [file2 ...]
#  多个文件之间会插入 `===== basename =====` 分隔符
# ────────────────────────────────────────────────────────────
extract_combined_log_tail() {
    local label="$1"
    local max_lines="${2:-${MAX_LOG_LINES}}"
    shift 2

    local tmp
    tmp=$(mktemp)
    local any=0
    local multi=0
    local count=0
    for f in "$@"; do
        [[ -f "$f" ]] && count=$((count + 1))
    done
    [[ "$count" -gt 1 ]] && multi=1

    for f in "$@"; do
        if [[ -f "$f" ]]; then
            if [[ "$multi" -eq 1 ]]; then
                [[ "$any" -eq 1 ]] && printf '\n' >> "$tmp"
                printf '===== %s =====\n' "$(basename "$f")" >> "$tmp"
            fi
            cat "$f" >> "$tmp"
            any=1
        fi
    done

    if [[ "$any" -eq 0 ]]; then
        rm -f "$tmp"
        return
    fi

    local total_lines
    total_lines=$(wc -l < "$tmp")
    local snippet
    snippet=$(tail -n "${max_lines}" "$tmp")
    rm -f "$tmp"

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
#  合并「失败用例 + 测试日志尾部」为同一个 <details> 块
#  用法：extract_test_section_combined <label> <max_lines> <max_cases> \
#         <unit_json> <search_json> <test_log> <test_search_log>
# ────────────────────────────────────────────────────────────
extract_test_section_combined() {
    local label="$1"
    local max_lines="$2"
    local max_cases="$3"
    local unit_json="$4"
    local search_json="$5"
    local unit_log="$6"
    local search_log="$7"

    # ── 1. 失败用例：优先从 jest JSON 提取 ──
    local failed_bullets=""
    local json_files=()
    [[ -f "${unit_json}"   ]] && json_files+=("${unit_json}")
    [[ -f "${search_json}" ]] && json_files+=("${search_json}")

    if [[ ${#json_files[@]} -gt 0 ]]; then
        failed_bullets=$(node - "${max_cases}" "${json_files[@]}" <<'NODE' || true
const fs = require('fs');

const maxCases = Number(process.argv[2] || 20);
const files = process.argv.slice(3);

function cleanMessage(msg) {
  if (!msg) return '';
  const noAnsi = String(msg).replace(/\u001b\[[0-9;]*m/g, '');
  const line = noAnsi
    .split('\n')
    .map((x) => x.trim())
    .find(Boolean) || '';
  return line.replace(/^Error:\s*/, '').trim();
}

const failed = [];
for (const file of files) {
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const suite of report.testResults || []) {
      const suiteFile = suite.name || suite.testFilePath || 'unknown-file';
      for (const test of suite.assertionResults || []) {
        if (test.status !== 'failed') continue;
        const fullName = [...(test.ancestorTitles || []), test.title].filter(Boolean).join(' > ');
        const summary = cleanMessage((test.failureMessages || [])[0] || '');
        failed.push({ suiteFile, fullName: fullName || '(unnamed test)', summary });
      }
    }
  } catch (error) {
    process.stderr.write(`[gitcode-notify] 解析 ${file} 失败: ${error.message}\n`);
  }
}

if (!failed.length) process.exit(0);

const shown = failed.slice(0, maxCases);
for (const item of shown) {
  const filePart = `(${item.suiteFile})`;
  if (item.summary) {
    console.log(`- ${item.fullName} ${filePart} => ${item.summary}`);
  } else {
    console.log(`- ${item.fullName} ${filePart}`);
  }
}

if (failed.length > maxCases) {
  console.log(`- ... 其余 ${failed.length - maxCases} 个失败用例已省略`);
}
NODE
)
    fi

    # 回退：JSON 无结果时，从文本日志里抓取
    if [[ -z "${failed_bullets}" ]]; then
        local tmp_fb
        tmp_fb=$(mktemp)
        for f in "${unit_log}" "${search_log}"; do
            [[ -f "$f" ]] && cat "$f" >> "${tmp_fb}"
        done
        if [[ -s "${tmp_fb}" ]]; then
            failed_bullets=$(grep -E '^[[:space:]]*● ' "${tmp_fb}" \
                | sed -E 's/^[[:space:]]*●[[:space:]]*/- /' \
                | head -n "${max_cases}" || true)
        fi
        rm -f "${tmp_fb}"
    fi

    # ── 2. 合并日志文件内容 ──
    local tmp_log
    tmp_log=$(mktemp)
    local file_count=0
    for f in "${unit_log}" "${search_log}"; do
        [[ -f "$f" ]] && file_count=$((file_count + 1))
    done

    local any_log=0
    for f in "${unit_log}" "${search_log}"; do
        if [[ -f "$f" ]]; then
            if [[ "${file_count}" -gt 1 ]]; then
                [[ "${any_log}" -eq 1 ]] && printf '\n' >> "${tmp_log}"
                printf '===== %s =====\n' "$(basename "$f")" >> "${tmp_log}"
            fi
            cat "$f" >> "${tmp_log}"
            any_log=1
        fi
    done

    # 没失败用例也没日志内容 → 整块跳过
    if [[ "${any_log}" -eq 0 && -z "${failed_bullets}" ]]; then
        rm -f "${tmp_log}"
        return
    fi

    local snippet="" truncation_note=""
    if [[ "${any_log}" -eq 1 ]]; then
        local total_lines
        total_lines=$(wc -l < "${tmp_log}")
        snippet=$(tail -n "${max_lines}" "${tmp_log}")
        if [[ "${total_lines}" -gt "${max_lines}" ]]; then
            truncation_note="(仅显示最后 ${max_lines} 行，共 ${total_lines} 行)"
        fi
    fi
    rm -f "${tmp_log}"

    # ── 3. 组装输出 ──
    printf '\n<details>\n<summary>%s %s</summary>\n\n' "${label}" "${truncation_note}"

    if [[ -n "${failed_bullets}" ]]; then
        printf '**失败用例（最多 %s 条）：**\n\n%s\n\n' "${max_cases}" "${failed_bullets}"
    fi

    if [[ -n "${snippet}" ]]; then
        printf '```\n%s\n```\n\n' "${snippet}"
    fi

    printf '</details>\n'
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
        body+="$(extract_combined_log_tail "📋 测试日志" 20 \
            "${log_dir}/test.log" "${log_dir}/test-search.log")"
    else
        body+="$(extract_log_tail "${log_dir}/build.log" "🔨 构建日志")"
        body+="$(extract_test_section_combined "🧪 测试日志" "${MAX_LOG_LINES}" 30 \
            "${log_dir}/jest-unit-results.json" "${log_dir}/jest-search-results.json" \
            "${log_dir}/test.log" "${log_dir}/test-search.log")"
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
