/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "ask.h"

// winsock2.h 必须先于 windows.h（避免 sockaddr 类型重定义）
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <algorithm>
#include <cwchar>
#include <stdexcept>

#include "json.h"
#include "hook_scope.h"
#include "log.h"

namespace sbx {

// -- UTF-8 <-> UTF-16（ask 协议线上格式为 UTF-8） ----------------------------

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

// -- HTTP 传输（WinHTTP 同步模式） --------------------------------------------

struct ParsedUrl {
    std::wstring host;
    unsigned short port = 0;
    std::wstring path;
    bool https = false;
};

static bool parseHttpUrl(const std::wstring& url, ParsedUrl& out)
{
    std::wstring u = url;
    bool https = false;
    if (u.rfind(L"https://", 0) == 0) { https = true; u = u.substr(8); }
    else if (u.rfind(L"http://", 0) == 0) { u = u.substr(7); }
    else return false;

    size_t slash = u.find(L'/');
    std::wstring hostPort = slash == std::wstring::npos ? u : u.substr(0, slash);
    std::wstring path = slash == std::wstring::npos ? L"/" : u.substr(slash);
    if (path.empty()) path = L"/";

    size_t colon = hostPort.rfind(L':');
    unsigned short port;
    std::wstring host;
    if (colon != std::wstring::npos && hostPort.find(L']') == std::wstring::npos) {
        host = hostPort.substr(0, colon);
        port = (unsigned short)_wtoi(hostPort.substr(colon + 1).c_str());
    } else {
        host = hostPort;
        port = https ? 443 : 80;
    }
    if (host.empty() || port == 0) return false;
    out.host = host;
    out.port = port;
    out.path = path;
    out.https = https;
    return true;
}

static std::wstring buildRequestJson(const std::wstring& vpath, const std::string& kind)
{
    JsonValue obj = JsonValue::object();
    obj.obj()[L"path"] = JsonValue::string(vpath);
    obj.obj()[L"access"] = JsonValue::string(std::wstring(kind.begin(), kind.end()));
    return obj.serialize();
}

// -- 命名管道传输：持久连接 + 4 字节小端长度前缀 + UTF-8 JSON 帧 ----------------

static bool pipeTransact(const std::wstring& pipeName, const std::wstring& request,
                         std::wstring& reply, int timeoutMs, std::wstring& err)
{
    std::wstring fullName = L"\\\\.\\pipe\\" + pipeName;
    // 注意：以同步句柄打开（不带 FILE_FLAG_OVERLAPPED）。实测 OVERLAPPED 句柄
    // 连接部分命名管道服务器（node:net / 内置端点）会返回 ERROR_FILE_NOT_FOUND，
    // 而同步句柄（.NET/cmd 客户端）可正常连接。超时通过 PeekNamedPipe 轮询实现。
    HANDLE h = CreateFileW(fullName.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                           OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        // 服务器尚未创建/实例忙：等待重试（经典客户端模式）
        DWORD e = GetLastError();
        if (e == ERROR_PIPE_BUSY && WaitNamedPipeW(fullName.c_str(), timeoutMs)) {
            h = CreateFileW(fullName.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                            OPEN_EXISTING, 0, nullptr);
        }
        if (h == INVALID_HANDLE_VALUE) {
            err = L"CreateFile(pipe) 失败: " + std::to_wstring(GetLastError());
            return false;
        }
    }

    std::string requestUtf8 = wideToUtf8(request);
    std::vector<BYTE> frame(4 + requestUtf8.size());
    DWORD len = (DWORD)requestUtf8.size();
    frame[0] = (BYTE)(len & 0xFF);
    frame[1] = (BYTE)((len >> 8) & 0xFF);
    frame[2] = (BYTE)((len >> 16) & 0xFF);
    frame[3] = (BYTE)((len >> 24) & 0xFF);
    memcpy(&frame[4], requestUtf8.data(), len);

    bool ok = false;
    do {
        // 同步写（管道句柄为同步；写阻塞等待服务器读取）
        DWORD written = 0;
        if (!WriteFile(h, frame.data(), (DWORD)frame.size(), &written, nullptr)) {
            err = L"管道写失败: " + std::to_wstring(GetLastError());
            break;
        }
        FlushFileBuffers(h);

        // 同步读：PeekNamedPipe 轮询（有数据才 ReadFile），绝对超时
        long long deadline = (long long)GetTickCount64() + timeoutMs;
        auto pipeRead = [&](BYTE* dst, DWORD want) -> bool {
            DWORD have = 0;
            while (have < want) {
                if ((long long)GetTickCount64() > deadline) return false;
                DWORD available = 0;
                if (!PeekNamedPipe(h, nullptr, 0, nullptr, &available, nullptr)) return false;
                if (available == 0) {
                    Sleep(10);
                    continue;
                }
                DWORD chunk = 0;
                if (!ReadFile(h, dst + have, want - have, &chunk, nullptr)) return false;
                if (chunk == 0) return false;
                have += chunk;
            }
            return true;
        };

        BYTE lenBuf[4];
        if (!pipeRead(lenBuf, 4)) {
            err = L"管道读(长度)失败或超时";
            break;
        }
        DWORD n = (DWORD)(lenBuf[0] | (lenBuf[1] << 8) | (lenBuf[2] << 16) | ((DWORD)lenBuf[3] << 24));
        if (n > 4 * 1024 * 1024) { err = L"非法帧长度"; break; }
        std::vector<BYTE> body(n);
        if (n > 0 && !pipeRead(body.data(), n)) {
            err = L"管道读(正文)失败或超时";
            break;
        }
        reply = utf8ToWide((const char*)body.data(), body.size());
        ok = true;
    } while (false);

    CloseHandle(h);
    return ok;
}

// -- 统一入口 ----------------------------------------------------------------

// Winsock HTTP/1.1 客户端：纯网络传输（不触碰文件系统 API，因此不会触发
// 文件 hook 形成递归 ask），以绝对时限 fail-closed。仅支持 http（本地决策
// 端点场景；https 明确报错）。同步阻塞调用线程，与 Dokan 的 I/O 等待语义一致。
static bool httpAskImpl(const AskConfig& cfg, const std::wstring& vpath, const std::string& kind,
                        std::wstring& reply, std::wstring& err, AskOutcome& outcome)
{
    ParsedUrl u;
    if (!parseHttpUrl(cfg.endpoint, u)) {
        err = L"无法解析端点 URL: " + cfg.endpoint;
        outcome = AskOutcome::HttpError;
        return false;
    }
    if (u.https) {
        err = L"Winsock 传输不支持 https（本地决策端点请使用 http）";
        outcome = AskOutcome::HttpError;
        return false;
    }

    long long deadline = (long long)GetTickCount64() + cfg.timeoutMs;
    auto remainingTv = [&](timeval& tv) -> bool {
        long long left = deadline - (long long)GetTickCount64();
        if (left <= 0) return false;
        tv.tv_sec = (long)(left / 1000);
        tv.tv_usec = (long)((left % 1000) * 1000);
        return true;
    };

    static WSADATA s_wsa = [] { WSAStartup(MAKEWORD(2, 2), &s_wsa); return s_wsa; }();

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) {
        err = L"socket 失败: " + std::to_wstring(WSAGetLastError());
        outcome = AskOutcome::TransportError;
        return false;
    }
    u_long mode = 1;
    ioctlsocket(s, FIONBIO, &mode);

    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(u.port);
    std::string hostNarrow = wideToUtf8(u.host);
    if (inet_pton(AF_INET, hostNarrow.c_str(), &addr.sin_addr) != 1) {
        if (u.host == L"localhost") {
            addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        } else {
            struct hostent* he = gethostbyname(hostNarrow.c_str());
            if (!he) {
                err = L"无法解析端点主机: " + u.host;
                closesocket(s);
                outcome = AskOutcome::TransportError;
                return false;
            }
            memcpy(&addr.sin_addr, he->h_addr, he->h_length);
        }
    }

    if (connect(s, (sockaddr*)&addr, sizeof(addr)) != 0 && WSAGetLastError() != WSAEWOULDBLOCK) {
        err = L"连接失败: " + std::to_wstring(WSAGetLastError());
        closesocket(s);
        outcome = AskOutcome::TransportError;
        return false;
    }
    fd_set wf;
    FD_ZERO(&wf);
    FD_SET(s, &wf);
    timeval tv;
    if (!remainingTv(tv)) {
        err = L"上游连接超时";
        closesocket(s);
        outcome = AskOutcome::TransportError;
        return false;
    }
    if (select(0, nullptr, &wf, nullptr, &tv) <= 0) {
        err = L"上游连接超时";
        closesocket(s);
        outcome = AskOutcome::TransportError;
        return false;
    }
    int soErr = 0;
    int soLen = sizeof(soErr);
    getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&soErr, &soLen);
    if (soErr != 0) {
        err = L"连接失败: " + std::to_wstring(soErr);
        closesocket(s);
        outcome = AskOutcome::TransportError;
        return false;
    }

    // 构造请求（固定 Content-Length；Connection: close 简化响应读取）
    std::string bodyUtf8 = wideToUtf8(buildRequestJson(vpath, kind));
    std::string req = "POST ";
    req += wideToUtf8(u.path);
    req += " HTTP/1.1\r\n";
    req += "Host: " + hostNarrow + ":" + std::to_string(u.port) + "\r\n";
    req += "Content-Type: application/json\r\n";
    if (!cfg.token.empty()) {
        req += "Authorization: Bearer " + wideToUtf8(cfg.token) + "\r\n";
    }
    req += "Content-Length: " + std::to_string(bodyUtf8.size()) + "\r\n";
    req += "Connection: close\r\n\r\n";
    req += bodyUtf8;

    size_t off = 0;
    while (off < req.size()) {
        fd_set wf2;
        FD_ZERO(&wf2);
        FD_SET(s, &wf2);
        if (!remainingTv(tv)) {
            err = L"上游发送超时";
            closesocket(s);
            outcome = AskOutcome::TransportError;
            return false;
        }
        if (select(0, nullptr, &wf2, nullptr, &tv) <= 0) {
            err = L"上游发送超时";
            closesocket(s);
            outcome = AskOutcome::TransportError;
            return false;
        }
        int n = send(s, req.data() + off, (int)(req.size() - off), 0);
        if (n == SOCKET_ERROR) {
            int e = WSAGetLastError();
            if (e == WSAEWOULDBLOCK) continue;
            err = L"send 失败: " + std::to_wstring(e);
            closesocket(s);
            outcome = AskOutcome::TransportError;
            return false;
        }
        if (n == 0) {
            err = L"连接被对端关闭";
            closesocket(s);
            outcome = AskOutcome::TransportError;
            return false;
        }
        off += (size_t)n;
    }

    // 接收全部响应（Connection: close -> EOF）
    std::string resp;
    char tmp[8192];
    while (true) {
        fd_set rf;
        FD_ZERO(&rf);
        FD_SET(s, &rf);
        if (!remainingTv(tv)) {
            err = L"上游响应超时（" + std::to_wstring(cfg.timeoutMs) + L"ms）";
            closesocket(s);
            outcome = AskOutcome::TransportError;
            return false;
        }
        if (select(0, &rf, nullptr, nullptr, &tv) <= 0) {
            err = L"上游响应超时（" + std::to_wstring(cfg.timeoutMs) + L"ms）";
            closesocket(s);
            outcome = AskOutcome::TransportError;
            return false;
        }
        int n = recv(s, tmp, sizeof(tmp), 0);
        if (n > 0) {
            resp.append(tmp, (size_t)n);
        } else if (n == 0) {
            break;
        } else {
            int e = WSAGetLastError();
            if (e == WSAEWOULDBLOCK) continue;
            err = L"recv 失败: " + std::to_wstring(e);
            closesocket(s);
            outcome = AskOutcome::TransportError;
            return false;
        }
    }
    closesocket(s);

    size_t hEnd = resp.find("\r\n\r\n");
    if (hEnd == std::string::npos) {
        err = L"响应缺少 HTTP 头";
        outcome = AskOutcome::HttpError;
        return false;
    }
    std::string head = resp.substr(0, hEnd);
    if (head.rfind("HTTP/1.", 0) != 0) {
        err = L"非法 HTTP 状态行";
        outcome = AskOutcome::HttpError;
        return false;
    }
    // 解析状态行中的状态码（"HTTP/1.1 200 OK"）：跳过 "HTTP/1.x " 前缀后取数字
    const char* sp = head.c_str();
    while (*sp && *sp != L' ') sp++;
    while (*sp == L' ') sp++;
    int status = atoi(sp);
    if (status == 0) {
        err = L"非法 HTTP 状态码";
        outcome = AskOutcome::HttpError;
        return false;
    }
    if (status != 200) {
        err = L"端点返回 HTTP " + std::to_wstring(status);
        outcome = AskOutcome::HttpError;
        return false;
    }
    outcome = AskOutcome::Ok;
    std::string body = resp.substr(hEnd + 4);
    reply = utf8ToWide(body.data(), body.size());
    return true;
}

bool askUpstream(const AskConfig& cfg, const std::wstring& vpath, const std::string& kind,
                 AskResult& out, std::wstring& errMsg, AskOutcome& outcome)
{
    if (cfg.endpoint.empty()) {
        errMsg = L"未配置上游端点";
        outcome = AskOutcome::HttpError;
        return false;
    }
    std::wstring reply;

    if (cfg.isPipe()) {
        std::wstring request = buildRequestJson(vpath, kind);
        // 管道传输无 HTTP 状态概念：连接/读写/超时失败一律视为传输级失败（熔断）
        if (!pipeTransact(cfg.pipeName(), request, reply, cfg.timeoutMs, errMsg)) {
            outcome = AskOutcome::TransportError;
            return false;
        }
        outcome = AskOutcome::Ok;
    } else {
        if (!httpAskImpl(cfg, vpath, kind, reply, errMsg, outcome)) return false;
    }

    // 解析响应：decision 必须合法，否则按不合法响应处理（不缓存）
    JsonValue root;
    try {
        root = parseJson(reply);
    } catch (...) {
        errMsg = L"响应不是合法 JSON";
        return false;
    }
    std::wstring decision = root.getString(L"decision");
    if (decision != L"allow" && decision != L"deny") {
        errMsg = L"响应不含合法 decision";
        return false;
    }
    out.allowed = decision == L"allow";
    out.grants = parseGrantsFromJson(root);
    return true;
}

std::vector<Grant> parseGrantsFromJson(const JsonValue& root)
{
    std::vector<Grant> grants;
    if (!root.isObject()) return grants;
    auto it = root.obj().find(L"grants");
    if (it == root.obj().end() || !it->second.isArray()) return grants;
    for (const auto& g : it->second.arr()) {
        try {
            std::wstring path = g.getString(L"path");
            std::wstring access = g.getString(L"access");
            long long ttl = 300;
            auto tit = g.obj().find(L"ttl");
            if (tit != g.obj().end() && tit->second.isInt()) ttl = tit->second.intValue();
            ttl = std::max(0LL, std::min(3600LL, ttl));
            std::string acc(access.begin(), access.end());
            for (auto& c : acc) c = (char)tolower((unsigned char)c);
            if (path.empty()) continue;
            if (acc != "read" && acc != "write" && acc != "execute" && acc != "all") continue;
            grants.push_back({ path, acc, (int)ttl });
        } catch (...) {
            // 非法项忽略
        }
    }
    return grants;
}

} // namespace sbx
