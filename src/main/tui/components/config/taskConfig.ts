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

export class TaskConfigPage implements Component {
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
        const taskConfig = data.task_config ?? {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: false
        };
        const cliConfig = data.cli_config ?? { use_isolated_python: true, inherit_venv: true };

        const fields: FieldDef[] = [
            {
                type: 'boolean',
                key: 'auto_retry',
                label: t('config.task.field.auto_retry'),
                value: taskConfig.auto_retry !== false
            },
            {
                type: 'boolean',
                key: 'generate_taskname',
                label: t('config.task.field.generate_taskname'),
                value: taskConfig.generate_taskname !== false
            },
            {
                type: 'boolean',
                key: 'termination_check',
                label: t('config.task.field.termination_check'),
                value: taskConfig.termination_check !== false
            },
            {
                type: 'boolean',
                key: 'evidence_card',
                label: t('config.task.field.evidence_card'),
                value: taskConfig.evidence_card === true
            },
            {
                type: 'boolean',
                key: 'use_isolated_python',
                label: t('config.task.field.use_isolated_python'),
                value: cliConfig.use_isolated_python !== false
            },
            {
                type: 'boolean',
                key: 'inherit_venv',
                label: t('config.task.field.inherit_venv'),
                value: cliConfig.inherit_venv !== false
            }
        ];

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        this.form = new ConfigForm(
            this.tui,
            t('config.task.title'),
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
        const setting = Setting.getInstance();
        const data = setting.getData();
        data.task_config = {
            ...(data.task_config ?? {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: false
            }),
            auto_retry: values.auto_retry !== false,
            generate_taskname: values.generate_taskname !== false,
            termination_check: values.termination_check !== false,
            evidence_card: values.evidence_card === true
        };
        data.cli_config = {
            ...(data.cli_config ?? {}),
            use_isolated_python: values.use_isolated_python !== false,
            inherit_venv: values.inherit_venv !== false
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
