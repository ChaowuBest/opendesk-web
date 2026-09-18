# dynobox-linux build
CC      ?= gcc
# -Wno-nonnull-compare: the wrappers intentionally guard against NULL paths
# before forwarding to glibc, whose headers declare those params nonnull.
CFLAGS  ?= -O2 -g -Wall -Wextra -Wno-unused-parameter -Wno-nonnull-compare -fPIC -Isrc
LDFLAGS ?=
BUILD   ?= build

CORE_SRCS = src/policy.c src/pathmap.c src/ask.c src/cfgio.c src/util.c src/log.c src/mini_toml.c
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

tests: $(LIB) $(CLI) $(BUILD)/t_probe $(BUILD)/t_threads $(BUILD)/t_exec_chain $(BUILD)/t_net $(BUILD)/t_mmap $(BUILD)/t_dlopen unit

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

clean:
	rm -rf $(BUILD) tests/work/audit.log
