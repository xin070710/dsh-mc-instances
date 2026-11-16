# dsh-mc-instances 设计说明

> 本文件是**开发期设计笔记**。面向使用者的说明见 [`README.zh.md`](../README.zh.md)。

## 一句话

把「模组工程的实例隔离」变成 DSH 工具：`gradlew runClient -Pinstance=<名字>` → `run/<名字>/`，
插件负责**列实例、建实例、开关 mod、读日志、一键生成 IntelliJ 运行配置**。

## 为什么是这个形态

用户的需求可以概括为：同一工程下要快速切换多个 `run/<实例>/` 测试不同模组组合，
而 IDE 的运行下拉框只会列出默认实例，新增组合必须手写 `.run` 或改命令行。

拆开看，痛点有三个，且都不是「缺一个启动器」：

1. **IDE 运行下拉框里长不出新条目** —— 现有 11 个 `.run` 配置都是手写的。要测新组合就得手写 `.run` 或去改命令行。
2. **`run/<实例>/mods/` 得手动填** —— 没有「把 jei 丢进 dev2」这种一键动作。
3. **只是「启动不了」的表象** —— 真正缺的是「实例的创建 + 配置 + 一键启动」三段。

所以本插件**不做启动器**（IDE 里点绿三角才是他们既有的、带调试能力的启动方式），
而是补齐「让 IDE 能启动任意实例」这一段：写 `.run` 配置 + 管 mods。

## 机制（对着真实工程约定）

| 关注点 | 约定 |
|---|---|
| 实例 = ? | `run/<名字>/` 目录；名字为空 = 默认实例（`run/` 本身） |
| 实例隔离怎么实现 | 各工程 `build.gradle` 里的 `-Pinstance` → `gameDirectory`/`runDir` |
| 工程识别 | 有 `gradlew.bat` + `build.gradle`（且提到 instance 的才算） |
| 加载器识别 | `fabric-loom` / `net.neoforged.moddev` / `net.minecraftforge.gradle` / `neo_version` 等特征串 |
| run/ 下的固有目录 | 用黑名单排除（`mods`/`config`/`logs`/… ），其余才当实例候选 |
| 实例判定 | 含 `mods`/`logs`/`config`/`options.txt` 任一才算，避免把杂物目录当实例 |
| mod 启用/禁用 | `xxx.jar` ⇄ `xxx.jar.disabled`（改名，不删文件） |
| 工作区杂货区 | 段名以 `_` 开头的目录（`_shared`/`_mods`/`_templates`/`_tools`）一律跳过扫描 |

## 硬性设计约束

- **不动构建脚本**：只读 `build.gradle` 做识别，写操作限定在 `run/` 与 `.idea/runConfigurations/`。
- **不删 mod**：禁用即改名。
- **默认实例受保护**：`run/` 不允许删除。
- **工程匹配规则唯一**：`resolveProject()` 一处实现，`createInstance` / `findProfile` /
  `writeRunConfigs` 共用。曾经三处各写一套，导致「建到了 A 工程、随后在 B 工程找不到」。
- **workspace 必须透传**：工具层 `ws(args)` 而不是 `ws()`。曾漏传，导致测试实例被建进真实工作区。

## 踩过的坑（都写成了回归测试）

| 坑 | 症状 | 现在被哪条测试守着 |
|---|---|---|
| 用「文件里出现 neoforge 字样」判加载器 | Fabric 工程的注释里提到源工程 NeoForge → 判成 NeoForge | `扫描：识别加载器…`（断言 `fab.loader === 'fabric'`） |
| 下划线目录被当模板跳过 | 工作区有 `_mods/` 时，整个工程都扫不到 | 同上 + 端到端用例先建 `_mods/` |
| `ws()` 漏传 `args.workspace` | 测试实例建进真实工作区，且后续找不到 | 端到端用例断言 `gameDir` 落在临时工作区内 |
| 工程匹配三套规则 | 建到 A 工程、在 B 工程找不到 | `resolveProject` 单一实现 + 端到端用例 |
| 测试用固定实例名 | 上次失败残留导致后续全挂 | 实例名带 `pid + 时间戳` |

## 测试分层

- `tests/profiles.test.js` —— 纯逻辑（临时工作区里造假工程）
- `tests/tools.test.js` —— 工具层端到端（mock `ctx` 跑真实 `execute`）、插件配置默认工作区与契约检查
- `tests/panel-api.test.js` —— Host API 门禁、新建/mod/日志/IDE/删除、启动恢复与停止、邻域检测
- `scripts/verify-real-workspace.mjs` —— 对**真实工作区**只读验证（不改任何东西）

`node --test` 全量 15 条。

工具层测试需要 `@deepseek-ai/dsh-tools` 可解析；本地开发时在
`node_modules/@deepseek-ai/` 下放一个指向本地 checkout 的 junction 即可。
插件入口对该包做了**可选加载 + 内置降级**，所以从 git 源安装时也不会因 peer 解析失败而炸掉插件树。

## 上架流程

1. 发布到 npm（`npm publish`，需登录），或用 GitHub Release / tarball——市场都支持；
2. 往 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 的 `data/plugins/` 提 **一个 YAML 文件**（README 由 CI 生成，不要手改）；
3. CI 每日刷新 <https://awesome-dsh-plugin.com/plugins.json>，市场与目录站自动收录。

条目字段：`url / name / category / tarball(可选) / description{en,zh} / icon(可选)`。
本仓库的条目文件名为 `xin070710__dsh-mc-instances.yml`。

## 本地安装记录（开发）

```sh
# 在插件仓库根目录
pnpm dsh plugin --profile web add .
```

装完 profile 的 `package.json` 里多出 `dsh-mc-instances`（link）并追加进 `dsh.profile.bundles`；
`pnpm dsh web --dump-config` 里能看到 `# == dsh-mc-instances` 层。
**新增 bundle 需要重启 DSH 才生效**（HMR 只覆盖已加载插件的文件变更）。

卸载：

```sh
pnpm dsh plugin --profile web remove dsh-mc-instances
```
