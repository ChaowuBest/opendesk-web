import { type Component, type TUI } from '@mariozechner/pi-tui';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';

const WEB_CHANNELS = [
    { id: 'duckduckgo', name: 'DuckDuckGo', needsApiKey: false },
    { id: 'bing', name: 'Bing', needsApiKey: false },
    { id: 'tavily', name: 'Tavily', needsApiKey: true },
    { id: 'brave', name: 'Brave', needsApiKey: true },
    { id: 'bocha', name: '博查', needsApiKey: true },
    { id: 'exa', name: 'Exa', needsApiKey: true }
];

const ACADEMIC_CHANNELS = [{ id: 'arxiv', name: 'arXiv' }];

function getSearchConfig(): any {
    const data = Setting.getInstance().getData();
    const apps: any = data.applications || {};
    return apps.search || {};
}

function saveSearchConfig(config: any) {
    const setting = Setting.getInstance();
    const data = setting.getData();
    const apps: any = data.applications || {};
    apps.search = config;
    data.applications = apps;
    setting.setData(data);
}

/**
 * TUI 搜索设置页面
 */
export class SearchConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private onConfigChange?: () => void;
    private state: 'main' | 'channel' = 'main';
    private form?: ConfigForm;
    private editingChannel?: string;

    constructor(tui: TUI, onBack: () => void, onConfigChange?: () => void) {
        this.tui = tui;
        this.onBack = onBack;
        this.onConfigChange = onConfigChange;
        this.showMain();
    }

    private showMain() {
        this.state = 'main';
        const config = getSearchConfig();
        const channels: any = config.channels || {};
        const defaultWeb = config.defaultWebSearch || 'bing';
        const defaultAcademic = config.defaultAcademicSearch || 'arxiv';
        const webSearchEnabled = config.webSearchEnabled !== false;
        const academicSearchEnabled = config.academicSearchEnabled !== false;

        const fields: FieldDef[] = [];

        // 启用网页搜索开关
        fields.push({
            type: 'boolean',
            key: 'webSearchEnabled',
            label: '启用网页搜索',
            value: webSearchEnabled
        });

        // 网页搜索渠道选择（仅在启用时显示）
        if (webSearchEnabled) {
            const webOptions = WEB_CHANNELS.map((ch) => ch.id);
            const webOptionLabels: Record<string, string> = {};
            for (const ch of WEB_CHANNELS) {
                const hasApiKey = !ch.needsApiKey || (channels[ch.id]?.api_key || '') !== '';
                webOptionLabels[ch.id] = `${ch.name}${!hasApiKey ? ' ✓' : hasApiKey ? ' 🔑' : ' ✗需要Key'}`;
            }

            fields.push({
                type: 'select',
                key: 'defaultWebSearch',
                label: '默认网页搜索',
                value: defaultWeb,
                options: webOptions,
                optionLabels: webOptionLabels
            });

            // API Key 配置（需要 key 的渠道）
            for (const ch of WEB_CHANNELS) {
                if (!ch.needsApiKey) continue;
                const apiKey = channels[ch.id]?.api_key || '';
                const masked = apiKey ? apiKey.substring(0, 4) + '****' + apiKey.substring(apiKey.length - 4) : '';
                fields.push({
                    type: 'text',
                    key: `apikey_${ch.id}`,
                    label: `${ch.name} API Key`,
                    value: masked || '（未设置）'
                });
            }
        }

        // 启用学术搜索开关
        fields.push({
            type: 'boolean',
            key: 'academicSearchEnabled',
            label: '启用学术搜索',
            value: academicSearchEnabled
        });

        // 学术搜索渠道选择（仅在启用时显示）
        if (academicSearchEnabled) {
            const academicOptions = ACADEMIC_CHANNELS.map((ch) => ch.id);
            const academicLabels: Record<string, string> = {};
            for (const ch of ACADEMIC_CHANNELS) {
                academicLabels[ch.id] = ch.name;
            }

            fields.push({
                type: 'select',
                key: 'defaultAcademicSearch',
                label: '默认学术搜索',
                value: defaultAcademic,
                options: academicOptions,
                optionLabels: academicLabels
            });
        }

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        this.form = new ConfigForm(
            this.tui,
            '搜索设置',
            fields,
            actions,
            (actionKey, values) => {
                if (actionKey === 'save') this.saveMain(values);
                else this.close();
            },
            () => this.close(),
            (values) => {
                // 当 boolean 或 select 变更时重建表单以刷新字段可见性
                const currentConfig = getSearchConfig();
                const updatedConfig = {
                    ...currentConfig,
                    webSearchEnabled: values.webSearchEnabled,
                    academicSearchEnabled: values.academicSearchEnabled,
                    defaultWebSearch: values.defaultWebSearch ?? currentConfig.defaultWebSearch,
                    defaultAcademicSearch: values.defaultAcademicSearch ?? currentConfig.defaultAcademicSearch
                };
                // 临时将更新后的值写回，以便 showMain 读取
                const allConfig = getSearchConfig();
                allConfig.webSearchEnabled = values.webSearchEnabled;
                allConfig.academicSearchEnabled = values.academicSearchEnabled;
                if (values.defaultWebSearch !== undefined) {
                    allConfig.defaultWebSearch = values.defaultWebSearch;
                }
                if (values.defaultAcademicSearch !== undefined) {
                    allConfig.defaultAcademicSearch = values.defaultAcademicSearch;
                }
                saveSearchConfig(allConfig);
                // 重建表单
                this.form?.deactivate();
                this.showMain();
            }
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private saveMain(values: Record<string, any>) {
        const config = getSearchConfig();
        const channels: any = config.channels || {};

        // 更新开关
        config.webSearchEnabled = values.webSearchEnabled;
        config.academicSearchEnabled = values.academicSearchEnabled;

        // 仅在启用时更新默认渠道
        if (values.webSearchEnabled && values.defaultWebSearch !== undefined) {
            config.defaultWebSearch = values.defaultWebSearch;
        }
        if (values.academicSearchEnabled && values.defaultAcademicSearch !== undefined) {
            config.defaultAcademicSearch = values.defaultAcademicSearch;
        }

        // 更新 API Keys
        for (const ch of WEB_CHANNELS) {
            if (!ch.needsApiKey) continue;
            const value = values[`apikey_${ch.id}`];
            if (value && value !== '（未设置）') {
                if (!channels[ch.id]) channels[ch.id] = {};
                channels[ch.id].api_key = value;
            }
        }

        config.channels = channels;
        saveSearchConfig(config);
        this.onConfigChange?.();
        this.close();
    }

    private close() {
        this.form?.deactivate();
        this.form = undefined;
        this.onBack();
    }

    invalidate() {}

    render(width: number): string[] {
        if (!this.form) return [];
        return this.form.render(width);
    }
}
