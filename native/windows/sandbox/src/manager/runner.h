/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <windows.h>
#include <string>
#include <map>

namespace sbx {

struct SandboxLaunchOptions {
    std::wstring commandLine;     // 完整子进程命令行
    std::wstring policyPath;      // TOML 策略文件
    bool automount = false;       // --automount（hook 内枚举盘符）
    std::wstring srcDir;          // --src（单根模式，与 automount 互斥）
    bool delToTrash = false;      // --del-to-trash（回收站）
    std::wstring trashDir;        // --trash-dir（OpenDesk 统一回收站目录）
    std::wstring upstream;        // --upstream 覆盖策略端点
    std::wstring askToken;        // --token 覆盖策略 token（兼容参数）
    std::map<std::wstring, std::wstring> envExtra;  // --env NAME=VALUE
};

// 定位 hook DLL（与 sandbox.exe 同目录）。archIs64 由目标进程 PE 决定。
std::wstring resolveHookDll(bool archIs64);

// 读取 PE Machine 字段：返回 true 表示 64 位。
bool peIs64Bit(const std::wstring& exePath);

// 运行沙箱子进程（挂载 Job + 注入 hook DLL + 等待退出）。返回子进程退出码。
int runSandbox(const SandboxLaunchOptions& opts);

} // namespace sbx