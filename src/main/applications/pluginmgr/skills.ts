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

export const MANAGE_PLUGINS_SKILL = `
---
name: manage-plugins
description: 管理并协助用户开发 OpenDesk 插件 (查询、校验、安装、启停、卸载)
---

# OpenDesk 插件管理

本技能负责管理已有的 OpenDesk 插件目录或安装包，以及协助用户设计、编写或修改插件源码。
需要开发插件时，请你阅读 [OpenDesk 插件开发指南](https://opendesk.matrix.openharmony.cn/docs/plugins/development/)，并根据指南中的引导生成插件实现。

插件会在 OpenDesk 主进程中以受信任的 Node.js 代码运行。安装或启用前必须向用户说明代码执行、依赖安装和网络访问影响，并取得用户确认。

## 工具路由

- listPlugins：查询插件来源、版本、启用状态和运行状态。
- getPluginDetails：查看指定插件的声明、贡献项和校验结果。
- installPlugin：安装本地目录、ZIP、TGZ、HTTP/HTTPS URL 或 npm spec。安装完成后运行时会自动刷新，不要紧接着重复调用 reloadPlugins。
- uninstallPlugin：卸载 plugins 目录中的插件（包括通过 installPlugin 安装和手工放入的插件）。来源为 builtin 的插件不能通过该工具删除，包括内置插件目录，以及 --plugins-directory / OPENDESK_PLUGINS_DIRECTORY / externalPaths 附加的插件目录中的插件。
- setPluginEnabled：启用或禁用插件，并刷新该插件提供的能力。清单里声明了 "system: true" 的内置插件启停由 OpenDesk 固定，该工具会拒绝修改，应向用户说明原因。
- reloadPlugins：重新发现并加载全部插件，适用于插件文件在 PluginMgr 之外发生变化（含附加插件目录）的情况。

不要猜测工具归属，也不要调用上述列表之外的插件管理工具。卸载请求必须使用本技能的 uninstallPlugin，不能通过文件工具直接删除 plugins 目录中的插件。

## 操作流程

### 查询与诊断

1. 使用 listPlugins 定位插件及其来源和状态。
2. 需要详细信息或排查加载失败时，使用 getPluginDetails 查看声明、校验结果和运行时诊断。
3. 向用户报告实际查询结果，不要根据插件名称推测其能力。

### 安装

1. 确认用户提供的安装源，说明插件代码和依赖将在本机执行。
2. 用户确认后调用 installPlugin。不要手工复制文件或修改 PluginMgr 注册数据。
3. 安装成功后调用 getPluginDetails，确认插件已经被发现且运行状态符合预期。

### 启用与禁用

1. 先用 listPlugins 或 getPluginDetails 确认插件存在。
2. 调用 setPluginEnabled，并把 enabled 设置为用户要求的状态。
3. 再次查询插件，确认状态已经更新。

### 卸载

1. 先确认插件来源不是 builtin；内置插件与附加插件目录里的插件不能通过 uninstallPlugin 删除。
2. 向用户说明卸载会从 plugins 目录删除该插件（插件的私有数据目录默认保留，重新安装同一插件后仍可继承），并在用户确认后调用 uninstallPlugin。
3. 再次查询，确认该插件已被移除。

### 重新加载

只有插件文件在 PluginMgr 之外发生变化，或用户明确要求重新发现插件时，才调用 reloadPlugins。安装、启停和卸载操作本身已经刷新运行时，不需要额外重载。
`;
