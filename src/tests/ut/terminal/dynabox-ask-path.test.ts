import { virtualPathToHostPath } from '../../../main/applications/terminal/sandboxes/ask-path.js';

test('ask path: converts single-drive virtual paths to host paths', () => {
    // ask 协议中路径恒为 "/盘符/..." 正斜杠形式（原生侧已归一化）
    expect(virtualPathToHostPath('/C/Users/liyif/a.txt')).toBe('C:/Users/liyif/a.txt');
    expect(virtualPathToHostPath('/c/work')).toBe('C:/work');
    expect(virtualPathToHostPath('/D/data/x.bin')).toBe('D:/data/x.bin');
    expect(virtualPathToHostPath('/C')).toBe('C:/');
    expect(virtualPathToHostPath('/C/')).toBe('C:/');
    expect(virtualPathToHostPath('/C/中文 目录/文件.txt')).toBe('C:/中文 目录/文件.txt');
});

test('ask path: rejects malformed virtual paths (fail-closed)', () => {
    // 首段不是单字母盘符（多字母段属于合成容器，无宿主对应）
    expect(virtualPathToHostPath('/NET/share')).toBeNull();
    expect(virtualPathToHostPath('/CORS/rules')).toBeNull();
    // 空路径与缺盘符段
    expect(virtualPathToHostPath('')).toBeNull();
    // 含非法字符
    expect(virtualPathToHostPath('/C/a:b')).toBeNull();
    expect(virtualPathToHostPath('/C/a*b')).toBeNull();
    // 遍历段
    expect(virtualPathToHostPath('/C/a/../b')).toBeNull();
    expect(virtualPathToHostPath('/C/./b')).toBeNull();
    // 控制字符
    expect(virtualPathToHostPath('/C/a\nb')).toBeNull();
});
