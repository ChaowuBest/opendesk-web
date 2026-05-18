# AGENTS.md

OpenDesk 是一个基于 Electron 的全能型 AI 工作站，同时提供 CLI 和 GUI 两种交互模式。
项目使用 TypeScript 编写，采用 Mulan PSL v2 开源协议。

## 开发命令

- 安装依赖: `npm install`
- 启动开发服务器 (Electron GUI): `npm start`
- 构建 CLI: `npm run build-cli`
- 构建全部 (Electron): `npm run build`
- 运行 CLI: `npm run cli`
- 运行测试: `npm test`
- 代码检查: `npm run lint`
- 代码格式化: `npm run format`
- 架构检查: `npm run check:architecture`

## 验证变更

在完成代码修改后，必须运行以下命令确认构建通过：

```bash
npm run build-cli
npm run build
```

如果引入了新功能或修复了 bug，应当运行相关测试：

```bash
npm test
```

## 代码风格

- **语言**: TypeScript strict mode
- **模块**: ES Modules (`"type": "module"`)，所有导入使用 `.js` 后缀
- **导入**: 始终使用顶层静态 import 语句，除非有充分理由需要动态导入
- **注释**: 不要删除现有代码中的注释，除非你明确被要求删除或重构相关代码。添加新代码时只为不显而易见的逻辑添加注释
- **缩进**: 4 空格
- **引号**: 单引号
- **分号**: 必须有
- **尾逗号**: 无
