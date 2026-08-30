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

import type { AcpAgentProfile } from '../common.js';

export type SafeAcpProfileSnapshot = {
    id: string;
    name: string;
    protocolVersion: 1 | 2;
    execution: AcpAgentProfile['execution'];
    transport:
        | {
              type: 'stdio';
              command: string;
              args: string[];
              cwd: 'workspace' | 'fixed';
              fixedCwd?: string;
              envNames: string[];
          }
        | {
              type: 'streamableHttp';
              url: string;
              headerNames: string[];
              cookies: 'include' | 'omit';
          };
};

const ENVIRONMENT_TEMPLATE_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class AcpEnvironmentVariableError extends Error {
    constructor(readonly variableName: string) {
        super(variableName);
        this.name = 'AcpEnvironmentVariableError';
    }
}

export function resolveAcpTemplate(value: string, environ: NodeJS.ProcessEnv): string {
    return value.replace(ENVIRONMENT_TEMPLATE_PATTERN, (_match, name: string) => {
        const replacement = environ[name];
        if (replacement === undefined) {
            throw new AcpEnvironmentVariableError(name);
        }
        return replacement;
    });
}

export function resolveAcpTemplateRecord(
    values: Record<string, string>,
    environ: NodeJS.ProcessEnv
): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolveAcpTemplate(value, environ)]));
}

export function createSafeAcpProfileSnapshot(profile: AcpAgentProfile): SafeAcpProfileSnapshot {
    if (profile.transport.type === 'stdio') {
        return {
            id: profile.id,
            name: profile.name,
            protocolVersion: profile.protocolVersion,
            execution: structuredClone(profile.execution),
            transport: {
                type: 'stdio',
                command: profile.transport.command,
                args: [...profile.transport.args],
                cwd: profile.transport.cwd,
                ...(profile.transport.fixedCwd ? { fixedCwd: profile.transport.fixedCwd } : {}),
                envNames: Object.keys(profile.transport.env).sort()
            }
        };
    }
    return {
        id: profile.id,
        name: profile.name,
        protocolVersion: profile.protocolVersion,
        execution: structuredClone(profile.execution),
        transport: {
            type: 'streamableHttp',
            url: profile.transport.url,
            headerNames: Object.keys(profile.transport.headers).sort(),
            cookies: profile.transport.cookies
        }
    };
}
