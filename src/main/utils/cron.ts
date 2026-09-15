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

/**
 * 简单 crontab 表达式匹配器
 * 支持标准5段格式: "分 时 日 月 周"
 *
 * 字段语法:
 *   *      任意值
 *   N      精确值
 *   N-M    范围
 *   N,M,O  列表
 *   *\/N    步长 (每隔N)
 *   N-M/S  范围步长
 */

function matchCronField(field: string, value: number, min: number, max: number): boolean {
    if (field === '*') return true;

    for (const part of field.split(',')) {
        const trimmed = part.trim();
        if (trimmed.includes('/')) {
            const [range, stepStr] = trimmed.split('/');
            const step = parseInt(stepStr, 10);
            if (isNaN(step) || step <= 0) continue;

            let start = min;
            let end = max;
            if (range !== '*') {
                if (range.includes('-')) {
                    const [s, e] = range.split('-').map(Number);
                    if (!isNaN(s)) start = s;
                    if (!isNaN(e)) end = e;
                } else {
                    const v = parseInt(range, 10);
                    if (!isNaN(v)) start = v;
                }
            }
            for (let i = start; i <= end; i += step) {
                if (value === i) return true;
            }
        } else if (trimmed.includes('-')) {
            const [s, e] = trimmed.split('-').map(Number);
            if (!isNaN(s) && !isNaN(e) && value >= s && value <= e) return true;
        } else {
            const v = parseInt(trimmed, 10);
            if (!isNaN(v) && value === v) return true;
        }
    }
    return false;
}

/**
 * 检查给定时间是否匹配 crontab 表达式
 * @param cronExpression 格式: "分 时 日 月 周"
 * @param date 要检查的时间，默认当前时间
 */
export function matchesCron(cronExpression: string, date: Date = new Date()): boolean {
    const fields = cronExpression.trim().split(/\s+/);
    if (fields.length !== 5) return false;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

    return (
        matchCronField(minute, date.getUTCMinutes(), 0, 59) &&
        matchCronField(hour, date.getUTCHours(), 0, 23) &&
        matchCronField(dayOfMonth, date.getUTCDate(), 1, 31) &&
        matchCronField(month, date.getUTCMonth() + 1, 1, 12) &&
        matchCronField(dayOfWeek, date.getUTCDay(), 0, 7) // 0 和 7 都代表周日
    );
}

/**
 * 将 UTC cron 表达式中的简单时/分字段转换为本地时间。
 * 仅当小时和分钟都是单个数值时才做转换；复杂表达式（范围、步长等）原样返回。
 * 返回 { localMinute, localHour, localDow, converted } —— converted 为 true 表示已转换。
 */
function convertCronFieldsToLocal(
    minute: string,
    hour: string,
    dow: string
): { localMinute: string; localHour: string; localDow: string; converted: boolean } {
    if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) {
        return { localMinute: minute, localHour: hour, localDow: dow, converted: false };
    }

    const offsetMin = -new Date().getTimezoneOffset(); // e.g. +480 for UTC+8
    let m = parseInt(minute, 10) + (offsetMin % 60);
    let h = parseInt(hour, 10) + Math.floor(offsetMin / 60);

    if (m >= 60) {
        h += 1;
        m -= 60;
    }
    if (m < 0) {
        h -= 1;
        m += 60;
    }

    let dayShift = 0;
    if (h >= 24) {
        h -= 24;
        dayShift = 1;
    }
    if (h < 0) {
        h += 24;
        dayShift = -1;
    }

    let localDow = dow;
    if (dayShift !== 0 && dow !== '*') {
        const shiftDay = (d: number) => (((d + dayShift) % 7) + 7) % 7;
        if (/^\d+$/.test(dow)) {
            localDow = String(shiftDay(parseInt(dow, 10)));
        } else if (/^\d+-\d+$/.test(dow)) {
            const [s, e] = dow.split('-').map(Number);
            localDow = `${shiftDay(s)}-${shiftDay(e)}`;
        } else if (/^[\d,]+$/.test(dow)) {
            localDow = dow
                .split(',')
                .map((d) => String(shiftDay(parseInt(d, 10))))
                .join(',');
        }
    }

    return { localMinute: String(m), localHour: String(h), localDow, converted: true };
}

/**
 * describeCron 的可注入文案。dowNames 为裸星期名（index 0=周日），
 * 前缀（如中文的"周"）由对应模板词条携带；各模板使用 ${param} 占位。
 */
export interface CronDescribeLabels {
    dowNames: string[];
    everyDowTemplate: string; // '每周${day}' / 'Every ${day}'
    dowTemplate: string; // '周${day}' / '${day}'
    monthlyDomTemplate: string; // '每月${day}日' / 'day ${day} of month'
    monthTemplate: string; // '${month}月' / '${month}'
    hourTemplate: string; // '${hour}时' / 'hour ${hour}'
    minuteTemplate: string; // '每小时第${minute}分' / 'minute ${minute} of every hour'
    everyMinute: string; // '每分钟' / 'every minute'
}

const DEFAULT_CRON_LABELS: CronDescribeLabels = {
    dowNames: ['日', '一', '二', '三', '四', '五', '六'],
    everyDowTemplate: '每周${day}',
    dowTemplate: '周${day}',
    monthlyDomTemplate: '每月${day}日',
    monthTemplate: '${month}月',
    hourTemplate: '${hour}时',
    minuteTemplate: '每小时第${minute}分',
    everyMinute: '每分钟'
};

function fillTemplate(template: string, params: Record<string, string | number>): string {
    let text = template;
    for (const [key, value] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), String(value));
    }
    return text;
}

/**
 * 格式化 cron 表达式为人类可读描述（自动将 UTC 时间转换为本地时间显示）
 * @param labels 可选的多语言文案；不传时使用中文默认文案（TUI dashboard 等沿用）
 */
export function describeCron(cronExpression: string, labels?: CronDescribeLabels): string {
    const l = labels ?? DEFAULT_CRON_LABELS;
    const fields = cronExpression.trim().split(/\s+/);
    if (fields.length !== 5) return cronExpression;

    const [minute, hour, dom, month, dow] = fields;
    const { localMinute, localHour, localDow, converted } = convertCronFieldsToLocal(minute, hour, dow);
    const parts: string[] = [];

    if (localDow !== '*') {
        if (localDow.includes('-')) {
            const [s, e] = localDow.split('-').map(Number);
            const from = fillTemplate(l.dowTemplate, { day: l.dowNames[s] || s });
            const to = fillTemplate(l.dowTemplate, { day: l.dowNames[e] || e });
            parts.push(`${from}-${to}`);
        } else if (localDow.includes(',')) {
            const days = localDow
                .split(',')
                .map((d) => fillTemplate(l.dowTemplate, { day: l.dowNames[parseInt(d)] || d }));
            parts.push(days.join('/'));
        } else {
            parts.push(fillTemplate(l.everyDowTemplate, { day: l.dowNames[parseInt(localDow)] || localDow }));
        }
    }

    if (dom !== '*') parts.push(fillTemplate(l.monthlyDomTemplate, { day: dom }));
    if (month !== '*') parts.push(fillTemplate(l.monthTemplate, { month }));

    if (localHour !== '*' && localMinute !== '*') {
        parts.push(`${localHour}:${localMinute.padStart(2, '0')}`);
    } else if (localHour !== '*') {
        parts.push(fillTemplate(l.hourTemplate, { hour: localHour }));
    } else if (localMinute !== '*') {
        parts.push(fillTemplate(l.minuteTemplate, { minute: localMinute }));
    }

    if (!converted && (hour !== '*' || minute !== '*')) {
        parts.push('(UTC)');
    }

    return parts.length > 0 ? parts.join(' ') : l.everyMinute;
}
