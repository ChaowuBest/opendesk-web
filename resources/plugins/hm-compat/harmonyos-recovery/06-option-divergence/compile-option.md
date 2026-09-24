# 编译选项差异

标准 Linux 上常见的编译和构建选项在 HarmonyOS上不支持。

[⬆ 返回桶6](./README.md)

---

## 无 32 位兼容层，-m32 不支持

```
-m32: unsupported option
32-bit.*not supported
invalid arch aarch64-linux-musl/m32
```

```bash
./configure --disable-mpers --prefix=$HOME/usr/local
# 或过滤 CFLAGS 中的 -m32
export CFLAGS=$(echo $CFLAGS | sed 's/-m32//g')
export CXXFLAGS=$(echo $CXXFLAGS | sed 's/-m32//g')
```

---

## POSIX timer 常量缺失

```
error: 'CLOCK_REALTIME' undeclared
error: 'CLOCK_MONOTONIC' undeclared
error: implicit declaration of function 'clock_gettime'
```

```bash
cmake .. -DSUPPORT_POSIX_TIMERS=OFF -DUSE_POSIX_TIMERS=OFF
```
