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
    PluginAccountKind,
    PluginAccountSession,
    PluginAccountUser
} from '../../../../packages/plugin-sdk/src/index.js';

/**
 * 账号接入相关类型定义。
 *
 * 账号系统与 OpenDesk 后端解耦接入：个人账号与企业管理账号共用同一套后端实现，
 * 区别仅在于 base_url 的来源——个人账号使用配置文件中的默认后端地址，企业账号
 * 需要用户在登录时手动输入 base_url（私有化部署地址）。
 */

/** 账号来源类型。 */
export type AccountKind = PluginAccountKind;

/** 登录模式，由向导写入配置。 */
export type AccountMode = 'personal' | 'enterprise' | 'nologin';

/** 登录用户信息（对齐后端 UserOut 的常用字段）。 */
export type AccountUser = PluginAccountUser;

/** 当前账号会话。 */
export type AccountSession = PluginAccountSession;

export interface AccountConfig {
    mode: AccountMode;
    default_base_url: string;
    enterprise_base_url: string;
}
