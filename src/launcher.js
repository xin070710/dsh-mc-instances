/**
 * 启动模组工程的开发实例：在后台拉起 `gradlew <task> -Pinstance=<名字>`。
 *
 * 设计要点：
 * - **立即返回**，游戏在后台跑；输出重定向到文件（`logs/launch-<实例>.log`），
 *   既避免管道捕获（本机沙箱下 Node 的 `stdio: 'pipe'` 会 EPERM），
 *   也让游戏进程与工具调用解耦——这就是「启动后游戏继续跑」的基本要求。
 * - **JAVA_HOME 自动匹配**：工程 `org.gradle.java.home` 优先；否则按工程需要的 JDK 主版本
 *   从环境变量与常见安装位置挑一个；找不到就交给系统 PATH。
 * - 不在此处杀进程：Windows 上要连带结束 Gradle fork 出的游戏 JVM 需要 taskkill /T，
 *   容易误伤用户自己开的实例，所以只提供「启动 + 读日志」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * 可选的 JDK 搜索根目录。只放通用的安装位置；个人机器上的特殊目录用
 * DSH_MC_JDK17 / DSH_MC_JDK21 / DSH_MC_JDK25 环境变量补。
 */
const JDK_ROOTS = [
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Java'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Adoptium'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Amazon Corretto'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Java'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'),
  path.join(os.homedir(), '.jdks'),
  '/usr/lib/jvm',
  '/Library/Java/JavaVirtualMachines',
].filter(Boolean)

function hasJava(dir) {
  return fs.existsSync(path.join(dir, 'bin', 'java.exe')) || fs.existsSync(path.join(dir, 'bin', 'java'))
}

/** 读 release 文件里的 JAVA_VERSION；读不到返回 null。 */
function javaMajor(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'release'), 'utf8')
    const match = /JAVA_VERSION="(\d+)/.exec(text)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

function javaCandidates(version) {
  const out = []
  const env = process.env[`DSH_MC_JDK${version}`]
  if (env) out.push(env)
  if (process.env.JAVA_HOME) out.push(process.env.JAVA_HOME)
  for (const root of JDK_ROOTS) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/jdk|jre|java|temurin|corretto|zulu/i.test(entry.name)) continue
      out.push(path.join(root, entry.name))
      // macOS 的 JDK 在 *.jdk/Contents/Home
      out.push(path.join(root, entry.name, 'Contents', 'Home'))
    }
  }
  return [...new Set(out)]
}

function resolveJavaHome(javaVersion) {
  if (!javaVersion) return null
  for (const cand of javaCandidates(javaVersion)) {
    if (!hasJava(cand)) continue
    const major = javaMajor(cand)
    if (major === null || major === Number(javaVersion)) return cand
  }
  return null
}

/** 启动/运行期的错误也写进启动日志，便于事后排查。 */
function LogError(message) {
  try {
    fs.appendFileSync(
      path.join(process.env.TEMP || '.', 'mc-instances-launch-error.log'),
      `[${new Date().toISOString()}] ${message}\n`,
    )
  } catch { /* 忽略 */ }
}

function probeGradleJavaHome(projectDir) {
  try {
    const text = fs.readFileSync(path.join(projectDir, 'gradle.properties'), 'utf8')
    const m = /org\.gradle\.java\.home\s*=\s*(.+)/.exec(text)
    if (!m) return null
    // 形如 D:\\tools\\jdk-25 ：先把 gradle.properties 里转义的反斜杠还原
    const p = m[1].trim().replace(/\\\\/g, '\\')
    return fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

/**
 * 后台启动一个实例。
 *
 * @returns {{pid:number, logFile:string, command:string, javaHome:string|null, side:string, instance:string}}
 */
export function launchInstance(project, profile, { side = 'client', extraArgs = [] } = {}) {
  const gradlew = path.join(project.dir, 'gradlew.bat')
  if (!fs.existsSync(gradlew)) {
    throw new Error(`工程目录里没有 gradlew.bat：${gradlew}`)
  }

  const task = side === 'server' ? 'runServer' : 'runClient'
  // 工程显式写死的 org.gradle.java.home 优先；否则按工程需要的主版本自动找。
  const javaHome = probeGradleJavaHome(project.dir) ?? resolveJavaHome(project.java)

  // 参数顺序：先 -Pinstance，再任务名
  const args = ['--console=plain', '--no-daemon']
  if (profile.name) {
    const value = `-Pinstance=${profile.name}`
    // 实例名可能带空格；cmd /c 下需要整体加引号，否则会被拆成两个参数。
    args.push(/[\s"&|<>^]/.test(profile.name) ? `"${value.replace(/"/g, '')}"` : value)
  }
  args.push(task)
  if (side === 'server') args.push('--args=--nogui')
  args.push(...extraArgs)

  const logDir = path.join(project.dir, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, `launch-${profile.name || 'default'}-${side}.log`)
  const fd = fs.openSync(logFile, 'w')

  const header = [
    `# ${new Date().toISOString()}  启动 ${project.relPath} › ${profile.displayName}`,
    `# task=${task}${profile.name ? ` -Pinstance=${profile.name}` : ''}`,
    `# JAVA_HOME=${javaHome ?? '(系统 PATH)'}`,
    `# 游戏目录=${profile.gameDir}`,
    '',
  ].join('\n')
  fs.writeSync(fd, header)

  // Windows 上 Node 不能直接 spawn .bat（会 EINVAL），必须经 cmd /c。
  // 日志已落到文件，控制台窗口隐藏即可。
  const child = spawn('cmd.exe', ['/c', gradlew, ...args], {
    cwd: project.dir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      ...(javaHome ? { JAVA_HOME: javaHome } : {}),
      // 中文路径 / 中文实例名：统一 UTF-8，避免 Gradle 输出乱码
      GRADLE_OPTS: [process.env.GRADLE_OPTS, '-Dfile.encoding=UTF-8'].filter(Boolean).join(' '),
    },
  })
  child.on('error', (err) => {
    LogError(`启动失败：${err.message}`)
  })

  const pid = child.pid ?? -1
  child.unref()
  // 父进程这边关掉自己的 fd 副本，让子进程独立持有
  try { fs.closeSync(fd) } catch { /* 忽略 */ }

  return {
    pid,
    logFile,
    command: `gradlew ${args.join(' ')}`,
    javaHome,
    side,
    instance: profile.displayName,
    // 面板 API 用它在进程退出时更新状态；Agent 工具不会序列化这个字段。
    child,
  }
}

/** 读启动日志尾部（与 run/<实例>/logs/latest.log 不同：这里含 Gradle 自身的输出）。 */
export function readLaunchLog(logFile, tailLines = 80) {
  if (!fs.existsSync(logFile)) {
    return { exists: false, text: '', path: logFile }
  }
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/)
  return {
    exists: true,
    path: logFile,
    totalLines: lines.length,
    text: lines.slice(Math.max(0, lines.length - tailLines)).join('\n'),
  }
}

/** 判断某个启动日志对应的进程是否还在跑（按日志文件是否仍被独占判断不可靠，这里用 pid 探测）。 */
export function isRunning(pid) {
  if (!pid || pid < 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
