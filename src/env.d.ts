/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 全局 ambient 模块声明（供 `npm run typecheck` 使用）。
 * 注意：本文件不能出现顶层 import/export（包括 `export {}`），否则整个文件
 * 变成模块，`declare module` 通配符将不再作为全局环境声明生效。
 * vite 的 ?raw / ?inline / ?asset 查询后缀导入在运行时由构建器处理，
 * 这里只需让 tsc 把它们识别为字符串模块。
 */

declare module '*?raw' {
    const content: string;
    export default content;
}

declare module '*?inline' {
    const content: string;
    export default content;
}

declare module '*?asset' {
    const path: string;
    export default path;
}

declare module '*.css' {
    const content: string;
    export default content;
}

/**
 * @bitclub.ai/opendesk-office 的 dist 直接携带原始 TS 源码且未提供类型入口，
 * 若不整体声明为 any，tsc 会把其内部 vendor 源码也纳入检查（数百条噪音）。
 * 类型检查范围先限定在 OpenDesk 自有代码，待该包补充 .d.ts 后再移除本 shim。
 */
declare module '@bitclub.ai/opendesk-office';
declare module '@bitclub.ai/opendesk-office/*';

/**
 * ace-builds 只发布 src-noconflict 下的运行时脚本，不带类型入口。
 * 项目对这些脚本全部是副作用导入（注册模式/主题），不使用其导出值，
 * 因此整体声明为 any 与运行时行为一致。待上游提供 .d.ts 后可移除本 shim。
 */
declare module 'ace-builds/src-noconflict/*';

/**
 * alpinejs 的 package main 指向 dist/module.cjs.js，未随包提供类型文件。
 * renderer 引导脚本只取默认导出的 Alpine 实例，先声明为 any 维持原状。
 */
declare module 'alpinejs';

/** marked-katex-extension 的发布包缺少其 types 入口指向的源码，补充实际使用的扩展签名。 */
declare module 'marked-katex-extension' {
    import type { KatexOptions } from 'katex';
    import type { MarkedExtension } from 'marked';

    export default function markedKatex(options?: KatexOptions & { nonStandard?: boolean }): MarkedExtension;
}

/**
 * search-index 未提供类型声明文件，其调用集中在 storage 层；
 * 先整体声明为 any，避免为局部用法臆造类型。
 */
declare module 'search-index';

/**
 * vite 的 import.meta.glob 在构建期展开为模块表；类型检查只需将其视为
 * path → 异步 loader 的记录（renderer 脚本以 tsc 检查、以 vite 构建）。
 */
interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
}
