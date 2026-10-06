/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <windows.h>
#include <string>

#include "../common/policy.h"

namespace sbx {

// 访问类别（与策略 kind 对应）
enum class AccessClass { Read, Write, Execute };

// hook 全局状态（dllmain.cpp 初始化，hooks_*.cpp 使用）
extern bool g_hooked;           // Detour patch 是否已提交
extern bool g_delToTrash;       // 删除送回收站
extern std::wstring g_trashDir; // OpenDesk 统一回收站目录（DYNOBOX_TRASH_DIR，<opendesk>/trash/<taskId>）
extern std::wstring g_trashExclude; // 回收站排除清单（DYNOBOX_TRASH_EXCLUDE，';' 分隔目录前缀）
extern Policy g_policy;         // 子进程内联策略（roots 已展开）

// 重入保护：hook 函数内部调用其他被 hook 的 API（SHFileOperation/GetLongPathName）
// 时置位，防止自身检测死循环。
struct HookGuard {
    __declspec(thread) static bool active;
    HookGuard() { active = true; }
    ~HookGuard() { active = false; }
    static bool inHook() { return active; }
};

// 归一化宿主路径 -> 虚拟路径 -> 策略判定。
// 返回值：true = 放行；false = 拒绝（此时 *winErr 写入 Win32 错误码：
//   ERROR_PATH_NOT_FOUND = 路径未映射到任何 root（not-found 语义）；
//   ERROR_ACCESS_DENIED  = 策略拒绝）。
bool sandboxCheckPath(const std::wstring& hostPath, AccessClass access, DWORD& winErr);

// 框架探测类操作的仅-deny 判定：ask/allow 一律放行（不触发 ask），deny 仍拦截。
bool sandboxCheckPathDenyOnly(const std::wstring& hostPath, AccessClass access, DWORD& winErr);

// 目录读探测的通用判定：read 类访问且目标当前是已存在目录时视为探测（不触发
// ask，deny 仍拦截）；目标非目录或不存在时返回 false（调用方走正常 read 判定）。
bool sandboxCheckDirReadProbe(const std::wstring& hostPath, DWORD& winErr);

// 会话内自建文件的读回判定：read 类访问且目标由沙箱会话内进程创建时视为读回
// 自身产物（不触发 ask，deny 仍拦截）；非会话内创建时返回 false。
bool sandboxCheckSessionCreatedRead(const std::wstring& hostPath, DWORD& winErr);

// 不存在路径的读放行：read 类访问且目标当前不存在（ENOENT 透传，不触发 ask，
// deny 仍拦截）；目标存在或查询失败时返回 false（走正常 read 判定）。
bool sandboxCheckNotExistRead(const std::wstring& hostPath, DWORD& winErr);

// 路径特殊设备/虚设备（NUL、CON、\\.\ 设备、命名管道）不做文件系统判定。
bool isSpecialDevicePath(const std::wstring& path);

// CreateFileW 的访问类别分解（与 Dokan 版 AccessKinds 语义对齐）。
AccessClass categorizeCreateAccess(DWORD desiredAccess, DWORD creationDisposition);

// 删除分流送回收站：配置了 DYNOBOX_TRASH_DIR 时移入 OpenDesk 统一回收站
// （<uuid>.back + summary.json 记录，供 GUI 文件回收站找回）；未配置时退回
// 系统回收站（SHFileOperation FOF_ALLOWUNDO）。成功返回 true（原文件已不在
// 原位置）；失败返回 false（调用方保留原文件，绝不静默永久删除）。
bool recycleToTrash(const std::wstring& path);

// 取句柄的完整规范化路径（\\?\ 前缀，动态缓冲避免 MAX_PATH 截断 fail-open）。
// 成功返回 true 并写 out；失败返回 false（句柄无路径/不可解析）。
bool finalPathByHandle(HANDLE hFile, std::wstring& out);

// 解析 FILE_RENAME_INFORMATION / FILE_RENAME_INFORMATION_EX 的目标路径并做 write 判定。
// info/bufferBytes：调用方传入的信息结构及其字节数（防越界读）。
// isEx：Ex 变体（Flags 字段版本，FileName 布局偏移相同）。
// 源路径已由调用方检查（sandboxCheckPath），此处只检查 rename 目标。
// 返回 true = 放行；false = 拒绝（*winErr 写 Win32 错误码）。
bool sandboxCheckRenameTarget(const std::wstring& sourcePath, const void* info, size_t bufferBytes,
                              bool isEx, DWORD& winErr);

// 判断路径是否"沙箱会话内创建"（文件创建时间 >= 会话开始时间，DYNOBOX_SESSION_START
// 由 runner 注入）。会话内创建的文件删除视为自发清理：不触发 ask、不进回收站，
// 直接删除（Dokan 版"实例内创建跟踪"的等价语义，无需共享内存/ADS）。
bool sandboxSessionCreated(const std::wstring& hostPath);

// 删除类操作的目标不存在判定：目标当前不存在（GetFileAttributesExW 返回
// FILE_NOT_FOUND / PATH_NOT_FOUND）→ 透传真实 API 结果，不进回收站。与
// sandboxCheckNotExistRead 同哲学（删除不存在文件是 no-op，回收站分流会把
// 无害操作变成 ACCESS_DENIED 致命错误——clang 编译 .o.tmp rename 即受害）。
// 返回 true = 应透传真实 API（*winErr 写判定错误码）；false = 正常删除判定。
bool sandboxCheckNotExistDelete(const std::wstring& hostPath, DWORD& winErr);

// -- 被拦截的 API 的原始入口（dllmain.cpp 初始化，hooks_*.cpp 使用）---------

extern "C" {
    extern HANDLE (WINAPI *Real_CreateFileW)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
    extern HANDLE (WINAPI *Real_CreateFileA)(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
    extern DWORD  (WINAPI *Real_GetFileAttributesW)(LPCWSTR);
    extern DWORD  (WINAPI *Real_GetFileAttributesA)(LPCSTR);
    extern HANDLE (WINAPI *Real_FindFirstFileW)(LPCWSTR, LPWIN32_FIND_DATAW);
    extern HANDLE (WINAPI *Real_FindFirstFileA)(LPCSTR, LPWIN32_FIND_DATAA);
    extern BOOL   (WINAPI *Real_CreateDirectoryW)(LPCWSTR, LPSECURITY_ATTRIBUTES);
    extern BOOL   (WINAPI *Real_CreateDirectoryA)(LPCSTR, LPSECURITY_ATTRIBUTES);
    extern BOOL   (WINAPI *Real_DeleteFileW)(LPCWSTR);
    extern BOOL   (WINAPI *Real_DeleteFileA)(LPCSTR);
    extern BOOL   (WINAPI *Real_RemoveDirectoryW)(LPCWSTR);
    extern BOOL   (WINAPI *Real_RemoveDirectoryA)(LPCSTR);
    extern BOOL   (WINAPI *Real_MoveFileW)(LPCWSTR, LPCWSTR);
    extern BOOL   (WINAPI *Real_MoveFileA)(LPCSTR, LPCSTR);
    extern BOOL   (WINAPI *Real_MoveFileExW)(LPCWSTR, LPCWSTR, DWORD);
    extern BOOL   (WINAPI *Real_MoveFileExA)(LPCSTR, LPCSTR, DWORD);
    extern BOOL   (WINAPI *Real_CopyFileW)(LPCWSTR, LPCWSTR, BOOL);
    extern BOOL   (WINAPI *Real_CopyFileA)(LPCSTR, LPCSTR, BOOL);
    extern BOOL   (WINAPI *Real_CopyFileExW)(LPCWSTR, LPCWSTR, LPPROGRESS_ROUTINE, LPVOID, LPBOOL, DWORD);
    extern BOOL   (WINAPI *Real_SetFileAttributesW)(LPCWSTR, DWORD);
    extern BOOL   (WINAPI *Real_SetFileAttributesA)(LPCSTR, DWORD);
    extern BOOL   (WINAPI *Real_SetFileInformationByHandle)(HANDLE, FILE_INFO_BY_HANDLE_CLASS, LPVOID, DWORD);
    extern BOOLEAN (WINAPI *Real_CreateSymbolicLinkW)(LPCWSTR, LPCWSTR, DWORD);
    extern BOOLEAN(WINAPI *Real_CreateSymbolicLinkA)(LPCSTR, LPCSTR, DWORD);
    extern BOOL   (WINAPI *Real_CreateProcessW)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
    extern BOOL   (WINAPI *Real_CreateProcessA)(LPCSTR, LPSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCSTR, LPSTARTUPINFOA, LPPROCESS_INFORMATION);
}

// -- 被拦截的 API 入口 -------------------------------------------------------

HANDLE WINAPI Hook_CreateFileW(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
HANDLE WINAPI Hook_CreateFileA(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
DWORD  WINAPI Hook_GetFileAttributesW(LPCWSTR);
DWORD  WINAPI Hook_GetFileAttributesA(LPCSTR);
HANDLE WINAPI Hook_FindFirstFileW(LPCWSTR, LPWIN32_FIND_DATAW);
HANDLE WINAPI Hook_FindFirstFileA(LPCSTR, LPWIN32_FIND_DATAA);
BOOL   WINAPI Hook_CreateDirectoryW(LPCWSTR, LPSECURITY_ATTRIBUTES);
BOOL   WINAPI Hook_CreateDirectoryA(LPCSTR, LPSECURITY_ATTRIBUTES);
BOOL   WINAPI Hook_DeleteFileW(LPCWSTR);
BOOL   WINAPI Hook_DeleteFileA(LPCSTR);
BOOL   WINAPI Hook_RemoveDirectoryW(LPCWSTR);
BOOL   WINAPI Hook_RemoveDirectoryA(LPCSTR);
BOOL   WINAPI Hook_MoveFileW(LPCWSTR, LPCWSTR);
BOOL   WINAPI Hook_MoveFileA(LPCSTR, LPCSTR);
BOOL   WINAPI Hook_MoveFileExW(LPCWSTR, LPCWSTR, DWORD);
BOOL   WINAPI Hook_MoveFileExA(LPCSTR, LPCSTR, DWORD);
BOOL   WINAPI Hook_CopyFileW(LPCWSTR, LPCWSTR, BOOL);
BOOL   WINAPI Hook_CopyFileA(LPCSTR, LPCSTR, BOOL);
BOOL   WINAPI Hook_CopyFileExW(LPCWSTR, LPCWSTR, LPPROGRESS_ROUTINE, LPVOID, LPBOOL, DWORD);
BOOL   WINAPI Hook_SetFileAttributesW(LPCWSTR, DWORD);
BOOL   WINAPI Hook_SetFileAttributesA(LPCSTR, DWORD);
BOOL   WINAPI Hook_SetFileInformationByHandle(HANDLE, FILE_INFO_BY_HANDLE_CLASS, LPVOID, DWORD);
BOOLEAN WINAPI Hook_CreateSymbolicLinkW(LPCWSTR, LPCWSTR, DWORD);
BOOLEAN WINAPI Hook_CreateSymbolicLinkA(LPCSTR, LPCSTR, DWORD);
BOOL   WINAPI Hook_CreateProcessW(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES,
                                  BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
BOOL   WINAPI Hook_CreateProcessA(LPCSTR, LPSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES,
                                  BOOL, DWORD, LPVOID, LPCSTR, LPSTARTUPINFOA, LPPROCESS_INFORMATION);

} // namespace sbx