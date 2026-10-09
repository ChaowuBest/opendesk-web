/*
 * boxdylib.c 纯函数级 C harness 测试（node:test 运行，经 tsx 执行）。
 *
 * 背景：CLT 工具链白名单的 <基名>-<版本号> 匹配分支无法用真进程测试——
 * /Library/Developer/CommandLineTools 只读、且真实系统不会同时安装全部
 * 版本号别名。此文件 #include boxdylib.c 直接调用内部函数验证匹配语义，
 * 编译产物是一次性可执行文件，与 dylib 构建互不影响。
 *
 * 注意：boxdylib.c 含 DYLD_INTERPOSE 与 constructor，普通可执行文件中
 * interpose 表不生效（无 dyld 重绑定），constructor 会执行但仅读环境变量，
 * 均无副作用；测试不依赖任何 interpose 行为。
 */
#include "boxdylib.c"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static int g_failures = 0;

static void expect_match(const char *name, bool expected) {
    bool got = clt_toolchain_basename(name);
    if (got != expected) {
        printf("FAIL clt_toolchain_basename(\"%s\"): expected %s, got %s\n",
               name, expected ? "true" : "false", got ? "true" : "false");
        g_failures++;
    }
}

int main(void) {
    /* 精确命中：表内基名 */
    expect_match("cc", true);
    expect_match("clang", true);
    expect_match("clang++", true);
    expect_match("gcc", true);
    expect_match("g++", true);
    expect_match("ld", true);
    expect_match("swift", true);
    expect_match("swiftc", true);
    expect_match("ar", true);
    expect_match("ranlib", true);
    expect_match("nm", true);
    expect_match("strip", true);
    expect_match("libtool", true);
    expect_match("install_name_tool", true);
    expect_match("otool", true);
    expect_match("codesign", true);
    expect_match("lipo", true);

    /* 版本后缀命中：<基名>-<纯数字>（本改动目标：随 CLT 版本演进不再逐个枚举） */
    expect_match("clang-14", true);
    expect_match("clang-15", true);
    expect_match("clang-16", true);
    expect_match("clang-17", true);
    expect_match("clang-18", true);
    expect_match("clang-21", true);   /* 未来版本：逐个枚举会失效，通配应命中 */
    expect_match("gcc-12", true);
    expect_match("gcc-14", true);
    expect_match("ld-3", true);

    /* 连字符名但非版本后缀：不命中（防止误豁免重签/注入） */
    expect_match("clang-format", false);
    expect_match("clangd", false);
    expect_match("clang-check", false);   /* 非纯数字后缀 */
    expect_match("clang-apple", false);
    expect_match("gcc-ar", false);
    expect_match("clang-", false);        /* 悬空连字符 */
    expect_match("llvm-nm", false);       /* 前缀不匹配（表内是 nm）*/
    expect_match("xcrun-strip", false);

    /* 完全无关的 basename：不命中 */
    expect_match("git", false);
    expect_match("python3", false);
    expect_match("cc-Compiler", false);   /* 非纯数字后缀 */
    expect_match("", false);

    if (g_failures > 0) {
        printf("%d assertion(s) failed\n", g_failures);
        return 1;
    }
    printf("clt_toolchain_basename: all assertions passed\n");
    return 0;
}
