# MC Dev Tools

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=dofes.mcdev-tools)

一个用于我的世界中国版模组开发的一站式 VSCode 工具插件

> **本地分支说明**：本仓库是自用分支，扩展 ID 为 `dofes.mcdev-tools-custom`，与插件市场的 `dofes.mcdev-tools` 并存互不干扰（市场版不会自动覆盖本地版）。当前运行的版本号显示在侧边栏面板右上角的徽标上（读自 `package.json` 的 `version`），版本号高于市场版即说明加载的是本地构建。
>
> 本地构建并安装（改完代码执行一条命令，然后重载窗口即可）：
>
> ```bash
> npm run local:install
> ```

## 功能

- **官方调试器支持**：通过官方调试器接口进行 Python 调试，启动并自动管理调试会话
- 支持多客户端调试，自动分配可用端口
- 一键启动 `mcdk.exe` 启动游戏开发测试
- 侧边栏可视化配置面板（皮肤编辑、昼夜更替、窗口样式等）

## 游戏启动测试

1. 按 `Ctrl+F5` 自动启动**ModPC**并不带调试器附加的开发测试
2. 插件会自动：
   - 搜索系统环境中的**ModPC**包
   - 启动 `mcdk.exe` 进行开发测试

## 调试器使用方法

### 方式一：官方调试器（推荐）

1. 按 `F5` 选择 **"Minecraft Python Debug"** 调试配置
2. 插件会自动：
   - 通过 mcdk 启动游戏并附加 Python 调试器
   - 通过 ptvsd 官方接口建立调试连接
   - 支持多客户端同时调试，自动端口分配

**launch.json 配置示例：**
```json
{
    "type": "mcdev-tools",
    "request": "launch",
    "name": "Minecraft Python Debug",
    "timeout": 60000,
    "dapConfig": {
        "justMyCode": false
    }
}
```

### 方式二：注入调试（mcdbg）

1. 按 `F5` 选择 **"Minecraft Debug (Inject)"** 调试配置
2. 插件会自动：
   - 查询运行中的 Minecraft 进程
   - 使用 mcdbg 注入 debugpy 到目标进程
   - 连接 Python 调试器

**launch.json 配置示例：**
```json
{
    "type": "mcdev-tools-inject",
    "request": "launch",
    "name": "Minecraft Debug (Inject)",
    "port": 5678,
    "dapConfig": {
        "justMyCode": false
    }
}
```

## 性能监测

调试面板里的 **性能监测** 页签可以记录运行中游戏的帧率、进程 CPU 与内存，用来回答「游戏卡，但不知道卡在哪」。

1. 先用 `Ctrl+F5`（运行游戏）或 F5 调试启动游戏，并在面板顶部选中该会话
2. 打开 **性能监测**，选择采样间隔（0.5 / 1 / 2 / 5 秒）后点击 **开始监测**
3. 曲线与统计随采样实时刷新：
   - **帧率**：当前 / 平均 / 1% 最低帧 / 最低 / 最高（1% 最低帧 = 最差 1% 采样的平均值）
   - **CPU 占用**：按单核口径统计，超过 100% 表示多核并行
   - **工作集内存**：当前 / 平均 / 峰值 / 净增
4. **导出 CSV / JSON** 保存整段采样，便于和帧率掉点的时刻对照

说明：

- CPU 与内存来自宿主进程计数器（`GetProcessTimes` / `GetProcessMemoryInfo`），不进入游戏线程，几乎无开销
- 帧率依赖游戏侧暴露的帧率接口；接口不可用时只记录 CPU 与内存，并在面板给出提示
- 最多保留 7200 个采样点（1 秒间隔约 2 小时），超出后自动丢弃最早的采样
- 停止监测后采样仍保留，可以继续导出，再次开始监测会接着这段曲线

## 配置项

在 VS Code 设置中可以配置以下选项：

### 通用配置

| 配置项                  | 默认值 | 说明                                           |
| ----------------------- | ------ | ---------------------------------------------- |
| `mcdev-tools.timeout`   | 60000  | 等待调试器就绪的超时时间（毫秒）               |
| `mcdev-tools.mcdkPath`  | (内置) | mcdk.exe 路径（留空使用插件内置）              |
| `mcdev-tools.enable`    | false  | 强制启用插件（默认 false 自动扫描 Addon 结构） |

### 官方调试器（ptvsd）配置

| 配置项                                              | 默认值      | 说明                                 |
| --------------------------------------------------- | ----------- | ------------------------------------ |
| `mcdev-tools.ptvsd.enabled`                         | true        | 是否启用 ptvsd 调试模式              |
| `mcdev-tools.ptvsd.ip`                              | localhost   | ptvsd 调试 IP 地址                   |
| `mcdev-tools.ptvsd.port`                            | 5678        | ptvsd 调试端口（多客户端自动分配）   |
| `mcdev-tools.ptvsd.justMyCode`                      | false       | 是否仅调试用户代码                   |
| `mcdev-tools.ptvsd.debugOptions.showPrivateMembers`  | true        | 显示私有成员（以 `_` 开头）          |
| `mcdev-tools.ptvsd.debugOptions.showSpecialMembers`  | true        | 显示特殊成员（以 `__` 开头和结尾）   |
| `mcdev-tools.ptvsd.debugOptions.showFunctionMembers` | true        | 显示函数成员                         |
| `mcdev-tools.ptvsd.debugOptions.showBuiltinMembers`  | true        | 显示内置成员                         |

## 前置要求

- 安装 [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) 扩展
- mcdk.exe（插件内置或从 [mcdk](https://github.com/GitHub-Zero123/MCDevTool) 获取）
- mcdbg.exe（注入模式需要，插件内置或从 [mcpdb](https://github.com/Dofes/mcpdb) 获取）


## 相关项目

- [mcpdb](https://github.com/Dofes/mcpdb) - Minecraft Python 调试器核心（为旧版本提供注入模式）
- [mcdk](https://github.com/GitHub-Zero123/MCDevTool) - Modpc 开发测试启动器

## 贡献者

感谢所有为本项目做出贡献的开发者！

- **[Dofes](https://github.com/Dofes)**
- **[Zero123](https://github.com/GitHub-Zero123)**
