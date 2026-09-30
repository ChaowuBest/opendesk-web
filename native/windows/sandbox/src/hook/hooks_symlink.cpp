/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
// CreateSymbolicLinkW/A hook：
//  1) link 路径按 write、target 按 read 做策略判定（阻止符号链接逃逸到沙箱外，
//     与 junction（mklink /J）的按名判定同语义）；
//  2) 修正 Detours 注入环境下的"假成功"：kernelbase 的 CreateSymbolicLinkW 在
//     普通令牌（无符号链接特权）下返回 TRUE 却不创建任何对象（宿主同环境是
//     ERROR_PRIVILEGE_NOT_HELD）。校验产物真实存在，假成功按权限不足失败，
//     令沙箱行为与宿主一致（Node fs.symlinkSync -> EPERM，python -> WinError 1314）。
#include "hook.h"

#include "../common/hook_scope.h"
#include "../common/log.h"
#include "detours.h"

namespace sbx {

// -- Detour 目标（真实函数，dllmain.cpp 定义并 attach） -----------------------

// Real_CreateSymbolicLinkW/A 由 dllmain.cpp 定义初始化（Detour 目标），此处仅引用。

static std::wstring ansiToWide(LPCSTR s)
{
    if (!s) return L"";
    int n = MultiByteToWideChar(CP_ACP, 0, s, -1, nullptr, 0);
    if (n <= 0) return L"";
    std::wstring w((size_t)n - 1, L'\0');
    MultiByteToWideChar(CP_ACP, 0, s, -1, &w[0], n);
    return w;
}

// -- hook 实现 ----------------------------------------------------------------

BOOLEAN WINAPI Hook_CreateSymbolicLinkW(LPCWSTR lpSymlinkFileName, LPCWSTR lpTargetFileName, DWORD dwFlags)
{
    if (HookGuard::inHook() || !g_hooked || lpSymlinkFileName == nullptr)
        return Real_CreateSymbolicLinkW(lpSymlinkFileName, lpTargetFileName, dwFlags);
    HookGuard guard;

    DWORD err = ERROR_SUCCESS;
    if (!sandboxCheckPath(lpSymlinkFileName, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    if (lpTargetFileName && !sandboxCheckPath(lpTargetFileName, AccessClass::Read, err)) {
        SetLastError(err);
        return FALSE;
    }

    BOOL r = Real_CreateSymbolicLinkW(lpSymlinkFileName, lpTargetFileName, dwFlags);
    if (r) {
        // 假成功防护：kernelbase 在注入环境下可能返回 TRUE 但无任何产物，
        // 视同权限不足（与宿主行为一致）。
        if (GetFileAttributesW(lpSymlinkFileName) == INVALID_FILE_ATTRIBUTES) {
            SetLastError(ERROR_PRIVILEGE_NOT_HELD);
            return FALSE;
        }
    }
    return r;
}

BOOLEAN WINAPI Hook_CreateSymbolicLinkA(LPCSTR lpSymlinkFileName, LPCSTR lpTargetFileName, DWORD dwFlags)
{
    if (HookGuard::inHook() || !g_hooked || lpSymlinkFileName == nullptr)
        return Real_CreateSymbolicLinkA(lpSymlinkFileName, lpTargetFileName, dwFlags);
    HookGuard guard;

    std::wstring link = ansiToWide(lpSymlinkFileName);
    std::wstring target = ansiToWide(lpTargetFileName);

    DWORD err = ERROR_SUCCESS;
    if (!link.empty() && !sandboxCheckPath(link, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    if (!target.empty() && !sandboxCheckPath(target, AccessClass::Read, err)) {
        SetLastError(err);
        return FALSE;
    }

    BOOL r = Real_CreateSymbolicLinkA(lpSymlinkFileName, lpTargetFileName, dwFlags);
    if (r) {
        if (GetFileAttributesA(lpSymlinkFileName) == INVALID_FILE_ATTRIBUTES) {
            SetLastError(ERROR_PRIVILEGE_NOT_HELD);
            return FALSE;
        }
    }
    return r;
}

} // namespace sbx