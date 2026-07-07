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

import { Skill } from '../../aikernel/skill.js';

const HARMONYOS_FALLBACK_SKILL = `
---
name: harmonyos-fallback-skill
description: >
  解决 HarmonyOS 上的依赖和环境问题。当在 HarmonyOS 上运行遇到缺失的 Python 包、Node.js 库、
  编译工具链（C/C++/Rust/Go）、路径/权限错误或其他开发工具问题时使用此技能。
  提供 HarmonyOS 专属的安装源、镜像、路径映射和命令。
---

# HarmonyOS 回退技能

在 HarmonyOS 上遇到依赖或环境问题时，按以下决策树解决。

## 1. Python 与 Python 包

**安装鸿蒙版 Python：**

\`\`\`bash
curl -fsSL https://gitcode.com/OpenHarmonyPCDeveloper/cmd-pkgs/releases/download/pkgs/install.sh | sh -s -- python 3.12.9
\`\`\`

参考页面：https://gitcode.com/OpenHarmonyPCDeveloper/Python_Package_For_HarmonyOS
如果命令失败，请查看参考页面获取最新安装说明。

**PyPI 镜像（鸿蒙源）：**

\`\`\`
https://pypi.cnb.cool/OpenHarmonyPCDeveloper/pypi/-/packages/simple
\`\`\`

配置 pip 使用此镜像源安装包。

**已适配鸿蒙的 Python 包列表：**
https://cnb.cool/OpenHarmonyPCDeveloper/pypi

## 2. Node.js 包

**npm registry 镜像：**

\`\`\`
https://npm.cnb.cool/OpenHarmonyPCDeveloper/npm/-/packages/
\`\`\`

在 \`.npmrc\` 中或通过 \`npm config set registry\` 设置此镜像源。

**已适配鸿蒙的 npm 包列表：**
https://cnb.cool/OpenHarmonyPCDeveloper/npm

## 3. Homebrew 与编译工具链

仅当需要编译 C/C++、Rust、Go 等复杂场景时才需要。大多数 CLI 工具在 HarmonyOS 上已可直接运行。

**安装鸿蒙版 Homebrew（Harmonybrew）：**

\`\`\`bash
zsh -c "$(curl -fsSL https://harmonybrew.atomgit.com/install.sh)"
\`\`\`

然后配置环境：

\`\`\`bash
echo >> ~/.zshrc
echo 'eval "$(/storage/Users/currentUser/.harmonybrew/bin/brew shellenv)"' >> ~/.zshrc
eval "$(/storage/Users/currentUser/.harmonybrew/bin/brew shellenv)"
\`\`\`

参考：https://atomgit.com/Harmonybrew/docs/blob/main/zh-CN/user/install.md（鸿蒙 PC 部分）

**各应用编译指南：**
https://atomgit.com/Harmonybrew/docs/blob/main/zh-CN/user/featured-packages.md

## 4. 其他开发工具

更多鸿蒙开发工具和软件包：
https://gitcode.com/OpenHarmonyPCDeveloper/ToolLists/blob/main/README.md

## 5. 路径与权限问题

HarmonyOS 的路径与标准 Linux 系统差异显著。遇到路径或权限相关错误时，需相应调整。

### 主目录

\`~/.claude\` 等路径在 HarmonyOS 上**不受支持**。不存在 \`~\` 目录——只有 \`/data/storage/el2\` 沙箱路径可用。任何引用 home 目录路径的工具或脚本都必须改为使用沙箱路径。

### 临时目录

\`tmp\` 在 HarmonyOS 上存在但**权限受限**。如果工具或脚本因 \`/tmp\` 访问问题失败，请切换到其他可写路径。

### 通用指引

在 HarmonyOS 上遇到"文件未找到"、"权限被拒绝"或类似错误时，首先怀疑路径不兼容。在尝试其他修复之前，先将标准 Linux 路径替换为 HarmonyOS 沙箱等价路径。
`;

export function loadHarmonyosFallbackSkill(): Skill | null {
    try {
        return Skill.parseMd(HARMONYOS_FALLBACK_SKILL);
    } catch {
        return null;
    }
}

export const MANAGE_SKILLS_SKILL = `
---
name: manage-skills
description: 介绍Skills的管理：添加、删除、查询和刷新等方法
---

# Skills Management

本技能介绍并提供工具来进行Skills的安装和管理。详情参考本技能附带的内置工具。

## Skill 添加

当前我们支持使用本Skill内置的addSkillFromDirectory工具从本地目录添加Skill。
你也可以使用addSkillFromUrl工具从zip URL下载并安装Skill。
对于Registry中的Skill，可以先使用searchSkillFromRegistry工具搜索，再使用addSkillFromRegistry工具安装。

在TUI模式下，你可以使用/skills命令打开技能中心，支持从Registry平台搜索和安装技能。

### Skill 添加方式

1. **从本地目录添加**：使用addSkillFromDirectory工具，指定包含SKILL.md的本地目录路径
2. **从URL下载**：使用addSkillFromUrl工具，指定Skill的zip下载URL
3. **从Registry搜索**：使用searchSkillFromRegistry工具，指定技能名称关键字，返回技能全名、安装量、Registry名称等
4. **从Registry安装**：使用addSkillFromRegistry工具，指定技能名称和Registry名称安装技能
5. **从Registry搜索安装**（TUI模式）：使用/skills命令打开管理界面，支持从skill0、SkillsMP、ClawHub等平台搜索和安装技能

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

使用本Skill内置的deleteSkills工具可以批量删除已经安装的Skill。你可以传入一个或多个skillId。

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
