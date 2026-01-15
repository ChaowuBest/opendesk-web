import { BaseService } from "../../base.js";
import path from 'path';


const __dirname = import.meta.dirname;

class CalendarService extends BaseService {

    constructor() {
        super();
    }

    static getWorkerPath() {
        return path.join(__dirname, 'worker.js');
    }

    static async getCalendarItems(dateString) {
        return await this.sendMessage('getCalendarItems', dateString);
    }

}

export { CalendarService };