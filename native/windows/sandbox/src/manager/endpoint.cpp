/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "endpoint.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../common/json.h"
#include "../common/log.h"

namespace sbx {

#pragma comment(lib, "ws2_32.lib")

static std::wstring g_default = L"deny";
static std::atomic<bool> g_quit{false};
static std::mutex g_logGate;
static std::vector<std::wstring> g_requestLog;

static std::string wideToUtf8(const std::wstring& w)
{
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s((size_t)n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

static std::wstring utf8ToWide(const char* bytes, size_t len)
{
    if (len == 0) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, bytes, (int)len, nullptr, 0);
    std::wstring w((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, bytes, (int)len, &w[0], n);
    return w;
}

// 演示规则（与 C# 版一致）：见 README §3.2 端点行为表
static void decide(const std::wstring& path, const std::wstring& access,
                   std::wstring& decision, JsonValue& grants)
{
    grants = JsonValue::array();
    auto G = [&](const wchar_t* p, const wchar_t* acc) {
        JsonValue g = JsonValue::object();
        g.obj()[L"path"] = JsonValue::string(p);
        g.obj()[L"access"] = JsonValue::string(acc);
        g.obj()[L"ttl"] = JsonValue::integer(120);
        grants.arr().push_back(g);
    };
    auto startsWith = [&](const wchar_t* prefix) {
        size_t n = wcslen(prefix);
        return path.size() >= n && _wcsnicmp(path.c_str(), prefix, n) == 0;
    };

    if (startsWith(L"/slow")) {
        Sleep(8000);   // 演示超时 -> fail-closed 拒绝
        decision = L"deny";
    } else if (startsWith(L"/notes")) {
        G(L"/notes/**", L"read");
        decision = L"allow";
    } else if (startsWith(L"/scratch")) {
        G(L"/scratch/**", L"all");
        decision = L"allow";
    } else if (startsWith(L"/staging") && access == L"write") {
        G(L"/staging/**", L"write");
        decision = L"allow";
    } else if (startsWith(L"/reject")) {
        decision = L"deny";
    } else if (startsWith(L"/guarded")) {
        decision = L"allow";   // 有意不下发授权：每次新路径重新问询
    } else if (startsWith(L"/tools/ask")) {
        decision = L"allow";
    } else {
        decision = g_default;
    }
}

static void record(const std::wstring& path, const std::wstring& access, const std::wstring& decision)
{
    std::lock_guard<std::mutex> lock(g_logGate);
    JsonValue e = JsonValue::object();
    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t ts[16];
    swprintf_s(ts, L"%02d:%02d:%02d", st.wHour, st.wMinute, st.wSecond);
    e.obj()[L"ts"] = JsonValue::string(ts);
    e.obj()[L"path"] = JsonValue::string(path);
    e.obj()[L"access"] = JsonValue::string(access);
    e.obj()[L"decision"] = JsonValue::string(decision);
    g_requestLog.push_back(e.serialize());
    Log::info(L"[decide] %-7ls %-32ls -> %ls", access.c_str(), path.c_str(), decision.c_str());
}

static std::wstring handleDecideJson(const std::wstring& body)
{
    std::wstring path = L"/";
    std::wstring access = L"read";
    try {
        JsonValue req = parseJson(body);
        if (req.isObject()) {
            std::wstring p = req.getString(L"path");
            std::wstring a = req.getString(L"access");
            if (!p.empty()) path = p;
            if (!a.empty()) access = a;
        }
    } catch (...) {
        // 坏 JSON 按 /+read 处理
    }
    std::wstring decision;
    JsonValue grants;
    decide(path, access, decision, grants);
    record(path, access, decision);
    JsonValue resp = JsonValue::object();
    resp.obj()[L"decision"] = JsonValue::string(decision);
    resp.obj()[L"grants"] = grants;
    return resp.serialize();
}

// -- HTTP 服务端 --------------------------------------------------------------

static std::string httpResponse(int code, const std::string& body)
{
    const char* reason = code == 200 ? "OK" : (code == 404 ? "Not Found" : "Bad Request");
    std::string head = "HTTP/1.1 " + std::to_string(code) + " " + reason + "\r\n"
                       "Content-Type: application/json; charset=utf-8\r\n"
                       "Content-Length: " + std::to_string(body.size()) + "\r\n"
                       "Connection: close\r\n\r\n";
    return head + body;
}

static void serveHttpClient(SOCKET s)
{
    // 读取请求（headers + body）
    std::string buf;
    char tmp[4096];
    size_t headerEnd = std::string::npos;
    size_t contentLength = 0;
    while (true) {
        int n = recv(s, tmp, sizeof(tmp), 0);
        if (n <= 0) break;
        buf.append(tmp, (size_t)n);
        if (headerEnd == std::string::npos) headerEnd = buf.find("\r\n\r\n");
        if (headerEnd != std::string::npos) {
            // 解析 Content-Length
            std::string headers = buf.substr(0, headerEnd);
            std::string lower;
            for (char c : headers) lower.push_back((char)tolower((unsigned char)c));
            size_t cl = lower.find("content-length:");
            if (cl != std::string::npos) {
                contentLength = (size_t)strtoul(headers.c_str() + cl + 15, nullptr, 10);
            }
            if (buf.size() >= headerEnd + 4 + contentLength) break;
        }
    }
    if (headerEnd == std::string::npos) {
        closesocket(s);
        return;
    }

    // 请求行
    size_t sp = buf.find(' ');
    std::string method = buf.substr(0, sp);
    size_t sp2 = buf.find(' ', sp + 1);
    std::string target = buf.substr(sp + 1, sp2 - sp - 1);
    size_t q = target.find('?');
    if (q != std::string::npos) target = target.substr(0, q);

    std::string body = buf.substr(headerEnd + 4);
    std::string response;
    if (target == "/health") {
        response = httpResponse(200, R"({"status":"ok"})");
    } else if (target == "/log") {
        std::lock_guard<std::mutex> lock(g_logGate);
        std::string arr = "[";
        for (size_t i = 0; i < g_requestLog.size(); i++) {
            if (i) arr += ",";
            arr += wideToUtf8(g_requestLog[i]);
        }
        arr += "]";
        response = httpResponse(200, arr);
    } else if (target == "/decide" && method == "POST") {
        std::wstring wbody = utf8ToWide(body.data(), body.size());
        std::wstring json = handleDecideJson(wbody);
        response = httpResponse(200, wideToUtf8(json));
    } else {
        response = httpResponse(404, R"({"error":"not found"})");
    }
    send(s, response.data(), (int)response.size(), 0);
    shutdown(s, SD_BOTH);
    closesocket(s);
}

int runEndpointHttp(int port, const std::wstring& defaultDecision)
{
    g_default = defaultDecision == L"allow" ? L"allow" : L"deny";

    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    BOOL reuse = TRUE;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));

    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   // 仅本机
    if (bind(listener, (sockaddr*)&addr, sizeof(addr)) != 0 || listen(listener, SOMAXCONN) != 0) {
        Log::error(L"决策端点监听失败（端口 %d）: %d", port, WSAGetLastError());
        closesocket(listener);
        WSACleanup();
        return 1;
    }
    Log::info(L"决策端点已启动: http://127.0.0.1:%d/decide  (兜底=%ls)", port, g_default.c_str());
    Log::info(L"查看请求日志: GET /log；Ctrl+C 退出");

    SetConsoleCtrlHandler([](DWORD type) -> BOOL {
        if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT) { g_quit = true; return TRUE; }
        return FALSE;
    }, TRUE);

    while (!g_quit) {
        sockaddr_in client;
        int clen = sizeof(client);
        SOCKET s = accept(listener, (sockaddr*)&client, &clen);
        if (s == INVALID_SOCKET) break;
        std::thread(serveHttpClient, s).detach();
    }
    Log::info(L"端点已退出");
    closesocket(listener);
    WSACleanup();
    return 0;
}

// -- 命名管道服务端（4 字节小端长度 + UTF-8 JSON 帧）--------------------------

static bool pipeReadExact(HANDLE h, BYTE* buf, DWORD n)
{
    DWORD have = 0;
    while (have < n) {
        DWORD k = 0;
        if (!ReadFile(h, buf + have, n - have, &k, nullptr)) return false;
        if (k == 0) return false;
        have += k;
    }
    return true;
}

static void servePipeClient(HANDLE h)
{
    while (true) {
        BYTE lenBuf[4];
        if (!pipeReadExact(h, lenBuf, 4)) break;
        DWORD n = (DWORD)(lenBuf[0] | (lenBuf[1] << 8) | (lenBuf[2] << 16) | ((DWORD)lenBuf[3] << 24));
        if (n > 4 * 1024 * 1024) break;
        std::vector<BYTE> body(n);
        if (n > 0 && !pipeReadExact(h, body.data(), n)) break;
        std::wstring wbody = utf8ToWide((const char*)body.data(), body.size());
        std::wstring json = handleDecideJson(wbody);
        std::string resp = wideToUtf8(json);
        DWORD len = (DWORD)resp.size();
        BYTE out[4] = { (BYTE)(len & 0xFF), (BYTE)((len >> 8) & 0xFF),
                        (BYTE)((len >> 16) & 0xFF), (BYTE)((len >> 24) & 0xFF) };
        DWORD written = 0;
        if (!WriteFile(h, out, 4, &written, nullptr)) break;
        if (!WriteFile(h, resp.data(), len, &written, nullptr)) break;
        FlushFileBuffers(h);
    }
    FlushFileBuffers(h);
    DisconnectNamedPipe(h);
    CloseHandle(h);
}

int runEndpointPipe(const std::wstring& pipeName, const std::wstring& defaultDecision)
{
    g_default = defaultDecision == L"allow" ? L"allow" : L"deny";
    std::wstring fullName = L"\\\\.\\pipe\\" + pipeName;
    Log::info(L"决策端点已启动（命名管道）: %ls  (兜底=%ls)", fullName.c_str(), g_default.c_str());

    SetConsoleCtrlHandler([](DWORD type) -> BOOL {
        if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT) { g_quit = true; return TRUE; }
        return FALSE;
    }, TRUE);

    while (!g_quit) {
        HANDLE h = CreateNamedPipeW(fullName.c_str(), PIPE_ACCESS_DUPLEX,
                                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                                    PIPE_UNLIMITED_INSTANCES, 64 * 1024, 64 * 1024, 0, nullptr);
        if (h == INVALID_HANDLE_VALUE) {
            Log::error(L"CreateNamedPipe 失败: %lu", GetLastError());
            break;
        }
        if (ConnectNamedPipe(h, nullptr) && !g_quit) {
            std::thread(servePipeClient, h).detach();
        } else {
            CloseHandle(h);
        }
    }
    Log::info(L"端点已退出");
    return 0;
}

} // namespace sbx