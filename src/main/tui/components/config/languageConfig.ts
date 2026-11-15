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
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import chalk from 'chalk';
import { t, setLocale, getLocale } from '../../../../locale/index.js';
import { getLocalePackStore } from '../../../../locale/packs.js';
import { formatLocaleDisplayName, isBuiltinLocaleTag } from '../../../../common/locale/pack.js';

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

        // 语言选项动态化：内置语言 + 已启用语言包注册的语言（显示名按语言自身书写形式）
        const availableLocales = getLocalePackStore().getAvailableLocales();
        const localeOptions = ['auto', ...availableLocales];
        const localeOptionLabels: Record<string, string> = {
            auto: t('config.language.option.auto')
        };
        for (const tag of availableLocales) {
            localeOptionLabels[tag] = isBuiltinLocaleTag(tag)
                ? t(`config.language.option.${tag}`)
                : formatLocaleDisplayName(tag);
        }

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
