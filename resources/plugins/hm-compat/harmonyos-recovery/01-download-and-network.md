# 🌐 桶1: 下载与软件源

本分类包括软件源太慢、Github下载慢、CA证书等导致依赖项下载失败的问题的排查和修复方法：

- **源太慢** — Python 包、npm 包下载慢到超时
- **网不通** — 连 GitHub 等官方源超时了
- **证书不认** — 系统有 CA 证书但工具找不到

**对应解法**：换国内镜像 / 鸿蒙专用源，或者配代理。下面按错误码逐个排查。

---

## E01 python3 -m pip install 超时/卡住

```
pip._vendor.urllib3.exceptions.ReadTimeoutError: HTTPSConnectionPool(
  host='files.pythonhosted.org', port=443): Read timed out.
WARNING: Retrying (Retry(total=4, ...)) after connection broken
  by 'ReadTimeoutError(...)'
```

鸿蒙上有专门的 PyPI 镜像，可采用如下两种方式配置后使用：

```bash
# 临时换源装一个包
python3 -m pip install --trusted-host pypi.repo.openharmony.cn -i https://pypi.repo.openharmony.cn/artifactory/openharmony-pypi/simple <包名>

# 或永久写入配置
python3 -m pip config set global.index-url https://pypi.repo.openharmony.cn/artifactory/openharmony-pypi/simple
```

> 如果镜像源也装不上，试试 `python3 -m pip install --default-timeout=120 <包名>` 延长超时

---

## E02 npm install 超时/卡住

```
npm ERR! code ERR_SOCKET_TIMEOUT
npm ERR! errno ERR_SOCKET_TIMEOUT
npm ERR! network request to https://registry.npmjs.org/xxx failed,
  reason: connect ETIMEDOUT
npm ERR! network 'proxy' config is set properly. See: 'npm help config'
```

鸿蒙上有专门的 npm registry 镜像：

```bash
# 配置镜像源
npm config set registry https://npm.cnb.cool/OpenHarmonyPCDeveloper/npm/-/packages/

# 验证
npm config get registry
```

> 已适配鸿蒙的 npm 包列表：https://cnb.cool/OpenHarmonyPCDeveloper/npm
> 如果之前配过旧版淘宝镜像（registry.npm.taobao.org），注意证书已过期，删掉改用上面的鸿蒙源

---

## E03 GitHub 下载慢/超时

```
wget: connect: Operation timed out
curl: (28) Connection timed out
github.com: could not resolve host
```

```bash
# ghfast.top 加速（推荐）
wget https://ghfast.top/https://github.com/<组织>/<项目>/releases/download/<版本>/<文件名>

# 代理回退
export https_proxy=http://proxy:port
export http_proxy=http://proxy:port
```

---

## E04 CA 证书路径不标准

```
SSL 证书验证失败 / CERTIFICATE_VERIFY_FAILED
wget: unable to load client CA certificates
```

（系统有 `/etc/ssl/certs/cacert.pem` 但 Python/OpenSSL 默认找不到）

```bash
export SSL_CERT_FILE=/etc/ssl/certs/cacert.pem
# 或临时跳过
wget --no-check-certificate https://example.com/file
```

---

## E150 git submodule 缺失

```
framework.*not found / submodule.*missing
fatal: not a git repository
```

```bash
# 手动下载子模块
git clone --depth=1 https://github.com/Mbed-TLS/mbed-framework.git framework
```

---

[⬆ 返回顶部](./README.md)
