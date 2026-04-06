# FillipDesk 自动更新系统

本文档详细介绍如何部署和使用 FillipDesk 的自动更新服务。

## 目录

- [系统架构](#系统架构)
- [服务端部署](#服务端部署)
- [客户端配置](#客户端配置)
- [发布更新包](#发布更新包)
- [API 文档](#api-文档)
- [使用示例](#使用示例)
- [常见问题](#常见问题)

## 系统架构

自动更新系统由两部分组成：

1. **更新服务器** (`server.ts`) - 负责存储和分发安装包
2. **更新客户端** (`client.ts`) - 集成在 Electron 应用中，负责检查、下载和安装更新

```
┌─────────────┐         HTTP          ┌─────────────┐
│  客户端应用  │ ──────────────────────────> │  更新服务器  │
│ (Electron)  │ <────────────────────────── │  (Node.js)  │
└─────────────┘     检查更新/下载安装包      └─────────────┘
```

## 服务端部署

### 1. 环境要求

- Node.js 18+
- 足够的磁盘空间存储安装包

### 2. 安装依赖

更新服务器使用 Node.js 内置模块，无需额外依赖。

### 3. 启动服务器

#### 方式一：使用 npm 脚本（推荐）

使用 `npm run updater:server` 命令，注意需要使用 `--` 来传递参数：

```bash
# 使用默认配置（host: 0.0.0.0, port: 3000）
npm run updater:server -- --directory ./packages

# 自定义主机和端口
npm run updater:server -- --host localhost --port 8080 --directory ./packages

# 查看帮助信息
npm run updater:server -- --help
# 或
npm run updater:server -- -h
```

**注意：** 在 npm scripts 中，`--` 后面的参数会传递给实际执行的命令。

#### 方式二：直接运行 TypeScript 文件

也可以直接使用 `tsx` 运行：

```bash
# 使用默认配置（host: 0.0.0.0, port: 3000）
tsx src/updater/server.ts --directory ./packages

# 自定义主机和端口
tsx src/updater/server.ts --host localhost --port 8080 --directory ./packages

# 查看帮助信息
tsx src/updater/server.ts --help
# 或
tsx src/updater/server.ts -h
```

**命令行参数说明：**

- `--directory` (必需): 安装包和 JSON 元数据文件的存储目录
- `--host` (可选): 服务器监听的主机地址，默认 `0.0.0.0`
- `--port` (可选): 服务器监听的端口号，默认 `3000`
- `-h, --help`: 显示帮助信息

**示例：**

```bash
# 使用默认配置（推荐，最简单）
tsx src/updater/server.ts --directory ./packages

# 本地开发（只监听本地）
tsx src/updater/server.ts --host localhost --directory ./packages

# 生产环境（自定义端口）
tsx src/updater/server.ts --host 0.0.0.0 --port 8080 --directory /var/www/updates/packages
```

**重要说明：**

- 服务器会自动扫描指定目录中的所有 `.json` 文件
- 每 5 秒自动扫描一次，发现新的 JSON 文件会自动加载
- 不需要手动维护 `manifest.json`，服务器会自动组合所有 JSON 文件
- 确保 JSON 文件格式正确（参考发布脚本生成的格式）

#### 方式二：作为 Node.js 模块使用

```typescript
import { UpdateServer } from './updater/server.js';

const server = new UpdateServer({
    port: 3000,
    host: '0.0.0.0',
    packagesDir: './packages',
    baseUrl: 'http://updates.yourdomain.com'
});

await server.start();
console.log('更新服务器已启动');
```

#### 方式三：使用 PM2 部署（生产环境推荐）

```bash
# 安装 PM2
npm install -g pm2

# 创建 PM2 配置文件 ecosystem.config.js
cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'fillipdesk-updater',
    script: 'tsx',
    args: 'src/updater/server.ts --host 0.0.0.0 --port 3000 --directory ./packages',
    instances: 1,
    exec_mode: 'fork',
    error_file: './logs/updater-error.log',
    out_file: './logs/updater-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOF

# 启动服务
pm2 start ecosystem.config.js

# 设置开机自启
pm2 startup
pm2 save
```

**注意：** 如果使用编译后的 JavaScript 文件，需要先运行 `npm run build`，然后修改 `script` 为 `dist/updater/server.js`。

### 5. 使用 Nginx 反向代理（推荐）

在生产环境中，建议使用 Nginx 作为反向代理，提供 HTTPS 和负载均衡：

```nginx
# /etc/nginx/sites-available/fillipdesk-updater
server {
    listen 80;
    server_name updates.yourdomain.com;

    # 允许大文件上传/下载
    client_max_body_size 500M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # 设置超时时间（大文件下载需要）
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
```

## 客户端配置

客户端已集成在主进程中，支持多个备选更新服务器地址，按顺序尝试。

### 代码配置

在 `src/main/main.js` 中，更新客户端会在应用启动时自动初始化：

```javascript
const initializeUpdater = () => {
    // 配置多个备选更新服务器地址，按顺序尝试
    // 如果第一个服务器不可用，会自动尝试下一个
    const updateServerUrls = [
        'http://updates.example.com',
        'http://updates-backup.example.com',
        'http://localhost:3000' // 本地测试服务器
    ];

    // 只在生产环境启用自动更新
    if (!is.dev) {
        updateClient = new UpdateClient({
            serverUrls: updateServerUrls,
            currentVersion: app.getVersion() || '0.1.3',
            checkInterval: 0 // 0 表示只在启动时检查，不自动检查
        });

        // 延迟检查更新，避免影响应用启动速度
        setTimeout(() => {
            updateClient.checkAndPromptUpdate().catch((error) => {
                logger.error('检查更新失败', error);
            });
        }, 3000);
    }
};
```

### 配置选项

`UpdateClient` 支持以下配置选项：

```typescript
interface UpdateClientConfig {
    serverUrls: string[]; // 多个备选服务器地址数组（必需），按顺序尝试
    currentVersion: string; // 当前应用版本（必需）
    platform?: string; // 平台（默认: process.platform）
    arch?: string; // 架构（默认: 自动检测）
    downloadDir?: string; // 下载目录（默认: app.getPath('userData')/updates）
    checkInterval?: number; // 自动检查间隔（毫秒，0 表示不自动检查）
}
```

### 多服务器容错机制

客户端支持多个备选服务器地址，具有以下特性：

1. **检查更新时**：按顺序尝试所有服务器，直到找到一个可用的服务器
2. **下载更新时**：如果原始下载 URL 失败，会自动尝试从备选服务器下载
3. **错误处理**：如果所有服务器都不可用，会记录错误但不影响应用运行

## 发布更新包

### 1. 构建安装包

使用 Electron Forge 构建当前平台的安装包：

```bash
# 在 Windows 上构建 Windows 安装包
npm run make:win32

# 在 macOS 上构建 macOS 安装包
npm run make:darwin
```

构建完成后，安装包位于 `out/make/` 目录下：

- Windows: `out/make/wix/FillipDesk-{version}-Setup.exe`
- macOS: `out/make/dmg/FillipDesk-{version}.dmg` 或 `FillipDesk-{version}-arm64.dmg`

### 2. 准备发布文件

使用 `npm run updater:publish` 命令自动处理安装包：

```bash
# 自动处理当前平台的安装包
npm run updater:publish
```

这个命令会：

1. 自动检测当前平台和架构
2. 从 `out/make/` 目录找到构建好的安装包
3. 将安装包重命名为标准格式：`FillipDesk-{version}-{platform}-{arch}.{ext}`
4. 复制到 `out/publish/` 目录
5. 计算文件的 SHA256 哈希值
6. 生成对应的 JSON 描述文件，包含完整的包信息（对应 `manifest.json` 中的 `packages` 数组项）

**输出文件：**

- 安装包：`out/publish/FillipDesk-{version}-{platform}-{arch}.{ext}`
- 包信息：`out/publish/FillipDesk-{version}-{platform}-{arch}.json`

**环境变量：**
可以通过 `UPDATE_BASE_URL` 环境变量设置下载 URL 的基础地址：

```bash
# Windows (PowerShell)
$env:UPDATE_BASE_URL="http://updates.yourdomain.com"
npm run updater:publish

# macOS/Linux
export UPDATE_BASE_URL=http://updates.yourdomain.com
npm run updater:publish
```

**生成的 JSON 文件示例：**

```json
{
    "platform": "win32",
    "arch": "x64",
    "version": "0.1.3",
    "url": "http://updates.yourdomain.com/packages/FillipDesk-0.1.3-win32-x64.msi",
    "hash": "abc123def456...",
    "size": 104857600,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

### 3. 手动发布到服务器

**重要：** 出于安全考虑，我们不提供自动发布到服务器的功能。请手动完成以下步骤：

1. **复制文件到服务器**
    - 将 `out/publish/` 目录下的**安装包文件**复制到服务器的包目录
    - 将 `out/publish/` 目录下对应的**JSON 文件**也复制到服务器的包目录

2. **服务器自动加载**
    - 服务器会每 5 秒自动扫描包目录
    - 发现新的 JSON 文件会自动加载
    - 不需要手动编辑任何 manifest.json 文件

**文件结构示例：**

```
服务器包目录 (--directory 指定的目录)
├── FillipDesk-0.1.3-win32-x64.msi          # 安装包文件
├── FillipDesk-0.1.3-win32-x64.json         # 包信息 JSON
├── FillipDesk-0.1.3-darwin-x64.dmg         # 安装包文件
├── FillipDesk-0.1.3-darwin-x64.json        # 包信息 JSON
├── FillipDesk-0.1.3-darwin-arm64.dmg       # 安装包文件
└── FillipDesk-0.1.3-darwin-arm64.json      # 包信息 JSON
```

**注意事项：**

- JSON 文件名应该与安装包文件名对应（扩展名不同）
- 服务器会自动匹配 JSON 文件和安装包文件
- 如果 JSON 文件中的 URL 不完整，服务器会自动使用 `baseUrl` 生成正确的下载 URL

## API 文档

更新服务器提供了以下 API 接口，可以通过 HTTP 请求访问。

### 手动访问 API

#### 使用 curl 命令

```bash
# 查询最新版本（Windows x64）
curl "http://localhost:3000/api/latest?platform=win32&arch=x64"

# 查询最新版本（macOS ARM64）
curl "http://localhost:3000/api/latest?platform=darwin&arch=arm64"

# 获取所有包列表
curl "http://localhost:3000/api/packages"

# 下载安装包文件
curl -O "http://localhost:3000/packages/FillipDesk-0.2.0-Setup.exe"
```

#### 使用浏览器

直接在浏览器中访问以下 URL：

- **查询最新版本**：`http://localhost:3000/api/latest?platform=win32&arch=x64`
- **获取所有包列表**：`http://localhost:3000/api/packages`
- **下载安装包**：`http://localhost:3000/packages/FillipDesk-0.2.0-Setup.exe`

#### 使用 PowerShell (Windows)

```powershell
# 查询最新版本
Invoke-RestMethod -Uri "http://localhost:3000/api/latest?platform=win32&arch=x64"

# 获取所有包列表
Invoke-RestMethod -Uri "http://localhost:3000/api/packages"

# 下载安装包
Invoke-WebRequest -Uri "http://localhost:3000/packages/FillipDesk-0.2.0-Setup.exe" -OutFile "FillipDesk-0.2.0-Setup.exe"
```

#### 使用 Python

```python
import requests

# 查询最新版本
response = requests.get("http://localhost:3000/api/latest", params={
    "platform": "win32",
    "arch": "x64"
})
print(response.json())

# 获取所有包列表
response = requests.get("http://localhost:3000/api/packages")
print(response.json())

# 下载安装包
response = requests.get("http://localhost:3000/packages/FillipDesk-0.2.0-Setup.exe", stream=True)
with open("FillipDesk-0.2.0-Setup.exe", "wb") as f:
    for chunk in response.iter_content(chunk_size=8192):
        f.write(chunk)
```

### GET /api/latest

获取指定平台和架构的最新版本。

**查询参数：**

- `platform` (必需): 平台名称 (`win32` 或 `darwin`)
- `arch` (必需): 架构 (`x64` 或 `arm64`)

**请求示例：**

```bash
curl "http://localhost:3000/api/latest?platform=win32&arch=x64"
```

**响应示例：**

```json
{
    "status": "ok",
    "data": {
        "platform": "win32",
        "arch": "x64",
        "version": "0.2.0",
        "url": "http://localhost:3000/packages/FillipDesk-0.2.0-Setup.exe",
        "hash": "abc123...",
        "size": 104857600,
        "createdAt": "2024-01-01T00:00:00.000Z",
        "updatedAt": "2024-01-01T00:00:00.000Z"
    }
}
```

如果没有找到匹配的包，`data` 为 `null`：

```json
{
    "status": "ok",
    "data": null
}
```

### GET /api/packages

获取所有已发布的包列表。

**请求示例：**

```bash
curl "http://localhost:3000/api/packages"
```

**响应示例：**

```json
{
    "status": "ok",
    "data": [
        {
            "platform": "win32",
            "arch": "x64",
            "version": "0.2.0",
            "url": "http://localhost:3000/packages/FillipDesk-0.2.0-Setup.exe",
            "hash": "abc123...",
            "size": 104857600,
            "createdAt": "2024-01-01T00:00:00.000Z",
            "updatedAt": "2024-01-01T00:00:00.000Z"
        },
        {
            "platform": "darwin",
            "arch": "x64",
            "version": "0.2.0",
            "url": "http://localhost:3000/packages/FillipDesk-0.2.0.dmg",
            "hash": "def456...",
            "size": 104857600,
            "createdAt": "2024-01-01T00:00:00.000Z",
            "updatedAt": "2024-01-01T00:00:00.000Z"
        }
    ]
}
```

### GET /packages/{filename}

下载指定的安装包文件。

**请求示例：**

```bash
curl -O "http://localhost:3000/packages/FillipDesk-0.2.0-Setup.exe"
```

**响应：**

- 成功：返回文件流，Content-Type: `application/octet-stream`
- 失败：返回 404 错误，Content-Type: `text/plain`，响应体为 `文件未找到`

## 使用示例

### 检查更新

客户端会在应用启动时自动检查更新。也可以手动触发：

```typescript
import { UpdateClient } from './updater/client.js';
import { app } from 'electron';

const client = new UpdateClient({
    serverUrls: ['http://updates.yourdomain.com', 'http://updates-backup.yourdomain.com'],
    currentVersion: app.getVersion()
});

// 检查更新
const result = await client.checkForUpdate();
if (result.hasUpdate) {
    console.log('发现新版本:', result.latestVersion);
}
```

### 下载更新

```typescript
if (result.hasUpdate && result.package) {
    // 下载更新包
    const filePath = await client.downloadUpdate(result.package, (progress) => {
        console.log(`下载进度: ${progress.toFixed(2)}%`);
    });

    console.log('下载完成:', filePath);
}
```

### 完整更新流程

```typescript
// 检查并提示用户更新（完整流程）
await client.checkAndPromptUpdate();
```

这个方法会：

1. 检查是否有更新
2. 如果有更新，显示对话框询问用户是否下载
3. 如果用户同意，下载更新包
4. 下载完成后，询问用户是否立即安装
5. 如果用户同意，打开安装包并退出应用

## 常见问题

### 1. 客户端无法连接到服务器

**问题：** 客户端检查更新时出现网络错误。

**解决方案：**

- 检查 `serverUrls` 配置中的服务器地址是否正确
- 确认至少有一个服务器正在运行且可访问
- 检查防火墙设置
- 确认 URL 协议正确（http://）
- 客户端会自动尝试所有备选服务器，如果都失败会静默处理

### 2. 下载的文件哈希值不匹配

**问题：** 下载完成后验证失败。

**解决方案：**

- 检查服务器上的文件是否完整
- 确认网络传输过程中没有损坏
- 重新发布安装包

### 3. 版本比较不正确

**问题：** 新版本没有被识别为更新。

**解决方案：**

- 确认版本号格式正确（例如：`0.2.0`）
- 检查服务器返回的版本号是否正确
- 版本比较使用简单的数字比较，确保版本号格式一致

### 4. 服务器内存占用过高

**问题：** 服务器处理大文件时内存占用过高。

**解决方案：**

- 使用流式传输（已实现）
- 考虑使用 CDN 存储大文件
- 使用 Nginx 等反向代理处理静态文件

### 5. JSON 文件没有被加载

**问题：** 新添加的 JSON 文件没有被服务器识别。

**解决方案：**

- 确认 JSON 文件格式正确
- 检查文件是否在 `--directory` 指定的目录中
- 等待最多 5 秒，服务器会自动扫描
- 检查服务器日志，查看是否有加载错误

### 6. 如何回滚到旧版本？

**解决方案：**

- 在服务器上保留旧版本的安装包和 JSON 文件
- 客户端可以通过修改 `currentVersion` 来"降级"
- 或者手动下载旧版本安装包

### 7. 如何测试更新功能？

**测试步骤：**

1. 启动更新服务器：`tsx src/updater/server.ts --host localhost --port 3000 --directory ./packages`
2. 运行 `npm run updater:publish` 生成测试包
3. 将生成的安装包和 JSON 文件复制到服务器的包目录
4. 在 `main.js` 中配置测试服务器地址到 `updateServerUrls` 数组
5. 运行应用，应该会检测到更新

### 8. 生产环境部署建议

1. **多服务器容错**：配置多个备选服务器地址，提高可用性
2. **使用 CDN**：加速大文件下载
3. **监控服务器**：监控服务器状态和下载统计
4. **备份包目录**：定期备份包目录中的所有文件
5. **版本管理**：使用语义化版本号（SemVer）
6. **灰度发布**：可以先发布给部分用户测试
7. **自动扫描**：服务器每 5 秒自动扫描，无需手动刷新

## 安全考虑

1. **文件完整性**：所有文件都使用 SHA256 哈希验证
2. **访问控制**：可以考虑添加 API 密钥或 IP 白名单
3. **文件扫描**：上传前扫描安装包是否有恶意软件
4. **版本验证**：确保版本号格式正确，防止注入攻击
5. **多服务器验证**：确保所有备选服务器都是可信的

## 许可证

本自动更新系统遵循项目的 BSD-3-Clause 许可证。
