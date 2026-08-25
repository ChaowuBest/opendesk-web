import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { PluginAgent } from '../../../main/applications/pluginmgr/runtime/agent.js';
import type { AgentDefinition } from '../../../main/aikernel/types/agent.js';
import type { TaskContext } from '../../../main/aikernel/agents/common.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

let tmpDir = '';
let configDir = '';

function mockTaskContext(workspace: string): TaskContext {
    return {
        task_id: 'test-task-id',
        task_name: 'test task',
        getWorkspace: () => workspace
    };
}

test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-agent-test-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-agent-config-'));
    setCustomOpendeskDirectory(configDir);
});

test.after(() => {
    setCustomOpendeskDirectory(undefined);
    for (const dir of [tmpDir, configDir]) {
        if (dir && fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test.afterEach(async () => {
    await AgentRegistry.unloadApplicationAgents();
    await AgentRegistry.unloadPluginAgents();
});

function makeDefinition(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
        name,
        whenToUse: `When ${name} is needed.`,
        body: `You are ${name}.`,
        ...overrides
    };
}

// ─── PluginAgent ─────────────────────────────────────────────

test('PluginAgent 未绑定作用域前不产生完整 id', () => {
    const agent = new PluginAgent(makeDefinition('reviewer', { dispatchable: false }));

    assert.equal(agent.agentType, 'custom');
    assert.equal(agent.agentName, 'reviewer');
    assert.equal(agent.whenToUse, 'When reviewer is needed.');
    assert.equal(agent.dispatchable, false);
    assert.equal(agent.getDefaultMode().id, 'default');
});

test('PluginAgent dispatchable 缺省为 true 且 system prompt 包含 agents.md 正文', async () => {
    const agent = new PluginAgent(makeDefinition('helper'));

    assert.equal(agent.dispatchable, true);

    const prompt = await agent.createSystemPrompt(undefined, mockTaskContext(tmpDir));
    assert.match(prompt, /You are helper\./);
    assert.match(prompt, /当前日期/);
    // 可调度的插件 agent 是子任务执行者，必须携带提交结果提示
    assert.match(prompt, /planning-attemptCompletion/);
});

// ─── AgentRegistry 集成 ──────────────────────────────────────

test('replacePluginAgents 以插件 id 为作用域注册并可通过完整 id 查询', async () => {
    const first = new PluginAgent(makeDefinition('worker'));
    const second = new PluginAgent(makeDefinition('planner', { dispatchable: false }));

    await AgentRegistry.replacePluginAgents([
        { bundleName: 'team-plugin', agents: [first, second] },
        { bundleName: 'other-plugin', agents: [new PluginAgent(makeDefinition('worker'))] }
    ]);

    assert.equal(AgentRegistry.getAgent('team-plugin:worker'), first);
    assert.equal(AgentRegistry.getAgent('other-plugin:worker')?.agentId, 'other-plugin:worker');
    assert.equal(AgentRegistry.getAgent('team-plugin:planner'), second);
    // 与应用 Agent 查询接口互通
    assert.equal(AgentRegistry.getApplicationAgent('team-plugin', 'worker'), first);
});

test('同一插件内重名的 agent 被跳过，不同插件的 agent 不受影响', async () => {
    const keep = new PluginAgent(makeDefinition('unique'));
    const droppedFirst = new PluginAgent(makeDefinition('clash'));
    const droppedSecond = new PluginAgent(makeDefinition('clash'));

    await AgentRegistry.replacePluginAgents([
        { bundleName: 'dup-plugin', agents: [keep, droppedFirst] },
        { bundleName: 'dup-plugin', agents: [droppedSecond] }
    ]);

    assert.equal(AgentRegistry.getAgent('dup-plugin:unique'), keep);
    assert.equal(AgentRegistry.getAgent('dup-plugin:clash'), droppedFirst);
    assert.notEqual(AgentRegistry.getAgent('dup-plugin:clash'), droppedSecond);
    const ids = AgentRegistry.getAgents().map((agent) => agent.agentId);
    assert.equal(ids.filter((id) => id === 'dup-plugin:clash').length, 1);
});

test('unloadPluginAgents 只清理插件 agent，不影响内置与应用 agent', async () => {
    class StubAgent extends (await import('../../../main/aikernel/agents/common.js')).AgentDecl {
        readonly agentName = 'app-worker';
        readonly agentType = 'custom' as const;
        readonly whenToUse = 'App agent.';
        readonly dispatchable = true;
        supportedModes() {
            return [
                {
                    id: 'default',
                    name: 'default',
                    description: 'default',
                    icon: '',
                    color: '',
                    permissionFactory: () => []
                }
            ];
        }
        protected defaultModeId(): string {
            return 'default';
        }
        async createSystemPrompt() {
            return '';
        }
    }

    const appAgent = new StubAgent();
    const pluginAgent = new PluginAgent(makeDefinition('plugin-only'));
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'sample.app', agents: [appAgent] }]);
    await AgentRegistry.replacePluginAgents([{ bundleName: 'sample-plugin', agents: [pluginAgent] }]);

    await AgentRegistry.unloadPluginAgents();

    assert.equal(AgentRegistry.getAgent('sample.app:app-worker'), appAgent);
    assert.equal(AgentRegistry.getAgent('sample-plugin:plugin-only'), undefined);

    // 再次注册后卸载应用 agent，插件 agent 同样不受影响
    const again = new PluginAgent(makeDefinition('plugin-only'));
    await AgentRegistry.replacePluginAgents([{ bundleName: 'sample-plugin', agents: [again] }]);
    await AgentRegistry.unloadApplicationAgents();
    assert.equal(AgentRegistry.getAgent('sample-plugin:plugin-only'), again);
    assert.equal(again.agentId, 'sample-plugin:plugin-only');
});

test('dispatchable 的插件 agent 出现在可调度列表中', async () => {
    const dispatchable = new PluginAgent(makeDefinition('scout'));
    const hidden = new PluginAgent(makeDefinition('ghost', { dispatchable: false }));
    await AgentRegistry.replacePluginAgents([{ bundleName: 'frontier', agents: [dispatchable, hidden] }]);

    const frontmatter = AgentRegistry.getAgentFrontmatterXml();
    assert.match(frontmatter, /name="frontier:scout"/);
    assert.doesNotMatch(frontmatter, /frontier:ghost/);
});
