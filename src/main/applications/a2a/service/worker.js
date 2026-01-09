import { BaseWorker } from "../../base.js";
import { A2ARegistryClient } from "./client.js";

// 硬编码的服务器地址
const GATEWAY_URL = "http://1.92.70.52:8080";

class A2AWorker extends BaseWorker {
    constructor() {
        super();
        this.client = new A2ARegistryClient(GATEWAY_URL);
    }

    async initialize() {
        await super.initialize();
    }

    async startService() {
        // 服务启动逻辑（如果需要）
    }

    async stopService() {
        // 服务停止逻辑（如果需要）
    }

    async listAgents(options = {}) {
        try {
            const result = await this.client.listAgents(options);
            return result;
        } catch (error) {
            throw new Error(`Failed to list agents: ${error.message}`);
        }
    }
}

const worker = new A2AWorker();
worker.initialize();
