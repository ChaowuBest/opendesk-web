/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "hook.h"

#include "../common/log.h"
#include "../common/paths.h"
#include "../common/toml.h"
#include "../common/hook_scope.h"
#include "detours.h"

// 本 DLL 内需要与 Detours 对接的真实函数指针（hooks_*.cpp 定义 Hook_* 实现）
extern "C" {
    HANDLE (WINAPI *Real_CreateFileW)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE) = CreateFileW;
    HANDLE (WINAPI *Real_CreateFileA)(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE) = CreateFileA;
    DWORD (WINAPI *Real_GetFileAttributesW)(LPCWSTR) = GetFileAttributesW;
    DWORD (WINAPI *Real_GetFileAttributesA)(LPCSTR) = GetFileAttributesA;
    HANDLE (WINAPI *Real_FindFirstFileW)(LPCWSTR, LPWIN32_FIND_DATAW) = FindFirstFileW;
    HANDLE (WINAPI *Real_FindFirstFileA)(LPCSTR, LPWIN32_FIND_DATAA) = FindFirstFileA;
    BOOL (WINAPI *Real_CreateDirectoryW)(LPCWSTR, LPSECURITY_ATTRIBUTES) = CreateDirectoryW;
    BOOL (WINAPI *Real_CreateDirectoryA)(LPCSTR, LPSECURITY_ATTRIBUTES) = CreateDirectoryA;
    BOOL (WINAPI *Real_DeleteFileW)(LPCWSTR) = DeleteFileW;
    BOOL (WINAPI *Real_DeleteFileA)(LPCSTR) = DeleteFileA;
    BOOL (WINAPI *Real_RemoveDirectoryW)(LPCWSTR) = RemoveDirectoryW;
    BOOL (WINAPI *Real_RemoveDirectoryA)(LPCSTR) = RemoveDirectoryA;
    BOOL (WINAPI *Real_MoveFileW)(LPCWSTR, LPCWSTR) = MoveFileW;
    BOOL (WINAPI *Real_MoveFileA)(LPCSTR, LPCSTR) = MoveFileA;
    BOOL (WINAPI *Real_MoveFileExW)(LPCWSTR, LPCWSTR, DWORD) = MoveFileExW;
    BOOL (WINAPI *Real_MoveFileExA)(LPCSTR, LPCSTR, DWORD) = MoveFileExA;
    BOOL (WINAPI *Real_CopyFileW)(LPCWSTR, LPCWSTR, BOOL) = CopyFileW;
    BOOL (WINAPI *Real_CopyFileA)(LPCSTR, LPCSTR, BOOL) = CopyFileA;
    BOOL (WINAPI *Real_CopyFileExW)(LPCWSTR, LPCWSTR, LPPROGRESS_ROUTINE, LPVOID, LPBOOL, DWORD) = CopyFileExW;
    BOOL (WINAPI *Real_SetFileAttributesW)(LPCWSTR, DWORD) = SetFileAttributesW;
    BOOL (WINAPI *Real_SetFileAttributesA)(LPCSTR, DWORD) = SetFileAttributesA;
    BOOL (WINAPI *Real_SetFileInformationByHandle)(HANDLE, FILE_INFO_BY_HANDLE_CLASS, LPVOID, DWORD) = SetFileInformationByHandle;
    // CreateSymbolicLinkW/A：直接取 kernelbase 真实函数。链接符号会解析到 kernel32
    // 的"转发 stub"（jmp 型指令），Detour 无法为它生成 trampoline（attach 被忽略、
    // 静默失效）；stub 最终跳转到 kernelbase 真实函数，patch 真实函数即可拦截。
    BOOLEAN (WINAPI *Real_CreateSymbolicLinkW)(LPCWSTR, LPCWSTR, DWORD) = nullptr;
    BOOLEAN (WINAPI *Real_CreateSymbolicLinkA)(LPCSTR, LPCSTR, DWORD) = nullptr;
    BOOL (WINAPI *Real_CreateProcessW)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION) = CreateProcessW;
    BOOL (WINAPI *Real_CreateProcessA)(LPCSTR, LPSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCSTR, LPSTARTUPINFOA, LPPROCESS_INFORMATION) = CreateProcessA;
}

namespace sbx {

bool g_hooked = false;
bool g_delToTrash = false;
Policy g_policy;

// 沙箱会话开始时刻（FILETIME，runner 经 DYNOBOX_SESSION_START 注入）；0 表示未设置。
static unsigned __int64 g_sessionStartFiletime = 0;

// 判断路径是否沙箱会话内创建（文件创建时间 >= 会话开始时间）。
// 会话内创建的文件删除 = 自发清理：不 ask、不进回收站，直接删除。
bool sandboxSessionCreated(const std::wstring& hostPath)
{
    if (g_sessionStartFiletime == 0) return false;
    std::wstring p = hostPath;
    if (p.rfind(L"\\\\?\\UNC\\", 0) == 0) p = L"\\\\" + p.substr(8);
    else if (p.rfind(L"\\\\?\\", 0) == 0) p = p.substr(4);
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(p.c_str(), GetFileExInfoStandard, &fad)) return false;
    ULARGE_INTEGER created;
    created.LowPart = fad.ftCreationTime.dwLowDateTime;
    created.HighPart = fad.ftCreationTime.dwHighDateTime;
    return created.QuadPart >= g_sessionStartFiletime;
}

// hooks_nt.cpp：ntdll 层 hook 安装（cygwin/bash 直调 NtCreateFile 等）
void installNtHooks();

__declspec(thread) bool HookGuard::active = false;

// -- 判定入口 ----------------------------------------------------------------

bool isSpecialDevicePath(const std::wstring& path)
{
    if (path.empty()) return true;
    // 虚设备：\\.\* 与 \\?\*
    if (path.rfind(L"\\\\.\\", 0) == 0) return true;
    if (path.rfind(L"\\\\?\\", 0) == 0) {
        // \\?\UNC\... 与 \\?\X:\... 是文件路径（GetFinalPathNameByHandle 返回此格式，
        // 必须参与策略判定）；其余（\\?\pipe\、\\?\GLOBALROOT 等）是虚设备
        bool isFilePrefix = path.rfind(L"\\\\?\\UNC\\", 0) == 0 ||
            (path.size() > 6 && iswalpha(path[4]) && path[5] == L':');
        if (!isFilePrefix) return true;
    }
    if (path.rfind(L"\\??\\", 0) == 0) return true;
    if (path.rfind(L"\\Device\\", 0) == 0) return true;
    // 保留设备名：NUL / CON / PRN / AUX / CONIN$ / CONOUT$ / CONERR$ / COM1..9 / LPT1..9。
    // 设备名在任意目录层级都保留（CreateFileW("C:\\x\\NUL") 打开的是设备而非文件）——
    // 取末段（最后一个分隔符之后）判定，Node/PowerShell 的相对 'NUL' 会被
    // GetFullPathName 展开成绝对路径，必须同样放行，否则会实体化普通文件。
    std::wstring last = path;
    {
        std::wstring::size_type sep = path.find_last_of(L"\\/");
        if (sep != std::wstring::npos) last = path.substr(sep + 1);
    }
    {
        std::wstring up;
        for (wchar_t c : last) up.push_back((wchar_t)towupper(c));
        if (up == L"NUL" || up == L"CON" || up == L"PRN" || up == L"AUX" ||
            up == L"CONIN$" || up == L"CONOUT$" || up == L"CONERR$") return true;
        if (up.size() == 4 && (up.rfind(L"COM", 0) == 0 || up.rfind(L"LPT", 0) == 0) &&
            up[3] >= L'1' && up[3] <= L'9') return true;
        if (up.size() == 5 && up.rfind(L"COM", 0) == 0 && up[3] >= L'1' && up[3] <= L'9')
            return true;   // COM10..99
    }
    return false;
}

AccessClass categorizeCreateAccess(DWORD desiredAccess, DWORD creationDisposition)
{
    const DWORD writeBits = GENERIC_WRITE | FILE_WRITE_DATA | FILE_APPEND_DATA |
                            FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA | DELETE;
    const DWORD execBits = GENERIC_EXECUTE | FILE_EXECUTE;
    bool write = (desiredAccess & writeBits) != 0 ||
                 creationDisposition == CREATE_NEW ||
                 creationDisposition == CREATE_ALWAYS ||
                 creationDisposition == TRUNCATE_EXISTING ||
                 creationDisposition == OPEN_ALWAYS;
    bool exec = (desiredAccess & execBits) != 0;
    if (write) return AccessClass::Write;
    if (exec) return AccessClass::Execute;
    return AccessClass::Read;
}

bool sandboxCheckPath(const std::wstring& hostPath, AccessClass access, DWORD& winErr)
{
    winErr = ERROR_SUCCESS;
    // ask 传输内部线程（WinHTTP 文件操作）抑制 hook，避免递归 ask 风暴
    if (HookScope::active) return true;
    if (isSpecialDevicePath(hostPath)) return true;

    std::wstring host;
    if (!normalizeHostPath(hostPath, host)) {
        // 无法归一化：放行（避免工具探测行为被误杀）
        return true;
    }

    std::wstring vpath;
    if (!mapHostToVirtual(host, g_policy.roots(), vpath)) {
        // 未映射到任何 root：按"沙箱内不存在"处理（not-found 语义）
        winErr = ERROR_PATH_NOT_FOUND;
        return false;
    }

    const char* kind = access == AccessClass::Read ? kAccessRead
                       : access == AccessClass::Write ? kAccessWrite
                       : kAccessExecute;
    if (g_policy.check(vpath, kind, nullptr)) return true;
    winErr = ERROR_ACCESS_DENIED;
    return false;
}

// 框架探测类操作（目录可写性检查/确保存在/属性查询）：仅 deny 硬边界生效，
// ask/allow 一律放行——探测不打扰弹窗，但 deny 规则仍拦（防尾斜杠等逃逸）。
bool sandboxCheckPathDenyOnly(const std::wstring& hostPath, AccessClass access, DWORD& winErr)
{
    winErr = ERROR_SUCCESS;
    if (HookScope::active) return true;
    if (isSpecialDevicePath(hostPath)) return true;

    std::wstring host;
    if (!normalizeHostPath(hostPath, host)) return true;

    std::wstring vpath;
    if (!mapHostToVirtual(host, g_policy.roots(), vpath)) {
        winErr = ERROR_PATH_NOT_FOUND;
        return false;
    }

    const char* kind = access == AccessClass::Read ? kAccessRead
                       : access == AccessClass::Write ? kAccessWrite
                       : kAccessExecute;
    if (!g_policy.checkDenyOnly(vpath, kind)) return true;
    winErr = ERROR_ACCESS_DENIED;
    return false;
}

// -- 初始化：加载环境策略并安装 Detours ---------------------------------------

static std::wstring envOrEmpty(const wchar_t* name)
{
    DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
    if (n == 0) return L"";
    std::wstring v(n, L'\0');
    GetEnvironmentVariableW(name, &v[0], n);
    v.resize(wcslen(v.c_str()));
    return v;
}

static void loadEnvironmentPolicy()
{
    std::wstring policyPath = envOrEmpty(L"DYNOBOX_POLICY");
    if (policyPath.empty()) return;

    g_policy = Policy::loadFromFile(policyPath);

    // --upstream / --token 经环境覆盖策略文件里的 [ask]（宿主导 dynabox.ts 传 --upstream）
    std::wstring upstream = envOrEmpty(L"DYNOBOX_UPSTREAM");
    if (!upstream.empty()) g_policy.mutableAsk().endpoint = upstream;
    std::wstring askToken = envOrEmpty(L"DYNOBOX_ASK_TOKEN");
    if (!askToken.empty()) g_policy.mutableAsk().token = askToken;

    std::wstring src = envOrEmpty(L"DYNOBOX_SRC");
    std::wstring automount = envOrEmpty(L"DYNOBOX_AUTOMOUNT");
    if (!src.empty()) {
        g_policy.addSrcRoot(src);
    } else if (automount == L"1") {
        g_policy.addAutomountRoots();
    }
    g_delToTrash = envOrEmpty(L"DYNOBOX_DEL_TO_TRASH") == L"1";
    // 沙箱会话开始时刻（runner 注入，FILETIME 十进制）：用于"会话内创建"判定
    std::wstring sessionStart = envOrEmpty(L"DYNOBOX_SESSION_START");
    if (!sessionStart.empty()) {
        g_sessionStartFiletime = _wcstoui64(sessionStart.c_str(), nullptr, 10);
    }
}

static void installHooks()
{
    if (DetourTransactionBegin() != NO_ERROR) return;
    if (DetourUpdateThread(GetCurrentThread()) != NO_ERROR) {
        DetourTransactionAbort();
        return;
    }
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateFileW), Hook_CreateFileW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateFileA), Hook_CreateFileA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_GetFileAttributesW), Hook_GetFileAttributesW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_GetFileAttributesA), Hook_GetFileAttributesA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_FindFirstFileW), Hook_FindFirstFileW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_FindFirstFileA), Hook_FindFirstFileA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateDirectoryW), Hook_CreateDirectoryW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateDirectoryA), Hook_CreateDirectoryA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_DeleteFileW), Hook_DeleteFileW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_DeleteFileA), Hook_DeleteFileA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_RemoveDirectoryW), Hook_RemoveDirectoryW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_RemoveDirectoryA), Hook_RemoveDirectoryA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_MoveFileW), Hook_MoveFileW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_MoveFileA), Hook_MoveFileA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_MoveFileExW), Hook_MoveFileExW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_MoveFileExA), Hook_MoveFileExA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CopyFileW), Hook_CopyFileW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CopyFileA), Hook_CopyFileA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CopyFileExW), Hook_CopyFileExW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_SetFileAttributesW), Hook_SetFileAttributesW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_SetFileAttributesA), Hook_SetFileAttributesA);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_SetFileInformationByHandle), Hook_SetFileInformationByHandle);
    // CreateSymbolicLinkW/A 真实入口在 kernelbase（GetProcAddress 解析；见定义处注释）。
    // 注入时点（CREATE_SUSPENDED 早期）kernelbase 可能尚未进入模块表，用
    // LoadLibraryW 确保拿到句柄（GetModuleHandleW 会因未加载返回 NULL）。
    {
        HMODULE kb = GetModuleHandleW(L"kernelbase.dll");
        if (!kb) kb = LoadLibraryW(L"kernelbase.dll");
        if (kb) {
            Real_CreateSymbolicLinkW = (BOOLEAN(WINAPI*)(LPCWSTR, LPCWSTR, DWORD))GetProcAddress(kb, "CreateSymbolicLinkW");
            Real_CreateSymbolicLinkA = (BOOLEAN(WINAPI*)(LPCSTR, LPCSTR, DWORD))GetProcAddress(kb, "CreateSymbolicLinkA");
            if (Real_CreateSymbolicLinkW) {
                LONG ra = DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateSymbolicLinkW), Hook_CreateSymbolicLinkW);
                if (ra != NO_ERROR)
                    Log::error(L"DetourAttach(CreateSymbolicLinkW) 失败: %d", ra);
            }
            if (Real_CreateSymbolicLinkA) {
                LONG ra = DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateSymbolicLinkA), Hook_CreateSymbolicLinkA);
                if (ra != NO_ERROR)
                    Log::error(L"DetourAttach(CreateSymbolicLinkA) 失败: %d", ra);
            }
        }
    }
    // ntdll 层 hook（cygwin/bash 直调 NtCreateFile 等）
    installNtHooks();
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateProcessW), Hook_CreateProcessW);
    DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateProcessA), Hook_CreateProcessA);
    if (DetourTransactionCommit() == NO_ERROR) {
        g_hooked = true;
    }
}

} // namespace sbx

// DllMain 必须为全局 extern "C"：CRT 的 _DllMainCRTStartup 按无修饰的 "DllMain"
// 符号查找。若放在命名空间内会被 C++ 名字修饰而永不调用，且链接器 /OPT:REF
// 会因此丢弃整个 hook 引用链（DLL 只剩 kernel32 依赖、全部 Hook_* 消失）。
extern "C" BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID lpReserved)
{
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hModule);
        try {
            sbx::loadEnvironmentPolicy();
            sbx::installHooks();
        } catch (...) {
            // 策略加载失败 = fail-closed：不安装 hook（进程仍可运行但无管控，
            // 诊断经 stderr 输出，宿主日志可见）。
            OutputDebugStringW(L"sandbox_hook: policy load failed, hooks not installed\n");
            sbx::Log::error(L"sandbox_hook: 策略加载失败，未安装管控");
        }
    }
    return TRUE;
}