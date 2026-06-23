# ai-code-stats

统计 OpenDesk 仓库中 AI 生成的代码占比，生成可视化 HTML 报告。

## 快速开始

```bash
node scripts/ai-code-stats/generate_stats.mjs
```

运行后在 `scripts/ai-code-stats/ai_code_stats.html` 生成报告，浏览器直接打开即可查看。

## 报告内容

| 图表                     | 说明                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| 概览卡片                 | 总提交数、AI 提交数、变更行数（代码文件）、AI 行数占比                      |
| 每周 AI 提交变更行数占比 | 按周统计 AI commit 的 insertions+deletions 占该周总变更行数的比例           |
| 每周 AI 代码行存量占比   | 基于 `git blame` 逐周累积，反映仓库中 AI 代码行的占比变化趋势               |
| 每周代码行数变化         | AI 行数与总行数的累积增长曲线                                               |
| Agent 变更行数占比       | 各 AI 工具（Cursor、OpenDesk、Codex 等）的 commit 变更行数占比（饼图）      |
| Model 变更行数占比       | 各模型（Claude-4.6-Opus、DeepSeek-V4-Pro 等）的 commit 变更行数占比（饼图） |

## 判定逻辑

Commit 被判定为 AI 生成当且仅当满足以下条件之一：

1. **`Made-with: xxx`** — 直接判定为 AI
2. **`Co-authored-by: xxx`** — 仅当 co-author 名称匹配已知 AI 工具（Cursor、Roo Code、Claude、Codex、Trae、OpenDesk、Kilo Code、Genspark）时判定为 AI

以下情况**不会**被判为 AI：

- `Co-authored-by: uv0xab` — 用户自签名
- `Co-authored-by: Stella__` 等 — 人类协作者
- `Signed-off-by` / `Reviewed-by` — 非 AI 标记

## 统计范围

- 仅统计代码文件（与 `scripts/count_ai_code.py` 使用相同的 `CODE_FILE_EXTS` 白名单 + `.mjs/.cjs/.mts/.cts`）
- git blame 统计排除空行
- commit 变更行数使用 `git log --numstat` 按文件过滤后汇总

## 与 count_ai_code.py 的对齐

本工具的方法论已对齐 `scripts/count_ai_code.py`，并在以下方面做了改进：

- 正确排除人类协作者的 `Co-authored-by`（如 Stella\_\_）
- 正确排除用户自签名 `Co-authored-by: uv0xab`
- 模型名大小写归一化
- 提供完整的趋势图表，而非仅数字摘要

## 输出文件

| 文件                 | 说明                                       |
| -------------------- | ------------------------------------------ |
| `ai_code_stats.html` | 可视化报告（独立 HTML，CDN 加载 Chart.js） |
| `commits_data.json`  | 中间数据缓存，包含所有 commit 的解析结果   |
| `generate_stats.mjs` | 主脚本                                     |
