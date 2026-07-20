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

import { Skill } from '../../../skill.js';

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
