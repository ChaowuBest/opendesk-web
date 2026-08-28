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

export type OutputDurationTranslator = (key: string, params?: Record<string, string | number>) => string;

export function formatOutputElapsed(seconds: number | undefined, translate: OutputDurationTranslator): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';

    const totalSeconds = Math.max(0, Math.round(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    if (hours > 0 && minutes > 0 && remainingSeconds > 0) {
        return translate('output.duration.elapsed.hoursMinutesSeconds', {
            hours,
            minutes,
            seconds: remainingSeconds
        });
    }
    if (hours > 0 && minutes > 0) {
        return translate('output.duration.elapsed.hoursMinutes', { hours, minutes });
    }
    if (hours > 0 && remainingSeconds > 0) {
        return translate('output.duration.elapsed.hoursSeconds', { hours, seconds: remainingSeconds });
    }
    if (hours > 0) {
        return translate('output.duration.elapsed.hours', { hours });
    }
    if (minutes > 0 && remainingSeconds > 0) {
        return translate('output.duration.elapsed.minutesSeconds', {
            minutes,
            seconds: remainingSeconds
        });
    }
    if (minutes > 0) {
        return translate('output.duration.elapsed.minutes', { minutes });
    }
    return translate('output.duration.elapsed.seconds', { seconds: remainingSeconds });
}
