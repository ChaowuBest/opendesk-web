import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const pkg: any = require('../../../../../package.json');

/**
 * Windows 安装包 better-sqlite3 回归守卫。
 *
 * 背景：@kenhkl/agent-gate（optionalDependencies better-sqlite3 ^12.10.0）与
 * @kenhkl/agent-moss（^11.0.0）各自嵌套安装的 better-sqlite3@12.x 通过
 * prebuild-install 按构建机系统 node ABI 编译出 build/Release/better_sqlite3.node。
 * 打包后 agent-gate 子进程实际可用的运行时是 Electron-as-node（ABI 与任何独立
 * node 版本都不同），dlopen 必然失败，用户侧表现为安装包报
 * "better-sqlite3 is not installed" 并回退/退出。
 *
 * 修复：npm overrides 用 $better-sqlite3 引用根 optionalDependencies 的声明，
 * 让两个子包去重（dedupe）到根 better-sqlite3@13.x（N-API prebuilds，跨 ABI）。
 *
 * 注意：对根直接依赖的包设置 override 时，npm 要求 override spec 与根依赖
 * spec 完全一致才会生效；硬编码版本（如 "13.0.3" vs 根的 "^13.0.3"）会被
 * npm 静默忽略——agent-moss 的 override 曾因此长期未生效。必须保持 $ 引用写法。
 *
 * 仓库不跟踪 package-lock.json，这里只验证可复现的依赖声明；安装产物中的
 * 实际去重与原生模块加载仍需在打包验收中验证。
 * 具体待办见 src/main/services/storage/STORAGE_ARCHITECTURE.md 的 Windows SQLite 发布验收清单。
 */

test('package.json overrides 对两个 @kenhkl 子包统一 better-sqlite3（$ 引用式，防 npm 静默忽略）', () => {
    const overrides = pkg.overrides ?? {};
    for (const scoped of ['@kenhkl/agent-gate', '@kenhkl/agent-moss']) {
        assert.equal(
            overrides[scoped]?.['better-sqlite3'],
            '$better-sqlite3',
            `${scoped} 的 better-sqlite3 override 必须保持 "$better-sqlite3" 引用式写法：` +
                '硬编码版本与根 optionalDependencies 的范围 spec 不一致时会被 npm 静默忽略'
        );
    }
});

test('根 optionalDependencies 必须声明 better-sqlite3（$ 引用式 override 的前提）', () => {
    assert.ok(
        pkg.optionalDependencies?.['better-sqlite3'],
        '$better-sqlite3 引用要求根声明该依赖，删除后 override 会失效'
    );
});
