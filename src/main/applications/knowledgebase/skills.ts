export const MANAGE_KNOWLEDGEBASE_SKILL = `
---
name: manage-knowledgebase
description: 介绍知识库服务商的管理：配置API密钥、启用/禁用服务商、创建/删除知识库等
---

# 知识库管理

本技能提供知识库服务商的配置和管理工具。通过附带的内置工具，你可以：

1. 查看所有知识库服务商的状态
2. 配置服务商的API密钥并启用/禁用
3. 创建新的知识库
4. 删除已有的知识库

## 可用知识库服务商

当前系统支持以下知识库服务商：

1. **智谱AI知识库** - 基于智谱AI开放平台的云端知识库服务，支持多种文档格式上传与语义检索，需要API密钥

## 配置说明

对于需要API密钥的知识库服务商，你需要先配置相应的API密钥并启用该服务商才能使用。
如果用户没有给你API密钥，你需要向用户询问。

需要注意的是，配置好的知识库服务商只有在新建的会话当中才能生效。
你应当提醒他们通过\`/new\`命令或者\`Ctrl+N\`快捷键来打开新的对话来测试。
`;

export const OPERATE_KNOWLEDGEBASE_SKILL = `
---
name: operate-knowledgebase
description: 提供知识库的使用功能：列出知识库、检索知识库内容、基于知识库问答、添加文件到知识库
---

# 知识库操作

本技能提供对已配置知识库的操作能力。用户可以通过自然语言指令完成知识库的查询、检索和文件管理。

## 前置条件

使用本技能的前提是用户已通过 manage-knowledgebase 技能配置并启用了至少一个知识库服务商。
如果用户尚未配置知识库服务商，应引导其先完成配置。

## 查看知识库列表

- **listKnowledgeBases**：列出所有已启用服务商下的知识库清单，包括 ID、名称、描述、文档数量等。
  可选指定 provider_id 仅列出特定服务商的知识库。

## 检索知识库

- **retrieveFromKnowledgeBase**：从指定知识库中检索与查询内容相关的文档片段，按相似度排序返回。
  需要提供 provider_id、knowledge_base_id 和 query，可选 top_k 控制返回数量（默认 5）。

## 知识库问答

- **askKnowledgeBase**：在指定知识库的上下文中提问，大模型会结合知识库内容生成回答。
  需要提供 provider_id、knowledge_base_id 和 question。

## 添加文件

- **addFilesToKnowledgeBase**：将本地文件或目录下的文件添加到知识库中，支持递归添加目录中所有受支持格式的文件。
  需要提供 provider_id、knowledge_base_id 和 paths（本地文件/目录路径列表）。

## 注意事项

- 所有操作工具都需要 provider_id 参数来指定服务商，可通过 listKnowledgeBases 获取可用的服务商和知识库信息。
- 检索和问答功能的质量取决于知识库中已有的文档内容。
`;
