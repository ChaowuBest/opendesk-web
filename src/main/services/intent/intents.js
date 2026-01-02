import { z } from 'zod';


class Intent {
    /**
     * @param {string} name
     * @param {string} description
     * @param {z.ZodSchema} params
     */
    constructor(name, description, params) {
        /** @type {string} */
        this.name = name;
        /** @type {string} */
        this.description = description;
        /** @type {z.ZodSchema} */
        this.params = params;
    }
}


class IntentRegistry {

    /** @type {IntentRegistry | null} */
    static instance = null;

    constructor() {
        if (IntentRegistry.instance !== null) {
            throw new Error('IntentRegistry already initialized');
        }

        /** @type {Intent[]} */
        this.intents = [];
    }

    /**
     * Get the unique intent registry instance
     * @returns {IntentRegistry}
     */
    static getInstance() {
        if (IntentRegistry.instance === null) {
            IntentRegistry.instance = new IntentRegistry();
        }
        return IntentRegistry.instance;
    }

    /**
     * @param {Intent} intent
     */
    registerIntent(intent) {
        this.intents.push(intent);
    }

    /**
     * Get all intents
     * @returns {Intent[]}
     */
    getIntents() {
        return this.intents;
    }
}

const globalInstance = IntentRegistry.getInstance();

globalInstance.registerIntent(new Intent(
    "添加待办事项",
    "当识别到屏幕上能够体现出用户需要处理的通知、事务或者流量耗尽，" +
    "提醒充值等能够推断出用户后续需要进行某些操作的时候，可以触发" +
    "待办事项操作",
    z.object({
        title: z.string().describe("待办事项的标题"),
        description: z.string().describe("待办事项的描述"),
        due_date: z.string().describe("待办事项的截止日期, 格式为YYYY-MM-DD"),
        priority: z.enum(['low', 'medium', 'high']).describe("待办事项的优先级"),
    })
))

globalInstance.registerIntent(new Intent(
    "记一笔帐",
    "当识别到屏幕上有与财务相关的信息，比如购物订单、发票、收据等内容时，可以触发记账操作。" +
    "但如果是账单，还款通知等汇总信息而非具体支出等情况，不应触发本意图",
    z.object({
        amount: z.number().describe("支出的金额"),
        description: z.string().describe("支出的描述"),
        currency: z.enum(['CNY', 'USD', 'EUR']).describe("支出的货币类型，比如人民币、美元、欧元等"),
        date: z.string().describe("支出的日期, 格式为YYYY-MM-DD"),
    })
))

export { Intent, IntentRegistry };