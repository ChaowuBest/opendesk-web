import { type Component, SelectList, visibleWidth } from '@mariozechner/pi-tui';
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
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';
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
        create: (openDeskTUI, onBack) => new ModelConfigPage(openDeskTUI.tui, onBack)
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
        icon: '🖥️',
        titleKey: 'config.display.title',
        hintKey: 'config.display.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new DisplayConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'network',
        icon: '🌐',
        titleKey: 'config.network.title',
        hintKey: 'config.network.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new NetworkConfigPage(openDeskTUI.tui, onBack, onConfigChange)
    },
    {
        value: 'debug',
        icon: '🪜',
        titleKey: 'config.debug.title',
        hintKey: 'config.debug.title.hint',
        create: (openDeskTUI, onBack, onConfigChange) => new DebugConfigPage(openDeskTUI.tui, onBack, onConfigChange)
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
 * 动态构建菜单项列表（每次调用时重新翻译，确保语言切换后菜单更新）
 */
function buildSectionItems(): Array<{ value: string; label: string }> {
    const titles = SECTION_DEFS.map((s) => `${s.icon}  ${t(s.titleKey)}`);
    const maxTitleWidth = Math.max(...titles.map((title) => visibleWidth(title)));

    return SECTION_DEFS.map((s, i) => {
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
            const section = SECTION_DEFS.find((s) => s.value === item.value);
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
