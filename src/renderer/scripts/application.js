import Alpine from "alpinejs";

import '../components/loading.js';
import '../components/agentinput.js'
import '../components/taskview.js'
import '../components/splitter.js'

// 注意：Tagify、SweetAlert2 和 TinyMCE 现在通过 NPM 包管理
// 在各自需要的模块中直接 import 使用，不再需要全局加载

// 将 Alpine 暴露到全局作用域，以便 HTML 中的内联脚本可以访问
window.Alpine = Alpine;
Alpine.start();