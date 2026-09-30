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

// 极简 TOML 子集：注释(#)、[table]、[[array-of-table]]、key = "string"/'string'/integer/boolean。
// 与 C# 版 MiniToml 语义一致，供策略文件解析使用。
class TomlValue;
using TomlTable = std::map<std::wstring, TomlValue>;
using TomlTableArray = std::vector<TomlTable>;

class TomlValue {
public:
    enum class Kind { Table, TableArray, String, Integer, Boolean };

    TomlValue() : m_kind(Kind::Table) {}
    static TomlValue makeTable() { return TomlValue(Kind::Table); }
    static TomlValue makeArray() { return TomlValue(Kind::TableArray); }

    Kind kind() const { return m_kind; }
    TomlTable& table() { return m_table; }
    const TomlTable& table() const { return m_table; }
    TomlTableArray& array() { return m_array; }
    const TomlTableArray& array() const { return m_array; }

    void setString(const std::wstring& s) { m_kind = Kind::String; m_string = s; }
    void setInteger(long long v) { m_kind = Kind::Integer; m_integer = v; }
    void setBoolean(bool b) { m_kind = Kind::Boolean; m_boolean = b; }

    std::wstring toString() const {
        if (m_kind == Kind::String) return m_string;
        if (m_kind == Kind::Integer) return std::to_wstring(m_integer);
        if (m_kind == Kind::Boolean) return m_boolean ? L"true" : L"false";
        return L"";
    }
    long long toInteger() const { return m_kind == Kind::Integer ? m_integer : 0; }

private:
    explicit TomlValue(Kind k) : m_kind(k) {}
    Kind m_kind;
    TomlTable m_table;
    TomlTableArray m_array;
    std::wstring m_string;
    long long m_integer = 0;
    bool m_boolean = false;
};

// 解析失败抛 std::runtime_error（带行号）。
TomlTable parseToml(const std::wstring& text);

} // namespace sbx
