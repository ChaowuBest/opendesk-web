/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

export const FILE_NAVIGATION_SKILL = `
---
name: file-navigation
description: 在 OpenDesk 本地文件相关工具之间选择与组合使用的决策指南
---

# 文件导航与搜索指南

当用户要你定位、查看或操作本地文件时，OpenDesk 提供了多个 tool，每种适合不同场景。选错 tool 会浪费资源或得到错误结果。

## 决策路径

按顺序检查下列问题，选第一个符合的 tool：

1. **用户给了精确路径，且文件是普通文本/代码** → \`readFile('<path>')\`

2. **用户给了精确路径，且文件可能是结构化文档** → \`extractText('<path>')\`
   - 适用：pdf、doc、docx、pptx、xls、xlsx、odt、odp、ods、md、json、代码文件等可提取文本的文件
   - 返回从文件中提取出的文本；结构化文档优先使用它，不要用 readFile 强行读二进制内容

3. **用户要按文件名/路径通配符匹配** → \`globFiles('docs/**/*.md')\`
   - 适用："列出所有 markdown 文件"、"找 src 目录下的所有 .ts 文件"
   - 不调用 embedding API，最快最精确

4. **用户要在文件内容里找精确字符串/正则** → \`grepFiles(pattern)\`
   - 适用："找用到 \\\`useEffect\\\` 的文件"、"grep 'TODO'"
   - 不调用 embedding API

5. **用户要语义地找文件或不知道精确关键词** → \`semanticSearch(query)\`
   - 适用："找和 auth 相关的文件"、"财务类的文档在哪"、"哪些文件提到了 React Hooks"、"找讲 Q3 营收的文档"
   - 同时匹配文件标题和内容 chunk，返回 Markdown bullet list，包含完整路径、匹配标题和匹配片段
   - 调用 embedding API，成本较高

## 使用建议

- **优先用非语义 tool**（globFiles / grepFiles），它们更便宜更精确
- **语义搜索结果是候选，不是答案**；拿到后可能还要 \`extractText\` 读具体文件确认
- **不要对同一问题重复调多个 search**——先想清楚用哪个
- **搜索返回空时不要盲目放宽 query 重试**；先检查返回值的 \`warning\` 字段
- 语义搜索默认返回 file-level 结果（一个文件一条，不重复）

## 处理 warning 字段

搜索结果可能包含 \`warning\` 字段，表示索引状态异常：

- \`首次扫描进行中\` → 告知用户"文件索引正在构建中，请稍后重试"，**不要反复尝试**
- \`未配置向量嵌入模型\` 或带有 \`code: 'EMBED_UNAVAILABLE'\` 的结果 → 嵌入模型不可用，**不要重试 semanticSearch**；改用 \`grepFiles\` / \`globFiles\` 完成本次查询，并告知用户运行 \`/config\` 配置嵌入模型
- \`未配置扫描目录\` → 告知用户需要运行 \`/config\` 添加文件扫描路径

## semanticSearch 的边界

| 查询意图 | 选择 | 原因 |
|---|---|---|
| "找财务文档" | semanticSearch | "财务"可能体现在标题或正文 |
| "找提到预算的段落" | semanticSearch | "预算"可能只出现在正文 |
| "draft.md 在哪" | globFiles | 精确文件名匹配 |
| "哪里用了 \\\`BaseStorage\\\`" | grepFiles | 精确符号匹配 |
| "有没有 Q3 报告这类文档" | semanticSearch | 类型匹配可能在标题或正文 |
| "哪个文件讲了迁移方案" | semanticSearch | "迁移方案"是内容特征 |

如果一次 semanticSearch 结果不理想，先考虑：
- 用户是否想找的是某个特定格式的文件（此时 globFiles 更直接）
- 用户是否给出了精确字符串或代码符号（此时 grepFiles 更直接）
- 是不是文件根本没被扫描（确认 /fs-status 里有这个目录）
`;
