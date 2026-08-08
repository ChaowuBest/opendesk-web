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

export { createSafeAcpProfileSnapshot, resolveAcpTemplate, resolveAcpTemplateRecord } from '../../../common/acp.js';
export type { SafeAcpProfileSnapshot } from '../../../common/acp.js';

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
