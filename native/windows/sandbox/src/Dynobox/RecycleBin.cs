/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Dynobox;

/// <summary>
/// 回收站删除：通过 SHFileOperation 把文件/目录送入 Windows 回收站。
/// 只在确认支持回收站的位置（本地盘/可移动盘）尝试；其余位置一律不执行删除，
/// 由调用方保留原文件（fail-safe：宁可让 rm 的结果失真，也不永久丢失用户数据）。
/// 错误信息仅进入内部诊断日志，不面向最终用户展示。
/// </summary>
public static class RecycleBin
{
    private const uint FO_DELETE = 3;
    private const ushort FOF_SILENT = 0x4;
    private const ushort FOF_NOCONFIRMATION = 0x10;
    private const ushort FOF_ALLOWUNDO = 0x40;
    private const ushort FOF_NOERRORUI = 0x400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCTW
    {
        public IntPtr hwnd;
        public uint wFunc;
        public string pFrom;
        public string? pTo;
        public ushort fFlags;
        // BOOL：非 0 表示操作被用户或系统中止
        public int fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string? lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperationW(ref SHFILEOPSTRUCTW op);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetVolumeNameForVolumeMountPointW(
        string mountPoint, StringBuilder volumeName, uint bufferLength);

    private const string BitBucketVolumeKey =
        @"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume";

    /// <summary>
    /// 该盘符的回收站被用户/策略禁用（"不将文件移到回收站"：NukeOnDelete=1
    /// 或 MaxCapacity=0）时，FOF_ALLOWUNDO 的删除会静默变成永久删除并返回
    /// 成功——与"启用后不丢文件"的承诺冲突，必须在删除前检测并拒绝。
    /// 读不到配置（键不存在/异常）一律按启用处理，保持既有行为。
    /// </summary>
    internal static bool IsBinDisabledForDrive(string root)
    {
        try
        {
            var mount = root.EndsWith('\\') ? root : root + "\\";
            var sb = new StringBuilder(120);
            if (!GetVolumeNameForVolumeMountPointW(mount, sb, (uint)sb.Capacity)) return false;
            var guid = sb.ToString().TrimEnd('\\');               // \\?\Volume{guid}
            var subKey = guid.Substring(guid.LastIndexOf('\\') + 1); // {guid}
            using var key = Registry.CurrentUser.OpenSubKey(BitBucketVolumeKey + "\\" + subKey);
            if (key is null) return false;
            if (key.GetValue("NukeOnDelete") is int nuke && nuke != 0) return true;
            if (key.GetValue("MaxCapacity") is int capacity && capacity == 0) return true;
            return false;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>把 path 送入回收站。失败时不产生任何破坏性副作用，返回 false 与原因。</summary>
    public static bool TrySend(string path, out string error)
    {
        error = "";
        // FOF_ALLOWUNDO 在没有回收站的位置（网络路径、光盘、RAM 盘等）会退化为
        // 永久删除，与"启用后不丢文件"的承诺冲突，这些位置直接拒绝。
        if (path.StartsWith(@"\\"))
        {
            error = "network paths have no recycle bin";
            return false;
        }
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(path));
            if (root is null || !new DriveInfo(root).IsReady ||
                new DriveInfo(root).DriveType is not (DriveType.Fixed or DriveType.Removable))
            {
                error = "drive does not keep a recycle bin";
                return false;
            }
            if (IsBinDisabledForDrive(root))
            {
                error = "recycle bin is disabled for this drive";
                return false;
            }
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
        // pFrom 必须是双 NUL 结尾的多串列表；封送器补最后一个 NUL，这里先补一个
        var op = new SHFILEOPSTRUCTW
        {
            wFunc = FO_DELETE,
            pFrom = path + "\0",
            fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI),
        };
        var rc = SHFileOperationW(ref op);
        if (rc == 0 && op.fAnyOperationsAborted == 0) return true;
        error = rc != 0 ? $"SHFileOperation code {rc}" : "operation aborted";
        return false;
    }
}
