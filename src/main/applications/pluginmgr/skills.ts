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

import { getLocale } from '../../../locale/index.js';

const ZH_CN_MANAGE_PLUGINS_SKILL = `
---
name: manage-plugins
description: 管理 OpenDesk 插件，包括查询、安装、卸载、启停和重新加载
---

# OpenDesk 插件管理

使用本技能附带的工具管理符合 OpenDesk 插件规范的插件。

## 查询

- 使用 listPlugins 查看插件来源、版本、启用状态和运行状态。
- 使用 getPluginDetails 查看指定插件的 manifest、Skills、MCP、能力和完整性校验结果。

## 安装

使用 installPlugin 安装插件。spec 支持本地目录、本地 TGZ 文件、HTTP/HTTPS URL 和 npm package spec。
安装源必须是符合 OpenDesk 插件规范的包；npm 安装默认不会运行生命周期脚本。

## 卸载

使用 uninstallPlugin 卸载插件。只有通过 PluginMgr 托管安装的 managed 插件可以卸载；builtin、local 和 external 插件不能通过该工具删除。

## 启用和禁用

使用 setPluginEnabled 修改插件启用状态。该操作会重新加载插件运行时，并同步刷新插件提供的 Tools、Skills 和 MCP。

## 重新加载

当 external 插件或运行时插件目录中的文件发生变化时，使用 reloadPlugins 重新执行插件发现和注册。
`;

const EN_US_MANAGE_PLUGINS_SKILL = `
---
name: manage-plugins
description: Manage OpenDesk plugins, including listing, installation, removal, enablement and reload
---

# OpenDesk Plugin Management

Use the tools attached to this Skill to manage packages that comply with the OpenDesk plugin specification.

## Inspect

- Use listPlugins to inspect plugin sources, versions, enabled states and runtime states.
- Use getPluginDetails to inspect a plugin manifest, Skills, MCP servers, capabilities and integrity verification.

## Install

Use installPlugin with a local directory, local TGZ file, HTTP/HTTPS URL or npm package spec.
The source must be a valid OpenDesk plugin package. npm lifecycle scripts are not run during installation.

## Uninstall

Use uninstallPlugin for managed plugins. Builtin, local and external plugins are not deleted by this tool.

## Enable or disable

Use setPluginEnabled to change plugin state. The plugin runtime is reloaded and contributed Tools, Skills and MCP servers are refreshed.

## Reload

Use reloadPlugins after changing an external plugin or a plugin under a runtime plugin directory.
`;

export function getManagePluginsSkill(): string {
    return getLocale() === 'en-US' ? EN_US_MANAGE_PLUGINS_SKILL : ZH_CN_MANAGE_PLUGINS_SKILL;
}
