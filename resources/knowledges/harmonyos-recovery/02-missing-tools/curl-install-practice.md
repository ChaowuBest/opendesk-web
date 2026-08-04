# 实践：修复带私有动态库的 curl

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

为工具创建独立前缀：

```bash
DST=<private-executable-prefix>/curl
mkdir -p "$DST/bin" "$DST/lib/external"

cp "$SRC/bin/curl" "$DST/bin/curl.source"
cp "$SRC/lib/libcurl.so.4" "$DST/lib/libcurl.source.so.4"
cp "$SRC/lib/external/libssl.so.3" \
  "$DST/lib/external/libssl.source.so.3"
cp "$SRC/lib/external/libcrypto.so.3" \
  "$DST/lib/external/libcrypto.source.so.3"
```

`<private-executable-prefix>` 必须替换为当前应用允许执行和加载原生代码的私有目录（如 `$CMD_PKGS_DIR/curl-cmdpkg`），不能仅因为某个目录可读写就假定它可执行 ELF。

## 3. 修改各级 RUNPATH

先复制工作文件并移除旧签名，再设置部署目录的库路径：

```bash
cp "$DST/bin/curl.source" "$DST/bin/curl.work"
cp "$DST/lib/libcurl.source.so.4" "$DST/lib/libcurl.work.so.4"
cp "$DST/lib/external/libssl.source.so.3" \
  "$DST/lib/external/libssl.work.so.3"
cp "$DST/lib/external/libcrypto.source.so.3" \
  "$DST/lib/external/libcrypto.work.so.3"

llvm-objcopy --remove-section=.codesign "$DST/bin/curl.work"
llvm-objcopy --remove-section=.codesign "$DST/lib/libcurl.work.so.4"
llvm-objcopy --remove-section=.codesign \
  "$DST/lib/external/libssl.work.so.3"
llvm-objcopy --remove-section=.codesign \
  "$DST/lib/external/libcrypto.work.so.3"

patchelf --set-rpath "$DST/lib:$DST/lib/external" \
  "$DST/bin/curl.work"
patchelf --set-rpath "$DST/lib:$DST/lib/external" \
  "$DST/lib/libcurl.work.so.4"
patchelf --set-rpath "$DST/lib/external" \
  "$DST/lib/external/libssl.work.so.3"
patchelf --set-rpath "$DST/lib/external" \
  "$DST/lib/external/libcrypto.work.so.3"
```

本次实践使用绝对 RUNPATH，是因为相同环境中的 `$ORIGIN` 对照测试未按预期找到相邻库。其他系统版本应先验证 `$ORIGIN`，不要默认改成绝对路径。

## 4. 对最终 ELF 重新签名

```bash
binary-sign-tool sign -selfSign 1 \
  -inFile "$DST/bin/curl.work" \
  -outFile "$DST/bin/curl" \
  -signAlg SHA256withECDSA

binary-sign-tool sign -selfSign 1 \
  -inFile "$DST/lib/libcurl.work.so.4" \
  -outFile "$DST/lib/libcurl.so.4" \
  -signAlg SHA256withECDSA

binary-sign-tool sign -selfSign 1 \
  -inFile "$DST/lib/external/libssl.work.so.3" \
  -outFile "$DST/lib/external/libssl.so.3" \
  -signAlg SHA256withECDSA

binary-sign-tool sign -selfSign 1 \
  -inFile "$DST/lib/external/libcrypto.work.so.3" \
  -outFile "$DST/lib/external/libcrypto.so.3" \
  -signAlg SHA256withECDSA

chmod 755 \
  "$DST/bin/curl" \
  "$DST/lib/libcurl.so.4" \
  "$DST/lib/external/libssl.so.3" \
  "$DST/lib/external/libcrypto.so.3"
```

签名后不要再执行 `patchelf`、`objcopy`、`strip` 或其他会修改 ELF 内容的操作。

## 5. 验证动态加载

```bash
for FILE in \
  "$DST/bin/curl" \
  "$DST/lib/libcurl.so.4" \
  "$DST/lib/external/libssl.so.3" \
  "$DST/lib/external/libcrypto.so.3"
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
