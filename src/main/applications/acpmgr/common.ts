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
import path from 'node:path';

export {
    AcpEnvironmentVariableError,
    createSafeAcpProfileSnapshot,
    resolveAcpTemplate,
    resolveAcpTemplateRecord
} from './runtime/profile.js';
export type { SafeAcpProfileSnapshot } from './runtime/profile.js';

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

const AcpMcpBindingSchema = z.object({
    serverId: z.string().trim().min(1),
    location: z.enum(['agent', 'client']).default('agent')
});

const RemotePlatformSchema = z.enum(['posix', 'windows']);

function isAbsoluteForPlatform(value: string, platform: z.output<typeof RemotePlatformSchema>): boolean {
    return platform === 'windows' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

const AgentWorkspaceSchema = z
    .discriminatedUnion('strategy', [
        z.object({ strategy: z.literal('legacy') }),
        z.object({
            strategy: z.literal('fixed'),
            path: z.string().trim().min(1),
            platform: RemotePlatformSchema.default('posix')
        }),
        z.object({
            strategy: z.literal('mapped'),
            localRoot: z.string().trim().min(1),
            remoteRoot: z.string().trim().min(1),
            platform: RemotePlatformSchema.default('posix')
        })
    ])
    .superRefine((workspace, context) => {
        if (workspace.strategy === 'fixed' && !isAbsoluteForPlatform(workspace.path, workspace.platform)) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'Remote cwd must be absolute' });
        }
        if (workspace.strategy === 'mapped') {
            if (!path.isAbsolute(workspace.localRoot)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['localRoot'],
                    message: 'Local mapping root must be absolute'
                });
            }
            if (!isAbsoluteForPlatform(workspace.remoteRoot, workspace.platform)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['remoteRoot'],
                    message: 'Remote mapping root must be absolute'
                });
            }
        }
    });

const ClientWorkspaceSchema = z
    .discriminatedUnion('strategy', [
        z.object({ strategy: z.literal('task') }),
        z.object({ strategy: z.literal('fixed'), path: z.string().trim().min(1) })
    ])
    .superRefine((workspace, context) => {
        if (workspace.strategy === 'fixed' && !path.isAbsolute(workspace.path)) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'Client cwd must be absolute' });
        }
    });

const AgentSessionCwdSchema = z
    .object({
        path: z.string().trim().min(1),
        platform: RemotePlatformSchema.default('posix')
    })
    .superRefine((value, context) => {
        if (!isAbsoluteForPlatform(value.path, value.platform)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['path'],
                message: 'Agent session cwd must be absolute'
            });
        }
    });

export const AcpExecutionSchema = z.discriminatedUnion('location', [
    z.object({ location: z.literal('agent'), workspace: AgentWorkspaceSchema }),
    z.object({
        location: z.literal('client'),
        workspace: ClientWorkspaceSchema,
        compatibility: z.enum(['preferred', 'required']).default('preferred'),
        agentSessionCwd: AgentSessionCwdSchema.optional()
    })
]);

const AcpSessionSchema = z
    .object({
        authMethodId: z.string().trim().min(1).optional(),
        modeId: z.string().trim().min(1).optional(),
        configOptions: z.record(z.string(), SessionValueSchema).default({}),
        mcpBindings: z.array(AcpMcpBindingSchema).optional(),
        mcpServerIds: z.array(z.string()).default([])
    })
    .transform(({ mcpServerIds, mcpBindings, ...session }) => ({
        ...session,
        mcpBindings: mcpBindings ?? mcpServerIds.map((serverId) => ({ serverId, location: 'agent' as const }))
    }));

const AcpTimeoutsSchema = z
    .object({
        connectMs: z.number().int().min(100).max(300_000).default(30_000),
        promptMs: z.number().int().min(100).max(86_400_000).default(1_800_000)
    })
    .default({ connectMs: 30_000, promptMs: 1_800_000 });

export const AcpAgentProfileSchema = z
    .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1),
        enabled: z.boolean().default(true),
        dispatchable: z.boolean().default(false),
        whenToUse: z.string().default(''),
        protocolVersion: z.union([z.literal(1), z.literal(2)]).default(1),
        transport: AcpTransportSchema,
        execution: AcpExecutionSchema.optional(),
        session: AcpSessionSchema.optional(),
        timeouts: AcpTimeoutsSchema,
        reconnect: z
            .object({
                enabled: z.boolean().default(true),
                maxAttempts: z.number().int().min(0).max(20).default(3),
                initialDelayMs: z.number().int().min(0).max(60_000).default(500),
                maxDelayMs: z.number().int().min(0).max(300_000).default(5_000)
            })
            .default({ enabled: true, maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5_000 })
    })
    .superRefine((profile, context) => {
        if (
            profile.protocolVersion === 2 &&
            profile.transport.type === 'streamableHttp' &&
            profile.execution?.location === 'client' &&
            !profile.execution.agentSessionCwd
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['execution', 'agentSessionCwd'],
                message: 'ACP v2 Client-hosted execution requires an Agent session cwd'
            });
        }
    })
    .transform((profile) => ({
        ...profile,
        session: profile.session ?? { configOptions: {}, mcpBindings: [] },
        execution:
            profile.execution ??
            (profile.transport.type === 'stdio'
                ? ({
                      location: 'client',
                      workspace: { strategy: 'task' },
                      compatibility: 'preferred'
                  } as const)
                : ({ location: 'agent', workspace: { strategy: 'legacy' } } as const))
    }));

const AcpAgentProfilesSchema = z
    .array(AcpAgentProfileSchema)
    .default([])
    .superRefine((profiles, context) => {
        const seen = new Set<string>();
        profiles.forEach((profile, index) => {
            if (seen.has(profile.id)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [index, 'id'],
                    message: `Duplicate ACP agent id: ${profile.id}`
                });
            }
            seen.add(profile.id);
        });
    });

export const AcpMgrConfigSchema = z.object({
    agents: AcpAgentProfilesSchema
});

export type AcpAgentProfile = z.output<typeof AcpAgentProfileSchema>;
export type AcpTransport = AcpAgentProfile['transport'];
export type AcpMgrConfig = z.output<typeof AcpMgrConfigSchema>;
