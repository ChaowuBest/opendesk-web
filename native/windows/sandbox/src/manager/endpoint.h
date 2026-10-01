/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <string>

namespace sbx {

// 内置参考决策端点（对齐 C# 版 DecisionEndpoint）：
//   HTTP: 127.0.0.1:<port>/decide（/health、/log 辅助路由）
//   管道: \\.\pipe\<name>（4 字节小端长度 + UTF-8 JSON 帧）
int runEndpointHttp(int port, const std::wstring& defaultDecision);
int runEndpointPipe(const std::wstring& pipeName, const std::wstring& defaultDecision);

} // namespace sbx