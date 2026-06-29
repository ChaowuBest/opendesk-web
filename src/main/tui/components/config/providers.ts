import { type Component, SelectList, type TUI } from '@mariozechner/pi-tui';
import { defaultSelectListTheme } from '../../theme.js';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';

export interface ProviderTemplate {
    name: string;
    displayName: string;
    base_url: string;
    provider_type?: 'openai' | 'anthropic';
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
    { name: 'openai', displayName: 'OpenAI', base_url: 'https://api.openai.com/v1' },
    { name: 'openrouter', displayName: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1' },
    { name: 'cerebras', displayName: 'Cerebras AI', base_url: 'https://api.cerebras.ai/v1' },
    { name: 'siliconflow', displayName: '硅基流动', base_url: 'https://api.siliconflow.cn/v1' },
    { name: 'deepseek', displayName: '深度求索', base_url: 'https://api.deepseek.com' },
    { name: 'opencode-go', displayName: 'OpenCode Go', base_url: 'https://opencode.ai/zen/go/v1' },
    { name: 'z-ai', displayName: '智谱开放平台', base_url: 'https://open.bigmodel.cn/api/paas/v4' },
    {
        name: 'z-ai-code',
        displayName: '智谱开放平台(CodingPlan)',
        base_url: 'https://open.bigmodel.cn/api/coding/paas/v4'
    },
    {
        name: 'kimi-code',
        displayName: 'Kimi(CodingPlan)',
        base_url: 'https://api.kimi.com/coding/v1'
    },
    { name: 'minimaxi', displayName: 'MiniMax', base_url: 'https://api.minimaxi.com/v1' },
    {
        name: 'aliyun-cn',
        displayName: '阿里云百炼',
        base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    },
    {
        name: 'aliyun-code-cn',
        displayName: '阿里云百炼(CodingPlan)',
        base_url: 'https://coding.dashscope.aliyuncs.com/v1'
    },
    {
        name: 'baidubce',
        displayName: '百度云千帆',
        base_url: 'https://qianfan.baidubce.com/v2'
    },
    {
        name: 'baidubce-code',
        displayName: '百度云千帆(CodingPlan)',
        base_url: 'https://qianfan.baidubce.com/v2/coding'
    },
    {
        name: 'volcengine',
        displayName: '火山引擎',
        base_url: 'https://ark.cn-beijing.volces.com/api/v3'
    },
    {
        name: 'volcengine-code',
        displayName: '火山引擎(CodingPlan)',
        base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3'
    },
    { name: 'local', displayName: 'Ollama', base_url: 'http://127.0.0.1:11434/v1' },
    { name: 'lmstudio', displayName: 'LM Studio', base_url: 'http://127.0.0.1:1234/v1' }
];

interface ProviderData {
    name: string;
    provider_type?: 'openai' | 'anthropic';
    base_url: string;
    api_key: string;
    no_proxy: boolean;
    no_ssl: boolean;
}

const PROVIDER_TYPE_OPTIONS = ['openai', 'anthropic'];
const PROVIDER_TYPE_LABELS: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic'
};

/**
 * 模型服务商配置页面。
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
            { value: '__add__', label: chalk.green(t('config.provider.add')) },
            ...providers.map((p: ProviderData, i: number) => ({
                value: String(i),
                label: `${p.name}  ${chalk.cyan(PROVIDER_TYPE_LABELS[p.provider_type ?? 'openai'])}  ${chalk.dim(p.base_url)}`
            }))
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
            ...PROVIDER_TEMPLATES.map((template) => ({
                value: template.name,
                label: `${template.displayName}  ${chalk.dim(template.base_url)}`
            })),
            { value: '__custom__', label: chalk.dim(t('config.provider.template.custom')) }
        ];

        this.templateList = new SelectList(items, Math.min(items.length, 15), defaultSelectListTheme);
        this.tui.setFocus(this.templateList);

        this.templateList.onSelect = (item) => {
            const template = PROVIDER_TEMPLATES.find((t) => t.name === item.value);
            this.editingIndex = -1;
            this.showEditForm({
                name: template?.name ?? '',
                provider_type: template?.provider_type ?? 'openai',
                base_url: template?.base_url ?? '',
                api_key: '',
                no_proxy: false,
                no_ssl: false
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
            { type: 'text', key: 'name', label: t('config.provider.field.name'), value: provider.name },
            {
                type: 'select',
                key: 'provider_type',
                label: t('config.provider.field.provider_type'),
                value: provider.provider_type ?? 'openai',
                options: PROVIDER_TYPE_OPTIONS,
                optionLabels: PROVIDER_TYPE_LABELS
            },
            { type: 'text', key: 'base_url', label: t('config.provider.field.base_url'), value: provider.base_url },
            { type: 'text', key: 'api_key', label: t('config.provider.field.api_key'), value: provider.api_key },
            { type: 'boolean', key: 'no_proxy', label: t('config.provider.field.no_proxy'), value: provider.no_proxy },
            { type: 'boolean', key: 'no_ssl', label: t('config.provider.field.no_ssl'), value: provider.no_ssl }
        ];

        const actions: ActionDef[] = [{ key: 'save', label: t('config.common.save'), style: 'primary' }];
        if (this.editingIndex >= 0) {
            actions.push({ key: 'delete', label: t('config.common.delete'), style: 'danger' });
        }
        actions.push({ key: 'cancel', label: t('config.common.cancel') });

        const title =
            this.editingIndex >= 0 ? t('config.provider.edit.title.edit') : t('config.provider.edit.title.add');
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
            provider_type: values.provider_type === 'anthropic' ? 'anthropic' : 'openai',
            base_url: values.base_url ?? '',
            api_key: values.api_key ?? '',
            no_proxy: !!values.no_proxy,
            no_ssl: !!values.no_ssl
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

    invalidate() {}

    render(width: number): string[] {
        const lines: string[] = [];

        switch (this.state) {
            case 'list':
                lines.push(chalk.bold('⚙️  ' + t('config.provider.title')));
                lines.push(chalk.dim('─'.repeat(Math.min(width - 2, 50))));
                lines.push('');
                if (this.list) lines.push(...this.list.render(width));
                lines.push('');
                lines.push(chalk.dim('  ' + t('config.main.hint')));
                break;

            case 'template':
                lines.push(chalk.bold('⚙️  ' + t('config.provider.template.title')));
                lines.push(chalk.dim('─'.repeat(Math.min(width - 2, 50))));
                lines.push('');
                if (this.templateList) lines.push(...this.templateList.render(width));
                lines.push('');
                lines.push(chalk.dim('  ' + t('config.main.hint')));
                break;

            case 'edit':
                if (this.form) lines.push(...this.form.render(width));
                break;
        }

        return lines;
    }
}
