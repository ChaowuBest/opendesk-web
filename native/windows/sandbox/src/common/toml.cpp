/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "toml.h"

#include <stdexcept>

namespace sbx {

static std::wstring stripComment(const std::wstring& line)
{
    bool inStr = false;
    for (size_t i = 0; i < line.size(); i++) {
        wchar_t c = line[i];
        if (c == L'"') inStr = !inStr;
        else if (c == L'#' && !inStr) return line.substr(0, i);
    }
    return line;
}

static int findEquals(const std::wstring& line)
{
    bool inStr = false;
    for (size_t i = 0; i < line.size(); i++) {
        wchar_t c = line[i];
        if (c == L'"') inStr = !inStr;
        else if (c == L'=' && !inStr) return (int)i;
    }
    return -1;
}

static std::wstring trim(const std::wstring& s)
{
    size_t b = 0, e = s.size();
    while (b < e && (s[b] == L' ' || s[b] == L'\t')) b++;
    while (e > b && (s[e - 1] == L' ' || s[e - 1] == L'\t')) e--;
    return s.substr(b, e - b);
}

static std::vector<std::wstring> splitDotted(const std::wstring& name)
{
    std::vector<std::wstring> parts;
    size_t start = 0;
    while (start <= name.size()) {
        size_t dot = name.find(L'.', start);
        std::wstring part = trim(dot == std::wstring::npos ? name.substr(start) : name.substr(start, dot - start));
        if (!part.empty()) parts.push_back(part);
        if (dot == std::wstring::npos) break;
        start = dot + 1;
    }
    return parts;
}

static TomlValue parseValue(const std::wstring& v, int lineNo)
{
    if (v.size() >= 2 && v.front() == L'"' && v.back() == L'"')
    {
        TomlValue t;
        t.setString(v.substr(1, v.size() - 2));
        return t;
    }
    if (v.size() >= 2 && v.front() == L'\'' && v.back() == L'\'')
    {
        TomlValue t;
        t.setString(v.substr(1, v.size() - 2));
        return t;
    }
    if (v == L"true") { TomlValue t; t.setBoolean(true); return t; }
    if (v == L"false") { TomlValue t; t.setBoolean(false); return t; }
    wchar_t* end = nullptr;
    long long n = wcstoll(v.c_str(), &end, 10);
    if (end && *end == L'\0' && end != v.c_str()) {
        TomlValue t;
        t.setInteger(n);
        return t;
    }
    throw std::runtime_error("第 " + std::to_string(lineNo) + " 行不支持的值: " +
                             std::string(v.begin(), v.end()));
}

static TomlTable& enterTable(TomlTable& root, const std::wstring& name, int lineNo)
{
    auto parts = splitDotted(name);
    TomlTable* node = &root;
    for (const auto& part : parts) {
        auto it = node->find(part);
        if (it != node->end()) {
            if (it->second.kind() != TomlValue::Kind::Table)
                throw std::runtime_error("第 " + std::to_string(lineNo) + " 行: [ " +
                                         std::string(name.begin(), name.end()) + " ] 与已有键冲突");
            node = &it->second.table();
        } else {
            auto [ins, ok] = node->emplace(part, TomlValue::makeTable());
            node = &ins->second.table();
            (void)ok;
        }
    }
    return *node;
}

static TomlTable& enterArrayTable(TomlTable& root, const std::wstring& name, int lineNo)
{
    auto parts = splitDotted(name);
    TomlTable* node = &root;
    for (size_t i = 0; i + 1 < parts.size(); i++) {
        auto it = node->find(parts[i]);
        if (it == node->end() || it->second.kind() != TomlValue::Kind::Table)
            throw std::runtime_error("第 " + std::to_string(lineNo) + " 行: 未定义的表");
        node = &it->second.table();
    }
    const std::wstring& last = parts.back();
    auto it = node->find(last);
    if (it == node->end()) {
        auto [ins, ok] = node->emplace(last, TomlValue::makeArray());
        it = ins;
        (void)ok;
    }
    if (it->second.kind() != TomlValue::Kind::TableArray)
        throw std::runtime_error("第 " + std::to_string(lineNo) + " 行: 不是表数组");
    it->second.array().emplace_back();
    return it->second.array().back();
}

TomlTable parseToml(const std::wstring& text)
{
    TomlTable root;
    TomlTable* current = &root;
    int lineNo = 0;

    size_t start = 0;
    while (start <= text.size()) {
        size_t nl = text.find(L'\n', start);
        std::wstring raw = nl == std::wstring::npos ? text.substr(start) : text.substr(start, nl - start);
        start = nl == std::wstring::npos ? text.size() + 1 : nl + 1;
        lineNo++;

        // 统一 \r\n
        if (!raw.empty() && raw.back() == L'\r') raw.pop_back();
        std::wstring line = trim(stripComment(raw));
        if (line.empty()) continue;

        if (line.size() >= 4 && line.rfind(L"[[", 0) == 0 && line.back() == L']' && line[line.size() - 2] == L']') {
            std::wstring name = trim(line.substr(2, line.size() - 4));
            current = &enterArrayTable(root, name, lineNo);
        } else if (line.size() >= 2 && line.front() == L'[' && line.back() == L']') {
            std::wstring name = trim(line.substr(1, line.size() - 2));
            current = &enterTable(root, name, lineNo);
        } else {
            int eq = findEquals(line);
            if (eq <= 0)
                throw std::runtime_error("第 " + std::to_string(lineNo) + " 行无法解析");
            std::wstring key = trim(line.substr(0, (size_t)eq));
            if (key.size() >= 2 && (key.front() == L'"' || key.front() == L'\'') && key.back() == key.front())
                key = key.substr(1, key.size() - 2);
            (*current)[key] = parseValue(trim(line.substr((size_t)eq + 1)), lineNo);
        }
    }
    return root;
}

} // namespace sbx
