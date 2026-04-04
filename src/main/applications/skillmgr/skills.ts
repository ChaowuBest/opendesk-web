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

export const MANAGE_SKILLS_SKILL = `
---
name: manage-skills
description: 介绍Skills的管理：添加、删除、查询和刷新等方法
---

# Skills Management

本技能介绍并提供工具来进行Skills的安装和管理。详情参考本技能附带的内置工具。

## Skill 添加

当前我们支持使用本Skill内置的addSkillFromPath工具从本地目录添加Skill。
你也可以使用addSkillFromUrl工具从URL下载并安装Skill。
对于GitHub上的Skill，可以使用addSkillFromGitHubUrl工具直接从GitHub仓库安装。

在TUI模式下，你可以使用/skills命令打开技能管理界面，支持从Registry平台搜索和安装技能。

### Skill 添加方式

1. **从本地目录添加**：使用addSkillFromPath工具，指定包含SKILL.md的本地目录路径
2. **从URL下载**：使用addSkillFromUrl工具，指定Skill的下载URL
3. **从GitHub安装**：使用addSkillFromGitHubUrl工具，指定GitHub仓库URL
4. **从Registry搜索安装**（TUI模式）：使用/skills命令打开管理界面，支持从skill0、SkillsMP、ClawHub等平台搜索和安装技能

### Skill 目录格式要求

每个Skill必须包含以下结构：
- SKILL.md：必填文件，包含YAML frontmatter和Markdown正文
- scripts/：可选目录，包含可执行脚本
- references/：可选目录，包含参考文档
- assets/：可选目录，包含资源文件

SKILL.md格式：
\`\`\`yaml
---
name: skill-name
description: 技能描述
license: MIT
---

# 技能正文
\`\`\`

## 查看当前安装的Skills

使用本Skill内置的listSkills工具可以查看当前已经安装的所有Skill及其信息。

## Skill 删除

使用本Skill内置的deleteSkill工具可以删除已经安装的Skill。

## Skill 刷新

使用本Skill内置的refreshSkills工具可以重新加载所有Skill，这在添加或删除Skill后使用。

## 获取Skill目录

使用本Skill内置的getSkillsDirectory工具可以获取当前Skills的存储目录路径。

## 其他注意事项

需要注意的是，Skill中提供的工具只有在新建的会话当中才能生效。
如果用户请求在当前会话中测试你添加或更新的Skill的话，你应当提醒他们通过\`/new\`命令
或者\`Ctrl+N\`快捷键来打开新的对话来测试。这是因为在已有的对话中修改工具的定义会导致上下文
缓存失效，因此我们不会在已有的对话上下文中调整工具的定义。
`;
