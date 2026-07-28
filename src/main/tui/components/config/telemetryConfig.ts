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

import { type Component, SelectList, TUI } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';
import { reloadTelemetry } from '../../../telemetry/index.js';
import {
    LangfuseConfigSchema,
    Setting,
    type LangfuseConfig,
    type OpenTelemetryConfig,
    type TelemetryConfig
} from '../../../utils/setting.js';
import { defaultSelectListTheme } from '../../theme.js';
import { ConfigForm, type ActionDef, type FieldDef } from './form.js';

type OpenTelemetryEndpoint = OpenTelemetryConfig['endpoints'][number];
type LangfuseEndpoint = LangfuseConfig['endpoints'][number];
type EndpointProtocol = 'opentelemetry' | 'langfuse';
type EndpointReference = { protocol: EndpointProtocol; index: number };
type PageState = 'endpoints' | 'endpoint';

const DEFAULT_LANGFUSE_CONFIG = LangfuseConfigSchema.parse(undefined);
const LANGFUSE_FIELDS = [
    'base_url',
    'public_key',
    'secret_key',
    'export_mode',
    'flush_at',
    'flush_interval_seconds',
    'environment',
    'max_payload_chars'
];

function getTelemetryConfig(): TelemetryConfig {
    const telemetry = Setting.getInstance().getData().telemetry;
    return {
        opentelemetry: telemetry?.opentelemetry ?? { endpoints: [] },
        langfuse: telemetry?.langfuse ?? DEFAULT_LANGFUSE_CONFIG
    };
}

function saveTelemetryConfig(config: TelemetryConfig): void {
    const setting = Setting.getInstance();
    setting.setData({
        ...setting.getData(),
        telemetry: config
    });
}

function positiveInteger(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * TUI 遥测端点设置。端点列表统一展示，编辑表单根据协议切换字段，
 * 持久化时仍按协议分组，保持协议初始化相互独立。
 */
export class TelemetryConfigPage implements Component {
    private state: PageState = 'endpoints';
    private list?: SelectList;
    private form?: ConfigForm;
    private openTelemetryEndpoints: OpenTelemetryEndpoint[] = [];
    private langfuse: LangfuseConfig = DEFAULT_LANGFUSE_CONFIG;
    private editing?: EndpointReference;
    private validationError?: string;

    constructor(
        private readonly tui: TUI,
        private readonly onBack: () => void,
        private readonly onConfigChange?: () => void
    ) {
        this.loadConfig();
        this.showEndpoints();
    }

    private loadConfig(): void {
        const config = getTelemetryConfig();
        this.openTelemetryEndpoints = config.opentelemetry.endpoints.map((endpoint) => ({ ...endpoint }));
        this.langfuse = {
            ...DEFAULT_LANGFUSE_CONFIG,
            ...config.langfuse,
            endpoints: config.langfuse.endpoints.map((endpoint) => ({ ...endpoint }))
        };
    }

    private persistAndNotify(): void {
        saveTelemetryConfig({
            opentelemetry: {
                endpoints: this.openTelemetryEndpoints.filter((endpoint) => endpoint.url.trim())
            },
            langfuse: this.langfuse
        });
        this.onConfigChange?.();
        void reloadTelemetry().catch(() => {});
    }

    private replaceList(items: { value: string; label: string }[]): void {
        this.form?.deactivate();
        this.form = undefined;
        this.list = new SelectList(items, Math.min(items.length, 15), defaultSelectListTheme);
        this.tui.setFocus(this.list);
        this.tui.requestRender();
    }

    private allEndpoints(): Array<EndpointReference & { endpoint: OpenTelemetryEndpoint | LangfuseEndpoint }> {
        return [
            ...this.openTelemetryEndpoints.map((endpoint, index) => ({
                protocol: 'opentelemetry' as const,
                index,
                endpoint
            })),
            ...this.langfuse.endpoints.map((endpoint, index) => ({
                protocol: 'langfuse' as const,
                index,
                endpoint
            }))
        ];
    }

    private showEndpoints(): void {
        this.state = 'endpoints';
        this.validationError = undefined;
        const items = [
            { value: '__add__', label: chalk.green(`+ ${t('config.telemetry.add')}`) },
            ...this.allEndpoints().map(({ protocol, index, endpoint }) => {
                const target =
                    protocol === 'opentelemetry'
                        ? (endpoint as OpenTelemetryEndpoint).url
                        : (endpoint as LangfuseEndpoint).base_url || 'https://cloud.langfuse.com';
                const name = endpoint.name || target;
                const status = endpoint.enabled ? chalk.green('●') : chalk.red('○');
                const protocolLabel = protocol === 'opentelemetry' ? 'OpenTelemetry' : 'Langfuse';
                return {
                    value: `${protocol}:${index}`,
                    label: `${status}  ${name}  ${chalk.dim(`[${protocolLabel}] ${target}`)}`
                };
            })
        ];
        this.replaceList(items);
        this.list.onSelect = (item) => {
            if (item.value === '__add__') {
                this.editing = undefined;
                this.showEndpointForm('opentelemetry');
                return;
            }
            const [protocol, rawIndex] = item.value.split(':');
            const index = Number(rawIndex);
            if ((protocol === 'opentelemetry' || protocol === 'langfuse') && Number.isInteger(index)) {
                this.editing = { protocol, index };
                this.showEndpointForm(protocol);
            }
        };
        this.list.onCancel = () => {
            this.list = undefined;
            this.onBack();
        };
    }

    private getEditingEndpoint(protocol: EndpointProtocol): OpenTelemetryEndpoint | LangfuseEndpoint | undefined {
        if (!this.editing || this.editing.protocol !== protocol) {
            return undefined;
        }
        return protocol === 'opentelemetry'
            ? this.openTelemetryEndpoints[this.editing.index]
            : this.langfuse.endpoints[this.editing.index];
    }

    private showEndpointForm(initialProtocol: EndpointProtocol): void {
        this.state = 'endpoint';
        this.list = undefined;
        this.validationError = undefined;
        const openTelemetryEndpoint = this.getEditingEndpoint('opentelemetry');
        const langfuseEndpoint = this.getEditingEndpoint('langfuse');
        const fields: FieldDef[] = [
            {
                type: 'select',
                key: 'protocol',
                label: t('config.telemetry.protocol'),
                value: initialProtocol,
                options: ['opentelemetry', 'langfuse'],
                optionLabels: {
                    opentelemetry: 'OpenTelemetry (OTLP)',
                    langfuse: 'Langfuse'
                }
            },
            {
                type: 'text',
                key: 'name',
                label: t('config.telemetry.field.name'),
                value: openTelemetryEndpoint?.name ?? langfuseEndpoint?.name ?? ''
            },
            {
                type: 'boolean',
                key: 'enabled',
                label: t('config.telemetry.field.enabled'),
                value: openTelemetryEndpoint?.enabled ?? langfuseEndpoint?.enabled ?? true
            },
            {
                type: 'text',
                key: 'url',
                label: t('config.telemetry.endpoint'),
                value: openTelemetryEndpoint?.url ?? '',
                visible: initialProtocol === 'opentelemetry'
            },
            {
                type: 'text',
                key: 'base_url',
                label: t('config.telemetry.langfuse.field.base_url'),
                value: langfuseEndpoint?.base_url ?? '',
                visible: initialProtocol === 'langfuse'
            },
            {
                type: 'text',
                key: 'public_key',
                label: t('config.telemetry.langfuse.field.public_key'),
                value: langfuseEndpoint?.public_key ?? '',
                visible: initialProtocol === 'langfuse'
            },
            {
                type: 'text',
                key: 'secret_key',
                label: t('config.telemetry.langfuse.field.secret_key'),
                value: langfuseEndpoint?.secret_key ?? '',
                visible: initialProtocol === 'langfuse'
            },
            {
                type: 'select',
                key: 'export_mode',
                label: t('config.telemetry.langfuse.field.export_mode'),
                value: langfuseEndpoint?.export_mode ?? 'batched',
                options: ['batched', 'immediate'],
                optionLabels: {
                    batched: t('config.telemetry.langfuse.option.export_mode.batched'),
                    immediate: t('config.telemetry.langfuse.option.export_mode.immediate')
                },
                visible: initialProtocol === 'langfuse'
            },
            {
                type: 'text',
                key: 'flush_at',
                label: t('config.telemetry.langfuse.field.flush_at'),
                value: String(langfuseEndpoint?.flush_at ?? 50),
                visible: initialProtocol === 'langfuse'
            },
            {
                type: 'text',
                key: 'flush_interval_seconds',
                label: t('config.telemetry.langfuse.field.flush_interval_seconds'),
                value: String(langfuseEndpoint?.flush_interval_seconds ?? 5),
                visible: initialProtocol === 'langfuse'
            },
            {
                type: 'text',
                key: 'environment',
                label: t('config.telemetry.langfuse.field.environment'),
                value: this.langfuse.environment,
                visible: initialProtocol === 'langfuse'
            },
            {
                type: 'text',
                key: 'max_payload_chars',
                label: t('config.telemetry.langfuse.field.max_payload_chars'),
                value: String(this.langfuse.max_payload_chars),
                visible: initialProtocol === 'langfuse'
            }
        ];
        const actions: ActionDef[] = [{ key: 'save', label: t('config.common.save'), style: 'primary' }];
        if (this.editing) {
            actions.push({ key: 'delete', label: t('config.common.delete'), style: 'danger' });
        }
        actions.push({ key: 'cancel', label: t('config.common.cancel') });
        this.form = new ConfigForm(
            this.tui,
            this.editing ? t('config.telemetry.edit') : t('config.telemetry.add_title'),
            fields,
            actions,
            (actionKey, values) => this.handleEndpointAction(actionKey, values),
            () => this.showEndpoints(),
            (values) => this.updateProtocolFieldVisibility(values.protocol)
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private updateProtocolFieldVisibility(protocol: EndpointProtocol): void {
        this.form?.setItemVisible('url', protocol === 'opentelemetry');
        this.form?.setItemsVisible(LANGFUSE_FIELDS, protocol === 'langfuse');
        this.tui.requestRender();
    }

    private removeEditingEndpoint(): void {
        if (!this.editing) return;
        if (this.editing.protocol === 'opentelemetry') {
            this.openTelemetryEndpoints.splice(this.editing.index, 1);
        } else {
            this.langfuse.endpoints.splice(this.editing.index, 1);
        }
    }

    private handleEndpointAction(actionKey: string, values: Record<string, any>): void {
        if (actionKey === 'delete') {
            this.removeEditingEndpoint();
            this.persistAndNotify();
            this.showEndpoints();
            return;
        }
        if (actionKey !== 'save') {
            this.showEndpoints();
            return;
        }

        const protocol: EndpointProtocol = values.protocol === 'langfuse' ? 'langfuse' : 'opentelemetry';
        const name = String(values.name ?? '').trim();
        const enabled = !!values.enabled;
        if (protocol === 'opentelemetry') {
            const url = String(values.url ?? '').trim();
            if (!url) {
                this.validationError = t('config.telemetry.validation.endpoint_required');
                this.tui.requestRender();
                return;
            }
            const endpoint: OpenTelemetryEndpoint = { name, protocol, enabled, url };
            if (this.editing?.protocol === protocol) {
                this.openTelemetryEndpoints[this.editing.index] = endpoint;
            } else {
                this.removeEditingEndpoint();
                this.openTelemetryEndpoints.push(endpoint);
            }
        } else {
            const flushAt = positiveInteger(values.flush_at);
            const flushIntervalSeconds = positiveInteger(values.flush_interval_seconds);
            const maxPayloadChars = positiveInteger(values.max_payload_chars);
            const publicKey = String(values.public_key ?? '');
            const secretKey = String(values.secret_key ?? '');
            if (!flushAt || !flushIntervalSeconds || !maxPayloadChars) {
                this.validationError = t('config.telemetry.langfuse.validation.positive_integer');
                this.tui.requestRender();
                return;
            }
            if (enabled && (!publicKey.trim() || !secretKey.trim())) {
                this.validationError = t('config.telemetry.langfuse.validation.keys_required');
                this.tui.requestRender();
                return;
            }
            const endpoint: LangfuseEndpoint = {
                name,
                protocol,
                enabled,
                base_url: String(values.base_url ?? '').trim(),
                public_key: publicKey,
                secret_key: secretKey,
                export_mode: values.export_mode === 'immediate' ? 'immediate' : 'batched',
                flush_at: flushAt,
                flush_interval_seconds: flushIntervalSeconds
            };
            this.langfuse = {
                ...this.langfuse,
                environment: String(values.environment ?? '').trim() || 'development',
                max_payload_chars: maxPayloadChars
            };
            if (this.editing?.protocol === protocol) {
                this.langfuse.endpoints[this.editing.index] = endpoint;
            } else {
                this.removeEditingEndpoint();
                this.langfuse.endpoints.push(endpoint);
            }
        }
        this.persistAndNotify();
        this.showEndpoints();
    }

    invalidate(): void {}

    render(width: number): string[] {
        const lines = [
            chalk.bold('📈  ' + t('config.telemetry.title')),
            chalk.dim('─'.repeat(Math.min(width - 2, 50))),
            ''
        ];
        if (this.validationError) {
            lines.push(chalk.red(`  ${this.validationError}`), '');
        }
        if (this.list) {
            lines.push(...this.list.render(width));
        } else if (this.form) {
            lines.push(...this.form.render(width));
        }
        lines.push('');
        lines.push(
            chalk.dim(
                `  ${t('config.main.hint')}  ${t(
                    this.state === 'endpoints' ? 'config.telemetry.hint' : 'config.telemetry.hint.protocol'
                )}`
            )
        );
        return lines;
    }
}
