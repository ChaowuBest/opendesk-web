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
import { ConfigForm, type ActionDef, type FieldDef } from './form.js';
import { t } from '../../../../locale/index.js';

const USE_PROXY_OPTIONS = ['none', 'system', 'custom'];

export class NetworkConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private onConfigChange?: () => void;
    private form?: ConfigForm;

    constructor(tui: TUI, onBack: () => void, onConfigChange?: () => void) {
        this.tui = tui;
        this.onBack = onBack;
        this.onConfigChange = onConfigChange;
        this.showForm();
    }

    private showForm() {
        const data = Setting.getInstance().getData();
        const networkConfig = data.network_config ?? {
            no_ssl: false,
            use_proxy: 'none',
            custom_proxy_addr: '',
            no_proxy: ''
        };
        const currentUseProxy = networkConfig.use_proxy || 'none';

        const fields: FieldDef[] = [
            {
                type: 'boolean',
                key: 'no_ssl',
                label: t('config.network.field.no_ssl'),
                value: networkConfig.no_ssl === true
            },
            {
                type: 'select',
                key: 'use_proxy',
                label: t('config.network.field.use_proxy'),
                value: currentUseProxy,
                options: USE_PROXY_OPTIONS,
                optionLabels: {
                    none: t('config.network.option.use_proxy.none'),
                    system: t('config.network.option.use_proxy.system'),
                    custom: t('config.network.option.use_proxy.custom')
                }
            },
            {
                type: 'text',
                key: 'custom_proxy_addr',
                label: t('config.network.field.custom_proxy_addr'),
                value: networkConfig.custom_proxy_addr || '',
                visible: currentUseProxy === 'custom'
            },
            {
                type: 'text',
                key: 'no_proxy',
                label: t('config.network.field.no_proxy'),
                value: networkConfig.no_proxy || '',
                visible: currentUseProxy === 'custom'
            }
        ];

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        this.form = new ConfigForm(
            this.tui,
            t('config.network.title'),
            fields,
            actions,
            (actionKey, values) => {
                if (actionKey === 'save') this.save(values);
                else this.close();
            },
            () => this.close(),
            (values) => {
                // 当 use_proxy 切换时，动态显示/隐藏自定义代理地址和 no_proxy
                const isCustom = values.use_proxy === 'custom';
                this.form?.setItemVisible('custom_proxy_addr', isCustom);
                this.form?.setItemVisible('no_proxy', isCustom);
            }
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private save(values: Record<string, unknown>) {
        const setting = Setting.getInstance();
        const data = setting.getData();
        data.network_config = {
            ...(data.network_config ?? { no_ssl: false, use_proxy: 'none', custom_proxy_addr: '', no_proxy: '' }),
            no_ssl: values.no_ssl === true,
            // 表单 select 仅提供 USE_PROXY_OPTIONS 中的取值，按此收窄
            use_proxy: (values.use_proxy as 'none' | 'system' | 'custom') || 'none',
            custom_proxy_addr: (values.custom_proxy_addr as string) || '',
            no_proxy: (values.no_proxy as string) || ''
        };
        setting.setData(data);
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
