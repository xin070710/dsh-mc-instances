/**
 * 纯 Node 单测：直接跑 src/profiles.js，不需要 DSH 运行时。
 * 用一个临时工作区构造「假模组工程」，验证扫描/建实例/mod 开关/日志/运行配置全链路。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  scan,
  createInstance,
  deleteInstance,
  setModEnabled,
  importMod,
  scanModCandidates,
  readLog,
  writeRunConfigs,
  readMods,
} from '../src/profiles.js'

/** 造一个假的 NeoForge 工程（含 gradlew.bat / build.gradle / gradle.properties）。 */
function makeProject(root, relPath, { loader = 'neoforge', mc = '1.21.1' } = {}) {
  const dir = path.join(root, relPath)
  fs.mkdirSync(path.join(dir, 'run', 'mods'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\n')
  const plugin = loader === 'fabric' ? "id 'fabric-loom' version '1.17.20'" : "id 'net.neoforged.moddev' version '2.0.142'"
  fs.writeFileSync(path.join(dir, 'build.gradle'), `
plugins { ${plugin} }
// [实例隔离] runClient 运行目录参数化：-Pinstance=<名字> → run/<名字>/
def instanceDir = (project.findProperty('instance') as String)?.trim() ?: ''
tasks.named('runClient') {
    def modsDir = new File(projectDir, 'run/mods')
    def target = new File(modsDir, 'pixelmon.jar')
}
`)
  fs.writeFileSync(path.join(dir, 'gradle.properties'), loader === 'fabric'
    ? 'minecraft_version=26.2\nfabric_api_version=0.160.0+26.2\n'
    : `minecraft_version=${mc}\nneo_version=21.1.248\n`)
  fs.writeFileSync(path.join(dir, 'run', 'options.txt'), 'fov:0.0\n')
  return dir
}

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-test-'))
}

test('扫描：没有 -Pinstance 的普通工程也会显示默认 run/（含只有 gradlew 的工程）', () => {
  const ws = tmpWorkspace()
  // 1) 有 gradlew.bat、标准 run/，但 build.gradle 完全不提 instance
  const plain = path.join(ws, 'Fabric', 'chronowatch')
  fs.mkdirSync(path.join(plain, 'run', 'mods'), { recursive: true })
  fs.writeFileSync(path.join(plain, 'gradlew.bat'), '@echo off\n')
  fs.writeFileSync(path.join(plain, 'build.gradle'), "plugins { id 'fabric-loom' version '1.17.20' }\nloom { runs { client { runDir 'run' } } }\n")
  fs.writeFileSync(path.join(plain, 'gradle.properties'), 'minecraft_version=1.21.1\n')
  // 2) 只有 gradlew（没有 .bat）的工程也要能被扫描到
  const shOnly = path.join(ws, 'NeoForge', 'starrynight')
  fs.mkdirSync(path.join(shOnly, 'run', 'logs'), { recursive: true })
  fs.writeFileSync(path.join(shOnly, 'gradlew'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(shOnly, 'build.gradle'), "plugins { id 'net.neoforged.moddev' version '2.0.148' }\n")
  fs.writeFileSync(path.join(shOnly, 'gradle.properties'), 'minecraft_version=1.21.1\nneo_version=21.1.248\n')

  const { projects, profiles } = scan(ws)
  assert.equal(projects.length, 2, `应识别 2 个普通工程，实际 ${projects.map((p) => p.relPath).join(', ')}`)
  assert.equal(projects.filter((p) => p.supportsInstance).length, 0)
  assert.equal(profiles.length, 2, '没有隔离支持的工程只应出现默认实例')
  assert.ok(profiles.every((p) => p.name === '' && p.supportsInstance === false))

  assert.throws(() => createInstance(ws, { project: 'chronowatch', instance: 'dev2' }), /没有 -Pinstance 隔离支持/)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('扫描：识别加载器、排除模板目录、列出默认实例', () => {
  const ws = tmpWorkspace()
  makeProject(ws, path.join('NeoForge', 'pokeemc'))
  makeProject(ws, path.join('Fabric', 'jojo'), { loader: 'fabric', mc: '26.2' })
  makeProject(ws, path.join('NeoForge', '_templates', 'mdk-neoforge')) // 应被排除

  const { projects, profiles } = scan(ws)
  assert.equal(projects.length, 2, `应只认 2 个工程，实际 ${projects.map((p) => p.relPath).join(', ')}`)
  assert.ok(projects.every((p) => !p.relPath.includes('_templates')))

  const neo = projects.find((p) => p.name === 'pokeemc')
  const fab = projects.find((p) => p.name === 'jojo')
  assert.equal(neo.loader, 'neoforge')
  assert.equal(neo.mcVersion, '1.21.1')
  assert.equal(neo.java, 21)
  assert.equal(fab.loader, 'fabric', 'Fabric 工程不能被 build.gradle 注释里的 NeoForge 带偏')
  assert.equal(fab.mcVersion, '26.2')
  assert.equal(fab.java, 25)
  assert.deepEqual(neo.autoSyncedMods, ['pixelmon.jar'])

  assert.equal(profiles.length, 2)
  assert.ok(profiles.every((p) => p.name === '' && p.displayName === '(默认) run/'))
  fs.rmSync(ws, { recursive: true, force: true })
})

test('新建实例：建目录、继承 options.txt、出现在扫描结果里', () => {
  const ws = tmpWorkspace()
  makeProject(ws, 'pokeemc')
  const { project, profile, inheritedOptions } = createInstance(ws, { project: 'pokeemc', instance: 'dev2' })

  assert.ok(fs.existsSync(profile.modsDir), 'mods/ 应存在')
  assert.ok(fs.existsSync(path.join(profile.gameDir, 'config')))
  assert.ok(fs.existsSync(path.join(profile.gameDir, 'saves')))
  assert.equal(inheritedOptions, true)
  assert.ok(fs.existsSync(path.join(profile.gameDir, 'options.txt')), 'options.txt 应被继承')
  assert.equal(profile.runConfigName, 'pokeemc-dev2')

  const again = scan(ws)
  assert.equal(again.profiles.length, 2, '默认 + dev2')
  assert.ok(again.profiles.some((p) => p.name === 'dev2'))

  assert.throws(() => createInstance(ws, { project: 'pokeemc', instance: 'dev2' }), /已存在/)
  assert.throws(() => createInstance(ws, { project: 'pokeemc', instance: 'a/b' }), /不能包含/)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('mod 开关：启用/禁用/只留一个/导入/移除', () => {
  const ws = tmpWorkspace()
  makeProject(ws, 'pokeemc')
  const { profile } = createInstance(ws, { project: 'pokeemc', instance: 'dev2' })

  // 造两个 mod
  const jarA = path.join(ws, 'a.jar'); fs.writeFileSync(jarA, 'x')
  const jarB = path.join(ws, 'b.jar'); fs.writeFileSync(jarB, 'y')
  importMod(profile, jarA)
  importMod(profile, jarB)
  let mods = readMods(profile.modsDir)
  assert.equal(mods.length, 2)
  assert.ok(mods.every((m) => m.enabled))

  // 禁用 b → 改名 .disabled
  mods = setModEnabled(profile, 'b.jar', false)
  assert.ok(fs.existsSync(path.join(profile.modsDir, 'b.jar.disabled')))
  assert.ok(!fs.existsSync(path.join(profile.modsDir, 'b.jar')))
  assert.equal(mods.find((m) => m.fileName === 'b.jar').enabled, false)
  assert.equal(mods.filter((m) => m.enabled).length, 1)

  // 重新启用
  mods = setModEnabled(profile, 'b.jar', true)
  assert.ok(fs.existsSync(path.join(profile.modsDir, 'b.jar')))
  assert.equal(mods.filter((m) => m.enabled).length, 2)

  // 移除
  fs.rmSync(path.join(profile.modsDir, 'a.jar'), { force: true })
  assert.equal(readMods(profile.modsDir).length, 1)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('候选 mod：能从各实例 mods/ 收集去重', () => {
  const ws = tmpWorkspace()
  makeProject(ws, 'pokeemc')
  const { profile } = createInstance(ws, { project: 'pokeemc', instance: 'dev2' })
  const jar = path.join(ws, 'shared-mod.jar'); fs.writeFileSync(jar, 'z')
  importMod(profile, jar)

  const cands = scanModCandidates(ws)
  assert.ok(cands.length >= 1)
  assert.ok(cands.some((c) => c.fileName === 'shared-mod.jar'))
  assert.ok(cands.every((c) => c.source.length > 0))
  fs.rmSync(ws, { recursive: true, force: true })
})

test('日志与运行配置生成', () => {
  const ws = tmpWorkspace()
  makeProject(ws, 'pokeemc')
  const { profile } = createInstance(ws, { project: 'pokeemc', instance: 'dev2' })

  // 日志
  const logDir = path.join(profile.gameDir, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  fs.writeFileSync(path.join(logDir, 'latest.log'), 'line1\nline2\nline3\n')
  const log = readLog(profile, 2)
  assert.equal(log.exists, true)
  assert.equal(log.totalLines, 4)
  assert.ok(log.text.includes('line3'))
  assert.ok(!log.text.includes('line1'))

  // 运行配置
  const res = writeRunConfigs(ws)
  assert.equal(res.written.length, 2, '默认 + dev2')
  const dev2 = res.written.find((w) => w.runConfigName === 'pokeemc-dev2')
  assert.ok(dev2)
  assert.equal(dev2.task, 'runClient')
  assert.equal(dev2.scriptParams, '-Pinstance=dev2')
  const xml = fs.readFileSync(dev2.file, 'utf8')
  assert.ok(xml.includes('<option value="runClient" />'))
  assert.ok(xml.includes('-Pinstance=dev2'))
  assert.ok(xml.includes('$PROJECT_DIR$/pokeemc'))

  const def = res.written.find((w) => w.runConfigName === 'pokeemc')
  assert.equal(def.scriptParams, '', '默认实例不带 -Pinstance')

  // 服务端变体
  const srv = writeRunConfigs(ws, { server: true })
  assert.ok(srv.written.every((w) => w.task === 'runServer'))
  assert.ok(srv.written.some((w) => w.runConfigName.includes('服务端')))
  fs.rmSync(ws, { recursive: true, force: true })
})

test('删除实例：默认实例受保护', () => {
  const ws = tmpWorkspace()
  makeProject(ws, 'pokeemc')
  const { profile } = createInstance(ws, { project: 'pokeemc', instance: 'tmp1' })
  deleteInstance(ws, { runConfigName: profile.runConfigName })
  assert.ok(!fs.existsSync(profile.gameDir))
  assert.equal(scan(ws).profiles.length, 1, '只剩默认实例')

  assert.throws(() => deleteInstance(ws, { runConfigName: 'pokeemc' }), /不允许删除/)
  fs.rmSync(ws, { recursive: true, force: true })
})
