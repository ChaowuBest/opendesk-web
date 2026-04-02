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
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


def _load_opendesk_setting() -> dict:
    """从宿主机读取 OpenDesk 的 setting.json。"""
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
        return self._version or "0.1.4"

    async def install(self, environment: BaseEnvironment) -> None:
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
                f"cd /app && "
                f"opendesk {model_flag}"
                f"--headless "
                f"--export-json /logs/agent/opendesk-result.json "
                f"-c {escaped_instruction} "
                f"2>&1 | tee /logs/agent/opendesk.txt"
            ),
            env={
                "TERM": "dumb",
                "NO_COLOR": "1",
                "NODE_PATH": f"{self.MOUNT_PATH}/node_modules",
            },
        )
