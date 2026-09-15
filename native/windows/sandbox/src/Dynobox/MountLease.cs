/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

namespace Dynobox;

/// <summary>盘符从选择到卸载始终由当前进程占用；进程退出后内核自动回收占用。</summary>
internal sealed class MountLease : IDisposable
{
    private readonly Mutex _mutex;
    public string Letter { get; }

    private MountLease(string letter, Mutex mutex)
    {
        Letter = letter;
        _mutex = mutex;
    }

    // A user's stable AppContainer identities must not overlap across logon sessions.
    private static string Name(char letter) => @"Global\OpenDesk.Dynobox.Mount."
        + LoopbackAccess.CurrentUserSid + "." + char.ToUpperInvariant(letter);

    public static bool IsReserved(char letter)
    {
        if (!Mutex.TryOpenExisting(Name(letter), out var mutex)) return false;
        mutex.Dispose();
        return true;
    }

    public static MountLease Acquire(string? requested)
    {
        var normalized = requested?.TrimEnd(':', '\\').ToUpperInvariant();
        if (normalized is not null && (normalized.Length != 1 || normalized[0] < 'A' || normalized[0] > 'Z'))
            throw new ArgumentException("Invalid sandbox mount letter", nameof(requested));
        var drives = DriveInfo.GetDrives().Select(d => char.ToUpperInvariant(d.Name[0])).ToHashSet();
        var candidates = normalized is null ? "ZYXWVUTSRQPONMLKJIHGFEDC" : normalized;
        foreach (var letter in candidates)
        {
            // 仅新建对象成功时占用，避免同线程构造多个实例时 Mutex 的可重入语义。
            var mutex = new Mutex(initiallyOwned: false, Name(letter), out var created);
            if (created && !drives.Contains(letter)) return new MountLease(letter.ToString(), mutex);
            mutex.Dispose();
        }
        throw new InvalidOperationException("Sandbox mount letter is occupied or no free drive is available");
    }

    public void Dispose() => _mutex.Dispose();
}
