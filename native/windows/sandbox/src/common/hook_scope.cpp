/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "hook_scope.h"

#include <windows.h>

__declspec(thread) bool HookScope::active = false;

// 进程级回收站重入保护（TLS 计数 + 进程级标志；SHFileOperation 的工作线程
// 无调用者 TLS 上下文，因此需要进程级标志而非仅 TLS）。
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
