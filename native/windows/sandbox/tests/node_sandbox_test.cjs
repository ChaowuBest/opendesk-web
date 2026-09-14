const fs = require('node:fs');
console.log(`node ${process.version} on ${process.platform}`);

// 尝试通过沙箱映射路径读家目录文件
for (const candidate of ['Z:\\C\\Users\\liyif\\opendesk_sandbox_write_test.txt',
                         'C:\\Users\\liyif\\opendesk_sandbox_write_test.txt']) {
    try {
        console.log(`read via ${candidate}:`, fs.readFileSync(candidate, 'utf8').trim());
    } catch (e) {
        console.log(`read via ${candidate} FAILED: ${e.code || e.name}: ${e.message.split('\n')[0]}`);
    }
}

// 写 D 盘根目录（原生路径与映射路径各试一次）
for (const target of ['D:\\opendesk_sandbox_node_result.txt',
                      'Z:\\D\\opendesk_sandbox_node_result.txt']) {
    try {
        fs.writeFileSync(target, `written by node in sandbox, pid=${process.pid}`);
        console.log(`write via ${target} OK`);
    } catch (e) {
        console.log(`write via ${target} FAILED: ${e.code || e.name}: ${e.message.split('\n')[0]}`);
    }
}
