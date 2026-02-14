#!/usr/bin/env node

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

import { app, dialog, shell, session } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { Transform } from 'stream';
import { spawn } from 'child_process';

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

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  package: Package | null;
}

export interface UpdateClientConfig {
  serverUrls: string[]; // 多个备选服务器地址，按顺序尝试
  currentVersion: string;
  platform?: string;
  arch?: string;
  downloadDir?: string;
  checkInterval?: number; // 检查间隔（毫秒），0 表示不自动检查
}

export class UpdateClient {
  private config: Required<UpdateClientConfig>;
  private checkIntervalId: NodeJS.Timeout | null = null;

  constructor(config: UpdateClientConfig) {
    this.config = {
      serverUrls: config.serverUrls || [],
      currentVersion: config.currentVersion,
      platform: config.platform || process.platform,
      arch: config.arch || process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x64',
      downloadDir: config.downloadDir || path.join(app.getPath('userData'), 'updates'),
      checkInterval: config.checkInterval || 0,
    };

    if (this.config.serverUrls.length === 0) {
      throw new Error('至少需要提供一个服务器地址');
    }

    // 确保下载目录存在
    if (!fs.existsSync(this.config.downloadDir)) {
      fs.mkdirSync(this.config.downloadDir, { recursive: true });
    }
  }

  /**
   * 解析系统代理设置
   * 返回代理配置对象，如果没有代理则返回 null
   */
  private async resolveSystemProxy(url: string): Promise<{ host: string; port: number; protocol: 'http' | 'https' | 'socks5' } | null> {
    try {
      // 使用 Electron 的 session.resolveProxy 获取系统代理
      const proxyString = await session.defaultSession.resolveProxy(url);

      if (!proxyString || proxyString === 'DIRECT') {
        return null;
      }

      // 解析代理字符串，格式可能是：
      // "PROXY host:port"
      // "HTTPS host:port"
      // "SOCKS5 host:port"
      // "PROXY host:port; HTTPS host:port" (多个代理，用分号分隔)
      const parts = proxyString.split(';');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('PROXY ')) {
          const proxyUrl = trimmed.substring(6).trim();
          const [host, port] = proxyUrl.split(':');
          if (host && port) {
            return {
              host: host.trim(),
              port: parseInt(port.trim(), 10),
              protocol: 'http',
            };
          }
        } else if (trimmed.startsWith('HTTPS ')) {
          const proxyUrl = trimmed.substring(6).trim();
          const [host, port] = proxyUrl.split(':');
          if (host && port) {
            return {
              host: host.trim(),
              port: parseInt(port.trim(), 10),
              protocol: 'https',
            };
          }
        } else if (trimmed.startsWith('SOCKS5 ')) {
          const proxyUrl = trimmed.substring(7).trim();
          const [host, port] = proxyUrl.split(':');
          if (host && port) {
            return {
              host: host.trim(),
              port: parseInt(port.trim(), 10),
              protocol: 'socks5',
            };
          }
        }
      }
    } catch (error) {
      console.warn('解析系统代理失败:', error);
    }

    return null;
  }

  /**
   * 比较版本号
   * 返回: 1 表示 version1 > version2, -1 表示 version1 < version2, 0 表示相等
   */
  private compareVersions(version1: string, version2: string): number {
    const v1parts = version1.split('.').map(Number);
    const v2parts = version2.split('.').map(Number);
    const maxLength = Math.max(v1parts.length, v2parts.length);

    for (let i = 0; i < maxLength; i++) {
      const v1part = v1parts[i] || 0;
      const v2part = v2parts[i] || 0;

      if (v1part > v2part) return 1;
      if (v1part < v2part) return -1;
    }

    return 0;
  }

  /**
   * 发送 HTTP/HTTPS 请求（支持代理）
   */
  private async httpRequest(url: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        const urlObj = new URL(url);
        const proxy = await this.resolveSystemProxy(url);

        // 如果没有代理，直接连接
        if (!proxy) {
          const client = urlObj.protocol === 'https:' ? https : http;
          client
            .get(url, (res) => {
              if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                return;
              }

              let data = '';
              res.on('data', (chunk) => {
                data += chunk;
              });
              res.on('end', () => {
                resolve(data);
              });
            })
            .on('error', reject);
          return;
        }

        // 使用代理连接
        if (proxy.protocol === 'http' || proxy.protocol === 'https') {
          // HTTP/HTTPS 代理
          const proxyClient = proxy.protocol === 'https' ? https : http;

          // 对于 HTTP 请求，通过代理发送完整 URL
          // 对于 HTTPS 请求，使用 CONNECT 方法建立隧道
          if (urlObj.protocol === 'https:') {
            // HTTPS 通过 HTTP 代理：使用 CONNECT 方法
            const options = {
              hostname: proxy.host,
              port: proxy.port,
              method: 'CONNECT',
              path: `${urlObj.hostname}:${urlObj.port || 443}`,
              headers: {
                'Host': `${urlObj.hostname}:${urlObj.port || 443}`,
                'Proxy-Connection': 'keep-alive',
              },
            };

            const req = proxyClient.request(options);
            req.on('connect', (res, socket, head) => {
              if (res.statusCode !== 200) {
                reject(new Error(`代理连接失败: ${res.statusCode}`));
                return;
              }

              // 通过隧道发送 HTTPS 请求
              const client = https.request({
                ...({ socket: socket } as any),
                method: 'GET',
                path: urlObj.pathname + urlObj.search,
                headers: {
                  'Host': urlObj.host,
                },
              }, (res) => {
                if (res.statusCode !== 200) {
                  reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                  return;
                }

                let data = '';
                res.on('data', (chunk) => {
                  data += chunk;
                });
                res.on('end', () => {
                  resolve(data);
                });
              });

              client.on('error', reject);
              client.end();
            });

            req.on('error', reject);
            req.end();
          } else {
            // HTTP 通过 HTTP 代理：直接转发请求
            const options = {
              hostname: proxy.host,
              port: proxy.port,
              method: 'GET',
              path: url,
              headers: {
                'Host': urlObj.host,
              },
            };

            proxyClient
              .request(options, (res) => {
                if (res.statusCode !== 200) {
                  reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                  return;
                }

                let data = '';
                res.on('data', (chunk) => {
                  data += chunk;
                });
                res.on('end', () => {
                  resolve(data);
                });
              })
              .on('error', reject)
              .end();
          }
        } else {
          // SOCKS5 代理暂不支持，回退到直连
          console.warn(`不支持的代理类型: ${proxy.protocol}，使用直连`);
          const client = urlObj.protocol === 'https:' ? https : http;
          client
            .get(url, (res) => {
              if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                return;
              }

              let data = '';
              res.on('data', (chunk) => {
                data += chunk;
              });
              res.on('end', () => {
                resolve(data);
              });
            })
            .on('error', reject);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 检查更新（尝试所有备选服务器地址）
   */
  async checkForUpdate(): Promise<UpdateCheckResult> {
    let lastError: Error | null = null;

    // 按顺序尝试所有服务器地址
    for (const serverUrl of this.config.serverUrls) {
      try {
        const url = `${serverUrl}/api/latest?platform=${this.config.platform}&arch=${this.config.arch}`;
        const response = await this.httpRequest(url);
        const result = JSON.parse(response);

        if (result.status !== 'ok' || !result.data) {
          // 服务器返回了响应但没有数据，继续尝试下一个
          continue;
        }

        const latestPackage: Package = result.data;
        const hasUpdate = this.compareVersions(latestPackage.version, this.config.currentVersion) > 0;

        return {
          hasUpdate,
          currentVersion: this.config.currentVersion,
          latestVersion: latestPackage.version,
          package: hasUpdate ? latestPackage : null,
        };
      } catch (error) {
        // 记录错误，继续尝试下一个服务器
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`检查更新失败 (${serverUrl}):`, lastError.message);
        continue;
      }
    }

    // 所有服务器都失败了
    console.error('所有更新服务器都无法访问，最后错误:', lastError);
    return {
      hasUpdate: false,
      currentVersion: this.config.currentVersion,
      latestVersion: null,
      package: null,
    };
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
   * 下载文件（支持代理）
   */
  private async downloadFile(url: string, destPath: string, onProgress?: (progress: number) => void): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        const urlObj = new URL(url);
        const proxy = await this.resolveSystemProxy(url);

        // 设置更大的缓冲区以提高下载速度
        const file = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 }); // 1MB 缓冲区
        const hasError = { value: false };

        // 如果没有代理，使用原来的逻辑
        if (!proxy || proxy.protocol === 'socks5') {
          if (proxy && proxy.protocol === 'socks5') {
            console.warn('SOCKS5 代理暂不支持，使用直连');
          }

          const client = urlObj.protocol === 'https:' ? https : http;

          // 设置 HTTP 请求选项，包括请求头和 keep-alive
          const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
              'User-Agent': 'FillipDesk-Updater/1.0',
              'Accept': '*/*',
              'Connection': 'keep-alive',
            },
          };

          const req = client.request(options, (res) => {
            this.handleDownloadResponse(res, file, destPath, onProgress, resolve, reject, hasError);
          });

          req.on('error', (error) => {
            hasError.value = true;
            file.close();
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath);
            }
            reject(error);
          });

          req.end();
          return;
        }

        // 使用 HTTP/HTTPS 代理
        const proxyClient = proxy.protocol === 'https' ? https : http;

        if (urlObj.protocol === 'https:') {
          // HTTPS 通过 HTTP 代理：使用 CONNECT 方法建立隧道
          const connectOptions = {
            hostname: proxy.host,
            port: proxy.port,
            method: 'CONNECT',
            path: `${urlObj.hostname}:${urlObj.port || 443}`,
            headers: {
              'Host': `${urlObj.hostname}:${urlObj.port || 443}`,
              'Proxy-Connection': 'keep-alive',
            },
          };

          const connectReq = proxyClient.request(connectOptions);
          connectReq.on('connect', (res, socket, head) => {
            if (res.statusCode !== 200) {
              hasError.value = true;
              file.close();
              if (fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
              }
              reject(new Error(`代理连接失败: ${res.statusCode}`));
              return;
            }

            // 通过隧道发送 HTTPS 请求
            const options = {
              ...({ socket: socket } as any),
              method: 'GET',
              path: urlObj.pathname + urlObj.search,
              headers: {
                'Host': urlObj.host,
                'User-Agent': 'FillipDesk-Updater/1.0',
                'Accept': '*/*',
                'Connection': 'keep-alive',
              },
            };

            const req = https.request(options, (res) => {
              this.handleDownloadResponse(res, file, destPath, onProgress, resolve, reject, hasError);
            });

            req.on('error', (error) => {
              hasError.value = true;
              file.close();
              if (fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
              }
              reject(error);
            });

            req.end();
          });

          connectReq.on('error', (error) => {
            hasError.value = true;
            file.close();
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath);
            }
            reject(error);
          });

          connectReq.end();
        } else {
          // HTTP 通过 HTTP 代理：直接转发请求
          const options = {
            hostname: proxy.host,
            port: proxy.port,
            method: 'GET',
            path: url,
            headers: {
              'Host': urlObj.host,
              'User-Agent': 'FillipDesk-Updater/1.0',
              'Accept': '*/*',
              'Connection': 'keep-alive',
            },
          };

          const req = proxyClient.request(options, (res) => {
            this.handleDownloadResponse(res, file, destPath, onProgress, resolve, reject, hasError);
          });

          req.on('error', (error) => {
            hasError.value = true;
            file.close();
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath);
            }
            reject(error);
          });

          req.end();
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 处理下载响应（处理进度跟踪和文件写入）
   */
  private handleDownloadResponse(
    res: http.IncomingMessage,
    file: fs.WriteStream,
    destPath: string,
    onProgress: ((progress: number) => void) | undefined,
    resolve: () => void,
    reject: (error: Error) => void,
    hasError: { value: boolean }
  ): void {
    if (res.statusCode !== 200) {
      file.close();
      fs.unlinkSync(destPath);
      reject(new Error(`下载失败: HTTP ${res.statusCode}`));
      return;
    }

    const totalSize = parseInt(res.headers['content-length'] || '0', 10);
    let downloadedSize = 0;
    let lastProgressPercent = -1;

    // 如果知道文件大小，在开始时打印
    if (totalSize > 0 && onProgress) {
      onProgress(0); // 触发 0% 进度
    }

    // 创建一个 Transform 流来跟踪进度，使用更大的缓冲区
    const progressStream = new Transform({
      highWaterMark: 1024 * 1024, // 1MB 缓冲区
      transform(chunk: Buffer, encoding, callback) {
        if (hasError.value) {
          callback();
          return;
        }

        downloadedSize += chunk.length;

        // 只在进度变化时调用回调，减少开销
        if (onProgress && totalSize > 0) {
          const progress = (downloadedSize / totalSize) * 100;
          const progressPercent = Math.floor(progress);

          // 只在百分比变化时调用，避免频繁调用
          if (progressPercent !== lastProgressPercent) {
            lastProgressPercent = progressPercent;
            onProgress(progress);
          }
        }

        // 将数据传递给下一个流
        callback(null, chunk);
      },
    });

    // 使用 pipe 链：res -> progressStream -> file
    res.pipe(progressStream).pipe(file);

    file.on('finish', () => {
      file.close();
      if (onProgress && totalSize > 0) {
        onProgress(100); // 确保 100% 被打印
      }
      resolve();
    });

    file.on('error', (error) => {
      hasError.value = true;
      file.close();
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(error);
    });

    progressStream.on('error', (error) => {
      hasError.value = true;
      file.close();
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(error);
    });

    res.on('error', (error) => {
      hasError.value = true;
      file.close();
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(error);
    });
  }

  /**
   * 下载更新包（如果 URL 失败，尝试从备选服务器下载）
   */
  async downloadUpdate(pkg: Package, onProgress?: (progress: number) => void): Promise<string> {
    const fileName = path.basename(pkg.url);
    const destPath = path.join(this.config.downloadDir, fileName);

    // 如果文件已存在，检查哈希值
    if (fs.existsSync(destPath)) {
      const existingHash = await this.calculateHash(destPath);
      if (existingHash === pkg.hash) {
        console.log('文件已存在且哈希值匹配，跳过下载');
        return destPath;
      } else {
        console.log('文件已存在但哈希值不匹配，重新下载');
        fs.unlinkSync(destPath);
      }
    }

    // 首先尝试原始 URL
    let downloadUrls = [pkg.url];

    // 如果原始 URL 不在备选服务器列表中，尝试从备选服务器下载
    const originalBaseUrl = pkg.url.substring(0, pkg.url.indexOf('/packages/'));
    if (!this.config.serverUrls.includes(originalBaseUrl)) {
      // 从备选服务器构建下载 URL
      for (const serverUrl of this.config.serverUrls) {
        const altUrl = `${serverUrl}/packages/${fileName}`;
        if (altUrl !== pkg.url) {
          downloadUrls.push(altUrl);
        }
      }
    }

    // 创建进度回调，同时打印日志和调用用户提供的回调
    let lastProgressPercent = -1;
    const progressCallback = (progress: number) => {
      const percent = Math.round(progress);
      // 只在百分比变化时打印，避免日志过多（每 5% 打印一次，或者达到 100% 时打印）
      if (percent !== lastProgressPercent && (percent % 5 === 0 || percent === 100)) {
        console.log(`下载进度: ${percent}%`);
        lastProgressPercent = percent;
      }
      // 调用用户提供的回调（如果存在）
      if (onProgress) {
        onProgress(progress);
      }
    };

    // 按顺序尝试下载
    let lastError: Error | null = null;
    for (const downloadUrl of downloadUrls) {
      try {
        console.log(`开始下载: ${fileName} (${(pkg.size / 1024 / 1024).toFixed(2)} MB)`);
        console.log(`下载地址: ${downloadUrl}`);
        await this.downloadFile(downloadUrl, destPath, progressCallback);

        console.log('下载完成，正在验证文件...');
        // 验证下载的文件
        const downloadedHash = await this.calculateHash(destPath);
        if (downloadedHash !== pkg.hash) {
          fs.unlinkSync(destPath);
          throw new Error('下载的文件哈希值不匹配');
        }

        console.log('文件验证成功');
        return destPath;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`从 ${downloadUrl} 下载失败:`, lastError.message);
        // 如果文件存在但下载失败，删除它
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        continue;
      }
    }

    // 所有下载源都失败了
    throw new Error(`所有下载源都失败: ${lastError?.message || '未知错误'}`);
  }

  /**
   * 提示用户更新
   */
  async promptUpdate(pkg: Package): Promise<boolean> {
    const response = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${pkg.version}`,
      detail: `当前版本: ${this.config.currentVersion}\n最新版本: ${pkg.version}\n文件大小: ${(pkg.size / 1024 / 1024).toFixed(2)} MB\n\n是否立即下载？`,
      buttons: ['立即下载', '稍后提醒'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response.response === 0) {
      // 立即下载
      return true;
    } else {
      // 稍后提醒
      return false;
    }
  }

  /**
   * 显示下载进度对话框
   * 注意：这是一个简化版本，实际应用中应该使用 BrowserWindow 创建自定义进度窗口
   */
  async showDownloadProgress(pkg: Package): Promise<string | null> {
    // 简化版：直接下载，不显示进度对话框
    // 实际应用中可以使用 BrowserWindow 创建自定义进度窗口来显示下载进度
    return await this.downloadUpdate(pkg);
  }

  /**
   * 安装更新（打开下载的文件）
   * 对于 Windows MSI，需要先退出应用再安装，然后重启
   */
  async installUpdate(filePath: string): Promise<void> {
    const platform = process.platform;

    if (platform === 'win32' && filePath.endsWith('.msi')) {
      // Windows MSI: 需要先退出应用才能安装
      // 创建一个批处理脚本来处理安装（安装包会自动启动应用）
      const scriptPath = path.join(this.config.downloadDir, 'install-and-restart.bat');

      // 转义路径中的特殊字符
      const escapedMsiPath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      console.info(`escapedMsiPath: ${escapedMsiPath}`);

      spawn('cmd', ['/c', escapedMsiPath], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      }).unref();

      // 退出应用，让安装程序可以替换文件
      setTimeout(() => {
        app.exit(0);
      }, 500);
    } else {
      // 其他平台或格式：直接打开安装程序
      // 设置应用重启标志
      app.relaunch();

      // 打开安装程序
      await shell.openPath(filePath);

      // 对于 macOS DMG，用户需要手动安装，所以不自动退出
      // 对于其他格式，等待一段时间后退出
      if (platform !== 'darwin') {
        setTimeout(() => {
          app.exit(0);
        }, 2000);
      }
    }
  }

  /**
   * 检查更新并提示用户（完整流程）
   */
  async checkAndPromptUpdate(): Promise<void> {
    try {
      const result = await this.checkForUpdate();

      if (!result.hasUpdate || !result.package) {
        return;
      }

      const shouldDownload = await this.promptUpdate(result.package);
      if (!shouldDownload) {
        return;
      }

      // 静默下载（不显示下载提示）
      this.downloadUpdate(result.package)
        .then((filePath) => {
          // 下载完成，提示安装
          dialog
            .showMessageBox({
              type: 'question',
              title: '下载完成',
              message: '更新包下载完成',
              detail: `文件已保存到: ${filePath}\n\n是否立即安装？`,
              buttons: ['立即安装', '稍后安装'],
              defaultId: 0,
            })
            .then((installResponse) => {
              if (installResponse.response === 0) {
                // 安装更新（会自动重启应用）
                this.installUpdate(filePath).catch((error) => {
                  dialog.showErrorBox(
                    '安装失败',
                    `安装更新时出错: ${error instanceof Error ? error.message : String(error)}`
                  );
                });
              }
            });
        })
        .catch((error) => {
          dialog.showErrorBox(
            '下载失败',
            `下载更新时出错: ${error instanceof Error ? error.message : String(error)}`
          );
        });
    } catch (error) {
      console.error('检查更新失败:', error);
    }
  }

  /**
   * 启动自动检查（如果配置了检查间隔）
   */
  startAutoCheck(): void {
    if (this.config.checkInterval > 0) {
      // 立即检查一次
      this.checkAndPromptUpdate();

      // 然后按间隔检查
      this.checkIntervalId = setInterval(() => {
        this.checkAndPromptUpdate();
      }, this.config.checkInterval);
    }
  }

  /**
   * 停止自动检查
   */
  stopAutoCheck(): void {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
  }
}
