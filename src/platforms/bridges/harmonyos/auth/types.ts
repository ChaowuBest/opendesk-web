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

/** 用户会话信息 */
export interface UserSession {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    unionId: string;
    openId: string;
    anonymousPhone: string;
}

/** 华为 OAuth2 token 响应 */
export interface HuaweiTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
}

/** 华为 OAuth2 用户信息响应 */
export interface HuaweiUserInfoResponse {
    unionId: string;
    openId: string;
    displayName?: string;
    email?: string;
    mobile?: string;
}

/** 持久化存储的会话结构 */
export interface StoredSession extends UserSession {
    version: 1;
    createdAtMs: number;
}
