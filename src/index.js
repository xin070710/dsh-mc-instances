/**
 * dsh-mc-instances — DSH 插件：Minecraft 模组「测试实例」管理器。
 *
 * 工作区里各模组工程用 `gradlew runClient -Pinstance=<名字>` 做实例隔离
 * （`run/<名字>/` 各自带 mods/config/saves/logs）。本插件把这套机制变成
 * Agent 可直接调用的工具：列实例、建实例、开关 mod、读日志、生成 IDE 运行配置。
 *
 * 设计约束：渲染层与参数校验都走 DSH 工具契约（defineTool），
 * 文件操作集中在 ./profiles.js（纯 Node、零依赖、可单测）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { launchInstance, readLaunchLog } from './launcher.js'
import { registerPanelApi } from './panel-api.js'
import {
  resolveWorkspace,
  scan,
  createInstance,
  deleteInstance,
  setModEnabled,
  importMod,
  scanModCandidates,
  readLog,
  writeRunConfigs,
} from './profiles.js'

/**
 * 优先使用宿主提供的 @deepseek-ai/dsh-tools（完整参数校验、schema 投影、UI 卡片契约）。
 * 解析不到时退化为内置等价实现：该包由 DSH 安装提供，从 git 源安装本插件时未必解析得到，
 * 此时宁可降级可用，也不要让整个插件树加载失败。
 */
let defineTool
let usingFallback = false
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  usingFallback = true
  defineTool = fallbackDefineTool
}

export const name = 'mc-instances'
export const inject = ['tools']

/** 是否退化为内置实现（诊断用）。 */
export const degraded = () => usingFallback

/** 把 DSL 参数规格投影成 JSON Schema。 */
function paramsToJsonSchema(params) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(params ?? {})) {
    const node = {}
    if (spec.type && spec.type !== 'json') node.type = spec.type
    if (spec.description) node.description = spec.description
    if (spec.enum) node.enum = [...spec.enum]
    if (spec.items) node.items = spec.items.type === 'json' ? {} : { type: spec.items.type }
    properties[key] = node
    if (spec.required === true) required.push(key)
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * 内置降级实现：对外形状与 defineTool 一致，做「必填 + 枚举 + 类型」的保守校验，
 * 并为 output.render 提供文本兜底。宿主能提供真包时不会走到这里。
 */
function fallbackDefineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: paramsToJsonSchema(options.parameters),
    output: {
      schema: options.output?.schema ?? { type: 'json' },
      render: options.output?.render ?? ((_a, v) => text(typeof v === 'string' ? v : JSON.stringify(v, null, 2))),
    },
    async execute(args) {
      const a = args ?? {}
      for (const [key, spec] of Object.entries(options.parameters ?? {})) {
        const v = a[key]
        if (spec.required === true && (v === undefined || v === null || v === '')) {
          throw new Error(`缺少必填参数 ${key}`)
        }
        if (v === undefined || v === null) continue
        if (spec.enum && !spec.enum.includes(v)) {
          throw new Error(`参数 ${key} 只能是 ${spec.enum.join(' / ')}，收到 ${JSON.stringify(v)}`)
        }
        if (spec.type === 'string' && typeof v !== 'string') throw new Error(`参数 ${key} 应为字符串`)
        if (spec.type === 'number' && typeof v !== 'number') throw new Error(`参数 ${key} 应为数字`)
        if (spec.type === 'boolean' && typeof v !== 'boolean') throw new Error(`参数 ${key} 应为布尔值`)
        if (spec.type === 'array' && !Array.isArray(v)) throw new Error(`参数 ${key} 应为数组`)
      }
      return options.execute(a, {})
    },
  }
}

/** 统一的文本渲染：把结构化结果摊平成给人看的几行。 */
const text = (t) => [{ type: 'text', text: t }]

const loaderLabel = (l) => ({ fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge' })[l] ?? '未知加载器'

const sizeText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`)

function findByRunConfigName(workspace, runConfigName) {
  const { projects, profiles } = scan(workspace)
  const profile = profiles.find((p) => p.runConfigName === runConfigName)
  if (!profile) {
    throw new Error(`找不到实例「${runConfigName}」。可用：${profiles.map((p) => p.runConfigName).join(', ')}`)
  }
  const project = projects.find((p) => p.relPath === profile.projectRelPath)
  return { project, profile }
}

export function apply(ctx, config = {}) {
  // 个人 profile 可以在 cordis.patch.yml 的 mc-instances 行写 config.workspace，
  // 作为省略 workspace 参数时的默认值；公开仓库本身不写死任何路径。
  const configuredWorkspace = typeof config?.workspace === 'string' && config.workspace.trim() !== ''
    ? path.resolve(config.workspace.trim())
    : ''
  // 注意：必须把调用参数里的 workspace 透传给 resolveWorkspace，
  // 否则永远落到默认工作区（曾因此把测试实例建进了真实工作区）。
  const ws = (args) => resolveWorkspace(args?.workspace, configuredWorkspace)

  // ── 1) 列实例 / 详情 ───────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mc_instances',
    description:
      'List Minecraft mod-testing instances (per-project run/<name>/ profiles) in the workspace, '
      + 'or show one instance in detail. Use this before launching a test instance in the IDE.',
    parameters: {
      action: { type: 'string', enum: ['list', 'detail'], description: 'list = 全部实例；detail = 单个实例详情' },
      workspace: { type: 'string', description: '工作区根目录；省略时依次使用 DSH_MC_WORKSPACE 环境变量、进程当前目录' },
      runConfigName: { type: 'string', description: 'detail 时必填：IDE 运行配置名，如 example-mod-dev2' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: { type: 'string' },
          projects: { type: 'array', items: { type: 'json' } },
          instances: { type: 'array', items: { type: 'json' } },
          detail: { type: 'json' },
        },
      },
      render: (_a, v) => {
        if (v.detail) {
          const d = v.detail
          const lines = [
            `${d.projectRelPath} › ${d.displayName}`,
            `  游戏目录  ${d.gameDir}`,
            `  加载器    ${loaderLabel(d.loader)} ${d.mcVersion}  (JDK ${d.java})`,
            `  实例名    ${d.name || '(默认)'}    IDE 运行配置：${d.runConfigName}`,
            `  mod       ${d.enabledModCount} 启用 / ${d.mods.length} 总计`,
            `  上次活动  ${d.lastActivity ?? '（尚未启动过）'}`,
          ]
          if (d.mods.length > 0) {
            lines.push('  mod 列表：')
            for (const m of d.mods) lines.push(`    [${m.enabled ? '✔' : ' '}] ${m.fileName}  ${sizeText(m.sizeBytes)}`)
          }
          if (d.autoSyncedMods?.length) lines.push(`  启动时自动同步：${d.autoSyncedMods.join(', ')}`)
          return text(lines.join('\n'))
        }
        const lines = [`工作区：${v.workspace}`, `工程 ${v.projects.length} 个 / 实例 ${v.instances.length} 个`, '']
        let last = null
        for (const i of v.instances) {
          if (i.projectRelPath !== last) {
            lines.push(`${i.projectRelPath}`)
            last = i.projectRelPath
          }
          lines.push(`  ${i.displayName.padEnd(16)} ${String(i.enabledModCount).padStart(2)} mod   ${i.runConfigName}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const workspace = ws(args)
      const { projects, profiles } = scan(workspace)
      if (args.action === 'detail') {
        if (!args.runConfigName) throw new Error('detail 需要 runConfigName')
        const { project, profile } = findByRunConfigName(workspace, args.runConfigName)
        return {
          workspace,
          projects: [],
          instances: [],
          detail: { ...profile, loader: project.loader, mcVersion: project.mcVersion, java: project.java, autoSyncedMods: project.autoSyncedMods },
        }
      }
      return { workspace, projects, instances: profiles, detail: null }
    },
  }))

  // ── 2) 新建实例 ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mc_instance_create',
    description:
      'Create a new mod-testing instance for a project: makes run/<instance>/ with mods/config/saves, '
      + 'inherits options.txt when available, writes the IntelliJ run configuration, and can copy mods in.',
    parameters: {
      project: { type: 'string', required: true, description: '工程目录名或相对路径，如 example-mod 或 NeoForge/example-mod' },
      instance: { type: 'string', required: true, description: '实例名（会成为 run/<instance>/），如 dev2、测试B' },
      workspace: { type: 'string', description: '工作区根目录' },
      copyModsFromRunConfigName: { type: 'string', description: '可选：从这个已有实例复制 mods/ 里的全部 jar' },
      writeIdeConfig: { type: 'boolean', description: '是否生成 IntelliJ 运行配置，默认 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runConfigName: { type: 'string' },
          gameDir: { type: 'string' },
          modsDir: { type: 'string' },
          inheritedOptions: { type: 'boolean' },
          copiedMods: { type: 'array', items: { type: 'string' } },
          runConfigFile: { type: 'string' },
        },
      },
      render: (_a, v) => text([
        `已创建实例：${v.runConfigName}`,
        `  游戏目录：${v.gameDir}`,
        `  继承 options.txt：${v.inheritedOptions ? '是' : '否（源目录没有 options.txt）'}`,
        v.copiedMods.length ? `  复制进来的 mod（${v.copiedMods.length}）：${v.copiedMods.join(', ')}` : '  未复制 mod',
        v.runConfigFile ? `  IDE 运行配置：${v.runConfigFile}` : '  未生成 IDE 运行配置',
        '',
        '在 IntelliJ 运行下拉框里选「' + v.runConfigName + '」即可启动该实例（若下拉框没刷新，先 Reload Gradle 项目）。',
      ].join('\n')),
    },
    async execute(args) {
      const workspace = ws(args)
      const { project, profile, inheritedOptions } = createInstance(workspace, {
        project: args.project,
        instance: args.instance,
      })

      let copiedMods = []
      if (args.copyModsFromRunConfigName) {
        const src = findByRunConfigName(workspace, args.copyModsFromRunConfigName)
        for (const m of src.profile.mods) {
          const base = m.fileName
          const candidate = [
            `${src.profile.modsDir}\\${base}`,
            `${src.profile.modsDir}\\${base}.disabled`,
          ].find((p) => { try { return fs.existsSync(p) } catch { return false } })
          if (!candidate) continue
          importMod(profile, candidate, m.enabled)
          copiedMods.push(base)
        }
      }

      let runConfigFile = ''
      if (args.writeIdeConfig !== false) {
        const res = writeRunConfigs(workspace, { project: project.name })
        runConfigFile = res.written.find((w) => w.instanceId === profile.instanceId)?.file ?? ''
      }

      return {
        runConfigName: profile.runConfigName,
        gameDir: profile.gameDir,
        modsDir: profile.modsDir,
        inheritedOptions,
        copiedMods,
        runConfigFile,
      }
    },
  }))

  // ── 3) mod 管理 ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mc_mods',
    description:
      'List, enable, disable, import or remove mods of one Minecraft test instance. '
      + 'Disabling renames xxx.jar to xxx.jar.disabled, so switching test setups never deletes files.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'enable', 'disable', 'only', 'import', 'remove', 'candidates'] },
      runConfigName: { type: 'string', description: '目标实例（IDE 运行配置名，如 example-mod-dev2；candidates 时可省）' },
      mods: { type: 'array', items: { type: 'string' }, description: '要操作的 mod 文件名（不含 .disabled）；only/import 时可给多个' },
      workspace: { type: 'string', description: '工作区根目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runConfigName: { type: 'string' },
          mods: { type: 'array', items: { type: 'json' } },
          candidates: { type: 'array', items: { type: 'json' } },
          changed: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a, v) => {
        if (v.candidates.length > 0) {
          const lines = [`可导入的 mod（工作区 _shared / _mods / 各实例 mods）：`]
          for (const c of v.candidates) lines.push(`  ${c.fileName}   (${c.source}, ${sizeText(c.sizeBytes)})`)
          return text(lines.join('\n'))
        }
        const lines = [`${v.runConfigName} 的 mod（${v.mods.filter((m) => m.enabled).length} 启用 / ${v.mods.length} 总计）`]
        for (const m of v.mods) lines.push(`  [${m.enabled ? '✔' : ' '}] ${m.fileName}  ${sizeText(m.sizeBytes)}`)
        if (v.changed.length > 0) lines.push('', `本次改动：${v.changed.join('；')}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const workspace = ws(args)

      if (args.action === 'candidates') {
        return { runConfigName: '', mods: [], candidates: scanModCandidates(workspace), changed: [] }
      }

      if (!args.runConfigName) throw new Error(`${args.action} 需要 runConfigName`)
      const { profile } = findByRunConfigName(workspace, args.runConfigName)
      const wanted = args.mods ?? []
      const changed = []

      if (args.action === 'list') {
        return { runConfigName: profile.runConfigName, mods: profile.mods, candidates: [], changed }
      }

      if (wanted.length === 0) throw new Error(`${args.action} 需要 mods 列表`)

      if (args.action === 'only') {
        const keep = new Set(wanted)
        for (const m of profile.mods) {
          const want = keep.has(m.fileName)
          if (m.enabled !== want) {
            setModEnabled(profile, m.fileName, want)
            changed.push(`${m.fileName} → ${want ? '启用' : '禁用'}`)
          }
        }
      } else if (args.action === 'import') {
        const cands = scanModCandidates(workspace)
        for (const w of wanted) {
          const hit = cands.find((c) => c.fileName === w || c.fileName === `${w}.jar`)
          if (!hit) throw new Error(`工作区里找不到候选 mod「${w}」。先用 action=candidates 看可用列表。`)
          importMod(profile, hit.path, true)
          changed.push(`导入 ${hit.fileName}`)
        }
      } else if (args.action === 'remove') {
        for (const w of wanted) {
          for (const f of [w, `${w}.disabled`]) {
            const p = `${profile.modsDir}\\${f}`
            try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); changed.push(`删除 ${f}`) } } catch { /* 忽略 */ }
          }
        }
      } else {
        const enabled = args.action === 'enable'
        for (const w of wanted) {
          const hit = profile.mods.find((m) => m.fileName === w || m.fileName === `${w}.jar` || m.fileName === w.replace(/\.jar$/, ''))
          if (!hit) throw new Error(`实例里没有 mod「${w}」`)
          if (hit.enabled !== enabled) {
            setModEnabled(profile, hit.fileName, enabled)
            changed.push(`${hit.fileName} → ${enabled ? '启用' : '禁用'}`)
          }
        }
      }

      const after = findByRunConfigName(workspace, args.runConfigName).profile
      return { runConfigName: after.runConfigName, mods: after.mods, candidates: [], changed }
    },
  }))

  // ── 4) 读日志 ──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mc_instance_log',
    description:
      'Read the tail of a Minecraft test instance log (run/<instance>/logs/latest.log). '
      + 'Use it after launching an instance to see whether the mod loaded or crashed.',
    parameters: {
      runConfigName: { type: 'string', required: true, description: '目标实例（IDE 运行配置名）' },
      tailLines: { type: 'number', description: '读取最后多少行，默认 120，最大 2000' },
      workspace: { type: 'string', description: '工作区根目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exists: { type: 'boolean' },
          path: { type: 'string' },
          totalLines: { type: 'number' },
          text: { type: 'string' },
        },
      },
      render: (_a, v) => text(v.exists
        ? `${v.path}（共 ${v.totalLines} 行，下面是末尾）\n\n${v.text}`
        : `还没有日志：${v.path}\n（该实例尚未启动过，或日志被清空）`),
    },
    async execute(args) {
      const workspace = ws(args)
      const { profile } = findByRunConfigName(workspace, args.runConfigName)
      const tail = Math.min(Math.max(Number(args.tailLines) || 120, 1), 2000)
      const r = readLog(profile, tail)
      return { exists: r.exists, path: r.path, totalLines: r.totalLines ?? 0, text: r.text }
    },
  }))

  // ── 5) 生成 IDE 运行配置 ───────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mc_ide_config',
    description:
      'Write IntelliJ IDEA Gradle run configurations (.idea/runConfigurations/*.run) for every '
      + 'mod-testing instance, so each instance appears in the IDE run dropdown and can be launched '
      + 'with one click (task runClient with -Pinstance=<name>).',
    parameters: {
      project: { type: 'string', description: '只给这个工程生成；省略则全部工程' },
      server: { type: 'boolean', description: '生成服务端配置（runServer）而不是客户端，默认 false' },
      workspace: { type: 'string', description: '工作区根目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          written: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_a, v) => {
        const lines = [`已生成 ${v.written.length} 个 IDE 运行配置 → ${v.dir}`, '']
        for (const w of v.written) {
          lines.push(`  ${w.runConfigName.padEnd(24)} ${w.project}   ${w.task} ${w.scriptParams}`.trimEnd())
        }
        lines.push('', '在 IntelliJ：Reload Gradle 项目后，运行下拉框里就会出现这些条目，选中按绿三角即可启动。')
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const workspace = ws(args)
      const res = writeRunConfigs(workspace, { project: args.project, server: args.server === true })
      return { dir: res.dir, written: res.written }
    },
  }))

  // ── 6) 删除实例 ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mc_instance_delete',
    description: 'Delete a mod-testing instance directory (run/<instance>/). The default run/ instance cannot be deleted.',
    parameters: {
      runConfigName: { type: 'string', required: true, description: '要删除的实例（IDE 运行配置名）' },
      workspace: { type: 'string', description: '工作区根目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'string' },
          gameDir: { type: 'string' },
        },
      },
      render: (_a, v) => text(`已删除实例「${v.deleted}」：${v.gameDir}`),
    },
    async execute(args) {
      const workspace = ws(args)
      const profile = deleteInstance(workspace, { runConfigName: args.runConfigName })
      return { deleted: profile.runConfigName, gameDir: profile.gameDir }
    },
  }))

  // ── 7) 后台启动实例 ───────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mc_instance_launch',
    description:
      'Launch a mod-testing instance in the background: runs `gradlew runClient|runServer -Pinstance=<name>` '
      + 'for the target project and redirects output to logs/launch-<instance>-<side>.log. Returns immediately '
      + 'with the process id and log path; the game keeps running after this call.',
    parameters: {
      runConfigName: { type: 'string', required: true, description: '目标实例（IDE 运行配置名，如 example-mod-dev2）' },
      side: { type: 'string', enum: ['client', 'server'], description: 'client（默认，开发客户端）或 server' },
      workspace: { type: 'string', description: '工作区根目录' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: '额外 Gradle 参数，如 --offline' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'number' },
          instance: { type: 'string' },
          project: { type: 'string' },
          side: { type: 'string' },
          javaHome: { type: 'string' },
          gameDir: { type: 'string' },
          command: { type: 'string' },
          logFile: { type: 'string' },
        },
      },
      render: (_a, v) => text([
        `已在后台启动：${v.project} › ${v.instance}   (${v.side}, pid ${v.pid})`,
        `  JAVA_HOME  ${v.javaHome}`,
        `  游戏目录   ${v.gameDir}`,
        `  命令       ${v.command}`,
        `  启动日志   ${v.logFile}`,
        '',
        '游戏会继续在后台运行；用 mc_instance_launch_log 看启动进度，'
        + '进游戏后用 mc_instance_log 看 run/<实例>/logs/latest.log。',
      ].join('\n')),
    },
    async execute(args) {
      const workspace = ws(args)
      const { project, profile } = findByRunConfigName(workspace, args.runConfigName)
      const side = args.side === 'server' ? 'server' : 'client'
      const extraArgs = Array.isArray(args.extraArgs) ? args.extraArgs.filter((s) => typeof s === 'string') : []
      if (side === 'client' && !extraArgs.some((a) => a.includes('--username'))) {
        extraArgs.push('--args=--username Dev')
      }

      const r = launchInstance(project, profile, { side, extraArgs })
      return {
        pid: r.pid,
        instance: profile.displayName,
        project: project.relPath,
        side,
        javaHome: r.javaHome ?? '(系统 PATH)',
        gameDir: profile.gameDir,
        command: r.command,
        logFile: r.logFile,
      }
    },
  }))

  // ── 8) 读 Gradle 侧启动日志 ───────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mc_instance_launch_log',
    description:
      'Read the tail of the Gradle-side launch log written by mc_instance_launch '
      + '(logs/launch-<instance>-<side>.log inside the project). Build errors and dependency '
      + 'failures show up here, before the game writes its own logs/latest.log.',
    parameters: {
      runConfigName: { type: 'string', required: true, description: '目标实例（IDE 运行配置名）' },
      side: { type: 'string', enum: ['client', 'server'], description: '与启动时一致，默认 client' },
      tailLines: { type: 'number', description: '读取最后多少行，默认 80，最大 2000' },
      workspace: { type: 'string', description: '工作区根目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exists: { type: 'boolean' },
          path: { type: 'string' },
          totalLines: { type: 'number' },
          text: { type: 'string' },
        },
      },
      render: (_a, v) => text(v.exists
        ? `${v.path}（共 ${v.totalLines} 行，下面是末尾）\n\n${v.text}`
        : `还没有启动日志：${v.path}\n（这个实例还没用 mc_instance_launch 启动过）`),
    },
    async execute(args) {
      const workspace = ws(args)
      const { project, profile } = findByRunConfigName(workspace, args.runConfigName)
      const side = args.side === 'server' ? 'server' : 'client'
      const file = path.join(project.dir, 'logs', `launch-${profile.name || 'default'}-${side}.log`)
      const tail = Math.min(Math.max(Number(args.tailLines) || 80, 1), 2000)
      const r = readLaunchLog(file, tail)
      return { exists: r.exists, path: r.path, totalLines: r.totalLines ?? 0, text: r.text }
    },
  }))

  // ── 9) 右侧栏面板 API（浏览器半调用；webServer 缺席时静默跳过）────────
  registerPanelApi(ctx, { defaultWorkspace: configuredWorkspace })
}
