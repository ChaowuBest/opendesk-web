import { type Component, SelectList, type TUI } from '@mariozechner/pi-tui';
import { defaultSelectListTheme } from '../../theme.js';
import { ProviderConfigPage } from './providers';
import { ModelConfigPage } from './models';
import { DefaultModelConfigPage } from './defaultModels';
import { FileMgrConfigPage } from './filemgrConfig.js';
import chalk from 'chalk';

interface ConfigSection {
    value: string;
    label: string;
    create: (tui: TUI, onBack: () => void, onConfigChange?: () => void) => Component;
}

const CONFIG_SECTIONS: ConfigSection[] = [
    {
        value: 'providers',
        label: `📡  模型服务商配置       ${chalk.dim('管理 API 模型服务商')}`,
        create: (tui, onBack) => new ProviderConfigPage(tui, onBack)
    },
    {
        value: 'models',
        label: `🤖  模型配置         ${chalk.dim('管理模型别名')}`,
        create: (tui, onBack) => new ModelConfigPage(tui, onBack)
    },
    {
        value: 'default-model',
        label: `🎯  默认模型配置     ${chalk.dim('选择各场景默认模型')}`,
        create: (tui, onBack, onConfigChange) => new DefaultModelConfigPage(tui, onBack, onConfigChange)
    },
    {
        value: 'filemgr',
        label: `📁  文件扫描配置       ${chalk.dim('管理文件扫描目录')}`,
        create: (tui: any, onBack: () => void) => new FileMgrConfigPage(tui, onBack)
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
        lines.push(chalk.bold('⚙️  系统设置'));
        lines.push(chalk.dim('─'.repeat(Math.min(width - 2, 50))));
        lines.push('');
        if (this.list) lines.push(...this.list.render(width));
        lines.push('');
        lines.push(chalk.dim('  Enter 进入  Esc 返回'));
        return lines;
    }
}
