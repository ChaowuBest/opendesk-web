# FillipDesk 开发说明

## 1. 配置开发环境

### 安装NVM, NodeJS和Electron

#### 配置国内镜像源

首先需要配置国内的NPM镜像源
```shell
npm config set registry https://registry.npmmirror.com
npm config get registry
```
由于Electron安装过程中会单独下载Electron自己的二进制文件，所以需要额外配置镜像。
根据你使用的Shell环境不同，你需要自己选择正确的环境变量配置方式，以`bash`为例，需要在
`$HOME/.bashrc`中添加:

```sh
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

## 2. 安装包构建

当前FillipDesk通过Electron Forge支持Windows和MacOS平台上的安装包构建。

### MacOS (dmg)

首先你需要有一台MacOS设备作为打包环境。在这台设备上将开发环境配置完成之后，直接运行下面的命令：

```shell
npm run package
npm run make
```
即可在`out/make/`中生成对应的dmg格式安装包。

### Windows (MSI)

在Windows下，我们通过`maker-wix`来构建.msi格式的安装包。

#### 配置依赖项

1. 下载并安装[Wix3 Toolset](https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm)
2. 将Wix的bin目录(我这里是`C:\Program Files (x86)\WiX Toolset v3.14\bin`配置到环境变量`PATH`中, 如果你修改了安装路径，那么按你自己的情况配置)

#### 构建安装包

在bash或cmd中运行下面的命令即可。

```shell
npm run package
npm run make
```

构建好的安装包会保存在`out/make/wix`中。

## 3. 后续开发规划

#### 版本节奏

- 每周更新一个修订版本(Patch version), e.g. 从`0.1.0`到`0.1.1`
- 有部分新增完整功能的时候更新小版本(Minor version), e.g. 从`0.1.13`到`0.2.0`
- 在合适的时机(Who Knows?)推出大版本

#### 当前计划支持的功能

- 基础功能
  - [ ] 聊天界面
    - [ ] 支持tokens统计和费用统计
    - [ ] 支持发送图片
    - [ ] 支持接收图片模型收到的图片
- 系统服务
  - [ ] AI文件系统
    - [ ] 显示文件系统索引状态
    - [ ] 优化标题嵌入搜索效果
    - [ ] 文件内容分块嵌入和查找
      - [ ] ppt/doc格式处理
      - [ ] pdf格式处理
      - ...
  - [ ] AI工作空间
  - [ ] 生成式通知
  - [ ] 系统设置
    - [ ] 设置刷新后自动重启对应服务
- 智能体
  - [ ] DeepResearch
- AI原生应用
  - [ ] 统一搜索(Search Everything)
  - [ ] AI收件箱
    - [ ] 邮件接入统一搜索
  - [ ] AI活动记录
    - [ ] 会议录制
    - [ ] 会议文本生成和摘要
    - [ ] 会议报告(PPT)输出？
  - [ ] AI PPT生成