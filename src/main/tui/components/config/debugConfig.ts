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
import {
    isDeveloperModeEnabled,
    setDeveloperModeEnabled,
    isLogRawLlmRequestEnabled,
    Setting
} from '../../../utils/setting.js';
import { ConfigForm, type ActionDef, type FieldDef } from './form.js';
import { t } from '../../../../locale/index.js';
import { ConfirmOverlay } from '../notice.js';
import type { OpenDeskTUI } from '../../entry.js';

export class DebugConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private onConfigChange?: () => void;
    private form?: ConfigForm;

    constructor(
        private readonly openDeskTUI: OpenDeskTUI,
        onBack: () => void,
        onConfigChange?: () => void
    ) {
        this.tui = openDeskTUI.tui;
        this.onBack = onBack;
        this.onConfigChange = onConfigChange;
        this.showForm();
    }

    private showForm(values?: Record<string, any>) {
        const fields: FieldDef[] = [
            {
                type: 'boolean',
                key: 'developer_mode',
                label: t('config.debug.field.developer_mode'),
                value: values?.developer_mode ?? isDeveloperModeEnabled()
            },
            {
                type: 'boolean',
                key: 'log_raw_llm_request',
                label: t('config.debug.field.log_raw_llm_request'),
                value: values?.log_raw_llm_request ?? isLogRawLlmRequestEnabled()
            }
        ];

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        this.form = new ConfigForm(
            this.tui,
            t('config.debug.title'),
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

    private save(values: Record<string, any>) {
        if (values.log_raw_llm_request === true && !isLogRawLlmRequestEnabled()) {
            this.form?.deactivate();
            new ConfirmOverlay(this.openDeskTUI, {
                title: t('config.debug.raw_llm.confirm.title'),
                message: t('config.debug.raw_llm.confirm.message'),
                confirmLabel: t('config.debug.raw_llm.confirm.enable'),
                cancelLabel: t('common.cancel'),
                allowDuringConfig: true
            }).show(
                () => this.commit(values),
                () => this.showForm({ ...values, log_raw_llm_request: false })
            );
            return;
        }
        this.commit(values);
    }

    private commit(values: Record<string, any>): void {
        const rawLoggingEnabled = values.log_raw_llm_request === true;
        setDeveloperModeEnabled(values.developer_mode === true);
        const setting = Setting.getInstance();
        const data = setting.getData();
        setting.setData({
            ...data,
            debug: {
                ...data.debug,
                log_raw_llm_request: rawLoggingEnabled
            }
        });
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
