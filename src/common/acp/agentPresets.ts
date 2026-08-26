/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

export interface AcpAgentPreset {
    id: string;
    name: string;
    descriptionKey: string;
    whenToUseKey: string;
    packageName: string;
    requiresDownloadNotice: boolean;
    transport: {
        type: 'stdio';
        command: string;
        args: readonly string[];
    };
}

export interface AcpAgentPresetDraft {
    name: string;
    enabled: boolean;
    dispatchable: boolean;
    whenToUse: string;
    protocolVersion: 1;
    transport: {
        type: 'stdio';
        command: string;
        args: string[];
        cwd: 'workspace';
        env: Record<string, string>;
        inheritEnv: boolean;
    };
    session: {
        configOptions: Record<string, string | boolean>;
        mcpBindings: Array<{ serverId: string; location: 'agent' | 'client' }>;
    };
    execution: {
        location: 'client';
        workspace: { strategy: 'task' };
        compatibility: 'preferred';
    };
    reconnect: {
        enabled: boolean;
        maxAttempts: number;
        initialDelayMs: number;
        maxDelayMs: number;
    };
    timeouts: {
        connectMs: number;
        promptMs: number;
    };
}

type Translate = (key: string) => string;

const definitions: AcpAgentPreset[] = [
    {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        descriptionKey: 'sp.agents.preset.copilot.description',
        whenToUseKey: 'sp.agents.preset.copilot.whenToUse',
        packageName: '@github/copilot-language-server',
        requiresDownloadNotice: true,
        transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@github/copilot-language-server@latest', '--acp']
        }
    },
    {
        id: 'claude-code',
        name: 'Claude Code',
        descriptionKey: 'sp.agents.preset.claude.description',
        whenToUseKey: 'sp.agents.preset.claude.whenToUse',
        packageName: '@agentclientprotocol/claude-agent-acp',
        requiresDownloadNotice: true,
        transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@agentclientprotocol/claude-agent-acp@latest']
        }
    },
    {
        id: 'gemini-cli',
        name: 'Gemini CLI',
        descriptionKey: 'sp.agents.preset.gemini.description',
        whenToUseKey: 'sp.agents.preset.gemini.whenToUse',
        packageName: '@google/gemini-cli',
        requiresDownloadNotice: true,
        transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@google/gemini-cli@latest', '--experimental-acp']
        }
    },
    {
        id: 'qwen-code',
        name: 'Qwen Code',
        descriptionKey: 'sp.agents.preset.qwen.description',
        whenToUseKey: 'sp.agents.preset.qwen.whenToUse',
        packageName: '@qwen-code/qwen-code',
        requiresDownloadNotice: true,
        transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@qwen-code/qwen-code@latest', '--acp', '--experimental-skills']
        }
    },
    {
        id: 'codex-cli',
        name: 'Codex CLI',
        descriptionKey: 'sp.agents.preset.codex.description',
        whenToUseKey: 'sp.agents.preset.codex.whenToUse',
        packageName: '@zed-industries/codex-acp',
        requiresDownloadNotice: true,
        transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@zed-industries/codex-acp@latest']
        }
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        descriptionKey: 'sp.agents.preset.opencode.description',
        whenToUseKey: 'sp.agents.preset.opencode.whenToUse',
        packageName: 'opencode-ai',
        requiresDownloadNotice: true,
        transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'opencode-ai@latest', 'acp']
        }
    }
];

export const ACP_AGENT_PRESETS: readonly Readonly<AcpAgentPreset>[] = Object.freeze(
    definitions.map((preset) =>
        Object.freeze({
            ...preset,
            transport: Object.freeze({
                ...preset.transport,
                args: Object.freeze([...preset.transport.args])
            })
        })
    )
);

export function getAcpAgentPreset(id: string): Readonly<AcpAgentPreset> | undefined {
    return ACP_AGENT_PRESETS.find((preset) => preset.id === id);
}

export function createAcpAgentPresetDraft(
    presetId: string,
    platform: string,
    translate: Translate
): AcpAgentPresetDraft {
    const preset = getAcpAgentPreset(presetId);
    if (!preset) throw new Error(`Unknown ACP agent preset: ${presetId}`);
    const isWindows = platform === 'win32';
    return {
        name: preset.name,
        enabled: true,
        dispatchable: true,
        whenToUse: translate(preset.whenToUseKey),
        protocolVersion: 1,
        transport: {
            type: 'stdio',
            command: isWindows ? 'cmd.exe' : preset.transport.command,
            args: isWindows ? ['/d', '/s', '/c', 'npx.cmd', ...preset.transport.args] : [...preset.transport.args],
            cwd: 'workspace',
            env: {},
            inheritEnv: true
        },
        session: {
            configOptions: {},
            mcpBindings: []
        },
        execution: {
            location: 'client',
            workspace: { strategy: 'task' },
            compatibility: 'preferred'
        },
        reconnect: {
            enabled: true,
            maxAttempts: 3,
            initialDelayMs: 500,
            maxDelayMs: 5000
        },
        timeouts: {
            connectMs: 30_000,
            promptMs: 1_800_000
        }
    };
}
