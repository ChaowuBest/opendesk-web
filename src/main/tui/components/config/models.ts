import { type Component, SelectList, type TUI } from '@mariozechner/pi-tui';
import { defaultSelectListTheme } from '../../theme.js';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import chalk from 'chalk';

interface ModelData {
    alias: string;
    provider_name: string;
    model_name: string;
}

/**
 * 模型配置页面。
 * 内部状态机：list → edit → list
 */
export class ModelConfigPage implements Component {
    private tui: TUI;
    private onClose: () => void;
    private state: 'list' | 'edit' = 'list';

    private list?: SelectList;
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

        const data = Setting.getInstance().getData() as any;
        const models: ModelData[] = data.models ?? [];

        const items = [
            { value: '__add__', label: chalk.green('➕ 添加模型') },
            ...models.map((m: ModelData, i: number) => ({
                value: String(i),
                label: `${m.alias}  ${chalk.dim(`${m.provider_name} / ${m.model_name}`)}`
            }))
        ];

        this.list = new SelectList(items, Math.min(items.length, 15), defaultSelectListTheme);
        this.tui.setFocus(this.list);

        this.list.onSelect = (item) => {
            if (item.value === '__add__') {
                this.editingIndex = -1;
                this.showEditForm({ alias: '', provider_name: '', model_name: '' });
            } else {
                this.editingIndex = parseInt(item.value, 10);
                this.showEditForm(models[this.editingIndex]);
            }
        };
        this.list.onCancel = () => this.onClose();

        this.tui.requestRender();
    }

    private showEditForm(model: ModelData) {
        this.state = 'edit';
        this.list = undefined;

        const data = Setting.getInstance().getData() as any;
        const providerNames: string[] = (data.providers ?? []).map((p: any) => p.name);

        const fields: FieldDef[] = [{ type: 'text', key: 'alias', label: '模型别名', value: model.alias }];

        if (providerNames.length > 0) {
            const currentProvider = providerNames.includes(model.provider_name)
                ? model.provider_name
                : providerNames[0];
            fields.push({
                type: 'select',
                key: 'provider_name',
                label: '模型服务商',
                value: currentProvider,
                options: providerNames
            });
        } else {
            fields.push({
                type: 'text',
                key: 'provider_name',
                label: '模型服务商',
                value: model.provider_name
            });
        }

        fields.push({
            type: 'text',
            key: 'model_name',
            label: '模型名称 (提供商侧)',
            value: model.model_name
        });

        const actions: ActionDef[] = [{ key: 'save', label: '✅ 保存', style: 'primary' }];
        if (this.editingIndex >= 0) {
            actions.push({ key: 'delete', label: '🗑️  删除', style: 'danger' });
        }
        actions.push({ key: 'cancel', label: '↩  返回' });

        const title = this.editingIndex >= 0 ? '编辑模型' : '添加模型';
        this.form = new ConfigForm(
            this.tui,
            title,
            fields,
            actions,
            (actionKey, values) => this.handleAction(actionKey, values),
            () => this.showList()
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private handleAction(actionKey: string, values: Record<string, any>) {
        if (actionKey === 'save') {
            this.saveModel(values);
        } else if (actionKey === 'delete') {
            this.deleteModel();
        } else {
            this.showList();
        }
    }

    private saveModel(values: Record<string, any>) {
        const setting = Setting.getInstance();
        const data = { ...(setting.getData() as any) };
        data.models = [...(data.models ?? [])];

        const model: ModelData = {
            alias: values.alias ?? '',
            provider_name: values.provider_name ?? '',
            model_name: values.model_name ?? ''
        };

        if (this.editingIndex >= 0) {
            data.models[this.editingIndex] = model;
        } else {
            data.models.push(model);
        }

        setting.setData(data);
        this.showList();
    }

    private deleteModel() {
        if (this.editingIndex < 0) return;

        const setting = Setting.getInstance();
        const data = { ...(setting.getData() as any) };
        data.models = [...(data.models ?? [])];
        data.models.splice(this.editingIndex, 1);
        setting.setData(data);
        this.showList();
    }

    invalidate() {}

    render(width: number): string[] {
        const lines: string[] = [];

        switch (this.state) {
            case 'list':
                lines.push(chalk.bold('⚙️  模型配置'));
                lines.push(chalk.dim('─'.repeat(Math.min(width - 2, 50))));
                lines.push('');
                if (this.list) lines.push(...this.list.render(width));
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
