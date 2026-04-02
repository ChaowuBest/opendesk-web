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

import { Skill } from '../skill.js'
import { BaseToolset } from '../tool.js'
import {
    ListSoulsTool,
    GetSoulTool,
    CreateSoulTool,
    UpdateSoulTool,
    DeleteSoulTool,
    SwitchSoulTool,
    ResetDefaultSoulTool,
} from './tools.js'

export const MANAGE_SOULS_SKILL = `
---
name: manage-souls
description: 管理智能体的人设：查看、修改、创建、删除和切换人设
---

# 人设（Soul）管理

本技能用于管理 OpenDesk 的 AI 人设。人设定义了 AI 助手的性格、语气、专长和行为准则。

## 核心概念

- 每个人设有一个不可变的 **uid**（唯一标识符）和一个用户可自定义的 **name**（昵称/名字）。
- uid 是系统内部使用的标识，不会改变；name 是用户看到的友好名称，可以随时修改。
- 系统始终有一个 uid 为 "default" 的默认人设，不可删除。

## 重要原则：优先修改，而非新建

**当用户想要调整、改变或优化当前人设时，应该使用 \`updateSoul\` 修改现有人设，而不是创建新的人设。**

只有当用户明确要求"创建一个新的人设"、"再来一个人设"、"新建"等意图时，才使用 \`createSoul\`。

典型场景对应：
| 用户意图 | 正确操作 |
|---------|---------|
| "帮我改一下人设，加上幽默感" | \`updateSoul\`（修改当前激活的人设） |
| "我想让你更专业一点" | \`updateSoul\`（修改当前激活的人设） |
| "把名字改成小明" | \`updateSoul\`（修改 name 字段） |
| "创建一个翻译专家的人设" | \`createSoul\`（这是全新的人设） |
| "我想要一个完全不同的人设" | \`createSoul\`（用户明确要新建） |

## 操作指南

### 查看人设

使用 \`listSouls\` 查看所有人设及当前激活的人设（每条包含 uid、name、描述、是否激活）。
使用 \`getSoul\` 查看某个人设的完整内容（传入 uid）。

### 修改人设（首选）

使用 \`updateSoul\` 修改已有人设。传入 uid，可选更新 name（昵称）、description（描述）或 body（内容）。
- 修改当前激活的人设时，先用 \`listSouls\` 获取其 uid。
- 可以只传需要修改的字段，未传的字段保持不变。

### 创建人设

仅在用户明确需要全新人设时使用 \`createSoul\`。需要提供：
- \`name\`：人设的昵称/名字（用户可见的友好名称，可以是中文）
- \`description\`：简短描述
- \`body\`：人设的完整 Markdown 内容

创建成功后会返回系统分配的 uid。

### 删除人设

使用 \`deleteSoul\` 删除人设（传入 uid）。默认人设（uid="default"）不可删除。

### 切换人设

使用 \`switchSoul\` 切换当前激活的人设（传入 uid）。切换后需要开启新会话才能生效。

### 重置默认人设

使用 \`resetDefaultSoul\` 将系统默认人设（uid="default"）重置为初始状态。这会覆盖用户对默认人设的任何修改。
当用户觉得默认人设被改乱了、想要恢复原始设置时使用。
`

/**
 * aikernel 内置的 Soul skill provider，在 SkillRegistry 初始化时自动注册。
 */
export class SoulSkillProvider {
    async getSkills(): Promise<Skill[]> {
        const skill = Skill.parseMd(MANAGE_SOULS_SKILL)
        const toolset = new BaseToolset('manage-souls')

        toolset.addTool(new ListSoulsTool())
        toolset.addTool(new GetSoulTool())
        toolset.addTool(new CreateSoulTool())
        toolset.addTool(new UpdateSoulTool())
        toolset.addTool(new DeleteSoulTool())
        toolset.addTool(new SwitchSoulTool())
        toolset.addTool(new ResetDefaultSoulTool())

        skill.toolsets = [toolset]
        return [skill]
    }
}
