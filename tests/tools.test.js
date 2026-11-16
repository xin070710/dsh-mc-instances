/**
 * 工具层测试：mock 一个 Cordis ctx，加载插件入口，真实调用每个工具的 execute。
 * 需要 @deepseek-ai/dsh-tools 可解析（由 DSH 安装提供）。
 *
 *   node --test tests/tools.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, name, inject } from '../src/index.js'

/** mock ctx：只实现 tools.register。 */
function mockCtx() {
  const tools = new Map()
  return {
    tools: { register: (t) => tools.set(t.name, t) },
    _tools: tools,
  }
}

function makeProject(root, relPath) {
  const dir = path.join(root, relPath)
  fs.mkdirSync(path.join(dir, 'run', 'mods'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\n')
  fs.writeFileSync(path.join(dir, 'build.gradle'), `
plugins { id 'net.neoforged.moddev' version '2.0.142' }
def instanceDir = (project.findProperty('instance') as String)?.trim() ?: ''
`)
  fs.writeFileSync(path.join(dir, 'gradle.properties'), 'minecraft_version=1.21.1\nneo_version=21.1.248\n')
  fs.writeFileSync(path.join(dir, 'run', 'options.txt'), 'fov:0.0\n')
  return dir
}

test('插件契约：name / inject / apply 注册全部工具', () => {
  assert.equal(name, 'mc-instances')
  assert.deepEqual(inject, ['tools'])

  const ctx = mockCtx()
  apply(ctx)
  const expected = [
    'mc_instances',
    'mc_instance_create',
    'mc_mods',
    'mc_instance_log',
    'mc_ide_config',
    'mc_instance_delete',
    'mc_instance_launch',
    'mc_instance_launch_log',
  ]
  for (const t of expected) {
    assert.ok(ctx._tools.has(t), `应注册工具 ${t}`)
  }
  assert.equal(ctx._tools.size, expected.length, `工具数应为 ${expected.length}`)
  // 契约字段齐全
  for (const [n, tool] of ctx._tools) {
    assert.equal(typeof tool.description, 'string', `${n} 需要 description`)
    assert.ok(tool.description.length > 10, `${n} 的 description 太短`)
    assert.equal(typeof tool.parameters, 'object', `${n} 需要 parameters`)
    assert.equal(typeof tool.execute, 'function', `${n} 需要 execute`)
    assert.equal(typeof tool.output?.schema, 'object', `${n} 需要 output.schema`)
    assert.equal(typeof tool.output?.render, 'function', `${n} 需要 output.render`)
  }
})

test('插件配置 config.workspace 作为省略 workspace 时的默认工作区', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-config-'))
  makeProject(ws, 'example-mod')
  t.after(() => { try { fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* ignore */ } })
  const ctx = mockCtx()
  apply(ctx, { workspace: ws })
  const call = (n, args) => ctx._tools.get(n).execute(args, {})
  const r = await call('mc_instances', { action: 'list' })
  assert.equal(r.workspace, ws)
  assert.equal(r.projects.length, 1)
})

test('端到端：建实例 → 列实例 → 导入/开关 mod → 读日志 → 生成 IDE 配置 → 删实例', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-tools-'))
  makeProject(ws, 'pokeemc')
  const ctx = mockCtx()
  apply(ctx)
  const call = (n, args) => ctx._tools.get(n).execute(args, {})

  // 每次用唯一实例名，保证测试可重复运行（不受上次残留影响）
  const INST = `e2e-${process.pid}-${Date.now().toString(36)}`
  const RC = `pokeemc-${INST}`

  // 造一个候选 mod
  fs.mkdirSync(path.join(ws, '_mods'), { recursive: true })
  fs.writeFileSync(path.join(ws, '_mods', 'jei-test.jar'), 'x'.repeat(2048))

  // 1) list
  let r = await call('mc_instances', { action: 'list', workspace: ws })
  assert.equal(r.projects.length, 1)
  assert.equal(r.instances.length, 1)
  assert.equal(r.instances[0].displayName, '(默认) run/')

  // 2) create
  r = await call('mc_instance_create', { project: 'pokeemc', instance: INST, workspace: ws })
  assert.equal(r.runConfigName, RC)
  assert.ok(fs.existsSync(r.modsDir))
  assert.ok(fs.existsSync(r.gameDir + path.sep + 'options.txt'))
  assert.ok(r.runConfigFile.endsWith('.run'), `应生成 .run：${r.runConfigFile}`)

  // 3) detail
  r = await call('mc_instances', { action: 'detail', runConfigName: RC, workspace: ws })
  assert.equal(r.detail.name, INST)
  assert.equal(r.detail.loader, 'neoforge')
  assert.equal(r.detail.enabledModCount, 0)

  // 4) candidates + import
  r = await call('mc_mods', { action: 'candidates', workspace: ws })
  assert.ok(r.candidates.some((c) => c.fileName === 'jei-test.jar'), '应看到 _mods 里的候选')

  r = await call('mc_mods', { action: 'import', runConfigName: RC, mods: ['jei-test.jar'], workspace: ws })
  assert.equal(r.mods.length, 1)
  assert.equal(r.mods[0].enabled, true)
  assert.ok(r.changed.some((c) => c.includes('导入')))

  // 5) disable → enable
  r = await call('mc_mods', { action: 'disable', runConfigName: RC, mods: ['jei-test.jar'], workspace: ws })
  assert.equal(r.mods[0].enabled, false)
  assert.ok(fs.existsSync(path.join(ws, 'pokeemc', 'run', INST, 'mods', 'jei-test.jar.disabled')))

  r = await call('mc_mods', { action: 'enable', runConfigName: RC, mods: ['jei-test.jar'], workspace: ws })
  assert.equal(r.mods[0].enabled, true)

  // 6) only
  fs.writeFileSync(path.join(ws, '_mods', 'other.jar'), 'y')
  await call('mc_mods', { action: 'import', runConfigName: RC, mods: ['other.jar'], workspace: ws })
  r = await call('mc_mods', { action: 'only', runConfigName: RC, mods: ['jei-test.jar'], workspace: ws })
  assert.equal(r.mods.find((m) => m.fileName === 'other.jar').enabled, false)
  assert.equal(r.mods.find((m) => m.fileName === 'jei-test.jar').enabled, true)

  // 7) log（还没有）
  r = await call('mc_instance_log', { runConfigName: RC, workspace: ws })
  assert.equal(r.exists, false)

  // 写一份日志再读
  const logDir = path.join(ws, 'pokeemc', 'run', INST, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  fs.writeFileSync(path.join(logDir, 'latest.log'), 'a\nb\nc\n')
  r = await call('mc_instance_log', { runConfigName: RC, tailLines: 2, workspace: ws })
  assert.equal(r.exists, true)
  assert.ok(r.text.includes('c') && !r.text.includes('a'))

  // 8) IDE 配置（全量）
  r = await call('mc_ide_config', { workspace: ws })
  assert.ok(r.written.length >= 2, `应生成 >=2 个配置，实际 ${r.written.length}`)
  assert.ok(r.written.some((w) => w.runConfigName === RC && w.scriptParams === `-Pinstance=${INST}`))
  assert.ok(r.dir.endsWith(path.join('.idea', 'runConfigurations')))

  // 9) 渲染函数可用（模型侧文本）
  const tool = ctx._tools.get('mc_instances')
  const content = tool.output.render({ action: 'list' }, { workspace: ws, projects: [], instances: [], detail: null })
  assert.ok(Array.isArray(content) && content[0].type === 'text')

  // 10) 错误路径有可读信息
  await assert.rejects(() => call('mc_instances', { action: 'detail', runConfigName: 'nope', workspace: ws }), /找不到实例/)
  await assert.rejects(() => call('mc_mods', { action: 'enable', runConfigName: RC, mods: ['不存在.jar'], workspace: ws }), /没有 mod/)
  await assert.rejects(() => call('mc_mods', { action: 'import', runConfigName: RC, mods: ['不存在.jar'], workspace: ws }), /找不到候选/)

  // 11) delete 保护默认实例
  await assert.rejects(() => call('mc_instance_delete', { runConfigName: 'pokeemc', workspace: ws }), /不允许删除/)

  r = await call('mc_instance_delete', { runConfigName: RC, workspace: ws })
  assert.equal(r.deleted, RC)
  assert.ok(!fs.existsSync(path.join(ws, 'pokeemc', 'run', INST)))

  fs.rmSync(ws, { recursive: true, force: true })
})
