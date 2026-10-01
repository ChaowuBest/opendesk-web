/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "hook.h"
#include "inject.h"

#include "../common/log.h"
#include "../common/utf.h"
#include "detours.h"

namespace sbx {

// 从 lpApplicationName / lpCommandLine 解析待启动的 exe 绝对路径。
// 无法解析（裸文件名且 PATH 找不到）返回空串——调用方按放行处理。
static std::wstring resolveExePath(LPCWSTR lpApplicationName, LPCWSTR lpCommandLine)
{
    std::wstring exe;
    if (lpApplicationName && *lpApplicationName) {
        exe = lpApplicationName;
    } else if (lpCommandLine && *lpCommandLine) {
        const wchar_t* p = lpCommandLine;
        while (*p == L' ' || *p == L'\t') p++;
        if (*p == L'"') {
            p++;
            const wchar_t* end = wcschr(p, L'"');
            if (end) exe.assign(p, end);
            else exe = p;
        } else {
            const wchar_t* end = p;
            while (*end && *end != L' ') end++;
            exe.assign(p, end);
        }
    }
    if (exe.empty()) return L"";
    // 去掉引号
    if (exe.size() >= 2 && exe.front() == L'"' && exe.back() == L'"')
        exe = exe.substr(1, exe.size() - 2);
    // 裸文件名（无路径分隔符）：用 SearchPath 解析（不读文件内容，安全）
    if (exe.find_first_of(L"\\/") == std::wstring::npos) {
        wchar_t found[MAX_PATH];
        DWORD n = SearchPathW(nullptr, exe.c_str(), L".exe", MAX_PATH, found, nullptr);
        if (n > 0 && n < MAX_PATH) exe = found;
        else return L"";   // PATH 找不到：放行（不判定）
    }
    return exe;
}

// 递归注入：判定通过后，以 CREATE_SUSPENDED 创建后代进程并注入本 hook DLL，
// 注入完成后（hook 就绪）再 resume。hook DLL 路径来自本 DLL 自身。
// 注意：MSYS2/cygwin 的 fork 用 CreateProcess 创建"自身镜像副本"（CREATE_SUSPENDED
// 后复制内存再 resume）。对该中间进程注入会破坏 fork 的复制语义导致子进程卡死
// （实测 ls/rm 挂起）。因此目标 exe 与当前进程相同时跳过注入（fork 中间进程
// 保持干净；其后的 cygwin exec 会替换镜像，Detours patch 随之消失——cygwin
// 外部程序不受管控是 Detours 用户态机制的已知边界）。
static BOOL createProcessWithHook(LPCWSTR lpApplicationName, LPWSTR lpCommandLine,
                                  LPSECURITY_ATTRIBUTES lpProcessAttributes,
                                  LPSECURITY_ATTRIBUTES lpThreadAttributes,
                                  BOOL bInheritHandles, DWORD dwCreationFlags,
                                  LPVOID lpEnvironment, LPCWSTR lpCurrentDirectory,
                                  LPSTARTUPINFOW lpStartupInfo,
                                  LPPROCESS_INFORMATION lpProcessInformation)
{
    wchar_t dllPath[MAX_PATH];
    DWORD n = GetModuleFileNameW(GetModuleHandleW(L"sandbox_hook.dll"), dllPath, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) {
        SetLastError(ERROR_MOD_NOT_FOUND);
        return FALSE;
    }

    // 目标 exe 与当前进程相同：MSYS2/cygwin 的 fork 用 CreateProcess 创建"自身
    // 镜像副本"（子进程以特殊 fork 模式启动后挂起自身，父进程复制内存再 resume），
    // 对该中间进程注入会破坏 fork 的复制语义导致子进程卡死。cygwin 的 fork
    // CreateProcess **不带 CREATE_SUSPENDED**（flags 0x420 等，由子进程自行挂起），
    // 单靠"同 exe + CREATE_SUSPENDED"无法命中，实测命令替换/管道/后台全部挂起。
    // 判定依据：当前进程加载了 cygwin1.dll（MSYS2/cygwin 程序）且目标是自身
    // 镜像 → 视为 fork/exec 中间进程，跳过注入（中间进程保持干净；cygwin exec
    // 随后替换镜像，Detours patch 消失——cygwin 外部程序不受管控是已知边界）。
    // node/python 等 Win32 原生进程不加载 cygwin1.dll，其"同 exe 子进程"
    // （spawnSync 等）不受影响，仍按 CREATE_SUSPENDED 判定注入，保持递归管控。
    std::wstring target = resolveExePath(lpApplicationName, lpCommandLine);
    // cygwin 目标不注入：MSYS2/Git 目录的程序（bash/ls/rm 等 cygwin 二进制）
    // 与 detours patch 机制性冲突（fork 复制被 patch 的内存 → wait 挂死），
    // 且其主进程本身已由 runner 跳过注入；此处兜底"Win32 进程启动 cygwin
    // 程序"的路径（node/python 内调 bash 等），避免把 cygwin 目标注入破坏 fork。
    // 代价：cygwin 程序 IO 不受管控（README 已知边界，引导用 Win32 等价物）。
    {
        const std::wstring& t = target;
        if (t.find(L"\\Git\\") != std::wstring::npos ||
            t.find(L"\\usr\\bin\\") != std::wstring::npos ||
            t.find(L"msys64") != std::wstring::npos) {
            return Real_CreateProcessW(lpApplicationName, lpCommandLine, lpProcessAttributes,
                                       lpThreadAttributes, bInheritHandles, dwCreationFlags,
                                       lpEnvironment, lpCurrentDirectory, lpStartupInfo,
                                       lpProcessInformation);
        }
    }
    HMODULE cygwin = GetModuleHandleW(L"cygwin1.dll");
    if (!target.empty()) {
        wchar_t self[MAX_PATH];
        DWORD sn = GetModuleFileNameW(nullptr, self, MAX_PATH);
        if (sn > 0 && sn < MAX_PATH &&
            _wcsicmp(target.c_str(), self) == 0 &&
            (cygwin != nullptr || (dwCreationFlags & CREATE_SUSPENDED) != 0)) {
            return Real_CreateProcessW(lpApplicationName, lpCommandLine, lpProcessAttributes,
                                       lpThreadAttributes, bInheritHandles, dwCreationFlags,
                                       lpEnvironment, lpCurrentDirectory, lpStartupInfo,
                                       lpProcessInformation);
        }
    }

    DWORD flags = dwCreationFlags | CREATE_SUSPENDED;
    if (!Real_CreateProcessW(lpApplicationName, lpCommandLine, lpProcessAttributes,
                             lpThreadAttributes, bInheritHandles, flags,
                             lpEnvironment, lpCurrentDirectory, lpStartupInfo,
                             lpProcessInformation)) {
        return FALSE;
    }
    if (!injectHookDll(lpProcessInformation->hProcess, dllPath)) {
        // 注入失败（常见于系统目录进程/受保护进程）：不终止后代——那会连坐
        // 中断父进程的正常启动流程（如 PowerShell 的 Process.Start）。后代
        // 不受管控是已知降级，记录诊断；父进程继续运行。
        Log::warn(L"[HOOK] 后代注入失败(%lu)，后代不受管控: %ls",
                  GetLastError(), dllPath);
        ResumeThread(lpProcessInformation->hThread);
        return TRUE;
    }
    if (!(dwCreationFlags & CREATE_SUSPENDED)) {
        ResumeThread(lpProcessInformation->hThread);
    }
    return TRUE;
}

BOOL WINAPI Hook_CreateProcessW(LPCWSTR lpApplicationName, LPWSTR lpCommandLine,
                                LPSECURITY_ATTRIBUTES lpProcessAttributes,
                                LPSECURITY_ATTRIBUTES lpThreadAttributes,
                                BOOL bInheritHandles, DWORD dwCreationFlags,
                                LPVOID lpEnvironment, LPCWSTR lpCurrentDirectory,
                                LPSTARTUPINFOW lpStartupInfo,
                                LPPROCESS_INFORMATION lpProcessInformation)
{
    if (HookGuard::inHook() || !g_hooked)
        return Real_CreateProcessW(lpApplicationName, lpCommandLine, lpProcessAttributes,
                                   lpThreadAttributes, bInheritHandles, dwCreationFlags,
                                   lpEnvironment, lpCurrentDirectory, lpStartupInfo,
                                   lpProcessInformation);
    HookGuard guard;

    std::wstring exePath = resolveExePath(lpApplicationName, lpCommandLine);
    if (!exePath.empty()) {
        DWORD err = ERROR_SUCCESS;
        if (!sandboxCheckPath(exePath, AccessClass::Execute, err)) {
            SetLastError(err);
            return FALSE;
        }
    }
    return createProcessWithHook(lpApplicationName, lpCommandLine, lpProcessAttributes,
                                 lpThreadAttributes, bInheritHandles, dwCreationFlags,
                                 lpEnvironment, lpCurrentDirectory, lpStartupInfo,
                                 lpProcessInformation);
}

BOOL WINAPI Hook_CreateProcessA(LPCSTR lpApplicationName, LPSTR lpCommandLine,
                                LPSECURITY_ATTRIBUTES lpProcessAttributes,
                                LPSECURITY_ATTRIBUTES lpThreadAttributes,
                                BOOL bInheritHandles, DWORD dwCreationFlags,
                                LPVOID lpEnvironment, LPCSTR lpCurrentDirectory,
                                LPSTARTUPINFOA lpStartupInfo,
                                LPPROCESS_INFORMATION lpProcessInformation)
{
    if (HookGuard::inHook() || !g_hooked)
        return Real_CreateProcessA(lpApplicationName, lpCommandLine, lpProcessAttributes,
                                   lpThreadAttributes, bInheritHandles, dwCreationFlags,
                                   lpEnvironment, lpCurrentDirectory, lpStartupInfo,
                                   lpProcessInformation);
    HookGuard guard;

    // 窄字符 -> 宽字符解析 exe 路径（判定用）
    std::wstring appWide = lpApplicationName ? ansiToWide(lpApplicationName) : L"";
    std::wstring cmdWide = lpCommandLine ? ansiToWide(lpCommandLine) : L"";
    std::wstring exePath = resolveExePath(appWide.empty() ? nullptr : appWide.c_str(),
                                          cmdWide.empty() ? nullptr : cmdWide.c_str());
    if (!exePath.empty()) {
        DWORD err = ERROR_SUCCESS;
        if (!sandboxCheckPath(exePath, AccessClass::Execute, err)) {
            SetLastError(err);
            return FALSE;
        }
    }
    // 窄字符版无直接注入路径：转调宽字符注入（命令行按原样传给宽 API 会改变
    // 8 位字符语义——这里退化为：判定通过后原样调用 Real_CreateProcessA（无注入），
    // 后代进程不受管控（32 位 ANSI 程序的已知限制）。
    return Real_CreateProcessA(lpApplicationName, lpCommandLine, lpProcessAttributes,
                               lpThreadAttributes, bInheritHandles, dwCreationFlags,
                               lpEnvironment, lpCurrentDirectory, lpStartupInfo,
                               lpProcessInformation);
}

} // namespace sbx