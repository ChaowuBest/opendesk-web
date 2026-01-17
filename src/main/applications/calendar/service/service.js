import { BaseService } from "../../base.js";
import { CalendarItemSchema } from "../common.js";
import path from 'path';


const __dirname = import.meta.dirname;

class CalendarService extends BaseService {

    constructor() {
        super();
    }

    static getWorkerPath() {
        return path.join(__dirname, 'worker.js');
    }

    /**
     * Get the calendar items for a given date
     * @param {string} dateString YYYY-MM-DD
     * @returns {Promise<z.output<CalendarItemSchema>[]>}
     */
    static async getCalendarItems(dateString) {
        return await this.sendMessage('getCalendarItems', dateString);
    }

}

export { CalendarService };