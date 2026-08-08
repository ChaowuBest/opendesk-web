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

import { z } from 'zod';

const EnvironmentRecordSchema = z.record(z.string(), z.string()).default({});

const StdioTransportSchema = z
    .object({
        type: z.literal('stdio'),
        command: z.string().trim().min(1),
        args: z.array(z.string()).default([]),
        cwd: z.enum(['workspace', 'fixed']).default('workspace'),
        fixedCwd: z.string().trim().min(1).optional(),
        env: EnvironmentRecordSchema,
        inheritEnv: z.boolean().default(true)
    })
    .superRefine((transport, context) => {
        if (transport.cwd === 'fixed' && !transport.fixedCwd) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['fixedCwd'],
                message: 'fixedCwd is required when cwd is fixed'
            });
        }
    });

const HttpUrlSchema = z
    .string()
    .url()
    .superRefine((value, context) => {
        const protocol = new URL(value).protocol;
        if (protocol !== 'http:' && protocol !== 'https:') {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Streamable HTTP URL must use HTTP or HTTPS'
            });
        }
    });

const StreamableHttpTransportSchema = z.object({
    type: z.literal('streamableHttp'),
    url: HttpUrlSchema,
    headers: EnvironmentRecordSchema,
    cookies: z.enum(['include', 'omit']).default('include')
});

export const AcpTransportSchema = z.union([StdioTransportSchema, StreamableHttpTransportSchema]);

const SessionValueSchema = z.union([z.string(), z.boolean()]);

export const AcpAgentProfileSchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    dispatchable: z.boolean().default(false),
    whenToUse: z.string().default(''),
    transport: AcpTransportSchema,
    session: z
        .object({
            modeId: z.string().trim().min(1).optional(),
            configOptions: z.record(z.string(), SessionValueSchema).default({}),
            mcpServerIds: z.array(z.string()).default([])
        })
        .default({ configOptions: {}, mcpServerIds: [] }),
    reconnect: z
        .object({
            enabled: z.boolean().default(true),
            maxAttempts: z.number().int().min(0).max(20).default(3),
            initialDelayMs: z.number().int().min(0).max(60_000).default(500),
            maxDelayMs: z.number().int().min(0).max(300_000).default(5_000)
        })
        .default({ enabled: true, maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5_000 })
});

export const AcpMgrConfigSchema = z.object({
    agents: z.array(AcpAgentProfileSchema).default([])
});

export type AcpAgentProfile = z.output<typeof AcpAgentProfileSchema>;
export type AcpTransport = AcpAgentProfile['transport'];
export type AcpMgrConfig = z.output<typeof AcpMgrConfigSchema>;

export type SafeAcpProfileSnapshot = {
    id: string;
    name: string;
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

export function resolveAcpTemplate(value: string, environ: NodeJS.ProcessEnv): string {
    return value.replace(ENVIRONMENT_TEMPLATE_PATTERN, (_match, name: string) => {
        const replacement = environ[name];
        if (replacement === undefined) {
            throw new Error(`Missing environment variable ${name}`);
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
        transport: {
            type: 'streamableHttp',
            url: profile.transport.url,
            headerNames: Object.keys(profile.transport.headers).sort(),
            cookies: profile.transport.cookies
        }
    };
}
