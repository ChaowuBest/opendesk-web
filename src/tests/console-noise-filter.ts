// Jest 通过 setupFilesAfterEnv 在每个测试文件加载前执行本模块。
//
// KaTeX 在模块加载时检查 document.compatMode：测试环境的 DOM shim 没有
// doctype 概念，永远处于 "quirks mode"，于是每个测试文件首次加载 katex
// 都会打印一条 "KaTeX doesn't work in quirks mode" 警告。该告警与被测
// 行为无关（katex 在无样式环境下本就走降级渲染路径，测试断言不依赖它），
// 在这里统一过滤这一条已知噪音；其余 console 输出原样透传，避免误吞
// 测试自身打印的诊断信息。
//
// 注意：本文件必须保持纯 JS 语法（不使用 TS 专属语法）。setupFilesAfterEnv
// 走 jest 的同步 ESM 加载路径，不经过 ts-jest 转换，TS 语法会以原始文本
// 进入 vm SourceTextModule 直接抛 SyntaxError。

const KATEX_QUIRKS_MODE_WARNING = "Warning: KaTeX doesn't work in quirks mode.";
const FILTER_FLAG = '__opendeskKatexNoiseFiltered';

if (!globalThis[FILTER_FLAG]) {
    globalThis[FILTER_FLAG] = true;
    const originalWarn = console.warn.bind(console);
    console.warn = (...args) => {
        if (typeof args[0] === 'string' && args[0].includes(KATEX_QUIRKS_MODE_WARNING)) {
            return;
        }
        originalWarn(...args);
    };
}
