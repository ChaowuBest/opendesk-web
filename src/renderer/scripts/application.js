import Alpine from "alpinejs";

import '../components/loading.js';
import '../components/agentinput.js'
import '../components/taskview.js'

// 将 Alpine 暴露到全局作用域，以便 HTML 中的内联脚本可以访问
window.Alpine = Alpine;
Alpine.start();