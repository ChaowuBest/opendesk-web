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

/**
 * AGENTS.md discovery and user instruction assembly.
 *
 * Implements the AGENTS.md spec (https://agents.md/):
 * - Discovers AGENTS.md files in the workspace root (case-insensitive filename matching).
 * - Reads and caches their content, invalidating on workspace change.
 * - Provides the content for injection into the system prompt.
 *
 * Filename matching is case-insensitive: AGENTS.md, agents.md, Agents.md, etc.
 * are all recognized. If multiple case variants exist, the first match wins
 * in priority order: AGENTS.md > agents.md > other variants.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getOpendeskDirectory } from '../utils/setting.js';

/** Priority-ordered candidate filenames for AGENTS.md discovery. */
const CANDIDATE_FILENAMES = ['AGENTS.md', 'agents.md'];

function getUserAgentsMdDirectory(): string {
    return path.join(getOpendeskDirectory(), 'agents', 'main');
}

export interface LoadedAgentsMd {
    /** The resolved absolute path of the file. */
    path: string;
    /** The trimmed file contents. */
    contents: string;
}

/**
 * Find the AGENTS.md file in a directory using case-insensitive matching.
 *
 * Strategy:
 * 1. Try the priority candidates (AGENTS.md, agents.md) directly — fast path.
 * 2. If none found, do a directory listing and match case-insensitively.
 *
 * This covers all case variants on case-sensitive filesystems (Linux)
 * while remaining fast on case-insensitive ones (macOS, Windows).
 */
function findAgentsMdInDirectory(dirPath: string): string | null {
    // Fast path: try well-known names first
    for (const candidate of CANDIDATE_FILENAMES) {
        const candidatePath = path.join(dirPath, candidate);
        try {
            const stat = fs.statSync(candidatePath);
            if (stat.isFile()) {
                return candidatePath;
            }
        } catch {
            // file does not exist, try next
        }
    }

    // Slow path: case-insensitive scan for uncommon variants (e.g. Agents.md, AGENTS.MD)
    try {
        const entries = fs.readdirSync(dirPath);
        for (const entry of entries) {
            if (entry.toLowerCase() === 'agents.md') {
                const fullPath = path.join(dirPath, entry);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isFile()) {
                        return fullPath;
                    }
                } catch {
                    // stat failed, skip
                }
            }
        }
    } catch {
        // directory not readable, skip
    }

    return null;
}

/**
 * Singleton manager for AGENTS.md discovery and caching.
 *
 * Call `loadForWorkspace(workspace)` when the workspace changes.
 * Call `getInstructions()` to retrieve the cached content (or null).
 */
class AgentsMdManager {
    private static instance: AgentsMdManager | null = null;

    private currentWorkspace: string = '';
    private workspaceLoaded: LoadedAgentsMd | null = null;
    private userLoaded: LoadedAgentsMd | null = null;
    private userLoadedOnce = false;

    static getInstance(): AgentsMdManager {
        if (!AgentsMdManager.instance) {
            AgentsMdManager.instance = new AgentsMdManager();
        }
        return AgentsMdManager.instance;
    }

    /**
     * (Re-)load AGENTS.md for the given workspace directory.
     * Skips reload if the workspace hasn't changed.
     */
    loadForWorkspace(workspace: string): void {
        if (this.currentWorkspace === workspace && this.workspaceLoaded !== undefined) {
            // already loaded for this workspace (including null = "no file found")
            return;
        }
        this.currentWorkspace = workspace;
        this.workspaceLoaded = null;

        if (!workspace) {
            return;
        }

        const filePath = findAgentsMdInDirectory(workspace);
        if (!filePath) {
            logger.info(`no AGENTS.md found in workspace: ${workspace}`);
            return;
        }

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const trimmed = raw.trim();
            if (trimmed.length === 0) {
                logger.info(`AGENTS.md found but empty: ${filePath}`);
                return;
            }
            this.workspaceLoaded = { path: filePath, contents: trimmed };
            logger.info(`loaded AGENTS.md (${trimmed.length} chars) from: ${filePath}`);
        } catch (err) {
            logger.warn(`failed to read AGENTS.md at ${filePath}: ${err}`);
        }
    }

    /**
     * Load user-level AGENTS.md from the OpenDesk config directory.
     * This file applies to all workspaces.
     */
    loadForUser(): void {
        if (this.userLoadedOnce) {
            return;
        }
        this.userLoadedOnce = true;
        this.userLoaded = null;

        const userAgentsDirectory = getUserAgentsMdDirectory();
        try {
            fs.mkdirSync(userAgentsDirectory, { recursive: true });
        } catch (err) {
            logger.warn(`failed to create user agents directory ${userAgentsDirectory}: ${err}`);
        }
        const filePath = findAgentsMdInDirectory(userAgentsDirectory);
        if (!filePath) {
            logger.info(`no user AGENTS.md found in user agents directory: ${userAgentsDirectory}`);
            return;
        }

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const trimmed = raw.trim();
            if (trimmed.length === 0) {
                logger.info(`user AGENTS.md found but empty: ${filePath}`);
                return;
            }
            this.userLoaded = { path: filePath, contents: trimmed };
            logger.info(`loaded user AGENTS.md (${trimmed.length} chars) from: ${filePath}`);
        } catch (err) {
            logger.warn(`failed to read user AGENTS.md at ${filePath}: ${err}`);
        }
    }

    /**
     * Force a reload even if the workspace hasn't changed.
     * Useful when the user might have created/modified AGENTS.md at runtime.
     */
    reloadForWorkspace(workspace: string): void {
        this.currentWorkspace = '';
        this.loadForWorkspace(workspace);
    }

    /**
     * Force a reload of user-level AGENTS.md.
     */
    reloadForUser(): void {
        this.userLoadedOnce = false;
        this.loadForUser();
    }

    /**
     * Get the loaded AGENTS.md content, or null if no file was found.
     */
    getInstructions(): string | null {
        return this.workspaceLoaded?.contents ?? null;
    }

    /**
     * Get the loaded user-level AGENTS.md content, or null if no file was found.
     */
    getUserInstructions(): string | null {
        return this.userLoaded?.contents ?? null;
    }

    /**
     * Get the loaded AGENTS.md metadata, or null.
     */
    getLoaded(): LoadedAgentsMd | null {
        return this.workspaceLoaded;
    }

    /**
     * Get the loaded user-level AGENTS.md metadata, or null.
     */
    getUserLoaded(): LoadedAgentsMd | null {
        return this.userLoaded;
    }

    /**
     * Get the current workspace this manager is tracking.
     */
    getCurrentWorkspace(): string {
        return this.currentWorkspace;
    }
}

/**
 * Build the AGENTS.md section for the system prompt.
 * Returns null if no AGENTS.md is loaded.
 */
export function getAgentsMdSection(workspace: string): string | null {
    const manager = AgentsMdManager.getInstance();
    manager.loadForUser();
    manager.loadForWorkspace(workspace);

    const userInstructions = manager.getUserInstructions();
    const workspaceInstructions = manager.getInstructions();
    if (!userInstructions && !workspaceInstructions) {
        return null;
    }

    const instructionSections: string[] = [];
    const userLoaded = manager.getUserLoaded();
    if (userInstructions && userLoaded) {
        instructionSections.push(`## 用户级指令

以下是来自用户级 AGENTS.md 文件的指令（${userLoaded.path}）。
这些指令适用于所有工作空间，用于描述用户的通用偏好和长期工作方式。

<USER_AGENTS_MD_INSTRUCTIONS>
${userInstructions}
</USER_AGENTS_MD_INSTRUCTIONS>`);
    }

    const workspaceLoaded = manager.getLoaded();
    if (workspaceInstructions && workspaceLoaded) {
        instructionSections.push(`## 工作空间指令

以下是来自工作空间 AGENTS.md 文件的指令（${workspaceLoaded.path}）。
这些指令由项目维护者提供，用于指导你在此项目中的行为。

<WORKSPACE_AGENTS_MD_INSTRUCTIONS>
${workspaceInstructions}
</WORKSPACE_AGENTS_MD_INSTRUCTIONS>`);
    }

    return `# AGENTS.md 指令

以下是来自不同作用域 AGENTS.md 文件的指令。
用户级指令适用于所有工作空间；工作空间指令适用于当前工作空间。
如果用户级指令与工作空间指令冲突，工作空间指令优先；用户在对话中直接给出的指令优先于 AGENTS.md 中的指令。

## AGENTS.md 规范说明
- 仓库中通常会包含 AGENTS.md 文件，它们可以出现在仓库的任何位置。
- 这些文件是人类向你（智能体）提供指令或工作提示的方式。
- 常见内容包括：编码规范、代码组织信息、运行或测试代码的说明等。
- AGENTS.md 的作用范围是包含它的目录及其所有子目录。
- 对于你最终修改的每个文件，你必须遵守其作用范围内所有 AGENTS.md 中的指令。
- 关于代码风格、结构、命名等的指令仅适用于 AGENTS.md 作用范围内的代码，除非文件另有说明。
- 用户在对话中直接给出的指令优先于 AGENTS.md 中的指令。

${instructionSections.join('\n\n')}`;
}

/**
 * Notify the manager that the workspace has changed.
 * Called during workspace switch to eagerly reload.
 */
export function onWorkspaceChanged(workspace: string): void {
    AgentsMdManager.getInstance().reloadForWorkspace(workspace);
}

export function onUserAgentsMdChanged(): void {
    AgentsMdManager.getInstance().reloadForUser();
}

export { AgentsMdManager };
