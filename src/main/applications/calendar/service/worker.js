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

import { BaseWorker } from '../../base';
import { logger } from '../../../utils/logger.js';
import { OutlookUtils } from '../../../utils/outlook.js';
import { CalendarItemSchema } from '../common.js';
import { NotificationManager } from '../../../utils/notificationmgr.js';
import { t } from '../locale/index.js';
import nedb from 'nedb-promises';
import path from 'path';
import fs from 'fs';
import PQueue from 'p-queue';

/** @type {PQueue} */
const task_queue = new PQueue({ concurrency: 1 });

/** 提醒阈值（毫秒） */
const REMINDER_15_MIN = 15 * 60 * 1000;
/** 提醒检查间隔：每5分钟检查一次 */
const REMINDER_CHECK_INTERVAL = 5 * 60 * 1000;

class CalendarWorker extends BaseWorker {
    constructor(bundleName, appDataDirectory) {
        super(bundleName, appDataDirectory);
        this.db = new nedb({ filename: path.join(this.appDataDirectory, 'calendar.db') });
        /** @type {NodeJS.Timeout | null} */
        this._interval = null;
        /** @type {NodeJS.Timeout | null} */
        this._reminderInterval = null;
        /**
         * 已发送提醒的记录，key 为 `${uid}_${threshold}`，避免重复提醒
         * @type {Set<string>}
         */
        this._notifiedSet = new Set();
    }

    async loadDatabase() {
        await this.db
            .load()
            .catch((err) => {
                logger.error(`error loading calendar.db: ${err}`);
                fs.rmSync(path.join(this.appDataDirectory, 'calendar.db'));
                this.db = new nedb({ filename: path.join(this.appDataDirectory, 'calendar.db') });
            })
            .finally(() => {
                this.db.ensureIndex({ fieldName: 'uid', unique: true });
            });
    }

    async loadOutlookCalendarItems() {
        let items = await OutlookUtils.getOutlookCalendarItems(-7, 7);
        if (!Array.isArray(items)) {
            items = [items];
        }
        const validatedItems = items.map((item) =>
            CalendarItemSchema.parse({
                uid: item.entryID,
                subject: item.subject,
                startTime: Date.parse(item.startTime.replace(' ', 'T')),
                endTime: Date.parse(item.endTime.replace(' ', 'T')),
                location: item.location,
                isAllDay: item.isAllDay ?? false,
                isCancelled: item.isCancelled ?? false
            })
        );

        for (const item of validatedItems) {
            await this.db.update({ uid: item.uid }, { $set: item }, { upsert: true }).catch((err) => {
                logger.error(`error saving outlook calendar item: ${item.uid}: ${err}`);
            });
        }
        logger.info(`loaded ${validatedItems.length} outlook calendar items to database`);
    }

    /**
     *
     * @param {string} dateString YYYY-MM-DD
     * @returns {Promise<z.output<CalendarItemSchema>[]>}
     */
    async getCalendarItems(dateString) {
        /* dateString是本地时间，如果用-作为连字符，会被当做UTC时间处理，所以需要替换为/ */
        const dayTimestamp = new Date(dateString.replace(/-/g, '/')).getTime();
        const items = await this.db
            .find({
                startTime: { $gte: dayTimestamp, $lte: dayTimestamp + 86400000 }
            })
            .sort({ startTime: 1 });

        const result = items.map((item) => CalendarItemSchema.parse(item));
        return result;
    }

    /**
     * @param {number} startTimestamp
     * @param {number} endTimestamp
     * @returns {Promise<z.output<CalendarItemSchema>[]>}
     */
    async getCalendarItemsInRange(startTimestamp, endTimestamp) {
        const items = await this.db
            .find({
                startTime: { $gte: startTimestamp, $lte: endTimestamp }
            })
            .sort({ startTime: 1 });
        return items.map((item) => CalendarItemSchema.parse(item));
    }

    /**
     * @param {string} uid
     * @param {object} updates
     * @returns {Promise<z.output<CalendarItemSchema>>}
     */
    async updateCalendarItem(uid, updates) {
        const existing = await this.db.findOne({ uid });
        if (!existing) {
            throw new Error(`未找到 uid 为 "${uid}" 的日程项`);
        }
        const allowedFields = ['subject', 'startTime', 'endTime', 'location', 'isAllDay', 'type'];
        const updateData = {};
        for (const field of allowedFields) {
            if (updates[field] !== undefined) updateData[field] = updates[field];
        }
        await this.db.update({ uid }, { $set: updateData });
        const updated = await this.db.findOne({ uid });
        const item = CalendarItemSchema.parse(updated);
        await this.emitEvent('calendarItemsChanged');
        return item;
    }

    /**
     * @param {object} item
     * @param {string} item.subject
     * @param {number} item.startTime
     * @param {number} item.endTime
     * @param {string} [item.location]
     * @param {boolean} [item.isAllDay]
     * @returns {Promise<z.output<CalendarItemSchema>>}
     */
    async addCalendarItem(item) {
        const doc = CalendarItemSchema.parse({
            uid: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            subject: item.subject,
            startTime: item.startTime,
            endTime: item.endTime,
            location: item.location || '',
            isAllDay: item.isAllDay ?? false,
            isCancelled: false,
            type: item.type || ''
        });
        await this.db.insert(doc);
        logger.info(`added calendar item: ${doc.uid} - ${doc.subject}`);
        await this.emitEvent('calendarItemsChanged');
        return doc;
    }

    /**
     * @param {string} uid
     * @returns {Promise<{deleted: boolean, uid: string}>}
     */
    async deleteCalendarItem(uid) {
        const numRemoved = await this.db.remove({ uid }, {});
        if (numRemoved === 0) {
            throw new Error(`未找到 uid 为 "${uid}" 的日程项`);
        }
        logger.info(`deleted calendar item: ${uid}`);
        await this.emitEvent('calendarItemsChanged');
        return { deleted: true, uid };
    }

    // ──────────────────── 日程提醒 ────────────────────

    /**
     * 查询即将到来的日程（未来 20 分钟内开始、尚未取消的日程）
     * @returns {Promise<Array>}
     */
    async getUpcomingItems() {
        const now = Date.now();
        const windowEnd = now + 16 * 60 * 1000; // 16 分钟窗口（覆盖 15 分钟提醒）

        const items = await this.db
            .find({
                startTime: { $gte: now, $lte: windowEnd },
                isCancelled: { $ne: true },
                isAllDay: { $ne: true } // 全天日程不需要精确提醒
            })
            .sort({ startTime: 1 });

        return items.map((item) => CalendarItemSchema.parse(item));
    }

    /**
     * 检查即将到来的日程并发送提醒通知。
     * - 提前 15 分钟：发送 warning 级别的预提醒
     * 使用 _notifiedSet 避免重复发送同一日程的同一阈值提醒。
     */
    async checkAndNotifyUpcoming() {
        try {
            const items = await this.getUpcomingItems();
            const now = Date.now();
            const notifier = NotificationManager.getInstance();

            for (const item of items) {
                const diff = item.startTime - now; // 距离开始还有多少毫秒

                // 15 分钟提醒（warning）
                if (diff <= REMINDER_15_MIN && diff > 0) {
                    const key = `${item.uid}_15min`;
                    if (!this._notifiedSet.has(key)) {
                        this._notifiedSet.add(key);
                        const minutesLeft = Math.ceil(diff / 60000);
                        const timeStr = this._formatTime(item.startTime);
                        notifier.sendNotification(
                            'warning',
                            t('app.name'),
                            `📅 ${item.subject}`,
                            `${t('notification.upcoming.body', { minutes: minutesLeft, time: timeStr })}${
                                item.location ? ' 📍' + item.location : ''
                            }`
                        );
                        logger.info(`[calendar-reminder] sent 15-min warning reminder: ${item.uid} - ${item.subject}`);
                    }
                }
            }

            // 定期清理过期的提醒记录（已经开始超过 30 分钟的日程）
            this._cleanupNotifiedSet();
        } catch (err) {
            logger.error(`[calendar-reminder] check failed: ${err}`);
        }
    }

    /**
     * 格式化时间戳为 HH:mm 格式
     * @param {number} timestamp
     * @returns {string}
     */
    _formatTime(timestamp) {
        const d = new Date(timestamp);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    /**
     * 清理过期的提醒记录，避免 _notifiedSet 无限增长。
     * 查询数据库中已过期的 uid，从 set 中移除对应记录。
     */
    async _cleanupNotifiedSet() {
        if (this._notifiedSet.size === 0) return;

        const now = Date.now();
        const cutoff = now - 30 * 60 * 1000; // 开始时间超过 30 分钟前的算过期

        // 提取 set 中所有 uid
        const uidSet = new Set();
        for (const key of this._notifiedSet) {
            const uid = key.replace(/_15min$/, '');
            uidSet.add(uid);
        }

        // 查询这些 uid 中已过期的
        const uids = [...uidSet];
        for (const uid of uids) {
            try {
                const doc = await this.db.findOne({ uid });
                if (!doc || doc.startTime < cutoff) {
                    // 日程已过期或已删除，清理提醒记录
                    this._notifiedSet.delete(`${uid}_15min`);
                }
            } catch {
                // ignore
            }
        }
    }

    /**
     * 启动日程提醒定时检查器
     */
    _startReminderChecker() {
        // 首次延迟 5 秒执行，等数据库加载完毕
        setTimeout(() => {
            this.checkAndNotifyUpcoming();
        }, 5000);

        this._reminderInterval = setInterval(() => {
            this.checkAndNotifyUpcoming();
        }, REMINDER_CHECK_INTERVAL);

        logger.info('[calendar-reminder] reminder checker started, interval: 30s');
    }

    /**
     * 停止日程提醒定时检查器
     */
    _stopReminderChecker() {
        if (this._reminderInterval) {
            clearInterval(this._reminderInterval);
            this._reminderInterval = null;
            logger.info('[calendar-reminder] reminder checker stopped');
        }
    }

    // ──────────────────── 生命周期 ────────────────────

    async initialize() {
        await this.loadDatabase();
        const syncImmediately = async () => {
            task_queue.add(async () => {
                if (this.config?.dataSources?.outlook?.enabled) {
                    await this.loadOutlookCalendarItems().catch((err) => {
                        logger.error(`error loading outlook calendar items: ${err}`);
                    });
                }
            });
        };

        await syncImmediately();
        this._interval = setInterval(syncImmediately, 1000 * 60 * 2);

        // 启动日程提醒检查器
        this._startReminderChecker();
    }

    async finalize() {
        // 停止同步定时器
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
        // 停止提醒检查器
        this._stopReminderChecker();
    }
}

export default CalendarWorker;
