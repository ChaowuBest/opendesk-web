/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <string>

// 线程级 hook 抑制标志：置位后 hook 的 sandboxCheckPath 直接放行（不再判定）。
// 用于 ask 传输的内部工作线程（WinHTTP 内部会做文件/证书操作，若这些操作再
// 触发文件 hook 会递归 ask 形成风暴）。
// 定义在 hook_scope.cpp，sandbox.exe 与 sandbox_hook.dll 各自持有一份 TLS。
struct HookScope {
    static __declspec(thread) bool active;
};

// 进程级回收站流程保护：
//  - 递归/并发防护：SHFileOperation（送回收站）是 shell 级共享操作，同一进程
//    并发调用会互相等待直至死锁（hook 环境下实测）；且其内部（工作线程）删除
//    原文件若再进 recycleToTrash 会无限递归。
//  - 语义：回收流程进行中（进程级深度计数）时，其他线程/路径的删除不退化为
//    回收站（第二个并发 SHFileOperation 会死锁），而是真实执行删除原文件
//    （避免静默吞掉无关删除）。
struct RecycleGuard {
    // 尝试进入回收流程：返回 true 表示本调用是首个回收者（应真实执行
    // SHFileOperation）；false 表示已有回收流程在进行。
    static bool tryEnter();
    // 回收流程结束（首个回收者调用）。
    static void leave();
    // 是否有回收流程正在进行（其他删除应退化为直接删除，避免 shell 并发死锁）。
    static bool active();
};