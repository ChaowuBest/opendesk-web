/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <string>
#include <vector>
#include <map>
#include <memory>

namespace sbx {

// 极简 JSON：仅覆盖 ask 协议所需构造（对象/数组/字符串/整数/布尔/null）。
// 解析失败抛 std::runtime_error。
class JsonValue {
public:
    enum class Kind { Null, Bool, Int, String, Array, Object };

    JsonValue() : m_kind(Kind::Null) {}
    static JsonValue null() { return JsonValue(); }
    static JsonValue boolean(bool b) { JsonValue v; v.m_kind = Kind::Bool; v.m_bool = b; return v; }
    static JsonValue integer(long long n) { JsonValue v; v.m_kind = Kind::Int; v.m_int = n; return v; }
    static JsonValue string(const std::wstring& s) { JsonValue v; v.m_kind = Kind::String; v.m_str = s; return v; }
    static JsonValue array() { JsonValue v; v.m_kind = Kind::Array; return v; }
    static JsonValue object() { JsonValue v; v.m_kind = Kind::Object; return v; }

    Kind kind() const { return m_kind; }
    bool isObject() const { return m_kind == Kind::Object; }
    bool isArray() const { return m_kind == Kind::Array; }
    bool isString() const { return m_kind == Kind::String; }
    bool isInt() const { return m_kind == Kind::Int; }

    std::wstring& str() { return m_str; }
    const std::wstring& str() const { return m_str; }
    long long intValue() const { return m_int; }
    bool boolValue() const { return m_bool; }
    std::vector<JsonValue>& arr() { return m_arr; }
    const std::vector<JsonValue>& arr() const { return m_arr; }
    std::map<std::wstring, JsonValue>& obj() { return m_obj; }
    const std::map<std::wstring, JsonValue>& obj() const { return m_obj; }

    // 对象字段读取（不存在或类型不符返回空串/0）
    std::wstring getString(const std::wstring& key) const;
    bool has(const std::wstring& key) const { return m_kind == Kind::Object && m_obj.count(key) > 0; }

    std::wstring serialize() const;

private:
    Kind m_kind;
    bool m_bool = false;
    long long m_int = 0;
    std::wstring m_str;
    std::vector<JsonValue> m_arr;
    std::map<std::wstring, JsonValue> m_obj;
};

// 解析 UTF-8/宽字符 JSON 文本。
JsonValue parseJson(const std::wstring& text);

} // namespace sbx
