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

import { resolveNativeBridge } from '../../main.js';
import type { HuaweiAccountKit, HuaweiLoginResult } from '../../common.js';
import { logger } from '../../../../main/utils/logger.js';
import { exchangeAuthCode, refreshAccessToken } from './huawei-id-verify.js';
import { loadSession, saveSession, deleteSession } from './token-store.js';
import type { UserSession } from './types';

const POLL_INTERVAL_MS = 200;

function getClientId(): string {
    return process.env.HUAWEI_CLIENT_ID ?? '';
}

function getClientSecret(): string {
    return process.env.HUAWEI_CLIENT_SECRET ?? '';
}

async function getAccountKit(): Promise<HuaweiAccountKit> {
    return resolveNativeBridge().getHuaweiAccountKit();
}

export class HuaweiAuthService {
    private cachedSession: UserSession | null = null;

    constructor() {
        this.cachedSession = loadSession();
    }

    /** 是否支持华为账号登录 */
    async isAvailable(): Promise<boolean> {
        try {
            const kit = await getAccountKit();
            return await kit.available();
        } catch {
            return false;
        }
    }

    /** 获取当前会话（内存缓存优先） */
    getSession(): UserSession | null {
        if (this.cachedSession) {
            if (this.cachedSession.expiresAt > Date.now()) {
                return this.cachedSession;
            }
        }
        return null;
    }

    /**
     * 发起华为账号登录。
     * 调用 HarmonyOS AccountKit 拉起登录窗口，轮询获取结果，
     * 然后用 authCode 换取 accessToken。
     */
    async login(): Promise<UserSession> {
        const kit = await getAccountKit();
        if (!(await kit.available())) {
            throw new Error('Huawei account login is not available on this platform');
        }

        // 1. 拉起登录窗口
        await kit.startLogin();
        logger.info('Huawei login window opened, polling for result...');

        // 2. 轮询获取登录结果
        const loginResult = await this.pollLoginResult(kit);
        if (!loginResult.status) {
            throw new Error('Huawei login failed or was cancelled');
        }

        logger.info('Huawei login successful, exchanging authCode for access token...');

        // 3. 用 authCode 换取 accessToken
        const clientId = getClientId();
        const clientSecret = getClientSecret();
        if (!clientId || !clientSecret) {
            logger.warn('HUAWEI_CLIENT_ID/HUAWEI_CLIENT_SECRET not set, storing raw login result');
            // 无 client credentials 时，直接使用 idToken 作为临时 session
            const session: UserSession = {
                accessToken: loginResult.idToken,
                refreshToken: '',
                expiresAt: Date.now() + 3600_000,
                unionId: loginResult.unionId,
                openId: loginResult.openId,
                anonymousPhone: loginResult.anonymousPhone
            };
            this.cachedSession = session;
            saveSession(session);
            return session;
        }

        const tokenResponse = await exchangeAuthCode(loginResult, clientId, clientSecret);
        const session: UserSession = {
            accessToken: tokenResponse.access_token,
            refreshToken: tokenResponse.refresh_token,
            expiresAt: Date.now() + tokenResponse.expires_in * 1000,
            unionId: loginResult.unionId,
            openId: loginResult.openId,
            anonymousPhone: loginResult.anonymousPhone
        };

        this.cachedSession = session;
        saveSession(session);
        logger.info('Huawei auth session created and persisted');
        return session;
    }

    /** 刷新 access_token */
    async refreshToken(): Promise<UserSession> {
        if (!this.cachedSession || !this.cachedSession.refreshToken) {
            throw new Error('No session or refresh token available');
        }

        const clientId = getClientId();
        const clientSecret = getClientSecret();
        if (!clientId || !clientSecret) {
            throw new Error('HUAWEI_CLIENT_ID/HUAWEI_CLIENT_SECRET not set');
        }

        const tokenResponse = await refreshAccessToken(this.cachedSession.refreshToken, clientId, clientSecret);

        const session: UserSession = {
            accessToken: tokenResponse.access_token,
            refreshToken: this.cachedSession.refreshToken,
            expiresAt: Date.now() + tokenResponse.expires_in * 1000,
            unionId: this.cachedSession.unionId,
            openId: this.cachedSession.openId,
            anonymousPhone: this.cachedSession.anonymousPhone
        };

        this.cachedSession = session;
        saveSession(session);
        logger.info('Huawei auth session refreshed');
        return session;
    }

    /** 登出，清除会话 */
    async logout(): Promise<void> {
        try {
            const kit = await getAccountKit();
            await kit.closeLogin();
        } catch {
            /* ignore */
        }
        this.cachedSession = null;
        deleteSession();
        logger.info('Huawei auth session cleared');
    }

    /** 轮询获取登录结果（不超时，弹窗保持直到用户完成登录或主动退出应用） */
    private async pollLoginResult(kit: HuaweiAccountKit): Promise<HuaweiLoginResult> {
        for (;;) {
            const result = await kit.peekLogin();
            if (result) {
                return result;
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
    }
}

// 单例
let authServiceInstance: HuaweiAuthService | null = null;

export function getHuaweiAuthService(): HuaweiAuthService {
    if (!authServiceInstance) {
        authServiceInstance = new HuaweiAuthService();
    }
    return authServiceInstance;
}
