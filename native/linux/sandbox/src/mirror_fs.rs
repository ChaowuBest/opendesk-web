/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

//! FUSE 镜像文件系统：把真实目录镜像为一个 FUSE 卷，每次"打开"（open/create/
//! mkdir/rename/unlink/opendir 等）都经过策略引擎判定；判定位于内核 VFS 必经
//! 路径，子进程无法绕过（与 Windows Dokan 方案同理）。
//! 透明路径：卷内相对路径还原为宿主绝对路径后按策略匹配，挂载点与宿主同名路径一致。

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{FileExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use libc::{EACCES, EBADF, EIO, EINVAL, ENOENT, ENOSYS, EPERM};
use fuser::{FileAttr, FileType, Filesystem, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request};

use crate::policy::{Policy, ACC_READ, ACC_WRITE};

// 缓存策略（无需用户配置）：
// - entry_timeout=0：dentry/negative 缓存关闭——保证"创建后立即读"一致
//   （git 的 lock+rename 密集写入、cargo 产物放置等短周期场景不会命中 negative 缓存）；
// - attr_timeout=1s：文件属性缓存——stat/fstat 走内核缓存，性能回升约 25%+。
const ENTRY_TTL: Duration = Duration::from_secs(0);
const ATTR_TTL: Duration = Duration::from_secs(1);

/// ino ↔ 卷内相对路径映射（单锁保护：alloc_ino 的 check-then-act 必须原子，
/// 否则并发 lookup/readdir 会给同一路径分配不同 ino，导致内核 inode 错乱）。
struct InoMap {
    by_ino: HashMap<u64, PathBuf>,
    by_path: HashMap<PathBuf, u64>,
}

impl InoMap {
    fn new() -> InoMap {
        let mut map = InoMap {
            by_ino: HashMap::new(),
            by_path: HashMap::new(),
        };
        map.by_ino.insert(1, PathBuf::new());
        map.by_path.insert(PathBuf::new(), 1);
        map
    }

    fn get_path(&self, ino: u64) -> Option<&PathBuf> {
        self.by_ino.get(&ino)
    }

    /// 分配/复用 ino（原子：同一路径始终同一 ino）
    fn alloc(&mut self, inner: PathBuf, next: &AtomicU64) -> u64 {
        if let Some(ino) = self.by_path.get(&inner) {
            return *ino;
        }
        let ino = next.fetch_add(1, Ordering::Relaxed);
        self.by_ino.insert(ino, inner.clone());
        self.by_path.insert(inner, ino);
        ino
    }
}

/// 打开的目录句柄：记录父目录 inner 路径，readdir 用 parent.join(name) 分配 ino，
/// 与 lookup 的路径拼接保持一致（否则子目录条目会映射到错误的根级路径）。
struct DirHandle {
    parent: PathBuf,
    entries: Vec<(String, FileType)>,
}

pub struct MirrorFs {
    /// 真实镜像根（管理进程宿主 namespace 直接访问）
    backing: PathBuf,
    /// 宿主 uid/gid（用于 attr 映射：FUSE attr 的 uid/gid 在挂载 userns 中解释，
    /// 宿主用户 kuid 需映射为 ns 内 uid 0，否则显示 nobody 导致权限不匹配）
    host_uid: u32,
    host_gid: u32,
    /// 挂载点路径（策略匹配前缀，透明路径下等于宿主同名路径）
    virtual_root: String,
    policy: Arc<Policy>,
    ino_map: Mutex<InoMap>,
    next_ino: AtomicU64,
    /// 打开的文件句柄（Arc<File>：读/写在取锁后执行，避免全局写串行化）
    files: Mutex<HashMap<u64, Arc<File>>>,
    dirs: Mutex<HashMap<u64, DirHandle>>,
    next_fh: AtomicU64,
    /// 删除送回收站（XDG Trash）：unlink/rmdir 改写为移动到 trash 目录
    del_to_trash: bool,
    /// XDG Trash 根（daemon 宿主 namespace 视角，如 ~/.local/share/Trash）
    trash_dir: PathBuf,
}

impl MirrorFs {
    pub fn new(
        backing: PathBuf,
        virtual_root: String,
        policy: Arc<Policy>,
        host_uid: u32,
        host_gid: u32,
        del_to_trash: bool,
    ) -> MirrorFs {
        // XDG Trash（~/.local/share/Trash）：与家目录文件同文件系统（rename 语义），
        // /tmp 等异盘文件跨 fs 时保留原文件（fail-closed，见 move_to_trash）
        let trash_dir = std::env::var("HOME")
            .map(|home| PathBuf::from(home).join(".local/share/Trash"))
            .unwrap_or_else(|_| PathBuf::from("/tmp/.dynobox-trash"));
        if del_to_trash {
            let _ = fs::create_dir_all(trash_dir.join("files"));
            let _ = fs::create_dir_all(trash_dir.join("info"));
        }
        MirrorFs {
            backing,
            host_uid,
            host_gid,
            virtual_root,
            policy,
            ino_map: Mutex::new(InoMap::new()),
            next_ino: AtomicU64::new(2),
            files: Mutex::new(HashMap::new()),
            dirs: Mutex::new(HashMap::new()),
            next_fh: AtomicU64::new(1),
            del_to_trash,
            trash_dir,
        }
    }

    fn real(&self, inner: &Path) -> PathBuf {
        self.backing.join(inner)
    }

    /// 卷内相对路径 → 策略匹配用的宿主绝对路径（透明路径）
    fn policy_path(&self, inner: &Path) -> String {
        if inner.as_os_str().is_empty() {
            self.virtual_root.clone()
        } else if self.virtual_root == "/" {
            format!("/{}", inner.display())
        } else {
            format!("{}/{}", self.virtual_root, inner.display())
        }
    }

    /// 策略判定：deny 返回 true（fail-closed）
    fn deny(&self, inner: &Path, access: u8) -> bool {
        !self.policy.check(&self.policy_path(inner), access)
    }

    fn alloc_ino(&self, inner: PathBuf) -> u64 {
        self.ino_map.lock().unwrap().alloc(inner, &self.next_ino)
    }

    fn lookup_path(&self, parent: u64, name: &std::ffi::OsStr) -> Option<PathBuf> {
        let name_str = name.to_str()?;
        if name_str.is_empty()
            || name_str == "."
            || name_str == ".."
            || name_str.contains('/')
            || name_str.contains('\0')
        {
            return None;
        }
        let parent_path = self.ino_map.lock().unwrap().get_path(parent)?.clone();
        Some(parent_path.join(name_str))
    }

    fn attr(&self, ino: u64, meta: &fs::Metadata) -> FileAttr {
        let mode = meta.mode();
        let kind = match () {
            _ if meta.file_type().is_dir() => FileType::Directory,
            _ if meta.file_type().is_symlink() => FileType::Symlink,
            _ if meta.file_type().is_block_device() => FileType::BlockDevice,
            _ if meta.file_type().is_char_device() => FileType::CharDevice,
            _ if meta.file_type().is_fifo() => FileType::NamedPipe,
            _ if meta.file_type().is_socket() => FileType::Socket,
            _ => FileType::RegularFile,
        };
        FileAttr {
            ino,
            size: meta.len(),
            blocks: meta.blocks(),
            atime: meta.accessed().unwrap_or(SystemTime::UNIX_EPOCH),
            mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ctime: meta.created().unwrap_or(SystemTime::UNIX_EPOCH),
            crtime: meta.created().unwrap_or(SystemTime::UNIX_EPOCH),
            kind,
            // 单映射 userns（0→宿主用户）无法表达其他宿主 uid：attr 的 uid/gid 若
            // 不是 ns 内有效值，内核 make_kuid 会返回无效 kuid，权限检查拒绝一切
            // 访问。因此 uid/gid 统一映射为宿主用户（ns 内唯一有效 uid 0）：
            // - 宿主属主文件：暴露真实权限位（owner=沙箱进程，语义与宿主一致）；
            // - 非宿主属主（root/系统用户）：只暴露 other 权限位，模拟"其他用户"
            //   视角，防止 root 私有文件（600/640）被沙箱进程以属主身份读到。
            perm: if meta.uid() == self.host_uid {
                (mode & 0o7777) as u16
            } else {
                (mode & 0o7) as u16
            },
            nlink: meta.nlink() as u32,
            uid: 0,
            gid: 0,
            rdev: meta.rdev() as u32,
            blksize: meta.blksize() as u32,
            flags: 0,
        }
    }

    /// 把文件/目录移入回收站（XDG Trash）：rename 到 files/ + 写 info/*.trashinfo。
    /// 返回 Ok(true)=已移入回收站，Ok(false)=未开启回收站；Err=跨文件系统/其他失败
    /// （保留原文件，调用方按删除失败处理，fail-closed）。
    fn move_to_trash(&self, inner: &Path, is_dir: bool) -> Result<bool, String> {
        if !self.del_to_trash {
            return Ok(false);
        }
        let real = self.real(inner);
        let file_name = inner
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("trash");
        // 冲突时追加序号（files/ 下已有同名则 + .N）
        let mut name = file_name.to_string();
        let mut counter = 1;
        while self.trash_dir.join("files").join(&name).exists() {
            name = format!("{file_name}.{counter}");
            counter += 1;
        }
        let target = self.trash_dir.join("files").join(&name);
        if let Err(e) = fs::rename(&real, &target) {
            // 跨文件系统（EXDEV）或权限失败：保留原文件，不静默删除
            return Err(format!("移入回收站失败（文件保留）: {e}"));
        }
        // XDG Trash info：Path 为删除时的相对路径，DeletionDate 为 ISO 时间
        let info_path = self.trash_dir.join("info").join(format!("{name}.trashinfo"));
        // DeletionDate 用本地时间（XDG 规范）：daemon 在宿主 ns，可执行 date 取
        // 本地时区；失败时回退 UTC（civil_time）
        let local = std::process::Command::new("/bin/date")
            .args(["+%Y-%m-%dT%H:%M:%S"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() >= 19);
        let date_value = match local {
            Some(s) => s,
            None => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default();
                let (y, m, d, hh, mm, ss) = Self::civil_time(now.as_secs() as i64);
                format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}")
            }
        };
        let path_value = inner.display().to_string();
        let _ = fs::write(
            &info_path,
            format!("[Trash Info]\nPath={path_value}\nDeletionDate={date_value}\n"),
        );
        let _ = is_dir;
        Ok(true)
    }

    /// 秒数 → (年,月,日,时,分,秒)（Howard Hinnant civil_from_days 算法，无 chrono）
    fn civil_time(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
        let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
        let z = days + 719468;
        let era = if z >= 0 { z } else { z - 146096 } / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = if m <= 2 { y + 1 } else { y };
        (
            year,
            m as u32,
            d as u32,
            (rem / 3600) as u32,
            ((rem % 3600) / 60) as u32,
            (rem % 60) as u32,
        )
    }

    /// 构造 attr（含 execute 策略 x 位掩码）后回复
    fn reply_attr_checked(&self, reply: ReplyAttr, inner: &Path, meta: &fs::Metadata) {
        let ino = self.alloc_ino(inner.to_path_buf());
        reply.attr(&ATTR_TTL, &self.attr_checked(ino, inner, meta));
    }

    /// 构造 attr：execute 策略拒绝执行时掩去 x 位（子进程 exec 会得到 EACCES）
    fn attr_checked(&self, ino: u64, inner: &Path, meta: &fs::Metadata) -> FileAttr {
        let mut attr = self.attr(ino, meta);
        if !self.policy.check_exec(&self.policy_path(inner)) {
            attr.perm &= !(0o111u16);
        }
        attr
    }
}

fn open_flags_access(flags: i32) -> u8 {
    match flags & libc::O_ACCMODE {
        libc::O_WRONLY => ACC_WRITE,
        libc::O_RDWR => ACC_READ | ACC_WRITE,
        _ => ACC_READ,
    }
}

fn errno_of(error: &std::io::Error) -> i32 {
    error.raw_os_error().unwrap_or(EIO)
}

impl Filesystem for MirrorFs {
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &std::ffi::OsStr, reply: ReplyEntry) {
        let inner = match self.lookup_path(parent, name) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        let real = self.real(&inner);
        match fs::symlink_metadata(&real) {
            Ok(meta) => {
                let ino = self.alloc_ino(inner.clone());
                reply.entry_ex(&ENTRY_TTL, &ATTR_TTL, &self.attr_checked(ino, &inner, &meta), 0);
            }
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, fh: Option<u64>, reply: ReplyAttr) {
        let inner = match self.ino_map.lock().unwrap().get_path(ino).cloned() {
            Some(p) => p,
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        let result = match fh {
            Some(fh) => match self.files.lock().unwrap().get(&fh).cloned() {
                Some(file) => file.metadata(),
                None => Err(std::io::Error::from_raw_os_error(EBADF)),
            },
            None => fs::symlink_metadata(self.real(&inner)),
        };
        match result {
            Ok(meta) => self.reply_attr_checked(reply, &inner, &meta),
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn readlink(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyData) {
        let inner = match self.ino_map.lock().unwrap().get_path(ino).cloned() {
            Some(p) => p,
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        if self.deny(&inner, ACC_READ) {
            reply.error(EACCES);
            return;
        }
        match fs::read_link(self.real(&inner)) {
            Ok(target) => reply.data(target.as_os_str().as_encoded_bytes()),
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn mkdir(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &std::ffi::OsStr,
        mode: u32,
        umask: u32,
        reply: ReplyEntry,
    ) {
        let inner = match self.lookup_path(parent, name) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        if self.deny(&inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        match fs::create_dir(self.real(&inner)) {
            Ok(()) => {
                fs::set_permissions(
                    self.real(&inner),
                    fs::Permissions::from_mode((mode & !umask) & 0o7777),
                )
                .ok();
                match fs::symlink_metadata(self.real(&inner)) {
                    Ok(meta) => {
                        let ino = self.alloc_ino(inner);
                        reply.entry_ex(&ENTRY_TTL, &ATTR_TTL, &self.attr(ino, &meta), 0);
                    }
                    Err(e) => reply.error(errno_of(&e)),
                }
            }
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn unlink(&mut self, _req: &Request<'_>, parent: u64, name: &std::ffi::OsStr, reply: ReplyEmpty) {
        let inner = match self.lookup_path(parent, name) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        if self.deny(&inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        match self.move_to_trash(&inner, false) {
            Ok(true) => reply.ok(), // 已移入回收站
            Ok(false) => match fs::remove_file(self.real(&inner)) {
                Ok(()) => reply.ok(),
                Err(e) => reply.error(errno_of(&e)),
            },
            Err(e) => {
                eprintln!("沙箱 unlink: {e}");
                reply.error(EIO);
            }
        }
    }

    fn rmdir(&mut self, _req: &Request<'_>, parent: u64, name: &std::ffi::OsStr, reply: ReplyEmpty) {
        let inner = match self.lookup_path(parent, name) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        if self.deny(&inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        match self.move_to_trash(&inner, true) {
            Ok(true) => reply.ok(),
            Ok(false) => match fs::remove_dir(self.real(&inner)) {
                Ok(()) => reply.ok(),
                Err(e) => reply.error(errno_of(&e)),
            },
            Err(e) => {
                eprintln!("沙箱 rmdir: {e}");
                reply.error(EIO);
            }
        }
    }

    fn symlink(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &std::ffi::OsStr,
        link: &Path,
        reply: ReplyEntry,
    ) {
        let inner = match self.lookup_path(parent, name) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        if self.deny(&inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        match std::os::unix::fs::symlink(link, self.real(&inner)) {
            Ok(()) => match fs::symlink_metadata(self.real(&inner)) {
                Ok(meta) => {
                    let ino = self.alloc_ino(inner);
                    reply.entry_ex(&ENTRY_TTL, &ATTR_TTL, &self.attr(ino, &meta), 0);
                }
                Err(e) => reply.error(errno_of(&e)),
            },
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn rename(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &std::ffi::OsStr,
        newparent: u64,
        newname: &std::ffi::OsStr,
        _flags: u32,
        reply: ReplyEmpty,
    ) {
        let old_inner = match self.lookup_path(parent, name) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        let new_inner = match self.lookup_path(newparent, newname) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        // 改名/移动视为对相关路径的 write，两个目标都要通过
        if self.deny(&old_inner, ACC_WRITE) || self.deny(&new_inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        match fs::rename(self.real(&old_inner), self.real(&new_inner)) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    /// mknod：FIFO（mkfifo）与普通文件；设备/套接字节点需要宿主演特权，拒绝
    fn mknod(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &std::ffi::OsStr,
        mode: u32,
        umask: u32,
        _rdev: u32,
        reply: ReplyEntry,
    ) {
        let inner = match self.lookup_path(parent, name) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        if self.deny(&inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        let real = self.real(&inner);
        let result = match mode & libc::S_IFMT {
            libc::S_IFIFO => {
                let cpath = match std::ffi::CString::new(real.as_os_str().as_encoded_bytes()) {
                    Ok(c) => c,
                    Err(_) => {
                        reply.error(EINVAL);
                        return;
                    }
                };
                let created = unsafe { libc::mkfifo(cpath.as_ptr(), (mode & !(umask as u32)) & 0o7777) } == 0;
                created
            }
            // Unix socket 文件（AF_UNIX bind 经 FUSE mknod 创建）：无需特权（同 FIFO）
            libc::S_IFSOCK => {
                let cpath = match std::ffi::CString::new(real.as_os_str().as_encoded_bytes()) {
                    Ok(c) => c,
                    Err(_) => {
                        reply.error(EINVAL);
                        return;
                    }
                };
                let created = unsafe {
                    libc::mknod(cpath.as_ptr(), libc::S_IFSOCK | ((mode & !(umask as u32)) & 0o7777), 0)
                } == 0;
                created
            }
            libc::S_IFREG => {
                use std::os::unix::fs::OpenOptionsExt;
                match OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .mode((mode & !(umask as u32)) & 0o7777)
                    .open(&real)
                {
                    Ok(_) => true,
                    Err(_) => false,
                }
            }
            // 字符/块设备节点：daemon 无宿主 root 特权，拒绝（fail-closed）
            _ => {
                reply.error(EPERM);
                return;
            }
        };
        if !result {
            reply.error(errno_of(&std::io::Error::last_os_error()));
            return;
        }
        match fs::symlink_metadata(&real) {
            Ok(meta) => {
                let ino = self.alloc_ino(inner);
                reply.entry_ex(&ENTRY_TTL, &ATTR_TTL, &self.attr(ino, &meta), 0);
            }
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    /// 硬链接（linkat）：编译工具（cargo 放置最终产物等）依赖硬链接，
    /// FUSE 未实现 link 回调时返回 ENOSYS，产物会静默缺失。
    fn link(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        newparent: u64,
        newname: &std::ffi::OsStr,
        reply: ReplyEntry,
    ) {
        let new_inner = match self.lookup_path(newparent, newname) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        if self.deny(&new_inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        let old_inner = match self.ino_map.lock().unwrap().get_path(ino).cloned() {
            Some(p) => p,
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        let old_real = self.real(&old_inner);
        match fs::hard_link(&old_real, self.real(&new_inner)) {
            Ok(()) => match fs::symlink_metadata(&old_real) {
                Ok(meta) => {
                    let new_ino = self.alloc_ino(new_inner);
                    reply.entry_ex(&ENTRY_TTL, &ATTR_TTL, &self.attr(new_ino, &meta), 0);
                }
                Err(e) => reply.error(errno_of(&e)),
            },
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn open(&mut self, _req: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        let inner = match self.ino_map.lock().unwrap().get_path(ino).cloned() {
            Some(p) => p,
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        if self.deny(&inner, open_flags_access(flags)) {
            reply.error(EACCES);
            return;
        }
        let real = self.real(&inner);
        let mut opts = OpenOptions::new();
        let access = flags & libc::O_ACCMODE;
        opts.read(access != libc::O_WRONLY)
            .write(access != libc::O_RDONLY)
            .truncate(flags & libc::O_TRUNC != 0);
        // 注意：不设置 O_APPEND——追加语义已由内核在 VFS 层处理（FUSE write 请求
        // 的 offset 即 EOF），若 fd 带 O_APPEND，pwrite 会被强制追加到全局 EOF、
        // 与内核期望的 offset 不一致，并发追加时数据错乱。
        match opts.open(&real) {
            Ok(file) => {
                let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
                self.files.lock().unwrap().insert(fh, Arc::new(file));
                reply.opened(fh, 0);
            }
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn read(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyData,
    ) {
        let file = match self.files.lock().unwrap().get(&fh).cloned() {
            Some(f) => f,
            None => {
                reply.error(EBADF);
                return;
            }
        };
        let mut buf = vec![0u8; size as usize];
        match file.read_at(&mut buf, offset as u64) {
            Ok(n) => {
                buf.truncate(n);
                reply.data(&buf);
            }
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn write(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        offset: i64,
        data: &[u8],
        _write_flags: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyWrite,
    ) {
        let file = match self.files.lock().unwrap().get(&fh).cloned() {
            Some(f) => f,
            None => {
                reply.error(EBADF);
                return;
            }
        };
        match file.write_at(data, offset as u64) {
            Ok(n) => reply.written(n as u32),
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn release(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        _flags: i32,
        _lock_owner: Option<u64>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        self.files.lock().unwrap().remove(&fh);
        reply.ok();
    }

    fn opendir(&mut self, _req: &Request<'_>, ino: u64, _flags: i32, reply: ReplyOpen) {
        let inner = match self.ino_map.lock().unwrap().get_path(ino).cloned() {
            Some(p) => p,
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        if self.deny(&inner, ACC_READ) {
            reply.error(EACCES);
            return;
        }
        let real = self.real(&inner);
        let entries: Vec<(String, FileType)> = match fs::read_dir(&real) {
            Ok(iter) => iter
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    let name = entry.file_name().to_str()?.to_string();
                    let ft = entry.file_type().ok()?;
                    let kind = if ft.is_dir() {
                        FileType::Directory
                    } else if ft.is_symlink() {
                        FileType::Symlink
                    } else if ft.is_block_device() {
                        FileType::BlockDevice
                    } else if ft.is_char_device() {
                        FileType::CharDevice
                    } else if ft.is_fifo() {
                        FileType::NamedPipe
                    } else if ft.is_socket() {
                        FileType::Socket
                    } else {
                        FileType::RegularFile
                    };
                    Some((name, kind))
                })
                .collect(),
            Err(e) => {
                reply.error(errno_of(&e));
                return;
            }
        };
        let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
        self.dirs
            .lock()
            .unwrap()
            .insert(fh, DirHandle { parent: inner, entries });
        reply.opened(fh, 0);
    }

    fn readdir(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        let (parent, entries) = {
            let guard = self.dirs.lock().unwrap();
            match guard.get(&fh) {
                Some(handle) => (handle.parent.clone(), handle.entries.clone()),
                None => {
                    reply.error(EBADF);
                    return;
                }
            }
        };
        // fuser 的 add() 返回 true 表示缓冲区已满（需停止填充）；满时也要 ok()
        // 发送已填充部分，内核会用 offset 续传。
        if offset == 0 {
            if reply.add(1, 1, FileType::Directory, ".") {
                reply.ok();
                return;
            }
            if reply.add(1, 2, FileType::Directory, "..") {
                reply.ok();
                return;
            }
        }
        let mut index = (offset.max(2) - 2) as usize;
        while index < entries.len() {
            let (name, kind) = &entries[index];
            // 与 lookup 保持一致：ino 分配用 parent.join(name) 的完整相对路径，
            // 否则子目录条目会映射到根级路径（同一文件不同 ino，内核错乱）
            let ino = self.alloc_ino(parent.join(name));
            let next = (index + 2 + 1) as i64;
            if reply.add(ino, next, *kind, name) {
                break;
            }
            index += 1;
        }
        // 必须显式发送：fuser 的 Reply drop 未发送时自动回 EIO
        reply.ok();
    }

    fn releasedir(&mut self, _req: &Request<'_>, _ino: u64, fh: u64, _flags: i32, reply: ReplyEmpty) {
        self.dirs.lock().unwrap().remove(&fh);
        reply.ok();
    }

    fn statfs(&mut self, _req: &Request<'_>, _ino: u64, reply: ReplyStatfs) {
        let mut vfs: libc::statvfs = unsafe { std::mem::zeroed() };
        let cpath = match std::ffi::CString::new(self.backing.as_os_str().as_encoded_bytes()) {
            Ok(c) => c,
            Err(_) => {
                reply.error(EINVAL);
                return;
            }
        };
        if unsafe { libc::statvfs(cpath.as_ptr(), &mut vfs) } != 0 {
            reply.error(EIO);
            return;
        }
        reply.statfs(
            vfs.f_blocks,
            vfs.f_bfree,
            vfs.f_bavail,
            vfs.f_files,
            vfs.f_ffree,
            vfs.f_bsize as u32,
            vfs.f_namemax as u32,
            vfs.f_frsize as u32,
        );
    }

    fn setattr(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<fuser::TimeOrNow>,
        mtime: Option<fuser::TimeOrNow>,
        _ctime: Option<SystemTime>,
        fh: Option<u64>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<u32>,
        reply: ReplyAttr,
    ) {
        let inner = match self.ino_map.lock().unwrap().get_path(ino).cloned() {
            Some(p) => p,
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        if self.deny(&inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        let real = self.real(&inner);
        if let Some(size) = size {
            let set_result = match fh {
                Some(fh) => match self.files.lock().unwrap().get(&fh).cloned() {
                    Some(file) => file.set_len(size),
                    None => Err(std::io::Error::from_raw_os_error(EBADF)),
                },
                None => OpenOptions::new().write(true).open(&real).and_then(|f| f.set_len(size)),
            };
            if let Err(e) = set_result {
                reply.error(errno_of(&e));
                return;
            }
        }
        if let Some(mode) = mode {
            if let Err(e) = fs::set_permissions(&real, fs::Permissions::from_mode(mode & 0o7777)) {
                reply.error(errno_of(&e));
                return;
            }
        }
        if uid.is_some() || gid.is_some() {
            // ns 内 uid 0 映射宿主用户；其他 uid（无人区/无映射）拒绝
            let host_uid = uid.map(|u| if u == 0 { self.host_uid } else { u32::MAX });
            let host_gid = gid.map(|g| if g == 0 { self.host_gid } else { u32::MAX });
            if host_uid == Some(u32::MAX) || host_gid == Some(u32::MAX) {
                reply.error(EPERM);
                return;
            }
            if let Err(e) = std::os::unix::fs::chown(&real, host_uid, host_gid) {
                reply.error(errno_of(&e));
                return;
            }
        }
        if atime.is_some() || mtime.is_some() {
            let times = [
                atime.map(|t| match t {
                    fuser::TimeOrNow::SpecificTime(t) => {
                        let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
                        libc::timespec {
                            tv_sec: d.as_secs() as libc::time_t,
                            tv_nsec: d.subsec_nanos() as libc::c_long,
                        }
                    }
                    fuser::TimeOrNow::Now => libc::timespec {
                        tv_sec: 0,
                        tv_nsec: libc::UTIME_NOW,
                    },
                })
                .unwrap_or(libc::timespec {
                    tv_sec: 0,
                    tv_nsec: libc::UTIME_OMIT,
                }),
                mtime.map(|t| match t {
                    fuser::TimeOrNow::SpecificTime(t) => {
                        let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
                        libc::timespec {
                            tv_sec: d.as_secs() as libc::time_t,
                            tv_nsec: d.subsec_nanos() as libc::c_long,
                        }
                    }
                    fuser::TimeOrNow::Now => libc::timespec {
                        tv_sec: 0,
                        tv_nsec: libc::UTIME_NOW,
                    },
                })
                .unwrap_or(libc::timespec {
                    tv_sec: 0,
                    tv_nsec: libc::UTIME_OMIT,
                }),
            ];
            let cpath = match std::ffi::CString::new(real.as_os_str().as_encoded_bytes()) {
                Ok(c) => c,
                Err(_) => {
                    reply.error(EINVAL);
                    return;
                }
            };
            if unsafe { libc::utimensat(libc::AT_FDCWD, cpath.as_ptr(), times.as_ptr(), 0) } != 0 {
                let e = std::io::Error::last_os_error();
                reply.error(errno_of(&e));
                return;
            }
        }
        match fs::symlink_metadata(&real) {
            Ok(meta) => self.reply_attr_checked(reply, &inner, &meta),
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn create(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &std::ffi::OsStr,
        mode: u32,
        umask: u32,
        flags: i32,
        reply: ReplyCreate,
    ) {
        let inner = match self.lookup_path(parent, name) {
            Some(p) => p,
            None => {
                reply.error(EINVAL);
                return;
            }
        };
        if self.deny(&inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
        let real = self.real(&inner);
        let mut opts = OpenOptions::new();
        opts.create(true)
            .write(true)
            .read(flags & libc::O_ACCMODE == libc::O_RDWR)
            .truncate(flags & libc::O_TRUNC != 0)
            .mode((mode & !umask) & 0o7777);
        match opts.open(&real) {
            Ok(file) => {
                let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
                self.files.lock().unwrap().insert(fh, Arc::new(file));
                match fs::symlink_metadata(&real) {
                    Ok(meta) => {
                        let ino = self.alloc_ino(inner);
                        reply.created_ex(&ENTRY_TTL, &ATTR_TTL, &self.attr(ino, &meta), 0, fh, 0);
                    }
                    Err(e) => {
                        self.files.lock().unwrap().remove(&fh);
                        reply.error(errno_of(&e));
                    }
                }
            }
            Err(e) => reply.error(errno_of(&e)),
        }
    }

    fn flush(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _lock_owner: u64, reply: ReplyEmpty) {
        reply.ok();
    }

    fn fsync(&mut self, _req: &Request<'_>, _ino: u64, fh: u64, _datasync: bool, reply: ReplyEmpty) {
        match self.files.lock().unwrap().get(&fh).cloned() {
            Some(file) => match file.sync_all() {
                Ok(()) => reply.ok(),
                Err(e) => reply.error(errno_of(&e)),
            },
            None => reply.error(EBADF),
        }
    }

    fn access(&mut self, _req: &Request<'_>, _ino: u64, _mask: i32, reply: ReplyEmpty) {
        reply.error(ENOSYS);
    }

    fn lseek(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        _fh: u64,
        _offset: i64,
        _whence: i32,
        reply: fuser::ReplyLseek,
    ) {
        reply.error(ENOSYS);
    }
}

