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

import type {
    PluginAccountBackend,
    PluginAccountLoginFlowState,
    PluginAccountLoginMethod,
    PluginAccountSession,
    PluginAccountUser,
    PluginDisplayName
} from '../../../../packages/plugin-sdk/src/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : requiredString(value);
}

function normalizeDisplayName(value: unknown): PluginDisplayName | undefined {
    if (typeof value === 'string') return value.trim() || undefined;
    if (!isRecord(value)) return undefined;
    const entries = Object.entries(value).filter(
        ([locale, text]) => locale.trim().length > 0 && typeof text === 'string' && text.trim().length > 0
    );
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries.map(([locale, text]) => [locale, (text as string).trim()]));
}

function normalizeHttpUrl(value: unknown): string | undefined {
    const text = requiredString(value);
    if (!text) return undefined;
    try {
        const url = new URL(text);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

export function normalizeAccountUser(value: unknown): PluginAccountUser {
    if (!isRecord(value)) throw new Error('account:user_invalid');
    const id = requiredString(value.id);
    const username = requiredString(value.username);
    if (!id || !username) throw new Error('account:user_invalid');
    return {
        id,
        username,
        ...(optionalString(value.email) ? { email: optionalString(value.email) } : {}),
        ...(optionalString(value.display_name) ? { display_name: optionalString(value.display_name) } : {}),
        ...(optionalString(value.avatar_url) ? { avatar_url: optionalString(value.avatar_url) } : {})
    };
}

export function normalizeAccountSession(value: unknown, backend: PluginAccountBackend): PluginAccountSession {
    if (!isRecord(value)) throw new Error('account:session_invalid');
    const backendId = requiredString(value.backendId);
    const kind = value.kind === 'personal' || value.kind === 'enterprise' ? value.kind : undefined;
    const baseUrl = normalizeHttpUrl(value.baseUrl);
    if (backendId !== backend.id || !kind || !backend.kinds.includes(kind) || !baseUrl) {
        throw new Error('account:session_invalid');
    }
    return {
        backendId,
        kind,
        baseUrl,
        user: normalizeAccountUser(value.user)
    };
}

export function normalizeAccountLoginMethods(value: unknown): readonly PluginAccountLoginMethod[] {
    if (!Array.isArray(value)) throw new Error('account:login_methods_invalid');
    const ids = new Set<string>();
    return value.map((candidate) => {
        if (!isRecord(candidate)) throw new Error('account:login_methods_invalid');
        const id = requiredString(candidate.id);
        const displayName = normalizeDisplayName(candidate.displayName);
        if (!id || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(id) || ids.has(id) || !displayName) {
            throw new Error('account:login_methods_invalid');
        }
        ids.add(id);
        if (candidate.type === 'browser' || candidate.type === 'device-code') {
            return { id, type: candidate.type, displayName } as PluginAccountLoginMethod;
        }
        if (candidate.type !== 'form' || !Array.isArray(candidate.fields)) {
            throw new Error('account:login_methods_invalid');
        }
        const fieldIds = new Set<string>();
        const fields = candidate.fields.map((field) => {
            if (!isRecord(field)) throw new Error('account:login_methods_invalid');
            const fieldId = requiredString(field.id);
            const label = normalizeDisplayName(field.label);
            if (
                !fieldId ||
                !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(fieldId) ||
                fieldIds.has(fieldId) ||
                !label ||
                (field.type !== 'text' && field.type !== 'password' && field.type !== 'email') ||
                (field.required !== undefined && typeof field.required !== 'boolean')
            ) {
                throw new Error('account:login_methods_invalid');
            }
            fieldIds.add(fieldId);
            const placeholder = normalizeDisplayName(field.placeholder);
            const autocomplete = optionalString(field.autocomplete);
            return {
                id: fieldId,
                type: field.type,
                label,
                ...(placeholder ? { placeholder } : {}),
                ...(autocomplete ? { autocomplete } : {}),
                ...(field.required !== undefined ? { required: field.required } : {})
            };
        });
        return { id, type: 'form', displayName, fields } as PluginAccountLoginMethod;
    });
}

export function normalizeAccountLoginFlowState(
    value: unknown,
    backend: PluginAccountBackend
): PluginAccountLoginFlowState {
    if (!isRecord(value)) throw new Error('account:login_flow_state_invalid');
    if (value.status === 'ready') return { status: 'ready' };
    if (value.status === 'waiting') {
        const message = normalizeDisplayName(value.message);
        if (value.message !== undefined && !message) throw new Error('account:login_flow_state_invalid');
        return { status: 'waiting', ...(message ? { message } : {}) };
    }
    if (value.status === 'opening-browser') {
        const url = normalizeHttpUrl(value.url);
        if (!url) throw new Error('account:login_flow_state_invalid');
        return { status: 'opening-browser', url };
    }
    if (value.status === 'device-code') {
        const code = requiredString(value.code);
        const verificationUrl = normalizeHttpUrl(value.verificationUrl);
        if (!code || !verificationUrl) throw new Error('account:login_flow_state_invalid');
        return { status: 'device-code', code, verificationUrl };
    }
    if (value.status === 'completed') {
        return { status: 'completed', session: normalizeAccountSession(value.session, backend) };
    }
    if (value.status === 'failed') {
        const errorCode = requiredString(value.errorCode);
        if (!errorCode) throw new Error('account:login_flow_state_invalid');
        return { status: 'failed', errorCode };
    }
    throw new Error('account:login_flow_state_invalid');
}
