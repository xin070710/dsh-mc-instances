/**
 * MC 测试实例（profile instance）的发现与操作。
 *
 * 这里的「实例」指的是工作区里各模组工程已有的实例隔离机制：
 *   gradlew runClient -Pinstance=<名字>   →   该工程的 run/<名字>/ 作为独立 gameDirectory
 * 每个实例自带 mods/ config/ saves/ logs/，互不干扰。
 *
 * 本模块把「扫描 / 新建 / 删实例 / mod 开关 / 读日志 / 生成 IDE 运行配置」
 * 做成纯 Node 实现（零依赖），供 DSH 工具层调用，也可单独测试。
 */
import fs from 'node:fs'
import path from 'node:path'

/** run/ 下这些是 Minecraft 固有目录，不是实例。 */
const RESERVED_RUN_DIRS = new Set([
  'mods', 'config', 'defaultconfigs', 'logs', 'crash-reports', 'saves', 'screenshots',
  'resourcepacks', 'shaderpacks', 'downloads', 'automodpack', 'local', 'replay_recordings',
  'server-resource-packs', 'versions', 'natives', 'pcl', '.mixin.out', 'data', 'resources',
  'telemetry', 'world', 'datapacks', 'backups', 'maps', 'schematics', 'exports',
])

/** 默认工作区：DSH_MC_WORKSPACE，未设置时用当前进程目录（通常是 DSH 安装目录）。 */
export const DEFAULT_WORKSPACE = path.resolve(process.env.DSH_MC_WORKSPACE || process.cwd())

/** 解析工作区：显式参数 > 插件配置 > 环境变量 > 默认值。 */
export function resolveWorkspace(explicit, configured) {
  const raw = explicit || configured || process.env.DSH_MC_WORKSPACE || DEFAULT_WORKSPACE
  return path.resolve(raw)
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

function statSafe(p) {
  try { return fs.statSync(p) } catch { return null }
}

/** 广度优先找 gradlew.bat，跳过模板/构建/依赖目录。 */
function findProjects(root, maxDepth = 4, budget = {}) {
  const out = []
  const queue = [[root, 0]]
  // 任意工作区（包括用户手选的文件夹）都要有上界：默认最多看 5000 个目录 / 3 秒，
  // 避免把 C:\ 这类根目录拖进一次同步扫描。父目录探测会传更小的预算。
  const maxDirs = Number(budget.maxDirs) > 0 ? Number(budget.maxDirs) : 5000
  const deadline = Date.now() + (Number(budget.deadlineMs) > 0 ? Number(budget.deadlineMs) : 3000)
  let visited = 0
  while (queue.length > 0) {
    if (visited++ > maxDirs || Date.now() > deadline) break
    const [dir, depth] = queue.shift()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }

    if (entries.some((e) => e.isFile() && e.name === 'gradlew.bat')) {
      const rel = path.relative(root, dir)
      // 工作区根自身若是工程也要算；其下的模板/脚手架目录（段名以 _ 开头）不算
      const segs = rel === '' ? [] : rel.split(path.sep)
      if (!segs.some((seg) => seg.startsWith('_'))) out.push(dir)
    }
    if (depth >= maxDepth) continue
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const n = e.name
      // 下划线目录（_shared / _mods / _templates / _tools）是工作区杂货区，
      // 不可能是模组工程，也不该拖慢扫描。
      if (n.startsWith('.') || n.startsWith('_') || n === 'build' || n === 'node_modules' || n === 'bin' || n === 'src') continue
      queue.push([path.join(dir, n), depth + 1])
    }
  }
  return out
}

function firstMatch(text, re) {
  const m = re.exec(text)
  return m ? m[1].trim() : null
}

function detectProject(dir, root) {
  const buildGradle = path.join(dir, 'build.gradle')
  if (!fs.existsSync(buildGradle)) return null
  let gradleText
  try { gradleText = fs.readFileSync(buildGradle, 'utf8') } catch { return null }
  if (!/instance/i.test(gradleText)) return null

  const propsPath = path.join(dir, 'gradle.properties')
  const props = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, 'utf8') : ''
  const all = `${gradleText}\n${props}`

  const supportsInstance = /-Pinstance/.test(gradleText) || /findProperty\(\s*['"]instance['"]/.test(gradleText)

  const mcVersion = firstMatch(all, /minecraft_version\s*[=:]\s*([0-9][\w.-]*)/)
    || firstMatch(all, /minecraft\s+["']([^"']+)["']/) || ''

  // 判定顺序 = 特异性从高到低；不能用「是否出现 neoforge 字样」（注释里会提到源工程）
  const hasFabric = /fabric-loom/.test(gradleText) || /fabric_api_version/.test(props)
  const hasNeoForge = /net\.neoforged\.(moddev|gradle)/.test(gradleText) || /neo_version/.test(props)
  const hasForge = /net\.minecraftforge\.gradle/.test(gradleText) || /forge_version/.test(props)
  const loader = hasFabric ? 'fabric' : hasNeoForge ? 'neoforge' : hasForge ? 'forge' : 'unknown'

  let java = Number(firstMatch(all, /JavaLanguageVersion\.of\((\d+)\)/)
    || firstMatch(all, /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?(\d+)/) || 0)
  if (!java) {
    java = mcVersion.startsWith('26.') || mcVersion.startsWith('25.') ? 25
      : /^1\.(21|20\.5|20\.6)/.test(mcVersion) ? 21 : 17
  }

  // runClient 会自动同步进实例 mods/ 的 jar（形如 new File(modsDir, 'pixelmon.jar')）
  const autoSyncedMods = [...gradleText.matchAll(/new File\(\s*modsDir\s*,\s*['"]([^'"]+\.jar)['"]\s*\)/g)]
    .map((m) => m[1])

  return {
    name: path.basename(dir),
    dir,
    relPath: path.relative(root, dir),
    loader,
    mcVersion,
    java,
    supportsInstance,
    autoSyncedMods: [...new Set(autoSyncedMods)],
    runRoot: path.join(dir, 'run'),
  }
}

/** 读实例 mods/，合并 xxx.jar 与 xxx.jar.disabled。 */
export function readMods(modsDir) {
  const map = new Map()
  for (const f of (() => { try { return fs.readdirSync(modsDir) } catch { return [] } })()) {
    const disabled = f.toLowerCase().endsWith('.jar.disabled')
    if (!disabled && !f.toLowerCase().endsWith('.jar')) continue
    const base = disabled ? f.slice(0, -'.disabled'.length) : f
    const st = statSafe(path.join(modsDir, f))
    const prev = map.get(base)
    if (prev && prev.enabled) continue
    map.set(base, { fileName: base, enabled: !disabled, sizeBytes: st ? st.size : 0 })
  }
  return [...map.values()].sort((a, b) => a.fileName.localeCompare(b.fileName))
}

function readProfile(project, name) {
  const isDefault = name === ''
  const gameDir = isDefault ? project.runRoot : path.join(project.runRoot, name)
  const modsDir = path.join(gameDir, 'mods')
  const logFile = path.join(gameDir, 'logs', 'latest.log')
  const mods = readMods(modsDir)
  const st = statSafe(logFile) || statSafe(gameDir)
  return {
    project: project.name,
    projectRelPath: project.relPath,
    name: isDefault ? '' : name,
    displayName: isDefault ? '(默认) run/' : name,
    // 工作区内唯一标识：工程相对路径 + 实例名。runConfigName 只保证「同工程内」
    // 可读，两个不同工程可以同名（例如 Fabric/jojo 与 NeoForge/jojo）。
    instanceId: `${project.relPath}::${isDefault ? '' : name}`,
    gameDir,
    projectDir: project.dir,
    exists: fs.existsSync(gameDir),
    modsDir,
    logFile,
    mods,
    enabledModCount: mods.filter((m) => m.enabled).length,
    lastActivity: st ? st.mtime.toISOString() : null,
    runConfigName: isDefault ? project.name : `${project.name}-${name}`,
  }
}

function looksLikeProfile(dir) {
  return ['mods', 'logs', 'config'].some((sub) => fs.existsSync(path.join(dir, sub)))
    || fs.existsSync(path.join(dir, 'options.txt'))
}

/** 扫描工作区，返回 { projects, profiles }。budget 可限制目录数与时限。 */
export function scan(workspace, { withProfiles = true, budget = {} } = {}) {
  const projects = []
  for (const dir of findProjects(workspace, 4, budget)) {
    const p = detectProject(dir, workspace)
    if (!p || (!p.supportsInstance && !withProfiles)) continue
    projects.push(p)
  }
  projects.sort((a, b) => a.relPath.localeCompare(b.relPath))

  const profiles = []
  for (const p of projects) {
    profiles.push(readProfile(p, ''))
    if (!withProfiles) continue
    for (const d of listDirs(p.runRoot)) {
      if (d.startsWith('.') || RESERVED_RUN_DIRS.has(d.toLowerCase())) continue
      const full = path.join(p.runRoot, d)
      if (!looksLikeProfile(full)) continue
      profiles.push(readProfile(p, d))
    }
  }
  return { projects, profiles }
}

/**
 * 统一的工程匹配规则（createInstance / findProfile / writeRunConfigs 必须用同一套，
 * 否则会出现「建到了 A 工程、随后在 B 工程里找不到」这类不一致）。
 *
 * 匹配优先级：精确目录名 > 精确相对路径 > 相对路径后缀；都不中则报错并给出候选。
 */
function resolveProject(projects, projectRef) {
  if (projectRef === undefined || projectRef === null || projectRef === '') return null
  const ref = String(projectRef).trim()
  const norm = (s) => s.split('/').join(path.sep).toLowerCase()
  const want = norm(ref)

  return projects.find((p) => p.name.toLowerCase() === want)
    ?? projects.find((p) => norm(p.relPath) === want)
    ?? projects.find((p) => norm(p.relPath).endsWith(path.sep + want))
    ?? null
}

function projectListForError(projects) {
  return projects.length > 0 ? projects.map((p) => p.relPath).join(', ') : '(无)'
}

function findProfile(workspace, projectName, instance = '') {
  const { projects, profiles } = scan(workspace)
  const project = resolveProject(projects, projectName)
  if (projectName && !project) {
    throw new Error(`找不到工程「${projectName}」。可用工程：${projectListForError(projects)}`)
  }
  const inst = instance === '(默认)' || instance === 'default' ? '' : (instance ?? '')
  let profile
  if (!project) {
    if (profiles.length === 1) profile = profiles[0]
    else throw new Error(`请指定 project。当前实例：${profiles.map((p) => `${p.projectRelPath}›${p.displayName}`).join(', ')}`)
  } else {
    profile = profiles.find((p) => p.projectRelPath === project.relPath && p.name === inst)
    if (!profile) {
      const avail = profiles.filter((p) => p.projectRelPath === project.relPath)
      throw new Error(`工程「${project.relPath}」下没有实例「${instance || '(默认)'}」。可用：${avail.map((p) => p.displayName).join(', ')}`)
    }
  }
  return { project, profile, projects, profiles }
}

/** 新建实例：建 run/<名字>/{mods,config,saves,logs}，并继承一份 options.txt。 */
export function createInstance(workspace, { project: projectName, instance, copyOptions = true }) {
  const name = String(instance ?? '').trim()
  if (!name) throw new Error('instance 不能为空')
  if (name.startsWith('.')) throw new Error('instance 名不能以点开头（扫描会跳过隐藏目录）')
  if (/[\\/:*?"<>|%]/.test(name)) throw new Error('instance 名不能包含 \\ / : * ? " < > | %')
  if (/[. ]$/.test(name)) throw new Error('instance 名不能以点或空格结尾（Windows 目录限制）')
  if (RESERVED_RUN_DIRS.has(name.toLowerCase())) throw new Error(`instance 名不能使用 Minecraft 保留目录名：${name}`)

  const { projects } = scan(workspace, { withProfiles: false })
  const project = resolveProject(projects, projectName)
  if (!project) throw new Error(`找不到工程「${projectName}」。可用：${projectListForError(projects)}`)

  const gameDir = path.join(project.runRoot, name)
  if (fs.existsSync(gameDir)) throw new Error(`实例目录已存在：${gameDir}`)

  for (const sub of ['mods', 'config', 'saves', 'logs']) {
    fs.mkdirSync(path.join(gameDir, sub), { recursive: true })
  }

  let inherited = false
  if (copyOptions) {
    const src = path.join(project.runRoot, 'options.txt')
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(gameDir, 'options.txt'))
      inherited = true
    }
  }

  const profile = readProfile(project, name)
  return { project, profile, inheritedOptions: inherited }
}

/** 删除实例目录（调用方需确认）。可用 runConfigName 或 project+instance 定位。 */
export function deleteInstance(workspace, { project: projectName, instance, runConfigName } = {}) {
  let profile
  if (runConfigName) {
    const { profiles } = scan(workspace)
    profile = profiles.find((p) => p.runConfigName === runConfigName)
    if (!profile) {
      throw new Error(`找不到实例「${runConfigName}」。可用：${profiles.map((p) => p.runConfigName).join(', ')}`)
    }
  } else {
    ({ profile } = findProfile(workspace, projectName, instance))
  }
  if (profile.name === '') throw new Error('默认实例（run/）不允许删除')
  fs.rmSync(profile.gameDir, { recursive: true, force: true })
  return profile
}

/** mod 开关：xxx.jar ⇄ xxx.jar.disabled。 */
export function setModEnabled(profile, fileName, enabled) {
  fs.mkdirSync(profile.modsDir, { recursive: true })
  const onPath = path.join(profile.modsDir, fileName)
  const offPath = `${onPath}.disabled`
  const on = fs.existsSync(onPath)
  const off = fs.existsSync(offPath)

  if (enabled && off) {
    if (on) fs.rmSync(offPath, { force: true })
    else fs.renameSync(offPath, onPath)
  } else if (!enabled && on) {
    if (off) fs.rmSync(onPath, { force: true })
    else fs.renameSync(onPath, offPath)
  }
  return readMods(profile.modsDir)
}

/** 把一个 jar 复制进实例 mods/。接受 xxx.jar 或 xxx.jar.disabled，目标文件名统一为 xxx.jar。 */
export function importMod(profile, sourceJar, enabled = true) {
  if (!fs.existsSync(sourceJar)) throw new Error(`源文件不存在：${sourceJar}`)
  fs.mkdirSync(profile.modsDir, { recursive: true })
  const fileName = path.basename(sourceJar).replace(/\.disabled$/i, '')
  const target = path.join(profile.modsDir, fileName)
  fs.copyFileSync(sourceJar, target)
  const off = `${target}.disabled`
  if (fs.existsSync(off)) fs.rmSync(off, { force: true })
  if (!enabled) fs.renameSync(target, off)
  return { fileName, mods: readMods(profile.modsDir) }
}

/** 候选 mod 来源：工作区 _shared、_mods、各工程 run/mods 与 run/<实例>/mods。 */
export function scanModCandidates(workspace) {
  const roots = []
  for (const [sub, label] of [['_shared', '_shared'], ['_mods', '_mods']]) {
    const d = path.join(workspace, sub)
    if (fs.existsSync(d)) roots.push([d, label])
  }
  for (const projectDir of findProjects(workspace)) {
    const runRoot = path.join(projectDir, 'run')
    if (!fs.existsSync(runRoot)) continue
    const rel = path.relative(workspace, projectDir)
    roots.push([path.join(runRoot, 'mods'), `${rel}/run/mods`])
    for (const d of listDirs(runRoot)) {
      const mods = path.join(runRoot, d, 'mods')
      if (fs.existsSync(mods)) roots.push([mods, `${rel}/run/${d}/mods`])
    }
  }

  const seen = new Set()
  const out = []
  for (const [dir, label] of roots) {
    for (const f of (() => { try { return fs.readdirSync(dir) } catch { return [] } })()) {
      if (!f.toLowerCase().endsWith('.jar')) continue
      const full = path.join(dir, f)
      if (seen.has(full.toLowerCase())) continue
      seen.add(full.toLowerCase())
      const st = statSafe(full)
      out.push({ fileName: f, path: full, source: label, sizeBytes: st ? st.size : 0 })
    }
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName))
}

/** 读实例日志尾部。 */
export function readLog(profile, tailLines = 120) {
  if (!fs.existsSync(profile.logFile)) return { exists: false, text: '', path: profile.logFile }
  const text = fs.readFileSync(profile.logFile, 'utf8')
  const lines = text.split(/\r?\n/)
  const tail = lines.slice(Math.max(0, lines.length - tailLines)).join('\n')
  return { exists: true, text: tail, path: profile.logFile, totalLines: lines.length }
}

/**
 * 只读文件尾部，避免为了 200 行日志把几十 MB 的 latest.log 整个读进内存。
 * 从末尾最多读 maxBytes 字节，丢掉第一行残片后按行切分。
 */
export function readTextTail(file, tailLines = 160, maxBytes = 262144) {
  let st
  try { st = fs.statSync(file) } catch { return { exists: false, text: '', path: file, bytes: 0, updatedAt: null, truncated: false } }
  if (!st.isFile()) return { exists: false, text: '', path: file, bytes: 0, updatedAt: null, truncated: false }
  const size = st.size
  const start = Math.max(0, size - maxBytes)
  let text = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const length = size - start
      const buf = Buffer.alloc(length)
      fs.readSync(fd, buf, 0, length, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { exists: false, error: '无法读取日志文件（可能被占用或没有权限）', text: '', path: file, bytes: size, updatedAt: st.mtime.toISOString(), truncated: false }
  }
  if (start > 0) {
    // 第一个换行之前是半行，无法判断完整性，直接丢弃。
    const nl = text.indexOf('\n')
    text = nl >= 0 ? text.slice(nl + 1) : ''
  }
  const lines = text.split(/\r?\n/)
  const tail = lines.slice(Math.max(0, lines.length - tailLines)).join('\n')
  return {
    exists: true,
    text: tail,
    path: file,
    bytes: size,
    updatedAt: st.mtime.toISOString(),
    truncated: start > 0,
  }
}

/** 实例目录里除 mods 之外的可见状态：存档、截图、崩溃报告、options.txt。 */
export function readInstanceExtras(profile) {
  const countDirs = (dir) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length } catch { return 0 }
  }
  const countFiles = (dir, filter) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && (!filter || filter(e.name))).length
    } catch { return 0 }
  }
  const newest = (dir) => {
    let best = null
    try {
      for (const e of fs.readdirSync(dir)) {
        const st = statSafe(path.join(dir, e))
        if (st && st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { name: e, mtimeMs: st.mtimeMs, size: st.size }
      }
    } catch { /* 目录不存在 */ }
    return best
  }

  const savesDir = path.join(profile.gameDir, 'saves')
  const crashDir = path.join(profile.gameDir, 'crash-reports')
  const screenshotsDir = path.join(profile.gameDir, 'screenshots')
  let newestSave = null
  try {
    for (const e of fs.readdirSync(savesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const st = statSafe(path.join(savesDir, e.name))
      if (st && (!newestSave || st.mtimeMs > newestSave.mtimeMs)) newestSave = { name: e.name, mtimeMs: st.mtimeMs }
    }
  } catch { /* 没有存档 */ }

  const options = {}
  try {
    const raw = fs.readFileSync(path.join(profile.gameDir, 'options.txt'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const key = line.slice(0, i)
      if (['lang', 'renderDistance', 'maxFps', 'guiScale', 'graphicsMode', 'showFps', 'fov'].includes(key)) {
        options[key] = line.slice(i + 1)
      }
    }
  } catch { /* 没有 options.txt */ }

  const crash = newest(crashDir)
  return {
    saves: countDirs(savesDir),
    newestSave: newestSave ? { name: newestSave.name, modifiedAt: new Date(newestSave.mtimeMs).toISOString() } : null,
    screenshots: countFiles(screenshotsDir),
    crashReports: countFiles(crashDir, (n) => n.endsWith('.txt')),
    latestCrash: crash ? { name: crash.name, sizeBytes: crash.size, modifiedAt: new Date(crash.mtimeMs).toISOString() } : null,
    options,
  }
}

/**
 * 快速探测一个工作区里有没有「支持实例隔离」的模组工程。
 * 只下潜两层并限制访问的目录数，用于右侧栏列出多个已注册工作区时的预算内扫描。
 */
export function probeWorkspace(root) {
  let exists = false
  try { exists = fs.statSync(root).isDirectory() } catch { exists = false }
  if (!exists) return { path: root, exists: false, projectCount: 0 }

  const queue = [[root, 0]]
  let visited = 0
  let projectCount = 0
  while (queue.length > 0 && visited < 600) {
    const [dir, depth] = queue.shift()
    visited++
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    const hasGradlew = entries.some((e) => e.isFile() && e.name === 'gradlew.bat')
    if (hasGradlew) {
      try {
        const text = fs.readFileSync(path.join(dir, 'build.gradle'), 'utf8')
        if (/-Pinstance/.test(text) || /findProperty\(\s*['"]instance['"]/.test(text)) projectCount++
      } catch { /* 没有 build.gradle 或读不到 */ }
    }
    if (depth >= 2) continue
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const n = e.name
      if (n.startsWith('.') || n.startsWith('_') || n === 'build' || n === 'node_modules' || n === 'bin' || n === 'src' || n === 'out' || n === '.gradle') continue
      queue.push([path.join(dir, n), depth + 1])
    }
  }
  return { path: root, exists: true, projectCount }
}

export { readProfile }

/**
 * 生成 IntelliJ IDEA 的 Gradle 运行配置（.run），让每个实例出现在 IDE 运行下拉框里。
 * 目录：<工作区>/.idea/runConfigurations/
 */
export function writeRunConfigs(workspace, { project: projectName, server = false } = {}) {
  const { projects, profiles } = scan(workspace)
  const targets = projectName
    ? (() => {
      const p = resolveProject(projects, projectName)
      if (!p) throw new Error(`找不到工程「${projectName}」。可用：${projectListForError(projects)}`)
      return { projects: [p], profiles: profiles.filter((x) => x.projectRelPath === p.relPath) }
    })()
    : { projects, profiles }

  const xmlAttr = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[ch])

  // 运行配置名默认用 runConfigName；工作区里有两个同名工程时它并不唯一
  // （例如 Fabric/jojo 与 NeoForge/jojo），必须加上工程路径前缀，否则后写的
  // .run 文件会覆盖前一个。
  const nameCounts = new Map()
  for (const item of profiles) nameCounts.set(item.runConfigName, (nameCounts.get(item.runConfigName) ?? 0) + 1)
  const rcBaseName = (profile) => {
    if ((nameCounts.get(profile.runConfigName) ?? 0) <= 1) return profile.runConfigName
    const segments = profile.projectRelPath.split(/[\\/]/).filter(Boolean)
    return `${segments.join('-')}-${profile.name || 'default'}`
  }

  const dir = path.join(workspace, '.idea', 'runConfigurations')
  fs.mkdirSync(dir, { recursive: true })

  const written = []
  for (const profile of targets.profiles) {
    const task = server ? 'runServer' : 'runClient'
    const rcName = rcBaseName(profile) + (server ? '（服务端）' : '')
    const projectPath = `$PROJECT_DIR$/${profile.projectRelPath.split(path.sep).join('/')}`
    const scriptParams = profile.name ? `-Pinstance=${profile.name}` : ''
    // 与工作区既有配置（会话 #33 建立的 *.run）保持同一格式
    const xml = `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="${xmlAttr(rcName)}" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="executionName" />
      <option name="externalProjectPath" value="${xmlAttr(projectPath)}" />
      <option name="externalSystemIdString" value="GRADLE" />
      <option name="scriptParameters" value="${xmlAttr(scriptParams)}" />
      <option name="taskDescriptions">
        <list />
      </option>
      <option name="taskNames">
        <list>
          <option value="${xmlAttr(task)}" />
        </list>
      </option>
      <option name="vmOptions" value="" />
    </ExternalSystemSettings>
    <ExternalSystemDebugServerProcess>true</ExternalSystemDebugServerProcess>
    <ExternalSystemReattachDebugProcess>true</ExternalSystemReattachDebugProcess>
    <DebugAllEnabled>false</DebugAllEnabled>
    <method v="2" />
  </configuration>
</component>
`
    const file = path.join(dir, `${rcName.replace(/[\\/:*?"<>|]/g, '_')}.run`)
    fs.writeFileSync(file, xml, 'utf8')
    written.push({
      instanceId: profile.instanceId,
      runConfigName: rcName,
      baseName: profile.runConfigName,
      file,
      task,
      scriptParams,
      project: profile.projectRelPath,
      instance: profile.displayName,
    })
  }
  return { dir, written }
}

export { RESERVED_RUN_DIRS }
