/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { t } from '../locale/index.js';

const WINDOWS_DRIVE_PATH = /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/][^\s]*/m;
const ACCESS_DENIED =
    /access (?:is )?denied|access to (?:the )?path .{0,200} is denied|unauthorizedaccessexception|permission denied|\beacces\b|拒绝访问|访问被拒绝/i;
// 命中 `\\?\pipe\`、`\\.\pipe\` 以及错误对象 JSON 序列化后的 `\\\\?\\pipe\\` 变体
const NAMED_PIPE_ADDRESS = /\\{2,4}[?.]\\{1,2}pipe\\{1,2}/;
const NAMED_PIPE_FAILURE =
    /\beaddrinuse\b|\beacces\b|\beperm\b|access (?:is )?denied|permission denied|拒绝访问|访问被拒绝/i;

export function appendSandboxPathDiagnostic(output: string, sandboxed: boolean): string {
    if (!sandboxed || !ACCESS_DENIED.test(output)) return output;

    const artifactLabel = `${t('output.artifactSaved')}: `;
    const diagnosticOutput = output
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith(artifactLabel))
        .join('\n');
    if (!WINDOWS_DRIVE_PATH.test(diagnosticOutput)) return output;

    const hint = t('sandbox.pathErrorHint');
    return output.includes(hint) ? output : `${output}\n\n${hint}`;
}

/**
 * 沙箱内的 AppContainer 进程被 Windows 禁止创建命名管道（\Device\NamedPipe
 * 根目录不含 package SID ACE），依赖管道 IPC 的工具（tsx CLI 等）一律
 * EADDRINUSE/EACCES。识别该失败签名并给出可行动的替代方案。
 */
export function appendSandboxPipeDiagnostic(output: string, sandboxed: boolean): string {
    if (!sandboxed || !NAMED_PIPE_FAILURE.test(output) || !NAMED_PIPE_ADDRESS.test(output)) return output;

    const hint = t('sandbox.pipeErrorHint');
    return output.includes(hint) ? output : `${output}\n\n${hint}`;
}
