/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { type Component, type TUI } from '@earendil-works/pi-tui';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import { t } from '../../../../locale/index.js';

const WEB_CHANNELS = [
    { id: 'duckduckgo', name: 'DuckDuckGo', needsApiKey: false },
    { id: 'bing', name: 'Bing', needsApiKey: false },
    { id: 'baidu', name: '百度', needsApiKey: false },
    { id: 'tavily', name: 'Tavily', needsApiKey: true },
    { id: 'brave', name: 'Brave', needsApiKey: true },
    { id: 'bocha', name: '博查', needsApiKey: true },
    { id: 'exa', name: 'Exa', needsApiKey: true }
];

const ACADEMIC_CHANNELS = [
    { id: 'arxiv', name: 'arXiv' },
    { id: 'dblp', name: 'DBLP' }
];

// 所有需要 API Key 的渠道 key 前缀列表
const API_KEY_KEYS = WEB_CHANNELS.filter((ch) => ch.needsApiKey).map((ch) => `apikey_${ch.id}`);

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
        const bingChannels: any = channels.bing || {};
        const bingLang = bingChannels.lang || 'zh';

        // 当前选择的 Web 搜索引擎
        const selectedWebMeta = WEB_CHANNELS.find((ch) => ch.id === defaultWeb);
        const selectedNeedsApiKey = selectedWebMeta?.needsApiKey ?? false;

        const fields: FieldDef[] = [];

        // ── 启用网页搜索开关 ──
        fields.push({
            type: 'boolean',
            key: 'webSearchEnabled',
            label: '启用网页搜索',
            value: webSearchEnabled
        });

        // ── 网页搜索渠道选择 ──
        const webOptions = WEB_CHANNELS.map((ch) => ch.id);
        const webOptionLabels: Record<string, string> = {};
        for (const ch of WEB_CHANNELS) {
            const hasApiKey = !ch.needsApiKey || (channels[ch.id]?.api_key || '') !== '';
            webOptionLabels[ch.id] = `${ch.name}${!ch.needsApiKey ? ' ✓' : hasApiKey ? ' 🔑' : ' ✗需要Key'}`;
        }
        fields.push({
            type: 'select',
            key: 'defaultWebSearch',
            label: '默认网页搜索',
            value: defaultWeb,
            options: webOptions,
            optionLabels: webOptionLabels,
            visible: webSearchEnabled
        });

        // ── Bing 语言模式（Bing 被选中且未禁用时可见） ──
        fields.push({
            type: 'select',
            key: 'bingLang',
            label: 'Bing 搜索模式',
            value: bingLang,
            options: ['zh', 'en'],
            optionLabels: { zh: '中国版', en: '全球版' },
            visible: webSearchEnabled && defaultWeb === 'bing'
        });

        // ── API Key 配置 ──
        for (const ch of WEB_CHANNELS) {
            if (!ch.needsApiKey) continue;
            const apiKey = channels[ch.id]?.api_key || '';
            const masked = apiKey ? apiKey.substring(0, 4) + '****' + apiKey.substring(apiKey.length - 4) : '';
            fields.push({
                type: 'text',
                key: `apikey_${ch.id}`,
                label: `${ch.name} API Key`,
                value: masked || '（未设置）',
                visible: webSearchEnabled && defaultWeb === ch.id
            });
        }

        // ── 启用学术搜索开关 ──
        fields.push({
            type: 'boolean',
            key: 'academicSearchEnabled',
            label: '启用学术搜索',
            value: academicSearchEnabled
        });

        // ── 学术搜索渠道选择 ──
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
            optionLabels: academicLabels,
            visible: academicSearchEnabled
        });

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
            (values) => this.onAnyFieldChange(values)
        );
        this.form.activate();
        this.tui.requestRender();
    }

    /**
     * 当任何字段（boolean 或 select）发生变化时调用。
     * 不重建表单，只刷新相关字段的可见性，保留焦点位置。
     */
    private onAnyFieldChange(values: Record<string, any>) {
        const ws = values.webSearchEnabled;
        const as = values.academicSearchEnabled;
        const curWeb = values.defaultWebSearch;

        // web 搜索：开关控制渠道选择器和 API Key 的可见性
        this.form?.setItemVisible('defaultWebSearch', ws);
        // Bing 模式仅当选中 Bing 且 web 启用时显示
        this.form?.setItemVisible('bingLang', ws && curWeb === 'bing');
        // 每个 API Key 仅当 web 启用且选中对应渠道时显示
        for (const ch of WEB_CHANNELS) {
            if (!ch.needsApiKey) continue;
            this.form?.setItemVisible(`apikey_${ch.id}`, ws && curWeb === ch.id);
        }
        // 学术搜索
        this.form?.setItemVisible('defaultAcademicSearch', as);

        this.tui.requestRender();
    }

    private saveMain(values: Record<string, any>) {
        const config = getSearchConfig();
        const channels: any = config.channels || {};

        // 更新开关
        config.webSearchEnabled = values.webSearchEnabled;
        config.academicSearchEnabled = values.academicSearchEnabled;
        // Bing 语言 → channels.bing.lang
        if (!channels.bing) channels.bing = {};
        channels.bing.lang = values.bingLang;

        // 更新默认渠道
        if (values.defaultWebSearch !== undefined) {
            config.defaultWebSearch = values.defaultWebSearch;
        }
        if (values.defaultAcademicSearch !== undefined) {
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
