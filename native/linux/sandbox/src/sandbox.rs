/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

//! 沙箱装配与进程治理：
//! 1. 管理进程（宿主 namespace）fork daemon（FUSE 会话）与装配进程；
//! 2. 装配进程 unshare(user/mount/pid/ipc) → uid_map（ns 内 root 映射宿主用户）
//!    → 在自身 userns 内 open /dev/fuse 并就地挂载 FUSE（透明路径）
//!    → tmpfs 新根 + pivot_root → 系统目录 ro bind → 最小 /dev /proc
//!    → fork shell（pid ns 内 pid 1，收敛 caps 后 exec）；
//! 3. daemon 位于宿主 namespace：通过 SCM_RIGHTS 接收装配进程挂载后的 FUSE fd
//!    （fd 在装配 userns 内 open，daemon 仅收发协议帧），直接访问镜像源；
//! 4. 治理：PID namespace（shell 死 → 全 ns 清空）+ PR_SET_PDEATHSIG（管理进程死
//!    → 整树陪葬）+ cgroup v2 cgroup.kill（best effort 双保险）。

use std::ffi::{CString, OsString};
use std::fs;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use nix::sys::socket::{
    recvmsg, sendmsg, socketpair, AddressFamily, ControlMessage, ControlMessageOwned,
    MsgFlags, SockFlag, SockType, SockaddrStorage,
};
use std::io::IoSliceMut;

use crate::mirror_fs::MirrorFs;
use crate::policy::Policy;

const RO_BIND_DIRS: &[&str] = &["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/opt", "/usr/local"];
const DEV_BINDS: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/full",
    "/dev/tty",
    "/dev/ptmx",
];
const ROOT_FS_MASK: u64 = libc::MS_NOSUID | libc::MS_NODEV;

// linux/capability.h 常量（libc crate 未导出）
const CAP_LINUX_IMMUTABLE: libc::c_int = 9;
const CAP_NET_ADMIN: libc::c_int = 12;
const CAP_SYS_MODULE: libc::c_int = 16;
const CAP_SYS_RAWIO: libc::c_int = 17;
const CAP_SYS_CHROOT: libc::c_int = 18;
const CAP_SYS_PTRACE: libc::c_int = 19;
const CAP_SYS_PACCT: libc::c_int = 20;
const CAP_SYS_ADMIN: libc::c_int = 21;
const CAP_SYS_BOOT: libc::c_int = 22;
const CAP_SYS_RESOURCE: libc::c_int = 24;
const CAP_SYS_TIME: libc::c_int = 25;
const CAP_SYS_TTY_CONFIG: libc::c_int = 26;
const CAP_MKNOD: libc::c_int = 27;
const CAP_LEASE: libc::c_int = 28;
const CAP_SETFCAP: libc::c_int = 31;
const CAP_IPC_LOCK: libc::c_int = 14;

pub struct RunOptions {
    pub policy: Arc<Policy>,
    pub child_argv: Vec<String>,
    pub cwd: Option<String>,
    /// 额外只读挂载目录（工具链等宿主路径，逗号分隔），沙箱内同路径只读可见
    pub ro_dirs: Vec<String>,
    /// 诊断日志文件（追加写入装配/退出关键事件；终端结果不受影响）
    pub log_file: Option<String>,
    /// 删除送回收站（XDG Trash）：unlink/rmdir 改写为移动到 trash 目录
    pub del_to_trash: bool,
}

fn last_err(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}

fn cstr(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| format!("路径含 NUL: {value}"))
}

fn do_mount(source: &str, target: &str, fstype: &str, flags: u64, data: &str) -> Result<(), String> {
    let src = cstr(source)?;
    let dst = cstr(target)?;
    let fstype = if fstype.is_empty() {
        Ok::<_, String>(None)
    } else {
        cstr(fstype).map(Some)
    }?;
    let data = if data.is_empty() {
        Ok::<_, String>(None)
    } else {
        cstr(data).map(Some)
    }?;
    let data_ptr = data.as_ref().map_or(std::ptr::null(), |d| d.as_ptr());
    let result = unsafe {
        libc::mount(
            src.as_ptr(),
            dst.as_ptr(),
            fstype.as_ref().map_or(std::ptr::null::<libc::c_char>(), |f| f.as_ptr()),
            flags,
            data_ptr as *const libc::c_void,
        )
    };
    if result != 0 {
        Err(last_err(&format!("mount({source} -> {target})")))
    } else {
        Ok(())
    }
}

fn mkdir_p(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("mkdir {}: {e}", path.display()))
}

/// 将挂载点显式设为私有传播（防挂载泄漏到宿主 namespace）。
/// 历史事故：FUSE 挂载曾因父挂载传播状态异常泄漏到宿主根 /，覆盖整个文件系统。
/// 私有化失败视为致命（fail-closed）：宁可不启动沙箱，也不污染宿主挂载树。
fn mount_private(target: &Path) -> Result<(), String> {
    do_mount(
        "none",
        target.to_str().ok_or("挂载点非 UTF-8")?,
        "",
        libc::MS_PRIVATE,
        "",
    )
}

fn bind_ro(source: &str, target: &Path) -> Result<(), String> {
    let target_str = target.to_str().ok_or("路径非 UTF-8")?;
    do_mount(source, target_str, "", libc::MS_BIND, "")
        .and_then(|_| do_mount(source, target_str, "", libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY, ""))
        .and_then(|_| mount_private(target))
}

fn bind_existing(source: &str, target: &Path) -> Result<(), String> {
    if Path::new(source).exists() {
        // bind 目标必须存在：目录先 mkdir，文件先 touch
        if let Some(parent) = target.parent() {
            let _ = mkdir_p(parent);
        }
        if !target.exists() {
            fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(target)
                .map_err(|e| format!("创建 bind 目标 {}: {e}", target.display()))?;
        }
        let target_str = target.to_str().ok_or("路径非 UTF-8")?;
        do_mount(source, target_str, "", libc::MS_BIND, "")?;
        mount_private(target)?;
    }
    Ok(())
}

fn write_proc_file(path: &str, content: &str) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("打开 {path}: {e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入 {path}: {e}"))?;
    Ok(())
}

fn set_pdeathsig() {
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
        // fork 后到 prctl 之间的竞态窗口：若父进程已死，pdeathsig 不会送达，
        // 立即检查父进程是否仍存活，否则自行退出（由调用方处理）
        if libc::kill(libc::getppid(), 0) != 0 {
            std::process::exit(1);
        }
    }
}

/// userns 可用性探测（fork 子进程执行，避免污染当前进程 namespace）。
pub fn userns_available() -> bool {
    unsafe {
        let pid = libc::fork();
        if pid < 0 {
            return false;
        }
        if pid == 0 {
            let ok = libc::unshare(libc::CLONE_NEWUSER) == 0;
            libc::_exit(if ok { 0 } else { 1 });
        }
        let mut status: libc::c_int = 0;
        libc::waitpid(pid, &mut status, 0);
        libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
    }
}

pub fn fuse_available() -> bool {
    Path::new("/dev/fuse").exists()
}

fn cgroup_setup(child_pid: libc::pid_t) -> Option<PathBuf> {
    let dir = PathBuf::from(format!("/sys/fs/cgroup/dynobox-{child_pid}"));
    match fs::create_dir(&dir) {
        Ok(()) => {
            let pid_file = dir.join("cgroup.procs");
            if fs::write(&pid_file, format!("{child_pid}\n")).is_ok() {
                Some(dir)
            } else {
                let _ = fs::remove_dir(&dir);
                None
            }
        }
        Err(_) => None,
    }
}

/// 清理陈旧的 /tmp/dynobox-root-<pid> 目录：管理进程被 SIGKILL 时无法正常清理，
/// 下次启动回收孤儿目录（仅当对应 pid 不再存活，避免误删并发实例）。
fn cleanup_stale_root_dirs() {
    let Ok(entries) = fs::read_dir("/tmp") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(pid_str) = name.strip_prefix("dynobox-root-") {
            if let Ok(pid) = pid_str.parse::<i32>() {
                let alive = unsafe { libc::kill(pid, 0) } == 0;
                if !alive {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

/// 按策略声明挂载 FUSE 根：virtual="/" 时 FUSE 挂到新根（整根视图），
/// 否则按各 root 路径就地挂载。
fn send_fuse_fds(sockets: &[RawFd], fuse_fds: &[RawFd]) -> Result<(), String> {
    for (index, socket) in sockets.iter().enumerate() {
        let fd = fuse_fds[index];
        let iov = [std::io::IoSlice::new(b"F")];
        let fds = [fd];
        sendmsg(
            *socket,
            &iov,
            &[ControlMessage::ScmRights(&fds)],
            MsgFlags::empty(),
            None::<&SockaddrStorage>,
        )
        .map_err(|e| format!("sendmsg fd: {e}"))?;
    }
    Ok(())
}

fn mount_roots(policy: &Policy, fuse_fds: &[RawFd], root_dir: &Path) -> Result<(), String> {
    // 整根（virtual="/"）与其他局部 root 混用会导致嵌套 FUSE（子挂载在整根卷内），
    // 双 daemon 单线程互相等待而死锁——fail-fast 拒绝
    let root_count = policy.roots.len();
    if root_count > 1 && policy.roots.iter().any(|r| r.virtual_path == "/") {
        return Err("整根视图（virtual=\"/\"）不能与其他 [[roots]] 混用（会形成嵌套 FUSE 死锁）".to_string());
    }
    for (index, root) in policy.roots.iter().enumerate() {
        let fd = fuse_fds[index];
        let mountpoint = if root.virtual_path == "/" {
            root_dir.to_path_buf()
        } else {
            let point = root_dir.join(root.virtual_path.trim_start_matches('/'));
            mkdir_p(&point)?;
            point
        };
        // user_id/group_id 在挂载者 userns 中解释：ns 内 uid 0 即宿主用户，
        // 与 fd 打开者一致。default_permissions：内核按 attr 的 uid/gid/perm 做标准
        // 权限检查（与真实文件系统语义一致；否则内核会在无 default_permissions 时
        // 对写/创建走特殊规则，导致 /tmp 等 world-writable 目录被拒）
        let data = format!("fd={fd},rootmode=40000,user_id=0,group_id=0,default_permissions");
        let mountpoint_str = mountpoint.to_str().ok_or("挂载点非 UTF-8")?;
        do_mount("dynobox", mountpoint_str, "fuse.dynobox", ROOT_FS_MASK, &data)?;
        // 防挂载泄漏（历史事故：FUSE 曾传播到宿主根 /，导致整个文件系统被覆盖）：
        // 挂载后对挂载点显式 MS_PRIVATE，隔离其传播组。正常情况下父挂载已私有，
        // 新挂载继承私有；此步骤是父传播状态异常时的双保险（传播是即时事件，
        // 一旦发生会直接污染宿主挂载树）。
        do_mount("none", mountpoint_str, "", libc::MS_PRIVATE, "")?;
    }
    Ok(())
}

fn cgroup_kill_and_remove(dir: &Path) {
    let kill = dir.join("cgroup.kill");
    if kill.exists() {
        let _ = fs::write(&kill, "1");
    } else if let Ok(procs) = fs::read_to_string(dir.join("cgroup.procs")) {
        for line in procs.lines() {
            if let Ok(pid) = line.trim().parse::<i32>() {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

/// 装配编排（对齐 bwrap 结构）：A 进入 namespace 并 fork S；S（pid ns 内 pid 1）
/// 完成全部挂载（ro bind / dev / tmpfs / FUSE / proc）后再 pivot_root，随后收敛
/// caps 并 exec shell。proc 挂载必须在 pivot_root 之前：pivot 后挂载 proc 会被内核
/// 拒绝（EPERM，实测）。
fn assemble(
    sockets: &[RawFd],
    policy: &Policy,
    root_dir: &Path,
    cwd: Option<&str>,
    ro_dirs: &[String],
    child_argv: &[String],
    mut status_pipe: fs::File,
) -> ! {
    // --- A：namespace 准备 ---
    // A 是管理进程（M）的子进程：M 被杀时 A 需陪葬（否则 pid ns 不销毁，shell 残留）
    set_pdeathsig();
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    if unsafe { libc::unshare(libc::CLONE_NEWUSER) } != 0 {
        let _ = status_pipe.write_all(format!("0 {}\n", last_err("unshare(CLONE_NEWUSER)")).as_bytes());
        std::process::exit(1);
    }
    let _ = write_proc_file("/proc/self/setgroups", "deny");
    if let Err(e) = write_proc_file("/proc/self/uid_map", &format!("0 {uid} 1\n")) {
        let _ = status_pipe.write_all(format!("0 uid_map: {e}\n").as_bytes());
        std::process::exit(1);
    }
    if let Err(e) = write_proc_file("/proc/self/gid_map", &format!("0 {gid} 1\n")) {
        let _ = status_pipe.write_all(format!("0 gid_map: {e}\n").as_bytes());
        std::process::exit(1);
    }
    let flags = libc::CLONE_NEWNS | libc::CLONE_NEWPID | libc::CLONE_NEWIPC;
    if unsafe { libc::unshare(flags) } != 0 {
        let _ = status_pipe.write_all(format!("0 {}\n", last_err("unshare(NS|PID|IPC)")).as_bytes());
        std::process::exit(1);
    }
    if let Err(e) = do_mount("none", "/", "", libc::MS_REC | libc::MS_PRIVATE, "") {
        let _ = status_pipe.write_all(format!("0 make-rprivate: {e}\n").as_bytes());
        std::process::exit(1);
    }

    // --- fork S（pid ns 内 pid 1）：全部装配 ---
    match unsafe { libc::fork() } {
        -1 => {
            let _ = status_pipe.write_all(format!("0 {}\n", last_err("fork 装配")).as_bytes());
            std::process::exit(1);
        }
        0 => {
            // ===== S：装配 + pivot + exec =====
            set_pdeathsig();
            let fail_s = |status_pipe: &mut fs::File, message: &str| -> ! {
                let _ = status_pipe.write_all(format!("0 {message}\n").as_bytes());
                std::process::exit(1);
            };

            // 在自身 userns 内 open /dev/fuse（FUSE 挂载要求 fd 属于挂载者的 userns）
            let mut fuse_fds: Vec<RawFd> = Vec::new();
            let mut fuse_files: Vec<fs::File> = Vec::new();
            for _ in &policy.roots {
                match fs::OpenOptions::new().read(true).write(true).open("/dev/fuse") {
                    Ok(f) => {
                        fuse_fds.push(f.as_raw_fd());
                        fuse_files.push(f);
                    }
                    Err(e) => fail_s(&mut status_pipe, &format!("open /dev/fuse: {e}")),
                }
            }

            let root_str = root_dir.to_str().unwrap();
            // root_dir 先挂 tmpfs：保证它是挂载点（pivot_root 要求），随后
            // 整根 FUSE（virtual="/"）覆盖其上；局部 roots 则挂到子路径
            if let Err(e) = do_mount("tmpfs", root_str, "tmpfs", 0, "size=64m") {
                fail_s(&mut status_pipe, &e);
            }
            if let Err(e) = mount_private(root_dir) {
                fail_s(&mut status_pipe, &e);
            }
            // 整根 FUSE 视图：FUSE 挂到新根（virtual="/" 时镜像宿主 /），
            // 沙箱内布局与宿主完全一致；/home、/tmp、/var 等可写区域走策略检查，
            // 系统目录在其上用只读 bind 覆盖（读性能不走 FUSE）。
            if let Err(e) = mount_roots(&policy, &fuse_fds, root_dir) {
                fail_s(&mut status_pipe, &e);
            }
            // FUSE 挂载完成后立即把 fd 交给 daemon（daemon run 后，后续 FUSE 访问
            // ——bind 系统目录 /proc move 等——才不会被内核请求阻塞等待）
            if let Err(e) = send_fuse_fds(sockets, &fuse_fds) {
                fail_s(&mut status_pipe, &e);
            }
            // 整根视图（virtual="/"）下目标在 FUSE 卷内（=宿主同名目录）已存在；
            // 非整根视图（局部 roots）下 tmpfs 根没有系统目录，先建空目录再 bind。
            // 绝不能在整根视图下 mkdir：会经 FUSE 在宿主根上创建目录。
            let whole_root_view = policy.roots.iter().any(|r| r.virtual_path == "/");
            for dir in RO_BIND_DIRS {
                let name = dir.trim_start_matches('/');
                if Path::new(dir).exists() {
                    let target = root_dir.join(name);
                    if !whole_root_view && !target.exists() {
                        if let Err(e) = mkdir_p(&target) {
                            fail_s(&mut status_pipe, &format!("创建系统目录挂载点 {name}: {e}"));
                        }
                    }
                    if let Err(e) = bind_ro(dir, &target) {
                        fail_s(&mut status_pipe, &e);
                    }
                }
            }
            // 额外只读目录（工具链等）：沙箱内同路径只读可见。
            // 显式要求的目录缺失时 fail-fast（静默跳过会让下游难以排查）
            for dir in ro_dirs {
                let name = dir.trim_start_matches('/');
                if !Path::new(dir).exists() {
                    fail_s(&mut status_pipe, &format!("--ro-dirs 路径不存在: {dir}"));
                }
                let target = root_dir.join(name);
                // 非整根视图（局部 roots）下 tmpfs 根没有该目录：先建目标再 bind；
                // 整根视图下宿主同名目录存在（ro_dirs 均来自宿主实测存在的路径），
                // mkdir_p 幂等跳过，不会经 FUSE 误创建。
                if let Err(e) = mkdir_p(&target) {
                    fail_s(&mut status_pipe, &format!("创建工具链挂载点 {name}: {e}"));
                }
                if let Err(e) = bind_ro(dir, &target) {
                    fail_s(&mut status_pipe, &e);
                }
            }

            // 最小 /dev：tmpfs + bind 常用设备节点（不含 /dev/fuse）。
            // 非整根视图下 tmpfs 根没有 /dev，先创建挂载目标。
            let dev = root_dir.join("dev");
            if let Err(e) = mkdir_p(&dev) {
                fail_s(&mut status_pipe, &e);
            }
            if let Err(e) = do_mount("tmpfs", dev.to_str().unwrap(), "tmpfs", 0, "mode=755") {
                fail_s(&mut status_pipe, &e);
            }
            if let Err(e) = mount_private(&dev) {
                fail_s(&mut status_pipe, &e);
            }
            for node in DEV_BINDS {
                let name = Path::new(node).file_name().and_then(|n| n.to_str()).unwrap_or("");
                if let Err(e) = bind_existing(node, &dev.join(name)) {
                    fail_s(&mut status_pipe, &e);
                }
            }
            if Path::new("/dev/shm").exists() {
                let _ = mkdir_p(&dev.join("shm"));
                let _ = bind_existing("/dev/shm", &dev.join("shm"));
            }
            if Path::new("/dev/pts").exists() {
                let _ = mkdir_p(&dev.join("pts"));
                let _ = bind_existing("/dev/pts", &dev.join("pts"));
            }
            // /dev/fd 与 std* 符号链接：bash 进程替换 <(...) 依赖 /dev/fd/N
            // （解析到 /proc/self/fd/N，proc 为沙箱 pid ns 视图）
            let _ = std::os::unix::fs::symlink("/proc/self/fd", dev.join("fd"));
            let _ = std::os::unix::fs::symlink("/proc/self/fd/0", dev.join("stdin"));
            let _ = std::os::unix::fs::symlink("/proc/self/fd/1", dev.join("stdout"));
            let _ = std::os::unix::fs::symlink("/proc/self/fd/2", dev.join("stderr"));

            // /tmp 与 /run 不再覆盖：经 FUSE 透传宿主目录（/tmp 跨沙箱实例持久，
            // 关闭不丢失；写操作仍经策略检查）

            // /proc：userns 内无法把 proc 挂载到新目录（内核 ns_capable 检查），但可以
            // 在继承的宿主 /proc 挂载点上 mount on top（实测可行）；随后用 move_mount
            // 移到新根，pivot 后沙箱内 /proc 即真实的 hidepid=2 proc（pid ns 视图，
            // /proc/<pid>/root 指向沙箱根而非宿主——避免借宿主演进程 root 逃逸）。
            let proc_mounted = do_mount(
                "proc",
                "/proc",
                "proc",
                libc::MS_NOSUID | libc::MS_NOEXEC | libc::MS_NODEV,
                "hidepid=2",
            )
            .or_else(|_| {
                do_mount(
                    "proc",
                    "/proc",
                    "proc",
                    libc::MS_NOSUID | libc::MS_NOEXEC | libc::MS_NODEV,
                    "",
                )
            });
            if let Err(e) = proc_mounted {
                fail_s(&mut status_pipe, &format!("/proc 挂载失败: {e}"));
            }
            // 移到新根 /proc（move_mount：源为当前挂载点 /proc，目标为新根目录）
            let proc_c = cstr("/proc").unwrap();
            let proc_target = root_dir.join("proc");
            // 非整根视图下 tmpfs 根没有 /proc：先创建 move_mount 目标
            if let Err(e) = mkdir_p(&proc_target) {
                fail_s(&mut status_pipe, &e);
            }
            let proc_target_c = cstr(proc_target.to_str().unwrap()).unwrap();
            if unsafe {
                libc::syscall(
                    libc::SYS_move_mount,
                    libc::AT_FDCWD,
                    proc_c.as_ptr(),
                    libc::AT_FDCWD,
                    proc_target_c.as_ptr(),
                    0u32,
                )
            } != 0
            {
                fail_s(&mut status_pipe, &last_err("move_mount /proc"));
            }
            if let Err(e) = mount_private(&root_dir.join("proc")) {
                fail_s(&mut status_pipe, &e);
            }

            // pivot_root：丢弃宿主根（必须在全部挂载完成后）
            let root_c = cstr(root_str).unwrap();
            let dot = cstr(".").unwrap();
            if unsafe { libc::chdir(root_c.as_ptr()) } != 0 {
                fail_s(&mut status_pipe, &last_err("chdir 新根"));
            }
            if unsafe { libc::syscall(libc::SYS_pivot_root, dot.as_ptr(), dot.as_ptr()) } != 0 {
                fail_s(&mut status_pipe, &last_err("pivot_root"));
            }
            // 摘除旧根：失败则旧根（宿主全部挂载）仍挂在新根上，子进程可经挂载点
            // 逃逸到宿主视图——必须 fail-closed
            if unsafe { libc::umount2(dot.as_ptr(), libc::MNT_DETACH) } != 0 {
                fail_s(&mut status_pipe, &last_err("umount 旧根"));
            }
            if unsafe { libc::chdir(cstr("/").unwrap().as_ptr()) } != 0 {
                fail_s(&mut status_pipe, &last_err("chdir 到新根"));
            }

            // 装配成功，通知管理进程；写后立即关闭写端，使 M 的 read 能读到
            // EOF 并在 shell 运行期间继续（cgroup 登记、响应信号）
            let _ = status_pipe.write_all(b"1\n");
            drop(status_pipe);

            // 收敛权限：从 bounding set 移除关键 cap（exec 后无法恢复）
            unsafe {
                for cap in [
                    CAP_SYS_ADMIN,
                    CAP_SYS_MODULE,
                    CAP_SYS_RAWIO,
                    CAP_MKNOD,
                    CAP_SYS_PTRACE,
                    CAP_NET_ADMIN,
                    CAP_SYS_BOOT,
                    CAP_SYS_TIME,
                    CAP_SETFCAP,
                    CAP_SYS_RESOURCE,
                    CAP_SYS_CHROOT,
                    CAP_IPC_LOCK,
                    CAP_LEASE,
                    CAP_LINUX_IMMUTABLE,
                    CAP_SYS_PACCT,
                    CAP_SYS_TTY_CONFIG,
                ] {
                    libc::prctl(libc::PR_CAPBSET_DROP, cap);
                }
            }
            if let Some(cwd) = cwd {
                let cwd_c = match cstr(cwd) {
                    Ok(c) => c,
                    Err(_) => std::process::exit(1),
                };
                if unsafe { libc::chdir(cwd_c.as_ptr()) } != 0 {
                    eprintln!("沙箱: 无法进入工作目录 {cwd}: {}", std::io::Error::last_os_error());
                    std::process::exit(1);
                }
            }
            // 关闭 FUSE/装配相关 fd（保留 stdin/stdout/stderr）
            unsafe {
                libc::syscall(libc::SYS_close_range, 3, u32::MAX, 0);
            }
            let args: Vec<OsString> = child_argv.iter().map(OsString::from).collect();
            let error = Command::new(&child_argv[0]).args(&args[1..]).exec();
            eprintln!("沙箱: 启动子进程失败: {error}");
            std::process::exit(127);
        }
        shell_pid => {
            // A 不再需要装配状态管道：关闭写端（配合 S 的关闭，M 能读到 EOF）
            drop(status_pipe);
            let mut status: libc::c_int = 0;
            unsafe {
                libc::waitpid(shell_pid, &mut status, 0);
            }
            let code = if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else if libc::WIFSIGNALED(status) {
                128 + libc::WTERMSIG(status)
            } else {
                128
            };
            std::process::exit(code);
        }
    }
}

/// daemon 进程（宿主 namespace）：接收 FUSE fd 后运行一个 FUSE 会话。
/// daemon 直接访问镜像源（宿主路径未被覆盖）。
fn daemon_main(
    socket: RawFd,
    backing: PathBuf,
    virtual_root: String,
    policy: Arc<Policy>,
    del_to_trash: bool,
) {
    set_pdeathsig();
    let mut buf = [0u8; 16];
    let mut iov = [IoSliceMut::new(&mut buf)];
    let mut cmsg_buffer = Vec::with_capacity(64);
    let message = match recvmsg::<SockaddrStorage>(socket, &mut iov, Some(&mut cmsg_buffer), MsgFlags::empty()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("沙箱 daemon: recvmsg 失败: {e}");
            std::process::exit(1);
        }
    };
    let mut fd: Option<RawFd> = None;
    if let Ok(cmsgs) = message.cmsgs() {
        for cmsg in cmsgs {
            if let ControlMessageOwned::ScmRights(fds) = cmsg {
                if let Some(first) = fds.first() {
                    fd = Some(*first);
                }
            }
        }
    }
    let raw = match fd {
        Some(raw) => raw,
        None => {
            eprintln!("沙箱 daemon: 未收到 FUSE fd");
            std::process::exit(1);
        }
    };
    let host_uid = unsafe { libc::getuid() };
    let host_gid = unsafe { libc::getgid() };
    let owned = unsafe { OwnedFd::from_raw_fd(raw) };
    let fs = MirrorFs::new(backing, virtual_root, policy, host_uid, host_gid, del_to_trash);
    // 请求 uid 按挂载 userns（fc->user_ns）表达（ns 内 uid 0 = 宿主用户），与 daemon
    // 在宿主 ns 的 uid 不直接可比，Owner ACL 会误拒所有请求。挂载点位于装配进程
    // 私有 mount ns，只有沙箱内进程可达，采用 All 无暴露面。
    let mut session = fuser::Session::from_fd(fs, owned, fuser::SessionACL::All);
    let _ = session.run();
    std::process::exit(0);
}

/// 运行沙箱（管理进程侧）：编排 daemon / 装配进程 / cgroup / 清理，返回子进程退出码。
fn log_diagnostic(log_file: &Option<String>, message: &str) {
    if let Some(path) = log_file {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let line = format!("[{}] {}\n", chrono_like_now(), message);
            let _ = file.write_all(line.as_bytes());
        }
    }
}

/// 轻量时间戳（无 chrono 依赖）：YYYY-MM-DD HH:MM:SS
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{days}day {h:02}:{m:02}:{s:02}")
}

pub fn run(options: RunOptions) -> Result<i32, String> {
    let child_argv = options.child_argv;
    log_diagnostic(&options.log_file, &format!("run start pid={}", unsafe { libc::getpid() }));
    // 回收上次异常退出残留的孤儿 root_dir（防止 /tmp 垃圾堆积）
    cleanup_stale_root_dirs();
    if child_argv.is_empty() {
        return Err("run 需要 -- 之后的子进程命令行".to_string());
    }
    if !userns_available() {
        return Err("动态沙箱需要非特权 user namespace（当前被内核或 AppArmor 限制）".to_string());
    }
    if !fuse_available() {
        return Err("/dev/fuse 不可用，无法挂载 FUSE 卷".to_string());
    }
    let policy = options.policy;
    if policy.roots.is_empty() {
        return Err("策略需要至少一个 [[roots]] 声明受控路径".to_string());
    }
    // virtual="/" 为整根视图（FUSE 挂到新根），布局与宿主一致——合法且推荐。
    // 启动前校验镜像源存在（fail-fast）：避免挂载空卷后所有 IO 静默 ENOENT
    for root in &policy.roots {
        if !Path::new(&root.real_path).exists() {
            return Err(format!("[[roots]] real 路径不存在: {}", root.real_path));
        }
    }

    std::env::set_var("DYNOBOX_SANDBOX", "1");
    std::env::set_var("SBX_ROOT", policy.roots[0].virtual_path.as_str());

    // 每 root 一对 socket（fd 传递：装配进程 → daemon）。
    // 保持 SockFD 存活，防止 drop 时关闭 fd。
    let mut sockets: Vec<(RawFd, RawFd)> = Vec::new();
    let mut socket_holders: Vec<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)> = Vec::new();
    for _ in &policy.roots {
        match socketpair(AddressFamily::Unix, SockType::Stream, None, SockFlag::empty()) {
            Ok((a, b)) => {
                sockets.push((a.as_raw_fd(), b.as_raw_fd()));
                socket_holders.push((a, b));
            }
            Err(e) => return Err(format!("socketpair: {e}")),
        }
    }

    // 装配状态管道（装配进程 → 管理进程）
    let mut status_pipe: [libc::c_int; 2] = [0; 2];
    unsafe {
        if libc::pipe(status_pipe.as_mut_ptr()) != 0 {
            return Err(last_err("pipe(status)"));
        }
    }

    // ---- fork daemon（每个 root 一个，宿主 namespace）----
    let mut daemon_pids: Vec<libc::pid_t> = Vec::new();
    let daemon_policy = Arc::clone(&policy);
    for (index, root) in policy.roots.iter().enumerate() {
        let backing = PathBuf::from(&root.real_path);
        let virtual_root = root.virtual_path.clone();
        let socket = sockets[index].1;
        let (policy, virtual_root) = (Arc::clone(&daemon_policy), virtual_root);
        let del_to_trash = options.del_to_trash;
        unsafe {
            let pid = libc::fork();
            if pid < 0 {
                // 清理已 fork 的 daemon（它们阻塞在 recvmsg，不会自行退出）
                for already in &daemon_pids {
                    libc::kill(*already, libc::SIGKILL);
                }
                return Err(last_err("fork daemon"));
            }
            if pid == 0 {
                libc::close(status_pipe[0]);
                libc::close(status_pipe[1]);
                daemon_main(socket, backing, virtual_root, policy, del_to_trash);
            }
            daemon_pids.push(pid);
        }
    }

    // ---- fork 装配进程 ----
    let root_dir = PathBuf::from(format!("/tmp/dynobox-root-{}", unsafe { libc::getpid() }));
    if let Err(e) = mkdir_p(&root_dir) {
        for pid in &daemon_pids {
            unsafe { libc::kill(*pid, libc::SIGKILL); }
        }
        return Err(e);
    }
    let assemble_sockets: Vec<RawFd> = sockets.iter().map(|(a, _)| *a).collect();
    let assemble_policy = Arc::clone(&policy);
    let assemble_argv = child_argv.clone();
    let assemble_cwd = options.cwd.clone();
    let assemble_ro_dirs = options.ro_dirs.clone();
    let assemble_root = root_dir.clone();

    let assemble_pid = unsafe { libc::fork() };
    if assemble_pid < 0 {
        for pid in &daemon_pids {
            unsafe { libc::kill(*pid, libc::SIGKILL); }
        }
        let _ = fs::remove_dir_all(&root_dir);
        return Err(last_err("fork 装配进程"));
    }
    // 装配进程已 fork：立即登记 cgroup。必须在装配进程 fork shell（S）之前完成——
    // A 还需两次 unshare 与 uid_map 写入（远慢于本调用）；cgroup v2 把进程移入
    // cgroup 不带动其已 fork 的子进程，登记晚了则 S 及 shell 后代不在 cgroup 内，
    // cgroup.kill 兜底对进程树失效（pid ns + pdeathsig 仍为主保障，cgroup 为第三保险）。
    let cgroup = cgroup_setup(assemble_pid);
    if assemble_pid == 0 {
        unsafe {
            libc::close(status_pipe[0]);
        }
        let status_file = unsafe { fs::File::from_raw_fd(status_pipe[1]) };
        assemble(
            &assemble_sockets,
            &assemble_policy,
            &assemble_root,
            assemble_cwd.as_deref(),
            &assemble_ro_dirs,
            &assemble_argv,
            status_file,
        );
    }

    // ---- 管理进程：读装配结果 ----
    unsafe {
        libc::close(status_pipe[1]);
    }
    let mut status_reader = unsafe { fs::File::from_raw_fd(status_pipe[0]) };
    let mut status_line = String::new();
    let _ = status_reader.read_to_string(&mut status_line);
    if !status_line.starts_with('1') {
        let message = status_line.trim_start_matches('0').trim().to_string();
        let error = if message.is_empty() {
            "沙箱装配失败".to_string()
        } else {
            message.clone()
        };
        log_diagnostic(&options.log_file, &format!("assemble failed: {error}"));
        unsafe {
            libc::kill(assemble_pid, libc::SIGKILL);
        }
        for pid in &daemon_pids {
            unsafe { libc::kill(*pid, libc::SIGKILL); }
        }
        if let Some(dir) = &cgroup {
            cgroup_kill_and_remove(dir);
        }
        let _ = fs::remove_dir_all(&root_dir);
        return Err(error);
    }

    // ---- 等待 shell（装配进程）退出 ----
    let mut status: libc::c_int = 0;
    unsafe {
        libc::waitpid(assemble_pid, &mut status, 0);
    }
    let exit_code = if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    };
    log_diagnostic(&options.log_file, &format!("run exit code={exit_code}"));

    // ---- 清理 ----
    for pid in &daemon_pids {
        unsafe {
            libc::kill(*pid, libc::SIGKILL);
        }
    }
    for pid in &daemon_pids {
        unsafe {
            libc::waitpid(*pid, std::ptr::null_mut(), 0);
        }
    }
    if let Some(cgroup) = cgroup {
        cgroup_kill_and_remove(&cgroup);
    }
    let _ = fs::remove_dir_all(&root_dir);
    Ok(exit_code)
}