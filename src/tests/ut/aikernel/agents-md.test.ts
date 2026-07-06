import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { AgentsMdManager, getAgentsMdSection } from '../../../main/aikernel/agents_md.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

let configDir = '';
let workspaceDir = '';

function userAgentsDir(): string {
    return path.join(configDir, 'agents', 'main');
}

function writeUserAgentsMd(contents: string): string {
    const dir = userAgentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(filePath, contents);
    return filePath;
}

beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-agents-md-config-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-agents-md-workspace-'));
    setCustomOpendeskDirectory(configDir);
    AgentsMdManager.getInstance().reloadForUser();
    AgentsMdManager.getInstance().reloadForWorkspace(workspaceDir);
});

afterEach(() => {
    AgentsMdManager.getInstance().reloadForWorkspace('');
    setCustomOpendeskDirectory(undefined);
    for (const dir of [configDir, workspaceDir]) {
        if (dir && fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('AGENTS.md instructions', () => {
    test('returns null when neither user nor workspace AGENTS.md exists', () => {
        expect(getAgentsMdSection(workspaceDir)).toBeNull();
    });

    test('creates user agents/main directory when loading user-level AGENTS.md', () => {
        expect(fs.existsSync(userAgentsDir())).toBe(true);
    });

    test('loads user-level AGENTS.md from config agents/main directory', () => {
        const filePath = writeUserAgentsMd('用户级：打招呼时说我是你的 AI 助手');
        AgentsMdManager.getInstance().reloadForUser();

        const section = getAgentsMdSection(workspaceDir);

        expect(section).toContain('## 用户级指令');
        expect(section).toContain(filePath);
        expect(section).toContain('用户级：打招呼时说我是你的 AI 助手');
        expect(section).toContain('<USER_AGENTS_MD_INSTRUCTIONS>');
        expect(section).not.toContain('## 工作空间指令');
    });

    test('does not load user-level AGENTS.md from config root directory', () => {
        fs.writeFileSync(path.join(configDir, 'AGENTS.md'), '旧位置用户级指令');
        AgentsMdManager.getInstance().reloadForUser();

        const section = getAgentsMdSection(workspaceDir);

        expect(section).toBeNull();
    });

    test('loads both user-level and workspace AGENTS.md with workspace after user', () => {
        writeUserAgentsMd('用户级指令');
        fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '工作空间指令');
        AgentsMdManager.getInstance().reloadForUser();
        AgentsMdManager.getInstance().reloadForWorkspace(workspaceDir);

        const section = getAgentsMdSection(workspaceDir);

        expect(section).toContain('## 用户级指令');
        expect(section).toContain('## 工作空间指令');
        expect(section).toContain('用户级指令');
        expect(section).toContain('工作空间指令');
        expect(section!.indexOf('用户级指令')).toBeLessThan(section!.indexOf('工作空间指令'));
        expect(section).toContain('<USER_AGENTS_MD_INSTRUCTIONS>');
        expect(section).toContain('<WORKSPACE_AGENTS_MD_INSTRUCTIONS>');
    });
});
