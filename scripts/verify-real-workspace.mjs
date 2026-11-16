/**
 * 真实工作区只读验证（不打补丁、不改任何东西）：
 * 用插件的工具层对着真实工作区跑一次 list / detail / candidates。
 *
 *   node scripts/verify-real-workspace.mjs <workspace>
 *
 * 工作区省略时读取 DSH_MC_WORKSPACE。
 */
import { apply } from '../src/index.js'

const workspace = process.argv[2] || process.env.DSH_MC_WORKSPACE
if (!workspace) {
  console.error('缺少工作区：把工作区作为参数传入，或设置 DSH_MC_WORKSPACE。')
  process.exit(1)
}
const ctx = { tools: { register: (t) => ctx._tools.set(t.name, t) }, _tools: new Map() }
apply(ctx)
const call = (n, args) => ctx._tools.get(n).execute(args, {})

console.log('工作区：', workspace)
console.log('已注册工具：', [...ctx._tools.keys()].join(', '))
console.log()

const list = await call('mc_instances', { action: 'list', workspace })
const tool = ctx._tools.get('mc_instances')
console.log(tool.output.render({ action: 'list' }, list)[0].text)
console.log()

// 对第一个非默认实例（若有）取详情；否则对默认实例取详情
const target = list.instances.find((i) => i.name !== '') ?? list.instances[0]
if (target) {
  const detail = await call('mc_instances', { action: 'detail', runConfigName: target.runConfigName, workspace })
  console.log('--- 详情 ---')
  console.log(tool.output.render({ action: 'detail' }, detail)[0].text)
}

const cands = await call('mc_mods', { action: 'candidates', workspace })
console.log()
console.log(tool === null ? '' : `--- 候选 mod（${cands.candidates.length}）---`)
console.log(ctx._tools.get('mc_mods').output.render({ action: 'candidates' }, cands)[0].text)

const srv = list.instances.filter((i) => i.name !== '')
console.log()
console.log(`只读验证完成：${list.projects.length} 工程 / ${list.instances.length} 实例 / ${cands.candidates.length} 候选 mod`)
