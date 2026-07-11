import { type Component, SelectList, TUI } from '@earendil-works/pi-tui';
import { defaultSelectListTheme } from '../../theme.js';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';

interface EnvEntry {
    key: string;
    value: string;
}

function getEnviron(): Record<string, string> {
    const data = Setting.getInstance().getData();
    return (data as any).environ || {};
}

function saveEnviron(environ: Record<string, string>) {
    const setting = Setting.getInstance();
    const data = setting.getData();
    (data as any).environ = environ;
    setting.setData(data);
}

/**
 * TUI 环境变量设置页面。
 * 状态机：main → edit → main
 *
 * - main: 环境变量列表（SelectList），可添加/选择/返回
 * - edit: 单个变量的 key/value 编辑表单
 */
export class EnvironConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private onConfigChange?: () => void;
    private state: 'main' | 'edit' = 'main';

    private list?: SelectList;
    private form?: ConfigForm;
    private entries: EnvEntry[] = [];
    private editingIndex = -1;

    constructor(tui: TUI, onBack: () => void, onConfigChange?: () => void) {
        this.tui = tui;
        this.onBack = onBack;
        this.onConfigChange = onConfigChange;
        this.loadEntries();
        this.showMain();
    }

    private loadEntries() {
        const environ = getEnviron();
        this.entries = Object.entries(environ).map(([k, v]) => ({ key: k, value: v }));
    }

    private persistAndNotify() {
        const environ: Record<string, string> = {};
        for (const e of this.entries) {
            if (e.key.trim()) {
                environ[e.key.trim()] = e.value;
            }
        }
        saveEnviron(environ);
        this.onConfigChange?.();
    }

    // ─── main 状态 ──────────────────────────────────────────────

    private showMain() {
        this.state = 'main';
        this.form?.deactivate();
        this.form = undefined;

        const items = [
            { value: '__add__', label: chalk.green(`+ ${t('config.environ.add')}`) },
            ...this.entries.map((e, i) => ({
                value: String(i),
                label: `${chalk.cyan(e.key)} ${chalk.dim('=')} ${chalk.white(e.value || chalk.dim.italic('(空)'))}`
            }))
        ];

        this.list = new SelectList(items, Math.min(items.length, 12), defaultSelectListTheme);
        this.tui.setFocus(this.list);

        this.list.onSelect = (item) => {
            if (item.value === '__add__') {
                this.editingIndex = -1;
                this.showEditForm('', '');
            } else {
                const idx = parseInt(item.value, 10);
                this.editingIndex = idx;
                this.showEditForm(this.entries[idx].key, this.entries[idx].value);
            }
        };
        this.list.onCancel = () => {
            this.persistAndNotify();
            this.list = undefined;
            this.onBack();
        };

        this.tui.requestRender();
    }

    // ─── edit 状态 ──────────────────────────────────────────────

    private showEditForm(initialKey: string, initialValue: string) {
        this.state = 'edit';
        this.list = undefined;

        const isEdit = this.editingIndex >= 0;
        const title = isEdit ? t('config.environ.edit') : t('config.environ.add_title');

        const fields: FieldDef[] = [
            { type: 'text', key: 'env_key', label: t('config.environ.key'), value: initialKey },
            { type: 'text', key: 'env_value', label: t('config.environ.value'), value: initialValue }
        ];

        const actions: ActionDef[] = [{ key: 'save', label: t('config.common.save'), style: 'primary' }];
        if (isEdit) {
            actions.push({ key: 'delete', label: t('config.common.delete'), style: 'danger' });
        }
        actions.push({ key: 'cancel', label: t('config.common.cancel') });

        this.form = new ConfigForm(
            this.tui,
            title,
            fields,
            actions,
            (actionKey, values) => this.handleEditAction(actionKey, values),
            () => this.showMain()
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private handleEditAction(actionKey: string, values: Record<string, any>) {
        if (actionKey === 'save') {
            const key = (values.env_key as string)?.trim() || '';
            const value = (values.env_value as string) ?? '';
            if (!key) {
                this.showMain();
                return;
            }
            if (this.editingIndex >= 0) {
                this.entries[this.editingIndex] = { key, value };
            } else {
                this.entries.push({ key, value });
            }
            this.persistAndNotify();
            this.showMain();
        } else if (actionKey === 'delete') {
            if (this.editingIndex >= 0) {
                this.entries.splice(this.editingIndex, 1);
                this.persistAndNotify();
            }
            this.showMain();
        } else {
            this.showMain();
        }
    }

    // ─── 渲染 ───────────────────────────────────────────────────

    invalidate() {}

    render(width: number): string[] {
        const lines: string[] = [];
        const dividerWidth = Math.min(width - 2, 50);

        switch (this.state) {
            case 'main':
                lines.push(chalk.bold('🌐  ' + t('config.environ.title')));
                lines.push(chalk.dim('─'.repeat(dividerWidth)));
                lines.push('');
                if (this.list) lines.push(...this.list.render(width));
                lines.push('');
                lines.push(chalk.dim(`  ${t('config.main.hint')}  ${t('config.environ.hint')}`));
                break;

            case 'edit':
                if (this.form) lines.push(...this.form.render(width));
                break;
        }

        return lines;
    }
}
