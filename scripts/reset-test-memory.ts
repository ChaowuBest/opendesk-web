/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：在本地开发重启前清空会影响新 Task 的长期记忆文件。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

interface ResetOptions {
    opendeskDirectory: string;
    workspaceDirectory: string;
}

function readArgument(name: string): string | undefined {
    const prefix = `${name}=`;
    const inline = process.argv.find((argument) => argument.startsWith(prefix));
    if (inline) {
        return inline.slice(prefix.length);
    }

    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertSafeDirectory(directory: string, label: string): string {
    const resolved = path.resolve(directory);
    const root = path.parse(resolved).root;
    if (resolved === root || resolved === path.resolve(os.homedir())) {
        throw new Error(`${label} 不能指向文件系统根目录或用户主目录：${resolved}`);
    }
    return resolved;
}

function readConfiguredWorkspace(opendeskDirectory: string): string | undefined {
    const settingPath = path.join(opendeskDirectory, 'setting.json');
    try {
        const setting = JSON.parse(fs.readFileSync(settingPath, 'utf8')) as { default_workspace?: unknown };
        return typeof setting.default_workspace === 'string' && setting.default_workspace.trim()
            ? setting.default_workspace.trim()
            : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw new Error(`无法读取 OpenDesk 设置 ${settingPath}：${String(error)}`);
    }
}

function resolveOptions(): ResetOptions {
    const opendeskDirectory = assertSafeDirectory(
        readArgument('--opendesk-directory') ?? path.join(os.homedir(), '.opendesk'),
        'OpenDesk 数据目录'
    );
    const configuredWorkspace = readConfiguredWorkspace(opendeskDirectory);
    const workspaceDirectory = assertSafeDirectory(
        readArgument('--workspace-directory') ?? configuredWorkspace ?? path.join(opendeskDirectory, 'workspace'),
        'Workspace 目录'
    );
    return { opendeskDirectory, workspaceDirectory };
}

function assertTargetInside(target: string, parent: string): void {
    const relative = path.relative(parent, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`拒绝写入预期目录之外的路径：${target}`);
    }
}

async function replaceFileAtomically(filePath: string, content: string): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });

    try {
        const stat = await fs.promises.lstat(filePath);
        if (stat.isSymbolicLink()) {
            throw new Error(`拒绝重置符号链接：${filePath}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }

    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.promises.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
        await fs.promises.rename(temporaryPath, filePath);
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export async function resetTestMemory(options: ResetOptions): Promise<string[]> {
    const globalMemoryDirectory = path.join(options.opendeskDirectory, 'memory');
    const workspaceMemoryDirectory = path.join(options.workspaceDirectory, '.opendesk', 'memory');
    const targets = [
        { path: path.join(globalMemoryDirectory, 'user.md'), content: '' },
        { path: path.join(globalMemoryDirectory, 'memory.json'), content: '[]\n' },
        { path: path.join(workspaceMemoryDirectory, 'memory.json'), content: '[]\n' }
    ];

    assertTargetInside(globalMemoryDirectory, options.opendeskDirectory);
    assertTargetInside(workspaceMemoryDirectory, options.workspaceDirectory);
    for (const target of targets) {
        await replaceFileAtomically(target.path, target.content);
    }
    return targets.map((target) => target.path);
}

const options = resolveOptions();
const resetPaths = await resetTestMemory(options);
console.log('已清空会影响新 Task 的长期记忆：');
for (const resetPath of resetPaths) {
    console.log(`- ${resetPath}`);
}
console.log('Task、Workflow、workspace 普通文件和 session memory 未改动。');
