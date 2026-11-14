# syntax=docker/dockerfile:1.7
#
# OpenDesk Web UI 镜像：容器内运行 Electron 主进程（无窗口），renderer 经 HTTP/WebSocket 提供给浏览器。
#
#   docker build -f docker/web/Dockerfile -t opendesk-web .
#   docker run -p 8080:8080 -e OPENDESK_WEB_TOKEN=<token> -v opendesk-home:/home/opendesk opendesk-web
#
# 多架构：JS 构建（vite/esbuild，与架构无关）只在构建机原生架构上跑一次；
# 依赖安装、Linux 沙箱编译与 electron-forge 打包按目标架构进行。

ARG NODE_IMAGE=node:22-bookworm
ARG RUNTIME_IMAGE=node:22-bookworm-slim

# ── 1. JS 构建（构建机架构）────────────────────────────────
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS js-build
WORKDIR /src
ENV HUSKY=0 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json .npmrc ./
COPY packages ./packages
# postinstall 需要 scripts/setup-native-modules.cjs
COPY scripts ./scripts
RUN --mount=type=cache,target=/root/.npm npm install
COPY . .
# renderer 构建峰值内存较高：顺序构建 main 与 renderer，避免两路并行挤占容器内存
RUN npm run build:plugins \
    && OPENDESK_BUILD_SEQUENTIAL=1 NODE_OPTIONS=--max-old-space-size=6144 node scripts/build-electron.cjs

# ── 2. 打包（目标架构）──────────────────────────────────────
FROM ${NODE_IMAGE} AS package
WORKDIR /src
ENV HUSKY=0 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
COPY package.json .npmrc ./
COPY packages ./packages
# postinstall 需要 scripts/setup-native-modules.cjs
COPY scripts ./scripts
RUN --mount=type=cache,target=/root/.npm npm install
COPY . .
COPY --from=js-build /src/dist ./dist
COPY --from=js-build /src/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
RUN npm run build-sandbox:linux \
    && npx electron-forge package --platform=linux --arch="$(node -p process.arch)" \
    && mv out/*-linux-* /opt/opendesk

# ── 3. 运行时 ──────────────────────────────────────────────
FROM ${RUNTIME_IMAGE} AS runtime
# Electron/Chromium 运行库 + Xvfb（主进程需要一个显示，即使不显示窗口）
# + agent 常用命令行工具 + 中文字体（服务端截图/导出 PDF 等渲染用）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates tini xvfb xauth dbus \
        libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libdrm2 libxkbcommon0 libatk-bridge2.0-0 \
        libatk1.0-0 libcups2 libxcomposite1 libxdamage1 libxrandr2 libxtst6 libxshmfence1 \
        libx11-xcb1 libxfixes3 libpango-1.0-0 libcairo2 libsecret-1-0 \
        fonts-noto-cjk fonts-noto-color-emoji \
        git curl wget procps less nano openssh-client unzip zip xz-utils jq ripgrep \
        python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    # 复用基础镜像中 uid 1000 的 node 用户，改名为 opendesk
    && groupmod -n opendesk node \
    && usermod -l opendesk -d /home/opendesk -m node

COPY --from=package /opt/opendesk /opt/opendesk
COPY docker/web/entrypoint.sh /usr/local/bin/opendesk-web
RUN chmod 755 /usr/local/bin/opendesk-web

ENV OPENDESK_WEB_PORT=8080 \
    OPENDESK_WEB_HOST=0.0.0.0 \
    HOME=/home/opendesk
USER opendesk
WORKDIR /home/opendesk
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD curl -fsS "http://127.0.0.1:${OPENDESK_WEB_PORT}/__opendesk/health" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/opendesk-web"]
