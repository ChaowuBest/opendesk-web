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

// -- 目录删除打开形态与瞬时共享冲突重试 -------------------------------------
// RemoveDirectoryW（Node fs.rmdirSync / PowerShell Remove-Item / .NET）以文件句柄
// 方式（BACKUP_SEMANTICS，无 FILE_DIRECTORY_FILE）打开目录，掩码携带
// DELETE | WRITE_ATTRIBUTES。打开必须放行到 DeleteDirectory/Cleanup，否则策略
// 放行了删除也永远删不掉目录；写目录数据语义仍须拒绝。

var allowPolicy = new Policy();
allowPolicy.Rules.Add(new Rule("/**", "all", "allow"));
var deleteFs = new MirrorFs(source, allowPolicy);

var rmdirTarget = Path.Combine(source, "rmdir-target");
Directory.CreateDirectory(rmdirTarget);
var deleteOpenInfo = new Info();
Equal(deleteFs.CreateFile("\\rmdir-target", DokanNet.FileAccess.Delete | DokanNet.FileAccess.WriteAttributes,
    FileShare.ReadWrite, FileMode.Open, FileOptions.None, FileAttributes.Normal, deleteOpenInfo),
    DokanResult.Success, "directory delete-open accepted");
if (!deleteOpenInfo.IsDirectory) throw new Exception("delete-open did not mark the directory");
var dataWriteInfo = new Info();
Equal(deleteFs.CreateFile("\\rmdir-target", DokanNet.FileAccess.WriteData,
    FileShare.ReadWrite, FileMode.Open, FileOptions.None, FileAttributes.Normal, dataWriteInfo),
    DokanResult.AccessDenied, "directory data write via file handle still denied");

var deleteInfo = new Info { DeletePending = true, IsDirectory = true };
Equal(deleteFs.DeleteDirectory("\\rmdir-target", deleteInfo), DokanResult.Success, "empty directory deletion allowed");
deleteFs.Cleanup("\\rmdir-target", deleteInfo);
if (Directory.Exists(rmdirTarget)) throw new Exception("Cleanup did not remove the deleted directory");

Directory.CreateDirectory(Path.Combine(source, "rmdir-nonempty"));
File.WriteAllText(Path.Combine(source, "rmdir-nonempty", "keep.txt"), "x");
var nonEmptyInfo = new Info { DeletePending = true, IsDirectory = true };
Equal(deleteFs.DeleteDirectory("\\rmdir-nonempty", nonEmptyInfo), DokanResult.DirectoryNotEmpty, "non-empty directory reports DirectoryNotEmpty");
Equal(deleteFs.DeleteDirectory("\\rmdir-missing", new Info { DeletePending = true, IsDirectory = true }), DokanResult.PathNotFound, "missing directory reports PathNotFound");

var denyPolicy = new Policy();
denyPolicy.Rules.Add(new Rule("/**", "all", "deny"));
var denyFs = new MirrorFs(source, denyPolicy);
Equal(denyFs.DeleteDirectory("\\rmdir-nonempty", new Info { DeletePending = true, IsDirectory = true }),
    DokanResult.AccessDenied, "policy deny keeps directory deletion denied");
if (!Directory.Exists(Path.Combine(source, "rmdir-nonempty"))) throw new Exception("denied directory was removed");
Console.WriteLine("directory delete-open gate passed");

// 瞬时共享冲突：索引/杀软以 share=R|W（无 DELETE）短暂握住刚写完的文件，
// 镜像转发到宿主的改名/删除会收到 ERROR_SHARING_VIOLATION；必须退避重试，
// 不能把 EPERM 直接抛回调用方。
File.WriteAllText(Path.Combine(source, "rename-retry.txt"), "retry-content");
{
    // holder 先建句柄、短暂持有（覆盖改名首拍），随后在重试窗口内释放
    var holderOpened = new ManualResetEventSlim(false);
    var holderTask = Task.Run(() =>
    {
        using var held = File.Open(Path.Combine(source, "rename-retry.txt"), FileMode.Open,
            System.IO.FileAccess.Read, FileShare.Read | FileShare.Write);
        holderOpened.Set();
        Thread.Sleep(200);
    });
    if (!holderOpened.Wait(5000)) throw new Exception("holder never grabbed the file");
    Equal(deleteFs.MoveFile("\\rename-retry.txt", "\\rename-retry.moved", false, new Info()),
        DokanResult.Success, "rename survives transient sharing conflict");
    if (!File.Exists(Path.Combine(source, "rename-retry.moved"))) throw new Exception("renamed file missing on host");
    holderTask.Wait(5000);
}
File.Delete(Path.Combine(source, "rename-retry.moved"));

File.WriteAllText(Path.Combine(source, "cleanup-retry.txt"), "cleanup-content");
{
    var holderOpened = new ManualResetEventSlim(false);
    var holderTask = Task.Run(() =>
    {
        using var held = File.Open(Path.Combine(source, "cleanup-retry.txt"), FileMode.Open,
            System.IO.FileAccess.Read, FileShare.Read | FileShare.Write);
        holderOpened.Set();
        Thread.Sleep(150);
    });
    if (!holderOpened.Wait(5000)) throw new Exception("holder never grabbed the cleanup file");
    var cleanupInfo = new Info { DeletePending = true };
    deleteFs.Cleanup("\\cleanup-retry.txt", cleanupInfo);
    holderTask.Wait(5000);
    if (File.Exists(Path.Combine(source, "cleanup-retry.txt"))) throw new Exception("Cleanup gave up on transient sharing conflict");
}
Console.WriteLine("transient sharing conflict retry passed");

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
