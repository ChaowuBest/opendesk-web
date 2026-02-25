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
        matchCronField(minute, date.getMinutes(), 0, 59) &&
        matchCronField(hour, date.getHours(), 0, 23) &&
        matchCronField(dayOfMonth, date.getDate(), 1, 31) &&
        matchCronField(month, date.getMonth() + 1, 1, 12) &&
        matchCronField(dayOfWeek, date.getDay(), 0, 7)  // 0 和 7 都代表周日
    );
}

/**
 * 格式化 cron 表达式为人类可读描述
 */
export function describeCron(cronExpression: string): string {
    const fields = cronExpression.trim().split(/\s+/);
    if (fields.length !== 5) return cronExpression;

    const [minute, hour, dom, month, dow] = fields;
    const parts: string[] = [];

    if (dow !== '*') {
        const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
        if (dow.includes('-')) {
            const [s, e] = dow.split('-').map(Number);
            parts.push(`周${dayNames[s] || s}-${dayNames[e] || e}`);
        } else if (dow.includes(',')) {
            const days = dow.split(',').map(d => `周${dayNames[parseInt(d)] || d}`);
            parts.push(days.join('/'));
        } else {
            parts.push(`每周${dayNames[parseInt(dow)] || dow}`);
        }
    }

    if (dom !== '*') parts.push(`每月${dom}日`);
    if (month !== '*') parts.push(`${month}月`);

    if (hour !== '*' && minute !== '*') {
        parts.push(`${hour}:${minute.padStart(2, '0')}`);
    } else if (hour !== '*') {
        parts.push(`${hour}时`);
    } else if (minute !== '*') {
        parts.push(`每小时第${minute}分`);
    }

    return parts.length > 0 ? parts.join(' ') : '每分钟';
}
