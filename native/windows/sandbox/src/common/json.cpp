/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "json.h"

#include <stdexcept>
#include <cwchar>

namespace sbx {

static void skipWs(const wchar_t*& p)
{
    while (*p == L' ' || *p == L'\t' || *p == L'\r' || *p == L'\n') p++;
}

static std::wstring parseStringBody(const wchar_t*& p)
{
    // 假定 *p == '"'；消费到闭合引号，处理 \" \\ \/ \b \f \n \r \t \uXXXX
    p++;
    std::wstring out;
    while (*p && *p != L'"') {
        wchar_t c = *p;
        if (c == L'\\') {
            p++;
            wchar_t e = *p;
            switch (e) {
                case L'"': out.push_back(L'"'); break;
                case L'\\': out.push_back(L'\\'); break;
                case L'/': out.push_back(L'/'); break;
                case L'b': out.push_back(L'\b'); break;
                case L'f': out.push_back(L'\f'); break;
                case L'n': out.push_back(L'\n'); break;
                case L'r': out.push_back(L'\r'); break;
                case L't': out.push_back(L'\t'); break;
                case L'u': {
                    p++;
                    unsigned code = 0;
                    for (int i = 0; i < 4; i++) {
                        wchar_t h = *p;
                        code <<= 4;
                        if (h >= L'0' && h <= L'9') code |= (unsigned)(h - L'0');
                        else if (h >= L'a' && h <= L'f') code |= (unsigned)(h - L'a' + 10);
                        else if (h >= L'A' && h <= L'F') code |= (unsigned)(h - L'A' + 10);
                        else throw std::runtime_error("JSON 非法 \\u 转义");
                        p++;
                    }
                    if (code >= 0xD800 && code <= 0xDBFF && p[0] == L'\\' && p[1] == L'u') {
                        // 代理对（简化：只处理 BMP 代理对）
                        p += 2;
                        unsigned lo = 0;
                        for (int i = 0; i < 4; i++) {
                            wchar_t h = *p;
                            lo <<= 4;
                            if (h >= L'0' && h <= L'9') lo |= (unsigned)(h - L'0');
                            else if (h >= L'a' && h <= L'f') lo |= (unsigned)(h - L'a' + 10);
                            else if (h >= L'A' && h <= L'F') lo |= (unsigned)(h - L'A' + 10);
                            else throw std::runtime_error("JSON 非法 \\u 转义");
                            p++;
                        }
                        unsigned cp = 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00);
                        out.push_back((wchar_t)(0xD800 + ((cp - 0x10000) >> 10)));
                        out.push_back((wchar_t)(0xDC00 + ((cp - 0x10000) & 0x3FF)));
                    } else {
                        out.push_back((wchar_t)code);
                    }
                    break;
                }
                default: throw std::runtime_error("JSON 非法转义");
            }
            p++;
        } else {
            out.push_back(c);
            p++;
        }
    }
    if (*p != L'"') throw std::runtime_error("JSON 字符串未闭合");
    p++;
    return out;
}

static JsonValue parseValueRec(const wchar_t*& p);

static JsonValue parseValueRec(const wchar_t*& p)
{
    skipWs(p);
    wchar_t c = *p;
    if (c == L'"') {
        return JsonValue::string(parseStringBody(p));
    }
    if (c == L'{') {
        p++;
        JsonValue obj = JsonValue::object();
        skipWs(p);
        if (*p == L'}') { p++; return obj; }
        while (true) {
            skipWs(p);
            if (*p != L'"') throw std::runtime_error("JSON 对象键必须为字符串");
            std::wstring key = parseStringBody(p);
            skipWs(p);
            if (*p != L':') throw std::runtime_error("JSON 对象缺冒号");
            p++;
            obj.obj()[key] = parseValueRec(p);
            skipWs(p);
            if (*p == L',') { p++; continue; }
            if (*p == L'}') { p++; return obj; }
            throw std::runtime_error("JSON 对象格式错误");
        }
    }
    if (c == L'[') {
        p++;
        JsonValue arr = JsonValue::array();
        skipWs(p);
        if (*p == L']') { p++; return arr; }
        while (true) {
            arr.arr().push_back(parseValueRec(p));
            skipWs(p);
            if (*p == L',') { p++; continue; }
            if (*p == L']') { p++; return arr; }
            throw std::runtime_error("JSON 数组格式错误");
        }
    }
    if (c == L't') { p += 4; return JsonValue::boolean(true); }
    if (c == L'f') { p += 5; return JsonValue::boolean(false); }
    if (c == L'n') { p += 4; return JsonValue(); }
    if (c == L'-' || (c >= L'0' && c <= L'9')) {
        const wchar_t* start = p;
        if (*p == L'-') p++;
        while (*p >= L'0' && *p <= L'9') p++;
        if (*p == L'.') {
            // 忽略小数（协议无小数；直接跳到数字尾）
            p++;
            while (*p >= L'0' && *p <= L'9') p++;
        }
        std::wstring num(start, p);
        wchar_t* end = nullptr;
        long long v = wcstoll(num.c_str(), &end, 10);
        return JsonValue::integer(v);
    }
    throw std::runtime_error("JSON 无法解析的字符");
}

JsonValue parseJson(const std::wstring& text)
{
    const wchar_t* p = text.c_str();
    JsonValue v = parseValueRec(p);
    return v;
}

std::wstring JsonValue::getString(const std::wstring& key) const
{
    if (m_kind != Kind::Object) return L"";
    auto it = m_obj.find(key);
    if (it == m_obj.end()) return L"";
    return it->second.isString() ? it->second.str() : it->second.serialize();
}

static void serializeString(std::wstring& out, const std::wstring& s)
{
    out.push_back(L'"');
    for (wchar_t c : s) {
        switch (c) {
            case L'"': out += L"\\\""; break;
            case L'\\': out += L"\\\\"; break;
            case L'\n': out += L"\\n"; break;
            case L'\r': out += L"\\r"; break;
            case L'\t': out += L"\\t"; break;
            default: out.push_back(c);
        }
    }
    out.push_back(L'"');
}

std::wstring JsonValue::serialize() const
{
    std::wstring out;
    switch (m_kind) {
        case Kind::Null: out = L""; break;
        case Kind::Bool: out = m_bool ? L"true" : L"false"; break;
        case Kind::Int: out = std::to_wstring(m_int); break;
        case Kind::String: serializeString(out, m_str); break;
        case Kind::Array: {
            out.push_back(L'[');
            for (size_t i = 0; i < m_arr.size(); i++) {
                if (i) out.push_back(L',');
                out += m_arr[i].serialize();
            }
            out.push_back(L']');
            break;
        }
        case Kind::Object: {
            out.push_back(L'{');
            size_t i = 0;
            for (const auto& [k, v] : m_obj) {
                if (i++) out.push_back(L',');
                serializeString(out, k);
                out.push_back(L':');
                out += v.serialize();
            }
            out.push_back(L'}');
            break;
        }
    }
    return out;
}

} // namespace sbx
