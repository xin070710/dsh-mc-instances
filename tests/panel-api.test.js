/**
 * 面板 Host API 的端到端测试：不依赖 DSH 运行时，用假的 webServer/workspaceRegistry
 * 把路由接起来，覆盖扫描、门禁、新建、mod、日志、IDE 配置、启动/停止与删除。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { registerPanelApi } from '../src/panel-api.js'

function makeHarness(workspace, options = {}) {
  // 每个 fixture 用自己的启动状态目录，避免测试污染真实 %DSH_HOME%。
  process.env.DSH_MC_PANEL_STATE_DIR = path.join(workspace, '.panel-state')
  const routes = new Map()
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:64880',
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const services = {
    webServer,
    workspaceRegistry: { list: () => [{ path: workspace, title: 'Fixture' }] },
  }
  const scope = {
    webServer,
    get: (name) => services[name],
    effect: (fn) => { fn(); return () => {} },
  }
  const ctx = {
    get: (name) => services[name],
    inject: (_deps, callback) => { callback(scope) },
    effect: (fn) => { fn(); return () => {} },
  }
  registerPanelApi(ctx, options)
  return routes
}

function makeRequest(method, url, body, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {
    'x-dsh-mc-panel': '1',
    host: '127.0.0.1:64880',
    origin: 'http://127.0.0.1:64880',
    ...headers,
  }
  if (body !== undefined) {
    if (!req.headers['content-type']) req.headers['content-type'] = 'application/json'
    const buffer = Buffer.from(JSON.stringify(body))
    setImmediate(() => { req.emit('data', buffer); req.emit('end') })
  } else {
    setImmediate(() => req.emit('end'))
  }
  return req
}

function makeResponse() {
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true },
    end(chunk) { this.body = chunk ? String(chunk) : this.body; this.writableEnded = true },
  }
}

function api(routes, method, pathname, body, headers) {
  return new Promise(async (resolve) => {
    const route = routes.get(pathname)
    const query = pathname.endsWith('/state') ? `?workspace=${encodeURIComponent(headers?.workspace ?? '')}&probeRoots=1` : ''
    const res = makeResponse()
    await route(makeRequest(method, pathname + query, body, headers), res)
    setImmediate(() => {
      let json = null
      try { json = JSON.parse(res.body) } catch { /* ignore */ }
      resolve({ status: res.statusCode, json })
    })
  })
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mc-panel-'))
  const project = path.join(root, 'NeoForge', 'example')
  const run = path.join(project, 'run')
  const dev2 = path.join(run, 'dev2')
  for (const dir of [
    path.join(run, 'mods'), path.join(run, 'logs'),
    path.join(dev2, 'mods'), path.join(dev2, 'logs'),
    path.join(root, '_shared'),
  ]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(project, 'build.gradle'), [
    "plugins { id 'net.neoforged.moddev' version '2.0.107' }",
    '// -Pinstance isolation supported',
    "tasks.register('runClient') { println project.findProperty('instance') }",
  ].join('\n'))
  fs.writeFileSync(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.1\nneo_version=21.1.80\n')
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(project, 'gradlew.bat'), '@echo off\r\necho fake gradle %*\r\nping -n 2 127.0.0.1 >nul\r\nexit /b 0\r\n')
  }
  fs.writeFileSync(path.join(run, 'mods', 'jei-1.21.1.jar'), Buffer.alloc(128, 1))
  fs.writeFileSync(path.join(run, 'options.txt'), 'lang:zh_cn\nrenderDistance:12\n')
  fs.writeFileSync(path.join(run, 'logs', 'latest.log'), '[INFO] Hello\n[ERROR] Boom\n')
  fs.writeFileSync(path.join(dev2, 'mods', 'foo.jar'), Buffer.alloc(64, 2))
  fs.writeFileSync(path.join(dev2, 'logs', 'latest.log'), '[INFO] dev2\n')
  fs.writeFileSync(path.join(root, '_shared', 'extra.jar'), Buffer.alloc(32, 3))
  return root
}

test('面板 API：扫描、门禁、新建、mod、日志、IDE 配置与删除', async (t) => {
  const root = makeFixture()
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 文件句柄可能稍后释放 */ } })
  const routes = makeHarness(root)
  assert.ok(routes.has('/dsh-mc-panel/api/state'))
  assert.ok(routes.has('/dsh-mc-panel/api/action'))

  const state = await api(routes, 'GET', '/dsh-mc-panel/api/state', undefined, { workspace: root })
  assert.equal(state.status, 200)
  assert.equal(state.json.ok, true)
  assert.equal(state.json.data.detected, true)
  assert.equal(state.json.data.projects.length, 1)
  assert.equal(state.json.data.instances.length, 2)
  const first = state.json.data.instances[0]
  assert.equal(first.loader, 'neoforge')
  assert.equal(first.mcVersion, '1.21.1')
  assert.equal(first.java, 21)
  assert.equal(first.extras.options.lang, 'zh_cn')
  assert.ok(first.mods.some((mod) => mod.fileName === 'jei-1.21.1.jar'))

  const denied = await api(routes, 'GET', '/dsh-mc-panel/api/state', undefined, { workspace: root, 'x-dsh-mc-panel': '' })
  assert.equal(denied.status, 403)
  const foreign = await api(routes, 'GET', '/dsh-mc-panel/api/state', undefined, { workspace: root, origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  const rebinding = await api(routes, 'GET', '/dsh-mc-panel/api/state', undefined, {
    workspace: root, host: 'foo.local:64880', origin: 'http://foo.local:64880',
  })
  assert.equal(rebinding.status, 403)
  const wrongPort = await api(routes, 'GET', '/dsh-mc-panel/api/state', undefined, {
    workspace: root, host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999',
  })
  assert.equal(wrongPort.status, 403)
  const jsonp = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'launches', workspace: root }, { 'content-type': 'application/jsonp' })
  assert.equal(jsonp.status, 415)
  const tooLarge = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'launches', workspace: root, pad: 'x'.repeat(300 * 1024) })
  assert.equal(tooLarge.status, 413)

  const created = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'create', workspace: root, project: 'NeoForge/example', instance: 'dev3',
    copyFrom: 'example-dev2', copyOptions: true, writeIde: true,
  })
  assert.equal(created.json.ok, true, JSON.stringify(created.json))
  const dev3 = path.join(root, 'NeoForge', 'example', 'run', 'dev3')
  assert.ok(fs.existsSync(path.join(dev3, 'options.txt')))
  assert.ok(fs.existsSync(path.join(dev3, 'mods', 'foo.jar')))
  assert.ok(fs.existsSync(path.join(root, '.idea', 'runConfigurations', 'example-dev3.run')))

  const disabled = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'mods', action: 'disable', workspace: root, runConfigName: 'example', mods: ['jei-1.21.1.jar'],
  })
  assert.equal(disabled.json.ok, true)
  assert.ok(fs.existsSync(path.join(root, 'NeoForge', 'example', 'run', 'mods', 'jei-1.21.1.jar.disabled')))
  const enabled = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'mods', action: 'enable', workspace: root, runConfigName: 'example', mods: ['jei-1.21.1.jar'],
  })
  assert.equal(enabled.json.ok, true)
  assert.ok(fs.existsSync(path.join(root, 'NeoForge', 'example', 'run', 'mods', 'jei-1.21.1.jar')))

  const imported = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'mods', action: 'import', workspace: root, runConfigName: 'example-dev2', mods: ['extra.jar'],
  })
  assert.equal(imported.json.ok, true)
  assert.ok(fs.existsSync(path.join(root, 'NeoForge', 'example', 'run', 'dev2', 'mods', 'extra.jar')))

  const candidateList = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'mods', action: 'candidates', workspace: root, instanceId: 'NeoForge\\example::dev2',
  })
  const extraPaths = candidateList.json.data.candidates.filter((item) => item.fileName === 'extra.jar').map((item) => item.path)
  assert.ok(extraPaths.length >= 2)
  const ambiguous = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'mods', action: 'import', workspace: root, instanceId: 'NeoForge\\example::dev2', paths: extraPaths.slice(0, 2),
  })
  assert.equal(ambiguous.json.ok, false)
  assert.match(ambiguous.json.error.message, /同名/)
  const byPath = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'mods', action: 'import', workspace: root, instanceId: 'NeoForge\\example::dev2', paths: [extraPaths[0]],
  })
  assert.equal(byPath.json.ok, true, JSON.stringify(byPath.json))

  const log = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'log', kind: 'game', workspace: root, runConfigName: 'example', tail: 20,
  })
  assert.equal(log.json.ok, true)
  assert.match(log.json.data.text, /Boom/)

  const ide = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'ide', workspace: root, project: 'example' })
  assert.equal(ide.json.ok, true)
  assert.ok(ide.json.data.written.length >= 2)

  const refused = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'delete', workspace: root, runConfigName: 'example-dev3', confirm: false,
  })
  assert.equal(refused.json.ok, false)
  assert.ok(fs.existsSync(dev3))
  const deleted = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'delete', workspace: root, runConfigName: 'example-dev3', confirm: true,
  })
  assert.equal(deleted.json.ok, true)
  assert.ok(!fs.existsSync(dev3))

  const escape = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'open', workspace: root, path: process.platform === 'win32' ? 'C:\\Windows' : '/etc', reveal: false,
  })
  assert.equal(escape.json.ok, false)
  assert.match(escape.json.error.message, /不在当前工作区/)

  const runDir = path.join(root, 'NeoForge', 'example', 'run')
  fs.writeFileSync(path.join(runDir, 'evil.exe'), Buffer.from('MZ'))
  const evil = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'open', workspace: root, path: path.join(runDir, 'evil.exe'), reveal: false,
  })
  assert.equal(evil.json.ok, false)
  assert.match(evil.json.error.message, /拒绝用默认程序打开/)

  const buildScript = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'open', workspace: root, path: path.join(root, 'NeoForge', 'example', 'build.gradle'), reveal: false,
  })
  assert.equal(buildScript.json.ok, false)
})

test('面板 API：未扫描且没有 MC 工程的工作区拒绝破坏性操作', async (t) => {
  const rooted = makeFixture()
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mc-panel-empty-'))
  t.after(() => {
    for (const root of [rooted, other]) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* ignore */ }
    }
  })
  // 注册表只信任 rooted；other 既没有通过 GET state 被扫描，也没有任何 MC 工程。
  const routes = makeHarness(rooted)
  const launched = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'launch', workspace: other, instanceId: 'NeoForge\\example::dev2', side: 'client',
  })
  assert.equal(launched.json.ok, false)
  assert.match(launched.json.error.message, /尚未被面板扫描/)
})

test('面板 API：邻域检测（当前工作区 + 父目录）', async (t) => {
  const root = makeFixture()
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mc-panel-iso-'))
  const emptyChild = path.join(root, 'empty-child')
  const isolatedChild = path.join(isolated, 'empty-child')
  fs.mkdirSync(emptyChild, { recursive: true })
  fs.mkdirSync(isolatedChild, { recursive: true })
  t.after(() => {
    for (const dir of [root, isolated]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* ignore */ }
    }
  })
  const routes = makeHarness(root)
  const current = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'neighborhood', workspace: root })
  assert.equal(current.json.ok, true)
  assert.equal(current.json.data.hasInstances, true)
  assert.equal(current.json.data.currentProjects, 1)
  const child = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'neighborhood', workspace: emptyChild })
  assert.equal(child.json.ok, true)
  assert.equal(child.json.data.currentProjects, 0)
  assert.equal(child.json.data.parentProjects >= 1, true)
  assert.equal(child.json.data.hasInstances, true)
  const isolatedResult = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'neighborhood', workspace: isolatedChild })
  assert.equal(isolatedResult.json.ok, true)
  assert.equal(isolatedResult.json.data.hasInstances, false)
  assert.equal(isolatedResult.json.data.parent, isolated)
})

test('面板 API：config.workspace 作为无 workspace 参数时的默认工作区', async (t) => {
  const configured = makeFixture()
  const registeredEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mc-panel-empty-registry-'))
  t.after(() => {
    for (const dir of [configured, registeredEmpty]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* ignore */ }
    }
  })
  const routes = makeHarness(registeredEmpty, { defaultWorkspace: configured })
  const state = await api(routes, 'GET', '/dsh-mc-panel/api/state')
  assert.equal(state.json.ok, true)
  assert.equal(path.resolve(state.json.data.workspace), path.resolve(configured))
  assert.ok(state.json.data.instances.length > 0)
})

test('面板 API：同名工程用 instanceId 消歧', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mc-panel-dup-'))
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* ignore */ } })
  for (const [dir, loader] of [['Fabric/jojo', "id 'fabric-loom'"], ['NeoForge/jojo', "id 'net.neoforged.moddev'"]]) {
    const project = path.join(root, dir)
    fs.mkdirSync(path.join(project, 'run', 'mods'), { recursive: true })
    fs.writeFileSync(path.join(project, 'build.gradle'), `plugins { ${loader} }\n// -Pinstance\n`)
    fs.writeFileSync(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.1\n')
    fs.writeFileSync(path.join(project, 'gradlew.bat'), '@echo off\r\n')
  }
  const routes = makeHarness(root)
  const state = await api(routes, 'GET', '/dsh-mc-panel/api/state', undefined, { workspace: root })
  assert.equal(state.json.ok, true)
  const instances = state.json.data.instances
  assert.equal(instances.length, 2)
  assert.equal(new Set(instances.map((item) => item.instanceId)).size, 2)
  assert.deepEqual(instances.map((item) => item.runConfigName).sort(), ['jojo', 'jojo'])
  for (const instance of instances) {
    const detail = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
      op: 'instance', workspace: root, instanceId: instance.instanceId,
    })
    assert.equal(detail.json.ok, true)
    assert.equal(detail.json.data.instance.projectRelPath, instance.projectRelPath)
    assert.equal(detail.json.data.instance.gameDir, instance.gameDir)
  }
  const ide = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'ide', workspace: root })
  assert.equal(ide.json.ok, true)
  const names = ide.json.data.written.map((item) => item.runConfigName).sort()
  assert.deepEqual(names, ['Fabric-jojo-default', 'NeoForge-jojo-default'])
  const files = new Set(ide.json.data.written.map((item) => item.file))
  assert.equal(files.size, 2)
})

test('面板 API：宿主重载后从落盘记录恢复运行中的实例并拒绝重复启动', async (t) => {
  const root = makeFixture()
  const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'sleep', process.platform === 'win32' ? ['/c', 'ping', '-n', '30', '127.0.0.1'] : ['30'], { windowsHide: true, stdio: 'ignore' })
  t.after(() => {
    try { child.kill() } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* ignore */ }
  })
  // 模拟上一次宿主运行留下的登记文件。
  const stateDir = path.join(root, '.panel-state')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'launches.json'), JSON.stringify({
    version: 1,
    records: [{
      id: 'restored-1', workspace: root, instanceId: 'NeoForge\\example::dev2', runConfigName: 'example-dev2',
      projectRelPath: 'NeoForge\\example', displayName: 'dev2', instanceName: 'dev2', side: 'client',
      pid: child.pid, logFile: 'x', startedAt: new Date(Date.now() - 10000).toISOString(), startedAtMs: Date.now() - 10000,
      status: 'running', exitCode: null, endedAt: null,
    }],
  }))
  const routes = makeHarness(root)
  const state = await api(routes, 'GET', '/dsh-mc-panel/api/state', undefined, { workspace: root })
  assert.equal(state.json.ok, true)
  assert.ok(state.json.data.launches.some((item) => item.id === 'restored-1'))
  const refused = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'launch', workspace: root, instanceId: 'NeoForge\\example::dev2', side: 'client',
  })
  assert.equal(refused.json.ok, false)
  assert.match(refused.json.error.message, /已经在运行/)
})

test('面板 API：启动、状态轮询与停止', { skip: process.platform !== 'win32' }, async (t) => {
  const root = makeFixture()
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* Windows 文件句柄可能稍后释放 */ }
  })
  const routes = makeHarness(root)
  const warmed = await api(routes, 'GET', '/dsh-mc-panel/api/state', undefined, { workspace: root })
  assert.equal(warmed.json.ok, true)

  const started = await api(routes, 'POST', '/dsh-mc-panel/api/action', {
    op: 'launch', workspace: root, instanceId: 'NeoForge\\example::dev2', side: 'client',
  })
  assert.equal(started.json.ok, true, JSON.stringify(started.json))
  const launch = started.json.data.launch
  assert.ok(launch.pid > 0)
  assert.ok(['starting', 'running'].includes(launch.status))
  assert.ok(fs.existsSync(launch.logFile))
  const list = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'launches', workspace: root })
  assert.ok(list.json.data.launches.some((item) => item.id === launch.id))
  const stopped = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'stop', workspace: root, launchId: launch.id })
  assert.equal(stopped.json.ok, true)
  assert.ok(['stopping', 'stopped'].includes(stopped.json.data.launch.status))
  await new Promise((resolve) => setTimeout(resolve, 6200))
  const after = await api(routes, 'POST', '/dsh-mc-panel/api/action', { op: 'launches', workspace: root })
  const settled = after.json.data.launches.find((item) => item.id === launch.id)
  assert.equal(settled.status, 'stopped')
})
