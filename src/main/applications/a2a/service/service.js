import { BaseService } from "../../base.js";
import path from 'path';

const __dirname = import.meta.dirname;

class A2AService extends BaseService {

    constructor() {
        super();
    }

    static getWorkerPath() {
        return path.join(__dirname, 'worker.js');
    }

    static async listAgents(options = {}) {
        return await this.sendMessage('listAgents', options);
    }
}

export { A2AService };
