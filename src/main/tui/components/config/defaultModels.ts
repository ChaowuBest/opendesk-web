import { type Component, type TUI } from "@mariozechner/pi-tui";
import { Setting } from "../../../utils/setting";
import { ConfigForm, type FieldDef, type ActionDef } from "./form";
import chalk from "chalk";


const DEFAULT_MODEL_FIELDS = [
    { key: 'default_model', label: '默认对话模型' },
    // { key: 'default_intent_parsing_model', label: '意图解析模型' },
    { key: 'default_embedding_model', label: '向量嵌入模型' },
    { key: 'default_reranker_model', label: '重排序模型' },
    // { key: 'default_vision_model', label: '视觉模型' },
] as const;

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
        const aliases: string[] = (data.models ?? []).map((m: any) => m.alias);
        const optionsWithEmpty = ['', ...aliases];

        const fields: FieldDef[] = DEFAULT_MODEL_FIELDS.map(f => {
            const current: string = data[f.key] ?? '';
            if (optionsWithEmpty.length > 1) {
                return {
                    type: 'select' as const,
                    key: f.key,
                    label: f.label,
                    value: optionsWithEmpty.includes(current) ? current : '',
                    options: optionsWithEmpty,
                };
            }
            return { type: 'text' as const, key: f.key, label: f.label, value: current };
        });

        const actions: ActionDef[] = [
            { key: 'save', label: '✅ 保存', style: 'primary' },
            { key: 'cancel', label: '↩  返回' },
        ];

        this.form = new ConfigForm(
            this.tui, '默认模型配置', fields, actions,
            (actionKey, values) => {
                if (actionKey === 'save') this.save(values);
                else this.close();
            },
            () => this.close(),
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
        if (this.onConfigChange) {
            this.onConfigChange();
        }
        this.close();
    }

    invalidate() { }

    render(width: number): string[] {
        if (!this.form) return [];

        const lines: string[] = [];
        if ((Setting.getInstance().getData() as any).models?.length === 0) {
            lines.push(chalk.yellow('  ⚠ 尚未配置任何模型，请先通过 /config models 添加模型'));
            lines.push('');
        }
        lines.push(...this.form.render(width));
        return lines;
    }
}
