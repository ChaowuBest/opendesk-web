# 🏗️ 桶4: 编译与构建过程报错

---

## libintl_gettext 链接失败

```
ld.lld: error: undefined symbol: libintl_gettext
ld.lld: error: undefined symbol: libintl_bindtextdomain
```

```bash
./configure --disable-nls --prefix=$HOME/usr/local
```

---

## configure 文件

```
configure: No such file or directory
autoconf: possibly undefined macro
autogen.sh.*failed
```

使用稳定版源码包（含预生成 configure/aclocal.m4/Makefile.in），而非开发版。

---

## aclocal.m4 占位符未替换

```
@am_AUTOM4TE@.*inaccessible
sh: @am_AUTOM4TE@.*not found
```

使用稳定版源码包。验证: `grep "@am_AUTOM4TE@" aclocal.m4` 应无匹配。

---

## automake 版本不匹配

```
automake.*version.*mismatch
aclocal.*version.*mismatch
```

（根因: autotools 完全缺失，比版本不匹配更严重）

需安装整套 autotools（autoconf + automake + libtool + perl）。

---

## autoreconf 不可用

```
automake not found
autoreconf: failed
```

需安装 automake + perl。安装后: `autoreconf -fvi && ./configure --prefix=$DEFAULT_PREFIX`

---

## cmake 构建模式在 HMDFS 上异常

```
cmake.*module.*deleted
.work.*directory.*reinitialized
```

（根因: HMDFS 上 cmake 的 .work 目录被意外删除/重建）

需使用 manual build mode 绕过。

---

[⬆ 返回顶部](./README.md)
