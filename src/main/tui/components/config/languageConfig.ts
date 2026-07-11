import { type Component, type TUI } from '@earendil-works/pi-tui';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import chalk from 'chalk';
import { t, setLocale, getLocale } from '../../../../locale/index.js';

/**
 * Language setting page.
 */
export class LanguageConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private form?: ConfigForm;

    constructor(tui: TUI, onBack: () => void) {
        this.tui = tui;
        this.onBack = onBack;
        this.showForm();
    }

    private showForm() {
        const data = Setting.getInstance().getData();
        const currentLocale = data.locale;

        const localeOptions = ['auto', 'zh-CN', 'en-US'];
        const localeOptionLabels: Record<string, string> = {
            auto: t('config.language.option.auto'),
            'zh-CN': t('config.language.option.zh-CN'),
            'en-US': t('config.language.option.en-US')
        };

        const fields: FieldDef[] = [
            {
                type: 'select',
                key: 'locale',
                label: t('config.language.field.locale'),
                value: currentLocale,
                options: localeOptions,
                optionLabels: localeOptionLabels
            }
        ];

        const actions: ActionDef[] = [
            { key: 'save', label: t('config.common.save'), style: 'primary' },
            { key: 'cancel', label: t('config.common.cancel') }
        ];

        this.form = new ConfigForm(
            this.tui,
            t('config.language.title'),
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

    private close() {
        this.form?.deactivate();
        this.form = undefined;
        this.onBack();
    }

    private save(values: Record<string, any>) {
        const newLocale = values.locale ?? 'auto';
        setLocale(newLocale);
        this.close();
    }

    invalidate() {}

    render(width: number): string[] {
        if (!this.form) return [];
        return this.form.render(width);
    }
}
