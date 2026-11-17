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
 * 「仓库设置」页签里的测评集仓库面板（benchmark-channel-settings）。
 *
 * 管理测评集仓库：每个启用的仓库在测评应用里占一个 Tab。面板行为（启停只改一行、
 * 增删改只重画列表、添加/编辑时由主进程联网校验清单）与插件仓库面板完全一致，
 * 因此共用 `RegistryChannelSettings`，这里只声明两者的差异。
 */

import { RegistryChannelSettings } from './registryChannelSettings.js';

class BenchmarkChannelSettings extends RegistryChannelSettings {}

BenchmarkChannelSettings.registryChannelConfig = {
    app: 'benchmark',
    i18n: 'sp.benchmarkChannel',
    logTag: 'benchmark-channel-settings',
    styleId: 'od-benchmark-channel-style',
    /** 样式类名前缀：两个仓库面板同时挂在「仓库设置」里，样式全局生效，必须各自带前缀 */
    cssPrefix: 'sp-bm',
    icon: 'fa-tower-broadcast',
    dom: {
        addButton: 'benchmark-channel-add-btn',
        nameInput: 'od-bm-channel-name',
        urlInput: 'od-bm-channel-url'
    },
    api: {
        list: 'listBenchmarkChannels',
        add: 'addBenchmarkChannel',
        update: 'updateBenchmarkChannel',
        remove: 'deleteBenchmarkChannel',
        setEnabled: 'setBenchmarkChannelEnabled'
    }
};

if (!customElements.get('benchmark-channel-settings')) {
    customElements.define('benchmark-channel-settings', BenchmarkChannelSettings);
}
