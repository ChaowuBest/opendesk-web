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
import { defaultSelectListTheme } from '../../theme.js';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form.js';
import chalk from 'chalk';
import { t } from '../../../../locale/index.js';
import { reloadTelemetry } from '../../../telemetry/index.js';

interface TelemetryEndpoint {
    url: string;
    protocol: string;
    enabled: boolean;
}

function getTelemetryConfig() {
    const data = Setting.getInstance().getData() as any;
    return data.telemetry?.opentelemetry ?? { endpoints: [] };
}

function saveTelemetryConfig(endpoints: TelemetryEndpoint[]) {
    const setting = Setting.getInstance();
    const data = setting.getData() as any;
    setting.setData({
        ...data,
        telemetry: {
            opentelemetry: { endpoints }
        }
    });
}

/**
 * TUI 遥测设置页面。
 * 状态机：main → edit → main
 *
 * - main: 端点列表（SelectList），每行显示协议、URL 和启用状态，可添加/选择/返回
 * - edit: 单个端点编辑表单（协议、URL、启用开关）
 */
export class TelemetryConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private onConfigChange?: () => void;
    private state: 'main' | 'edit' = 'main';

    private list?: SelectList;
    private form?: ConfigForm;
    private endpoints: TelemetryEndpoint[] = [];
    private editingIndex = -1;

    constructor(tui: TUI, onBack: () => void, onConfigChange?: () => void) {
        this.tui = tui;
        this.onBack = onBack;
        this.onConfigChange = onConfigChange;
        this.loadConfig();
        this.showMain();
    }

    private loadConfig() {
        const config = getTelemetryConfig();
        const raw = Array.isArray(config.endpoints) ? config.endpoints : [];
        // string 格式的旧端点已在 schema 层面过滤，这里不再需要兼容处理
        this.endpoints = raw.map((ep: any) => ({
            url: ep.url ?? '',
            protocol: ep.protocol ?? 'opentelemetry',
            enabled: ep.enabled ?? false
        }));
    }

    private persistAndNotify() {
        saveTelemetryConfig(this.endpoints.filter((ep) => ep.url.trim()));
        this.onConfigChange?.();
        void reloadTelemetry().catch(() => {});
    }

    private getProtocolLabel(protocol: string): string {
        switch (protocol) {
            case 'opentelemetry':
                return 'OpenTelemetry';
            default:
                return protocol || 'OpenTelemetry';
        }
    }

    // ─── main 状态 ──────────────────────────────────────────────

    private showMain() {
        this.state = 'main';
        this.form?.deactivate();
        this.form = undefined;

        const items = [
            { value: '__add__', label: chalk.green(`+ ${t('config.telemetry.add')}`) },
            ...this.endpoints.map((ep, i) => {
                const protocolLabel = chalk.cyan(`[${this.getProtocolLabel(ep.protocol)}]`);
                const urlDisplay = ep.enabled ? chalk.white(ep.url) : chalk.dim(ep.url);
                const status = ep.enabled ? chalk.green(' ●') : chalk.red(' ○');
                return {
                    value: String(i),
                    label: `${status}  ${protocolLabel}  ${urlDisplay}`
                };
            })
        ];

        this.list = new SelectList(items, Math.min(items.length, 15), defaultSelectListTheme);
        this.tui.setFocus(this.list);

        this.list.onSelect = (item) => {
            if (item.value === '__add__') {
                this.editingIndex = -1;
                this.showEditForm('', 'opentelemetry', true);
            } else {
                const idx = parseInt(item.value, 10);
                if (!Number.isNaN(idx) && idx >= 0 && idx < this.endpoints.length) {
                    this.editingIndex = idx;
                    const ep = this.endpoints[idx];
                    this.showEditForm(ep.url, ep.protocol, ep.enabled);
                }
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

    private showEditForm(initialUrl: string, initialProtocol: string, initialEnabled: boolean) {
        this.state = 'edit';
        this.list = undefined;

        const isEdit = this.editingIndex >= 0;
        const title = isEdit ? t('config.telemetry.edit') : t('config.telemetry.add_title');

        const fields: FieldDef[] = [
            { type: 'text', key: 'endpoint_protocol', label: t('config.telemetry.protocol'), value: initialProtocol },
            { type: 'text', key: 'endpoint_url', label: t('config.telemetry.endpoint'), value: initialUrl },
            {
                type: 'boolean',
                key: 'endpoint_enabled',
                label: t('config.telemetry.field.enabled'),
                value: initialEnabled
            }
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
            const url = (values.endpoint_url as string)?.trim() || '';
            const protocol = (values.endpoint_protocol as string)?.trim() || 'opentelemetry';
            const enabled = !!values.endpoint_enabled;
            if (url) {
                if (this.editingIndex >= 0) {
                    this.endpoints[this.editingIndex] = { url, protocol, enabled };
                } else {
                    this.endpoints.push({ url, protocol, enabled });
                }
                this.persistAndNotify();
            }
            this.showMain();
        } else if (actionKey === 'delete') {
            if (this.editingIndex >= 0) {
                this.endpoints.splice(this.editingIndex, 1);
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
                lines.push(chalk.bold('📈  ' + t('config.telemetry.title')));
                lines.push(chalk.dim('─'.repeat(dividerWidth)));
                lines.push('');
                if (this.list) lines.push(...this.list.render(width));
                lines.push('');
                lines.push(chalk.dim(`  ${t('config.main.hint')}  ${t('config.telemetry.hint')}`));
                break;

            case 'edit':
                if (this.form) lines.push(...this.form.render(width));
                break;
        }

        return lines;
    }
}
