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
 * Feishu Device Authorization Flow for one-click bot creation.
 *
 * Uses the endpoint POST https://accounts.feishu.cn/oauth/v1/app/registration
 * with three actions: init → begin → poll.
 *
 * After the user scans the QR code with the Feishu mobile app,
 * the server returns the newly created app's client_id and client_secret.
 */

import { getPlatform } from '../../../platforms/base.js';

const FEISHU_AUTH_BASE_URL = 'https://accounts.feishu.cn';
const REGISTRATION_PATH = '/oauth/v1/app/registration';

export interface FeishuInitResponse {
    nonce: string;
    supported_auth_methods: string[];
}

export interface FeishuBeginResponse {
    device_code: string;
    verification_uri: string;
    user_code: string;
    verification_uri_complete: string;
    interval?: number;
    expire_in?: number;
    expires_in?: number;
}

export interface FeishuPollResponse {
    client_id?: string;
    client_secret?: string;
    user_info?: { open_id?: string };
    error?: string;
    error_description?: string;
}

async function postRegistration(params: Record<string, string>): Promise<any> {
    const url = FEISHU_AUTH_BASE_URL + REGISTRATION_PATH;
    const body = new URLSearchParams(params).toString();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    try {
        const res = await getPlatform().fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: controller.signal
        });
        return await res.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function feishuAuthInit(): Promise<FeishuInitResponse> {
    return postRegistration({ action: 'init' });
}

export async function feishuAuthBegin(): Promise<FeishuBeginResponse> {
    return postRegistration({
        action: 'begin',
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id'
    });
}

export async function feishuAuthPoll(deviceCode: string): Promise<FeishuPollResponse> {
    return postRegistration({
        action: 'poll',
        device_code: deviceCode
    });
}
