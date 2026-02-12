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

import { readFileSync, statSync, existsSync, copyFileSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');

interface PackageInfo {
  platform: 'win32' | 'darwin';
  arch: 'x64' | 'arm64';
  version: string;
  url: string;
  hash: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 计算文件的 SHA256 哈希值
 */
function calculateHash(filePath: string): string {
  const fileBuffer = readFileSync(filePath);
  const hashSum = createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

/**
 * 获取当前平台和架构
 */
function getPlatformInfo(): { platform: string; arch: string } {
  const platform = process.platform;
  let arch = process.arch;

  // 标准化架构名称
  if (arch === 'x64') {
    arch = 'x64';
  } else if (arch === 'arm64') {
    arch = 'arm64';
  } else {
    console.error(`不支持的架构: ${arch}`);
    process.exit(1);
  }

  if (platform !== 'win32' && platform !== 'darwin') {
    console.error(`不支持的平台: ${platform}`);
    process.exit(1);
  }

  return { platform, arch };
}

/**
 * 查找构建好的安装包
 */
function findInstaller(platform: string, arch: string, version: string): string | null {
  if (platform === 'win32') {
    // Windows: out/make/wix/{arch}/fillipdesk.msi 或 out/make/wix/fillipdesk.msi
    // MSI 文件可能在不同的架构子目录中，文件名可能不包含版本号
    let searchPath = join(projectRoot, 'out', 'make', 'wix');
    
    // 先尝试在架构子目录中查找
    const archDir = join(searchPath, arch);
    if (existsSync(archDir)) {
      searchPath = archDir;
    }
    
    // 尝试查找 .msi 文件（文件名可能不包含版本号）
    const possibleNames = [
      'fillipdesk.msi',
      `FillipDesk-${version}.msi`,
      `FillipDesk.msi`,
    ];
    
    for (const name of possibleNames) {
      const fullPath = join(searchPath, name);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
    
    // 如果都找不到，尝试查找目录下的第一个 .msi 文件
    try {
      const files = readdirSync(searchPath);
      const msiFile = files.find((f) => f.toLowerCase().endsWith('.msi'));
      if (msiFile) {
        return join(searchPath, msiFile);
      }
    } catch (error) {
      // 目录不存在或无法读取
    }
    
    console.warn(`未找到 MSI 安装包`);
    console.warn(`请检查目录: ${searchPath}`);
    return null;
  } else if (platform === 'darwin') {
    // macOS: out/make/dmg/FillipDesk-{version}.dmg 或 FillipDesk-{version}-arm64.dmg
    // 也可能在子目录中，如 out/make/dmg/x64/ 或 out/make/dmg/arm64/
    searchPath = join(projectRoot, 'out', 'make', 'dmg');
    
    // 先尝试在子目录中查找
    const archDir = join(searchPath, arch);
    if (existsSync(archDir)) {
      searchPath = archDir;
    }
    
    // macOS 安装包可能没有版本号在文件名中，尝试多种格式
    const possibleNames = [
      `FillipDesk-${version}-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`,
      `FillipDesk-${version}.dmg`,
      `FillipDesk.dmg`,
    ];
    
    for (const name of possibleNames) {
      const fullPath = join(searchPath, name);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
    
    // 如果都找不到，尝试查找目录下的第一个 .dmg 文件
    try {
      const files = readdirSync(searchPath);
      const dmgFile = files.find((f) => f.endsWith('.dmg'));
      if (dmgFile) {
        return join(searchPath, dmgFile);
      }
    } catch (error) {
      // 目录不存在或无法读取
    }
    
    return null;
  } else {
    console.error(`不支持的平台: ${platform}`);
    return null;
  }
}

/**
 * 生成标准化的安装包文件名
 */
function generatePackageFileName(platform: string, arch: string, version: string, originalPath: string): string {
  const ext = extname(originalPath);
  return `FillipDesk-${version}-${platform}-${arch}${ext}`;
}

/**
 * 生成包信息 JSON
 */
function generatePackageInfo(
  filePath: string,
  platform: string,
  arch: string,
  version: string,
  url: string
): PackageInfo {
  const stats = statSync(filePath);
  const hash = calculateHash(filePath);
  const now = new Date().toISOString();

  return {
    platform: platform as 'win32' | 'darwin',
    arch: arch as 'x64' | 'arm64',
    version,
    url,
    hash,
    size: stats.size,
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  // 读取 package.json 获取版本号
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    console.error('未找到 package.json');
    process.exit(1);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const version = packageJson.version;

  if (!version) {
    console.error('package.json 中未找到 version 字段');
    process.exit(1);
  }

  // 获取平台和架构信息
  const { platform, arch } = getPlatformInfo();

  console.log(`准备发布安装包:`);
  console.log(`  版本: ${version}`);
  console.log(`  平台: ${platform}`);
  console.log(`  架构: ${arch}`);

  // 查找安装包
  const installerPath = findInstaller(platform, arch, version);
  if (!installerPath) {
    console.error('未找到安装包文件');
    console.error('请先运行: npm run make');
    process.exit(1);
  }

  console.log(`  找到安装包: ${installerPath}`);

  // 生成标准化的文件名
  const packageFileName = generatePackageFileName(platform, arch, version, installerPath);
  const outputDir = join(projectRoot, 'out', 'publish');
  const outputPath = join(outputDir, packageFileName);

  // 确保输出目录存在
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 复制并重命名文件
  console.log(`  复制到: ${outputPath}`);
  copyFileSync(installerPath, outputPath);

  // 生成包信息
  // URL 需要用户手动配置，这里使用占位符
  const baseUrl = process.env.UPDATE_BASE_URL || 'http://updates.yourdomain.com';
  const url = `${baseUrl}/packages/${packageFileName}`;

  const packageInfo = generatePackageInfo(outputPath, platform, arch, version, url);

  // 保存包信息到 JSON 文件
  const infoFileName = packageFileName.replace(extname(packageFileName), '.json');
  const infoFilePath = join(outputDir, infoFileName);
  writeFileSync(infoFilePath, JSON.stringify(packageInfo, null, 2), 'utf-8');

  console.log(`\n发布完成!`);
  console.log(`  安装包: ${outputPath}`);
  console.log(`  包信息: ${infoFilePath}`);
  console.log(`\n包信息内容 (可添加到服务器的 manifest.json):`);
  console.log(JSON.stringify(packageInfo, null, 2));
  console.log(`\n注意: 请手动将安装包复制到服务器，并更新 manifest.json`);
}

main().catch((error) => {
  console.error('发布失败:', error);
  process.exit(1);
});
