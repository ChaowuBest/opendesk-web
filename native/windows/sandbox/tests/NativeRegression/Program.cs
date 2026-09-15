using System.Security.Principal;
using DokanNet;
using Dynobox;

if (args[0] == "reserve")
{
    using var sandbox = new Sandbox(new Policy(), automount: true);
    Console.WriteLine(sandbox.Letter);
    Console.ReadLine();
    return;
}

var source = args[0];
var policy = new Policy();
policy.Rules.Add(new Rule("/**", "all", "deny"));
var fs = new MirrorFs(new[] { ("/D", source), ("/NET/share", source) }, policy);
NtStatus Open(MirrorFs mirror, string name, DokanNet.FileAccess access, FileMode mode = FileMode.Open) =>
    mirror.CreateFile(name, access, FileShare.ReadWrite, mode, FileOptions.None, FileAttributes.Normal, new Info());
void Equal(NtStatus actual, NtStatus expected, string label)
{
    if (actual != expected) throw new Exception($"{label}: expected {expected}, got {actual}");
}
Equal(Open(fs, "\\", DokanNet.FileAccess.ReadAttributes), DokanResult.Success, "synthetic volume root");
Equal(Open(fs, "\\NET", DokanNet.FileAccess.ReadAttributes), DokanResult.Success, "synthetic assembly node");
Equal(Open(fs, "\\", DokanNet.FileAccess.WriteData), DokanResult.AccessDenied, "synthetic root write");
Equal(Open(fs, "\\", DokanNet.FileAccess.ReadAttributes, FileMode.Create), DokanResult.AccessDenied, "synthetic root create");
Equal(Open(fs, "\\D", DokanNet.FileAccess.ReadAttributes), DokanResult.AccessDenied, "real drive root still enforced");
Equal(Open(new MirrorFs(source, policy), "\\", DokanNet.FileAccess.ReadAttributes), DokanResult.AccessDenied, "single real root still enforced");
if (!policy.Check("/C/Users/test/AppData/Local/Packages/dynobox-1234/AC/Temp/policy-test.ps1", "write").Allowed)
    throw new Exception("internal AppContainer temp writes should be allowed");
if (!policy.Check("/C/Users/test/AppData/Local/Packages/dynobox-1234/AC/Microsoft/Windows/PowerShell/ModuleAnalysisCache/cache", "execute").Allowed)
    throw new Exception("internal AppContainer cache access should be allowed");
Console.WriteLine("synthetic traversal passed");

var listingPolicy = new Policy();
listingPolicy.Rules.Add(new Rule("/**", "read", "allow"));
var listingFs = new MirrorFs(new[] { ("/D", source) }, listingPolicy);
var listingInfo = new Info();
Equal(listingFs.CreateFile("\\D", DokanNet.FileAccess.ReadData | DokanNet.FileAccess.ReadAttributes,
    FileShare.ReadWrite, FileMode.Open, FileOptions.None, FileAttributes.Normal, listingInfo),
    DokanResult.Success, "directory listing without initial directory flag");
if (!listingInfo.IsDirectory) throw new Exception("directory handle was not recognized");
listingFs.CloseFile("\\D", listingInfo);
Equal(Open(fs, "\\D", DokanNet.FileAccess.ReadData), DokanResult.AccessDenied, "denied directory listing");
Equal(Open(listingFs, "\\D", DokanNet.FileAccess.WriteData), DokanResult.AccessDenied, "directory write still denied");

// Windows may fault pages from an executable after its user handle is cleaned up.
// Dokan CloseFile, rather than Cleanup, ends that file object's lifetime.
var pagingFile = "sandbox-paging-" + Guid.NewGuid().ToString("N") + ".bin";
var pagingPath = Path.Combine(source, pagingFile);
File.WriteAllText(pagingPath, "mapped child image");
try
{
    var allow = new Policy();
    allow.Rules.Add(new Rule("/**", "all", "allow"));
    var pagingFs = new MirrorFs(source, allow);
    var info = new Info();
    var virtualFile = "\\" + pagingFile;
    Equal(pagingFs.CreateFile(virtualFile, DokanNet.FileAccess.ReadData, FileShare.ReadWrite,
        FileMode.Open, FileOptions.None, FileAttributes.Normal, info), DokanResult.Success, "open image");
    pagingFs.Cleanup(virtualFile, info);
    var buffer = new byte[64];
    Equal(pagingFs.ReadFile(virtualFile, buffer, out var count, 0, info), DokanResult.Success, "paging read after Cleanup");
    if (System.Text.Encoding.UTF8.GetString(buffer, 0, count) != "mapped child image") throw new Exception("image data corrupted");
    pagingFs.CloseFile(virtualFile, info);
    Equal(pagingFs.ReadFile(virtualFile, buffer, out _, 0, info), DokanResult.AccessDenied, "final CloseFile releases image");
}
finally { File.Delete(pagingPath); }
Console.WriteLine("paging lifetime passed");

sealed class Info : IDokanFileInfo
{
    public object? Context { get; set; }
    public bool DeletePending { get; set; }
    public bool IsDirectory { get; set; }
    public bool NoCache => false;
    public bool PagingIo => false;
    public int ProcessId => Environment.ProcessId;
    public bool SynchronousIo => true;
    public bool WriteToEndOfFile => false;
    public WindowsIdentity GetRequestor() => null!;
    public bool TryResetTimeout(int milliseconds) => true;
}
