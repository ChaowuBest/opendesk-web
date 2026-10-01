/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <string>
#include <vector>

namespace sbx {

struct AskConfig {
    std::wstring endpoint;         // http(s)://host[:port]/path 或 pipe://名字
    std::wstring token;            // Bearer token（HTTP 用）
    int timeoutMs = 2000;          // ask 超时/不可达 => deny（fail-closed）
    int cacheTtlSeconds = 60;      // ask 决策缓存（路径+访问类型），0 = 不缓存
    int grantTtlSeconds = 300;     // 端点下发子树授权的默认有效期（响应可覆盖，上限 1h）

    bool isPipe() const { return endpoint.rfind(L"pipe://", 0) == 0; }
    // "pipe://" 为 7 字符前缀，管道名取其后的子串。
    std::wstring pipeName() const { return endpoint.substr(7); }
};

struct Grant {
    std::wstring path;    // 虚拟路径（/ 开头）
    std::string access;   // read/write/execute/all（小写）
    int ttlSeconds = 300;
};

struct AskResult {
    bool allowed = false;
    std::vector<Grant> grants;
};

// ask 上游结果分类：熔断只针对"端点不可达/挂"（TransportError），
// HTTP 非 200 / 非法响应是端点"可达但拒绝"（HttpError），不触发熔断。
enum class AskOutcome { Ok, HttpError, TransportError };

// 向端点发起一次 ask。返回 true 表示得到合法响应（allowed 为最终决策）；
// 返回 false 表示超时/连接失败/响应不合法——调用方必须按 deny 处理且不缓存。
// outcome 输出失败类别：HttpError（拿到 HTTP 响应但非 200/坏响应）与
// TransportError（连接/传输层失败，应触发端点熔断）。
bool askUpstream(const AskConfig& cfg, const std::wstring& vpath, const std::string& kind,
                 AskResult& out, std::wstring& errMsg, AskOutcome& outcome);

// 解析端点下发的 grants 数组（协议 v2，容错：非法项忽略）。
std::vector<Grant> parseGrantsFromJson(const class JsonValue& root);

} // namespace sbx
