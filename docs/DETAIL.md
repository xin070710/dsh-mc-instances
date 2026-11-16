# MC 实例管理器

![MC 实例管理器右侧面板预览：会话右侧的实例卡片列表与 mod 开关，一键启动按钮，以及底部游戏日志窗口](preview.svg)

在 DeepSeek Harness 的右侧栏管理 Minecraft 模组测试实例（`run/<名字>/`），PCL2 风格的实例卡片让「换一套 mod 跑一次」变成一次点击。

## 功能

- **实例卡片**：按工程分组，显示加载器、MC 版本、JDK、mod 数与上次活动；支持搜索、加载器筛选、运行中筛选。
- **启动 / 停止**：后台执行 `gradlew runClient -Pinstance=…`（或 `runServer`），显示 PID 与运行时长；停止会先温和关闭，5 秒后才强制结束进程树。Gradle 输出写到工程的 `logs/launch-*.log`。
- **Mods**：启用/禁用只改名（`xxx.jar` ⇄ `xxx.jar.disabled`），不删文件；支持「只留这一个」、删除确认、从工作区的 `_shared/`、`_mods/` 与各实例 `mods/` 导入候选 jar。
- **日志**：游戏 `latest.log` 与 Gradle 启动日志两个分页，自动刷新、错误/警告高亮，只在贴近底部时跟随。
- **新建 / 删除**：新实例自动建 `mods/ config/ saves/ logs/`，继承默认实例的 `options.txt`，可从别的实例复制整套 mods；删除默认 `run/` 或运行中的实例会被拒绝。
- **IDE 配置**：为每个实例写 `.idea/runConfigurations/<工程>-<实例>.run`，IntelliJ 运行下拉框直接出现；同名工程自动加前缀。
- **入口与设置**：会话头部按钮、右侧栏指南卡片、MC 实例 tab；默认「附近没有实例时自动隐藏入口」（当前工作区含子目录 + 直接父目录），全隐藏时按 `Ctrl+Alt+M` 打开面板。

## 安全边界

面板 Host API 只接受本机回环页面 + 自定义请求头；「打开目录」只允许扫描到的实例/工程目录与日志、文本、图片类文件，拒绝可执行文件。插件不改 `build.gradle`，不删 mod 文件，不执行任意路径。

## 安装

从插件市场安装，或直接装 GitHub 源码：

```sh
dsh plugin --profile web add github:xin070710/dsh-mc-instances
```

无需构建。Agent 工具：`mc_instances`、`mc_instance_create`、`mc_mods`、`mc_instance_log`、`mc_ide_config`、`mc_instance_delete`、`mc_instance_launch`、`mc_instance_launch_log`。

## 链接

- 仓库：<https://github.com/xin070710/dsh-mc-instances>
- 问题：<https://github.com/xin070710/dsh-mc-instances/issues>
- 许可：MIT
