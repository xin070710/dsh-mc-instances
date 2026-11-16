/**
 * 用插件的 launcher 真启动一个实例（供人工验证用）。
 *
 *   node scripts/launch.mjs <工程名或相对路径> [实例名] [client|server] [工作区]
 * 例：
 *   node scripts/launch.mjs example-mod
 *   node scripts/launch.mjs example-mod dev2 client D:\path\to\mods
 *
 * 工作区省略时读取 DSH_MC_WORKSPACE；这个脚本只用于人工验证，不属于 DSH 运行时。
 */
import { scan } from '../src/profiles.js'
import { launchInstance, readLaunchLog } from '../src/launcher.js'

const [projectRef, instance = '', side = 'client', workspaceArg] = process.argv.slice(2)
const workspace = workspaceArg || process.env.DSH_MC_WORKSPACE
if (!workspace) {
  console.error('缺少工作区：把工作区作为第 4 个参数传入，或设置 DSH_MC_WORKSPACE。')
  process.exit(1)
}

const { projects, profiles } = scan(workspace)
const norm = (s) => s.split('/').join('\\').toLowerCase()
const project = projects.find((p) => p.name.toLowerCase() === norm(projectRef))
  ?? projects.find((p) => norm(p.relPath) === norm(projectRef))
  ?? projects.find((p) => norm(p.relPath).endsWith('\\' + norm(projectRef)))
if (!project) {
  console.error(`找不到工程「${projectRef}」。可用：${projects.map((p) => p.relPath).join(', ')}`)
  process.exit(1)
}

const want = instance === 'default' || instance === '' ? '' : instance
const profile = profiles.find((p) => p.projectRelPath === project.relPath && p.name === want)
if (!profile) {
  console.error(`工程 ${project.relPath} 下没有实例「${instance || '(默认)'}」`)
  process.exit(1)
}

const r = launchInstance(project, profile, {
  side,
  extraArgs: side === 'client' ? ['--args=--username Dev'] : ['--args=--nogui'],
})

console.log('已后台启动')
console.log('  pid      ', r.pid)
console.log('  实例     ', `${project.relPath} › ${profile.displayName}`)
console.log('  JAVA_HOME', r.javaHome ?? '(系统 PATH)')
console.log('  游戏目录 ', profile.gameDir)
console.log('  命令     ', r.command)
console.log('  启动日志 ', r.logFile)

await new Promise((res) => setTimeout(res, 1500))
const l = readLaunchLog(r.logFile, 15)
console.log('\n--- 启动日志前几行 ---')
console.log(l.text)
