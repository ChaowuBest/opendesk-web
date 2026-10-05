/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
// ntdll 层 hook：覆盖 MSYS2/cygwin（Git Bash）以及一切直接调用 NtCreateFile 的
// 文件 IO。kernel32 hook（CreateFileW 等）只拦截经导出 API 的路径；cygwin 大量
// 操作直接走 ntdll（NtCreateFile/NtSetInformationFile/NtDeleteFile），若不拦截，
// bash 沙箱内文件写/删/改名形同虚设。
//
// 判定复用 sandboxCheckPath（NtCreateFile 的 ObjectName 为 NT 路径 \??\C:\foo，
// 转换为 Win32 路径后进行路径归一化 + roots 映射 + 策略判定）。
//
// 双重判定问题：CreateFileW hook（HookGuard::inHook()）内部经 trampoline 调到
// 的 NtCreateFile 已被拦截——但 HookGuard 在同一线程置位，我们的 NtCreateFile
// hook 会直通（避免重复判定）；只有"直接调 ntdll 的路径"（cygwin 等）才会进入
// 本层判定。

#include "hook.h"

#include <winternl.h>

#include "../common/hook_scope.h"
#include "../common/log.h"
#include "detours.h"

#define ALWAYS_INLINE __forceinline

// NTSTATUS 错误码（winternl.h 不全部导出）
#define STATUS_SUCCESS ((NTSTATUS)0x00000000L)
#define STATUS_OBJECT_PATH_NOT_FOUND ((NTSTATUS)0xC000003AL)
#define STATUS_ACCESS_DENIED ((NTSTATUS)0xC0000022L)

namespace sbx {

// hook 实现前置声明（installNtHooks 引用）
NTSTATUS NTAPI Hook_NtCreateFile(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
                                 PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
NTSTATUS NTAPI Hook_NtSetInformationFile(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
NTSTATUS NTAPI Hook_NtDeleteFile(POBJECT_ATTRIBUTES);

// -- ntdll 函数类型（避免依赖 winternl 的签名差异） ---------------------------

typedef NTSTATUS(NTAPI* FN_NtCreateFile)(
    PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER,
    ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);

typedef NTSTATUS(NTAPI* FN_NtSetInformationFile)(
    HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);

typedef NTSTATUS(NTAPI* FN_NtDeleteFile)(POBJECT_ATTRIBUTES);

// FileInformationClass 常量（部分 SDK 未导出）
constexpr ULONG kFileDispositionInformation = 13;
constexpr ULONG kFileRenameInformation = 10;
constexpr ULONG kFileDispositionInformationEx = 64;
constexpr ULONG kFileRenameInformationEx = 65;
constexpr ULONG kFileDispositionInformationEx2 = 71;
constexpr ULONG kFileDirectoryFile = 0x00000001;       // FILE_DIRECTORY_FILE
constexpr ULONG kFileOpenForBackupIntent = 0x00004000; // FILE_OPEN_FOR_BACKUP_INTENT

// -- Detour 目标（真实函数，DllMain 里 attach） ------------------------------

extern "C" {
    FN_NtCreateFile Real_NtCreateFile = nullptr;
    FN_NtSetInformationFile Real_NtSetInformationFile = nullptr;
    FN_NtDeleteFile Real_NtDeleteFile = nullptr;
}

// -- ntdll hook 安装辅助（dllmain.cpp 调用） ---------------------------------

void installNtHooks()
{
    HMODULE nt = GetModuleHandleW(L"ntdll.dll");
    if (!nt) return;
    if (!Real_NtCreateFile)
        Real_NtCreateFile = (FN_NtCreateFile)GetProcAddress(nt, "NtCreateFile");
    if (!Real_NtSetInformationFile)
        Real_NtSetInformationFile = (FN_NtSetInformationFile)GetProcAddress(nt, "NtSetInformationFile");
    if (!Real_NtDeleteFile)
        Real_NtDeleteFile = (FN_NtDeleteFile)GetProcAddress(nt, "NtDeleteFile");
    if (Real_NtCreateFile)
        DetourAttach(&reinterpret_cast<PVOID&>(Real_NtCreateFile), (PVOID)Hook_NtCreateFile);
    if (Real_NtSetInformationFile)
        DetourAttach(&reinterpret_cast<PVOID&>(Real_NtSetInformationFile), (PVOID)Hook_NtSetInformationFile);
    if (Real_NtDeleteFile)
        DetourAttach(&reinterpret_cast<PVOID&>(Real_NtDeleteFile), (PVOID)Hook_NtDeleteFile);
}


// -- NT 路径 → Win32 ---------------------------------------------------------

ALWAYS_INLINE static bool ntPathToWin32(const UNICODE_STRING* name, std::wstring& out)
{
    if (!name || !name->Buffer || name->Length == 0) return false;
    size_t chars = name->Length / sizeof(wchar_t);
    std::wstring p(name->Buffer, chars);

    // \??\C:\foo -> C:\foo；\??\UNC\server\share -> \\server\share。
    // 其余 \??\ 前缀（GLOBALROOT\Device\...、\??\pipe\...、\??\NUL 等）是设备/特殊
    // 对象：不做路径判定（放行），否则会转换成 cwd 下的垃圾相对路径参与策略判定。
    if (p.rfind(L"\\??\\", 0) == 0) {
        if (p.rfind(L"\\??\\UNC\\", 0) == 0) {
            out = L"\\\\" + p.substr(8);
            return true;
        }
        if (p.size() > 7 && iswalpha(p[4]) && p[5] == L':') {
            out = p.substr(4);
            return true;
        }
        return false;
    }
    // \SystemRoot\... -> %SystemRoot% （magic static 缓存，避免热路径重复查环境）
    if (p.rfind(L"\\SystemRoot\\", 0) == 0) {
        static const std::wstring sysRoot = [] {
            wchar_t buf[260];
            DWORD n = GetEnvironmentVariableW(L"SystemRoot", buf, 260);
            return (n > 0 && n < 260) ? std::wstring(buf) : std::wstring();
        }();
        if (!sysRoot.empty()) {
            out = sysRoot + p.substr(11);
            return true;
        }
    }
    // 其余（\Device\HarddiskVolume1\...、\??\ 已覆盖之外的）无法可靠转换 → 调用方放行
    return false;
}

// -- NtCreateFile 访问类别分解（与 CreateFileW 判定一致） ---------------------

ALWAYS_INLINE static AccessClass categorizeNtCreateAccess(ACCESS_MASK access, ULONG createDisposition)
{
    const ACCESS_MASK writeBits = GENERIC_WRITE | FILE_WRITE_DATA | FILE_APPEND_DATA |
                                  FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA | DELETE | FILE_DELETE_CHILD;
    const ACCESS_MASK execBits = GENERIC_EXECUTE | FILE_EXECUTE;
    bool write = (access & writeBits) != 0 ||
                 createDisposition == FILE_CREATE || createDisposition == FILE_OVERWRITE ||
                 createDisposition == FILE_OVERWRITE_IF || createDisposition == FILE_OPEN_IF;
    bool exec = (access & execBits) != 0;
    if (write) return AccessClass::Write;
    if (exec) return AccessClass::Execute;
    return AccessClass::Read;
}

ALWAYS_INLINE static NTSTATUS ntStatusForWinError(DWORD winErr)
{
    return winErr == ERROR_PATH_NOT_FOUND ? STATUS_OBJECT_PATH_NOT_FOUND : STATUS_ACCESS_DENIED;
}

// -- hook 实现 ----------------------------------------------------------------

NTSTATUS NTAPI Hook_NtCreateFile(PHANDLE fileHandle, ACCESS_MASK desiredAccess,
                                 POBJECT_ATTRIBUTES objectAttributes, PIO_STATUS_BLOCK ioStatusBlock,
                                 PLARGE_INTEGER allocationSize, ULONG fileAttributes, ULONG shareAccess,
                                 ULONG createDisposition, ULONG createOptions, PVOID eaBuffer, ULONG eaLength)
{
    // HookGuard 已置位说明调用来自本 DLL 内的 hook 路径（经 trampoline 回到
    // 真实 ntdll），已在上层判定过——避免二次判定（额外开销 + 语义混乱）。
    if (HookGuard::inHook() || HookScope::active || !g_hooked || !objectAttributes) {
        return Real_NtCreateFile(fileHandle, desiredAccess, objectAttributes, ioStatusBlock,
                                 allocationSize, fileAttributes, shareAccess, createDisposition,
                                 createOptions, eaBuffer, eaLength);
    }
    HookGuard guard;

    std::wstring winPath;
    if (objectAttributes->ObjectName && ntPathToWin32(objectAttributes->ObjectName, winPath)) {
        // read 类通用探测豁免（与 CreateFileW 路径同语义）：目标为已存在目录
        // （路径链校验/可遍历性检查）、会话内自建文件读回（PowerShell
        // __PSScriptPolicyTest 读回等）、目标不存在（ENOENT 透传）→ 均不触发
        // ask，deny 仍拦截。目标是普通存在文件时走正常 read 判定。
        if (categorizeNtCreateAccess(desiredAccess, createDisposition) == AccessClass::Read) {
            DWORD perr = ERROR_SUCCESS;
            if (sandboxCheckDirReadProbe(winPath, perr) ||
                sandboxCheckSessionCreatedRead(winPath, perr) ||
                sandboxCheckNotExistRead(winPath, perr)) {
                return Real_NtCreateFile(fileHandle, desiredAccess, objectAttributes, ioStatusBlock,
                                         allocationSize, fileAttributes, shareAccess,
                                         createDisposition, createOptions, eaBuffer, eaLength);
            }
        }
        // 目录写探测（FILE_OPEN + 目录标志）与"确保存在"（FILE_CREATE +
        // FILE_DIRECTORY_FILE 落在已存在目录上）是无副作用的框架行为（.NET/
        // PowerShell 启动时对家目录/AppData 的可写性检查）——完全跳过权限判定，
        // 不触发任何 ask。目标非目录或目录不存在时仍是真实创建/写入，走正常判定。
        const bool isDirProbe =
            (createDisposition == FILE_CREATE && (createOptions & kFileDirectoryFile) != 0) ||
            (createDisposition == FILE_OPEN &&
             (createOptions & (kFileDirectoryFile | kFileOpenForBackupIntent)) != 0);
        if (isDirProbe) {
            WIN32_FILE_ATTRIBUTE_DATA fad;
            if (GetFileAttributesExW(winPath.c_str(), GetFileExInfoStandard, &fad) &&
                (fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
                // 目录探测不触发 ask；deny 规则仍拦截（防尾斜杠/别名逃逸）
                DWORD perr = ERROR_SUCCESS;
                if (!sandboxCheckPathDenyOnly(winPath, categorizeNtCreateAccess(desiredAccess, createDisposition), perr)) {
                    return ntStatusForWinError(perr);
                }
                return Real_NtCreateFile(fileHandle, desiredAccess, objectAttributes, ioStatusBlock,
                                         allocationSize, fileAttributes, shareAccess,
                                         createDisposition, createOptions, eaBuffer, eaLength);
            }
        }
        DWORD err = ERROR_SUCCESS;
        if (!sandboxCheckPath(winPath, categorizeNtCreateAccess(desiredAccess, createDisposition), err)) {
            return ntStatusForWinError(err);
        }
    }
    return Real_NtCreateFile(fileHandle, desiredAccess, objectAttributes, ioStatusBlock,
                             allocationSize, fileAttributes, shareAccess, createDisposition,
                             createOptions, eaBuffer, eaLength);
}

NTSTATUS NTAPI Hook_NtSetInformationFile(HANDLE fileHandle, PIO_STATUS_BLOCK ioStatusBlock,
                                         PVOID fileInformation, ULONG length,
                                         FILE_INFORMATION_CLASS fileInformationClass)
{
    // HookGuard 已置位（来自本 DLL hook 路径）→ 直通，避免二次判定
    if (HookGuard::inHook() || HookScope::active || !g_hooked || !fileHandle || fileHandle == INVALID_HANDLE_VALUE) {
        return Real_NtSetInformationFile(fileHandle, ioStatusBlock, fileInformation, length,
                                         fileInformationClass);
    }
    HookGuard guard;

    // 句柄级删除/改名（cygwin rm/mv 走此路径）
    switch ((ULONG)fileInformationClass) {
        case kFileDispositionInformation:
        case kFileDispositionInformationEx:
        case kFileDispositionInformationEx2:
        {
            wchar_t pathBuf[MAX_PATH];
            DWORD n = GetFinalPathNameByHandleW(fileHandle, pathBuf, MAX_PATH, FILE_NAME_NORMALIZED);
            if (n > 0 && n < MAX_PATH) {
                std::wstring p(pathBuf, n);
                // 沙箱会话内创建：自发清理，直接删（不 ask、不进回收站）。
                // 注意 sandboxSessionCreated 对回收站路径有豁免（返回 false），
                // 回收站内容的删除/写入由 sandboxCheckPath 的 trash-protected 拦。
                if (sandboxSessionCreated(p)) break;
                DWORD err = ERROR_SUCCESS;
                if (!sandboxCheckPath(p, AccessClass::Write, err)) {
                    return ntStatusForWinError(err);
                }
                // 句柄级删除同样接入回收站（python os.remove / Node 等可能走此路径）；
                // 回收站移动文件后，原句柄的删除标记落空即可（文件已不在原位置）。
                if (g_delToTrash) {
                    if (RecycleGuard::active()) break;   // 回收流程进行中：交由真实句柄删除
                    return recycleToTrash(p) ? STATUS_SUCCESS : STATUS_ACCESS_DENIED;
                }
            }
            break;
        }
        case kFileRenameInformation:
        case kFileRenameInformationEx:
        {
            std::wstring src;
            if (finalPathByHandle(fileHandle, src)) {
                DWORD err = ERROR_SUCCESS;
                if (!sandboxCheckPath(src, AccessClass::Write, err)) {
                    return ntStatusForWinError(err);
                }
                // 目标路径同样必须通过策略判定（防句柄级 rename 把文件移入 deny 目录）
                bool isEx = (ULONG)fileInformationClass == kFileRenameInformationEx;
                if (!sandboxCheckRenameTarget(src, fileInformation, length, isEx, err)) {
                    return ntStatusForWinError(err);
                }
            }
            break;
        }
        default:
            break;
    }
    return Real_NtSetInformationFile(fileHandle, ioStatusBlock, fileInformation, length,
                                     fileInformationClass);
}

NTSTATUS NTAPI Hook_NtDeleteFile(POBJECT_ATTRIBUTES objectAttributes)
{
    // HookGuard 已置位（来自本 DLL hook 路径）→ 直通，避免二次判定
    if (HookGuard::inHook() || HookScope::active || !g_hooked || !objectAttributes) {
        return Real_NtDeleteFile(objectAttributes);
    }
    HookGuard guard;

    std::wstring winPath;
    if (objectAttributes->ObjectName && ntPathToWin32(objectAttributes->ObjectName, winPath)) {
        // 沙箱会话内创建：自发清理，直接删（不 ask、不进回收站）
        if (sandboxSessionCreated(winPath)) return Real_NtDeleteFile(objectAttributes);
        DWORD err = ERROR_SUCCESS;
        if (!sandboxCheckPath(winPath, AccessClass::Write, err)) {
            return ntStatusForWinError(err);
        }
        // 句柄级删除路径（python os.remove、Node fs.unlink 等可能直调 ntdll）
        // 同样接入回收站：--del-to-trash 下删除经 SHFileOperation 送回收站。
        if (g_delToTrash) {
            if (RecycleGuard::active()) return Real_NtDeleteFile(objectAttributes);   // 回收流程进行中：直接真实删除
            if (recycleToTrash(winPath)) return STATUS_SUCCESS;
            return STATUS_ACCESS_DENIED;
        }
    }
    return Real_NtDeleteFile(objectAttributes);
}

} // namespace sbx