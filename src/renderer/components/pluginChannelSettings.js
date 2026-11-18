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

/**
 * 「仓库设置」页签里的插件仓库面板（plugin-channel-settings）。
 *
 * 管理插件市场仓库：每个启用的仓库在「插件中心 → 插件市场」里是一个独立的插件市场。
 * 面板行为（启停只改一行、增删改只重画列表、添加/编辑时由主进程联网校验清单）与测评集
 * 仓库面板完全一致，因此共用 `RegistryChannelSettings`，这里只声明两者的差异。
 */

import { RegistryChannelSettings } from './registryChannelSettings.js';

class PluginChannelSettings extends RegistryChannelSettings {}

PluginChannelSettings.registryChannelConfig = {
    app: 'pluginmgr',
    i18n: 'sp.pluginChannel',
    logTag: 'plugin-channel-settings',
    styleId: 'od-plugin-channel-style',
    /** 样式类名前缀：两个仓库面板同时挂在「仓库设置」里，样式全局生效，必须各自带前缀 */
    cssPrefix: 'sp-pc',
    icon: 'fa-store',
    dom: {
        addButton: 'plugin-channel-add-btn',
        nameInput: 'od-pc-channel-name',
        urlInput: 'od-pc-channel-url'
    },
    api: {
        list: 'listPluginChannels',
        add: 'addPluginChannel',
        update: 'updatePluginChannel',
        remove: 'deletePluginChannel',
        setEnabled: 'setPluginChannelEnabled'
    }
};

if (!customElements.get('plugin-channel-settings')) {
    customElements.define('plugin-channel-settings', PluginChannelSettings);
}
