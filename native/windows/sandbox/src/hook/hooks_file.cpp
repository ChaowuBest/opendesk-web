/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "hook.h"

#include <shellapi.h>
#include <objbase.h>
#include <cstring>
#include <cwctype>
#include <vector>

#include "../common/log.h"
#include "../common/hook_scope.h"
#include "../common/utf.h"

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

namespace sbx {

// 去掉 GetFinalPathNameByHandle 返回的 \\?\ / \\?\UNC\ 前缀（SHFileOperation 与
// summary.json 记录都需要普通路径）。
static std::wstring normalizeWin32Path(const std::wstring& path)
{
    if (path.rfind(L"\\\\?\\UNC\\", 0) == 0) {
        return L"\\\\" + path.substr(8);
    }
    if (path.rfind(L"\\\\?\\", 0) == 0) {
        return path.substr(4);
    }
    return path;
}

// 生成随机 UUID v4（CoCreateGuid）并格式化为 RFC 4122 小写连字符形式，
// 与 Linux/OH/macOS 原生层及宿主侧回收站格式一致。
static bool generateUuidV4(std::wstring& out)
{
    GUID guid;
    if (CoCreateGuid(&guid) != S_OK) return false;
    wchar_t buf[40] = {};
    swprintf_s(buf, L"%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
               (unsigned)guid.Data1, (unsigned)guid.Data2, (unsigned)guid.Data3,
               (unsigned)guid.Data4[0], (unsigned)guid.Data4[1],
               (unsigned)guid.Data4[2], (unsigned)guid.Data4[3], (unsigned)guid.Data4[4],
               (unsigned)guid.Data4[5], (unsigned)guid.Data4[6], (unsigned)guid.Data4[7]);
    out.assign(buf);
    return true;
}

// JSON 字符串转义：仅 \" \\ 与控制字符需要转义（\b \f \n \r \t 及 \u00XX）；
// 非 ASCII 按UTF-8 原样输出（合法 JSON，中文路径无需 \u 转义）。
static void jsonEscapeToUtf8(const std::wstring& value, std::string& out)
{
    out += '"';
    // 先整体转 UTF-8 再按字节转义：逐 wchar_t 转换会把非 BMP 字符（emoji 等
    // UTF-16 代理对）拆成孤立代理项，WideCharToMultiByte 产出 U+FFFD 损坏路径
    const std::string utf8 = wideToUtf8(value);
    for (unsigned char ch : utf8) {
        switch (ch) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (ch < 0x20) {
                    char esc[8];
                    sprintf_s(esc, "\\u%04x", (unsigned)ch);
                    out += esc;
                } else {
                    out += static_cast<char>(ch);
                }
                break;
        }
    }
    out += '"';
}

// ISO 8601 UTC 时间戳（毫秒精度），与宿主侧 TrashEntry.deleted_at 一致。
static std::wstring isoUtcNow()
{
    SYSTEMTIME st;
    GetSystemTime(&st);
    wchar_t buf[40] = {};
    swprintf_s(buf, L"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
               st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    return buf;
}

// 逐级创建目录（mkdir -p 等价；回收站目录多级：<opendesk>/trash/<taskId>）。
static bool ensureDirectoryRecursive(const std::wstring& directory)
{
    std::wstring dir = directory;
    while (!dir.empty() && (dir.back() == L'\\' || dir.back() == L'/')) dir.pop_back();
    if (dir.size() < 2) return false;
    for (size_t i = 1; i < dir.size(); i++) {
        if (dir[i] == L'\\' || dir[i] == L'/') {
            std::wstring prefix = dir.substr(0, i);
            // 跳过盘符根（C:\）与非前缀分隔符
            if (prefix.size() == 2 && prefix[1] == L':') continue;
            CreateDirectoryW(prefix.c_str(), nullptr); // 已存在时忽略错误
        }
    }
    if (!CreateDirectoryW(dir.c_str(), nullptr)) {
        DWORD err = GetLastError();
        if (err != ERROR_ALREADY_EXISTS) return false;
    }
    return true;
}

// 追加一条删除记录到 summary.json（顶层 JSON 数组）。同一任务的并发沙箱实例
// 会共写同一文件：独占 LockFileEx 下读-改-写；新条目追加到数组尾部（定位最后
// 的 ']'），避免整表解析/重写。旧文件损坏时改名留存（.corrupt-<tick>）后重建。
// 写入成功返回 true。
static bool appendTrashSummary(const std::wstring& trashDir, const std::wstring& uuid,
                               const std::wstring& originalPath, unsigned long long size,
                               const std::wstring& deletedAtIso)
{
    std::wstring summaryPath = trashDir + L"\\summary.json";
    // FILE_SHARE_DELETE：损坏重建需把已打开的 summary.json 改名留存
    HANDLE handle = CreateFileW(summaryPath.c_str(), GENERIC_READ | GENERIC_WRITE,
                                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        Log::warn(L"[TRASH] 打开 summary.json 失败(%lu): %ls", GetLastError(), summaryPath.c_str());
        return false;
    }
    OVERLAPPED region = {};
    if (!LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, MAXDWORD, MAXDWORD, &region)) {
        Log::warn(L"[TRASH] 锁定 summary.json 失败(%lu)", GetLastError());
        CloseHandle(handle);
        return false;
    }

    bool ok = false;
    std::string content;
    do {
        LARGE_INTEGER fileSize = {};
        if (!GetFileSizeEx(handle, &fileSize) || fileSize.QuadPart < 0 ||
            fileSize.QuadPart > 256 * 1024 * 1024) {
            Log::warn(L"[TRASH] summary.json 大小异常，跳过记录");
            break;
        }
        content.resize(static_cast<size_t>(fileSize.QuadPart));
        DWORD read = 0;
        SetFilePointer(handle, 0, nullptr, FILE_BEGIN);
        if (!ReadFile(handle, content.empty() ? nullptr : &content[0],
                      static_cast<DWORD>(content.size()), &read, nullptr)) {
            Log::warn(L"[TRASH] 读取 summary.json 失败(%lu)", GetLastError());
            break;
        }
        content.resize(read);

        // 条目 JSON（字段顺序与 Linux/OH/macOS 一致）
        std::string entry = "{\"uuid\":\"" + wideToUtf8(uuid) + "\",\"original_path\":";
        jsonEscapeToUtf8(originalPath, entry);
        entry += ",\"size\":" + std::to_string(size) + ",\"deleted_at\":\"" + wideToUtf8(deletedAtIso) + "\"}";

        // 顶层结构定位：合法文件形如 [ ... ]；缺失括号或顺序颠倒视为损坏
        size_t closeIdx = content.find_last_of(']');
        size_t openIdx = content.find('[');
        bool corrupt = closeIdx == std::string::npos || openIdx == std::string::npos || openIdx > closeIdx;

        std::string updated;
        if (!corrupt) {
            bool emptyArray = true;
            for (size_t i = openIdx + 1; i < closeIdx; i++) {
                unsigned char ch = static_cast<unsigned char>(content[i]);
                if (ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n') {
                    emptyArray = false;
                    break;
                }
            }
            if (emptyArray) {
                // "[ ]" → "[\n  <entry>\n]"
                updated = content.substr(0, openIdx + 1) + "\n  " + entry + "\n]" +
                          (closeIdx + 1 < content.size() ? content.substr(closeIdx + 1) : "");
            } else {
                // 非空数组：去掉尾部 ']' 及其后空白，追加逗号与条目
                updated = content.substr(0, closeIdx);
                while (!updated.empty() &&
                       (updated.back() == '\n' || updated.back() == '\r' || updated.back() == ' ' ||
                        updated.back() == '\t')) {
                    updated.pop_back();
                }
                updated += ",\n  " + entry + "\n]" +
                           (closeIdx + 1 < content.size() ? content.substr(closeIdx + 1) : "");
            }
        } else {
            // 文件损坏（非空时）：改名留存旧内容后重建空数组
            if (!content.empty()) {
                std::wstring backup = trashDir + L"\\summary.json.corrupt-" +
                                      std::to_wstring(GetTickCount64());
                if (!MoveFileExW(summaryPath.c_str(), backup.c_str(), MOVEFILE_REPLACE_EXISTING)) {
                    Log::warn(L"[TRASH] summary.json 留存失败(%lu)，跳过记录", GetLastError());
                    break;
                }
                Log::warn(L"[TRASH] summary.json 损坏，旧内容留存: %ls", backup.c_str());
                // 关闭指向已改名文件的句柄，重建全新文件
                UnlockFileEx(handle, 0, MAXDWORD, MAXDWORD, &region);
                CloseHandle(handle);
                handle = CreateFileW(summaryPath.c_str(), GENERIC_READ | GENERIC_WRITE,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                     nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
                if (handle == INVALID_HANDLE_VALUE) {
                    Log::warn(L"[TRASH] 重建 summary.json 失败(%lu)", GetLastError());
                    return false;
                }
                OVERLAPPED region2 = {};
                if (!LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, MAXDWORD, MAXDWORD, &region2)) {
                    Log::warn(L"[TRASH] 锁定重建的 summary.json 失败(%lu)", GetLastError());
                    CloseHandle(handle);
                    return false;
                }
                region = region2;
            }
            updated = "[\n  " + entry + "\n]";
        }

        DWORD written = 0;
        SetFilePointer(handle, 0, nullptr, FILE_BEGIN);
        // 先写后截断：写失败时旧内容完整保留，避免清空索引（WriteFile 成功后
        // 文件指针位于新内容末尾，SetEndOfFile 恰好截掉旧内容的残留尾部）
        if (!WriteFile(handle, updated.data(), static_cast<DWORD>(updated.size()), &written, nullptr) ||
            written != updated.size() ||
            !SetEndOfFile(handle)) {
            Log::warn(L"[TRASH] 写入 summary.json 失败(%lu)", GetLastError());
            break;
        }
        ok = true;
    } while (false);

    UnlockFileEx(handle, 0, MAXDWORD, MAXDWORD, &region);
    CloseHandle(handle);
    return ok;
}

// 递归复制目录树 src -> dst（跨卷目录移入回收站的兜底，定义见后）：
// 调用方必然处于回收流程（RecycleGuard 已进入、HookGuard TLS 已持有），
// 内部所有 Win32 API 都走真实实现，不会再被 hook 分流到回收站。
static bool copyDirectoryTree(const std::wstring& src, const std::wstring& dst);
// 递归删除目录树（原目录完整复制进回收站后清空原位置）。
static bool removeDirectoryTree(const std::wstring& dir);

// 配置了统一回收站（DYNOBOX_TRASH_DIR）时的删除实现：MoveFileExW 移动到
// <trashDir>\<uuid>.back（跨卷文件自动复制+删除），并追加 summary.json 记录
// 供 GUI 文件回收站搜索与找回。跨卷目录 MoveFileExW 不支持，退化为
// 复制目录树到回收站 + 删除原目录树（见 copyDirectoryTree / removeDirectoryTree）。
static bool moveToOpenDeskTrash(const std::wstring& normalizedPath)
{
    // 多级回收站目录防御性创建（宿主通常已建）
    if (!ensureDirectoryRecursive(g_trashDir)) {
        Log::warn(L"[TRASH] 回收站目录不可用，保留原文件: %ls", g_trashDir.c_str());
        return false;
    }
    std::wstring uuid;
    if (!generateUuidV4(uuid)) {
        Log::warn(L"[TRASH] UUID 生成失败，保留原文件: %ls", normalizedPath.c_str());
        return false;
    }
    // 大小：目录记 0，文件按字节数（GUI 列表展示用）
    unsigned long long sizeBytes = 0;
    bool isDirectory = false;
    {
        WIN32_FILE_ATTRIBUTE_DATA fad;
        if (GetFileAttributesExW(normalizedPath.c_str(), GetFileExInfoStandard, &fad)) {
            isDirectory = (fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            if (!isDirectory) {
                ULARGE_INTEGER fileSize;
                fileSize.LowPart = fad.nFileSizeLow;
                fileSize.HighPart = fad.nFileSizeHigh;
                sizeBytes = fileSize.QuadPart;
            }
        }
    }
    std::wstring target = g_trashDir + L"\\" + uuid + L".back";
    // MOVEFILE_COPY_ALLOWED：跨卷文件复制+删除；目录同卷直接移动、跨卷复制+删除
    DWORD flags = MOVEFILE_WRITE_THROUGH | (isDirectory ? 0 : MOVEFILE_COPY_ALLOWED);
    if (!MoveFileExW(normalizedPath.c_str(), target.c_str(), flags)) {
        DWORD moveErr = GetLastError();
        // 跨卷目录：MoveFileExW 不支持跨卷移动目录（ERROR_NOT_SAME_DEVICE）。
        // 退化为"先复制目录树到回收站，成功后再删除原目录树"——
        // 复制全部成功前绝不触碰原目录（fail-closed，绝不静默丢数据）。
        if (isDirectory && moveErr == ERROR_NOT_SAME_DEVICE) {
            if (!copyDirectoryTree(normalizedPath, target)) {
                Log::warn(L"[TRASH] 目录复制到回收站失败(%lu)，保留原文件: %ls",
                          GetLastError(), normalizedPath.c_str());
                return false;
            }
            // 原目录树已完整备份进回收站，删除原树。删除失败（如文件被占用）时
            // 残留留在原位置、回收站已有完整副本，下次删除可继续，不丢数据。
            if (!removeDirectoryTree(normalizedPath)) {
                Log::warn(L"[TRASH] 目录回收后原目录清理失败(%lu)，回收站已保留副本: %ls",
                          GetLastError(), normalizedPath.c_str());
            }
            appendTrashSummary(g_trashDir, uuid, normalizedPath, sizeBytes, isoUtcNow());
            return true;
        }
        // 跨卷文件/权限等失败：保留原文件（绝不静默永久删除）
        Log::warn(L"[TRASH] 移入回收站失败(%lu)，保留原文件: %ls", moveErr, normalizedPath.c_str());
        return false;
    }
    // 记录失败不回滚移动（文件已在回收站，仅无索引；下次删除可继续记录）
    appendTrashSummary(g_trashDir, uuid, normalizedPath, sizeBytes, isoUtcNow());
    return true;
}

// 递归复制目录树 src -> dst（跨卷目录移入回收站的兜底）。
// 调用方必然处于回收流程（RecycleGuard 已进入、HookGuard TLS 已持有），
// 此处所有 Win32 API 都走真实实现，不会再被 hook 分流到回收站。
// 目录符号链接/联接点（reparse point）只建同名空目录、不复制内容，避免
// 跟随链接递归到无关位置；文件链接按普通文件复制其指向的数据。
// 全部复制成功返回 true；中途失败返回 false（可能残留部分副本，无索引）。
static bool copyDirectoryTree(const std::wstring& src, const std::wstring& dst)
{
    if (!CreateDirectoryW(dst.c_str(), nullptr)) {
        DWORD err = GetLastError();
        if (err != ERROR_ALREADY_EXISTS) {
            return false;
        }
    }
    std::wstring search = src + L"\\*";
    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(search.c_str(), &fd);
    if (hFind == INVALID_HANDLE_VALUE) {
        // 空目录（无子项可枚举）视为复制完成；其他错误（无权限等）视为失败
        DWORD err = GetLastError();
        return err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND;
    }
    bool ok = true;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        std::wstring childSrc = src + L"\\" + fd.cFileName;
        std::wstring childDst = dst + L"\\" + fd.cFileName;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
                // 目录链接：只建同名空目录，不跟随复制
                if (!CreateDirectoryW(childDst.c_str(), nullptr) &&
                    GetLastError() != ERROR_ALREADY_EXISTS) {
                    ok = false;
                    break;
                }
            } else if (!copyDirectoryTree(childSrc, childDst)) {
                ok = false;
                break;
            }
        } else if (!CopyFileExW(childSrc.c_str(), childDst.c_str(), nullptr, nullptr, nullptr, 0)) {
            ok = false;
            break;
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    return ok;
}

// 递归删除目录树（回收流程内使用：原目录已完整复制进回收站后清空原位置）。
// 只读文件先清属性再删；目录链接按普通目录删除（RemoveDirectoryW 删链接本身）。
static bool removeDirectoryTree(const std::wstring& dir)
{
    std::wstring search = dir + L"\\*";
    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(search.c_str(), &fd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            std::wstring child = dir + L"\\" + fd.cFileName;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                if (!removeDirectoryTree(child)) {
                    FindClose(hFind);
                    return false;
                }
            } else {
                SetFileAttributesW(child.c_str(), FILE_ATTRIBUTE_NORMAL);
                if (!DeleteFileW(child.c_str())) {
                    FindClose(hFind);
                    return false;
                }
            }
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
    }
    SetFileAttributesW(dir.c_str(), FILE_ATTRIBUTE_NORMAL);
    return RemoveDirectoryW(dir.c_str()) != FALSE;
}

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

// 退路：系统回收站（未配置统一回收站目录时使用，SHFileOperation FOF_ALLOWUNDO）。
static bool recycleToSystemBin(const std::wstring& path)
{
    if (isRecycleBinDisabled()) {
        Log::warn(L"[TRASH] 回收站被系统策略禁用（NoRecycleBin/NukeOnDelete），保留原文件: %ls",
                  path.c_str());
        return false;
    }
    std::vector<wchar_t> buf(path.begin(), path.end());
    buf.push_back(L'\0');
    buf.push_back(L'\0');
    SHFILEOPSTRUCTW op = {};
    op.hwnd = nullptr;
    op.wFunc = FO_DELETE;
    op.pFrom = buf.data();
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
    int r = SHFileOperationW(&op);
    if (r != 0) {
        Log::warn(L"[TRASH] 回收站删除失败(%d)，保留原文件: %ls", r, path.c_str());
        return false;
    }
    return true;
}

bool recycleToTrash(const std::wstring& path)
{
    // 进程级重入/并发保护：SHFileOperation 是 shell 级共享操作，同一进程并发
    // 调用会互相等待直至死锁（hook 环境下实测），且其内部（工作线程）删除原
    // 文件若再进 recycleToTrash 会无限递归。首个回收者执行删除分流；
    // 流程进行中其他删除请求由各删除 hook 退化为直接删除（见 active() 调用点）。
    if (!RecycleGuard::tryEnter()) return true;
    struct RecycleLeave {
        ~RecycleLeave() { RecycleGuard::leave(); }
    } recycleLeave;

    std::wstring p = normalizeWin32Path(path);
    // 配置了 OpenDesk 统一回收站目录：移入该目录并记录 summary.json
    if (!g_trashDir.empty()) {
        return moveToOpenDeskTrash(p);
    }
    return recycleToSystemBin(p);
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
    // read 类通用探测豁免：目标为已存在目录（路径链校验/可遍历性检查）、会话内
    // 自建文件读回（PowerShell __PSScriptPolicyTest 等）、目标不存在（ENOENT
    // 透传——真实 API 对宿主返回 not-found，与无沙箱行为一致）→ 均不触发 ask，
    // deny 仍拦截。目标存在且为文件时走正常 read 判定（内容读取受策略管控）。
    if (categorizeCreateAccess(dwDesiredAccess, dwCreationDisposition) == AccessClass::Read) {
        DWORD perr = ERROR_SUCCESS;
        if (sandboxCheckDirReadProbe(lpFileName, perr) ||
            sandboxCheckSessionCreatedRead(lpFileName, perr) ||
            sandboxCheckNotExistRead(lpFileName, perr)) {
            return Real_CreateFileW(lpFileName, dwDesiredAccess, dwShareMode, lpSA,
                                    dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
        }
    }
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
    // 同 W 版：read 类访问的目录探测/会话内读回/不存在路径透传 → 不 ask
    if (!wide.empty() &&
        categorizeCreateAccess(dwDesiredAccess, dwCreationDisposition) == AccessClass::Read) {
        DWORD perr = ERROR_SUCCESS;
        if (sandboxCheckDirReadProbe(wide, perr) ||
            sandboxCheckSessionCreatedRead(wide, perr) ||
            sandboxCheckNotExistRead(wide, perr)) {
            return Real_CreateFileA(lpFileName, dwDesiredAccess, dwShareMode, lpSA,
                                    dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile);
        }
    }
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
        // read 类通用探测豁免：已存在目录枚举（列目录只返回名字）、会话内自建
        // 文件读回、不存在路径透传（FindFirstFile 返回 not-found，与宿主一致）
        // → 不触发 ask，deny 仍拦截。存在文件走正常 read 判定。
        if (!sandboxCheckDirReadProbe(checkPath, err) &&
            !sandboxCheckSessionCreatedRead(checkPath, err) &&
            !sandboxCheckNotExistRead(checkPath, err) &&
            !sandboxCheckPath(checkPath, AccessClass::Read, err)) {
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
        // 同 W 版：已存在目录枚举/会话内读回/不存在路径透传按探测处理
        if (!sandboxCheckDirReadProbe(checkPath, err) &&
            !sandboxCheckSessionCreatedRead(checkPath, err) &&
            !sandboxCheckNotExistRead(checkPath, err) &&
            !sandboxCheckPath(checkPath, AccessClass::Read, err)) {
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
    // 删除不存在的文件 = no-op（POSIX unlink 同样返回 ENOENT）：透传真实 API，
    // 不触发 ask、不进回收站（否则无害操作被回收站失败变成 ACCESS_DENIED，破坏
    // clang 等工具对已清理临时文件的残留句柄清理）。
    DWORD notExistErr = ERROR_SUCCESS;
    if (sandboxCheckNotExistDelete(lpFileName, notExistErr)) {
        SetLastError(notExistErr);
        return Real_DeleteFileW(lpFileName);
    }
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
    // 删除不存在的文件 = no-op：透传真实 API，不进回收站
    DWORD notExistErr = ERROR_SUCCESS;
    if (!wide.empty() && sandboxCheckNotExistDelete(wide, notExistErr)) {
        SetLastError(notExistErr);
        return Real_DeleteFileA(lpFileName);
    }
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
    // 删除不存在的目录 = no-op：透传真实 API，不进回收站
    DWORD notExistErr = ERROR_SUCCESS;
    if (sandboxCheckNotExistDelete(lpPathName, notExistErr)) {
        SetLastError(notExistErr);
        return Real_RemoveDirectoryW(lpPathName);
    }
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
    // 删除不存在的目录 = no-op：透传真实 API，不进回收站
    DWORD notExistErr = ERROR_SUCCESS;
    if (!wide.empty() && sandboxCheckNotExistDelete(wide, notExistErr)) {
        SetLastError(notExistErr);
        return Real_RemoveDirectoryA(lpPathName);
    }
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
                // 句柄指向的文件已不存在（残留句柄的删除标记，clang 等工具对已
                // rename/清理文件的清理）：透传真实句柄删除（no-op），不进回收站。
                DWORD notExistErr = ERROR_SUCCESS;
                if (sandboxCheckNotExistDelete(p, notExistErr)) {
                    SetLastError(notExistErr);
                    break;   // 交真实句柄删除（文件已不在，返回宿主一致的 ENOENT 语义）
                }
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