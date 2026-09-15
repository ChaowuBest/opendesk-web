# 文件操作受限

鸿蒙 HMDFS 文件系统与常规 Linux/Windows 文件系统差异较大，在文件写、编译、安装、Git 操作等场景中容易触发文件系统限制问题。

[⬆ 返回桶3](./README.md)

---

## 1. `/tmp` 只读

常见错误现象如：

```
cannot create temporary file: /tmp/xxx: Read-only file system
/tmp: Permission denied
erofs: filesystem is read-only
```

根本原因是鸿蒙系统的 `/tmp` 是 **erofs（只读文件系统）** 挂载，无法写入临时文件。此外 `/data/local/tmp` 也有权限限制。

在`configure` / `make` / `install` 等工具执行时，默认使用 `/tmp` 写临时文件，需要通过 `TMPDIR` 环境变量重定向到用户目录：

```bash
export TMPDIR=$HOME/tmp
mkdir -p $TMPDIR
```

---

## 2. `~` 等路径访问

依赖 `~` 路径的应用可能无法正常读写文件，用户主目录是 `$HOME/`。

---

## 3. 软链接创建失败

常见出错信息是：

```
ln: cannot create symbolic link 'xxx': Permission denied
ln -sf 创建带随机后缀的乱码文件
```

根因在于鸿蒙 SELinux 策略限制用户进程在特定目录创建和访问软链接。
推荐如下两种解决方案：

方案 A：用 `cp` 替代

```bash
cp $(readlink -f /path/to/target) /path/to/link
```

方案 B：封装 wrapper 脚本

```bash
cat > $HOME/usr/local/bin/cc << 'EOF'
#!/bin/sh
exec /data/service/hnp/bin/clang "$@"
EOF
chmod +x $HOME/usr/local/bin/cc
```

---

## 4. 硬链接不支持（E079）

常见错误告警：

```
ln: cannot create hard link: Operation not permitted
ln（无 -s）在 HMDFS 上报 EPERM
```

根因如下所示：

```
$HOME = /storage/Users/currentUser → HMDFS（分布式文件系统）
    │
    ├── HMDFS 挂载选项: rw, nodev, relatime, hmmac=genfs
    │       └── nodev: 禁用设备文件
    │       └── 分布式架构: inode 跨设备不唯一
    │
    └── ln（无 -s）尝试创建硬链接 → 多个目录项指向同一 inode
            └── HMDFS 无法保证跨设备 inode 唯一性
                └── 返回 EPERM / Operation not permitted
```

这会导致 `git clone --local`、`make install` 等操作失败。
如下是不同触发场景下对应的解决方案

```bash
# Git 克隆时禁用硬链接
git clone --no-hardlinks <repo>

# configure 层面禁用硬链接
./configure --prefix=$PREFIX ac_cv_prog_ln_s="cp -p"

# ccache / pnpm 使用内存盘
export CCACHE_DIR=/dev/shm/ccache
npm config set store-dir /dev/shm/pnpm-store
```

---

## 5. `/proc` 文件系统访问限制

```
Cannot open /proc/stat: Permission denied
Cannot open /proc/version|uptime|loadavg|cmdline|diskstats: Permission denied
```

（/proc/meminfo、/proc/cpuinfo、/proc/self/status 可正常访问）

```python
# 用 syscall 接口替代 /proc 解析
import ctypes, ctypes.util
libc = ctypes.CDLL(ctypes.util.find_library('c'))
# sysinfo() -> uptime/totalram/freeram/load avg
# sysconf(_SC_NPROCESSORS_ONLN) -> CPU 核数
```

---

## 6. git safe.directory 在 HMDFS 上失败

```
fatal: detected dubious ownership in repository at '...'
To add an exception for this directory, call: git config --global --add safe.directory ...
```

（根因: HMDFS UID 映射导致仓库 owner 与当前用户不一致）

```ini
# 创建 ~/usr/local/etc/gitconfig
[safe]
    directory = *
```

---

## 7. venv 创建失败

```
Error: [Errno 13] Permission denied: 'lib' -> '/path/venv/lib64'
python3 -m venv myproject 失败
```

（lib64 已修补为 mkdir，但 bin/python3 copy 后无法加载 libpython3.12.so.1.0）

```python
import os, venv
env_dir = '/path/to/venv'
os.makedirs(os.path.join(env_dir, 'lib64'), exist_ok=True)
_orig = os.symlink
def _safe_symlink(src, dst, *a, **kw):
    try: _orig(src, dst, *a, **kw)
    except OSError:
        if not os.path.exists(dst): os.makedirs(dst, exist_ok=True)
os.symlink = _safe_symlink
try:
    venv.EnvBuilder(with_pip=True, symlinks=False).create(env_dir)
finally:
    os.symlink = _orig
```
