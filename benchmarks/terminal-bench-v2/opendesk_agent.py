"""
opendesk_agent.py - Harbor ExternalAgent 适配器。

在容器中运行 OpenDesk headless 模式来完成 TerminalBench 任务。

OpenDesk 二进制（Linux 交叉编译版）和配置文件通过 volume mount
挂载到容器的 /opendesk-host 目录。Agent 的 setup 阶段将二进制和
配置复制到容器内正确的位置。

使用方法:
  harbor run ... --agent-import-path opendesk_agent:OpenDeskAgent \\
    --mounts-json '["/path/to/project/dist/cli:/opendesk-host:ro"]'
"""

import json
import os
import shlex
import sys
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


def _load_opendesk_setting() -> dict:
    """从宿主机读取 OpenDesk 的 setting.json。"""

    if sys.platform == "win32":
        setting_path = Path(os.environ["APPDATA"]) / "opendesk" / "setting.json"
    else:
        setting_path = Path("~/.opendesk/setting.json").expanduser()

    if not setting_path.exists():
        raise FileNotFoundError(
            f"OpenDesk 配置文件不存在: {setting_path}\n"
            "请先在宿主机上配置 OpenDesk"
        )
    with open(setting_path, "r") as f:
        return json.load(f)


def _build_setting_for_model(full_setting: dict, model_alias: str) -> dict:
    """根据 model alias 构造只包含必要信息的 setting.json。"""
    models = full_setting.get("models", [])
    target_model = None
    for m in models:
        if m.get("alias") == model_alias:
            target_model = m
            break

    if target_model is None:
        available = [m.get("alias", "?") for m in models]
        raise ValueError(
            f"模型别名 '{model_alias}' 在 setting.json 中未找到。\n"
            f"可用模型: {', '.join(available)}"
        )

    provider_name = target_model.get("provider_name")
    providers = full_setting.get("providers", [])
    target_provider = None
    for p in providers:
        if p.get("name") == provider_name:
            target_provider = p
            break

    if target_provider is None:
        raise ValueError(
            f"provider '{provider_name}' 在 setting.json 中未找到"
        )

    return {
        "default_model": model_alias,
        "default_intent_parsing_model": "",
        "default_embedding_model": "",
        "default_reranker_model": "",
        "default_vision_model": "",
        "providers": [target_provider],
        "models": [target_model],
        "applications": {},
    }


class OpenDeskAgent(BaseInstalledAgent):
    SUPPORTS_ATIF: bool = False

    # 容器内 opendesk 挂载的路径
    MOUNT_PATH = "/opendesk-host"

    def __init__(self, *args, **kwargs):
        self._model_alias = kwargs.pop("model_alias", None)
        super().__init__(*args, **kwargs)

        self._full_setting = _load_opendesk_setting()

        if self._model_alias is None:
            if self.model_name:
                self._model_alias = self.model_name
            else:
                self._model_alias = self._full_setting.get(
                    "default_model", ""
                )

        self._container_setting = _build_setting_for_model(
            self._full_setting, self._model_alias
        )

    @staticmethod
    def name() -> str:
        return "opendesk"

    def version(self) -> str | None:
        return self._version or "0.2.0"

    # 国内镜像源替换脚本（apt/apk/yum 通用，兼容 DEB822 和传统格式）
    _MIRROR_CMD = (
        "if command -v apt-get &> /dev/null; then "
        "find /etc/apt -name '*.list' -o -name '*.sources' -o -name 'sources.list' 2>/dev/null"
        " | xargs -r sed -i"
        " -e 's|deb.debian.org|mirrors.aliyun.com|g'"
        " -e 's|security.debian.org/debian-security|mirrors.aliyun.com/debian-security|g'"
        " -e 's|security.debian.org|mirrors.aliyun.com|g'"
        " -e 's|archive.ubuntu.com|mirrors.aliyun.com|g'"
        " -e 's|security.ubuntu.com|mirrors.aliyun.com|g';"
        " elif command -v apk &> /dev/null; then "
        "sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories 2>/dev/null;"
        " fi"
    )

    # 预装 uv 的脚本：优先从 mount 复制预下载的二进制，回退到国内镜像下载
    _UV_INSTALL_CMD = (
        "ARCH=$(uname -m); "
        "if [ \"$ARCH\" = \"x86_64\" ] || [ \"$ARCH\" = \"amd64\" ]; then "
        "  UV_ARCH='x86_64-unknown-linux-gnu'; "
        "elif [ \"$ARCH\" = \"aarch64\" ] || [ \"$ARCH\" = \"arm64\" ]; then "
        "  UV_ARCH='aarch64-unknown-linux-gnu'; "
        "else "
        "  echo '[uv] Unsupported arch: '$ARCH; exit 0; "
        "fi; "
        # 方式1: 从 mount 目录复制预下载的 uv（最快，无网络）
        "UV_INSTALLED=0; "
        f"if [ -f {MOUNT_PATH}/uv-${{UV_ARCH}}/uv ]; then "
        f"  cp {MOUNT_PATH}/uv-${{UV_ARCH}}/uv /usr/local/bin/uv && "
        f"  cp {MOUNT_PATH}/uv-${{UV_ARCH}}/uvx /usr/local/bin/uvx 2>/dev/null; "
        "  chmod +x /usr/local/bin/uv /usr/local/bin/uvx 2>/dev/null; "
        "  UV_INSTALLED=1; "
        "  echo '[uv] 从 mount 复制完成'; "
        "fi; "
        # 方式2: 使用国内镜像下载（经测试无代理可用的源）
        "if [ $UV_INSTALLED -eq 0 ] && ! command -v uv &> /dev/null; then "
        "  echo '[uv] 尝试国内镜像下载...'; "
        "  mkdir -p /tmp/uv-install && "
        "  (curl -fsSL --connect-timeout 10 --max-time 60 "
        "    \"https://gh-proxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-${UV_ARCH}.tar.gz\" "
        "    | tar xz -C /tmp/uv-install 2>/dev/null) || "
        "  (curl -fsSL --connect-timeout 10 --max-time 60 "
        "    \"https://ghfast.top/https://github.com/astral-sh/uv/releases/latest/download/uv-${UV_ARCH}.tar.gz\" "
        "    | tar xz -C /tmp/uv-install 2>/dev/null) || "
        "  (curl -fsSL --connect-timeout 15 --max-time 120 "
        "    \"https://github.com/astral-sh/uv/releases/latest/download/uv-${UV_ARCH}.tar.gz\" "
        "    | tar xz -C /tmp/uv-install 2>/dev/null) || "
        "  (curl -LsSf https://astral.sh/uv/install.sh | sh 2>/dev/null) || "
        "  true; "
        "  if [ -f /tmp/uv-install/uv ]; then "
        "    cp /tmp/uv-install/uv /usr/local/bin/uv && chmod +x /usr/local/bin/uv; "
        "    cp /tmp/uv-install/uvx /usr/local/bin/uvx 2>/dev/null && chmod +x /usr/local/bin/uvx 2>/dev/null; "
        "  elif ls /tmp/uv-install/uv-*/uv 2>/dev/null; then "
        "    cp /tmp/uv-install/uv-*/uv /usr/local/bin/uv && chmod +x /usr/local/bin/uv; "
        "    cp /tmp/uv-install/uv-*/uvx /usr/local/bin/uvx 2>/dev/null && chmod +x /usr/local/bin/uvx 2>/dev/null; "
        "  fi; "
        "  rm -rf /tmp/uv-install; "
        "fi; "
        # 确保 ~/.local/bin 也有 uv（verifier 的 install.sh 检查此路径）
        "if command -v uv &> /dev/null; then "
        "  mkdir -p /root/.local/bin && "
        "  ln -sf $(which uv) /root/.local/bin/uv 2>/dev/null; "
        "  ln -sf $(which uvx) /root/.local/bin/uvx 2>/dev/null; "
        "  echo 'export PATH=\"/root/.local/bin:$PATH\"' > /root/.local/bin/env; "
        "  echo \"[uv] $(uv --version) 已安装\"; "
        "fi"
    )

    # cpython 预安装镜像地址（淘宝 NPM 镜像，加速 python-build-standalone 下载）
    _PYTHON_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone"

    # 使用国内镜像预安装 cpython + 持久化镜像配置
    _CPYTHON_PRECACHE_CMD = (
        # 持久化镜像配置：写入 uv.toml（所有 uv 调用自动生效，包括 verifier 阶段）
        "mkdir -p /root/.config/uv && "
        f"printf 'python-install-mirror = \"{_PYTHON_INSTALL_MIRROR}\"\\n\\n[pip]\\nindex-url = \"https://mirrors.aliyun.com/pypi/simple/\"\\n' > /root/.config/uv/uv.toml; "
        # 同时写入环境变量（兼容不读 uv.toml 的场景）
        f"echo 'export UV_PYTHON_INSTALL_MIRROR=\"{_PYTHON_INSTALL_MIRROR}\"' >> /etc/profile.d/uv-mirror.sh 2>/dev/null; "
        f"echo 'export UV_PYTHON_INSTALL_MIRROR=\"{_PYTHON_INSTALL_MIRROR}\"' >> /root/.bashrc 2>/dev/null; "
        f"export UV_PYTHON_INSTALL_MIRROR={_PYTHON_INSTALL_MIRROR}; "
        # 预安装 cpython，让 verifier 阶段跳过下载
        "if command -v uv &> /dev/null; then "
        "  echo '[cpython] 使用国内镜像预安装 Python...'; "
        "  uv python install 3.13 2>&1 || "
        "  echo '[cpython] 预安装失败，verifier 将自行下载'; "
        "else "
        "  echo '[cpython] uv 未安装，跳过 Python 预安装'; "
        "fi"
    )

    async def install(self, environment: BaseEnvironment) -> None:
        # 将 GitHub hosts 写入容器的 /etc/hosts（加速 GitHub 网络访问）
        await self.exec_as_root(
            environment,
            command=(
                f"if [ -f {self.MOUNT_PATH}/github-hosts.txt ]; then "
                f"  echo '# GitHub Hosts Start' >> /etc/hosts && "
                f"  cat {self.MOUNT_PATH}/github-hosts.txt >> /etc/hosts && "
                f"  echo '# GitHub Hosts End' >> /etc/hosts && "
                f"  echo '[hosts] GitHub hosts 已写入 /etc/hosts'; "
                f"else "
                f"  echo '[hosts] 未找到 github-hosts.txt，跳过'; "
                f"fi"
            ),
        )

        # 替换为国内镜像源（加速 apt/apk 下载）
        await self.exec_as_root(environment, command=self._MIRROR_CMD)

        # 安装系统依赖（bun 编译的二进制需要的基本库）
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apt-get &> /dev/null; then"
                "  apt-get update -qq && apt-get install -y -qq curl ca-certificates;"
                " elif command -v apk &> /dev/null; then"
                "  apk add --no-cache curl ca-certificates libstdc++ gcompat;"
                " elif command -v yum &> /dev/null; then"
                "  yum install -y curl ca-certificates;"
                " fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        # 预装 uv（避免 verifier 阶段因网络问题下载失败）
        await self.exec_as_root(
            environment,
            command=self._UV_INSTALL_CMD,
        )

        # 使用国内镜像预安装 cpython（避免 verifier 阶段从 github.com 缓慢下载）
        await self.exec_as_root(
            environment,
            command=self._CPYTHON_PRECACHE_CMD,
        )

        # 自动检测容器架构并复制对应二进制
        await self.exec_as_root(
            environment,
            command=(
                f"ARCH=$(uname -m); "
                f"if [ \"$ARCH\" = \"x86_64\" ] || [ \"$ARCH\" = \"amd64\" ]; then "
                f"  cp {self.MOUNT_PATH}/opendesk-linux-x64 /usr/local/bin/opendesk; "
                f"elif [ \"$ARCH\" = \"aarch64\" ] || [ \"$ARCH\" = \"arm64\" ]; then "
                f"  cp {self.MOUNT_PATH}/opendesk-linux-arm64 /usr/local/bin/opendesk; "
                f"else "
                f"  echo \"Unsupported architecture: $ARCH\" >&2; exit 1; "
                f"fi && "
                f"chmod +x /usr/local/bin/opendesk"
            ),
        )

        # 从 mount 点复制 setting.json
        await self.exec_as_root(
            environment,
            command=(
                "mkdir -p /root/.opendesk && "
                f"cp {self.MOUNT_PATH}/setting.json /root/.opendesk/setting.json"
            ),
        )

        # 同时为 agent user 写入
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p $HOME/.opendesk && "
                f"cp {self.MOUNT_PATH}/setting.json $HOME/.opendesk/setting.json"
            ),
        )

        # 验证安装（外部依赖通过 mount 的 node_modules stub 提供）
        await self.exec_as_agent(
            environment,
            command=(
                f"NODE_PATH={self.MOUNT_PATH}/node_modules "
                "opendesk --version"
            ),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        export_json_path = self.logs_dir / "opendesk-result.json"
        if export_json_path.exists():
            try:
                with open(export_json_path, "r") as f:
                    data = json.load(f)
                context.metadata = context.metadata or {}
                context.metadata["opendesk_result"] = data
            except Exception:
                pass

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped_instruction = shlex.quote(instruction)

        model_flag = ""
        if self._model_alias:
            model_flag = f"--model {shlex.quote(self._model_alias)} "

        await self.exec_as_agent(
            environment,
            command=(
                f"WORKDIR=/app; [ -d \"$WORKDIR\" ] || WORKDIR=$HOME; "
                f"cd \"$WORKDIR\" && "
                f"opendesk {model_flag}"
                f"--headless "
                f"--allow-everything "
                f"--export-json /logs/agent/opendesk-result.json "
                f"--profile /logs/agent/profile.json "
                f"-c {escaped_instruction} "
                f"2>&1 | tee /logs/agent/opendesk.txt"
            ),
            env={
                "TERM": "dumb",
                "NO_COLOR": "1",
                "NODE_PATH": f"{self.MOUNT_PATH}/node_modules",
            },
        )
