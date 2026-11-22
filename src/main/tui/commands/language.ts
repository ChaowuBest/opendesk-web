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

import type { AutocompleteItem, Component } from '@earendil-works/pi-tui';
import { Box, Text } from '@earendil-works/pi-tui';
import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { SelectTable, type SelectRow } from '../components/selecttable.js';
import { defaultSelectListTheme, getOverlayColors } from '../theme.js';
import chalk from 'chalk';
import { getLocale, getLocaleSetting, t } from '../../../locale/index.js';
import { getLocalePackStore } from '../../../locale/packs.js';
import { applyLanguageSetting } from '../localeSwitch.js';
import {
    formatLocaleDisplayName,
    isBuiltinLocaleTag,
    normalizeLocaleTag,
    orderLocaleOptions
} from '../../../common/locale/pack.js';

const AUTO_LOCALE = 'auto';

/** 可切换语言：auto（跟随系统）+ 内置语言与语言包注册的语言 */
function listSelectableLocales(): string[] {
    return [AUTO_LOCALE, ...orderLocaleOptions(getLocalePackStore().getAvailableLocales())];
}

function formatLocaleLabel(tag: string): string {
    if (tag === AUTO_LOCALE) return t('config.language.option.auto');
    return isBuiltinLocaleTag(tag) ? t(`config.language.option.${tag}`) : formatLocaleDisplayName(tag);
}

/**
 * 解析命令参数为可用语言。
 * 接受 auto、大小写/分隔符不敏感的语言 tag（zh-cn、zh_CN -> zh-CN）。
 * 只写主语言（en -> en-US）时按主语言就近匹配；带区域/书写系统的 tag（zh-Hant）不做就近匹配，
 * 否则用户会以为切的是繁体，实际被静默换成了 zh-CN。
 */
function resolveLocaleArgument(arg: string): string | undefined {
    const trimmed = arg.trim();
    if (!trimmed) return undefined;
    if (trimmed.toLowerCase() === AUTO_LOCALE) return AUTO_LOCALE;

    const available = getLocalePackStore().getAvailableLocales();
    const normalized = normalizeLocaleTag(trimmed);
    if (!normalized) return undefined;

    const exact = available.find((tag) => tag.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;

    // 带 '-' 说明用户显式指定了区域/书写系统，就近匹配会误导
    if (normalized.includes('-')) return undefined;

    return available.find((tag) => tag.toLowerCase().split('-')[0] === normalized);
}

/** 未知/不可用语言提示：给出可用语言与用法 */
function showUnknownLocale(tui: OpenDeskTUI, requested: string): void {
    const info = new InfoOverlay(tui, {
        title: t('language.not.found') + requested,
        message: `${t('language.available')}: ${listSelectableLocales().join(', ')}\n\n${chalk.gray(t('language.usage'))}`,
        closeLabel: t('common.close')
    });
    info.show();
}

/** 切换成功提示：命令行与选择器两条路径共用，避免行为不一致 */
function showSwitchedNotice(tui: OpenDeskTUI, target: string): void {
    const resolved = getLocale();
    const detail = target === AUTO_LOCALE ? `${target} (${resolved})` : target;
    const info = new InfoOverlay(tui, {
        title: t('language.switched'),
        message: detail,
        closeLabel: t('common.close')
    });
    info.show();
}

/** 设置写盘失败提示：界面仍停留在原语言，必须说清楚而不是假装切换成功 */
function showSaveFailed(tui: OpenDeskTUI): void {
    const info = new InfoOverlay(tui, {
        title: t('language.save.failed'),
        message: t('language.save.failed.hint'),
        closeLabel: t('common.close')
    });
    info.show();
}

class LanguageSelectOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private table: SelectTable;

    constructor(openDeskTUI: OpenDeskTUI, locales: string[], currentSetting: string) {
        this.openDeskTUI = openDeskTUI;

        const maxVisibleRows = Math.max(5, Math.min(20, openDeskTUI.tui.terminal.rows - 8));
        // 设置值可能是手改过的大小写（zh-cn），标记当前项时不能只做严格比较
        const current = (currentSetting ?? '').toLowerCase();
        const rows: SelectRow[] = locales.map((tag) => ({
            labels: [
                tag.toLowerCase() === current
                    ? chalk.green('● ' + formatLocaleLabel(tag))
                    : '  ' + formatLocaleLabel(tag),
                chalk.gray(tag)
            ],
            value: tag
        }));

        this.table = new SelectTable(rows, maxVisibleRows, defaultSelectListTheme);
        this.table.setColumnStrechFactors([1, 0]);
        this.table.columnSeparator = '  ';

        this.table.onSelect = (tag) => {
            this.close();
            // 选择器里的语言都来自可用集合，失败只可能是设置落盘失败
            const result = applyLanguageSetting(this.openDeskTUI, tag);
            if (result === 'ok') showSwitchedNotice(this.openDeskTUI, tag);
            else if (result === 'save-failed') showSaveFailed(this.openDeskTUI);
        };
        this.table.onCancel = () => {
            this.close();
        };

        const header = new Text(chalk.bold(`ℹ️ ${t('language.description')}`));
        this.box = new Box(1, 1);
        const oc = getOverlayColors();
        this.box.setBgFn((text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text));
        this.box.addChild(header);
        this.box.addChild(this.table);
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    handleInput(keyData: string): void {
        this.table.handleInput(keyData);
        this.openDeskTUI.tui.requestRender();
    }

    show() {
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
            return;
        }

        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this);
    }

    private close() {
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }
}

export function registerLanguageCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'language',
        description: t('language.description'),

        getArgumentCompletions: (argPrefix: string): AutocompleteItem[] | null => {
            const prefix = argPrefix.trim().toLowerCase();
            const current = (getLocaleSetting() ?? '').toLowerCase();
            const items = listSelectableLocales()
                .filter((tag) => tag.toLowerCase().startsWith(prefix))
                .map((tag) => ({
                    value: tag,
                    label: tag,
                    description:
                        formatLocaleLabel(tag) + (tag.toLowerCase() === current ? ` (${t('language.current')})` : '')
                }));
            return items.length > 0 ? items : null;
        },

        execute: async (args: string) => {
            const requested = args.trim();

            // 无参数时显示语言选择列表
            if (!requested) {
                new LanguageSelectOverlay(tui, listSelectableLocales(), getLocaleSetting()).show();
                return;
            }

            const target = resolveLocaleArgument(requested);
            if (!target) {
                showUnknownLocale(tui, requested);
                return;
            }

            // 应用失败时不能提示「已切换」，否则界面和设置会各说一套
            const result = applyLanguageSetting(tui, target);
            if (result === 'invalid') {
                showUnknownLocale(tui, requested);
                return;
            }
            if (result === 'save-failed') {
                showSaveFailed(tui);
                return;
            }
            if (tui.isInputBlocked()) return;

            showSwitchedNotice(tui, target);
        }
    });
}
