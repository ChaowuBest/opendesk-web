/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "inject.h"

#include <vector>

namespace sbx {

bool injectHookDll(HANDLE hProcess, const std::wstring& dllPath, bool waitDone)
{
    // 架构一致性：仅支持同架构注入（64→64 / 32→32）。CreateRemoteThread 的
    // LoadLibraryW 地址按本进程 kernel32 基址解析；跨架构（如 64 位管理进程注入
    // 32 位目标）该地址在目标地址空间无效，线程入口指向垃圾地址会导致目标崩溃。
    // 检测到架构不匹配时优雅失败（由调用方决定后续处理），绝不硬注入。
    BOOL targetWow64 = FALSE;
    if (!IsWow64Process(hProcess, &targetWow64)) {
        return false;
    }
#if defined(_WIN64)
    if (targetWow64) {
        SetLastError(ERROR_NOT_SUPPORTED);
        return false;
    }
#else
    if (!targetWow64) {
        SetLastError(ERROR_NOT_SUPPORTED);
        return false;
    }
#endif

    // kernel32.dll 在所有 64 位进程以相同基址映射（系统共享镜像），
    // 因此本进程解析出的 LoadLibraryW 地址可直接用于同架构目标进程。
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC loadLibraryW = GetProcAddress(k32, "LoadLibraryW");
    if (!loadLibraryW) {
        SetLastError(ERROR_PROC_NOT_FOUND);
        return false;
    }

    size_t bytes = (dllPath.size() + 1) * sizeof(wchar_t);
    LPVOID remote = VirtualAllocEx(hProcess, nullptr, bytes,
                                   MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) return false;
    if (!WriteProcessMemory(hProcess, remote, dllPath.c_str(), bytes, nullptr)) {
        VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
        return false;
    }

    HANDLE thread = CreateRemoteThread(hProcess, nullptr, 0,
                                       (LPTHREAD_START_ROUTINE)loadLibraryW,
                                       remote, 0, nullptr);
    if (!thread) {
        VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
        return false;
    }
    DWORD waitResult = WAIT_OBJECT_0;
    if (waitDone) {
        // LoadLibrary 期间 DllMain 会安装 Detours hook；注入线程结束后
        // 进程再 resume，保证任何后续 API 调用都走已就绪的 hook。
        waitResult = WaitForSingleObject(thread, 60000);
        if (waitResult == WAIT_OBJECT_0) {
            // 远程线程的退出码即 LoadLibraryW 的返回值（模块句柄）；为 0 表示
            // DLL 加载失败（路径/依赖缺失）——此时 hook 并未安装，必须让调用方
            // 知道注入失败，否则子进程无管控地运行（静默降级）。
            DWORD exitCode = 0;
            if (!GetExitCodeThread(thread, &exitCode) || exitCode == 0) {
                CloseHandle(thread);
                VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
                SetLastError(ERROR_MOD_NOT_FOUND);
                return false;
            }
        }
    }
    CloseHandle(thread);
    VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
    return waitResult == WAIT_OBJECT_0;
}

} // namespace sbx