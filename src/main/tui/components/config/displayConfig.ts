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
import { OUTPUT_DISPLAY_LEVELS } from '../../display.js';

export class DisplayConfigPage implements Component {
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
        const outputDisplay = data.cli_config?.output_display ?? 'minimal';
        const reasonDisplay =
            data.cli_config?.reason_display === 'full' || data.cli_config?.show_all_reasoning === true
                ? 'full'
                : 'partial';

        const fields: FieldDef[] = [
            {
                type: 'select',
                key: 'output_display',
                label: t('config.display.field.output_display'),
                value: outputDisplay,
                options: [...OUTPUT_DISPLAY_LEVELS],
                optionLabels: {
                    minimal: t('config.display.option.output_display.minimal'),
                    verbose: t('config.display.option.output_display.verbose')
                }
            },
            {
                type: 'select',
                key: 'reason_display',
                label: t('config.display.field.reason_display'),
                value: reasonDisplay,
                options: ['full', 'partial'],
                optionLabels: {
                    full: t('config.display.option.reason_display.full'),
                    partial: t('config.display.option.reason_display.partial')
                },
                disabled: outputDisplay === 'minimal',
                disabledHint: t('config.display.reason_display.unavailable')
            }
        ];

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        const form = new ConfigForm(
            this.tui,
            t('config.display.title'),
            fields,
            actions,
            (actionKey, values) => {
                if (actionKey === 'save') this.save(values);
                else this.close();
            },
            () => this.close(),
            (values) => {
                const minimal = values.output_display !== 'verbose';
                form.setItemDisabled('reason_display', minimal, t('config.display.reason_display.unavailable'));
            }
        );
        this.form = form;
        this.form.activate();
        this.tui.requestRender();
    }

    private save(values: Record<string, unknown>) {
        const setting = Setting.getInstance();
        const data = setting.getData();
        if (!data.cli_config) {
            data.cli_config = {} as typeof data.cli_config;
        }
        data.cli_config.output_display = values.output_display === 'verbose' ? 'verbose' : 'minimal';
        data.cli_config.show_all_reasoning =
            data.cli_config.output_display === 'verbose' && values.reason_display === 'full';
        if (
            data.cli_config.output_display === 'verbose' &&
            (values.reason_display === 'full' || values.reason_display === 'partial')
        ) {
            data.cli_config.reason_display = values.reason_display;
        }
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
