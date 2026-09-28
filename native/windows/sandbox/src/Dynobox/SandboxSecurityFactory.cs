/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

namespace Dynobox;

/// <summary>沙箱隔离机制选择：
///   appcontainer（默认）——lowbox 门 + package SID ACE；在本机（26220）实测可用；
///   restricted ——受限令牌 + 显式 ACL 白名单；内核对带 restricting SID 的
///   CreateRestrictedToken 直接返回 ERROR_INVALID_PARAMETER（26220 实测），
///   在支持的系统上作为替代实现启用。</summary>
public static class SandboxSecurityFactory
{
    public static ISandboxSecurity Create(string mode = "appcontainer") => mode switch
    {
        "restricted" => new RestrictedTokenSecurity(),
        _ => new SandboxSecurity(),
    };
}
