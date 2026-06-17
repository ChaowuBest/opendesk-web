import { type Component, type TUI } from '@mariozechner/pi-tui';
import { Setting } from '../../../utils/setting';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';

const DEFAULT_MODEL_FIELDS = [
    { key: 'default_model', labelKey: 'config.defaultmodel.field.default_model', modelType: 'chat' },
    { key: 'default_embedding_model', labelKey: 'config.defaultmodel.field.embedding_model', modelType: 'embedding' },
    { key: 'default_reranker_model', labelKey: 'config.defaultmodel.field.reranker_model', modelType: 'chat' }
] as const;

function modelTypeOf(model: any): 'chat' | 'embedding' {
    return model?.model_type === 'embedding' ? 'embedding' : 'chat';
}

/**
 * 默认模型选择页面。
 * 用 select 字段在已配置的模型别名中切换各场景的默认模型。
 */
export class DefaultModelConfigPage implements Component {
    private tui: TUI;
    private onClose: () => void;
    private onConfigChange?: () => void;
    private form?: ConfigForm;

    constructor(tui: TUI, onClose: () => void, onConfigChange?: () => void) {
        this.tui = tui;
        this.onClose = onClose;
        this.onConfigChange = onConfigChange;
        this.showForm();
    }

    private showForm() {
        const data = Setting.getInstance().getData() as any;
        const models: any[] = data.models ?? [];

        const fields: FieldDef[] = DEFAULT_MODEL_FIELDS.map((f) => {
            const current: string = data[f.key] ?? '';
            const aliases: string[] = models
                .filter((m: any) => modelTypeOf(m) === f.modelType)
                .map((m: any) => m.alias);
            const optionsWithEmpty = ['', ...aliases];
            if (optionsWithEmpty.length > 1) {
                return {
                    type: 'select' as const,
                    key: f.key,
                    label: t(f.labelKey),
                    value: optionsWithEmpty.includes(current) ? current : '',
                    options: optionsWithEmpty
                };
            }
            return { type: 'text' as const, key: f.key, label: t(f.labelKey), value: current };
        });

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        this.form = new ConfigForm(
            this.tui,
            t('config.defaultmodel.title'),
            fields,
            actions,
            (actionKey, values) => {
                if (actionKey === 'save') this.save(values);
                else this.close();
            },
            () => this.close()
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private close() {
        this.form?.deactivate();
        this.form = undefined;
        this.onClose();
    }

    private save(values: Record<string, any>) {
        const setting = Setting.getInstance();
        const data = { ...(setting.getData() as any) };

        for (const f of DEFAULT_MODEL_FIELDS) {
            data[f.key] = values[f.key] ?? '';
        }

        setting.setData(data);
        this.close();
        if (this.onConfigChange) {
            this.onConfigChange();
        }
    }

    invalidate() {}

    render(width: number): string[] {
        if (!this.form) return [];

        const lines: string[] = [];
        if ((Setting.getInstance().getData() as any).models?.length === 0) {
            lines.push(chalk.yellow('  ⚠ ' + t('config.model.warning.no.models')));
            lines.push('');
        }
        lines.push(...this.form.render(width));
        return lines;
    }
}
