import { type Component, SelectList, type TUI } from '../../pi-tui.js';
import { defaultSelectListTheme } from '../../theme.js';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import chalk from 'chalk';
import { getReasoningEffortLabels, REASONING_EFFORT_SELECT_VALUES } from '../../../../common/reasoning-effort.js';
import { t } from '../../../../locale/index.js';

interface ModelData {
    alias: string;
    provider_name: string;
    model_name: string;
    model_type?: 'chat' | 'embedding' | '';
    reasoning_effort?: string;
    context_length?: number;
    auto_parse_think_tags?: boolean;
    custom_headers?: Record<string, string>;
}

interface HeaderItem {
    key: string;
    value: string;
}

/**
 * 模型配置页面。
 * 内部状态机：list → edit → headers → header-edit → headers → edit → list
 *
 * - list: 模型列表，选择或新增
 * - edit: 模型编辑表单，含 "编辑 Headers" 操作按钮
 * - headers: Headers 列表，可添加/编辑/删除 header
 * - header-edit: 单个 Header 的 key/value 编辑表单
 */
export class ModelConfigPage implements Component {
    private tui: TUI;
    private onClose: () => void;
    private state: 'list' | 'edit' | 'headers' | 'header-edit' = 'list';

    private list?: SelectList;
    private form?: ConfigForm;
    private headersList?: SelectList;
    private headerForm?: ConfigForm;
    private editingIndex = -1;
    private editingHeaderIndex = -1;

    // Headers 编辑状态
    private headers: HeaderItem[] = [];
    // 从编辑模型表单进入 headers 时保存的表单值，用于返回时恢复
    private savedFormValues?: Record<string, any>;

    constructor(tui: TUI, onClose: () => void) {
        this.tui = tui;
        this.onClose = onClose;
        this.showList();
    }

    // ─── list 状态 ────────────────────────────────────────────────

    private showList() {
        this.state = 'list';
        this.form?.deactivate();
        this.form = undefined;
        this.headersList = undefined;
        this.headerForm?.deactivate();
        this.headerForm = undefined;
        this.savedFormValues = undefined;

        const data = Setting.getInstance().getData() as any;
        const models: ModelData[] = data.models ?? [];

        const items = [
            { value: '__add__', label: chalk.green(t('config.model.add')) },
            ...models.map((m: ModelData, i: number) => {
                const effortLabels = getReasoningEffortLabels(t);
                const effortTag = m.reasoning_effort
                    ? chalk.yellow(`[${effortLabels[m.reasoning_effort] ?? m.reasoning_effort}]`)
                    : '';
                const modelType = m.model_type === 'embedding' ? 'embedding' : 'chat';
                const typeTag = chalk.cyan(`[${modelType}]`);
                const headersTag =
                    m.custom_headers && Object.keys(m.custom_headers).length > 0
                        ? chalk.blue(`[${Object.keys(m.custom_headers).length} headers]`)
                        : '';
                return {
                    value: String(i),
                    label: `${m.alias}  ${chalk.dim(`${m.provider_name} / ${m.model_name}`)} ${typeTag} ${effortTag} ${headersTag}`
                };
            })
        ];

        this.list = new SelectList(items, Math.min(items.length, 15), defaultSelectListTheme);
        this.tui.setFocus(this.list);

        this.list.onSelect = (item) => {
            if (item.value === '__add__') {
                this.editingIndex = -1;
                this.headers = [];
                this.showEditForm({ alias: '', provider_name: '', model_name: '', model_type: 'chat' });
            } else {
                this.editingIndex = parseInt(item.value, 10);
                const model = models[this.editingIndex];
                this.headers = model.custom_headers
                    ? Object.entries(model.custom_headers).map(([k, v]) => ({ key: k, value: v }))
                    : [];
                this.showEditForm(model);
            }
        };
        this.list.onCancel = () => this.onClose();

        this.tui.requestRender();
    }

    // ─── edit 状态 ────────────────────────────────────────────────

    private showEditForm(model: ModelData) {
        this.state = 'edit';
        this.list = undefined;
        this.headersList = undefined;
        this.headerForm?.deactivate();
        this.headerForm = undefined;
        this.savedFormValues = undefined;

        const data = Setting.getInstance().getData() as any;
        const providerNames: string[] = (data.providers ?? []).map((p: any) => p.name);

        const fields: FieldDef[] = [
            { type: 'text', key: 'alias', label: t('config.model.field.alias'), value: model.alias }
        ];

        if (providerNames.length > 0) {
            const currentProvider = providerNames.includes(model.provider_name)
                ? model.provider_name
                : providerNames[0];
            fields.push({
                type: 'select',
                key: 'provider_name',
                label: t('config.model.field.provider'),
                value: currentProvider,
                options: providerNames
            });
        } else {
            fields.push({
                type: 'text',
                key: 'provider_name',
                label: t('config.model.field.provider'),
                value: model.provider_name
            });
        }

        fields.push({
            type: 'select',
            key: 'model_type',
            label: t('config.model.field.model_type'),
            value: model.model_type === 'embedding' ? 'embedding' : 'chat',
            options: ['chat', 'embedding'],
            optionLabels: {
                chat: t('config.model.type.chat'),
                embedding: t('config.model.type.embedding')
            }
        });

        fields.push({
            type: 'text',
            key: 'model_name',
            label: t('config.model.field.model_name'),
            value: model.model_name
        });

        fields.push({
            type: 'select',
            key: 'reasoning_effort',
            label: t('config.model.field.reasoning_effort'),
            value: model.reasoning_effort || '',
            options: REASONING_EFFORT_SELECT_VALUES,
            optionLabels: getReasoningEffortLabels(t)
        });

        fields.push({
            type: 'text',
            key: 'context_length',
            label: t('config.model.field.context_length'),
            value: model.context_length ? String(model.context_length) : ''
        });

        fields.push({
            type: 'boolean',
            key: 'auto_parse_think_tags',
            label: t('config.model.field.auto_parse_think_tags'),
            value: model.auto_parse_think_tags ?? false
        });

        // "编辑 Headers" 操作按钮，显示当前 headers 数量
        const headersCount = this.headers.length;
        const headersLabel =
            headersCount > 0
                ? `${t('config.model.field.edit_headers')} (${headersCount})`
                : t('config.model.field.edit_headers');

        const actions: ActionDef[] = [
            { key: 'headers', label: headersLabel, style: 'default' },
            { key: 'save', label: t('config.common.save'), style: 'primary' }
        ];
        if (this.editingIndex >= 0) {
            actions.push({ key: 'delete', label: t('config.common.delete'), style: 'danger' });
        }
        actions.push({ key: 'cancel', label: t('config.common.cancel') });

        const title = this.editingIndex >= 0 ? t('config.model.edit.title.edit') : t('config.model.edit.title.add');
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
        if (actionKey === 'headers') {
            // 保存当前表单值，稍后从 headers 返回时恢复
            this.savedFormValues = values;
            this.showHeadersList();
        } else if (actionKey === 'save') {
            this.saveModel(values);
        } else if (actionKey === 'delete') {
            this.deleteModel();
        } else {
            this.showList();
        }
    }

    // ─── headers 状态 ─────────────────────────────────────────────

    private showHeadersList() {
        this.state = 'headers';
        this.form?.deactivate();
        this.form = undefined;
        this.headerForm?.deactivate();
        this.headerForm = undefined;

        const items = [
            { value: '__add__', label: chalk.green(`${t('config.model.header.add')}`) },
            ...this.headers.map((h, i) => ({
                value: String(i),
                label: `${chalk.cyan(h.key || t('config.model.header.empty'))}: ${chalk.dim(h.value || t('config.model.header.empty'))}`
            }))
        ];

        this.headersList = new SelectList(items, Math.min(items.length, 10), defaultSelectListTheme);
        this.tui.setFocus(this.headersList);

        this.headersList.onSelect = (item) => {
            if (item.value === '__add__') {
                this.editingHeaderIndex = -1;
                this.showHeaderForm('', '');
            } else {
                const idx = parseInt(item.value, 10);
                this.editingHeaderIndex = idx;
                this.showHeaderForm(this.headers[idx].key, this.headers[idx].value);
            }
        };
        this.headersList.onCancel = () => {
            this.restoreEditForm();
        };

        this.tui.requestRender();
    }

    /** 从 headers 状态返回 edit 状态，恢复之前保存的表单值 */
    private restoreEditForm() {
        const values = this.savedFormValues || {};
        const model: ModelData = {
            alias: values.alias ?? '',
            provider_name: values.provider_name ?? '',
            model_name: values.model_name ?? '',
            model_type: values.model_type === 'embedding' ? 'embedding' : 'chat',
            reasoning_effort: values.reasoning_effort ?? '',
            context_length: values.context_length ? parseInt(values.context_length, 10) : undefined,
            auto_parse_think_tags: values.auto_parse_think_tags ?? false
        };
        this.savedFormValues = undefined;
        this.showEditForm(model);
    }

    // ─── header-edit 状态 ──────────────────────────────────────────

    private showHeaderForm(initialKey: string, initialValue: string) {
        this.state = 'header-edit';
        this.headersList = undefined;

        const isEdit = this.editingHeaderIndex >= 0;
        const title = isEdit ? t('config.model.header.edit') : t('config.model.header.add_title');
        const fields: FieldDef[] = [
            { type: 'text', key: 'header_key', label: t('config.model.header.key'), value: initialKey },
            { type: 'text', key: 'header_value', label: t('config.model.header.value'), value: initialValue }
        ];

        const actions: ActionDef[] = [{ key: 'save', label: t('config.common.save'), style: 'primary' }];
        if (isEdit) {
            actions.push({ key: 'delete', label: t('config.common.delete'), style: 'danger' });
        }
        actions.push({ key: 'cancel', label: t('config.common.cancel') });

        this.headerForm = new ConfigForm(
            this.tui,
            title,
            fields,
            actions,
            (actionKey, values) => this.handleHeaderAction(actionKey, values),
            () => this.showHeadersList()
        );
        this.headerForm.activate();
        this.tui.requestRender();
    }

    private handleHeaderAction(actionKey: string, values: Record<string, any>) {
        if (actionKey === 'save') {
            const key = values.header_key?.trim() || '';
            const value = values.header_value?.trim() || '';
            if (!key) {
                this.showHeadersList();
                return;
            }
            if (this.editingHeaderIndex >= 0) {
                this.headers[this.editingHeaderIndex] = { key, value };
            } else {
                this.headers.push({ key, value });
            }
            this.showHeadersList();
        } else if (actionKey === 'delete') {
            if (this.editingHeaderIndex >= 0) {
                this.headers.splice(this.editingHeaderIndex, 1);
            }
            this.showHeadersList();
        } else {
            this.showHeadersList();
        }
    }

    // ─── 保存 / 删除 ──────────────────────────────────────────────

    private saveModel(values: Record<string, any>) {
        const setting = Setting.getInstance();
        const data = { ...(setting.getData() as any) };
        data.models = [...(data.models ?? [])];

        const parsedContextLength = parseInt(values.context_length, 10);

        // 从 headers 数组构建 custom_headers 对象
        const custom_headers: Record<string, string> = {};
        for (const h of this.headers) {
            if (h.key.trim() && h.value.trim()) {
                custom_headers[h.key.trim()] = h.value.trim();
            }
        }

        const model: ModelData = {
            alias: values.alias ?? '',
            provider_name: values.provider_name ?? '',
            model_name: values.model_name ?? '',
            model_type: values.model_type === 'embedding' ? 'embedding' : 'chat',
            reasoning_effort: values.model_type === 'embedding' ? '' : (values.reasoning_effort ?? ''),
            context_length:
                values.model_type !== 'embedding' && Number.isFinite(parsedContextLength) && parsedContextLength > 0
                    ? parsedContextLength
                    : undefined,
            auto_parse_think_tags: values.auto_parse_think_tags ?? false,
            custom_headers: Object.keys(custom_headers).length > 0 ? custom_headers : undefined
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

    // ─── 渲染 ─────────────────────────────────────────────────────

    invalidate() {}

    render(width: number): string[] {
        const lines: string[] = [];
        const dividerWidth = Math.min(width - 2, 50);

        switch (this.state) {
            case 'list':
                lines.push(chalk.bold('⚙️  ' + t('config.model.title')));
                lines.push(chalk.dim('─'.repeat(dividerWidth)));
                lines.push('');
                if (this.list) lines.push(...this.list.render(width));
                lines.push('');
                lines.push(chalk.dim('  ' + t('config.main.hint')));
                break;

            case 'edit':
                if (this.form) lines.push(...this.form.render(width));
                break;

            case 'headers':
                lines.push(chalk.bold('📋  ' + t('config.model.field.edit_headers')));
                lines.push(chalk.dim('─'.repeat(dividerWidth)));
                lines.push('');
                if (this.headersList) lines.push(...this.headersList.render(width));
                lines.push('');
                lines.push(chalk.dim('  ' + t('config.main.hint')));
                break;

            case 'header-edit':
                if (this.headerForm) lines.push(...this.headerForm.render(width));
                break;
        }

        return lines;
    }
}
