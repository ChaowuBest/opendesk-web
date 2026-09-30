/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <windows.h>
#include <string>

namespace sbx {

// 在目标进程中注入 hook DLL（CreateRemoteThread + LoadLibraryW 完整路径）。
// 仅支持同架构（64->64 / 32->32）；跨架构返回 FALSE（GetLastError=ERROR_NOT_SUPPORTED）。
// 调用方应保证目标进程处于挂起状态、且注入线程结束后再 resume，避免竞态。
// 注入成功返回 TRUE，并可选择等待注入线程结束（waitDone=true 默认）。
bool injectHookDll(HANDLE hProcess, const std::wstring& dllPath, bool waitDone = true);

} // namespace sbx