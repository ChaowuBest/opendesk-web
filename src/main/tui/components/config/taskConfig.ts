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
import { scanSupportedShells, selectSupportedShell } from '../../../applications/terminal/scan.js';

export class TaskConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private onConfigChange?: () => void;
    private form?: ConfigForm;
    private readonly shells = scanSupportedShells();

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
        const selectedShell = selectSupportedShell(this.shells, taskConfig);
        const shellPaths = [...new Set(this.shells.map((shell) => shell.path))];

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
                type: 'select',
                key: 'shell_path',
                label: t('sp.task.terminal.shell'),
                value: selectedShell?.path ?? '',
                options: shellPaths.length ? shellPaths : [''],
                optionLabels: {
                    '': t('sp.task.terminal.noShells'),
                    ...Object.fromEntries(this.shells.map((shell) => [shell.path, `${shell.kind} — ${shell.path}`]))
                }
            },
            {
                type: 'boolean',
                key: 'shell_sandboxed',
                label: t('sp.task.terminal.sandbox'),
                value: selectedShell?.sandboxed === true,
                visible: this.shells.some((shell) => shell.path === selectedShell?.path && shell.sandboxed)
            },
            {
                type: 'boolean',
                key: 'shell_sandbox_del_to_trash',
                label: t('sp.task.terminal.sandbox.delToTrash'),
                value: taskConfig.shell_sandbox_del_to_trash === true,
                visible:
                    selectedShell?.sandboxed === true &&
                    this.shells.some((shell) => shell.path === selectedShell?.path && shell.sandboxed)
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
            () => this.close(),
            (values) => {
                const supportsSandbox = this.shells.some(
                    (shell) => shell.path === values.shell_path && shell.sandboxed
                );
                this.form?.setItemVisible('shell_sandboxed', supportsSandbox);
                this.form?.setItemVisible(
                    'shell_sandbox_del_to_trash',
                    supportsSandbox && values.shell_sandboxed === true
                );
            }
        );
        this.form.activate();
        this.tui.requestRender();
    }

    private save(values: Record<string, any>) {
        const setting = Setting.getInstance();
        const data = setting.getData();
        const shell = selectSupportedShell(this.shells, values);
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
            evidence_card: values.evidence_card === true,
            shell_path: shell?.path ?? '',
            shell_sandboxed: shell?.sandboxed ?? false,
            shell_sandbox_del_to_trash: values.shell_sandbox_del_to_trash === true
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
