export const MANAGE_SEARCH_TOOLS_SKILL = `
---
name: manage-search-tools
description: 介绍搜索工具的管理：配置API密钥、启用/禁用工具等
---

# 搜索工具管理

本技能介绍并提供工具来进行搜索工具的配置和管理。详情参考本技能附带的内置工具的描述。

## 搜索架构

系统提供两个统一的搜索工具给AI模型使用：

1. **WebSearch** - 统一网页搜索，底层可使用多种搜索引擎（DuckDuckGo、Bing、百度、Tavily、Brave、博查、Exa）
2. **AcademicSearch** - 统一学术搜索，底层使用 arXiv、DBLP

## 可用搜索引擎

### 网页搜索引擎

1. **DuckDuckGo** - 免费的网页搜索引擎，无需API密钥
2. **Bing** - 免费的网页搜索引擎，无需API密钥（默认）
3. **百度 (Baidu)** - 中文网页搜索引擎，无需API密钥，自动过滤广告
4. **Tavily** - 专为AI设计的搜索引擎，需要API密钥
5. **Brave** - 隐私优先的搜索引擎，需要API密钥
6. **博查 (Bocha)** - 专为AI设计的中文搜索引擎，需要API密钥
7. **Exa** - AI驱动的搜索引擎，需要API密钥

### 学术搜索引擎

1. **arXiv** - 学术论文预印本搜索引擎，无需API密钥
2. **DBLP** - 计算机科学文献数据库，无需API密钥

## 配置说明

对于需要API密钥的搜索渠道（如Tavily、Brave、博查、Exa），你需要先配置相应的API密钥才能将该渠道设为默认搜索引擎。
如果用户没有给你API密钥，你需要向用户询问，请他们把密钥告诉你，否则无法正确配置。

设置默认网页搜索引擎后，所有 WebSearch 调用都会使用该渠道。
设置默认学术搜索引擎后，所有 AcademicSearch 调用都会使用该渠道。

**启用/关闭搜索工具**：
你可以通过 \`configureSearchTool\` 来启用或关闭整个搜索工具类别：
- 设置 \`channel="webSearchEnabled"\` 和 \`value="true"/"false"\` 来启用/关闭网页搜索
- 设置 \`channel="academicSearchEnabled"\` 和 \`value="true"/"false"\` 来启用/关闭学术搜索
关闭后，对应的搜索工具将不会加载到会话中。

需要注意的是，配置好的搜索工具只有在新建的会话当中才能生效。
你应当提醒他们通过\`/new\`命令或者\`Ctrl+N\`快捷键来打开新的对话来测试。
`;
