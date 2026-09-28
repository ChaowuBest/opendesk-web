/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

using System.Runtime.InteropServices;
using System.Text;

namespace Dynobox;

/// <summary>
/// 孤儿卷清扫：沙箱管理进程被强制结束（任务管理器/崩溃/信号）而卷仍挂载时，
/// 内核中未完成的 IRP 永远无人完成——之后任何触碰该盘符的进程都会无限挂起，
/// 最终拖垮整个系统。这里在每次运行启动前清理此类残留：
/// - 用 QueryDosDevice 识别 Dokan 卷（设备目标为 \Device\Volume{GUID} 形态；
///   真实磁盘分区是 \Device\HarddiskVolumeN）。这是纯对象管理器查询，
///   不产生文件系统 IRP，对孤儿卷也绝不挂起；
/// - 租约互斥体仍被持有的盘符属于存活实例，一律跳过；
/// - 其余交给 Dokan.RemoveMountPoint 强制卸载（内核侧补完挂起 IRP）。
/// </summary>
internal static class MountSweep
{
    public static IReadOnlyList<char> DokanVolumeLetters()
    {
        var result = new List<char>();
        for (var letter = 'C'; letter <= 'Z'; letter++)
        {
            if (TryQueryDosDevice(letter, out var target) &&
                target.StartsWith(@"\Device\Volume{", StringComparison.OrdinalIgnoreCase))
                result.Add(letter);
        }
        return result;
    }

    /// <summary>卸载所有"无存活管理进程"的 Dokan 残留卷，返回被清理的盘符。</summary>
    public static IReadOnlyList<char> Sweep()
    {
        var cleaned = new List<char>();
        var dokan = new DokanNet.Dokan(new DokanNet.Logging.NullLogger());
        using var _ = dokan;
        foreach (var letter in DokanVolumeLetters())
        {
            if (MountLease.IsReserved(letter)) continue;   // 存活实例的卷，绝不触碰
            try
            {
                if (dokan.RemoveMountPoint(letter + ":"))
                {
                    cleaned.Add(letter);
                    Log.Info("[SWEEP] 已清理孤儿卷 {0}:", letter);
                }
            }
            catch (Exception ex)
            {
                Log.Warn("[SWEEP] 清理孤儿卷 {0}: 失败 {1}", letter, ex.Message);
            }
        }
        return cleaned;
    }

    private static bool TryQueryDosDevice(char letter, out string target)
    {
        target = string.Empty;
        var buffer = new StringBuilder(1024);
        var length = QueryDosDeviceW(letter + ":", buffer, buffer.Capacity);
        if (length == 0) return false;
        // 多串以 \0 分隔，取第一段
        target = buffer.ToString().Split('\0')[0];
        return target.Length > 0;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint QueryDosDeviceW(string deviceName,
        [Out] StringBuilder targetPath, int max);
}
