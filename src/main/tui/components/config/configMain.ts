import { type Component, SelectList, type TUI } from '@mariozechner/pi-tui';
import { defaultSelectListTheme } from '../../theme.js';
import { ProviderConfigPage } from './providers';
import { ModelConfigPage } from './models';
import { DefaultModelConfigPage } from './defaultModels';
import { FileMgrConfigPage } from './filemgrConfig.js';
import { LanguageConfigPage } from './languageConfig.js';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';

interface ConfigSection {
    value: string;
    label: string;
    create: (tui: TUI, onBack: () => void, onConfigChange?: () => void) => Component;
}

const CONFIG_SECTIONS: ConfigSection[] = [
    {
        value: 'providers',
        label: `💳  ${t('config.provider.title')}       ${chalk.dim(t('config.provider.title.hint'))}`,
        create: (tui, onBack) => new ProviderConfigPage(tui, onBack)
    },
    {
        value: 'models',
        label: `💰  ${t('config.model.title')}         ${chalk.dim(t('config.model.title.hint'))}`,
        create: (tui, onBack) => new ModelConfigPage(tui, onBack)
    },
    {
        value: 'default-model',
        label: `🏆  ${t('config.defaultmodel.title')}     ${chalk.dim(t('config.defaultmodel.title.hint'))}`,
        create: (tui, onBack, onConfigChange) => new DefaultModelConfigPage(tui, onBack, onConfigChange)
    },
    {
        value: 'filemgr',
        label: `📦  ${t('config.filemgr.title')}       ${chalk.dim(t('config.filemgr.title.hint'))}`,
        create: (tui: any, onBack: () => void) => new FileMgrConfigPage(tui, onBack)
    },
    {
        value: 'language',
        label: `🌎  ${t('config.language.title')}       ${chalk.dim(t('config.language.title.hint'))}`,
        create: (tui: any, onBack: () => void) => new LanguageConfigPage(tui, onBack)
    }
];

/**
 * 系统设置主页面。
 * 一级菜单列出所有配置分区，选择后进入对应子页面，Esc 返回上级。
 */
export class ConfigMainPage implements Component {
    private tui: TUI;
    private onClose: () => void;
    private onConfigChange?: () => void;
    private state: 'main' | 'sub' = 'main';

    private list?: SelectList;
    private subPage?: Component;

    constructor(tui: TUI, onClose: () => void, onConfigChange?: () => void) {
        this.tui = tui;
        this.onClose = onClose;
        this.onConfigChange = onConfigChange;
        this.showMain();
    }

    private showMain() {
        this.state = 'main';
        this.subPage = undefined;

        const items = CONFIG_SECTIONS.map((s) => ({ value: s.value, label: s.label }));
        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.tui.setFocus(this.list);

        this.list.onSelect = (item) => {
            const section = CONFIG_SECTIONS.find((s) => s.value === item.value);
            if (section) this.enterSection(section);
        };
        this.list.onCancel = () => this.onClose();

        this.tui.requestRender();
    }

    private enterSection(section: ConfigSection) {
        this.state = 'sub';
        this.list = undefined;
        this.subPage = section.create(this.tui, () => this.showMain(), this.onConfigChange);
        this.tui.requestRender();
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
