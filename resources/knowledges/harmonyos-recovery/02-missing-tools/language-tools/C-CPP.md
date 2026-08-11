# C/C++ 编译工具链

OpenHarmony 的 LLVM 工具链（clang、clang++、ldd、llvm-ar、llvm-nm、llvm-objdump 等）、构建工具（make、cmake、ninja）以及调试分析工具（gdb、perf、strace 等）均位于 `/data/service/hap/bin` 目录下。部分工具报"command not found"是环境变量设置问题。

> 注：`/data/service/hap/bin` 下的工具链需用户在 AppGallery 中手动下载 **DevBox** 后方具备。

## 常见问题

### 找不到 C/C++ 编译器

```
configure: error: C compiler cannot create executables
cc: not found / clang: command not found
cc1plus: error: unrecognized command-line option
```

```bash
export CC=clang
export CXX=clang++
export CFLAGS="--target=aarch64-unknown-linux-ohos"
export CXXFLAGS="--target=aarch64-unknown-linux-ohos"
```

### 找不到 llvm-ar

```
ar: command not found
ar: invalid option -- 'T'
RANLIB: command not found
```

```bash
export AR=llvm-ar
export RANLIB=llvm-ranlib
export NM=llvm-nm
export STRIP=llvm-strip
```

### gfortran 缺失

```
gfortran: No such file or directory
```

平台限制，无法本地解决。替代：交叉编译或使用 Eigen/LAPACK C 接口。

### Perl 缺失导致 automake 不可用

```
Can't locate Automake/Config.pm in @INC
bad interpreter: .*perl: no such file or directory
```

先安装 Perl，再安装 automake；或使用稳定版源码包绕过 autotools 依赖。

### Boost b2 不识别 OHOS

```
clang++ --version : no (cached, failure)
cannot deduce architecture from compiler
aarch64-unknown-linux-ohos not recognized
```

```bash
# 方案1: CMake 构建（Boost 1.90+）
mkdir -p build && cd build
cmake .. -DBOOST_INCLUDE_LIBRARIES="system;filesystem;thread" -DCMAKE_INSTALL_PREFIX=$DEFAULT_PREFIX
cmake --build . && cmake --install .

# 方案2: 仅用 header-only 库
export CPLUS_INCLUDE_PATH=/path/to/boost_1_90_0:$CPLUS_INCLUDE_PATH

# 方案3: user-config.jam 手动配置
cat > user-config.jam << 'EOF'
using clang : ohos : clang++ : <archiver>llvm-ar <ranlib>llvm-ranlib ;
EOF
./b2 --user-config=user-config.jam --with-system --with-filesystem install
```

### fbida 自定义构建系统

```
GNUmakefile.*mk/Autoconf.mk
jpeg-version.sh.*failed
```

```bash
# fbida 不用标准 autotools
make config
# JPEG 版本手动设置
export JPEG_VER=62
make config
```

## C/C++ 包管理工具

### ohos_vcpkg

```
vcpkg: command not found
vcpkg: unknown target: arm64-ohos
```

微软 vcpkg 的鸿蒙分支，提供适用于 OpenHarmony 的预编译 C/C++ 库；支持范围以 [ohos_vcpkg](https://gitcode.com/OpenHarmonyPCDeveloper/ohos_vcpkg) 仓库为准：

```bash
git clone https://gitcode.com/OpenHarmonyPCDeveloper/ohos_vcpkg.git
cd ohos_vcpkg
./bootstrap-vcpkg.sh
./vcpkg install <包名> --triplet arm64-ohos
```

### lycium_plusplus

```
lycium: command not found
```

OpenHarmony C++ 编译框架增强版，支持范围以 [lycium_plusplus](https://gitcode.com/OpenHarmonyPCDeveloper/lycium_plusplus) 仓库为准。

### muslc_gext 扩展接口库

```
warning: implicit declaration of function 'muslc_gext_*'
undefined reference to 'muslc_gext_*'
```

需从源码编译：

```bash
git clone https://gitcode.com/OpenHarmonyPCDeveloper/muslc_gext.git
cd muslc_gext
make && make install
```

---

[⬆ 返回 language-tools](./README.md)
