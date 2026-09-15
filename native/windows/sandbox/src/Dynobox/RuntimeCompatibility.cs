/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

using System.Text;

namespace Dynobox;

/// <summary>
/// Compatibility preparation for executables launched in an AppContainer.
/// Rules are content based: the launcher never branches on a tool name. A
/// runtime which embeds a host-only path or emits the legacy named-pipe format
/// is copied into a private overlay and receives the sandbox path semantics.
/// </summary>
internal static class RuntimeCompatibility
{
    private static readonly byte[] LegacyPipePrefix = Encoding.ASCII.GetBytes("\\\\?\\pipe\\");
    private static readonly byte[] LegacyPipeSuffix = Encoding.ASCII.GetBytes("\\%llu-%lu");
    private static readonly byte[] LocalPipeTemplate = Encoding.ASCII.GetBytes("\\\\.\\pipe\\LOCAL\\%llu");

    public static bool PrepareExecutable(
        string source,
        string destination,
        IEnumerable<(string From, string To)>? pathMaps = null)
    {
        var bytes = File.ReadAllBytes(source).ToList();
        var changed = false;
        changed |= ReplaceLegacyNamedPipeTemplates(bytes) > 0;
        if (pathMaps is not null)
            changed |= ReplaceEmbeddedPaths(bytes, pathMaps);
        if (!changed) return false;

        var parent = Path.GetDirectoryName(destination);
        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
        File.WriteAllBytes(destination, bytes.ToArray());
        return changed;
    }

    private static int ReplaceLegacyNamedPipeTemplates(List<byte> bytes)
    {
        var count = 0;
        for (var i = 0; i <= bytes.Count - LegacyPipePrefix.Length; i++)
        {
            if (!Matches(bytes, i, LegacyPipePrefix)) continue;
            var nameStart = i + LegacyPipePrefix.Length;
            var nameEnd = IndexOf(bytes, (byte)'\\', nameStart);
            if (nameEnd <= nameStart || !Matches(bytes, nameEnd, LegacyPipeSuffix)) continue;

            var sourceLength = nameEnd + LegacyPipeSuffix.Length - i;
            if (LocalPipeTemplate.Length > sourceLength) continue;
            ReplaceInPlace(bytes, i, sourceLength, LocalPipeTemplate);
            count++;
            i += sourceLength - 1;
        }
        return count;
    }

    private static int IndexOf(List<byte> bytes, byte value, int start)
    {
        for (var i = start; i < bytes.Count; i++)
            if (bytes[i] == value) return i;
        return -1;
    }

    private static void ReplaceInPlace(List<byte> bytes, int offset, int sourceLength, byte[] replacement)
    {
        for (var i = 0; i < replacement.Length; i++) bytes[offset + i] = replacement[i];
        for (var i = replacement.Length; i < sourceLength; i++) bytes[offset + i] = 0;
    }

    private static bool ReplaceEmbeddedPaths(
        List<byte> bytes,
        IEnumerable<(string From, string To)> pathMaps)
    {
        var maps = pathMaps
            .Where(map => !string.IsNullOrEmpty(map.From) &&
                          !string.Equals(map.From, map.To, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(map => map.From.Length)
            .Select(map => (From: Encoding.UTF8.GetBytes(map.From), map.To))
            .ToArray();
        if (maps.Length == 0) return false;

        var changed = false;
        // Windows launcher formats commonly store an interpreter path directly
        // after a #! marker. Restrict replacements to that marker so unrelated
        // strings in a PE image are never rewritten.
        for (var marker = 0; marker + 1 < bytes.Count; marker++)
        {
            if (bytes[marker] != (byte)'#' || bytes[marker + 1] != (byte)'!') continue;
            var pathStart = marker + 2;
            foreach (var (from, toText) in maps)
            {
                if (!MatchesPath(bytes, pathStart, from)) continue;
                var to = Encoding.UTF8.GetBytes(toText);
                bytes.RemoveRange(pathStart, from.Length);
                bytes.InsertRange(pathStart, to);
                changed = true;
                break;
            }
        }
        return changed;
    }

    private static bool Matches(List<byte> bytes, int offset, byte[] value)
    {
        if (offset < 0 || offset + value.Length > bytes.Count) return false;
        for (var i = 0; i < value.Length; i++)
            if (bytes[offset + i] != value[i]) return false;
        return true;
    }

    private static bool MatchesPath(List<byte> bytes, int offset, byte[] value)
    {
        if (offset < 0 || offset + value.Length > bytes.Count) return false;
        for (var i = 0; i < value.Length; i++)
        {
            var actual = bytes[offset + i];
            var expected = value[i];
            if (actual == expected) continue;
            if (actual is >= (byte)'a' and <= (byte)'z') actual = (byte)(actual - ('a' - 'A'));
            if (expected is >= (byte)'a' and <= (byte)'z') expected = (byte)(expected - ('a' - 'A'));
            if (actual != expected) return false;
        }
        return true;
    }

    public static bool IsVirtualPathDiagnostic(ReadOnlySpan<byte> line, string virtualRoot)
    {
        var text = Encoding.UTF8.GetString(line).TrimEnd('\r', '\n');
        const string prefix = "Failed to find real location of ";
        var root = virtualRoot.TrimEnd('\\', '/');
        if (MatchesRootDiagnostic(text, prefix, root)) return true;

        // 用户在命令里重定向 stderr（2>&1）时，PowerShell 把这条原生 stderr 行
        // 包装成错误记录再输出，例如：
        //   "python : Failed to find real location of Z:\C\...\python.exe"
        //   "+ CategoryInfo          : NotSpecified: (Failed to find real location of Z:\...:String) [], RemoteException"
        // 后者尾部带有 ":String) ..." 字段。只按行内出现的前缀 + 虚拟根匹配剥离，
        // 其余 stderr 内容（含真实的 Python traceback）一律原样放行。
        var idx = text.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
        if (idx <= 0) return false;
        return MatchesRootDiagnostic(text[(idx + prefix.Length)..], prefix, root) ||
               MatchesRootPathPrefix(text[(idx + prefix.Length)..], root);
    }

    private static bool MatchesRootDiagnostic(string text, string prefix, string root)
    {
        if (!text.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
        return MatchesRootPathPrefix(text[prefix.Length..], root);
    }

    private static bool MatchesRootPathPrefix(string path, string root)
    {
        var trimmed = path.Trim();
        return trimmed.Equals(root, StringComparison.OrdinalIgnoreCase) ||
               trimmed.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase) ||
               trimmed.StartsWith(root + "/", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 行级诊断判定（不依赖卷根）：行内任意位置出现 getpath 警告前缀即认为
    /// 是需要抑制的诊断行（覆盖 raw 与 PowerShell 包装两种形态）。
    /// </summary>
    public static bool IsRealpathDiagnosticLine(string text)
    {
        return text.Contains("Failed to find real location of ", StringComparison.OrdinalIgnoreCase);
    }

}
