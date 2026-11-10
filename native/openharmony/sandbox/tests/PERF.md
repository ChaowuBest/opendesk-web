# 鸿蒙真机性能基线（file stat 风暴）

对标 Windows 侧「`npm run test` 全量：宿主 92s；沙箱 117.5s（+27.7%）」的记录方式，
本文件记录 **纯属性访问（file stat）风暴** 下宿主与沙箱的吞吐对比与退化幅度。

## 环境

| 项 | 值 |
|---|---|
| 设备 | HUAWEI MateBook Fold 2in1（鸿蒙 PC） |
| 系统 | OpenHarmony 7.0.0.105 / HongMeng Kernel 1.13.0 / aarch64 / musl |
| 执行域 | `hishell_hap`（应用域，经 SSH 登录；ELF 需 `binary-sign-tool` 自签名） |
| 二进制 | 本仓库源码，DevEco NDK clang 15.0.4 交叉编译 → strip → 自签名 |
| 策略 | `net_default.toml`（`default=deny` + `dynobox-test/**` all-allow；**无缓存/无 ask**） |
| 探针 | `t_stat_storm <rounds> <path...>`：每条路径执行 `stat`/`lstat`/`access(F_OK)`/`realpath`/`open+close` 各 1 次 |
| 取样 | 每个场景宿主/沙箱各跑 3 轮，取中位 |

## 数据（2026-09-28）

### 场景 A：TREE 风暴（200 个文件 × 20 轮 × 5 ops = 20,000 次属性访问）

| 运行方式 | 耗时（中位） | 吞吐 | 相对宿主 |
|---|---|---|---|
| 宿主直跑 | 135.8 ms | ~147k ops/s | 1.00× |
| 沙箱内 | 742.2 ms | ~27k ops/s | **5.5× 慢（+447%）** |

### 场景 B：HOT 风暴（单文件 × 200,000 轮 × 5 ops = 1,000,000 次属性访问）

| 运行方式 | 耗时（中位） | 吞吐 | 相对宿主 |
|---|---|---|---|
| 宿主直跑 | 5448 ms | ~184k ops/s | 1.00× |
| 沙箱内 | 35033 ms | ~28.5k ops/s | **6.4× 慢（+543%）** |

## 退化分析

- 每次"属性访问进沙箱"的净增成本在两个场景下高度一致：**≈ +30 µs/次**
  （tree: (742.2−135.8)/20000 = 30.3 µs；hot: (35033−5448)/1e6 = 29.6 µs）。
- 宿主侧单次属性访问本身约 5.5 µs（HMDFS 属网络型 FS，本身比 ext4 慢）。
- 该成本主要来自每次调用的 `gate1x`：
  1. `dbox_plan_path` 逐组件 `readlinkat` 符号链接解析（本例路径约 6 层 → 6–12 次 syscall/次）；
  2. 规则表 glob 匹配（most-specific：按 specificity 降序，遇到更不具体的规则即提前结束）；
  3. 策略互斥锁 + 规范化；
  4. （`--tmp` 映射区不计入：直接放行，不做解析与匹配）。

## 与 Windows 侧口径差异

Windows 记录的 +27.7% 是**全量测试整体**耗时（含大量非 IO 部分，IO 摊薄）；
本文件的 +447%/+543% 是**纯属性 IO 微基准**（100% 走沙箱拦截路径），两者不矛盾：
前者反映"用户可感知的任务整体开销"，后者反映"单次属性访问的拦截成本"。

对实际使用的影响：构建/工具链类任务对 stat 的调用量在**万级**量级时，
按 +30 µs/次计约增加 0.3 s——可接受；百万级高频 stat 场景（如巨型 monorepo
全量索引）才会有可感知退化。

## 可选优化方向（2026-11-10 已全部实施，见下一节）

1. **静态判定缓存**：策略生命周期内不变，缓存 `(vpath, acc, allow_system) → allow/deny`，
   可消除重复的 glob 匹配（对 HOT 场景收益最大）。**注意**：只可缓存静态判定，
   不可缓存 ask 决策（会破坏 `cache_ttl_seconds=0` 的"每次询问"语义）。
2. **路径解析缓存**：缓存 `plan_path` 的符号链接解析结果。对 HOT 场景收益最大，
   但会引入符号链接重定向的 TOCTOU 窗口（安全方向：不会越权，总是打开已判定的同一目标；
   功能方向：链接改指向后不立即生效）。README 已声明 TOCTOU 为机制边界。
3. 减少热路径上的锁粒度（命中缓存时免锁）。

## 复现

```bash
make tests                       # 构建含 t_stat_storm 的测试产物
# 设备侧（家目录为唯一可写且需签名的位置，见 README「运行时产物」）：
#   生成 200 个文件 -> filelist，然后对照宿主/沙箱各跑 3 轮：
./t_stat_storm 20 $(tr '\n' ' ' < filelist)
./dynobox run --policy net_default.toml --cwd "$PWD" -- ./t_stat_storm 20 $(tr '\n' ' ' < filelist)
```

---

# 2026-11-10 热路径优化（规则预编译 + 解析前缀缓存）

## 背景

沙箱内 `tar -xzf` 解压（工具链包、SDK，数十万个小文件）比宿主慢一个数量级以上，
**即便策略已把目标树全部放通、没有任何 ask**。定位到 `gate1x` 每次拦截的三处固定成本：

1. **规则匹配**：每条规则每次判定都重新 `dbox_normpath(模式)` 并切分组件
   （约 `6 + 2×组件数` 次 malloc/free）；20 条规则 × 读/写两个类别 ≈ 数百次分配/次 open。
2. **路径解析**：逐组件 `fstatat` **绝对路径**（内核每次从根重走，O(n²)）+
   每组件 `strndup`，另有 `vpath`/`real` 两次 `strdup`。
3. **策略锁**：`gate_check` 对 read / write 两个类别各加解锁一次。

## 改动（判定语义不变）

| 项 | 实现 | 位置 |
|---|---|---|
| 规则预编译 | 加载完成后把每条规则的 glob 模式按组件预编译、预计算 specificity 并按降序排序；判定时只在栈上切分被判定路径（零堆分配），扫到"比已命中者更不具体"时提前结束 | `policy.c`: `dbox_policy_compile` / `dbox_policy_eval_static_ex` |
| 解析前缀缓存 | 缓存"从根到该目录每一级都是真实目录"的词法前缀（512 槽直接映射、TTL 500ms、seqlock 防撕裂）。命中时父目录直接取用，只对最后一个组件做一次 `fstatat` | `pathmap.c`: `pcache_put` / `pcache_hit` / `dbox_resolve_real` |
| 单次锁 | `gate_check` 对整个类别序列只加一次 `g_pol_mu` | `preload.c`: `check_one_locked` |
| 省拷贝 | identity namespace 下 `vpath`/`real` 指向同一块内存（`dbox_plan_path` 允许 `out_real = NULL`）；`write_parent_missing` 改用栈缓冲 | `preload.c`: `gate_resolve` / `gate_free` |

## 安全权衡

前缀缓存引入的窗口与 README 已声明的 TOCTOU 同性质：TTL 内某一级目录被替换成
符号链接时，解析沿用旧结论——最终打开的目标仍是此前判定过的同一路径，
**不产生越权**，只是"链接改指向"不立即生效。

最后组件**永远**实际 `fstatat`，因此 ENOENT / `O_NOFOLLOW` / 新建文件可见性
（`O_CREAT` 首次创建）语义完全不变；缓存只记录"解析结果 == 词法路径"的前缀，
不会把符号链接前缀误记成真实目录。

## 数据（同机同策略，3 轮中位）

策略：20 条规则（18 条无关 deny + 目标树 all-allow + 兜底 `/**` all-allow），
无 ask、无决策缓存——对应"决策已放通"的真实场景。

| 场景 | 宿主 | 旧版沙箱 | 新版沙箱 | 旧→新 |
|---|---|---|---|---|
| **tar 解压**（2000 × 1KB 文件 / 40 目录） | 803 ms | 15151 ms（18.9×） | **2135 ms（2.66×）** | **7.1×** |
| TREE 风暴（200 文件 × 20 轮 × 5 ops） | 480 ms | 2299 ms | **780 ms** | 2.9× |
| HOT 风暴（单文件 × 200000 轮 × 5 ops） | 22671 ms | 112452 ms | **36004 ms** | 3.1× |
| IOSTORM（3000 文件 open+write+close） | 500 ms | 1181 ms | **660 ms** | 1.8× |

单次属性访问净增：**91 µs → 15 µs**（剩余部分主要是必须的那次 `fstatat` 本身；
HMDFS 属网络型 FS，宿主单次约 5.5 µs）。

## 回归

- `tests/run_all.sh`：**167 pass / 5 fail，与优化前逐项一致**（5 项为既有环境限制：
  dlopen 签名、endpoint 网络、find、/proc），无新增失败；
- `unit_policy`：205 断言全通过（含 glob 匹配、specificity 优先级、配置往返）。

## 复现

```bash
make all tests CC=clang
# 新旧对照（旧版从 git 历史还原后另行构建）：
./build/dynobox run --policy tests/work/perf/perf20.toml --cwd "$PWD" \
    -- /bin/tar -xf tests/work/perf/fixture.tar -C tests/work/perf/out
# IO 风暴探针：
./build/t_io_storm <dir> 3000 2
./build/dynobox run --policy <policy> --cwd "$PWD" -- ./build/t_io_storm <dir> 3000 2
```

---

# 2026-11-10（续）跨平台预编译 API + 写路径捷径

## 1. 把"预编译匹配"下沉为 core 公共 API

上一轮只在 Linux/OpenHarmony 的 `dbox_policy_eval_static_ex` 里做了快路径，
macOS 的 `boxdylib` 与 Windows 的 `Policy` 各自遍历规则，享受不到。现在由 core 导出：

```c
typedef struct dbox_glob dbox_glob_t;
dbox_glob_t *dbox_glob_compile(const char *pattern);          // 装载时一次
int   dbox_glob_match_compiled(const dbox_glob_t *, const char *path);
size_t dbox_glob_specificity(const dbox_glob_t *);
void  dbox_glob_free(dbox_glob_t *);
```

三平台接入点：

| 平台 | 接入方式 |
|---|---|
| Linux / OpenHarmony | `dbox_rule_t` 持有 `dbox_glob_t *`（`policy.c`），判定循环内联切分一次路径 |
| macOS | `PolicyRule` 增加 `glob` + `base_len`（`boxdylib.c`），`policy_lookup_detailed` 用编译版，特异性不再每次重算 |
| Windows | `Rule` 增加 `CoreGlob`（`std::shared_ptr`，`core_policy.*`），`Rule::matches` 用编译版；保留既有字面前缀预筛，vpath 每次只转换/小写一次 |

Windows 侧用 `shared_ptr` 是因为 `std::vector<Rule>` 会拷贝/移动元素；
编译失败（OOM）返回空句柄，两平台都回退到逐次解析，行为不变。

## 2. 写路径捷径复用目录缓存

`write_parent_missing`（写打开前的父链缺失探测）此前每次做一次独立 `fstatat`，
而它探测的正是刚被解析验证过的父目录。现在先查目录前缀缓存（`dbox_dir_cache_hit`，
同时支持相对路径拼 cwd），命中即免掉这次 syscall。

语义方向是安全的：命中只用于**跳过无副作用的探测**（父目录存在与否只影响是否
需要 ask，实际写仍由内核给出权威错误）；TTL 内目录被替换时最坏是多一次 ask。

注意 `mkdir_target_exists` **不能**用这个捷径（见下节"审查修正"）。

## 3. 数据（3 轮中位）

| 场景 | 宿主 | 上一轮 | 本轮（含安全校验） |
|---|---|---|---|
| tar 解压（2000 × 1KB / 40 目录） | 762 ms | 2127 ms | **2452 ms（3.2×）** |
| IOSTORM（3000 文件 open+write+close） | 500 ms | 660 ms | **750 ms** |

相比最初的 15151 ms / 1181 ms 仍是 **6.2× / 1.6×** 的提升。

加安全校验（父目录 NOFOLLOW 复验，见下）后比纯缓存版回退 ~12-17%，这是
"每次判定多 1 次 `fstatat`"的代价——换来与完整解析等价的符号链接语义。

## 4. 审查修正（第二次 review）

| 问题 | 性质 | 处置 |
|---|---|---|
| `check_one_locked` 在持有 `g_pol_mu` 时调用 `dbox_logf` | 合并锁引入的**性能回归**（`--log -v` 下每次 allow 都持全局策略锁做 write） | 拆分判定/日志，日志与 errno 全部移到锁外 |
| `dbox_resolve_real` 快路径 `strcpy(out, parent)` 未校验 `outsz` | 公共 API 的**栈溢出**风险 | 按 `outsz` 校验后 memcpy |
| 新增 4KB 栈缓冲（eval / glob_match_compiled / resolve） | 放大信号处理器重入的**栈溢出**风险（README A.3） | 收敛到 1KB / 256B，超长回退 |
| pcache seqlock 无内存屏障 | aarch64 弱内存序下的**数据竞争** | `__atomic` RELEASE/ACQUIRE；哨兵改 -1 |
| `mkdir_target_exists` 用目录缓存 | **ask 绕过**：缓存误判"目标已存在"时，本该 ask 的 mkdir 被只做 deny 判定就透传给内核真实创建 | 移除捷径，恢复真实 stat |
| 目录缓存让"符号链接替换"绕过 deny | **越权读取**：TTL 内把 allow 目录换成指向 deny 区的链接，策略按旧解析判定而内核按新目标打开 | 命中后对父目录做 NOFOLLOW 复验（必须仍是实体目录）；TTL 500→200ms |
| `dbox_policy_eval_static_ex` 快路径未排除 `vpath == NULL` | **空指针解引用**（公共 API 传入 NULL 时；旧路径返回"不匹配"） | 快路径显式要求 `vpath` 非空，NULL 走旧路径 |
| `dbox_policy_free` 的 memset 把 `default_perm` 置 0（= ALLOW） | **fail-open** 隐患（释放后被误用时默认放行） | 显式落回 `PERM_DENY` |

第 6 项已固化为回归探针 `t_probe pcache_symlink`（`run_all.sh` 中
"目录缓存命中后仍按当前解析判定"）：同一进程内先读 allow 区文件填充缓存，
再把该目录 rename 走并换成指向 deny 区的符号链接，原路径访问必须仍被拒。
曾临时移除校验验证该探针确实能抓到越权（输出 `PROBE-FAIL ... bypassed deny`）。

## 5. 验证

- `unit_policy`：**233 断言**（含编译版 glob 与逐次解析版全组合一致、specificity
  与排序语义、旧路径对照）；
- `tests/run_all.sh`：**168 pass / 5 fail**（5 项为既有环境限制），新增缓存安全断言；
- macOS / Windows 侧本机无工具链，仅做静态审查，需在对应平台复核
  （`npm run build-sandbox:darwin`、`nmake /f Makefile`）。
