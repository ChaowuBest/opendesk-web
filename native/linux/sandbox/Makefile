# dynobox-linux build（LD_PRELOAD 版）
#
# 源码复用：与 OpenHarmony 版共用 native/openharmony/sandbox/src 下的一套 C 源码
# （core 策略引擎 + preload 拦截层 + CLI），本目录只提供构建脚本，不复制第二份源码。
#
#   policy.c / pathmap.c / ask.c / cfgio.c / util.c / log.c / mini_toml.c
#     —— core：策略解析、glob 匹配、ask 决策、配置编解码、日志（纯 POSIX C）
#   preload.c —— LD_PRELOAD 拦截层（glibc / musl 双兼容）
#   main.c / endpoint.c —— CLI 与 ask 端点
#
# 运行时布局：runtime/<target>/{dynobox,libdynobox.so}。main.c 的
# find_preload_lib() 在 dynobox 自身目录旁找 libdynobox.so，两者必须同目录。
#
# 用法：
#   make                              # 构建 build/{dynobox,libdynobox.so}
#   make runtime                      # 落盘 runtime/<host-triple>/ 并 strip
#   make runtime RUNTIME_TARGET=aarch64-unknown-linux-gnu
#   make unit                         # core 策略引擎单元测试

CC      ?= gcc
# -Wno-nonnull-compare: wrappers guard NULL paths before forwarding to glibc,
# whose headers declare those params nonnull.
CFLAGS  ?= -O2 -g -Wall -Wextra -Wno-unused-parameter -Wno-nonnull-compare -fPIC
# -Wno-comment: comments document glob semantics by quoting patterns such as
# `/a/**`; the `/*` appearing inside those block comments is intentional text,
# not a nested comment opener. 用 += 追加，即使外部覆盖 CFLAGS 也保持静默。
CFLAGS  += -Wno-comment
LDFLAGS ?=
BUILD   ?= $(ROOT)/build

# 本 Makefile 所在目录（源码复用路径以此为基准，与调用时的 cwd 无关）
ROOT     := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

# 源码单一来源：OpenHarmony sandbox 的 src/（Linux 直接复用同一份 C 源码）。
# 本目录是 native/linux/sandbox，需上两级到 native/ 再进 openharmony/。
# 用 abspath 规范化（消解 ..），否则 make 对含 .. 的目标做隐式规则匹配时误判不存在。
SHARED_SRC := $(abspath $(ROOT)/../../openharmony/sandbox/src)
SRCDIR    := $(SHARED_SRC)
CFLAGS    += -I$(SRCDIR)

CORE_SRCS = $(SRCDIR)/policy.c $(SRCDIR)/pathmap.c $(SRCDIR)/ask.c $(SRCDIR)/cfgio.c \
            $(SRCDIR)/util.c $(SRCDIR)/log.c $(SRCDIR)/mini_toml.c $(SRCDIR)/rawio_linux.c
LIB_SRCS  = $(CORE_SRCS) $(SRCDIR)/preload.c
CLI_SRCS  = $(CORE_SRCS) $(SRCDIR)/main.c $(SRCDIR)/endpoint.c

HDRS = $(SRCDIR)/dynobox.h $(SRCDIR)/policy.h $(SRCDIR)/pathmap.h $(SRCDIR)/ask.h \
       $(SRCDIR)/cfgio.h $(SRCDIR)/util.h $(SRCDIR)/log.h $(SRCDIR)/mini_toml.h

LIB = $(BUILD)/libdynobox.so
CLI = $(BUILD)/dynobox

.PHONY: all clean unit runtime
all: $(LIB) $(CLI)

$(LIB): $(LIB_SRCS) $(HDRS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -shared -o $@ $(LIB_SRCS) -ldl -lpthread $(LDFLAGS)

$(CLI): $(CLI_SRCS) $(HDRS) $(SRCDIR)/endpoint.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(CLI_SRCS) -lpthread $(LDFLAGS)

# core 策略引擎单元测试（复用 OH 侧测试用例）
unit: $(SRCDIR)/../tests/unit_policy.c $(CORE_SRCS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $(BUILD)/unit_policy $(SRCDIR)/../tests/unit_policy.c $(CORE_SRCS) -lpthread

# ---------------------------------------------------------------------------
# 运行时产物：runtime/<target>/。RUNTIME_TARGET 用 rust 风格 triple，与打包
# 脚本（build-linux-sandbox.cjs / forge stage）按架构取产物的约定一致。
#
# 与 OH 版不同：Linux/glibc 无 .codesign 段、无需重签，strip 即可。
# ---------------------------------------------------------------------------
RUNTIME_TARGET ?= $(shell uname -m)-unknown-linux-gnu
RUNTIME_DIR    ?= $(ROOT)/runtime/$(RUNTIME_TARGET)
STRIP          ?= strip

.PHONY: runtime
runtime: $(RUNTIME_DIR)/dynobox $(RUNTIME_DIR)/libdynobox.so
	@{ \
	  printf 'artifact:  dynobox + libdynobox.so (stripped)\n'; \
	  printf 'target:    %s\n' '$(RUNTIME_TARGET)'; \
	  printf 'source:    native/openharmony/sandbox/src (shared with OpenHarmony build)\n'; \
	  printf 'cc:        %s\n' "$$($(CC) --version 2>/dev/null | head -1)"; \
	  printf 'built:     %s\n' "$$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)"; \
	  printf 'layout:    dynobox resolves libdynobox.so relative to its own dir\n'; \
	} > $(RUNTIME_DIR)/BUILD-INFO.txt
	@echo "== $(RUNTIME_DIR) ==" && ls -l $(RUNTIME_DIR)

$(RUNTIME_DIR)/dynobox $(RUNTIME_DIR)/libdynobox.so: $(RUNTIME_DIR)/%: $(BUILD)/%
	@mkdir -p $(RUNTIME_DIR)
	@cp -f $< $@.work
	@$(STRIP) $@.work 2>/dev/null || true
	@mv -f $@.work $@
	@chmod 755 $@

clean:
	rm -rf $(BUILD)