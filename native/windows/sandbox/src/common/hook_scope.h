/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

// 线程级 hook 抑制标志：置位后 hook 的 sandboxCheckPath 直接放行（不再判定）。
// 用于 ask 传输的内部工作线程（WinHTTP 内部会做文件/证书操作，若这些操作再
// 触发文件 hook 会递归 ask 形成风暴）。
// 定义在 hook_scope.cpp，sandbox.exe 与 sandbox_hook.dll 各自持有一份 TLS。
struct HookScope {
    static __declspec(thread) bool active;
};

// 进程级"回收站操作中"保护：SHFileOperation（送回收站）内部会在工作线程执行
// 删除原文件等操作，这些操作再次进入删除 hook（NtDeleteFile/NtSetInformationFile
// 等）时若又调 recycleToTrash 会无限递归直至栈溢出。进入回收站流程时置位，
// 回收站流程内的删除请求视为已处理（直接成功返回，不再重复调 SHFileOperation）。
struct RecycleGuard {
    // 尝试获取"回收站流程"许可；返回 false 表示本线程/进程已在回收站流程中。
    static bool tryEnter();
    static void leave();
    static bool active();
};
