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

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Package {
    platform: 'win32' | 'darwin';
    arch: 'x64' | 'arm64';
    version: string;
    url: string;
    hash: string;
    size: number;
    createdAt: string;
    updatedAt: string;
}

export interface UpdateServerConfig {
    port: number;
    host: string;
    packagesDir: string;
    baseUrl?: string;
    basePath?: string; // API 的基础路径，例如 '/update'
}

export class UpdateServer {
    private packages: Map<string, Package> = new Map();
    private config: Required<UpdateServerConfig>;
    private server: http.Server;
    private scanInterval: NodeJS.Timeout | null = null;
    private loadedJsonFiles: Map<string, number> = new Map(); // 文件路径 -> 最后修改时间戳

    constructor(config: UpdateServerConfig) {
        // 规范化 basePath：确保以 / 开头，不以 / 结尾（除非是根路径）
        const basePath = config.basePath
            ? config.basePath.startsWith('/')
                ? config.basePath === '/'
                    ? ''
                    : config.basePath.replace(/\/$/, '')
                : '/' + config.basePath.replace(/\/$/, '')
            : '';

        this.config = {
            port: config.port,
            host: config.host,
            packagesDir: config.packagesDir,
            baseUrl: config.baseUrl || `http://${config.host}:${config.port}${basePath}`,
            basePath: basePath
        };

        // 确保包目录存在
        if (!fs.existsSync(this.config.packagesDir)) {
            fs.mkdirSync(this.config.packagesDir, { recursive: true });
        }

        // 初始加载包信息
        this.scanPackages();

        // 创建服务器
        this.server = http.createServer(this.handleRequest.bind(this));
    }

    /**
     * 扫描目录中的所有 JSON 文件并加载包信息
     */
    private scanPackages(): void {
        try {
            const files = fs.readdirSync(this.config.packagesDir);
            const jsonFiles = files.filter((f) => f.endsWith('.json'));

            for (const jsonFile of jsonFiles) {
                const jsonPath = path.join(this.config.packagesDir, jsonFile);

                try {
                    const stats = fs.statSync(jsonPath);
                    const content = fs.readFileSync(jsonPath, 'utf-8');
                    const pkg: Package = JSON.parse(content);

                    // 验证包信息格式
                    if (pkg.platform && pkg.arch && pkg.version && pkg.hash && pkg.size !== undefined) {
                        const key = this.getPackageKey(pkg.platform, pkg.arch, pkg.version);
                        const existingPkg = this.packages.get(key);

                        // 检查文件修改时间
                        const fileModifiedTime = stats.mtime.getTime();
                        const lastLoadedTime = this.loadedJsonFiles.get(jsonPath) || 0;

                        // 如果是新文件或文件已更新，重新加载
                        if (fileModifiedTime > lastLoadedTime) {
                            // 更新 URL（如果 JSON 中的 URL 不完整，使用 baseUrl 生成）
                            if (!pkg.url || !pkg.url.startsWith('http')) {
                                const fileName = path.basename(jsonFile, '.json');
                                // 尝试找到对应的安装包文件
                                const possibleExtensions = ['.exe', '.msi', '.dmg'];
                                let packageFile: string | null = null;
                                for (const ext of possibleExtensions) {
                                    const filePath = path.join(this.config.packagesDir, fileName + ext);
                                    if (fs.existsSync(filePath)) {
                                        packageFile = path.basename(filePath);
                                        break;
                                    }
                                }
                                if (packageFile) {
                                    // 生成包的下载 URL
                                    // 如果 baseUrl 已经以 basePath 结尾，直接使用；否则组合两者
                                    let baseUrl = this.config.baseUrl;
                                    if (this.config.basePath && !baseUrl.endsWith(this.config.basePath)) {
                                        // 确保 baseUrl 不以 / 结尾，basePath 以 / 开头
                                        baseUrl = baseUrl.replace(/\/$/, '') + this.config.basePath;
                                    }
                                    pkg.url = `${baseUrl}/packages/${packageFile}`;
                                }
                            }

                            // 如果文件被修改，使用文件修改时间作为 updatedAt（如果 JSON 中没有或更旧）
                            const fileUpdatedAt = new Date(fileModifiedTime).toISOString();
                            if (!pkg.updatedAt || new Date(pkg.updatedAt).getTime() < fileModifiedTime) {
                                pkg.updatedAt = fileUpdatedAt;
                            }

                            this.packages.set(key, pkg);
                            this.loadedJsonFiles.set(jsonPath, fileModifiedTime);

                            if (existingPkg) {
                                console.log(`已更新包信息: ${jsonFile}`);
                            } else {
                                console.log(`已加载包信息: ${jsonFile}`);
                            }
                        }
                    } else {
                        console.warn(`跳过无效的包信息文件: ${jsonFile}`);
                    }
                } catch (error) {
                    console.error(`加载包信息文件失败 ${jsonFile}:`, error);
                }
            }
        } catch (error) {
            console.error('扫描包目录失败:', error);
        }
    }

    /**
     * 启动定时扫描
     */
    startScanning(): void {
        // 每5秒扫描一次
        this.scanInterval = setInterval(() => {
            this.scanPackages();
        }, 5000);
    }

    /**
     * 停止定时扫描
     */
    stopScanning(): void {
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
    }

    /**
     * 生成包的唯一键
     */
    private getPackageKey(platform: string, arch: string, version: string): string {
        return `${platform}-${arch}-${version}`;
    }

    /**
     * 计算文件的 SHA256 哈希值
     */
    private async calculateHash(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }

    /**
     * 获取指定平台和架构的最新版本
     */
    getLatestVersion(platform: string, arch: string): Package | null {
        const matchingPackages = Array.from(this.packages.values()).filter(
            (pkg) => pkg.platform === platform && pkg.arch === arch
        );

        if (matchingPackages.length === 0) {
            return null;
        }

        // 按版本号排序（简单比较，实际应该使用 semver）
        matchingPackages.sort((a, b) => {
            return b.version.localeCompare(a.version, undefined, {
                numeric: true,
                sensitivity: 'base'
            });
        });

        return matchingPackages[0];
    }

    /**
     * 获取所有包列表
     */
    getAllPackages(): Package[] {
        return Array.from(this.packages.values());
    }

    /**
     * 获取所有包的最新更新时间
     */
    private getLatestUpdatedAt(): string {
        const packages = Array.from(this.packages.values());
        if (packages.length === 0) {
            return new Date().toISOString();
        }

        // 找到所有包中最新的 updatedAt
        const dates = packages.map((pkg) => new Date(pkg.updatedAt).getTime());
        const latestTimestamp = Math.max(...dates);
        return new Date(latestTimestamp).toISOString();
    }

    /**
     * 处理 HTTP 请求
     */
    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        // 设置 CORS 头
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // 去掉 basePath 前缀来匹配路由
        let pathname = url.pathname;
        if (this.config.basePath && pathname.startsWith(this.config.basePath)) {
            pathname = pathname.substring(this.config.basePath.length) || '/';
        }

        // API 路由
        if (pathname === '/api/latest' && req.method === 'GET') {
            const platform = url.searchParams.get('platform') || '';
            const arch = url.searchParams.get('arch') || '';
            const latest = this.getLatestVersion(platform, arch);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', data: latest }));
            return;
        }

        if (pathname === '/api/packages' && req.method === 'GET') {
            const packages = this.getAllPackages();
            const latestUpdatedAt = this.getLatestUpdatedAt();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    status: 'ok',
                    data: packages,
                    updatedAt: latestUpdatedAt
                })
            );
            return;
        }

        // 下载包文件
        if (pathname.startsWith('/packages/') && req.method === 'GET') {
            const fileName = path.basename(pathname);
            const filePath = path.join(this.config.packagesDir, fileName);

            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('文件未找到');
                return;
            }

            const stats = fs.statSync(filePath);
            const fileStream = fs.createReadStream(filePath);

            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': stats.size,
                'Content-Disposition': `attachment; filename="${fileName}"`
            });

            fileStream.pipe(res);
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('未找到');
    }

    /**
     * 启动服务器
     */
    start(): Promise<void> {
        return new Promise((resolve) => {
            this.server.listen(this.config.port, this.config.host, () => {
                console.log(`更新服务器已启动: http://${this.config.host}:${this.config.port}`);
                console.log(`包目录: ${this.config.packagesDir}`);
                console.log(`已加载 ${this.packages.size} 个包`);
                // 启动定时扫描
                this.startScanning();
                resolve();
            });
        });
    }

    /**
     * 停止服务器
     */
    stop(): Promise<void> {
        // 停止定时扫描
        this.stopScanning();

        return new Promise((resolve) => {
            this.server.close(() => {
                console.log('更新服务器已停止');
                resolve();
            });
        });
    }
}

/**
 * 打印帮助信息
 */
function printHelp(): void {
    console.log('OpenDesk 更新服务器');
    console.log('');
    console.log('用法:');
    console.log('  tsx src/updater/server.ts [选项] --directory <directory>');
    console.log('');
    console.log('必需参数:');
    console.log('  --directory <path>    安装包和 JSON 元数据文件的存储目录');
    console.log('');
    console.log('可选参数:');
    console.log('  --host <host>        服务器监听的主机地址 (默认: 0.0.0.0)');
    console.log('  --port <port>        服务器监听的端口号 (默认: 3000)');
    console.log('  --base-path <path>   API 的基础路径，例如 /update (默认: 空，即根路径)');
    console.log('  -h, --help           显示此帮助信息');
    console.log('');
    console.log('示例:');
    console.log('  tsx src/updater/server.ts --directory ./packages');
    console.log('  tsx src/updater/server.ts --host localhost --port 8080 --directory ./packages');
    console.log('  tsx src/updater/server.ts --directory /var/www/updates/packages');
    console.log('');
    console.log('说明:');
    console.log('  - 服务器会自动扫描指定目录中的所有 .json 文件');
    console.log('  - 每 5 秒自动扫描一次，发现新的 JSON 文件会自动加载');
    console.log('  - 不需要手动维护 manifest.json，服务器会自动组合所有 JSON 文件');
}

/**
 * 解析命令行参数
 */
function parseCommandLineArgs(): {
    host: string;
    port: number;
    directory: string;
    basePath?: string;
} | null {
    const args = process.argv.slice(2);
    let host: string | null = null;
    let port: number | null = null;
    let directory: string | null = null;
    let basePath: string | null = null;

    // 检查帮助参数
    for (const arg of args) {
        if (arg === '-h' || arg === '--help') {
            printHelp();
            return null;
        }
    }

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--host' && i + 1 < args.length) {
            host = args[i + 1];
            i++;
        } else if (args[i] === '--port' && i + 1 < args.length) {
            port = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--directory' && i + 1 < args.length) {
            directory = args[i + 1];
            i++;
        } else if (args[i] === '--base-path' && i + 1 < args.length) {
            basePath = args[i + 1];
            i++;
        }
    }

    // directory 是必需的
    if (!directory) {
        console.error('错误: 缺少必需的参数 --directory');
        console.error('');
        printHelp();
        return null;
    }

    // host 和 port 有默认值
    const finalHost = host || '0.0.0.0';
    const finalPort = port || 3000;

    // 验证端口号
    if (port !== null && (isNaN(port) || port < 1 || port > 65535)) {
        console.error('错误: 端口号必须是 1-65535 之间的数字');
        return null;
    }

    return {
        host: finalHost,
        port: finalPort,
        directory,
        ...(basePath !== null && { basePath })
    };
}

// 如果直接运行此文件，启动服务器
// 检查是否作为主模块运行（支持 node、tsx 等）
const isMainModule = (() => {
    // 获取当前文件的路径
    const currentFile = fileURLToPath(import.meta.url);
    // 获取执行的文件路径
    const executedFile = process.argv[1];

    // 检查是否匹配（支持绝对路径和相对路径）
    return (
        currentFile === executedFile ||
        currentFile.endsWith(executedFile) ||
        executedFile?.endsWith('server.ts') ||
        executedFile?.endsWith('server.js')
    );
})();

if (isMainModule) {
    const config = parseCommandLineArgs();
    if (!config) {
        process.exit(1);
    }

    const server = new UpdateServer({
        host: config.host,
        port: config.port,
        packagesDir: config.directory,
        ...(config.basePath && { basePath: config.basePath })
    });

    server.start().catch(console.error);

    // 优雅关闭
    process.on('SIGINT', async () => {
        await server.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await server.stop();
        process.exit(0);
    });
}
