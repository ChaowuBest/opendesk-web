/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "hook_scope.h"

#include <windows.h>

__declspec(thread) bool HookScope::active = false;

// 进程级回收站流程保护：深度计数。
// SHFileOperation 是 shell 级共享操作，同一进程并发调用会互相等待直至死锁
// （hook 环境下实测）；且其内部（工作线程）删除原文件再进 recycleToTrash 会
// 无限递归。语义：
//  - 首个回收者（depth 0 -> 1）真实执行 SHFileOperation；
//  - 流程进行中（active()）的其他删除请求退化为"直接删除原文件"（不进回收站），
//    既避免第二个并发 SHFileOperation 死锁，也避免静默吞掉无关删除；
//  - SHFileOperation 内部（工作线程）删除原文件也命中 active()，直接删除——
//    此时文件已被 shell 移入回收站，原位置删除是 no-op 或失败但无害。
static volatile LONG g_recycleDepth = 0;

bool RecycleGuard::tryEnter()
{
    return InterlockedIncrement(&g_recycleDepth) == 1;
}

void RecycleGuard::leave()
{
    InterlockedDecrement(&g_recycleDepth);
}

bool RecycleGuard::active()
{
    return InterlockedCompareExchange(&g_recycleDepth, 0, 0) != 0;
}