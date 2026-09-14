/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

namespace Dynobox;

/// <summary>
/// 极简 TOML 子集解析器：只支持本工具规则文件用到的构造 ——
/// 注释(#)、[table]、[[array-of-table]]、key = "string" / integer / boolean。
/// 解析结果：TomlTable（字典），嵌套为 TomlTable / TomlTableArray（List of TomlTable）。
/// </summary>
public static class MiniToml
{
    public sealed class TomlTable : Dictionary<string, object>
    {
    }

    public sealed class TomlTableArray : List<TomlTable>
    {
    }

    public static TomlTable Parse(string text)
    {
        var root = new TomlTable();
        var current = root;
        var lineNo = 0;
        foreach (var rawLine in text.Replace("\r\n", "\n").Split('\n'))
        {
            lineNo++;
            var line = StripComment(rawLine).Trim();
            if (line.Length == 0) continue;

            if (line.StartsWith("[[") && line.EndsWith("]]"))
            {
                var name = line[2..^2].Trim();
                current = EnterArrayTable(root, name, lineNo);
            }
            else if (line.StartsWith('[') && line.EndsWith(']'))
            {
                var name = line[1..^1].Trim();
                current = EnterTable(root, name, lineNo);
            }
            else
            {
                var eq = FindEquals(line);
                if (eq <= 0)
                    throw new FormatException($"第 {lineNo} 行无法解析: {rawLine.Trim()}");
                var key = line[..eq].Trim().Trim('"').Trim('\'');
                var value = ParseValue(line[(eq + 1)..].Trim(), lineNo);
                current[key] = value;
            }
        }
        return root;
    }

    private static string StripComment(string line)
    {
        var inStr = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (c == '"') inStr = !inStr;
            else if (c == '#' && !inStr) return line[..i];
        }
        return line;
    }

    private static int FindEquals(string line)
    {
        var inStr = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (c == '"') inStr = !inStr;
            else if (c == '=' && !inStr) return i;
        }
        return -1;
    }

    private static object ParseValue(string v, int lineNo)
    {
        if (v.Length >= 2 && v.StartsWith('"') && v.EndsWith('"'))
            return v[1..^1];
        if (v.Length >= 2 && v.StartsWith('\'') && v.EndsWith('\''))
            return v[1..^1];
        if (v == "true") return true;
        if (v == "false") return false;
        if (long.TryParse(v, out var n)) return n;
        throw new FormatException($"第 {lineNo} 行不支持的值: {v}");
    }

    private static TomlTable EnterTable(TomlTable root, string name, int lineNo)
    {
        var parts = SplitDotted(name);
        var node = root;
        foreach (var part in parts)
        {
            if (node.TryGetValue(part, out var existing))
            {
                if (existing is TomlTable t) node = t;
                else throw new FormatException($"第 {lineNo} 行: [ {name} ] 与已有键冲突");
            }
            else
            {
                var t = new TomlTable();
                node[part] = t;
                node = t;
            }
        }
        return node;
    }

    private static TomlTable EnterArrayTable(TomlTable root, string name, int lineNo)
    {
        var parts = SplitDotted(name);
        var node = root;
        for (var i = 0; i < parts.Length - 1; i++)
        {
            if (!node.TryGetValue(parts[i], out var existing) || existing is not TomlTable t)
                throw new FormatException($"第 {lineNo} 行: 未定义的表 {parts[i]}");
            node = t;
        }
        var last = parts[^1];
        if (!node.TryGetValue(last, out var arrObj))
        {
            var arr = new TomlTableArray();
            node[last] = arr;
        }
        if (node[last] is not TomlTableArray array)
            throw new FormatException($"第 {lineNo} 行: {name} 不是表数组");
        var entry = new TomlTable();
        array.Add(entry);
        return entry;
    }

    private static string[] SplitDotted(string name) =>
        name.Split('.', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
}
