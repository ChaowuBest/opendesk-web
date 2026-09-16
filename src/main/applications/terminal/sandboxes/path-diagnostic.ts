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
