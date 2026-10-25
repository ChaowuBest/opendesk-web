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

import type { HuaweiLoginResult } from '../../common.js';
import type { HuaweiTokenResponse, HuaweiUserInfoResponse } from './types';

const TOKEN_ENDPOINT = 'https://oauth-api.cloud.huawei.com/openapi/rogue/v2/token';
const USERINFO_ENDPOINT = 'https://oauth-api.cloud.huawei.com/openapi/rogue/v2/userInfo';

/**
 * 使用 authCode 换取 access_token。
 * 需要 client_id 和 client_secret（从环境变量读取）。
 */
export async function exchangeAuthCode(
    loginResult: HuaweiLoginResult,
    clientId: string,
    clientSecret: string
): Promise<HuaweiTokenResponse> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: loginResult.authCode,
        client_id: clientId,
        client_secret: clientSecret
    });

    const resp = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Huawei token exchange failed: ${resp.status} ${text}`);
    }

    return (await resp.json()) as HuaweiTokenResponse;
}

/**
 * 使用 access_token 获取用户信息。
 */
export async function getUserInfo(accessToken: string): Promise<HuaweiUserInfoResponse> {
    const resp = await fetch(USERINFO_ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Huawei userInfo fetch failed: ${resp.status} ${text}`);
    }

    return (await resp.json()) as HuaweiUserInfoResponse;
}

/**
 * 使用 refresh_token 刷新 access_token。
 */
export async function refreshAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string
): Promise<HuaweiTokenResponse> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
    });

    const resp = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Huawei token refresh failed: ${resp.status} ${text}`);
    }

    return (await resp.json()) as HuaweiTokenResponse;
}
