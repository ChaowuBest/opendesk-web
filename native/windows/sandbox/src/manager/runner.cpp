/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "runner.h"

#include <vector>
#include <winternl.h>

#include "../common/log.h"
#include "../common/policy.h"
#include "../hook/inject.h"
#include "detours.h"

namespace sbx {

// 获取本进程（sandbox.exe）的直接父进程 PID：OpenDesk 主进程退出（退出/崩溃/
// 被强杀）不会级联子进程，Windows 上父进程死亡后子进程会继续运行——沙箱必须
// 监护父进程，父先退出则终止自身（Job KILL_ON_JOB_CLOSE 随之杀整棵沙箱树），
// 否则用户的机器上会残留孤儿沙箱进程（bash/cmd/node 后代继续跑）。
static DWORD getParentProcessId()
{
    typedef NTSTATUS(NTAPI* FN_NtQueryInformationProcess)(
        HANDLE, ULONG, PVOID, ULONG, PULONG);
    static FN_NtQueryInformationProcess fn = (FN_NtQueryInformationProcess)GetProcAddress(
        GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
    if (!fn) return 0;
    typedef struct {
        PVOID Reserved1;
        PVOID PebBaseAddress;
        PVOID Reserved2[2];
        ULONG_PTR UniqueProcessId;
        ULONG_PTR InheritedFromUniqueProcessId;
    } PROCESS_BASIC_INFORMATION;
    PROCESS_BASIC_INFORMATION pbi = {};
    ULONG len = 0;
    if (fn(GetCurrentProcess(), 0, &pbi, sizeof(pbi), &len) < 0) return 0;
    return (DWORD)pbi.InheritedFromUniqueProcessId;
}

std::wstring resolveHookDll(bool archIs64)
{
    wchar_t self[MAX_PATH];
    DWORD n = GetModuleFileNameW(nullptr, self, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return L"";
    std::wstring dir(self, n);
    size_t slash = dir.find_last_of(L'\\');
    if (slash == std::wstring::npos) return L"";
    dir.resize(slash + 1);
    std::wstring name = archIs64 ? L"sandbox_hook.dll" : L"sandbox_hook32.dll";
    std::wstring full = dir + name;
    return GetFileAttributesW(full.c_str()) != INVALID_FILE_ATTRIBUTES ? full : L"";
}

bool peIs64Bit(const std::wstring& exePath)
{
    HANDLE h = CreateFileW(exePath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return true;   // 读不到按 64 位处理（多数场景）
    IMAGE_DOS_HEADER dos;
    bool is64 = true;
    do {
        DWORD read = 0;
        if (!ReadFile(h, &dos, sizeof(dos), &read, nullptr) || read != sizeof(dos)) break;
        if (dos.e_magic != IMAGE_DOS_SIGNATURE) break;
        LARGE_INTEGER off;
        off.QuadPart = dos.e_lfanew;
        if (!SetFilePointerEx(h, off, nullptr, FILE_BEGIN)) break;
        IMAGE_NT_HEADERS64 nt;
        if (!ReadFile(h, &nt, sizeof(nt), &read, nullptr) || read < sizeof(nt.Signature) + sizeof(nt.FileHeader)) break;
        if (nt.Signature != IMAGE_NT_SIGNATURE) break;
        is64 = nt.FileHeader.Machine != IMAGE_FILE_MACHINE_I386;
    } while (false);
    CloseHandle(h);
    return is64;
}

// -- 构造子进程环境块 ---------------------------------------------------------

static std::wstring buildEnvironment(const SandboxLaunchOptions& opts)
{
    // 从当前进程环境复制，附加沙箱变量与 --env
    LPWCH raw = GetEnvironmentStringsW();
    std::vector<std::wstring> entries;
    if (raw) {
        for (LPWCH p = raw; *p; p += wcslen(p) + 1)
            entries.emplace_back(p);
        FreeEnvironmentStringsW(raw);
    }

    auto set = [&](const std::wstring& key, const std::wstring& value) {
        std::wstring kv = key + L"=" + value;
        for (auto& e : entries) {
            if (e.size() > key.size() && e.compare(0, key.size() + 1, key + L"=") == 0) {
                e = std::move(kv);
                return;
            }
        }
        entries.push_back(std::move(kv));
    };

    set(L"DYNOBOX_SANDBOX", L"1");
    set(L"DYNOBOX_POLICY", opts.policyPath);
    // 判定日志通道：把 --log-file 路径与 -v 开关注入子进程，hook 侧 DllMain 据此
    // 打开同一日志文件并把每次策略判定（[POLICY] 行）写回——管理进程与整棵沙箱树
    // 的判定记录汇聚到同一文件，事故后可归因（此前 hook 判定日志只进 stderr，
    // 不落盘，日志退化成只有策略行+退出码的 stub）。
    if (!opts.logFile.empty()) set(L"DYNOBOX_LOG_FILE", opts.logFile);
    if (opts.verbose) set(L"DYNOBOX_VERBOSE", L"1");
    // 沙箱会话开始时刻（FILETIME 十进制）：hook 据此判断"会话内创建"的文件，
    // 删除时视为自发清理（不 ask、不进回收站）
    {
        FILETIME ft;
        GetSystemTimeAsFileTime(&ft);
        ULARGE_INTEGER ul;
        ul.LowPart = ft.dwLowDateTime;
        ul.HighPart = ft.dwHighDateTime;
        set(L"DYNOBOX_SESSION_START", std::to_wstring(ul.QuadPart));
    }
    if (!opts.srcDir.empty()) {
        set(L"DYNOBOX_SRC", opts.srcDir);
    } else if (opts.automount) {
        set(L"DYNOBOX_AUTOMOUNT", L"1");
    }
    if (opts.delToTrash) set(L"DYNOBOX_DEL_TO_TRASH", L"1");
    // 统一回收站目录：hook 据此移入 <opendesk>/trash/<taskId>/<uuid>.back 并记录
    // summary.json；无论 delToTrash 开关与否都注入（原生层仅在开关开启时使用）
    if (!opts.trashDir.empty()) set(L"DYNOBOX_TRASH_DIR", opts.trashDir);
    // 回收站排除清单：hook 删除分流命中直接真删（临时目录零噪音，见 hooks_file.cpp）
    if (!opts.trashExclude.empty()) set(L"DYNOBOX_TRASH_EXCLUDE", opts.trashExclude);
    if (!opts.upstream.empty()) set(L"DYNOBOX_UPSTREAM", opts.upstream);
    if (!opts.askToken.empty()) set(L"DYNOBOX_ASK_TOKEN", opts.askToken);
    for (const auto& [k, v] : opts.envExtra) set(k, v);

    std::wstring block;
    for (const auto& e : entries) {
        block += e;
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

int runSandbox(const SandboxLaunchOptions& opts)
{
    // 校验策略（hook DLL 会自己再加载一份，这里提前暴露错误）
    try {
        Policy p = Policy::loadFromFile(opts.policyPath);
        Log::info(L"策略: %zu 条规则, default=%hs, ask=%ls (timeout=%dms, cache=%ds)",
                  p.rules().size(), p.def().c_str(), p.askConfig().endpoint.c_str(),
                  p.askConfig().timeoutMs, p.askConfig().cacheTtlSeconds);
    } catch (const std::exception& e) {
        Log::error(L"策略加载失败: %hs", e.what());
        return 1;
    }

    // 目标 exe 架构决定注入的 hook DLL。用 CommandLineToArgvW 标准解析 argv[0]
    // （正确处理引号与"Program Files"这类含空格路径），裸名再用 SearchPathW
    // 解析为完整路径（如 "bash" -> C:\Program Files\Git\usr\bin\bash.exe）。
    std::wstring exe;
    {
        int argc = 0;
        LPWSTR* argv = CommandLineToArgvW(opts.commandLine.c_str(), &argc);
        if (argv && argc > 0) exe = argv[0];
        if (argv) LocalFree(argv);
        if (!exe.empty() && exe.find_first_of(L"\\/") == std::wstring::npos) {
            wchar_t found[MAX_PATH];
            DWORD n = SearchPathW(nullptr, exe.c_str(), L".exe", MAX_PATH, found, nullptr);
            if (n > 0 && n < MAX_PATH) exe = found;
        }
    }
    std::wstring hookDll = resolveHookDll(peIs64Bit(exe));
    if (hookDll.empty()) {
        Log::error(L"未找到 hook DLL（sandbox_hook.dll），沙箱不可用");
        return 1;
    }

    // cygwin 程序（MSYS2/Git 的 bash/ls/rm 等）主进程注入 hook 但用"删除相关
    // 最小 hook 集"（hook DLL 按 cygwin1.dll 检测自动降级）：完整 detours patch
    // 与 cygwin fork 机制性冲突（fork 复制被 patch 的内存 → wait 挂死），最小集
    // 在保留 fork 可用性的同时尽量覆盖删除路径的管控（实验阶段）。
    auto isCygwinTarget = [](const std::wstring& ep) -> bool {
        return ep.find(L"\\Git\\") != std::wstring::npos ||
               ep.find(L"\\usr\\bin\\") != std::wstring::npos ||
               ep.find(L"msys64") != std::wstring::npos;
    };
    const bool isCygwin = isCygwinTarget(exe);
    // cygwin 目标（MSYS2/Git 的 bash/ls/rm 等）不注入 hook：detours patch 与
    // cygwin 完全不兼容（任何 hook 集都破坏 fork，完整集连基本文件操作都会
    // 异常）——cygwin 进程的 IO 不受管控是架构边界，见 README 已知限制。
    const bool injectHook = !isCygwin;

    // Job 容器：管理进程退出 => 整树终止；不授予 BREAKAWAY_OK -> 无法脱离
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        Log::error(L"CreateJobObject 失败: %lu", GetLastError());
        return 1;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = {};
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
        Log::error(L"SetInformationJobObject 失败: %lu", GetLastError());
        CloseHandle(job);
        return 1;
    }

    std::wstring envBlock = buildEnvironment(opts);
    std::vector<wchar_t> envBuf(envBlock.begin(), envBlock.end());
    envBuf.push_back(L'\0');

    std::wstring cmdLine = opts.commandLine;
    std::vector<wchar_t> cmdBuf(cmdLine.begin(), cmdLine.end());
    cmdBuf.push_back(L'\0');

    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = {};

    // 以 CREATE_SUSPENDED 创建子进程，注入 hook DLL 后由我们 Assign 到 Job 再
    // resume（无后代逃逸窗口）。
    BOOL created = FALSE;
    // 注入流程需要 CREATE_SUSPENDED（等待注入完成再 resume）；cygwin 目标不注入
    // 时直接创建（不挂起），避免任何启动时序差异。
    const DWORD createFlags = (injectHook ? CREATE_SUSPENDED : 0) | CREATE_UNICODE_ENVIRONMENT;
    created = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, FALSE,
                             createFlags,
                             envBuf.data(), nullptr, &si, &pi);
    if (!created) {
        DWORD err = GetLastError();
        Log::error(L"CreateProcessW 失败: %lu（命令行: %ls）", err, cmdLine.c_str());
        CloseHandle(job);
        return 1;
    }
    // 经典注入：CreateRemoteThread + LoadLibraryW（完整路径）；等待注入完成
    // （DllMain 已安装 hook）再 Assign Job / resume，无加载竞态。
    if (injectHook && !injectHookDll(pi.hProcess, hookDll)) {
        DWORD err = GetLastError();
        Log::error(L"hook DLL 注入失败: %lu（hook=%ls）", err, hookDll.c_str());
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        return 1;
    }

    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        Log::error(L"AssignProcessToJobObject 失败: %lu", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        return 1;
    }

    ResumeThread(pi.hThread);

    // 父进程监护：父进程（OpenDesk 主进程）先退出时终止子进程——Job 句柄随
    // 本进程退出关闭（KILL_ON_JOB_CLOSE）后整棵沙箱树被系统杀死。防止 OpenDesk
    // 退出/崩溃后留下继续运行的孤儿沙箱。父句柄拿不到时退化为"只等子进程"（旧行为）。
    HANDLE parent = nullptr;
    DWORD parentPid = getParentProcessId();
    if (parentPid != 0 && parentPid != GetCurrentProcessId()) {
        parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    }

    DWORD exitCode = 0;
    if (parent) {
        HANDLE waits[2] = { pi.hProcess, parent };
        DWORD wait = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
        if (wait == WAIT_OBJECT_0 + 1) {
            // 父先退出：终止子进程，Job 关闭后全树随之结束
            Log::warn(L"[RUN] 父进程（pid=%lu）先退出，终止沙箱树避免孤儿进程", parentPid);
            TerminateProcess(pi.hProcess, 1);
            WaitForSingleObject(pi.hProcess, 5000);
            GetExitCodeProcess(pi.hProcess, &exitCode);
        } else {
            GetExitCodeProcess(pi.hProcess, &exitCode);
        }
        CloseHandle(parent);
    } else {
        WaitForSingleObject(pi.hProcess, INFINITE);
        GetExitCodeProcess(pi.hProcess, &exitCode);
    }

    Log::info(L"[RUN] 子进程退出码: %lu", exitCode);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(job);
    return (int)exitCode;
}

} // namespace sbx