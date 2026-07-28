import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CustomAgent } from '../../../main/applications/agentoffice/custom-agent.js';
import { AgentOfficeApplication } from '../../../main/applications/agentoffice/app.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import type { TaskContext } from '../../../main/aikernel/agents/common.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { AgentsMdManager } from '../../../main/aikernel/agents_md.js';
import { SkillRegistry } from '../../../main/aikernel/skill.js';

let tmpDir = '';
let configDir = '';

function mockTaskContext(workspace: string): TaskContext {
    return {
        task_id: 'test-task-id',
        task_name: 'test task',
        getWorkspace: () => workspace
    };
}

function writeAgentConfig(
    dir: string,
    opts: {
        agentJson?: object;
        agentsMd?: string;
        mcpJson?: object;
        skills?: Record<string, string>;
    }
): void {
    fs.mkdirSync(dir, { recursive: true });
    if (opts.agentJson !== undefined) {
        fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(opts.agentJson));
    }
    if (opts.agentsMd !== undefined) {
        fs.writeFileSync(path.join(dir, 'agents.md'), opts.agentsMd);
    }
    if (opts.mcpJson !== undefined) {
        fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(opts.mcpJson));
    }
    if (opts.skills) {
        for (const [skillName, skillMd] of Object.entries(opts.skills)) {
            const skillDir = path.join(dir, 'skills', skillName);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd);
        }
    }
}

async function loadAgentsThroughAgentOffice(): Promise<{
    agents: CustomAgent[];
    registrations: Array<{ agentId: string; config: unknown }>;
}> {
    const registrations: Array<{ agentId: string; config: unknown }> = [];
    const application = new AgentOfficeApplication();
    application.setRegistry({
        getApplication: (bundleName: string) =>
            bundleName === 'mcpmgr'
                ? {
                      replaceAgentServers: async (next: Array<{ agentId: string; config: unknown }>) => {
                          registrations.push(...next);
                      }
                  }
                : undefined
    });
    const agents = (await application.getAgents()) as CustomAgent[];
    await AgentRegistry.replaceCustomAgents(agents);
    return { agents, registrations };
}

const VALID_AGENT_JSON = { name: 'test-agent', when_to_use: 'A test agent.' };
const VALID_AGENTS_MD = '# Test Agent\n\nYou are a test agent.';
const VALID_SKILL_MD = `---
name: my-skill
description: A test skill for unit testing.
---
# My Skill

This skill does something useful.`;

test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-agent-test-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-agent-config-'));
    setCustomOpendeskDirectory(configDir);
    AgentsMdManager.getInstance().reloadForUser();
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
    // 清理 AgentRegistry 中的残留 custom agent
    await AgentRegistry.unloadCustomAgents();
    // 清理 configDir/agents 目录，确保测试间无状态泄漏
    const agentsDir = path.join(configDir, 'agents');
    if (fs.existsSync(agentsDir)) {
        fs.rmSync(agentsDir, { recursive: true, force: true });
    }
});

// ─── 基础加载测试 ─────────────────────────────────────────────

test('loadFromPath: 正常加载含 agent.json 和 agents.md 的目录', async () => {
    const dir = path.join(tmpDir, 'my-agent');
    writeAgentConfig(dir, {
        agentJson: { name: 'my-agent', when_to_use: 'A test agent for unit testing.' },
        agentsMd: '# My Agent\n\nYou are a test agent.'
    });

    const agent = await CustomAgent.loadFromPath(dir);
    assert.equal(agent.agentName, 'my-agent');
    assert.equal(agent.whenToUse, 'A test agent for unit testing.');
    assert.equal(agent.agentType, 'custom');
});

test('loadFromPath: 缺失 agent.json 时从目录名推断', async () => {
    const dir = path.join(tmpDir, 'no-json-agent');
    writeAgentConfig(dir, { agentsMd: '# Code Reviewer\n\nYou review code.' });

    const agent = await CustomAgent.loadFromPath(dir);
    assert.equal(agent.agentName, 'no-json-agent');
    assert.equal(agent.whenToUse, 'Code Reviewer');

    await agent.dispose();
});

test('loadFromPath: 缺失 agents.md 时抛出错误', async () => {
    const dir = path.join(tmpDir, 'no-md');
    writeAgentConfig(dir, {
        agentJson: { name: 'no-md-agent', when_to_use: 'Missing agents.md.' }
    });

    await assert.rejects(() => CustomAgent.loadFromPath(dir), /agents\.md not found/);
});

test('loadFromPath: agent.json 缺少 name 字段时抛出错误', async () => {
    const dir = path.join(tmpDir, 'bad-json');
    writeAgentConfig(dir, {
        agentJson: { when_to_use: 'Missing name.' },
        agentsMd: '# Agent'
    });

    await assert.rejects(() => CustomAgent.loadFromPath(dir), /failed to parse agent\.json/);
});

test('loadFromPath: agent.json 缺少 when_to_use 字段时抛出错误', async () => {
    const dir = path.join(tmpDir, 'bad-json-2');
    writeAgentConfig(dir, {
        agentJson: { name: 'no-when' },
        agentsMd: '# Agent'
    });

    await assert.rejects(() => CustomAgent.loadFromPath(dir), /failed to parse agent\.json/);
});

test('loadFromPath: agents.md 为空文件时抛出错误', async () => {
    const dir = path.join(tmpDir, 'empty-md');
    writeAgentConfig(dir, {
        agentJson: { name: 'empty-md-agent', when_to_use: 'Empty agents.md.' },
        agentsMd: '   \n  \n  '
    });

    await assert.rejects(() => CustomAgent.loadFromPath(dir), /agents\.md is empty/);
});

// ─── Mode 和 Prompt 测试 ──────────────────────────────────────

test('supportedModes: 返回单个 default mode', async () => {
    const dir = path.join(tmpDir, 'mode-test');
    writeAgentConfig(dir, { agentJson: VALID_AGENT_JSON, agentsMd: '# Mode Test' });

    const agent = await CustomAgent.loadFromPath(dir);
    const modes = agent.supportedModes();
    assert.equal(modes.length, 1);
    assert.equal(modes[0].id, 'default');
});

test('defaultModeId: 返回 default', async () => {
    const dir = path.join(tmpDir, 'mode-id-test');
    writeAgentConfig(dir, { agentJson: VALID_AGENT_JSON, agentsMd: '# Mode ID Test' });

    const agent = await CustomAgent.loadFromPath(dir);
    assert.equal(agent.defaultModeId(), 'default');
});

test('createSystemPrompt: 包含 agents.md 内容', async () => {
    const dir = path.join(tmpDir, 'prompt-test');
    writeAgentConfig(dir, {
        agentJson: { name: 'reviewer', when_to_use: 'Code review agent.' },
        agentsMd: '# Code Reviewer\n\n你是一个代码审查专家，专注于发现代码质量问题。'
    });

    const agent = await CustomAgent.loadFromPath(dir);
    const taskCtx = mockTaskContext(tmpDir);
    const prompt = await agent.createSystemPrompt(undefined, taskCtx);

    assert.ok(prompt.includes('代码审查专家'), 'prompt should contain agents.md content');
    assert.ok(prompt.includes('attemptCompletion'), 'prompt should contain attemptCompletion hint');
});

test('createSystemPrompt: 包含环境信息', async () => {
    const dir = path.join(tmpDir, 'env-test');
    writeAgentConfig(dir, { agentJson: VALID_AGENT_JSON, agentsMd: '# Env Test' });

    const agent = await CustomAgent.loadFromPath(dir);
    const taskCtx = mockTaskContext(tmpDir);
    const prompt = await agent.createSystemPrompt(undefined, taskCtx);

    assert.ok(prompt.includes(tmpDir), 'prompt should contain workspace path');
    assert.ok(prompt.includes('当前运行环境'), 'prompt should contain environment section');
});

// ─── Skills 测试 ──────────────────────────────────────────────

test('loadFromPath: 加载 skills/ 目录中的技能', async () => {
    const dir = path.join(tmpDir, 'with-skills');
    writeAgentConfig(dir, {
        agentJson: { name: 'skill-agent', when_to_use: 'Agent with skills.' },
        agentsMd: '# Skill Agent',
        skills: { 'my-skill': VALID_SKILL_MD }
    });

    const agent = await CustomAgent.loadFromPath(dir);

    // 验证技能已注册到 SkillRegistry
    const skill = await SkillRegistry.getInstance().getSkill(`custom:${path.resolve(dir)}`, 'my-skill');
    assert.ok(skill, 'skill should be registered in SkillRegistry');
    assert.equal(skill!.frontmatter.name, 'my-skill');
    assert.equal(skill!.frontmatter.description, 'A test skill for unit testing.');

    await agent.dispose();
});

test('loadFromPath: 无 skills 目录时不报错', async () => {
    const dir = path.join(tmpDir, 'no-skills');
    writeAgentConfig(dir, { agentJson: VALID_AGENT_JSON, agentsMd: '# No Skills' });

    const agent = await CustomAgent.loadFromPath(dir);
    assert.equal(agent.agentName, 'test-agent');

    await agent.dispose();
});

test('loadFromPath: 无效的 SKILL.md 被跳过', async () => {
    const dir = path.join(tmpDir, 'bad-skill');
    writeAgentConfig(dir, {
        agentJson: { name: 'bad-skill-agent', when_to_use: 'Agent with bad skill.' },
        agentsMd: '# Bad Skill Agent',
        skills: { 'bad-skill': 'no frontmatter here' }
    });

    const agent = await CustomAgent.loadFromPath(dir);

    // 无效技能不应注册
    const skill = await SkillRegistry.getInstance().getSkill(`custom:${path.resolve(dir)}`, 'bad-skill');
    assert.equal(skill, undefined);

    await agent.dispose();
});

test('dispose: 注销 SkillProvider', async () => {
    const dir = path.join(tmpDir, 'dispose-test');
    writeAgentConfig(dir, {
        agentJson: { name: 'dispose-agent', when_to_use: 'Dispose test.' },
        agentsMd: '# Dispose Test',
        skills: { 'my-skill': VALID_SKILL_MD }
    });

    const agent = await CustomAgent.loadFromPath(dir);

    // 注册后应能找到
    const skillBefore = await SkillRegistry.getInstance().getSkill(`custom:${path.resolve(dir)}`, 'my-skill');
    assert.ok(skillBefore, 'skill should be registered before dispose');

    await agent.dispose();

    // 注销后应找不到
    const skillAfter = await SkillRegistry.getInstance().getSkill(`custom:${path.resolve(dir)}`, 'my-skill');
    assert.equal(skillAfter, undefined, 'skill should be unregistered after dispose');
});

// ─── MCP 测试 ─────────────────────────────────────────────────

test('loadFromPath: 加载 mcp.json 配置', async () => {
    const dir = path.join(tmpDir, 'with-mcp');
    writeAgentConfig(dir, {
        agentJson: { name: 'mcp-agent', when_to_use: 'Agent with MCP.' },
        agentsMd: '# MCP Agent',
        mcpJson: {
            servers: [
                {
                    id: 'test-server',
                    name: 'Test Server',
                    transport: 'stdio',
                    enabled: true,
                    command: 'echo',
                    args: ['hello']
                }
            ]
        }
    });

    const agent = await CustomAgent.loadFromPath(dir);
    assert.deepEqual(agent.mcpConfig, {
        servers: [
            {
                id: 'test-server',
                name: 'Test Server',
                transport: 'stdio',
                enabled: true,
                command: 'echo',
                args: ['hello']
            }
        ]
    });
    assert.equal(agent.agentId, path.resolve(dir));

    await agent.dispose();
});

test('loadFromPath: 无 mcp.json 时返回空 MCP 配置', async () => {
    const dir = path.join(tmpDir, 'no-mcp');
    writeAgentConfig(dir, { agentJson: VALID_AGENT_JSON, agentsMd: '# No MCP' });

    const agent = await CustomAgent.loadFromPath(dir);
    assert.deepEqual(agent.mcpConfig, { servers: [] });

    await agent.dispose();
});

test('loadFromPath: 保留禁用的 MCP 配置交由 MCPMgr 过滤', async () => {
    const dir = path.join(tmpDir, 'disabled-mcp');
    writeAgentConfig(dir, {
        agentJson: { name: 'disabled-mcp-agent', when_to_use: 'Agent with disabled MCP.' },
        agentsMd: '# Disabled MCP',
        mcpJson: {
            servers: [
                {
                    id: 'disabled-server',
                    name: 'Disabled Server',
                    transport: 'stdio',
                    enabled: false,
                    command: 'echo'
                }
            ]
        }
    });

    const agent = await CustomAgent.loadFromPath(dir);
    assert.equal((agent.mcpConfig as { servers: Array<{ enabled: boolean }> }).servers[0].enabled, false);

    await agent.dispose();
});

test('loadFromPath: 无效的 mcp.json 不影响 agent 加载', async () => {
    const dir = path.join(tmpDir, 'bad-mcp');
    writeAgentConfig(dir, {
        agentJson: VALID_AGENT_JSON,
        agentsMd: '# Bad MCP',
        mcpJson: { invalid: true }
    });

    // 不应抛出异常，只是跳过 MCP
    const agent = await CustomAgent.loadFromPath(dir);
    assert.equal(agent.agentName, 'test-agent');

    await agent.dispose();
});

// ─── AgentOffice getAgents 测试 ───────────────────────────────

test('AgentOffice.getAgents: 从 agents 目录加载并注册自定义 agent', async () => {
    const agentsDir = path.join(configDir, 'agents');
    const agentDir = path.join(agentsDir, 'registry-test-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agents.md'), '# Registry Test Agent\n\nA test agent loaded via registry.');
    fs.writeFileSync(
        path.join(agentDir, 'agent.json'),
        JSON.stringify({
            name: 'registry-test-agent',
            when_to_use: 'Agent loaded via AgentOffice.getAgents.'
        })
    );

    const { registrations } = await loadAgentsThroughAgentOffice();

    const agent = AgentRegistry.getAgent('registry-test-agent');
    assert.ok(agent, 'custom agent should be registered after AgentOffice loading');
    assert.equal(agent!.agentType, 'custom');
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].agentId, path.resolve(agentDir));

    // Cleanup
    await AgentRegistry.unloadCustomAgents();
    assert.equal(
        AgentRegistry.getAgent('registry-test-agent'),
        undefined,
        'agent should be unregistered after unloadCustomAgents'
    );
});

test('AgentOffice.getAgents: 无 agents 目录时不报错', async () => {
    // configDir 下没有 agents/ 目录
    const { agents, registrations } = await loadAgentsThroughAgentOffice();
    assert.equal(agents.length, 0);
    assert.equal(registrations.length, 0);
    // 不应抛出异常
});

test('AgentOffice.getAgents: 加载失败的目录被跳过', async () => {
    const agentsDir = path.join(configDir, 'agents');
    const goodDir = path.join(agentsDir, 'good-agent');
    const badDir = path.join(agentsDir, 'bad-agent');

    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'agents.md'), '# Good Agent');
    fs.writeFileSync(
        path.join(goodDir, 'agent.json'),
        JSON.stringify({
            name: 'good-agent',
            when_to_use: 'A good agent.'
        })
    );

    // bad-agent 目录存在但没有 agents.md
    fs.mkdirSync(badDir, { recursive: true });

    await loadAgentsThroughAgentOffice();

    assert.ok(AgentRegistry.getAgent('good-agent'), 'good agent should be loaded');
    assert.equal(AgentRegistry.getAgent('bad-agent'), undefined, 'bad agent should be skipped');

    await AgentRegistry.unloadCustomAgents();
});

test('AgentOffice.getAgents: 重新收集时替换已加载 agent', async () => {
    const agentsDir = path.join(configDir, 'agents');
    const agentDir = path.join(agentsDir, 'reload-test-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agents.md'), '# Reload Test Agent');
    fs.writeFileSync(
        path.join(agentDir, 'agent.json'),
        JSON.stringify({
            name: 'reload-test-agent',
            when_to_use: 'Before reload.'
        })
    );

    await loadAgentsThroughAgentOffice();
    let agent = AgentRegistry.getAgent('reload-test-agent');
    assert.ok(agent);
    assert.equal(agent!.whenToUse, 'Before reload.');

    // 修改 agent.json
    fs.writeFileSync(
        path.join(agentDir, 'agent.json'),
        JSON.stringify({
            name: 'reload-test-agent',
            when_to_use: 'After reload.'
        })
    );

    await loadAgentsThroughAgentOffice();
    agent = AgentRegistry.getAgent('reload-test-agent');
    assert.ok(agent);
    assert.equal(agent!.whenToUse, 'After reload.');

    await AgentRegistry.unloadCustomAgents();
});
