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

import { type Component, SelectList, visibleWidth } from '@earendil-works/pi-tui';
import { defaultSelectListTheme } from '../../theme.js';
import { ProviderConfigPage } from './providers';
import { ModelConfigPage } from './models';
import { DefaultModelConfigPage } from './defaultModels';
import { TaskConfigPage } from './taskConfig.js';
import { DisplayConfigPage } from './displayConfig.js';
import { NetworkConfigPage } from './networkConfig.js';
import { FileMgrConfigPage } from './filemgrConfig.js';
import { LanguageConfigPage } from './languageConfig.js';
import { ShortcutsConfigPage } from './shortcutsConfig.js';
import { SearchConfigPage } from './searchConfig.js';
import { EnvironConfigPage } from './environConfig.js';
import { GatewayConfigPage } from './gatewayConfig.js';
import { DebugConfigPage } from './debugConfig.js';
import { TelemetryConfigPage } from './telemetryConfig.js';
import { PluginConfigPage } from './pluginConfig.js';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';
import { getFeatureManager } from '../../../../common/features/manager.js';
import { OpenDeskTUI } from '../../entry.js';

interface ConfigSectionDef {
    value: string;
    icon: string;
    titleKey: string;
    hintKey: string;
    create: (openDeskTUI: OpenDeskTUI, onBack: () => void, onConfigChange?: () => void) => Component;
}

const SECTION_DEFS: ConfigSectionDef[] = [
    {
        value: 'providers',
        icon: '💳',
        titleKey: 'config.provider.title',
        hintKey: 'config.provider.title.hint',
        create: (openDeskTUI, onBack) => new ProviderConfigPage(openDeskTUI.tui, onBack)
    },
    {
        value: 'models',
        icon: '💰',
        titleKey: 'config.model.title',
        hintKey: 'config.model.title.hint',
        create: (openDeskTUI, onBack) => new ModelConfigPage(openDeskTUI, onBack)
    },
    {
        value: 'default-model',
        icon: '🏆',
        titleKey: 'config.defaultmodel.title',
        hintKey: 'config.defaultmodel.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) =>
            new DefaultModelConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'task',
        icon: '📋',
        titleKey: 'config.task.title',
        hintKey: 'config.task.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new TaskConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'display',
        icon: '📺',
        titleKey: 'config.display.title',
        hintKey: 'config.display.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new DisplayConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'network',
        icon: '📟',
        titleKey: 'config.network.title',
        hintKey: 'config.network.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new NetworkConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'debug',
        icon: '📊',
        titleKey: 'config.debug.title',
        hintKey: 'config.debug.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new DebugConfigPage(openDeskTUI, onBack, onConfigChange)
    },
    {
        value: 'telemetry',
        icon: '📈',
        titleKey: 'config.telemetry.title',
        hintKey: 'config.telemetry.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) =>
            new TelemetryConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'plugins',
        icon: '🔌',
        titleKey: 'config.plugin.title',
        hintKey: 'config.plugin.title.hint',
        create: (openDeskTUI, onBack) => new PluginConfigPage(openDeskTUI, onBack)
    },
    {
        value: 'search',
        icon: '🔍',
        titleKey: 'config.search.title',
        hintKey: 'config.search.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new SearchConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'environ',
        icon: '📚',
        titleKey: 'config.environ.title',
        hintKey: 'config.environ.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new EnvironConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'gateway',
        icon: '💻',
        titleKey: 'config.gateway.title',
        hintKey: 'config.gateway.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new GatewayConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'filemgr',
        icon: '📦',
        titleKey: 'config.filemgr.title',
        hintKey: 'config.filemgr.title.hint',
        create: (openDeskTUI, onBack) => new FileMgrConfigPage(openDeskTUI.tui, onBack)
    },
    {
        value: 'language',
        icon: '🌎',
        titleKey: 'config.language.title',
        hintKey: 'config.language.title.hint',
        create: (openDeskTUI, onBack) => new LanguageConfigPage(openDeskTUI.tui, onBack)
    },
    {
        value: 'shortcuts',
        icon: '🚲️',
        titleKey: 'config.shortcuts.title',
        hintKey: 'config.shortcuts.title.hint',
        create: (openDeskTUI, onBack) => new ShortcutsConfigPage(openDeskTUI, onBack)
    }
];

/**
 * 当前可见的配置分区。
 * telemetry 特性被插件禁用（ctx.features.disableFeature('telemetry')）时隐藏遥测配置入口：
 * 用户无法再主动修改端点，配置本身保留在设置文件里，插件停用后入口原样恢复。
 */
export function getVisibleSectionDefs(): ConfigSectionDef[] {
    const telemetryDisabled = getFeatureManager().isFeatureDisabled('telemetry');
    return telemetryDisabled ? SECTION_DEFS.filter((section) => section.value !== 'telemetry') : SECTION_DEFS;
}

/**
 * 动态构建菜单项列表（每次调用时重新翻译，确保语言切换后菜单更新）
 */
function buildSectionItems(): Array<{ value: string; label: string }> {
    const sections = getVisibleSectionDefs();
    const titles = sections.map((s) => `${s.icon}  ${t(s.titleKey)}`);
    const maxTitleWidth = Math.max(...titles.map((title) => visibleWidth(title)));

    return sections.map((s, i) => {
        const title = titles[i];
        const pad = ' '.repeat(Math.max(2, maxTitleWidth - visibleWidth(title) + 4));
        return {
            value: s.value,
            label: `${title}${pad}${chalk.dim(t(s.hintKey))}`
        };
    });
}

/**
 * 系统设置主页面。
 * 一级菜单列出所有配置分区，选择后进入对应子页面，Esc 返回上级。
 */
export class ConfigMainPage implements Component {
    private openDeskTUI: OpenDeskTUI;
    private onClose: () => void;
    private onConfigChange?: () => void;
    private state: 'main' | 'sub' = 'main';

    private list?: SelectList;
    private subPage?: Component;

    constructor(openDeskTUI: OpenDeskTUI, onClose: () => void, onConfigChange?: () => void) {
        this.openDeskTUI = openDeskTUI;
        this.onClose = onClose;
        this.onConfigChange = onConfigChange;
        this.showMain();
    }

    private showMain() {
        this.state = 'main';
        this.subPage = undefined;

        const items = buildSectionItems();
        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.openDeskTUI.tui.setFocus(this.list);

        this.list.onSelect = (item) => {
            const section = getVisibleSectionDefs().find((s) => s.value === item.value);
            if (section) this.enterSection(section);
        };
        this.list.onCancel = () => this.onClose();

        this.openDeskTUI.tui.requestRender();
    }

    private enterSection(section: ConfigSectionDef) {
        this.state = 'sub';
        this.list = undefined;
        this.subPage = section.create(this.openDeskTUI, () => this.showMain(), this.onConfigChange);
        this.openDeskTUI.tui.requestRender();
    }

    invalidate() {}

    render(width: number): string[] {
        if (this.state === 'sub' && this.subPage) {
            return this.subPage.render(width);
        }

        const lines: string[] = [];
        lines.push(chalk.bold('⚙️  ' + t('config.main.title')));
        lines.push(chalk.dim('─'.repeat(Math.min(width - 2, 50))));
        lines.push('');
        if (this.list) lines.push(...this.list.render(width));
        lines.push('');
        lines.push(chalk.dim('  ' + t('config.main.hint')));
        return lines;
    }
}
