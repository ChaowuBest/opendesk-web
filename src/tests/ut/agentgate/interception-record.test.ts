/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * AgentGate 内置工具拦截记录 + 异步归因的契约测试。
 *
 * 覆盖 issue：同任务多次拦截时，异步归因必须落在「本次拦截自己那条记录」上，
 * 而不是永远更新第 0 条。记录每个分支的 riskType / securityLevel 字段也必须各自就位。
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 固定 gate 地址，避免 hook 走 9100-9105 端口探测
process.env.AGENT_GATE_URL = 'http://127.0.0.1:19999';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-interception-'));
const skillsDir = path.join(dataRoot, 'apps', 'skills');
const interceptionsDir = path.join(dataRoot, 'apps', 'interceptions');
const taskId = 'task_interception_contract';
const recordsFile = path.join(interceptionsDir, `${taskId}.json`);

const settingData: any = {
    applications: {
        agentgate: { enabled: true, securityLevel: 'high', maliciousSkillDetection: true }
    }
};

type GateResponse = {
    decision: string;
    reason: string;
    risk_level: string;
    risk_type: string;
    violated_layers: string[];
};

/** 每次 analyze 请求返回的响应队列（缺省取最后一个） */
let gateResponses: GateResponse[] = [];
const analyzeRequests: any[] = [];

let registeredHandler: ((ctx: any) => Promise<any>) | null = null;

jest.unstable_mockModule('../../../main/aikernel/hooks.js', () => ({
    GlobalHooks: {
        beforeToolCall: jest.fn((fn: any) => {
            registeredHandler = fn;
        }),
        afterFinishTurn: jest.fn(),
        afterToolcallParse: jest.fn()
    }
}));

jest.unstable_mockModule('../../../main/utils/setting.js', () => {
    class Setting {
        static getInstance() {
            return {
                get data() {
                    return settingData;
                },
                getData: () => settingData,
                setData: (d: any) => Object.assign(settingData, d),
                getApplicationConfig: (name: string) => settingData.applications?.[name],
                getModelInstance: () => undefined
            };
        }
        static clearCache() {}
        static updateInstanceData(d: any) {
            Object.assign(settingData, d);
        }
    }
    return { Setting, getOpendeskDirectory: () => dataRoot };
});

jest.unstable_mockModule('../../../main/applications/skillmgr/utils/skill-registry.js', () => ({
    skillRegistry: {
        getSkillsDirectory: () => skillsDir,
        getSkill: jest.fn(),
        getSkills: jest.fn(() => [])
    }
}));

// LLM 归因返回哪个候选由被测命令决定，便于断言「这次归因落到了这次记录上」
jest.unstable_mockModule('../../../main/applications/agentgate/skillAttribution.js', () => ({
    attributeInterception: jest.fn(async (_toolName: string, command: string) => ({
        candidates: [
            {
                bundleName: 'builtin',
                skillName: command.includes('second') ? 'second-skill' : 'first-skill',
                confidence: 'high',
                evidence: 'e'
            }
        ]
    })),
    attributeBatchInterceptions: jest.fn(),
    confidenceWeight: jest.fn(() => 0),
    sortByConfidenceDesc: jest.fn((arr: any[]) => arr)
}));

jest.unstable_mockModule('../../../main/applications/agentgate/agent-gate-bridge.js', () => ({
    AgentGateBridge: { getInstance: () => ({ getStatus: () => ({ gatePort: 0 }) }) }
}));

jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    getDebugMode: jest.fn(() => false),
    setDebugMode: jest.fn(),
    LogStream: class {}
}));

jest.unstable_mockModule('../../../platforms/bridges/harmonyos/local-runtime.js', () => ({
    getHarmonyLocalRuntimeFeatureAvailability: jest.fn(() => ({ available: true, reason: null, missing: [] }))
}));

jest.unstable_mockModule('../../../main/tui/components/notification.js', () => ({
    NotificationStore: { getInstance: () => ({ push: jest.fn() }) }
}));

const flushAsync = async (ms = 300): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};

const makeTask = () => ({
    task_id: taskId,
    task_name: 'interception-contract',
    getWorkspace: () => dataRoot,
    chat_context: {
        lastUserMessage: () => ({ getPlainText: () => '请帮我处理一下这个脚本' })
    },
    getLoadedSkillsFromContext: () => [{ bundleName: 'builtin', skillName: 'demo-skill' }],
    getTurnGeneration: () => 7
});

const makeToolCall = (command: string) => ({
    tool_name: 'executeBash',
    args_object: { command }
});

describe('AgentGate 拦截记录归因契约', () => {
    let handler: (ctx: any) => Promise<any>;

    beforeAll(async () => {
        const fetchMock = jest.fn(async (url: unknown) => {
            const target = String(url);
            if (target.includes('/api/v1/analyze')) {
                analyzeRequests.push({ url: target });
                const resp = gateResponses.length > 1 ? gateResponses.shift()! : gateResponses[0];
                return { ok: true, status: 200, json: async () => ({ ...resp }) };
            }
            throw new Error(`unexpected fetch: ${target}`);
        });
        (globalThis as any).fetch = fetchMock as any;

        // initAgentGateHook 里有 2s 后推送通知的定时器，用 fake timers 拦掉，避免测试结束后仍持有 handle
        jest.useFakeTimers();
        const { initAgentGateHook } = await import('../../../main/applications/agentgate/hook.js');
        initAgentGateHook();
        jest.useRealTimers();
        handler = registeredHandler!;
        expect(handler).toBeTruthy();
    });

    beforeEach(() => {
        fs.rmSync(interceptionsDir, { recursive: true, force: true });
        analyzeRequests.length = 0;
        settingData.applications.agentgate.securityLevel = 'high';
        gateResponses = [
            {
                decision: 'Deny',
                reason: '恶意技能指令',
                risk_level: 'high',
                risk_type: 'malicious_skill',
                violated_layers: ['L1.1']
            }
        ];
    });

    afterAll(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    const readRecords = (): any[] => {
        if (!fs.existsSync(recordsFile)) return [];
        return JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
    };

    it('同一任务连续两次内置工具拦截：归因各自落在自己的记录上', async () => {
        const first = await handler({ task: makeTask(), toolCall: makeToolCall('bash first.sh') });
        expect(first.operation).toBe('deny');
        await flushAsync();

        const second = await handler({ task: makeTask(), toolCall: makeToolCall('bash second.sh') });
        expect(second.operation).toBe('deny');
        await flushAsync();

        const records = readRecords();
        expect(records).toHaveLength(2);

        // 第一条记录必须保留第一次归因结果，不能被第二次归因覆盖
        expect(records[0].command).toBe('bash first.sh');
        expect(records[0].attributed).toBe(true);
        expect(records[0].suspected.map((s: any) => s.skillName)).toEqual(['first-skill']);

        // 第二条记录必须完成自己的归因
        expect(records[1].command).toBe('bash second.sh');
        expect(records[1].attributed).toBe(true);
        expect(records[1].suspected.map((s: any) => s.skillName)).toEqual(['second-skill']);
    });

    it('内置工具路径写入的记录携带真实 riskType / securityLevel', async () => {
        await handler({ task: makeTask(), toolCall: makeToolCall('bash probe.sh') });
        await flushAsync();

        const [record] = readRecords();
        expect(record.riskType).toBe('malicious_skill');
        expect(record.securityLevel).toBe('high');
        expect(typeof record.recordId).toBe('string');
    });

    it('medium 安全级别下的 low 风险拦截：riskType 与 securityLevel 不串位', async () => {
        settingData.applications.agentgate.securityLevel = 'medium';
        gateResponses = [
            {
                decision: 'Deny',
                reason: '疑似外传凭据',
                risk_level: 'low',
                risk_type: 'sensitive_data',
                violated_layers: ['L2.1']
            }
        ];

        const action = await handler({ task: makeTask(), toolCall: makeToolCall('bash leak.sh') });
        expect(action.operation).toBe('deny');
        await flushAsync();

        const [record] = readRecords();
        expect(record.riskType).toBe('sensitive_data');
        expect(record.securityLevel).toBe('medium');
    });
});
