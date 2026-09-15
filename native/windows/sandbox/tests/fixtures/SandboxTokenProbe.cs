using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class SandboxTokenProbe
{
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int length, out int needed);

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenGroups { public uint Count; public SidAndAttributes First; }

    public static void Main(string[] args)
    {
        using (var identity = WindowsIdentity.GetCurrent())
        {
            CheckToken(identity.Token, 29); // TokenIsAppContainer
            CheckToken(identity.Token, 30); // TokenCapabilities
        }
        var mappedPath = args[0];
        var hostPath = mappedPath.Substring(3).Insert(1, ":");
        foreach (var target in new[] { hostPath, mappedPath })
        {
            try
            {
                File.ReadAllText(target);
                throw new Exception("file isolation bypassed: " + target);
            }
            catch (UnauthorizedAccessException) { }
        }
        Console.WriteLine("capabilities-and-isolation-ok");
    }

    private static void CheckToken(IntPtr token, int kind)
    {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        var buffer = Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetTokenInformation(token, kind, buffer, needed, out needed))
                throw new Exception("GetTokenInformation failed");
            if (kind == 29)
            {
                if (Marshal.ReadInt32(buffer) != 1) throw new Exception("child escaped AppContainer");
                return;
            }
            var count = Marshal.ReadInt32(buffer);
            var first = Marshal.OffsetOf(typeof(TokenGroups), "First").ToInt32();
            var sids = new System.Collections.Generic.List<string>();
            for (var i = 0; i < count; i++)
            {
                var entry = (SidAndAttributes)Marshal.PtrToStructure(
                    buffer + first + i * Marshal.SizeOf(typeof(SidAndAttributes)), typeof(SidAndAttributes));
                if ((entry.Attributes & 4) != 0) sids.Add(new SecurityIdentifier(entry.Sid).Value);
            }
            if (!sids.Contains("S-1-15-3-1") || !sids.Contains("S-1-15-3-3"))
                throw new Exception("network capabilities missing from child token");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
}
