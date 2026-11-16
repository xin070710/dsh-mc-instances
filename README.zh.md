# dsh-mc-instances

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)

<img src="assets/icon-180.png" width="96" height="96" alt="dsh-mc-instances icon" align="right">

> **右侧面板入口**：插件加载后，会话右侧栏多出「MC 实例」tab；在指南页点「MC 实例管理器」卡片，或点会话头部的 MC 实例按钮，打开的都是同一个 PCL2 风格面板——实例卡片、一键启动/停止、mod 开关、游戏/Gradle 日志都在里面。禁用插件后这些入口消失；面板只操作 `run/`、`.idea/runConfigurations/` 与工程的 `logs/` 启动日志，不改动工程文件。

装在 DeepSeek Harness 里的 **Minecraft 模组测试实例管理器**。

<img src="docs/preview.svg" alt="PCL2 风格实例管理面板预览" width="900">

它管的是模组开发里那套「实例隔离」机制：每个工程用
`gradlew runClient -Pinstance=<名字>` 把游戏目录切到自己的 `run/<名字>/`，
各实例自带 `mods/ config/ saves/ logs/`，互不干扰。

问题在于：**这些实例在 IDE 的运行下拉框里长不出来**，想测「模组 B」只能去手改 Gradle 命令，
`mods/` 也得手动往里丢。这个插件把整套操作变成一句话，或一次点击。

## 它给你什么

| 能力 | 说明 |
|---|---|
| **右侧栏 PCL2 风格面板** | 会话右侧栏的「MC 实例」tab：实例卡片按工程分组，显示加载器、MC 版本、JDK、mod 数、上次活动；支持搜索、加载器筛选、运行中筛选。自动检测当前会话工作区；默认开启「附近没有实例时自动隐藏入口」 |
| **启动 / 停止** | 面板里直接拉起 `gradlew runClient -Pinstance=…`（也可启动服务端），显示 PID 与运行时长；停止会结束整个进程树，Gradle 输出落到工程的 `logs/launch-*.log` |
| **游戏与 Gradle 日志** | 两个日志分页，自动刷新、错误/警告高亮；可以复制路径或在文件管理器中定位 |
| **列实例** | 扫出工作区里所有支持实例隔离的工程，以及每个工程下的全部实例（含默认 `run/`），标注加载器、MC 版本、JDK、mod 数量、上次启动时间 |
| **一键生成 IDE 运行配置** | 为每个实例写 `.idea/runConfigurations/<工程>-<实例>.run`，IntelliJ 运行下拉框里直接出现条目，**选它按绿三角就启动**，调试/断点照常可用 |
| **新建实例** | 一句话建出 `run/<名字>/{mods,config,saves,logs}`，并继承默认实例的 `options.txt`（键位/画面设置不用重配） |
| **mod 开关** | 勾选即启用/禁用 —— 禁用只是把 `xxx.jar` 改名成 `xxx.jar.disabled`，**不删文件**，秒切测试组合；还支持「只留这一个」 |
| **从工作区挑 mod** | 自动汇总 `_shared/`、`_mods/`、各工程 `run/mods`、各实例 `run/<实例>/mods` 里的 jar 作为候选，一句话导入到目标实例 |
| **读日志** | 直接读实例的 `logs/latest.log` 尾部，启动完就能看模组有没有加载/崩溃 |
| **删实例** | 删掉 `run/<实例>/`（默认实例 `run/` 受保护，删不掉） |

## 安装

从插件市场安装（推荐）：打开 **插件 → 插件市场**，搜索 “MC 实例” 或 `dsh-mc-instances`，点安装。

也可以直接装 GitHub 源码（无需构建）：

```sh
dsh plugin --profile web add github:xin070710/dsh-mc-instances
```

装完重启 `dsh web` 即可，无需其它配置。桌面端请在应用内 **设置 → 插件** 安装，profile 名称以应用为准。

## 用法（对着 Agent 说人话就行）

```
帮我看下现在有哪些测试实例
给 example-mod 新建一个叫 dev2 的实例，顺手把 jei 复制进去
把 example-mod-dev2 的 mod 只留 Pixelmon，其它都关掉
生成一下 IDE 运行配置
example-mod-dev2 启动崩了，看下日志
```

Agent 会调用下面这几个工具：

| 工具 | 作用 |
|---|---|
| `mc_instances` | `action: list` 列全部实例；`action: detail` 看某个实例详情（含 mod 列表） |
| `mc_instance_create` | 建实例；可选 `copyModsFromRunConfigName` 从别的实例复制整套 mods，默认顺手生成 IDE 运行配置 |
| `mc_mods` | `list` / `enable` / `disable` / `only` / `import` / `remove` / `candidates` |
| `mc_instance_log` | 读**游戏侧**日志尾部（`run/<实例>/logs/latest.log`，默认 120 行，最多 2000） |
| `mc_ide_config` | 为全部或某个工程生成 IntelliJ 运行配置（`server: true` 则生成 `runServer` 版本） |
| `mc_instance_delete` | 删除实例目录 |
| `mc_instance_launch` | **在后台直接拉起实例**（`gradlew runClient -Pinstance=…`），立即返回 pid 与日志路径，游戏继续跑 |
| `mc_instance_launch_log` | 读 **Gradle 侧**启动日志（`logs/launch-<实例>-<side>.log`），构建/依赖报错在这里 |

## 配置

工作区根目录按这个顺序解析：

1. 工具参数 `workspace`
2. 环境变量 `DSH_MC_WORKSPACE`
3. 进程当前目录

面板会优先读取 DSH 已注册工作区；当前工作区附近没有实例时，按「自动隐藏」设置决定是否切到其它含 MC 工程的工作区。

启动 `dsh web` 前设置环境变量即可换默认工作区：

```sh
DSH_MC_WORKSPACE=D:\path\to\your\mods dsh web
```

也可以在 profile 的 `cordis.patch.yml` 里给插件行写默认工作区（公开仓库本身不写死路径）：

```yaml
- id: mc-instances
  name: dsh-mc-instances
  config:
    workspace: D:\path\to\your\mods
```

JDK 解析顺序：工程 `gradle.properties` 的 `org.gradle.java.home` → `DSH_MC_JDK17/21/25` → `JAVA_HOME` → 常见安装目录（`C:\Program Files\Java`、Eclipse Adoptium、Microsoft、`~/.jdks`、`/usr/lib/jvm` 等）。

## 在 IntelliJ 里的完整流程

1. 让 Agent「生成 IDE 运行配置」（或自己调 `mc_ide_config`）
2. 回到 IntelliJ，右侧 Gradle 面板点 **Reload**（首次需要，让 IDEA 重新读运行配置）
3. 顶部运行下拉框里就会出现 `example-mod-dev2` 这类条目，选中按绿三角
4. 启动后让 Agent「看下 example-mod-dev2 的日志」，就能确认模组加载情况

## 行为约定

- **没有实例时自动隐藏入口（可设置）**：默认开启。检测范围是当前工作区（含子目录）与直接父目录；附近没有 MC 工程/实例时，隐藏会话头部的 MC 实例按钮，并让右侧栏指南里的 MC 实例卡片一起消失，同时停止自动切换到其它工作区。入口全隐藏时按 **Ctrl+Alt+M**（macOS 为 ⌘⌥M）打开面板，再在右上角齿轮「MC 实例设置」里关闭自动隐藏；设置保存在当前浏览器 / 桌面 profile。
- **不改你的构建脚本**。插件只读 `build.gradle` 来识别加载器/版本/JDK，写操作全部发生在 `run/` 与 `.idea/runConfigurations/` 里。
- **不删 mod 文件**。禁用 = 改名加 `.disabled` 后缀，可随时切回。
- **默认实例受保护**：`run/` 本身不允许删除；运行中的实例也拒绝删除。
- **同名工程可区分**：工作区里可能有 `Fabric\example` 与 `NeoForge\example` 这类同名工程，面板用「工程相对路径 + 实例名」作为唯一身份；生成 IDE 配置时若运行配置重名，会自动加工程前缀（如 `Fabric-example-default`）。
- **启动记录落盘**：正在运行的实例记录写在 `%DSH_HOME%/mc-instances/launches.json`，Host 插件重载后仍会拒绝重复启动同一个实例。停止时先温和关闭，5 秒后才强制结束进程树。
- **面板只开安全的路径**：Host API 只接受本机回环页面 + 自定义请求头；「打开目录」只允许扫描到的实例/工程目录与日志、文本、图片类文件，拒绝 `.exe` 等可执行类型。通过 dsh-pocket 等远程入口访问时面板不可用，但 Agent 工具仍可用。
- **扫描有预算**：每次扫描最多访问 5000 个目录 / 3 秒，避免手选到 `C:\` 这类根目录时卡住界面。
- **零运行时依赖**：文件操作是纯 Node 实现，宿主的 `@deepseek-ai/dsh-tools` 是唯一 peer 依赖。
- 生成的 `.run` 文件与工作区既有的 IntelliJ 运行配置同格式（`GradleRunConfiguration` + `runClient` + `-Pinstance=<名字>`）。

## 开发

```sh
node --test
```

- `src/profiles.js` —— 纯 Node 的实例/工程扫描与操作，不需要 DSH 运行时即可单测
- `src/index.js` —— DSH 工具层（`defineTool`），把上面对外暴露成工具
- `src/panel-api.js` —— 右侧栏面板的 Host HTTP API（本机回环 + 自定义头门禁）
- `client.js` —— 浏览器端的右侧栏 tab / 指南卡片 / 头部按钮
- `tests/` —— 纯逻辑、工具层端到端、面板 API 与启动/停止

本地跑工具层测试需要能解析 `@deepseek-ai/dsh-tools`（由 DSH 安装提供），
在 `node_modules/@deepseek-ai/` 下放一个指向它的链接即可；解析不到时插件会自动降级到内置实现。

欢迎提交 issue / PR。提交条目到社区市场请见 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)；本仓库的条目文件为 `xin070710__dsh-mc-instances.yml`。

## License

MIT © dsh-mc-instances contributors
