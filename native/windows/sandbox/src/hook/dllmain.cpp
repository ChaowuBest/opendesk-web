/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "hook.h"

#include "../common/log.h"
#include "../common/paths.h"
#include "../common/hook_scope.h"
#include "detours.h"

#include <stdexcept>

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
std::wstring g_trashDir;
Policy g_policy;

// 沙箱会话开始时刻（FILETIME，runner 经 DYNOBOX_SESSION_START 注入）；0 表示未设置。
static unsigned __int64 g_sessionStartFiletime = 0;

// 判断路径是否沙箱会话内创建（文件创建时间 >= 会话开始时间）。
// 会话内创建的文件删除 = 自发清理：不 ask、不进回收站，直接删除。
// 例外：回收站目录内的文件永不走此短路——回收站产物（<uuid>.back）本身就是
// 会话内由回收流程创建的，若无此豁免，"删回收站内容"会被误判为临时文件清理
// 而直接真删（蓝队 B1：回收站可恢复性承诺被绕过）。
bool sandboxSessionCreated(const std::wstring& hostPath)
{
    if (g_sessionStartFiletime == 0) return false;
    std::wstring p = hostPath;
    if (p.rfind(L"\\\\?\\UNC\\", 0) == 0) p = L"\\\\" + p.substr(8);
    else if (p.rfind(L"\\\\?\\", 0) == 0) p = p.substr(4);
    // 尾部分隔符归一化：引擎打开文件时可能附加尾反斜杠（err=267 的属性查询
    // 直接失败导致"会话内创建"判定失准，读回自建文件的豁免被绕过）
    while (p.size() > 1 && (p.back() == L'\\' || p.back() == L'/')) p.pop_back();
    if (!g_trashDir.empty()) {
        std::wstring trashNorm = g_trashDir;
        while (!trashNorm.empty() && (trashNorm.back() == L'\\' || trashNorm.back() == L'/'))
            trashNorm.pop_back();
        std::wstring pn = p;
        while (!pn.empty() && (pn.back() == L'\\' || pn.back() == L'/')) pn.pop_back();
        std::wstring trashLower = trashNorm, pLower = pn;
        for (auto& c : trashLower) c = (wchar_t)towlower(c);
        for (auto& c : pLower) c = (wchar_t)towlower(c);
        if (pLower == trashLower ||
            (pLower.size() > trashLower.size() &&
             pLower.compare(0, trashLower.size(), trashLower) == 0 &&
             (pLower[trashLower.size()] == L'\\' || pLower[trashLower.size()] == L'/'))) {
            return false;   /* 回收站内：不视为会话内临时文件（删除/写由 trash-protected 拦） */
        }
    }
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
    // GLOBALROOT 卷文件路径（\\?\GLOBALROOT\Device\HarddiskVolumeN\... 或
    // \\.\GLOBALROOT\Device\HarddiskVolumeN\...）不是虚设备：它们在设备命名空间
    // 里映射到真实卷上的文件，必须参与策略判定（由 sandboxCheckPath 经
    // mapGlobalRootToDrive 转换为盘符路径后判定），否则可绕过 roots 映射读任意文件。
    {
        std::wstring dummy;
        if (mapGlobalRootToDrive(path, dummy)) return false;
    }
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

    // GLOBALROOT 设备命名空间路径（\\?\GLOBALROOT\Device\HarddiskVolumeN\...）转盘符
    // 参与正常判定——否则直接走 isSpecialDevicePath 的虚设备放行会绕过 roots 映射。
    std::wstring drivePath;
    if (!mapGlobalRootToDrive(hostPath, drivePath)) drivePath = hostPath;

    std::wstring host;
    if (!normalizeHostPath(drivePath, host)) {
        // 无法归一化：放行（避免工具探测行为被误杀）
        return true;
    }

    std::wstring vpath;
    if (!mapHostToVirtual(host, g_policy.roots(), vpath)) {
        // 未映射到任何 root：按"沙箱内不存在"处理（not-found 语义）
        winErr = ERROR_PATH_NOT_FOUND;
        return false;
    }

    // 回收站写保护（对齐 Linux/OH core 的 trash-protected DENY）：回收站是误删
    // 数据的恢复区，沙箱进程可写即可清空整个回收站（T3 蓝队发现）。--del-to-trash
    // 的移动由 hook 的 RecycleGuard 分支完成，不经此判定，不受影响。读不受限。
    if (access == AccessClass::Write && !g_trashDir.empty()) {
        std::wstring trashNorm = g_trashDir;
        while (!trashNorm.empty() && (trashNorm.back() == L'\\' || trashNorm.back() == L'/'))
            trashNorm.pop_back();
        std::wstring hostNorm = host;
        while (!hostNorm.empty() && (hostNorm.back() == L'\\' || hostNorm.back() == L'/'))
            hostNorm.pop_back();
        // 大小写不敏感前缀 + 组件边界（\trash\<taskId>\... 或恰为目录本身）
        std::wstring trashLower = trashNorm, hostLower = hostNorm;
        for (auto& c : trashLower) c = (wchar_t)towlower(c);
        for (auto& c : hostLower) c = (wchar_t)towlower(c);
        if (hostLower == trashLower ||
            (hostLower.size() > trashLower.size() &&
             hostLower.compare(0, trashLower.size(), trashLower) == 0 &&
             (hostLower[trashLower.size()] == L'\\' || hostLower[trashLower.size()] == L'/'))) {
            winErr = ERROR_ACCESS_DENIED;
            return false;
        }
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

    std::wstring drivePath;
    if (!mapGlobalRootToDrive(hostPath, drivePath)) drivePath = hostPath;
    std::wstring host;
    if (!normalizeHostPath(drivePath, host)) return true;

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

// 目录读探测的通用判定：read 类访问且目标**当前是已存在目录**时，视为存在性/
// 可遍历性探测——目录句柄不携带文件数据，读不到任何内容（列目录/校验路径链/
// 可读性检查均属此类，.NET/PowerShell/git 启动时对家目录与 Temp 链的逐层访问
// 都走这里）。仅 deny 硬边界生效（ask 不弹、allow 照常），deny 仍拦截防逃逸。
// 目标是文件或不存在时返回 false，走正常 read 判定（读文件内容仍受策略管控）。
bool sandboxCheckDirReadProbe(const std::wstring& hostPath, DWORD& winErr)
{
    // 尾部分隔符归一化：探测调用可能带尾反斜杠（目录语义），属性查询前剥掉，
    // 否则 GetFileAttributesExW 对文件+尾斜杠返回 err=267，探测判定失准
    std::wstring p = hostPath;
    while (p.size() > 1 && (p.back() == L'\\' || p.back() == L'/')) p.pop_back();
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(p.c_str(), GetFileExInfoStandard, &fad) ||
        (fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        return false;
    }
    return sandboxCheckPathDenyOnly(p, AccessClass::Read, winErr);
}

// 会话内自建文件的读回判定：read 类访问且目标由沙箱会话内进程创建（创建时间
// >= 会话开始）→ 视为进程读回自己的产物，不触发 ask。典型：PowerShell 引擎
// 写入 __PSScriptPolicyTest_*.ps1 后立即读回（执行策略检测），写已受 write 规则
// 管控，读回同进程刚写的内容不产生新的信息泄露面。与"会话内创建文件的删除 =
// 自发清理"（sandboxSessionCreated）同哲学。deny 规则仍拦截（防逃逸）。
bool sandboxCheckSessionCreatedRead(const std::wstring& hostPath, DWORD& winErr)
{
    if (!sandboxSessionCreated(hostPath)) return false;
    return sandboxCheckPathDenyOnly(hostPath, AccessClass::Read, winErr);
}

// 不存在路径的读放行：read 类访问且目标**当前不存在** → 不触发 ask，直接放行。
// 真实 API 随后对宿主返回 ENOENT/PATH_NOT_FOUND，与无沙箱行为完全一致——读不到
// 任何内容，只是把"不存在"的错误结果透传给调用方（工具的探测/容错逻辑依赖它）。
// 典型：解释器启动时逐级向上探测 pyvenv.cfg / package.json / 标记文件。
// 边界：deny 规则仍优先拦截（deny 区路径的存在性探测不泄露）；写不在豁免内
// （创建文件是真实副作用，照常管控）；TOCTOU 下读到的是沙箱内进程自己预置的
// 文件，与"会话内自建读回"等价，无新增泄露面。
bool sandboxCheckNotExistRead(const std::wstring& hostPath, DWORD& winErr)
{
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (GetFileAttributesExW(hostPath.c_str(), GetFileExInfoStandard, &fad)) {
        return false;   // 目标存在：正常 read 判定（内容读取受策略管控）
    }
    DWORD err = GetLastError();
    if (err != ERROR_FILE_NOT_FOUND && err != ERROR_PATH_NOT_FOUND) {
        return false;   // 查询失败（权限等）：正常 read 判定，不扩大豁免
    }
    return sandboxCheckPathDenyOnly(hostPath, AccessClass::Read, winErr);
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
    // OpenDesk 统一回收站目录（<opendesk>/trash/<taskId>，宿主每次拉起都传入）；
    // 非空时删除分流到该目录（<uuid>.back + summary.json），否则退回系统回收站
    g_trashDir = envOrEmpty(L"DYNOBOX_TRASH_DIR");
    // 沙箱会话开始时刻（runner 注入，FILETIME 十进制）：用于"会话内创建"判定
    std::wstring sessionStart = envOrEmpty(L"DYNOBOX_SESSION_START");
    if (!sessionStart.empty()) {
        g_sessionStartFiletime = _wcstoui64(sessionStart.c_str(), nullptr, 10);
    }
}

static void installHooks()
{
    if (DetourTransactionBegin() != NO_ERROR) {
        Log::error(L"DetourTransactionBegin 失败: %ld", GetLastError());
        return;
    }
    if (DetourUpdateThread(GetCurrentThread()) != NO_ERROR) {
        Log::error(L"DetourUpdateThread 失败: %ld", GetLastError());
        DetourTransactionAbort();
        return;
    }
    // 记录 attach 失败：任何关键 hook 未装上都会导致对应 API 不受管控，
    // 静默失败会让子进程"无管控但看似沙箱化"。逐个检查返回值并在提交后
    // 汇总报警（fail-closed 语义：attach 不完整则 g_hooked=false，调用方
    // 仍会运行但日志明确标记未管控）。
    size_t attachFailures = 0;
    auto attach = [&attachFailures](PVOID* pp, PVOID detour, const wchar_t* name) {
        LONG ra = DetourAttach(pp, detour);
        if (ra != NO_ERROR) {
            Log::error(L"DetourAttach(%ls) 失败: %d", name, ra);
            attachFailures++;
        }
    };
    attach(&reinterpret_cast<PVOID&>(Real_CreateFileW), (PVOID)Hook_CreateFileW, L"CreateFileW");
    attach(&reinterpret_cast<PVOID&>(Real_CreateFileA), (PVOID)Hook_CreateFileA, L"CreateFileA");
    attach(&reinterpret_cast<PVOID&>(Real_GetFileAttributesW), (PVOID)Hook_GetFileAttributesW, L"GetFileAttributesW");
    attach(&reinterpret_cast<PVOID&>(Real_GetFileAttributesA), (PVOID)Hook_GetFileAttributesA, L"GetFileAttributesA");
    attach(&reinterpret_cast<PVOID&>(Real_FindFirstFileW), (PVOID)Hook_FindFirstFileW, L"FindFirstFileW");
    attach(&reinterpret_cast<PVOID&>(Real_FindFirstFileA), (PVOID)Hook_FindFirstFileA, L"FindFirstFileA");
    attach(&reinterpret_cast<PVOID&>(Real_CreateDirectoryW), (PVOID)Hook_CreateDirectoryW, L"CreateDirectoryW");
    attach(&reinterpret_cast<PVOID&>(Real_CreateDirectoryA), (PVOID)Hook_CreateDirectoryA, L"CreateDirectoryA");
    attach(&reinterpret_cast<PVOID&>(Real_DeleteFileW), (PVOID)Hook_DeleteFileW, L"DeleteFileW");
    attach(&reinterpret_cast<PVOID&>(Real_DeleteFileA), (PVOID)Hook_DeleteFileA, L"DeleteFileA");
    attach(&reinterpret_cast<PVOID&>(Real_RemoveDirectoryW), (PVOID)Hook_RemoveDirectoryW, L"RemoveDirectoryW");
    attach(&reinterpret_cast<PVOID&>(Real_RemoveDirectoryA), (PVOID)Hook_RemoveDirectoryA, L"RemoveDirectoryA");
    attach(&reinterpret_cast<PVOID&>(Real_MoveFileW), (PVOID)Hook_MoveFileW, L"MoveFileW");
    attach(&reinterpret_cast<PVOID&>(Real_MoveFileA), (PVOID)Hook_MoveFileA, L"MoveFileA");
    attach(&reinterpret_cast<PVOID&>(Real_MoveFileExW), (PVOID)Hook_MoveFileExW, L"MoveFileExW");
    attach(&reinterpret_cast<PVOID&>(Real_MoveFileExA), (PVOID)Hook_MoveFileExA, L"MoveFileExA");
    attach(&reinterpret_cast<PVOID&>(Real_CopyFileW), (PVOID)Hook_CopyFileW, L"CopyFileW");
    attach(&reinterpret_cast<PVOID&>(Real_CopyFileA), (PVOID)Hook_CopyFileA, L"CopyFileA");
    attach(&reinterpret_cast<PVOID&>(Real_CopyFileExW), (PVOID)Hook_CopyFileExW, L"CopyFileExW");
    attach(&reinterpret_cast<PVOID&>(Real_SetFileAttributesW), (PVOID)Hook_SetFileAttributesW, L"SetFileAttributesW");
    attach(&reinterpret_cast<PVOID&>(Real_SetFileAttributesA), (PVOID)Hook_SetFileAttributesA, L"SetFileAttributesA");
    attach(&reinterpret_cast<PVOID&>(Real_SetFileInformationByHandle), (PVOID)Hook_SetFileInformationByHandle, L"SetFileInformationByHandle");
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
                LONG ra = DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateSymbolicLinkW), (PVOID)Hook_CreateSymbolicLinkW);
                if (ra != NO_ERROR) {
                    Log::error(L"DetourAttach(CreateSymbolicLinkW) 失败: %d", ra);
                    attachFailures++;
                }
            }
            if (Real_CreateSymbolicLinkA) {
                LONG ra = DetourAttach(&reinterpret_cast<PVOID&>(Real_CreateSymbolicLinkA), (PVOID)Hook_CreateSymbolicLinkA);
                if (ra != NO_ERROR) {
                    Log::error(L"DetourAttach(CreateSymbolicLinkA) 失败: %d", ra);
                    attachFailures++;
                }
            }
        } else {
            Log::error(L"kernelbase.dll 加载失败，CreateSymbolicLink 不受管控");
            attachFailures++;
        }
    }
    // ntdll 层 hook（cygwin/bash 直调 NtCreateFile 等）
    installNtHooks();
    attach(&reinterpret_cast<PVOID&>(Real_CreateProcessW), (PVOID)Hook_CreateProcessW, L"CreateProcessW");
    attach(&reinterpret_cast<PVOID&>(Real_CreateProcessA), (PVOID)Hook_CreateProcessA, L"CreateProcessA");
    if (DetourTransactionCommit() == NO_ERROR) {
        if (attachFailures == 0) {
            g_hooked = true;
        } else {
            // 有关键 hook 未装上：不标记已管控（日志已逐条报警）。
            Log::error(L"Detours hook 安装不完整（%zu 个 attach 失败），子进程不受完整管控", attachFailures);
        }
    } else {
        Log::error(L"DetourTransactionCommit 失败: %ld", GetLastError());
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
        } catch (const std::exception& e) {
            // 策略加载失败 = fail-closed：不安装 hook（进程仍可运行但无管控）。
            // 异常原文透出（stderr + 调试器），便于定位（core 桥接层的解析错误
            // 带具体原因，如表名/字段校验失败）。
            wchar_t msg[512];
            MultiByteToWideChar(CP_UTF8, 0, e.what(), -1, msg, 512);
            OutputDebugStringW(msg);
            sbx::Log::error(L"sandbox_hook: 策略加载失败: %ls", msg);
        } catch (...) {
            OutputDebugStringW(L"sandbox_hook: policy load failed (unknown), hooks not installed\n");
            sbx::Log::error(L"sandbox_hook: 策略加载失败（未知异常），未安装管控");
        }
    }
    return TRUE;
}