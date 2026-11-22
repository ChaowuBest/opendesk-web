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

import { type Component } from '@earendil-works/pi-tui';
import type { OpenDeskTUI } from '../../entry.js';
import { Setting } from '../../../utils/setting.js';
import { ConfigForm, type FieldDef, type ActionDef } from './form';
import { InfoOverlay } from '../notice.js';
import { t, getRuntimeLocale } from '../../../../locale/index.js';
import { applyLanguageSetting } from '../../localeSwitch.js';
import { getLocalePackStore } from '../../../../locale/packs.js';
import { formatLocaleDisplayName, isBuiltinLocaleTag, orderLocaleOptions } from '../../../../common/locale/pack.js';

/**
 * Language setting page.
 */
export class LanguageConfigPage implements Component {
    private openDeskTUI: OpenDeskTUI;
    private onBack: () => void;
    private form?: ConfigForm;

    constructor(openDeskTUI: OpenDeskTUI, onBack: () => void) {
        this.openDeskTUI = openDeskTUI;
        this.onBack = onBack;
        this.showForm();
    }

    private showForm() {
        const data = Setting.getInstance().getData();
        const currentLocale = data.locale;

        // 语言选项动态化：内置语言 + 已启用语言包注册的语言（显示名按语言自身书写形式）
        // 顺序：默认（auto）→ 中文 → 其余按字母序
        const availableLocales = orderLocaleOptions(getLocalePackStore().getAvailableLocales());
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
            this.openDeskTUI.tui,
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
        this.openDeskTUI.tui.requestRender();
    }

    private close() {
        this.form?.deactivate();
        this.form = undefined;
        this.onBack();
    }

    private save(values: Record<string, any>) {
        const newLocale = values.locale ?? 'auto';
        const previousLocale = Setting.getInstance().getData().locale;
        // 设置值没变也可能需要应用：以 --language 启动时运行时覆盖会盖住设置，
        // 此时用户选的正是当前设置值，不处理的话界面不会跟着变
        const needsApply = newLocale !== previousLocale || getRuntimeLocale() !== null;
        // 与 /language 共用同一实现：写设置 -> 清运行时覆盖 -> 重刷界面文案
        const result = needsApply ? applyLanguageSetting(this.openDeskTUI, newLocale) : 'ok';
        this.close();
        if (result === 'save-failed') {
            // 保存失败时界面仍停在原语言，必须说清楚，而不是静默关闭
            const info = new InfoOverlay(this.openDeskTUI, {
                title: t('language.save.failed'),
                message: t('language.save.failed.hint'),
                closeLabel: t('common.close'),
                allowDuringConfig: true
            });
            info.show();
        }
    }

    invalidate() {}

    render(width: number): string[] {
        if (!this.form) return [];
        return this.form.render(width);
    }
}
