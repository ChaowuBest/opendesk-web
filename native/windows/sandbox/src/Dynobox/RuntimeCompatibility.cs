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
/// runtime which emits the legacy named-pipe format is copied into the private
/// bootstrap directory and receives the same safe namespace as every other
/// executable.
/// </summary>
internal static class RuntimeCompatibility
{
    private static readonly (string From, string To)[] NamedObjectFormats =
    {
        ("\\\\?\\pipe\\uv\\%llu-%lu", "\\\\.\\pipe\\LOCAL\\%llu"),
        ("\\\\?\\pipe\\%suv\\%llu-%lu", "\\\\.\\pipe\\LOCAL\\%llu"),
    };

    public static bool PrepareExecutable(string source, string destination)
    {
        File.Copy(source, destination, overwrite: true);
        var bytes = File.ReadAllBytes(destination);
        var changed = false;
        foreach (var (from, to) in NamedObjectFormats)
            changed |= ReplaceAscii(bytes, from, to) > 0;
        if (changed) File.WriteAllBytes(destination, bytes);
        return changed;
    }

    private static int ReplaceAscii(byte[] bytes, string fromText, string toText)
    {
        var from = Encoding.ASCII.GetBytes(fromText);
        var to = Encoding.ASCII.GetBytes(toText);
        if (to.Length > from.Length) return 0;
        var count = 0;
        for (var i = 0; i <= bytes.Length - from.Length; i++)
        {
            if (!bytes.AsSpan(i, from.Length).SequenceEqual(from)) continue;
            to.CopyTo(bytes.AsSpan(i, to.Length));
            Array.Clear(bytes, i + to.Length, from.Length - to.Length);
            count++;
            i += from.Length - 1;
        }
        return count;
    }
}
