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

import fs from 'fs';
import path from 'path';
import type { ExternalAgentDefinition } from '../../../aikernel/types/agent.js';

export const AGENTS_MD_FILENAME = 'agents.md';
const AGENT_META_FILENAME = 'agent.json';

interface AgentMetaFile {
    name?: unknown;
    when_to_use?: unknown;
    dispatchable?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPathInside(root: string, target: string): boolean {
    const normalizedRoot = path.resolve(root);
    const normalizedTarget = path.resolve(target);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

/**
 * 将插件声明的相对路径解析为插件根目录内的真实路径。
 * 绝对路径、越出根目录的路径以及越界符号链接都会被拒绝。
 */
export function resolvePluginResourcePath(rootDir: string, declaredPath: string, code: string): string {
    if (path.isAbsolute(declaredPath)) throw new Error(`${code}:absolute`);
    const resolved = path.resolve(rootDir, declaredPath);
    if (!isPathInside(rootDir, resolved)) throw new Error(`${code}:outside_root`);
    if (!fs.existsSync(resolved)) throw new Error(`${code}:not_found`);
    const realRoot = fs.realpathSync(rootDir);
    const realResolved = fs.realpathSync(resolved);
    if (!isPathInside(realRoot, realResolved)) throw new Error(`${code}:outside_root`);
    return realResolved;
}

/** 从 agent 目录读取可选的 agent.json 元数据；文件存在但内容非法时抛错，不静默忽略。 */
function readAgentMeta(directory: string, code: string): AgentMetaFile {
    const metaPath = path.join(directory, AGENT_META_FILENAME);
    if (!fs.existsSync(metaPath)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as unknown;
        if (!isRecord(raw)) throw new Error('not an object');
        return raw as AgentMetaFile;
    } catch (err) {
        throw new Error(`${code}:${path.basename(directory)}:${err}`);
    }
}

function optionalMetaString(value: unknown, field: string, code: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${code}:${field}`);
    }
    return value.trim();
}

export interface AgentResourceErrorCodes {
    /** 路径非法（绝对路径、越界、不存在、不是目录） */
    path: string;
    /** 声明目录下找不到任何 agent */
    notFound: string;
    /** agents.md 为空 */
    bodyEmpty: string;
    /** agent.json 内容非法 */
    metaInvalid: string;
}

/** manifest resources.agents 静态声明使用的错误码 */
export const AGENT_MANIFEST_ERROR_CODES: AgentResourceErrorCodes = {
    path: 'plugin.manifest_agent_path_invalid',
    notFound: 'plugin.manifest_agent_not_found',
    bodyEmpty: 'plugin.manifest_agent_body_empty',
    metaInvalid: 'plugin.manifest_agent_meta_invalid'
};

/** ctx.agents.registerDirectory 运行时注册使用的错误码 */
export const AGENT_RUNTIME_ERROR_CODES: AgentResourceErrorCodes = {
    path: 'plugin.agent_directory_invalid',
    notFound: 'plugin.agent_directory_empty',
    bodyEmpty: 'plugin.agent_body_empty',
    metaInvalid: 'plugin.agent_meta_invalid'
};

/**
 * 从单个 agent 目录读取 ExternalAgentDefinition（含安装位置 location）。
 *
 * 目录格式与 OpenDesk 自定义子 Agent 一致：
 * - agents.md   - system prompt 指令体（必需且非空）
 * - agent.json  - 可选元数据：name、when_to_use、dispatchable
 *
 * 缺失字段的推断规则：name 取目录名，whenToUse 取 agents.md 首行标题，dispatchable 默认 true。
 */
export function loadAgentFromDirectory(directory: string, codes: AgentResourceErrorCodes): ExternalAgentDefinition {
    const body = fs.readFileSync(path.join(directory, AGENTS_MD_FILENAME), 'utf-8').trim();
    const directoryName = path.basename(directory);
    if (body.length === 0) {
        throw new Error(`${codes.bodyEmpty}:${directoryName}`);
    }
    const meta = readAgentMeta(directory, codes.metaInvalid);
    if (meta.dispatchable !== undefined && typeof meta.dispatchable !== 'boolean') {
        throw new Error(`${codes.metaInvalid}:${directoryName}:dispatchable`);
    }
    const firstLine =
        body
            .split('\n')[0]
            .replace(/^#+\s*/, '')
            .trim() || directoryName;
    return {
        name: optionalMetaString(meta.name, `${directoryName}:name`, codes.metaInvalid) ?? directoryName,
        whenToUse: optionalMetaString(meta.when_to_use, `${directoryName}:when_to_use`, codes.metaInvalid) ?? firstLine,
        body,
        location: directory,
        dispatchable: meta.dispatchable ?? true
    };
}

/**
 * 扫描声明的目录并返回其中所有 agent 目录。
 *
 * 目录自身包含 agents.md 时视为单个 agent；否则扫描其一级子目录，
 * 收集包含 agents.md 的目录。声明路径必须位于插件根目录内。
 */
export function findAgentDirectories(rootDir: string, declaredPath: string, codes: AgentResourceErrorCodes): string[] {
    const resolved = resolvePluginResourcePath(rootDir, declaredPath, codes.path);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`${codes.path}:not_directory`);
    if (fs.existsSync(path.join(resolved, AGENTS_MD_FILENAME))) return [resolved];
    const directories = fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(resolved, entry.name))
        .filter((directory) => fs.existsSync(path.join(directory, AGENTS_MD_FILENAME)))
        .sort();
    if (directories.length === 0) throw new Error(`${codes.notFound}:${declaredPath}`);
    return directories;
}

/**
 * 扫描插件目录下声明的相对路径，返回其中所有 agent 定义（携带安装位置）。
 * 供 manifest 静态资源与 ctx.agents.registerDirectory 复用。
 */
export function loadAgentsFromDirectory(
    rootDir: string,
    declaredPath: string,
    codes: AgentResourceErrorCodes
): ExternalAgentDefinition[] {
    return findAgentDirectories(rootDir, declaredPath, codes).map((directory) =>
        loadAgentFromDirectory(directory, codes)
    );
}
