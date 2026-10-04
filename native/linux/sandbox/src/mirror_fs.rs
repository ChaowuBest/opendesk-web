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
/// entries 用 Arc 共享：大目录多页 readdir 不再逐页克隆整个条目列表。
struct DirHandle {
    parent: PathBuf,
    entries: Arc<Vec<(String, FileType)>>,
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
        trash_dir_override: String,
    ) -> MirrorFs {
        // OpenDesk 统一回收站目录（<opendesk>/trash/<taskId>，宿主经 --trash-dir
        // 传入）；未传入时退回 XDG Trash（~/.local/share/Trash）。两者都与家目录
        // 文件同文件系统（rename 语义），/tmp 等异盘文件跨 fs 时保留原文件
        // （fail-closed，见 move_to_trash）
        let trash_dir = if !trash_dir_override.is_empty() {
            PathBuf::from(trash_dir_override)
        } else {
            std::env::var("HOME")
                .map(|home| PathBuf::from(home).join(".local/share/Trash"))
                .unwrap_or_else(|_| PathBuf::from("/tmp/.dynobox-trash"))
        };
        if del_to_trash {
            let _ = fs::create_dir_all(&trash_dir);
            // daemon umask 已清零（见 daemon_main）：回收站属用户私有数据，
            // 显式收紧为 0700，防首次创建时权限落入 0777
            let _ = fs::set_permissions(&trash_dir, fs::Permissions::from_mode(0o700));
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
            // ctime 是 inode change time（st_ctim，chmod/chown/rename 时更新），
            // 不是 birth time——created() 返回的 btime 语义不同，误用会让沙箱内
            // stat 与宿主不一致（make/rsync 等依赖 ctime 判断元数据变更）
            ctime: system_time_from(meta.ctime(), meta.ctime_nsec()),
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

    /// 把文件/目录移入 OpenDesk 统一回收站：rename 到 `<trash>/<uuid>.back` +
    /// 追加 `summary.json` 记录（uuid/原始路径/大小/删除时间，供宿主 GUI 搜索
    /// 与找回）。返回 Ok(true)=已移入回收站，Ok(false)=未开启回收站；
    /// Err=跨文件系统/其他失败（保留原文件，调用方按删除失败处理，fail-closed）。
    fn move_to_trash(&self, inner: &Path, is_dir: bool) -> Result<bool, String> {
        if !self.del_to_trash {
            return Ok(false);
        }
        let real = self.real(inner);
        // 大小必须在 rename 前取（目录记 0；symlink 记 0，目标内容不随删丢失）
        let size_bytes = match fs::symlink_metadata(&real) {
            Ok(meta) if !meta.is_dir() => meta.len(),
            _ => 0,
        };
        let uuid = Self::generate_uuid_v4();
        let target = self.trash_dir.join(format!("{uuid}.back"));
        if let Err(e) = fs::rename(&real, &target) {
            // 跨文件系统（EXDEV）或权限失败：保留原文件，不静默删除
            return Err(format!("移入回收站失败（文件保留）: {e}"));
        }
        // 原始路径：宿主绝对路径（透明路径，与策略匹配同视角），GUI 找回时按
        // 该路径恢复
        let original_path = self.policy_path(inner);
        let deleted_at = Self::iso_utc_now();
        if let Err(e) = Self::append_summary_entry(&self.trash_dir, &uuid, &original_path, size_bytes, &deleted_at) {
            // 记录失败不回滚移动（文件已在回收站，仅缺索引）：留下诊断日志
            eprintln!("沙箱 daemon: summary.json 记录失败: {e}");
        }
        let _ = is_dir;
        Ok(true)
    }

    /// 生成随机 UUID v4（/dev/urandom → RFC 4122 小写连字符格式）。
    /// 失败时退化为时间+pid 拼接的伪随机串（保留唯一性，放弃随机性）。
    fn generate_uuid_v4() -> String {
        let mut bytes = [0u8; 16];
        let mut ok = false;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            use std::io::Read;
            ok = f.read_exact(&mut bytes).is_ok();
        }
        if !ok {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            bytes[..8].copy_from_slice(&nanos.to_le_bytes()[..8]);
            bytes[8..12].copy_from_slice(&std::process::id().to_le_bytes());
            bytes[12..16].copy_from_slice(&(nanos as u32).to_le_bytes());
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
        format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        )
    }

    /// 当前 UTC 时间的 ISO 8601 毫秒精度时间戳（无 chrono，civil_time 换算）。
    fn iso_utc_now() -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let millis = now.as_millis() % 1000;
        let (y, m, d, hh, mm, ss) = Self::civil_time(now.as_secs() as i64);
        format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
    }

    /// JSON 字符串转义（仅 \" \\ 与控制字符；非 ASCII 按 UTF-8 原样输出，合法 JSON）。
    fn json_escape(value: &str, out: &mut String) {
        out.push('"');
        for ch in value.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
    }

    /// 追加一条删除记录到 `<trash>/summary.json`（顶层 JSON 数组）。
    /// flock 独占锁下读-改-写：新条目定位数组尾部 ']' 追加，避免整表解析/重写；
    /// 损坏文件留存为 summary.json.corrupt-<millis> 后重开重建（锁随之转移到
    /// 新 inode）。返回 Ok(()) 或原因。
    fn append_summary_entry(
        trash_dir: &Path,
        uuid: &str,
        original_path: &str,
        size_bytes: u64,
        deleted_at: &str,
    ) -> Result<(), String> {
        use std::io::{Read, Seek, SeekFrom, Write};
        fn open_rw(path: &Path) -> Result<std::fs::File, String> {
            // mode(0o600)：daemon umask 已清零（见 daemon_main），不显式收紧会落成 0666
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(path)
                .map_err(|e| format!("open {}: {e}", path.display()))
        }
        // flock 阻塞等待可能被信号打断（EINTR）：必须重试，否则会在未持锁状态下
        // 读-改-写 summary.json，与其他并发写者互相覆盖
        fn flock_retry(file: &std::fs::File, operation: libc::c_int) {
            let fd = std::os::fd::AsRawFd::as_raw_fd(file);
            loop {
                let rc = unsafe { libc::flock(fd, operation) };
                if rc == 0 {
                    return;
                }
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno != libc::EINTR {
                    return;
                }
            }
        }
        let summary_path = trash_dir.join("summary.json");
        let mut file = open_rw(&summary_path)?;
        flock_retry(&file, libc::LOCK_EX);
        let result = loop {
            let mut raw = Vec::new();
            if let Err(e) = file.read_to_end(&mut raw) {
                break Err(format!("read: {e}"));
            }
            if raw.len() > 256 * 1024 * 1024 {
                break Err("summary.json 过大".to_string());
            }
            let content = String::from_utf8_lossy(&raw);

            let mut entry = String::from("{\"uuid\":");
            Self::json_escape(uuid, &mut entry);
            entry.push_str(",\"original_path\":");
            Self::json_escape(original_path, &mut entry);
            entry.push_str(&format!(",\"size\":{size_bytes},\"deleted_at\":"));
            Self::json_escape(deleted_at, &mut entry);
            entry.push('}');

            let open_idx = content.find('[');
            let close_idx = content.rfind(']');
            let corrupt = match (open_idx, close_idx) {
                (Some(o), Some(c)) => o > c,
                _ => true,
            };
            if corrupt && !content.is_empty() {
                // 损坏文件留存后重开：当前 fd 指向被改名的旧 inode，锁保护需
                // 转移到 summary_path 处的新 inode（重开 + 重新 flock 后续轮追加）
                let backup = trash_dir.join(format!(
                    "summary.json.corrupt-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                ));
                if let Err(e) = std::fs::rename(&summary_path, &backup) {
                    break Err(format!("留存损坏 summary 失败: {e}"));
                }
                flock_retry(&file, libc::LOCK_UN);
                file = match open_rw(&summary_path) {
                    Ok(f) => f,
                    Err(e) => break Err(e),
                };
                flock_retry(&file, libc::LOCK_EX);
                continue;
            }
            let updated = if corrupt {
                // 空文件（目录首轮）或留存后的重建：单条目数组
                format!("[\n  {}\n]", entry)
            } else {
                let (o, c) = (open_idx.unwrap(), close_idx.unwrap());
                let empty_array =
                    content[o + 1..c].bytes().all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'));
                if empty_array {
                    format!("{}\n  {}\n]{}", &content[..=o], entry, &content[c + 1..])
                } else {
                    let head = content[..c].trim_end().to_string();
                    format!("{},\n  {}\n]{}", head, entry, &content[c + 1..])
                }
            };
            file.seek(SeekFrom::Start(0)).map_err(|e| format!("seek: {e}"))?;
            if let Err(e) = file.write_all(updated.as_bytes()) {
                // 先写后截断：写失败（如被信号打断）时旧内容完整保留，避免清空索引
                break Err(format!("write: {e}"));
            }
            if let Err(e) = file.set_len(updated.len() as u64) {
                break Err(format!("truncate: {e}"));
            }
            break Ok(());
        };
        flock_retry(&file, libc::LOCK_UN);
        result
    }

    /// 秒数 → (年,月,日,时,分,秒)（Howard Hinnant civil_from_days 算法，无 chrono；
    /// 供诊断日志等复用）
    pub fn civil_time(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
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

    /// 构造 attr：execute 策略拒绝执行时掩去 x 位（子进程 exec 会得到 EACCES）。
    /// 目录的 x 位是遍历（搜索）权限而非"执行"：不掩，否则 execute-deny 的
    /// 目录会不可进入（cd/stat 子项全挂），read-allow 语义被破坏。
    fn attr_checked(&self, ino: u64, inner: &Path, meta: &fs::Metadata) -> FileAttr {
        let mut attr = self.attr(ino, meta);
        if !meta.is_dir() && !self.policy.check_exec(&self.policy_path(inner)) {
            attr.perm &= !(0o111u16);
        }
        attr
    }

    /// xattr 名字/路径 → CString（字节透传，防非 UTF-8 名字被拒绝丢失语义）
    fn c_bytes(bytes: &[u8]) -> Result<std::ffi::CString, ()> {
        std::ffi::CString::new(bytes).map_err(|_| ())
    }
}

fn open_flags_access(flags: i32) -> u8 {
    let mut access = match flags & libc::O_ACCMODE {
        libc::O_WRONLY => ACC_WRITE,
        libc::O_RDWR => ACC_READ | ACC_WRITE,
        _ => ACC_READ,
    };
    // O_TRUNC 即便搭配 O_RDONLY 也是写操作（Linux 内核允许只读打开携带 O_TRUNC
    // 并截断文件）：必须计入 write 类别，否则 write-deny 文件可被"只读"打开清空
    if flags & libc::O_TRUNC != 0 {
        access |= ACC_WRITE;
    }
    access
}

fn errno_of(error: &std::io::Error) -> i32 {
    error.raw_os_error().unwrap_or(EIO)
}

/// st_ctim（秒+纳秒，可能为负）→ SystemTime
fn system_time_from(secs: i64, nsecs: i64) -> SystemTime {
    if secs >= 0 {
        SystemTime::UNIX_EPOCH + Duration::new(secs as u64, nsecs as u32)
    } else {
        SystemTime::UNIX_EPOCH - Duration::new((-(secs + 1)) as u64, (1_000_000_000 - nsecs) as u32)
    }
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
        // 一步 libc::mkdir（mode 已应用请求方 umask）：先 create_dir 再
        // set_permissions 的两步写法存在权限窗口（中间态按 daemon umask 暴露）
        let real = self.real(&inner);
        let computed = (mode & !umask) & 0o7777;
        let cpath = match std::ffi::CString::new(real.as_os_str().as_encoded_bytes()) {
            Ok(c) => c,
            Err(_) => {
                reply.error(EINVAL);
                return;
            }
        };
        if unsafe { libc::mkdir(cpath.as_ptr(), computed as libc::mode_t) } != 0 {
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
        // POSIX 语义：rmdir 只删空目录。回收站路径的 rename 会绕过内核空检查
        // （整棵目录树被移走且返回成功），必须前置空校验
        if self.del_to_trash {
            match fs::read_dir(self.real(&inner)) {
                Ok(mut entries) => {
                    if entries.next().is_some() {
                        reply.error(libc::ENOTEMPTY);
                        return;
                    }
                }
                Err(e) => {
                    reply.error(errno_of(&e));
                    return;
                }
            }
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
        // renameat2 flags：NOREPLACE 目标存在时 EEXIST（当前内核已在 VFS 层拦截，
        // 此处防御性实现，防内核行为变化）；EXCHANGE/WHITEOUT 需要原子交换语义，
        // 普通 rename 无法模拟——忽略会把交换变成覆盖（实测目标数据静默丢失），
        // fail-closed 拒绝。
        if _flags & libc::RENAME_NOREPLACE != 0
            && fs::symlink_metadata(self.real(&new_inner)).is_ok()
        {
            reply.error(libc::EEXIST);
            return;
        }
        if _flags & (libc::RENAME_EXCHANGE | libc::RENAME_WHITEOUT) != 0 {
            reply.error(EINVAL);
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
        // 硬链接后经新路径的访问与源是同一 inode：策略按路径判定无法感知这一点，
        // 若源 write 被拒绝仍允许链接，敏感文件可被链进可写目录后经宽泛兜底规则
        // 读取/改写（策略逃逸）。源路径 write 同样要求放行（fail-closed）。
        if self.deny(&old_inner, ACC_WRITE) {
            reply.error(EACCES);
            return;
        }
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
            .insert(fh, DirHandle { parent: inner, entries: Arc::new(entries) });
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
                Some(handle) => (handle.parent.clone(), Arc::clone(&handle.entries)),
                None => {
                    reply.error(EBADF);
                    return;
                }
            }
        };
        // fuser 的 add() 返回 true 表示缓冲区已满（需停止填充）；满时也要 ok()
        // 发送已填充部分，内核会用 offset 续传。
        // offset 编码："."=1、".."=2、条目 i（0-based）=i+3；每个 offset 唯一
        // 对应流内位置（极端小缓冲下内核会以任意已发送 offset 续传）
        if offset == 0 && reply.add(1, 1, FileType::Directory, ".") {
            reply.ok();
            return;
        }
        if offset <= 1 && reply.add(1, 2, FileType::Directory, "..") {
            reply.ok();
            return;
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

    /// 扩展属性透传：读按 ACC_READ、写按 ACC_WRITE 策略判定；l 前缀变体
    /// 与 getattr 的 symlink_metadata 语义一致（不跟随符号链接）。
    /// cp -a/rsync -X/tar --xattrs 等依赖，ENOSYS 会让这些工具退化或警告。
    fn setxattr(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        name: &std::ffi::OsStr,
        value: &[u8],
        flags: i32,
        _position: u32,
        reply: ReplyEmpty,
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
        let (cpath, cname) = match (Self::c_bytes(self.real(&inner).as_os_str().as_encoded_bytes()), Self::c_bytes(name.as_encoded_bytes())) {
            (Ok(p), Ok(n)) => (p, n),
            _ => {
                reply.error(EINVAL);
                return;
            }
        };
        if unsafe {
            libc::lsetxattr(cpath.as_ptr(), cname.as_ptr(), value.as_ptr().cast(), value.len(), flags)
        } != 0
        {
            reply.error(errno_of(&std::io::Error::last_os_error()));
            return;
        }
        reply.ok();
    }

    fn getxattr(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        name: &std::ffi::OsStr,
        size: u32,
        reply: fuser::ReplyXattr,
    ) {
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
        let (cpath, cname) = match (Self::c_bytes(self.real(&inner).as_os_str().as_encoded_bytes()), Self::c_bytes(name.as_encoded_bytes())) {
            (Ok(p), Ok(n)) => (p, n),
            _ => {
                reply.error(EINVAL);
                return;
            }
        };
        if size == 0 {
            let needed =
                unsafe { libc::lgetxattr(cpath.as_ptr(), cname.as_ptr(), std::ptr::null_mut(), 0) };
            if needed < 0 {
                reply.error(errno_of(&std::io::Error::last_os_error()));
                return;
            }
            reply.size(needed as u32);
            return;
        }
        let mut buf = vec![0u8; size as usize];
        let n = unsafe {
            libc::lgetxattr(cpath.as_ptr(), cname.as_ptr(), buf.as_mut_ptr().cast(), size as usize)
        };
        if n < 0 {
            reply.error(errno_of(&std::io::Error::last_os_error()));
            return;
        }
        buf.truncate(n as usize);
        reply.data(&buf);
    }

    fn listxattr(&mut self, _req: &Request<'_>, ino: u64, size: u32, reply: fuser::ReplyXattr) {
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
        let cpath = match Self::c_bytes(self.real(&inner).as_os_str().as_encoded_bytes()) {
            Ok(c) => c,
            Err(_) => {
                reply.error(EINVAL);
                return;
            }
        };
        if size == 0 {
            let needed =
                unsafe { libc::llistxattr(cpath.as_ptr(), std::ptr::null_mut(), 0) };
            if needed < 0 {
                reply.error(errno_of(&std::io::Error::last_os_error()));
                return;
            }
            reply.size(needed as u32);
            return;
        }
        let mut buf = vec![0u8; size as usize];
        let n = unsafe {
            libc::llistxattr(cpath.as_ptr(), buf.as_mut_ptr().cast(), size as usize)
        };
        if n < 0 {
            reply.error(errno_of(&std::io::Error::last_os_error()));
            return;
        }
        buf.truncate(n as usize);
        reply.data(&buf);
    }

    fn removexattr(&mut self, _req: &Request<'_>, ino: u64, name: &std::ffi::OsStr, reply: ReplyEmpty) {
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
        let (cpath, cname) = match (Self::c_bytes(self.real(&inner).as_os_str().as_encoded_bytes()), Self::c_bytes(name.as_encoded_bytes())) {
            (Ok(p), Ok(n)) => (p, n),
            _ => {
                reply.error(EINVAL);
                return;
            }
        };
        if unsafe { libc::lremovexattr(cpath.as_ptr(), cname.as_ptr()) } != 0 {
            reply.error(errno_of(&std::io::Error::last_os_error()));
            return;
        }
        reply.ok();
    }

    /// 空间预分配/释放透传（数据库、dd oflag 等场景）：宿主 ext4/tmpfs 均支持，
    /// ENOSYS 会让调用方退化或失败。fh 优先（与 open/create 句柄一致），
    /// 否则按路径打开。
    fn fallocate(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        fh: u64,
        offset: i64,
        length: i64,
        mode: i32,
        reply: ReplyEmpty,
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
        let result = if fh != 0 {
            // fh 由 open/create 分配（0 恒为"无句柄"）
            match self.files.lock().unwrap().get(&fh).cloned() {
                Some(file) => {
                    let r = unsafe {
                        libc::fallocate(std::os::fd::AsRawFd::as_raw_fd(&file), mode, offset, length)
                    };
                    if r == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
                }
                None => Err(std::io::Error::from_raw_os_error(EBADF)),
            }
        } else {
            let cpath = match Self::c_bytes(self.real(&inner).as_os_str().as_encoded_bytes()) {
                Ok(c) => c,
                Err(_) => {
                    reply.error(EINVAL);
                    return;
                }
            };
            let fd = unsafe {
                libc::open(cpath.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC)
            };
            if fd < 0 {
                reply.error(errno_of(&std::io::Error::last_os_error()));
                return;
            }
            let r = unsafe { libc::fallocate(fd, mode, offset, length) };
            let err = std::io::Error::last_os_error();
            unsafe { libc::close(fd) };
            if r == 0 { Ok(()) } else { Err(err) }
        };
        match result {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(errno_of(&e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::MirrorFs;

    #[test]
    fn civil_time_converts_epoch_seconds() {
        // 已知 UTC 时间戳锚点：换算错误会破坏回收站 DeletionDate 与诊断日志
        assert_eq!(MirrorFs::civil_time(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(MirrorFs::civil_time(1_767_225_600), (2026, 1, 1, 0, 0, 0));
        assert_eq!(MirrorFs::civil_time(1_790_726_400), (2026, 9, 30, 0, 0, 0));
        assert_eq!(MirrorFs::civil_time(1_790_726_400 + 86_399), (2026, 9, 30, 23, 59, 59));
    }

    #[test]
    fn uuid_v4_has_canonical_shape() {
        // 与宿主侧 TrashEntry 校验正则一致：8-4-4-4-12 小写十六进制，v4 版本位
        for _ in 0..32 {
            let uuid = MirrorFs::generate_uuid_v4();
            assert_eq!(uuid.len(), 36);
            let parts: Vec<&str> = uuid.split('-').collect();
            assert_eq!(parts.len(), 5);
            assert_eq!((parts[0].len(), parts[1].len(), parts[2].len(), parts[3].len(), parts[4].len()),
                       (8, 4, 4, 4, 12));
            assert!(uuid.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
            assert!(uuid.chars().all(|c| !c.is_ascii_uppercase()));
            assert_eq!(&parts[2][0..1], "4");
        }
        // 唯一性抽查
        let a = MirrorFs::generate_uuid_v4();
        let b = MirrorFs::generate_uuid_v4();
        assert_ne!(a, b);
    }

    #[test]
    fn json_escape_quotes_control_chars_and_keeps_utf8() {
        let mut out = String::new();
        MirrorFs::json_escape("C:\\dir\\名前\"quote\"\n\u{1}", &mut out);
        assert_eq!(out, "\"C:\\\\dir\\\\名前\\\"quote\\\"\\n\\u0001\"");
    }

    #[test]
    fn summary_append_grows_array_and_survives_rebuild() {
        let dir = std::env::temp_dir().join(format!("dynobox-summary-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let entry = |uuid: &str| {
            MirrorFs::append_summary_entry(&dir, uuid, "/tmp/a.txt", 42, "2026-05-01T00:00:00.000Z")
                .unwrap();
        };
        entry("00000000-0000-4000-8000-000000000001");
        entry("00000000-0000-4000-8000-000000000002");

        let content = std::fs::read_to_string(dir.join("summary.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 2);
        assert_eq!(parsed[1]["original_path"], "/tmp/a.txt");
        assert_eq!(parsed[1]["size"], 42);

        // 空数组形式（宿主或旧数据可能写入 "[]"）：追加后仍是合法数组
        std::fs::write(dir.join("summary.json"), "[]").unwrap();
        entry("00000000-0000-4000-8000-000000000003");
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("summary.json")).unwrap()).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 1);
        assert_eq!(parsed[0]["uuid"], "00000000-0000-4000-8000-000000000003");

        // 损坏内容：留存重建，新条目可查且旧文件有备份
        std::fs::write(dir.join("summary.json"), "{broken").unwrap();
        entry("00000000-0000-4000-8000-000000000004");
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("summary.json")).unwrap()).unwrap();
        assert_eq!(parsed[0]["uuid"], "00000000-0000-4000-8000-000000000004");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("summary.json.corrupt"))
            .collect();
        assert_eq!(leftovers.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn iso_utc_now_has_millisecond_precision() {
        let stamp = MirrorFs::iso_utc_now();
        // 2026-05-01T00:00:00.000Z
        assert_eq!(stamp.len(), 24);
        assert!(stamp.ends_with('Z'));
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
        assert_eq!(&stamp[19..20], ".");
    }
}

