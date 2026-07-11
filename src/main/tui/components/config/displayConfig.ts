import { type Component, type TUI } from '@earendil-works/pi-tui';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type ActionDef, type FieldDef } from './form.js';
import { t } from '../../../../locale/index.js';

const REASON_DISPLAY_OPTIONS = ['full', 'partial'];

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
        const reasonDisplay = data.cli_config?.reason_display || 'partial';

        const fields: FieldDef[] = [
            {
                type: 'select',
                key: 'reason_display',
                label: t('config.display.field.reason_display'),
                value: reasonDisplay,
                options: REASON_DISPLAY_OPTIONS,
                optionLabels: {
                    full: t('config.display.option.reason_display.full'),
                    partial: t('config.display.option.reason_display.partial')
                }
            }
        ];

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        this.form = new ConfigForm(
            this.tui,
            t('config.display.title'),
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

    private save(values: Record<string, unknown>) {
        const setting = Setting.getInstance();
        const data = setting.getData();
        if (!data.cli_config) {
            data.cli_config = {} as typeof data.cli_config;
        }
        data.cli_config.reason_display = values.reason_display === 'full' ? 'full' : 'partial';
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
