import { BaseWorker } from "../../base.js";
import { logger } from "../../../utils/logger.js";
import { OutlookUtils } from "../../../utils/outlook.js";
import { CalendarItemSchema } from "../common.js";
import nedb from 'nedb-promises';
import path from 'path';
import fs from 'fs';
import PQueue from 'p-queue';


/** @type {PQueue} */
const task_queue = new PQueue({ concurrency: 1 });

class CalendarWorker extends BaseWorker {

    constructor(appDataDirectory) {
        super('calendar', appDataDirectory);
        this.db = new nedb({ filename: path.join(this.appDataDirectory, 'calendar.db') });
        /** @type {NodeJS.Timeout | null} */
        this._interval = null;
    }

    async loadDatabase() {
        await this.db.load().catch(err => {
            logger.error(`error loading calendar.db: ${err}`);
            fs.rmSync(path.join(this.appDataDirectory, 'calendar.db'));
            this.db = new nedb({ filename: path.join(this.appDataDirectory, 'calendar.db') });
        }).finally(() => {
            this.db.ensureIndex({ fieldName: 'uid', unique: true });
        });
    }

    async loadOutlookCalendarItems() {
        const items = await OutlookUtils.getOutlookCalendarItems(-7, 7);
        const validatedItems = items.map(item => CalendarItemSchema.parse({
            uid: item.entryID,
            subject: item.subject,
            startTime: Date.parse(item.startTime.replace(' ', 'T')),
            endTime: Date.parse(item.endTime.replace(' ', 'T')),
            location: item.location,
            isAllDay: item.isAllDay ?? false,
            isCancelled: item.isCancelled ?? false
        }));

        for (const item of validatedItems) {
            await this.db.update(
                { uid: item.uid },
                { $set: item },
                { upsert: true }
            ).catch(err => {
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
        const items = await this.db.find({
            startTime: { $gte: dayTimestamp, $lte: dayTimestamp + 86400000 },
        }).sort({ startTime: 1 });

        const result = items.map(item => CalendarItemSchema.parse(item));
        return result;
    }

    async initialize() {
        await this.loadDatabase();
        const syncImmediately = async () => {
            task_queue.add(async () => {
                await this.loadOutlookCalendarItems().catch(err => {
                    logger.error(`error loading outlook calendar items: ${err}`);
                });
            });
        };

        await syncImmediately();
        this._interval = setInterval(syncImmediately, 1000 * 60 * 2);
    }

}

export default CalendarWorker;