/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "hook.h"

#include <shellapi.h>
#include <cstring>
#include <cwctype>
#include <vector>

#include "../common/log.h"
#include "../common/hook_scope.h"
#include "../common/utf.h"

#pragma comment(lib, "shell32.lib")

namespace sbx {

// 系统策略禁用回收站时（Policies\Explorer 的 NoRecycleBin / NukeOnDelete=1），
// SHFileOperation 的 FOF_ALLOWUNDO 会静默退化为永久删除——违反"绝不静默永久
// 删除"的承诺。删除前检测，禁用时拒绝删除并保留原文件。
static bool isRecycleBinDisabled()
{
    HKEY key;
    if (RegOpenKeyExW(HKEY_CURRENT_USER,
                      L"Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer",
                      0, KEY_READ, &key) != ERROR_SUCCESS) {
        return false;
    }
    DWORD value = 0;
    DWORD size = sizeof(value);
    bool disabled = false;
    if (RegQueryValueExW(key, L"NoRecycleBin", nullptr, nullptr, (LPBYTE)&value, &size) == ERROR_SUCCESS &&
        value == 1) {
        disabled = true;
    }
    value = 0;
    size = sizeof(value);
    if (RegQueryValueExW(key, L"NukeOnDelete", nullptr, nullptr, (LPBYTE)&value, &size) == ERROR_SUCCESS &&
        value == 1) {
        disabled = true;
    }
    RegCloseKey(key);
    return disabled;
}

bool recycleToTrash(const std::wstring& path)
{
    // 进程级重入/并发保护：SHFileOperation 是 shell 级共享操作，同一进程并发
    // 调用会互相等待直至死锁（hook 环境下实测），且其内部（工作线程）删除原
    // 文件若再进 recycleToTrash 会无限递归。首个回收者执行 SHFileOperation；
    // 流程进行中其他删除请求由各删除 hook 退化为直接删除（见 active() 调用点）。
    if (!RecycleGuard::tryEnter()) return true;
    struct RecycleLeave {
        ~RecycleLeave() { RecycleGuard::leave(); }
    } recycleLeave;

    if (isRecycleBinDisabled()) {
        Log::warn(L"[TRASH] 回收站被系统策略禁用（NoRecycleBin/NukeOnDelete），保留原文件: %ls",
                  path.c_str());
        return false;
    }
    // GetFinalPathNameByHandle 返回 \\?\C:\... 前缀；SHFileOperation 需要普通路径
    std::wstring p = path;
    if (p.rfind(L"\\\\?\\UNC\\", 0) == 0) {
        p = L"\\\\" + p.substr(8);
    } else if (p.rfind(L"\\\\?\\", 0) == 0) {
        p = p.substr(4);
    }
    std::vector<wchar_t> buf(p.begin(), p.end());
    buf.push_back(L'\0');
    buf.push_back(L'\0');
    SHFILEOPSTRUCTW op = {};
    op.hwnd = nullptr;
    op.wFunc = FO_DELETE;
    op.pFrom = buf.data();
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
    int r = SHFileOperationW(&op);
    if (r != 0) {
        Log::warn(L"[TRASH] 回收站删除失败(%d)，保留原文件: %ls", r, p.c_str());
        return false;
    }
    return true;
}

bool finalPathByHandle(HANDLE hFile, std::wstring& out)
{
    // 动态缓冲：长路径（> MAX_PATH）不因截断而跳过判定（fail-open）。
    DWORD need = GetFinalPathNameByHandleW(hFile, nullptr, 0, FILE_NAME_NORMALIZED);
    if (need == 0 || need > 32 * 1024) return false;
    std::wstring buf(need, L'\0');
    DWORD n = GetFinalPathNameByHandleW(hFile, &buf[0], need, FILE_NAME_NORMALIZED);
    if (n == 0 || n >= need) return false;
    buf.resize(n);
    out = std::move(buf);
    return true;
}

// FILE_RENAME_INFORMATION / _EX 布局（不依赖 SDK 版本差异，按 offsetof 取字段）：
//   BOOLEAN ReplaceIfExists; | ULONG Flags(_EX)  -- offset 0
//   HANDLE RootDirectory;                         -- 对齐后
//   ULONG FileNameLength;                         -- 字节数（不含 null）
//   WCHAR FileName[1];                            -- 目标路径（RootDirectory=NULL 时为完整路径；
//                                                     否则相对 RootDirectory 目录）
struct RenameInfoLayout {
    BOOLEAN ReplaceIfExists;
    HANDLE RootDirectory;
    ULONG FileNameLength;
    WCHAR FileName[1];
};

bool sandboxCheckRenameTarget(const std::wstring& sourcePath, const void* info, size_t bufferBytes,
                              bool isEx, DWORD& winErr)
{
    winErr = ERROR_SUCCESS;
    if (!info || bufferBytes < 16) {
        // 结构异常：无法解析目标 -> fail-closed（避免逃逸）
        winErr = ERROR_INVALID_PARAMETER;
        return false;
    }
    const BYTE* p = (const BYTE*)info;
    const size_t nameLenOff = offsetof(RenameInfoLayout, FileNameLength);
    const size_t nameOff = offsetof(RenameInfoLayout, FileName);
    ULONG nameBytes = 0;
    memcpy(&nameBytes, p + nameLenOff, sizeof(nameBytes));
    if (nameBytes > 32 * 1024 || nameBytes > bufferBytes - nameOff) {
        winErr = ERROR_INVALID_PARAMETER;
        return false;
    }
    std::wstring target;
    target.assign((const wchar_t*)(p + nameOff), nameBytes / sizeof(wchar_t));
    // 剥离可能包含的尾随 null（FileNameLength 若含 null 则字节数多算）
    while (!target.empty() && target.back() == L'\0') target.pop_back();
    if (target.empty()) {
        winErr = ERROR_INVALID_PARAMETER;
        return false;
    }

    // 目标基准目录：
    //  - RootDirectory 句柄非空：取其完整路径为基准
    //  - 否则 target 应为完整路径；若为相对路径则按源文件所在目录解析
    //    （比按进程 CWD 解析更贴近沙箱判定，且对判定更安全）
    std::wstring base;
    HANDLE rootDir = nullptr;
    memcpy(&rootDir, p + offsetof(RenameInfoLayout, RootDirectory), sizeof(rootDir));
    bool isDrive = (target.size() >= 2 && iswalpha(target[0]) && target[1] == L':');
    bool isUnc = target.rfind(L"\\\\", 0) == 0;
    // \\?\C:\... / \\?\UNC\... 是完整路径（RootDirectory 之外的绝对形式）
    bool isNtPrefixed = target.rfind(L"\\\\?\\", 0) == 0;
    bool full = isDrive || isUnc || isNtPrefixed;
    if (!full && rootDir && rootDir != INVALID_HANDLE_VALUE) {
        if (!finalPathByHandle(rootDir, base)) {
            // 拿不到 RootDirectory 的真实路径：无法判定目标 -> fail-closed
            winErr = ERROR_PATH_NOT_FOUND;
            return false;
        }
    } else if (!full) {
        // 相对路径：以源文件所在目录为基准
        std::wstring src = sourcePath;
        size_t sep = src.find_last_of(L"\\/");
        base = (sep == std::wstring::npos) ? src : src.substr(0, sep);
    }
    // 相对路径拼接到 base 后解析（GetFullPathNameW 解析 .. 与别名）
    if (!base.empty()) {
        std::wstring joined = base + L"\\" + target;
        DWORD need = GetFullPathNameW(joined.c_str(), 0, nullptr, nullptr);
        if (need == 0 || need > 32 * 1024) {
            winErr = ERROR_PATH_NOT_FOUND;
            return false;
        }
        std::wstring tmp(need, L'\0');
        if (GetFullPathNameW(joined.c_str(), need, &tmp[0], nullptr) == 0) {
            winErr = ERROR_PATH_NOT_FOUND;
            return false;
        }
        tmp.resize(wcslen(tmp.c_str()));
        target = std::move(tmp);
    }

    if (!sandboxCheckPath(target, AccessClass::Write, winErr)) {
        // 目标被 deny / 未映射（沙箱外）: 拒绝 rename
        return false;
    }
    return true;
}


// -- CreateFileW/A -----------------------------------------------------------

// 目录句柄打开（BACKUP_SEMANTICS + OPEN_EXISTING 且目标为已存在目录）：这是
// .NET/PowerShell 等框架的可写性/存在性探测，不携带也读不到文件内容——不论请求
// 的读/写权限，完全跳过权限判定（不触发任何 ask）。打开文件不在此列。
static bool isDirOpenProbe(LPCWSTR path, DWORD dwFlagsAndAttributes, DWORD dwCreationDisposition)
{
    if ((dwFlagsAndAttributes & FILE_FLAG_BACKUP_SEMANTICS) == 0 || dwCreationDisposition != OPEN_EXISTING)
        return false;
    WIN32_FILE_ATTRIBUTE_DATA fad;
    return GetFileAttributesExW(path, GetFileExInfoStandard, &fad) &&
           (fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

HANDLE WINAPI Hook_CreateFileW(LPCWSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
                               LPSECURITY_ATTRIBUTES lpSA, DWORD dwCreationDisposition,
                               DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr) {
        return Real_CreateFileW(lpFileName, dwDesiredAccess, dwShareMode, lpSA,
                                dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
    }
    HookGuard guard;
    if (isDirOpenProbe(lpFileName, dwFlagsAndAttributes, dwCreationDisposition)) {
        // 目录探测不触发 ask；deny 规则仍拦截（防尾斜杠/别名逃逸）
        DWORD perr = ERROR_SUCCESS;
        if (!sandboxCheckPathDenyOnly(lpFileName, categorizeCreateAccess(dwDesiredAccess, dwCreationDisposition), perr)) {
            SetLastError(perr);
            return INVALID_HANDLE_VALUE;
        }
        return Real_CreateFileW(lpFileName, dwDesiredAccess, dwShareMode, lpSA,
                                dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
    }
    DWORD err = ERROR_SUCCESS;
    if (!sandboxCheckPath(lpFileName, categorizeCreateAccess(dwDesiredAccess, dwCreationDisposition), err)) {
        SetLastError(err);
        return INVALID_HANDLE_VALUE;
    }
    return Real_CreateFileW(lpFileName, dwDesiredAccess, dwShareMode, lpSA,
                            dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
}

HANDLE WINAPI Hook_CreateFileA(LPCSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
                               LPSECURITY_ATTRIBUTES lpSA, DWORD dwCreationDisposition,
                               DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr) {
        return Real_CreateFileA(lpFileName, dwDesiredAccess, dwShareMode, lpSA,
                                dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
    }
    HookGuard guard;
    std::wstring wide = ansiToWide(lpFileName);
    DWORD err = ERROR_SUCCESS;
    if (isDirOpenProbe(wide.c_str(), dwFlagsAndAttributes, dwCreationDisposition)) {
        // 目录探测不触发 ask；deny 规则仍拦截
        DWORD perr = ERROR_SUCCESS;
        if (!wide.empty() && !sandboxCheckPathDenyOnly(wide, categorizeCreateAccess(dwDesiredAccess, dwCreationDisposition), perr)) {
            SetLastError(perr);
            return INVALID_HANDLE_VALUE;
        }
        return Real_CreateFileA(lpFileName, dwDesiredAccess, dwShareMode, lpSA,
                                dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
    }
    if (!wide.empty() && !sandboxCheckPath(wide, categorizeCreateAccess(dwDesiredAccess, dwCreationDisposition), err)) {
        SetLastError(err);
        return INVALID_HANDLE_VALUE;
    }
    return Real_CreateFileA(lpFileName, dwDesiredAccess, dwShareMode, lpSA,
                            dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
}

// -- GetFileAttributesW/A（读/属性探测）--------------------------------------

DWORD WINAPI Hook_GetFileAttributesW(LPCWSTR lpFileName)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr)
        return Real_GetFileAttributesW(lpFileName);
    HookGuard guard;
    // 属性/存在性探测（GetFileAttributes）只读元数据、不携带文件内容，是框架
    // "确保存在"检查的常用路径（.NET/PowerShell 启动）——不触发 ask，但 deny
    // 规则仍拦截（防尾斜杠/别名逃逸）。
    DWORD err = ERROR_SUCCESS;
    if (!sandboxCheckPathDenyOnly(lpFileName, AccessClass::Read, err)) {
        SetLastError(err);
        return INVALID_FILE_ATTRIBUTES;
    }
    return Real_GetFileAttributesW(lpFileName);
}

DWORD WINAPI Hook_GetFileAttributesA(LPCSTR lpFileName)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr)
        return Real_GetFileAttributesA(lpFileName);
    HookGuard guard;
    // 属性/存在性探测（GetFileAttributes）只读元数据，不触发 ask（deny 仍拦，见 W 版）
    std::wstring wide = ansiToWide(lpFileName);
    DWORD err = ERROR_SUCCESS;
    if (!wide.empty() && !sandboxCheckPathDenyOnly(wide, AccessClass::Read, err)) {
        SetLastError(err);
        return INVALID_FILE_ATTRIBUTES;
    }
    return Real_GetFileAttributesA(lpFileName);
}

// -- FindFirstFileW/A（目录枚举 = read；通配符末段剥离后判定父目录）-------------

// FindFirstFile 的枚举路径常以通配符结尾（"dir\*"、"dir\*.txt"）：hook 判定的是
// 传入路径文本，通配分量若不去除会落到父目录规则之外——例如精确 deny 子目录被
// "dir\*" 枚举绕过（default=allow 下逃逸，实测 cmd `dir denied\` 会列出内容）。
// 判定前把末段含 * 或 ? 的分量剥掉（按父目录判定），与目录语义对齐。
static bool findFirstPathForCheck(const std::wstring& raw, std::wstring& out)
{
    std::wstring p = raw;
    size_t sep = p.find_last_of(L"\\/");
    std::wstring last = sep == std::wstring::npos ? p : p.substr(sep + 1);
    if (last.find_first_of(L"*?") != std::wstring::npos) {
        if (sep == std::wstring::npos) return false;   // 纯通配（无父路径）：放行
        p.resize(sep);
        if (p.size() == 2 && p[1] == L':') p.push_back(L'\\');   // "C:" -> "C:\"
    }
    out = p;
    return true;
}

HANDLE WINAPI Hook_FindFirstFileW(LPCWSTR lpFileName, LPWIN32_FIND_DATAW lpFindData)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr)
        return Real_FindFirstFileW(lpFileName, lpFindData);
    HookGuard guard;
    std::wstring checkPath;
    if (findFirstPathForCheck(lpFileName, checkPath)) {
        DWORD err = ERROR_SUCCESS;
        if (!sandboxCheckPath(checkPath, AccessClass::Read, err)) {
            SetLastError(err);
            return INVALID_HANDLE_VALUE;
        }
    }
    return Real_FindFirstFileW(lpFileName, lpFindData);
}

HANDLE WINAPI Hook_FindFirstFileA(LPCSTR lpFileName, LPWIN32_FIND_DATAA lpFindData)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr)
        return Real_FindFirstFileA(lpFileName, lpFindData);
    HookGuard guard;
    std::wstring wide = ansiToWide(lpFileName);
    std::wstring checkPath;
    if (!wide.empty() && findFirstPathForCheck(wide, checkPath)) {
        DWORD err = ERROR_SUCCESS;
        if (!sandboxCheckPath(checkPath, AccessClass::Read, err)) {
            SetLastError(err);
            return INVALID_HANDLE_VALUE;
        }
    }
    return Real_FindFirstFileA(lpFileName, lpFindData);
}

// -- CreateDirectoryW/A ------------------------------------------------------

BOOL WINAPI Hook_CreateDirectoryW(LPCWSTR lpPathName, LPSECURITY_ATTRIBUTES lpSA)
{
    if (HookGuard::inHook() || !g_hooked || lpPathName == nullptr)
        return Real_CreateDirectoryW(lpPathName, lpSA);
    HookGuard guard;
    // 目录已存在时 CreateDirectoryW 是无操作（"确保目录存在"探测，PowerShell
    // 等框架行为）：不触发 ask，但 deny 规则仍拦截（防逃逸）。真实创建（目录
    // 不存在）按 write 正常判定。
    {
        WIN32_FILE_ATTRIBUTE_DATA fad;
        if (GetFileAttributesExW(lpPathName, GetFileExInfoStandard, &fad)) {
            DWORD perr = ERROR_SUCCESS;
            if (!sandboxCheckPathDenyOnly(lpPathName, AccessClass::Write, perr)) {
                SetLastError(perr);
                return FALSE;
            }
            return Real_CreateDirectoryW(lpPathName, lpSA);
        }
    }
    DWORD err = ERROR_SUCCESS;
    if (!sandboxCheckPath(lpPathName, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    return Real_CreateDirectoryW(lpPathName, lpSA);
}

BOOL WINAPI Hook_CreateDirectoryA(LPCSTR lpPathName, LPSECURITY_ATTRIBUTES lpSA)
{
    if (HookGuard::inHook() || !g_hooked || lpPathName == nullptr)
        return Real_CreateDirectoryA(lpPathName, lpSA);
    HookGuard guard;
    std::wstring wide = ansiToWide(lpPathName);
    // 目录已存在：无操作探测（不触发 ask，deny 仍拦，见 W 版注释）
    if (!wide.empty()) {
        WIN32_FILE_ATTRIBUTE_DATA fad;
        if (GetFileAttributesExW(wide.c_str(), GetFileExInfoStandard, &fad)) {
            DWORD perr = ERROR_SUCCESS;
            if (!sandboxCheckPathDenyOnly(wide, AccessClass::Write, perr)) {
                SetLastError(perr);
                return FALSE;
            }
            return Real_CreateDirectoryA(lpPathName, lpSA);
        }
    }
    DWORD err = ERROR_SUCCESS;
    if (!wide.empty() && !sandboxCheckPath(wide, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    return Real_CreateDirectoryA(lpPathName, lpSA);
}

// -- DeleteFileW/A / RemoveDirectoryW/A（write + 回收站）-----------------------

BOOL WINAPI Hook_DeleteFileW(LPCWSTR lpFileName)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr)
        return Real_DeleteFileW(lpFileName);
    HookGuard guard;
    // 沙箱会话内创建的文件：自发清理，不 ask、不进回收站，直接删除
    if (sandboxSessionCreated(lpFileName)) return Real_DeleteFileW(lpFileName);
    DWORD err = ERROR_SUCCESS;
    if (!sandboxCheckPath(lpFileName, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    if (g_delToTrash) {
        bool rec = RecycleGuard::active();
        if (rec) {
            // 回收流程进行中：此删除要么是 SHFileOperation 内部（工作线程）对
            // 已移入回收站的原文件执行清理（文件已不在原位置，直接删除无害），
            // 要么是其他线程对无关文件的并发删除——直接真实删除，避免第二个
            // 并发 SHFileOperation 死锁，也避免静默吞掉无关删除。
            return Real_DeleteFileW(lpFileName);
        }
        return recycleToTrash(lpFileName) ? TRUE : FALSE;
    }
    return Real_DeleteFileW(lpFileName);
}

BOOL WINAPI Hook_DeleteFileA(LPCSTR lpFileName)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr)
        return Real_DeleteFileA(lpFileName);
    HookGuard guard;
    std::wstring wide = ansiToWide(lpFileName);
    if (!wide.empty() && sandboxSessionCreated(wide)) return Real_DeleteFileA(lpFileName);
    DWORD err = ERROR_SUCCESS;
    if (!wide.empty() && !sandboxCheckPath(wide, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    if (g_delToTrash) return recycleToTrash(wide) ? TRUE : FALSE;
    return Real_DeleteFileA(lpFileName);
}

BOOL WINAPI Hook_RemoveDirectoryW(LPCWSTR lpPathName)
{
    if (HookGuard::inHook() || !g_hooked || lpPathName == nullptr)
        return Real_RemoveDirectoryW(lpPathName);
    HookGuard guard;
    DWORD err = ERROR_SUCCESS;
    if (!sandboxCheckPath(lpPathName, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    if (g_delToTrash) return recycleToTrash(lpPathName) ? TRUE : FALSE;
    return Real_RemoveDirectoryW(lpPathName);
}

BOOL WINAPI Hook_RemoveDirectoryA(LPCSTR lpPathName)
{
    if (HookGuard::inHook() || !g_hooked || lpPathName == nullptr)
        return Real_RemoveDirectoryA(lpPathName);
    HookGuard guard;
    std::wstring wide = ansiToWide(lpPathName);
    DWORD err = ERROR_SUCCESS;
    if (!wide.empty() && !sandboxCheckPath(wide, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    if (g_delToTrash) return recycleToTrash(wide) ? TRUE : FALSE;
    return Real_RemoveDirectoryA(lpPathName);
}

// -- MoveFileW/A / MoveFileExW/A（源与目标均 write）---------------------------

static BOOL checkMovePaths(const std::wstring& from, const std::wstring& to)
{
    DWORD err = ERROR_SUCCESS;
    if (!from.empty() && !sandboxCheckPath(from, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    if (!to.empty() && !sandboxCheckPath(to, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    return TRUE;
}

BOOL WINAPI Hook_MoveFileW(LPCWSTR lpExisting, LPCWSTR lpNew)
{
    if (HookGuard::inHook() || !g_hooked) return Real_MoveFileW(lpExisting, lpNew);
    HookGuard guard;
    if (!checkMovePaths(lpExisting ? lpExisting : L"", lpNew ? lpNew : L"")) return FALSE;
    return Real_MoveFileW(lpExisting, lpNew);
}

BOOL WINAPI Hook_MoveFileA(LPCSTR lpExisting, LPCSTR lpNew)
{
    if (HookGuard::inHook() || !g_hooked) return Real_MoveFileA(lpExisting, lpNew);
    HookGuard guard;
    if (!checkMovePaths(ansiToWide(lpExisting), ansiToWide(lpNew))) return FALSE;
    return Real_MoveFileA(lpExisting, lpNew);
}

BOOL WINAPI Hook_MoveFileExW(LPCWSTR lpExisting, LPCWSTR lpNew, DWORD dwFlags)
{
    if (HookGuard::inHook() || !g_hooked) return Real_MoveFileExW(lpExisting, lpNew, dwFlags);
    HookGuard guard;
    if (!checkMovePaths(lpExisting ? lpExisting : L"", lpNew ? lpNew : L"")) return FALSE;
    return Real_MoveFileExW(lpExisting, lpNew, dwFlags);
}

BOOL WINAPI Hook_MoveFileExA(LPCSTR lpExisting, LPCSTR lpNew, DWORD dwFlags)
{
    if (HookGuard::inHook() || !g_hooked) return Real_MoveFileExA(lpExisting, lpNew, dwFlags);
    HookGuard guard;
    if (!checkMovePaths(ansiToWide(lpExisting), ansiToWide(lpNew))) return FALSE;
    return Real_MoveFileExA(lpExisting, lpNew, dwFlags);
}

// -- CopyFileW/A / CopyFileExW（源 read + 目标 write）--------------------------

static BOOL checkCopyPaths(const std::wstring& from, const std::wstring& to)
{
    DWORD err = ERROR_SUCCESS;
    if (!from.empty() && !sandboxCheckPath(from, AccessClass::Read, err)) {
        SetLastError(err);
        return FALSE;
    }
    if (!to.empty() && !sandboxCheckPath(to, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    return TRUE;
}

BOOL WINAPI Hook_CopyFileW(LPCWSTR lpExisting, LPCWSTR lpNew, BOOL bFailIfExists)
{
    if (HookGuard::inHook() || !g_hooked) return Real_CopyFileW(lpExisting, lpNew, bFailIfExists);
    HookGuard guard;
    if (!checkCopyPaths(lpExisting ? lpExisting : L"", lpNew ? lpNew : L"")) return FALSE;
    return Real_CopyFileW(lpExisting, lpNew, bFailIfExists);
}

BOOL WINAPI Hook_CopyFileA(LPCSTR lpExisting, LPCSTR lpNew, BOOL bFailIfExists)
{
    if (HookGuard::inHook() || !g_hooked) return Real_CopyFileA(lpExisting, lpNew, bFailIfExists);
    HookGuard guard;
    if (!checkCopyPaths(ansiToWide(lpExisting), ansiToWide(lpNew))) return FALSE;
    return Real_CopyFileA(lpExisting, lpNew, bFailIfExists);
}

BOOL WINAPI Hook_CopyFileExW(LPCWSTR lpExisting, LPCWSTR lpNew, LPPROGRESS_ROUTINE lpProgress,
                             LPVOID lpData, LPBOOL pbCancel, DWORD dwCopyFlags)
{
    if (HookGuard::inHook() || !g_hooked)
        return Real_CopyFileExW(lpExisting, lpNew, lpProgress, lpData, pbCancel, dwCopyFlags);
    HookGuard guard;
    if (!checkCopyPaths(lpExisting ? lpExisting : L"", lpNew ? lpNew : L"")) return FALSE;
    return Real_CopyFileExW(lpExisting, lpNew, lpProgress, lpData, pbCancel, dwCopyFlags);
}

// -- SetFileAttributesW/A -----------------------------------------------------

BOOL WINAPI Hook_SetFileAttributesW(LPCWSTR lpFileName, DWORD dwAttributes)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr)
        return Real_SetFileAttributesW(lpFileName, dwAttributes);
    HookGuard guard;
    DWORD err = ERROR_SUCCESS;
    if (!sandboxCheckPath(lpFileName, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    return Real_SetFileAttributesW(lpFileName, dwAttributes);
}

BOOL WINAPI Hook_SetFileAttributesA(LPCSTR lpFileName, DWORD dwAttributes)
{
    if (HookGuard::inHook() || !g_hooked || lpFileName == nullptr)
        return Real_SetFileAttributesA(lpFileName, dwAttributes);
    HookGuard guard;
    std::wstring wide = ansiToWide(lpFileName);
    DWORD err = ERROR_SUCCESS;
    if (!wide.empty() && !sandboxCheckPath(wide, AccessClass::Write, err)) {
        SetLastError(err);
        return FALSE;
    }
    return Real_SetFileAttributesA(lpFileName, dwAttributes);
}

// -- SetFileInformationByHandle（句柄级删除/改名：Node rmSync、.NET 等走此路径）-

BOOL WINAPI Hook_SetFileInformationByHandle(HANDLE hFile, FILE_INFO_BY_HANDLE_CLASS fileInformationClass,
                                            LPVOID lpFileInformation, DWORD dwBufferSize)
{
    if (HookGuard::inHook() || !g_hooked || hFile == nullptr || hFile == INVALID_HANDLE_VALUE)
        return Real_SetFileInformationByHandle(hFile, fileInformationClass, lpFileInformation, dwBufferSize);
    HookGuard guard;
    switch (fileInformationClass) {
        case FileDispositionInfo:      // 删除
        case FileDispositionInfoEx:    // 删除（扩展）
        {
            wchar_t pathBuf[MAX_PATH];
            DWORD n = GetFinalPathNameByHandleW(hFile, pathBuf, MAX_PATH, FILE_NAME_NORMALIZED);
            if (n > 0 && n < MAX_PATH) {
                std::wstring p(pathBuf, n);
                // 沙箱会话内创建：自发清理，直接删（不 ask、不进回收站）
                if (sandboxSessionCreated(p)) break;
                DWORD err = ERROR_SUCCESS;
                if (!sandboxCheckPath(p, AccessClass::Write, err)) {
                    SetLastError(err);
                    return FALSE;
                }
                // 句柄级删除（Node fs.rmSync / .NET File.Delete 等）同样接入回收站
                if (g_delToTrash) {
                    if (RecycleGuard::active()) break;   // 回收流程进行中：交由真实句柄删除
                    bool trashed = recycleToTrash(p);
                    SetLastError(trashed ? ERROR_SUCCESS : ERROR_ACCESS_DENIED);
                    return trashed ? TRUE : FALSE;
                }
            }
            break;
        }
        case FileRenameInfo:           // 改名
        case FileRenameInfoEx:         // 改名（扩展）
        {
            std::wstring src;
            if (finalPathByHandle(hFile, src)) {
                DWORD err = ERROR_SUCCESS;
                if (!sandboxCheckPath(src, AccessClass::Write, err)) {
                    SetLastError(err);
                    return FALSE;
                }
                // 目标路径同样必须通过策略判定（源+目标双检查，与 MoveFileEx 对齐，
                // 防止句柄级 rename 把文件移入 deny 目录/沙箱外）。
                bool isEx = fileInformationClass == FileRenameInfoEx;
                if (!sandboxCheckRenameTarget(src, lpFileInformation, dwBufferSize, isEx, err)) {
                    SetLastError(err);
                    return FALSE;
                }
            }
            break;
        }
        default:
            break;
    }
    return Real_SetFileInformationByHandle(hFile, fileInformationClass, lpFileInformation, dwBufferSize);
}

} // namespace sbx