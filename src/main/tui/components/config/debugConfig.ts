import { type Component, type TUI } from '@mariozechner/pi-tui';
import {
    isDeveloperModeEnabled,
    setDeveloperModeEnabled,
    isLogRawLlmRequestEnabled,
    Setting
} from '../../../utils/setting.js';
import { ConfigForm, type ActionDef, type FieldDef } from './form.js';
import { t } from '../../../../locale/index.js';

export class DebugConfigPage implements Component {
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
        const fields: FieldDef[] = [
            {
                type: 'boolean',
                key: 'developer_mode',
                label: t('config.debug.field.developer_mode'),
                value: isDeveloperModeEnabled()
            },
            {
                type: 'boolean',
                key: 'log_raw_llm_request',
                label: t('config.debug.field.log_raw_llm_request'),
                value: isLogRawLlmRequestEnabled()
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
        setDeveloperModeEnabled(values.developer_mode === true);
        const setting = Setting.getInstance();
        const data = setting.getData();
        setting.setData({
            ...data,
            debug: {
                ...data.debug,
                log_raw_llm_request: values.log_raw_llm_request === true
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
