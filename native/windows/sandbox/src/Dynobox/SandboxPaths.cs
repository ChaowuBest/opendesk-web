/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

using System.Text.RegularExpressions;

namespace Dynobox;

/// <summary>
/// 沙箱内部路径的统一判定。策略、镜像文件系统与回收站分支都依赖"哪些路径
/// 不属于用户数据"这一语义，集中在此避免各处自行拼前缀/正则：
///   - /dynobox          引导区（管理副本、兼容 overlay、虚拟 NUL 文件）
///   - /dynobox/nul.file 虚拟 NUL（读 EOF、写丢弃，供 os.devnull 类用途）
///   - AppContainer 私有 AC 数据（部分系统上运行库会写入探测/缓存文件）
/// </summary>
public static class SandboxPaths
{
    public const string BootstrapArea = "/dynobox";
    public const string VirtualNulPath = BootstrapArea + "/nul.file";

    private static readonly Regex AppContainerPrivateData = new(
        @"^/[A-Za-z]/Users/[^/]+/AppData/Local/Packages/dynobox-[^/]+/AC(?:/|$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static bool IsBootstrapArea(string vpath)
    {
        var normalized = Policy.NormalizeVirtualPath(vpath);
        return normalized.Equals(BootstrapArea, StringComparison.OrdinalIgnoreCase) ||
               normalized.StartsWith(BootstrapArea + "/", StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsVirtualNul(string vpath) =>
        Policy.NormalizeVirtualPath(vpath).Equals(VirtualNulPath, StringComparison.OrdinalIgnoreCase);

    public static bool IsAppContainerPrivateData(string vpath) =>
        AppContainerPrivateData.IsMatch(Policy.NormalizeVirtualPath(vpath));

    /// <summary>内部路径 = 引导区 ∪ 虚拟 NUL ∪ AppContainer 私有数据。
    /// 回收站分支对内部路径直接清除，不送回收站。</summary>
    public static bool IsInternal(string vpath) =>
        IsBootstrapArea(vpath) || IsVirtualNul(vpath) || IsAppContainerPrivateData(vpath);
}
