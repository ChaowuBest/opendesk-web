import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TaskContext } from '../../../../main/aikernel/agents/common.js';
import { AgentRegistry } from '../../../../main/aikernel/agents/registry.js';
import { SkillRegistry } from '../../../../main/aikernel/skill.js';
import type { TaskState } from '../../../../main/aikernel/states/tasks.js';
import { AgentOfficeApplication } from '../../../../main/applications/agentoffice/app.js';
import type { StaffListItem } from '../../../../main/applications/agentoffice/common.js';
import { CustomAgent } from '../../../../main/applications/agentoffice/custom-agent.js';
import { AgentsMdManager } from '../../../../main/aikernel/agents_md.js';
import { setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

const ENABLED_STAFF_ID = '11111111-1111-4111-8111-111111111111';
const DISABLED_STAFF_ID = '22222222-2222-4222-8222-222222222222';
const SKILL_NAME = 'staff-research';
const SKILL_MD = `---
name: ${SKILL_NAME}
description: Research only for this digital staff.
---
# Staff Research

Use the staff-private research workflow.`;

let configDirectory = '';

function writeStaffAgent(staffId: string, serverCommand: string): string {
    const agentDirectory = path.join(configDirectory, 'apps', 'agentoffice', 'staffs', staffId, 'agent');
    const skillDirectory = path.join(agentDirectory, 'skills', SKILL_NAME);
    fs.mkdirSync(skillDirectory, { recursive: true });
    fs.writeFileSync(path.join(agentDirectory, 'agents.md'), '# Digital Researcher\n\nFollow the staff playbook.');
    fs.writeFileSync(
        path.join(agentDirectory, 'mcp.json'),
        JSON.stringify({
            servers: [
                {
                    name: 'staff-files',
                    command: serverCommand
                }
            ]
        })
    );
    fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), SKILL_MD);
    return agentDirectory;
}

function staffListItem(id: string, enabled: boolean): StaffListItem {
    return {
        id,
        name: enabled ? 'Avery' : 'Disabled',
        vendor_name: 'OpenDesk',
        title: 'Researcher',
        specialties: ['research'],
        trigger_interval: 'never',
        hired_at: '2026-07-26T00:00:00.000Z',
        enabled,
        message_count: 0,
        task_count: 0
    };
}

test.before(() => {
    configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-staff-agent-'));
    setCustomOpendeskDirectory(configDirectory);
});

test.after(() => {
    setCustomOpendeskDirectory(undefined);
    fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('AgentOffice loads Staff capabilities without making Staff dispatchable', async () => {
    const enabledAgentDirectory = writeStaffAgent(ENABLED_STAFF_ID, 'first-command');
    writeStaffAgent(DISABLED_STAFF_ID, 'disabled-command');
    const registrationSnapshots: Array<Array<{ agentId: string; config: unknown }>> = [];
    const application = new AgentOfficeApplication();
    application.callWorker = async (methodName: string) => {
        assert.equal(methodName, 'listStaffStartupInfo');
        return {
            status: 'ok',
            data: [staffListItem(ENABLED_STAFF_ID, true), staffListItem(DISABLED_STAFF_ID, false)]
        };
    };
    application.setRegistry({
        getApplication: (bundleName: string) =>
            bundleName === 'mcpmgr'
                ? {
                      replaceAgentServers: async (registrations: Array<{ agentId: string; config: unknown }>) => {
                          registrationSnapshots.push(structuredClone(registrations));
                      }
                  }
                : undefined
    });

    const agents = await application.getAgents();
    await AgentRegistry.replaceApplicationAgents([{ bundleName: application.bundleName, agents }]);

    assert.equal(agents.length, 1);
    assert.equal(agents[0].dispatchable, false);
    assert.equal(AgentRegistry.getApplicationAgent('agentoffice', `staff:${ENABLED_STAFF_ID}`), agents[0]);
    assert.equal(registrationSnapshots.length, 1);
    assert.deepEqual(registrationSnapshots[0], [
        {
            agentId: `agentoffice:staff:${ENABLED_STAFF_ID}`,
            config: {
                servers: [{ name: 'staff-files', command: 'first-command' }]
            }
        }
    ]);

    const skillRegistry = SkillRegistry.getInstance();
    const staffBundleName = `staff:${ENABLED_STAFF_ID}`;
    const staffAgentId = `agentoffice:staff:${ENABLED_STAFF_ID}`;
    const staffSkill = await skillRegistry.getSkillForAgent(staffBundleName, SKILL_NAME, staffAgentId);
    assert.ok(staffSkill);
    assert.deepEqual(staffSkill.agentIds, [staffAgentId]);
    assert.equal(await skillRegistry.getSkillForAgent(staffBundleName, SKILL_NAME), undefined);
    assert.equal(await skillRegistry.getSkillForAgent(staffBundleName, SKILL_NAME, '/another/agent'), undefined);
    assert.match(await skillRegistry.getSkillFrontmatterXml(undefined, staffAgentId), new RegExp(SKILL_NAME));
    assert.doesNotMatch(await skillRegistry.getSkillFrontmatterXml(), new RegExp(SKILL_NAME));
    assert.equal(skillRegistry.getSkillProvider(`staff:${DISABLED_STAFF_ID}`), undefined);

    const loadSkill = skillRegistry.getToolset().getTool('LoadSkill');
    assert.ok(loadSkill);
    const denied = await loadSkill.execute({ bundleName: staffBundleName, skillName: SKILL_NAME }, undefined, {
        agentId: '/another/agent'
    } as TaskState);
    assert.equal(denied.result, '未找到该Skill');
    const allowed = await loadSkill.execute({ bundleName: staffBundleName, skillName: SKILL_NAME }, undefined, {
        agentId: staffAgentId
    } as TaskState);
    assert.match(String(allowed.result), /staff-private research workflow/);

    fs.writeFileSync(
        path.join(enabledAgentDirectory, 'mcp.json'),
        JSON.stringify({ servers: [{ name: 'staff-files', command: 'updated-command' }] })
    );
    const reloadedAgents = await application.getAgents();
    await AgentRegistry.replaceApplicationAgents([
        {
            bundleName: application.bundleName,
            agents: reloadedAgents
        }
    ]);
    assert.deepEqual(registrationSnapshots.at(-1), [
        {
            agentId: staffAgentId,
            config: {
                servers: [{ name: 'staff-files', command: 'updated-command' }]
            }
        }
    ]);
    assert.ok(await skillRegistry.getSkillForAgent(staffBundleName, SKILL_NAME, staffAgentId));

    await application.beforeExit();
    assert.equal(await skillRegistry.getSkill(staffBundleName, SKILL_NAME), undefined);
});

test('Staff prompt uses its own Agent definition without subtask completion instructions', async (context) => {
    const agentDirectory = path.join(configDirectory, 'standalone-staff-agent');
    const skillDirectory = path.join(agentDirectory, 'skills', SKILL_NAME);
    fs.mkdirSync(skillDirectory, { recursive: true });
    fs.writeFileSync(
        path.join(agentDirectory, 'agents.md'),
        '# Staff Specialist\n\nUse the staff-specific definition.'
    );
    fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), SKILL_MD);
    const agent = await CustomAgent.loadFromPath(agentDirectory, {
        purpose: 'staff',
        agentName: 'staff:test',
        whenToUse: 'Staff runtime test',
        skillBundleName: 'staff:test',
        additionalSystemPrompt: () => 'CRITICAL STAFF RULE'
    });
    context.after(async () => await agent.dispose());
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-staff-workspace-'));
    fs.writeFileSync(path.join(workspaceDirectory, 'AGENTS.md'), 'WORKSPACE INSTRUCTIONS');
    AgentsMdManager.getInstance().reloadForWorkspace(workspaceDirectory);
    context.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const taskContext: TaskContext = {
        task_id: 'staff-task',
        task_name: 'staff task',
        agentId: agent.agentId,
        getWorkspace: () => workspaceDirectory
    };

    const prompt = await agent.createSystemPrompt(agent.supportedModes()[0], taskContext);

    assert.match(prompt, /staff-specific definition/);
    assert.match(prompt, new RegExp(SKILL_NAME));
    assert.doesNotMatch(prompt, /planning-attemptCompletion/);
    assert.ok(prompt.indexOf('CRITICAL STAFF RULE') > prompt.indexOf('WORKSPACE INSTRUCTIONS'));
    assert.equal(prompt.trimEnd().endsWith('CRITICAL STAFF RULE'), true);
});
