# dynobox-linux build
CC      ?= gcc
# -Wno-nonnull-compare: the wrappers intentionally guard against NULL paths
# before forwarding to glibc, whose headers declare those params nonnull.
CFLAGS  ?= -O2 -g -Wall -Wextra -Wno-unused-parameter -Wno-nonnull-compare -fPIC -Isrc
LDFLAGS ?=
BUILD   ?= build

CORE_SRCS = src/policy.c src/pathmap.c src/ask.c src/cfgio.c src/util.c src/log.c src/mini_toml.c src/rawio_linux.c
LIB_SRCS  = $(CORE_SRCS) src/preload.c
CLI_SRCS  = $(CORE_SRCS) src/main.c src/endpoint.c

LIB = $(BUILD)/libdynobox.so
CLI = $(BUILD)/dynobox

.PHONY: all clean test unit
all: $(LIB) $(CLI)

$(LIB): $(LIB_SRCS) src/dynobox.h src/policy.h src/pathmap.h src/ask.h src/cfgio.h src/util.h src/log.h src/mini_toml.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -shared -o $@ $(LIB_SRCS) -ldl -lpthread $(LDFLAGS)

$(CLI): $(CLI_SRCS) src/dynobox.h src/policy.h src/pathmap.h src/ask.h src/cfgio.h src/util.h src/log.h src/mini_toml.h src/endpoint.h
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(CLI_SRCS) -lpthread $(LDFLAGS)

unit: tests/unit_policy.c $(CORE_SRCS)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $(BUILD)/unit_policy tests/unit_policy.c $(CORE_SRCS) -lpthread

tests: $(LIB) $(CLI) $(BUILD)/t_probe $(BUILD)/t_threads $(BUILD)/t_exec_chain $(BUILD)/t_net $(BUILD)/t_mmap $(BUILD)/t_dlopen $(BUILD)/t_adversarial $(BUILD)/t_stat_storm $(BUILD)/libadv_helper.so unit

$(BUILD)/t_adversarial: tests/t_adversarial.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ $< -ldl

# 对抗测试用的第三方库（由 t_adversarial 的 dlopen-lib 手段载入）
$(BUILD)/libadv_helper.so: tests/adv_helper.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -shared -o $@ $<

$(BUILD)/t_probe: tests/t_probe.c
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ $<

$(BUILD)/t_threads: tests/t_threads.c
	$(CC) $(CFLAGS) -o $@ $< -lpthread

$(BUILD)/t_exec_chain: tests/t_exec_chain.c
	$(CC) $(CFLAGS) -o $@ $<

$(BUILD)/t_net: tests/t_net.c
	$(CC) $(CFLAGS) -o $@ $<

$(BUILD)/t_mmap: tests/t_mmap.c
	$(CC) $(CFLAGS) -o $@ $<

$(BUILD)/t_dlopen: tests/t_dlopen.c
	$(CC) $(CFLAGS) -o $@ $< -ldl

# file stat 风暴压测探针（性能基线与退化记录见 tests/PERF.md）
$(BUILD)/t_stat_storm: tests/t_stat_storm.c
	$(CC) $(CFLAGS) -o $@ $<

# ---------------------------------------------------------------------------
# 运行时产物：把 dynobox + libdynobox.so 收敛到 runtime/<target>/。
#
# 产出的是**已瘦身并重新签名**的最小产物（体积约为带调试信息版本的三成）：
#   去旧签名 -> strip -> 重新签名
# ohos 工具链在链接时会自动自签名（ELF 带 .codesign 段），而 strip 等任何
# 二进制改写都会让签名失效，所以必须"先改后签"，且签名之后不再改动文件。
# 若签名工具不可用（非 OHOS 环境），自动退化为直接复制。
#
# main.c 的 find_preload_lib() 会在 dynobox **自身目录**旁查找
# libdynobox.so，所以两者必须同目录 —— 本目标的布局正好满足。
#
# 用法：  make runtime
#         make runtime RUNTIME_TARGET=x86_64-linux-gnu
# ---------------------------------------------------------------------------
RUNTIME_TARGET ?= aarch64-linux-ohos
RUNTIME_DIR    ?= runtime/$(RUNTIME_TARGET)
OBJCOPY        ?= llvm-objcopy
STRIP          ?= strip
SIGNTOOL       ?= binary-sign-tool

.PHONY: runtime
runtime: $(RUNTIME_DIR)/dynobox $(RUNTIME_DIR)/libdynobox.so
	@{ \
	  printf 'artifact:  dynobox + libdynobox.so (slimmed, re-signed)\n'; \
	  printf 'target:    %s\n' '$(RUNTIME_TARGET)'; \
	  printf 'git:       %s\n' "$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"; \
	  printf 'cc:        %s\n' "$$($(CC) --version 2>/dev/null | head -1)"; \
	  printf 'built:     %s\n' "$$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)"; \
	  printf 'pipeline:  strip -> binary-sign-tool sign -selfSign 1\n'; \
	  printf 'signature: self-signed (.codesign)；签名后请勿再改动文件\n'; \
	  printf 'layout:    dynobox resolves libdynobox.so relative to its own dir\n'; \
	} > $(RUNTIME_DIR)/BUILD-INFO.txt
	@echo "== $(RUNTIME_DIR) ==" && ls -l $(RUNTIME_DIR)

# 单个产物的瘦身 + 重新签名。顺序不可颠倒：ohos 工具链链接时已自动自签名，
# strip 等任何改写都会让签名失效，所以必须"先改后签"，签名后不再动文件。
$(RUNTIME_DIR)/dynobox $(RUNTIME_DIR)/libdynobox.so: $(RUNTIME_DIR)/%: $(BUILD)/%
	@mkdir -p $(RUNTIME_DIR)
	@cp -f $< $@.work
	@if readelf -S $@.work 2>/dev/null | grep -q '\.codesign'; then \
	    $(OBJCOPY) --remove-section=.codesign $@.work; \
	 fi
	@$(STRIP) $@.work
	@if command -v $(SIGNTOOL) >/dev/null 2>&1; then \
	    $(SIGNTOOL) sign -selfSign 1 -inFile $@.work -outFile $@ \
	        -signAlg SHA256withECDSA >/dev/null; \
	 else \
	    echo "  ($(SIGNTOOL) not found: keeping unsigned stripped artifact)"; \
	    cp -f $@.work $@; \
	 fi
	@rm -f $@.work
	@chmod 755 $@

clean:
	rm -rf $(BUILD) tests/work/audit.log
