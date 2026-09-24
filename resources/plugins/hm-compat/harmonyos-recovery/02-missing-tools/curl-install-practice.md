# 实践：修复带私有动态库的 curl（executeBash 通道）

本节保留一次完整实践，用来展示 cmd-pkgs 渠道安装的 curl 从“已安装但无法启动”到可用的处理过程。它是案例，不是所有工具都必须照搬的固定安装方案；通用原理参见[执行权限受限](../03-permission-denied/exec-permission.md)。

## 1. 确认文件和依赖

假设安装脚本将 curl 放在 `$HOME/usr/local`：

```bash
SRC="$HOME/usr/local"

file "$SRC/bin/curl"
readelf -d "$SRC/bin/curl" \
  | grep -E 'NEEDED|RPATH|RUNPATH'
readelf -d "$SRC/lib/libcurl.so.4" \
  | grep -E 'NEEDED|RPATH|RUNPATH|SONAME'
```

实践中的依赖链为：

```text
curl
├── libcurl.so.4
├── libssl.so.3
└── libcrypto.so.3
```

仅设置 `LD_LIBRARY_PATH` 后仍无法加载，说明还需检查部署文件系统、ELF 签名和各级 RUNPATH。

## 2. 迁移到可执行的应用私有目录

可执行文件统一装到 `$CMD_PKGS_DIR/bin`（executeBash 通道 PATH 仅来自 OpenDesk env 注入的固定路径），私有库装到 `lib/external/curl-cmdpkg` 隔离子目录（避免与其他包的同名 `.so` 互相覆盖）：

```bash
DST="$CMD_PKGS_DIR"
LIBDIR="$DST/lib/external/curl-cmdpkg"
mkdir -p "$DST/bin" "$LIBDIR"

cp "$SRC/bin/curl" "$DST/bin/curl.source"
cp "$SRC/lib/libcurl.so.4" "$LIBDIR/libcurl.source.so.4"
cp "$SRC/lib/external/libssl.so.3" \
  "$LIBDIR/libssl.source.so.3"
cp "$SRC/lib/external/libcrypto.so.3" \
  "$LIBDIR/libcrypto.source.so.3"
```

`$CMD_PKGS_DIR` 为当前应用允许执行和加载原生代码的私有目录（PATH 已前置其 bin），不能仅因为某个目录可读写就假定它可执行 ELF。

## 3. 修改各级 RUNPATH

先复制工作文件并移除旧签名，再设置部署目录的库路径：

```bash
cp "$DST/bin/curl.source" "$DST/bin/curl.work"
cp "$LIBDIR/libcurl.source.so.4" "$LIBDIR/libcurl.work.so.4"
cp "$LIBDIR/libssl.source.so.3" "$LIBDIR/libssl.work.so.3"
cp "$LIBDIR/libcrypto.source.so.3" "$LIBDIR/libcrypto.work.so.3"

llvm-objcopy --remove-section=.codesign "$DST/bin/curl.work"
llvm-objcopy --remove-section=.codesign "$LIBDIR/libcurl.work.so.4"
llvm-objcopy --remove-section=.codesign \
  "$LIBDIR/libssl.work.so.3"
llvm-objcopy --remove-section=.codesign \
  "$LIBDIR/libcrypto.work.so.3"

patchelf --set-rpath "$LIBDIR" \
  "$DST/bin/curl.work"
patchelf --set-rpath "$LIBDIR" \
  "$LIBDIR/libcurl.work.so.4"
patchelf --set-rpath "$LIBDIR" \
  "$LIBDIR/libssl.work.so.3"
patchelf --set-rpath "$LIBDIR" \
  "$LIBDIR/libcrypto.work.so.3"
```

本次实践使用绝对 RUNPATH，是因为相同环境中的 `$ORIGIN` 对照测试未按预期找到相邻库。其他系统版本应先验证 `$ORIGIN`，不要默认改成绝对路径。

## 4. 对最终 ELF 重新签名

```bash
binary-sign-tool sign -selfSign 1 \
  -inFile "$DST/bin/curl.work" \
  -outFile "$DST/bin/curl" \
  -signAlg SHA256withECDSA

binary-sign-tool sign -selfSign 1 \
  -inFile "$LIBDIR/libcurl.work.so.4" \
  -outFile "$LIBDIR/libcurl.so.4" \
  -signAlg SHA256withECDSA

binary-sign-tool sign -selfSign 1 \
  -inFile "$LIBDIR/libssl.work.so.3" \
  -outFile "$LIBDIR/libssl.so.3" \
  -signAlg SHA256withECDSA

binary-sign-tool sign -selfSign 1 \
  -inFile "$LIBDIR/libcrypto.work.so.3" \
  -outFile "$LIBDIR/libcrypto.so.3" \
  -signAlg SHA256withECDSA

chmod 755 \
  "$DST/bin/curl" \
  "$LIBDIR/libcurl.so.4" \
  "$LIBDIR/libssl.so.3" \
  "$LIBDIR/libcrypto.so.3"
```

签名后不要再执行 `patchelf`、`objcopy`、`strip` 或其他会修改 ELF 内容的操作。

## 5. 验证动态加载

```bash
for FILE in \
  "$DST/bin/curl" \
  "$LIBDIR/libcurl.so.4" \
  "$LIBDIR/libssl.so.3" \
  "$LIBDIR/libcrypto.so.3"
do
  binary-sign-tool display-sign -inFile "$FILE"
  readelf -d "$FILE" | grep -E 'NEEDED|RPATH|RUNPATH|SONAME'
done

"$DST/bin/curl" --version
```

`display-sign` 只能显示签名元数据，最终仍以实际执行结果为准。

## 6. 配置 CA 并验证 HTTPS

如果 curl 已能启动，但返回 `curl: (60)`，这是证书信任配置问题，不是动态库加载失败。先定位系统 CA，再显式验证：

```bash
CA_FILE=<system-ca-bundle>

SSL_CERT_FILE="$CA_FILE" \
  "$DST/bin/curl" -fsS -o /dev/null https://example.com/
```

如果需要默认设置 CA，可以使用经过签名的最小 ELF 启动器设置 `SSL_CERT_FILE` 后 `exec` 真正的 curl。不要假定受限文件系统上的 shebang 包装脚本可以直接执行。

## 7. 验证不同调用方式

```bash
"$DST/bin/curl" --version

bash -c "'$DST/bin/curl' --version"

python3 -c "
import subprocess
subprocess.run(['$DST/bin/curl', '--version'], check=True)
"
```

通过后可添加到 PATH。
