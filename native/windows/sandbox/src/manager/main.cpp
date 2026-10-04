/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

// sandbox —— 基于 Detours API 拦截的轻量级文件访问控制沙箱。
//
// 架构：sandbox.exe（管理进程）负责 CLI/策略校验/Job/注入启动；注入的
// sandbox_hook.dll 在子进程内 hook 文件系统 API，按同一份策略做
// allow/ask/deny 判定（判定发生在进程内，无内核往返）。

#include <windows.h>
#include <iostream>
#include <string>
#include <vector>

#include "../common/log.h"
#include "../common/policy.h"
#include "../common/utf.h"
#include "endpoint.h"
#include "runner.h"

using namespace sbx;

static const wchar_t* kUsage =
    L"用法:\n"
    L"  sandbox run  --policy <rules.toml> [--src DIR] [--automount] [--del-to-trash] [--upstream URL] [--token TOKEN] [--mount X] [--log-file FILE] [--env NAME=VALUE] -- <子进程命令行>\n"
    L"  sandbox mount --policy <rules.toml> [--src DIR] [--automount]        （Detours 实现无需挂载：仅校验策略）\n"
    L"  sandbox endpoint [--port 8080] [--pipe 管道名] [--default deny]\n"
    L"  sandbox debug-rules --policy <rules.toml> [--path P] [--access K]\n"
    L"  sandbox cleanup\n"
    L"\n"
    L"示例:\n"
    L"  sandbox run --automount --policy examples\\rules_drive.toml ^\n"
    L"      --upstream pipe://dynobox-decide -- cmd /c tests\\run_tests.bat\n";

struct CliOptions {
    std::wstring policy;
    std::wstring src;
    std::wstring upstream;
    std::wstring askToken;
    std::wstring mount;
    bool automount = false;
    bool delToTrash = false;
    std::wstring trashDir;       // --trash-dir（OpenDesk 统一回收站目录）
    std::vector<std::pair<std::wstring, std::wstring>> envExtra;
};

static void printUsage()
{
    fwprintf(stdout, L"%s", kUsage);
}

// Windows 命令行参数引用：含空白/引号时用双引号包裹并按 MSDN 规则转义反斜杠。
static std::wstring quoteWindowsArgument(const std::wstring& value)
{
    if (value.empty() || value.find_first_of(L" \t\"") == std::wstring::npos) return value;
    std::wstring out = L"\"";
    size_t i = 0;
    while (i < value.size()) {
        size_t bs = 0;
        while (i < value.size() && value[i] == L'\\') { bs++; i++; }
        if (i == value.size()) {
            out.append(bs * 2, L'\\');
            break;
        }
        if (value[i] == L'"') {
            out.append(bs * 2 + 1, L'\\');
            out.push_back(L'"');
        } else {
            out.append(bs, L'\\');
            out.push_back(value[i]);
        }
        i++;
    }
    out.push_back(L'"');
    return out;
}

static bool parseRunArgs(const std::vector<std::wstring>& args, CliOptions& opts)
{
    for (size_t i = 0; i < args.size(); i++) {
        const std::wstring& a = args[i];
        auto next = [&](std::wstring& out) -> bool {
            if (i + 1 >= args.size()) {
                Log::error(L"%ls 需要一个参数", a.c_str());
                return false;
            }
            out = args[++i];
            return true;
        };
        if (a == L"--automount") opts.automount = true;
        else if (a == L"--del-to-trash") opts.delToTrash = true;
        else if (a == L"--trash-dir") { if (!next(opts.trashDir)) return false; }
        else if (a == L"--policy") { if (!next(opts.policy)) return false; }
        else if (a == L"--src") { if (!next(opts.src)) return false; }
        else if (a == L"--upstream") { if (!next(opts.upstream)) return false; }
        else if (a == L"--token") { if (!next(opts.askToken)) return false; }
        else if (a == L"--mount") { if (!next(opts.mount)) return false; }
        else if (a == L"--log-file") { std::wstring v; if (!next(v)) return false; Log::setFile(v); }
        else if (a == L"--env") {
            std::wstring kv;
            if (!next(kv)) return false;
            size_t eq = kv.find(L'=');
            if (eq == std::wstring::npos || eq == 0) {
                Log::error(L"--env 格式应为 NAME=VALUE: %ls", kv.c_str());
                return false;
            }
            // 允许空值（NAME= 表示设置/清空环境变量）
            opts.envExtra.emplace_back(kv.substr(0, eq), kv.substr(eq + 1));
        } else if (a == L"--map") {
            // 兼容参数：Detours 实现子进程直接使用宿主路径，启动期翻译不再需要
            std::wstring kv;
            if (!next(kv)) return false;
            size_t eq = kv.find(L'=');
            if (eq == std::wstring::npos || eq == 0) {
                Log::error(L"--map 格式应为 旧前缀=新前缀: %ls", kv.c_str());
                return false;
            }
            Log::warn(L"--map 在 Detours 实现下为空操作（子进程直接使用宿主路径）: %ls", kv.c_str());
        } else {
            Log::error(L"无法识别的参数: %ls", a.c_str());
            return false;
        }
    }
    if (opts.policy.empty()) {
        Log::error(L"--policy 为必填");
        return false;
    }
    return true;
}

static int runDebugRules(const std::vector<std::wstring>& args)
{
    std::wstring policyFile;
    std::wstring path = L"/C/Windows/win.ini";
    std::wstring access = L"read";
    for (size_t i = 0; i < args.size(); i++) {
        if (args[i] == L"--policy" && i + 1 < args.size()) policyFile = args[++i];
        else if (args[i] == L"--path" && i + 1 < args.size()) path = args[++i];
        else if (args[i] == L"--access" && i + 1 < args.size()) access = args[++i];
    }
    if (policyFile.empty()) {
        Log::error(L"--policy 为必填");
        return 2;
    }
    Policy p = Policy::loadFromFile(policyFile);
    fwprintf(stdout, L"default=%hs\n", p.def().c_str());
    for (const auto& r : p.rules()) {
        fwprintf(stdout, L"  rule path=%ls access=%hs perm=%hs\n", r.path.c_str(), r.access.c_str(),
                 r.perm == Perm::Allow ? "allow" : (r.perm == Perm::Ask ? "ask" : "deny"));
    }
    std::string acc = narrowAscii(access);
    std::string why;
    bool ok = p.check(normalizeVirtualPath(path), acc, &why);
    fwprintf(stdout, L"check -> %hs (%hs)\n", ok ? "allow" : "deny", why.c_str());
    return 0;
}

int wmain(int argc, wchar_t** argv)
{
    // `--` 之后是子进程命令行（wmain 的 argv 已按 Windows 规则切分）。
    // 重新 join：已含引号的元素（多 token 命令行，dynabox 等宿主传入）保持原样；
    // 仅在"含空格但完全无引号"的元素上补回引号，避免含空格路径（C:\Program
    // Files\...）被 CreateProcess 按空格切碎。对已含引号的元素整体包裹会把
    // 内部引号转义、破坏多 token 语义（曾致 chcp.com/Copy 命令行解析错乱）。
    std::vector<std::wstring> args(argv + 1, argv + argc);
    std::wstring childCommand;
    for (size_t i = 0; i < args.size(); i++) {
        if (args[i] == L"--") {
            for (size_t j = i + 1; j < args.size(); j++) {
                if (!childCommand.empty()) childCommand.push_back(L' ');
                const std::wstring& a = args[j];
                bool needsQuote = a.find(L'"') == std::wstring::npos &&
                                  a.find_first_of(L" \t") != std::wstring::npos;
                if (needsQuote) childCommand += quoteWindowsArgument(a);
                else childCommand += a;
            }
            args.resize(i);
            break;
        }
    }

    if (args.empty() || args[0] == L"-h" || args[0] == L"--help" || args[0] == L"help") {
        printUsage();
        return 0;
    }

    // 通用选项
    for (auto it = args.begin(); it != args.end();) {
        if (*it == L"-v" || *it == L"--verbose") {
            Log::setVerbose(true);
            it = args.erase(it);
        } else {
            ++it;
        }
    }

    std::wstring sub = args[0];
    std::vector<std::wstring> rest(args.begin() + 1, args.end());

    try {
        if (sub == L"run") {
            if (childCommand.empty()) {
                Log::error(L"run 子命令需要在 -- 之后提供子进程命令行");
                printUsage();
                return 2;
            }
            CliOptions opts;
            if (!parseRunArgs(rest, opts)) {
                printUsage();
                return 2;
            }
            if (opts.automount && !opts.src.empty()) {
                Log::error(L"--src 与 --automount 冲突");
                return 2;
            }
            if (!opts.src.empty()) {
                DWORD attrs = GetFileAttributesW(opts.src.c_str());
                if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
                    Log::error(L"--src 目录不存在: %ls", opts.src.c_str());
                    return 2;
                }
            }
            SandboxLaunchOptions launch;
            launch.commandLine = childCommand;
            launch.policyPath = opts.policy;
            launch.automount = opts.automount;
            launch.srcDir = opts.src;
            launch.delToTrash = opts.delToTrash;
            launch.trashDir = opts.trashDir;
            launch.upstream = opts.upstream;
            launch.askToken = opts.askToken;
            for (const auto& [k, v] : opts.envExtra) launch.envExtra[k] = v;
            return runSandbox(launch);
        }

        if (sub == L"mount") {
            // Detours 实现无虚拟卷：仅做策略校验（CLI 兼容）
            CliOptions opts;
            if (!parseRunArgs(rest, opts)) {
                printUsage();
                return 2;
            }
            Policy p = Policy::loadFromFile(opts.policy);
            fwprintf(stdout, L"策略校验通过：%zu 条规则, default=%hs（Detours 实现无需挂载，使用 run 运行子进程）\n",
                     p.rules().size(), p.def().c_str());
            return 0;
        }

        if (sub == L"endpoint") {
            int port = 8080;
            std::wstring def = L"deny";
            std::wstring pipe;
            for (size_t i = 0; i < rest.size(); i++) {
                if (rest[i] == L"--port" && i + 1 < rest.size()) port = _wtoi(rest[++i].c_str());
                else if (rest[i] == L"--pipe" && i + 1 < rest.size()) pipe = rest[++i];
                else if (rest[i] == L"--default" && i + 1 < rest.size()) def = rest[++i];
            }
            return pipe.empty() ? runEndpointHttp(port, def) : runEndpointPipe(pipe, def);
        }

        if (sub == L"debug-rules") return runDebugRules(rest);

        if (sub == L"cleanup") {
            // Detours 实现无挂载卷：仅清理遗留的 hook DLL 锁文件（如有）
            fwprintf(stdout, L"无需清理（Detours 实现无虚拟卷）\n");
            return 0;
        }

        Log::error(L"未知子命令: %ls", sub.c_str());
        printUsage();
        return 2;
    } catch (const std::exception& e) {
        Log::error(L"%hs", e.what());
        return 1;
    }
}