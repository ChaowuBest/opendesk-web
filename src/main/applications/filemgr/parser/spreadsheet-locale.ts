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

import { addLocale, getLocale as getSpreadsheetLocale, type DayNames, type MonthNames } from 'numfmt';

const localeAliases = new Map<string, string>();

export function resolveSpreadsheetLocale(candidate: string): string {
    let numberFormat: Intl.NumberFormat;
    try {
        numberFormat = new Intl.NumberFormat(candidate);
    } catch {
        return 'en-US';
    }
    const locale = numberFormat.resolvedOptions().locale;
    const parsed = new Intl.Locale(locale);
    if (!parsed.script && parsed.baseName === locale && getSpreadsheetLocale(locale)) return locale;
    const cached = localeAliases.get(locale);
    if (cached) return cached;

    const baseTag = [parsed.language, parsed.region].filter(Boolean).join('-');
    const base =
        getSpreadsheetLocale(baseTag) ?? getSpreadsheetLocale(parsed.language) ?? getSpreadsheetLocale('en-US');
    const parts = numberFormat.formatToParts(12345.6);
    const monthNames = (width: 'short' | 'long') => {
        const formatter = new Intl.DateTimeFormat(locale, { month: width, calendar: 'gregory', timeZone: 'UTC' });
        return Array.from({ length: 12 }, (_, month) =>
            formatter.format(new Date(Date.UTC(2020, month, 15)))
        ) as MonthNames;
    };
    const dayNames = (width: 'short' | 'long') => {
        const formatter = new Intl.DateTimeFormat(locale, { weekday: width, calendar: 'gregory', timeZone: 'UTC' });
        return Array.from({ length: 7 }, (_, day) =>
            formatter.format(new Date(Date.UTC(2020, 5, 7 + day)))
        ) as DayNames;
    };

    // numfmt accepts language-region tags only. Use a private alias per full tag
    // so script-specific names never overwrite the shared base locale data.
    const alias = `qaa-${String(localeAliases.size + 1).padStart(3, '0')}`;
    addLocale(
        {
            ...base,
            decimal: parts.find((part) => part.type === 'decimal')?.value ?? base?.decimal,
            group: parts.find((part) => part.type === 'group')?.value ?? base?.group,
            mmm: monthNames('short'),
            mmmm: monthNames('long'),
            ddd: dayNames('short'),
            dddd: dayNames('long')
        },
        alias
    );
    localeAliases.set(locale, alias);
    return alias;
}
