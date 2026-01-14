import { BaseService } from "../../base.js";
import path from 'path';

const __dirname = import.meta.dirname;


class SynchronizationService extends BaseService {

    constructor() {
        super();
    }

    static getWorkerPath() {
        return path.join(__dirname, 'worker.js');
    }

    static async getOutlookCalendarItems() {
        return await this.sendMessage('getOutlookCalendarItems', {});
    }

}

export { SynchronizationService };