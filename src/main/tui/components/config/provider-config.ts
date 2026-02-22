import { type Component, SelectList, type TUI } from "@mariozechner/pi-tui";
import { defaultSelectListTheme } from "../../theme";
import { Setting } from "../../../utils/setting.js";
import { ConfigForm, type FieldDef, type ActionDef } from "./config-form";
import { PROVIDER_TEMPLATES } from "./templates";
import chalk from "chalk";

interface ProviderData {
    name: string;
    base_url: string;
    api_key: string;
    no_proxy: boolean;
}

/**
 * 供应商配置页面。
 * 内部状态机：list → template → edit → list
 */
export class ProviderConfigPage implements Component {
    private tui: TUI;
    private onClose: () => void;
    private state: 'list' | 'template' | 'edit' = 'list';

    private list?: SelectList;
    private templateList?: SelectList;
    private form?: ConfigForm;
    private editingIndex = -1;

    constructor(tui: TUI, onClose: () => void) {
        this.tui = tui;
        this.onClose = onClose;
        this.showList();
    }

    private showList() {
        this.state = 'list';
        this.form?.deactivate();
        this.form = undefined;
        this.templateList = undefined;

        const data = Setting.getInstance().getData() as any;
        const providers: ProviderData[] = data.providers ?? [];

        const items = [
            { value: '__add__', label: chalk.green('➕ 添加供应商') },
            ...providers.map((p: ProviderData, i: number) => ({
                value: String(i),
                label: `${p.name}  ${chalk.dim(p.base_url)}`,
            })),
        ];

        this.list = new SelectList(items, Math.min(items.length, 15), defaultSelectListTheme);
        this.tui.setFocus(this.list);

        this.list.onSelect = (item) => {
            if (item.value === '__add__') {
                this.showTemplateList();
            } else {
                this.editingIndex = parseInt(item.value, 10);
                this.showEditForm(providers[this.editingIndex]);
            }
        };
        this.list.onCancel = () => this.onClose();

        this.tui.requestRender();
    }

    private showTemplateList() {
        this.state = 'template';
        this.list = undefined;

        const items = [
            ...PROVIDER_TEMPLATES.map(t => ({
                value: t.name,
                label: `${t.displayName}  ${chalk.dim(t.base_url)}`,
            })),
            { value: '__custom__', label: chalk.dim('✏️  自定义…') },
        ];

        this.templateList = new SelectList(items, Math.min(items.length, 15), defaultSelectListTheme);
        this.tui.setFocus(this.templateList);

        this.templateList.onSelect = (item) => {
            const template = PROVIDER_TEMPLATES.find(t => t.name === item.value);
            this.editingIndex = -1;
            this.showEditForm({
                name: template?.name ?? '',
                base_url: template?.base_url ?? '',
                api_key: '',
                no_proxy: false,
            });
        };
        this.templateList.onCancel = () => this.showList();

        this.tui.requestRender();
    }

    private showEditForm(provider: ProviderData) {
        this.state = 'edit';
        this.list = undefined;
        this.templateList = undefined;

        const fields: FieldDef[] = [
            { type: 'text', key: 'name', label: '名称', value: provider.name },
            { type: 'text', key: 'base_url', label: 'API 地址', value: provider.base_url },
            { type: 'text', key: 'api_key', label: 'API 密钥', value: provider.api_key },
            { type: 'boolean', key: 'no_proxy', label: '禁用代理', value: provider.no_proxy },
        ];

        const actions: ActionDef[] = [
            { key: 'save', label: '✅ 保存', style: 'primary' },
        ];
        if (this.editingIndex >= 0) {
            actions.push({ key: 'delete', label: '🗑️  删除', style: 'danger' });
        }
        actions.push({ key: 'cancel', label: '↩  返回' });

        const title = this.editingIndex >= 0 ? '编辑供应商' : '添加供应商';
        this.form = new ConfigForm(
            this.tui, title, fields, actions,
            (actionKey, values) => this.handleAction(actionKey, values),
            () => this.showList(),
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private handleAction(actionKey: string, values: Record<string, any>) {
        if (actionKey === 'save') {
            this.saveProvider(values);
        } else if (actionKey === 'delete') {
            this.deleteProvider();
        } else {
            this.showList();
        }
    }

    private saveProvider(values: Record<string, any>) {
        const setting = Setting.getInstance();
        const data = { ...(setting.getData() as any) };
        data.providers = [...(data.providers ?? [])];

        const provider: ProviderData = {
            name: values.name ?? '',
            base_url: values.base_url ?? '',
            api_key: values.api_key ?? '',
            no_proxy: !!values.no_proxy,
        };

        if (this.editingIndex >= 0) {
            data.providers[this.editingIndex] = provider;
        } else {
            data.providers.push(provider);
        }

        setting.setData(data);
        this.showList();
    }

    private deleteProvider() {
        if (this.editingIndex < 0) return;

        const setting = Setting.getInstance();
        const data = { ...(setting.getData() as any) };
        data.providers = [...(data.providers ?? [])];
        data.providers.splice(this.editingIndex, 1);
        setting.setData(data);
        this.showList();
    }

    invalidate() { }

    render(width: number): string[] {
        const lines: string[] = [];

        switch (this.state) {
            case 'list':
                lines.push(chalk.bold('⚙️  供应商配置'));
                lines.push(chalk.dim('─'.repeat(Math.min(width - 2, 50))));
                lines.push('');
                if (this.list) lines.push(...this.list.render(width));
                lines.push('');
                lines.push(chalk.dim('  Enter 选择  Esc 返回'));
                break;

            case 'template':
                lines.push(chalk.bold('⚙️  选择供应商模板'));
                lines.push(chalk.dim('─'.repeat(Math.min(width - 2, 50))));
                lines.push('');
                if (this.templateList) lines.push(...this.templateList.render(width));
                lines.push('');
                lines.push(chalk.dim('  Enter 选择  Esc 返回'));
                break;

            case 'edit':
                if (this.form) lines.push(...this.form.render(width));
                break;
        }

        return lines;
    }
}
