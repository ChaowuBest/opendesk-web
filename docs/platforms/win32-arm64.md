# Windows Arm上开发所需要的额外配置

## 注意事项

1. 在安装nodejs之前，一定要注意看nvm的配置。
   [nvm-windows](https://github.com/coreybutler/nvm-windows/releases)所提供的安装包是x86架构的，Windows Arm上也可以安装并以转译的形式运行，但这会导致默认安装的node版本是也是x86的，后续会有很多坑；

   总是建议你通过下面的完整命令来安装node, e.g.::
   ```shell
   nvm use v25.2.1 arm64
   # 安装完后执行 nvm list
   nvm list
   # 应当看到如下内容
   # * 25.2.1 (Currently using arm64-bit executable)
   #                          ~~~~~~~~~~~
   ```

## 安装 VS Buildtools

NodeJS生态中的大部分包都是跨平台的。但其中少数使用到了Native的组件。

NodeJS提供了node-gyp来构建这些包，但是在Arm64下，你需要手动安装构建所需要的工具链，也就是VS生成工具(VS Buildtools)，这里介绍了如何在Windows Arm上安装这些工具。

1. 在[Visual Studio下载界面](https://my.visualstudio.com/Downloads?q=visual%20studio%202022&wt.mc_id=o~msft~vscom~older-downloads)查找Visual Studio 2022 (因为目前node-gyp主流版本还不支持更新版本的VS);
2. 找到Build Tools for Visual Studio 2022, 并选择arm版本下载;
   ![Download Buildtools](../images/win-arm64-download-vsbuildtools.png)
3. 打开安装工具，选择**单个组件**（重要！在工作负荷里可能看不到arm64相关的内容），并勾选以下几个选项
    - Windows 11 SDK
    - MSVC v143 - VS 2022 C++ ARM64/ARM64EC 生成工具(最新)
    - 适用于最新v143生成工具的C++ ATL(ARM64/ARM64EC)
    - 用于v143生成工具的C++通用平台支持(ARM64/ARM64EC)
   ![Install Buildtools](../images/win-arm64-install-vsbuildtools.png)
   然后安装即可。

安装后重启你的IDE，之后由于安装包构建报错的软件包(如better-sqlite3等)应当都可以通过node-gyp正常安装。

## 设置默认编码为UTF8

参考[这篇帖子](https://zhuanlan.zhihu.com/p/153219931)的教程，在控制面板中将Windows的全局编码设定为UTF-8（否则默认情况下，中文的编码为GBK）.

如果不这么设置的话，部分需要node-gyp来本地构建的包会由于编码问题而无法编译(e.g. nodejieba)。在x86架构的Windows下，由于有预编译包的存在才不容易出现这个问题。