/**
 * dsh-mc-instances · Host 侧面板 API
 *
 * 右侧栏「MC 实例」面板的宿主半：在同一进程里做工作区扫描与实例操作，
 * 通过 ctx.webServer 暴露两条同源 HTTP 端点，供浏览器半调用：
 *
 *   GET  /dsh-mc-panel/api/state?workspace=...&probeRoots=1
 *   POST /dsh-mc-panel/api/action   { op, ... }
 *
 * 设计约束：
 * - 文件操作全部复用 ./profiles.js，和 Agent 工具走同一套实现；
 * - 启动复用 ./launcher.js（后台 detached，日志落盘），本模块只负责登记进程；
 * - 所有端点都校验自定义请求头 + 本机 Host/Origin，避免任意网页借同源访问本机；
 * - 响应统一 { ok, data | error }，域错误用 HTTP 200 返回，便于 UI 展示原文。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  DEFAULT_WORKSPACE,
  scan,
  createInstance,
  deleteInstance,
  setModEnabled,
  importMod,
  scanModCandidates,
  writeRunConfigs,
  probeWorkspace,
  readInstanceExtras,
  readProfile,
  readTextTail,
} from './profiles.js'
import { launchInstance, isRunning } from './launcher.js'

const ROUTE_BASE = '/dsh-mc-panel'
const API_BASE = `${ROUTE_BASE}/api`
const GATE_HEADER = 'x-dsh-mc-panel'
const MAX_BODY_BYTES = 256 * 1024
const SCAN_CACHE_MS = 3000
const PROBE_CACHE_MS = 30000
const PROBE_NEGATIVE_CACHE_MS = 30000
const TOO_LARGE = Symbol('too-large')
const TIMED_OUT = Symbol('timeout')

/** 只接受本机回环页面。私网名与 `.local` 不再放行：服务只监听回环地址， */
/** 放行它们只会给 DNS rebinding 留下一个把公网名字解析到本机的口子。 */
const LOOPBACK_ADDRESS = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)(:(\d+))?$/u

/** 一次请求是否来自本机回环页面。 */
function allowed(req, expectedPort) {
  try {
    if (req?.headers?.[GATE_HEADER] !== '1') return false
    const site = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : ''
    if (site === '' || !LOOPBACK_ADDRESS.test(site)) return false
    if (expectedPort) {
      const match = /:(\d+)$/u.exec(site)
      const port = match ? match[1] : ''
      if (port !== String(expectedPort)) return false
    }
    const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin.trim().toLowerCase() : ''
    if (origin === 'null') return false
    if (origin !== '') {
      let originSite = ''
      try { originSite = new URL(origin).host.toLowerCase() } catch { return false }
      if (originSite !== site) return false
    }
    return true
  } catch {
    return false
  }
}

function sendJson(res, status, payload) {
  try {
    if (res.writableEnded === true || res.destroyed === true) return
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try { if (res.writableEnded !== true && res.destroyed !== true) res.end() } catch { /* socket 已断开 */ }
  }
}

const ok = (res, data) => sendJson(res, 200, { ok: true, data })
const fail = (res, message, code = 'error') => sendJson(res, 200, { ok: false, error: { code, message: String(message ?? '未知错误') } })

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0
    let done = false
    const parts = []
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      // 不立刻 destroy：先让调用方回一个 408，再把剩余请求体排空。
      finish(TIMED_OUT)
      try { req.resume?.() } catch { /* ignore */ }
    }, 10000)
    timer.unref?.()
    try {
      req.on('data', (chunk) => {
        if (done) return
        size += chunk.length
        if (size > limit) {
          finish(TOO_LARGE)
          try { req.resume?.() } catch { /* ignore */ }
          return
        }
        parts.push(chunk)
      })
      req.on('end', () => {
        if (done) return
        if (size === 0) return finish({})
        try {
          const text = Buffer.concat(parts).toString('utf8')
          const parsed = JSON.parse(text)
          finish(parsed !== null && typeof parsed === 'object' ? parsed : null)
        } catch {
          finish(null)
        }
      })
      req.on('aborted', () => finish(null))
      req.on('error', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

const lowerKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

function titleOfPath(p) {
  try { return path.basename(p) || p } catch { return p }
}

/** 一条「已注册工作区」记录；extra 是插件配置的默认工作区。 */
function registeredWorkspaces(ctx, extra = '') {
  const list = []
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      for (const ws of registry.list()) {
        if (typeof ws?.path === 'string') list.push({ path: ws.path, title: ws.title || titleOfPath(ws.path), kind: 'workspace' })
      }
    }
  } catch { /* 组合里没有工作区服务时退化为默认工作区 */ }
  const env = process.env.DSH_MC_WORKSPACE
  if (typeof env === 'string' && env.trim() !== '') list.push({ path: env.trim(), title: `${titleOfPath(env.trim())}（环境变量）`, kind: 'env' })
  if (typeof extra === 'string' && extra.trim() !== '') list.push({ path: extra.trim(), title: `${titleOfPath(extra.trim())}（配置）`, kind: 'config' })

  const seen = new Set()
  const out = []
  for (const entry of list) {
    let abs
    try { abs = path.resolve(entry.path) } catch { continue }
    const key = lowerKey(abs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...entry, path: abs })
  }
  return out
}

/** 一次面板会话：缓存、启动登记表、以及用于 route 的上下文。 */
class PanelRuntime {
  constructor(ctx, { defaultWorkspace = '' } = {}) {
    this.ctx = ctx
    this.defaultWorkspace = defaultWorkspace
    this.scanCache = new Map()
    this.probeCache = new Map()
    this.extrasCache = new Map()
    this.neighborhoodCache = new Map()
    this.launches = new Map()
    this.trusted = new Set()
    this.stateDir = process.env.DSH_MC_PANEL_STATE_DIR
      || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'mc-instances')
    this.launchFile = path.join(this.stateDir, 'launches.json')
    this.restoreLaunches()
  }

  trust(workspace) {
    try { this.trusted.add(lowerKey(path.resolve(workspace))) } catch { /* ignore */ }
  }

  isTrusted(workspace) {
    let abs
    try { abs = path.resolve(workspace) } catch { return false }
    const key = lowerKey(abs)
    if (this.trusted.has(key)) return true
    return registeredWorkspaces(this.ctx, this.defaultWorkspace).some((root) => lowerKey(root.path) === key)
  }

  extras(profile) {
    const key = `${lowerKey(profile.gameDir)}|${profile.lastActivity ?? ''}|${profile.mods.length}`
    const hit = this.extrasCache.get(key)
    if (hit && Date.now() - hit.at < 8000) return hit.data
    const data = readInstanceExtras(profile)
    // 只保留最近 200 条，避免长时间运行后 Map 无界增长。
    if (this.extrasCache.size > 200) this.extrasCache.clear()
    this.extrasCache.set(key, { at: Date.now(), data })
    return data
  }

  restoreLaunches() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.launchFile, 'utf8'))
      const records = Array.isArray(raw?.records) ? raw.records : []
      for (const rec of records) {
        if (!rec || typeof rec.id !== 'string' || typeof rec.pid !== 'number') continue
        if (typeof rec.workspace !== 'string' || typeof rec.instanceId !== 'string') continue
        if (!isRunning(rec.pid)) continue
        this.launches.set(rec.id, {
          ...rec,
          child: null,
          stopTimer: null,
          status: 'running',
          startedAtMs: typeof rec.startedAtMs === 'number' ? rec.startedAtMs : Date.now(),
        })
      }
    } catch { /* 首次运行或文件损坏：从空登记表开始 */ }
  }

  persistLaunches() {
    try {
      const records = [...this.launches.values()]
        .filter((rec) => !rec.endedAt)
        .map(({ child, stopTimer, ...rest }) => rest)
      fs.mkdirSync(this.stateDir, { recursive: true })
      fs.writeFileSync(this.launchFile, JSON.stringify({ version: 1, records }, null, 2), 'utf8')
    } catch { /* 状态持久化失败不应影响启动本身 */ }
  }

  invalidate(workspace) {
    if (!workspace) { this.scanCache.clear(); this.neighborhoodCache.clear(); return }
    const key = lowerKey(path.resolve(workspace))
    this.scanCache.delete(key)
    this.neighborhoodCache.delete(key)
  }

  /**
   * 当前工作区「附近」有没有 MC 工程/实例：
   * - 当前工作区本身（递归，深度 4，覆盖子目录）；
   * - 当前工作区为空时，再看直接父目录（受限预算，覆盖兄弟工程与父级自身的工程）。
   * 结果缓存 10 秒，供会话头部的自动隐藏按钮使用。
   */
  neighborhood(workspace) {
    const abs = path.resolve(workspace)
    const key = lowerKey(abs)
    const hit = this.neighborhoodCache.get(key)
    if (hit && Date.now() - hit.at < 10000) return hit.data
    const current = this.scan(abs)
    let parent = null
    let parentProjects = 0
    let hasInstances = current.projects.length > 0
    if (!hasInstances) {
      const candidate = path.dirname(abs)
      // 盘符根目录不做父级扫描：C:\ 会拖垮一次同步请求。
      if (candidate !== abs && path.parse(candidate).root !== candidate) {
        parent = candidate
        try {
          // 父级只看到「父目录本身 + 它的直接子目录」里的工程，不递归整棵树。
          // 例如工作区是 D:\work\unrelated 时，D:\work\MCMods\Fabric\jojo
          // 属于 D:\work 的孙级，不该让这个无关工作区显示入口。
          const probe = this.probe(parent)
          parentProjects = probe.projectCount
          hasInstances = parentProjects > 0
        } catch { parentProjects = 0 }
      }
    }
    const data = {
      hasInstances,
      currentProjects: current.projects.length,
      parent,
      parentProjects,
      checked: parent ? [abs, parent] : [abs],
      timestamp: Date.now(),
    }
    this.neighborhoodCache.set(key, { at: Date.now(), data })
    return data
  }

  scan(workspace) {
    const key = lowerKey(workspace)
    const hit = this.scanCache.get(key)
    if (hit && Date.now() - hit.at < SCAN_CACHE_MS) return hit.data
    const data = scan(workspace)
    this.scanCache.set(key, { at: Date.now(), data })
    return data
  }

  probe(root) {
    const key = lowerKey(root)
    const hit = this.probeCache.get(key)
    if (hit) {
      const ttl = hit.data.exists && hit.data.projectCount > 0 ? PROBE_CACHE_MS : PROBE_NEGATIVE_CACHE_MS
      if (Date.now() - hit.at < ttl) return hit.data
    }
    const data = probeWorkspace(root)
    this.probeCache.set(key, { at: Date.now(), data })
    return data
  }

  rootsView() {
    return registeredWorkspaces(this.ctx, this.defaultWorkspace).map((entry) => {
      const probe = this.probe(entry.path)
      return {
        ...entry,
        exists: probe.exists,
        projectCount: probe.projectCount,
      }
    })
  }

  /** 该实例当前的启动登记（若有）。 */
  activeLaunch(workspace, instanceId) {
    for (const rec of this.launches.values()) {
      if (rec.workspace === workspace && rec.instanceId === instanceId && rec.status !== 'exited' && rec.status !== 'failed' && rec.status !== 'stopped') {
        return this.launchView(rec)
      }
    }
    return null
  }

  refreshLaunch(rec) {
    if (rec.endedAt) return rec
    if (rec.child && rec.child.exitCode !== null && rec.child.exitCode !== undefined) {
      rec.endedAt = new Date().toISOString()
      rec.exitCode = rec.child.exitCode
      rec.status = rec.stopped ? 'stopped' : rec.child.exitCode === 0 ? 'exited' : 'failed'
      if (rec.stopTimer) { clearTimeout(rec.stopTimer); rec.stopTimer = null }
      this.persistLaunches()
      return rec
    }
    if (!isRunning(rec.pid)) {
      // 进程已消失但 exit 事件还没有送到（例如父进程被外部结束）。
      rec.endedAt = new Date().toISOString()
      rec.exitCode = rec.exitCode ?? null
      rec.status = rec.stopped ? 'stopped' : (rec.exitCode === 0 ? 'exited' : 'failed')
      if (rec.stopTimer) { clearTimeout(rec.stopTimer); rec.stopTimer = null }
      this.persistLaunches()
      return rec
    }
    if (rec.status === 'starting' && Date.now() - rec.startedAtMs > 4000) rec.status = 'running'
    // taskkill /T 也杀不掉（权限、僵死进程）时，12 秒后把状态还给 running，
    // 让 UI 重新提供停止按钮，而不是永远卡在“停止中”。
    if (rec.status === 'stopping' && rec.stoppingAt && Date.now() - rec.stoppingAt > 12000) {
      rec.status = 'running'
      rec.stopped = false
      rec.stoppingAt = null
      if (rec.stopTimer) { clearTimeout(rec.stopTimer); rec.stopTimer = null }
      this.persistLaunches()
    }
    return rec
  }

  launchView(rec) {
    this.refreshLaunch(rec)
    return {
      id: rec.id,
      workspace: rec.workspace,
      instanceId: rec.instanceId,
      runConfigName: rec.runConfigName,
      projectRelPath: rec.projectRelPath,
      displayName: rec.displayName,
      instanceName: rec.instanceName,
      side: rec.side,
      pid: rec.pid,
      logFile: rec.logFile,
      javaHome: rec.javaHome ?? null,
      command: rec.command ?? null,
      startedAt: rec.startedAt,
      startedAtMs: rec.startedAtMs,
      status: rec.status,
      exitCode: rec.exitCode,
      endedAt: rec.endedAt,
    }
  }

  launchesView() {
    return [...this.launches.values()]
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .map((rec) => this.launchView(rec))
  }

  startLaunch({ workspace, project, profile, side, extraArgs }) {
    const existing = this.activeLaunch(workspace, profile.instanceId)
    if (existing) throw new Error(`实例「${profile.runConfigName}」已经在运行（PID ${existing.pid}）`)
    const result = launchInstance(project, profile, { side, extraArgs })
    const rec = {
      id: crypto.randomUUID(),
      workspace,
      instanceId: profile.instanceId,
      runConfigName: profile.runConfigName,
      projectRelPath: profile.projectRelPath,
      displayName: profile.displayName,
      instanceName: profile.name,
      side,
      pid: result.pid,
      logFile: result.logFile,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      status: 'starting',
      exitCode: null,
      endedAt: null,
      stopped: false,
      child: result.child ?? null,
      javaHome: result.javaHome,
      command: result.command,
    }
    this.launches.set(rec.id, rec)
    this.persistLaunches()
    if (rec.child) {
      rec.child.once('exit', (code) => {
        rec.exitCode = code
        rec.endedAt = new Date().toISOString()
        rec.status = rec.stopped ? 'stopped' : code === 0 ? 'exited' : 'failed'
        if (rec.stopTimer) { clearTimeout(rec.stopTimer); rec.stopTimer = null }
        this.persistLaunches()
      })
      rec.child.once('error', () => {
        rec.exitCode = null
        rec.endedAt = new Date().toISOString()
        rec.status = 'failed'
        if (rec.stopTimer) { clearTimeout(rec.stopTimer); rec.stopTimer = null }
        this.persistLaunches()
      })
    }
    return this.launchView(rec)
  }

  stopLaunch(id) {
    const rec = this.launches.get(id)
    if (!rec) throw new Error('找不到这次启动记录（可能来自上一次应用运行）')
    if (rec.endedAt) return this.launchView(rec)
    rec.stopped = true
    // 先标记 stopping：taskkill 是异步的，立刻写 stopped 会在失败时撒谎。
    // refreshLaunch / child exit 事件会在进程真的消失后把它落成 stopped。
    rec.status = 'stopping'
    rec.stoppingAt = Date.now()
    const pid = rec.pid
    const forceKill = () => {
      if (!isRunning(pid)) return
      if (process.platform === 'win32') {
        const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        child.on('error', () => { /* 进程可能已经结束 */ })
      } else {
        try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* 已经结束 */ } }
      }
    }
    if (process.platform === 'win32') {
      // 先温和关闭（GUI 游戏能走自己的退出流程，避免存档写一半被 /F 打断）。
      const child = spawn('taskkill.exe', ['/PID', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' })
      child.on('error', () => { /* 交给兜底 */ })
    } else {
      try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* 已经结束 */ } }
    }
    if (rec.stopTimer) clearTimeout(rec.stopTimer)
    rec.stopTimer = setTimeout(forceKill, 5000)
    rec.stopTimer.unref?.()
    this.persistLaunches()
    return this.launchView(rec)
  }

  dispose() {
    // 不杀游戏：面板关闭/插件卸载不代表用户要结束正在跑的游戏。
    // 但仍要把仍在运行的登记落盘，重载后才能拒绝重复启动。
    this.persistLaunches()
    this.launches.clear()
    this.scanCache.clear()
    this.probeCache.clear()
    this.extrasCache.clear()
    this.trusted.clear()
  }
}

function projectOf(scanResult, profile) {
  return scanResult.projects.find((p) => p.relPath === profile.projectRelPath)
}

/** 给一个实例补齐面板需要的工程信息与目录统计。 */
function enrichInstance(runtime, workspace, profile, project) {
  const extras = readInstanceExtras(profile)
  const active = runtime.activeLaunch(workspace, profile.instanceId)
  let gameLog = null
  try {
    const st = fs.statSync(profile.logFile)
    gameLog = { path: profile.logFile, size: st.size, updatedAt: st.mtime.toISOString() }
  } catch { /* 还没启动过 */ }
  return {
    ...profile,
    workspace,
    loader: project?.loader ?? 'unknown',
    mcVersion: project?.mcVersion ?? '',
    java: project?.java ?? 0,
    supportsInstance: project?.supportsInstance ?? false,
    autoSyncedMods: project?.autoSyncedMods ?? [],
    extras,
    gameLog,
    launch: active,
  }
}

function stateData(runtime, workspace, { probeRoots = true } = {}) {
  const abs = path.resolve(workspace)
  const result = runtime.scan(abs)
  if (result.projects.length > 0) runtime.trust(abs)
  const instances = result.profiles.map((profile) => enrichInstance(runtime, abs, profile, projectOf(result, profile)))
  const roots = probeRoots ? runtime.rootsView() : []
  const title = roots.find((r) => lowerKey(r.path) === lowerKey(abs))?.title ?? titleOfPath(abs)
  return {
    workspace: abs,
    workspaceTitle: title,
    detected: result.projects.length > 0,
    projects: result.projects.map((p) => ({
      ...p,
      instanceCount: result.profiles.filter((profile) => profile.projectRelPath === p.relPath).length,
    })),
    instances,
    roots,
    launches: runtime.launchesView(),
    timestamp: Date.now(),
  }
}

/**
 * 按 instanceId（优先）或 runConfigName 定位实例。
 * runConfigName 只在同一工程内唯一，工作区里可能有两个同名工程；面板一律传 instanceId。
 */
function findProfile(scanResult, ref) {
  const value = typeof ref === 'string' ? ref : ''
  let profile = value === '' ? undefined : scanResult.profiles.find((p) => p.instanceId === value)
  if (!profile && value !== '') profile = scanResult.profiles.find((p) => p.runConfigName === value)
  if (!profile) {
    const available = scanResult.profiles.map((p) => p.instanceId).join(', ') || '(无)'
    throw new Error(`找不到实例「${value || '(空)'}」。可用：${available}`)
  }
  return profile
}

function instanceData(runtime, workspace, ref) {
  const abs = path.resolve(workspace)
  const result = runtime.scan(abs)
  const profile = findProfile(result, ref)
  const instance = enrichInstance(runtime, abs, profile, projectOf(result, profile))
  return instance
}

/** 在当前工作区里挑一个候选 mod（候选来自 _shared/_mods/各实例 mods）。 */
function importCandidates(workspace, names) {
  const candidates = scanModCandidates(workspace)
  const picked = []
  for (const name of names) {
    const hit = candidates.find((c) => c.fileName === name || c.fileName === `${name}.jar`)
    if (!hit) throw new Error(`工作区里找不到候选 mod「${name}」`)
    picked.push(hit)
  }
  return picked
}

function modsAction(runtime, workspace, ref, action, names, paths) {
  const abs = path.resolve(workspace)
  const result = runtime.scan(abs)
  const profile = findProfile(result, ref)
  const wanted = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n !== '') : []
  const wantedPaths = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p !== '') : []
  const changed = []

  if (action === 'list') {
    return { instanceId: profile.instanceId, runConfigName: profile.runConfigName, mods: profile.mods, candidates: [], changed }
  }
  if (action === 'candidates') {
    return { instanceId: profile.instanceId, runConfigName: profile.runConfigName, mods: profile.mods, candidates: scanModCandidates(abs), changed }
  }
  if (wanted.length === 0 && !(action === 'import' && wantedPaths.length > 0)) throw new Error(`${action} 需要 mods 列表`)
  // 文件名只允许 basename：UI 只传扫描结果里的名字，但接口本身不能信任调用方。
  for (const name of wanted) {
    if (/[\\/]/.test(name) || name === '.' || name === '..') throw new Error(`非法的 mod 文件名：${name}`)
  }

  if (action === 'enable' || action === 'disable') {
    const enabled = action === 'enable'
    for (const name of wanted) {
      setModEnabled(profile, name, enabled)
      changed.push(`${name} → ${enabled ? '启用' : '禁用'}`)
    }
  } else if (action === 'only') {
    const keep = new Set(wanted)
    for (const mod of profile.mods) {
      const want = keep.has(mod.fileName)
      if (mod.enabled !== want) {
        setModEnabled(profile, mod.fileName, want)
        changed.push(`${mod.fileName} → ${want ? '启用' : '禁用'}`)
      }
    }
  } else if (action === 'import') {
    const candidateList = scanModCandidates(abs)
    let picked = []
    if (wantedPaths.length > 0) {
      // 路径必须来自本次候选扫描结果：客户端不能凭一个任意路径往实例里塞文件。
      const byPath = new Map(candidateList.map((c) => [lowerKey(path.resolve(c.path)), c]))
      picked = wantedPaths.map((p) => {
        const hit = byPath.get(lowerKey(path.resolve(p)))
        if (!hit) throw new Error(`候选 mod 不在当前工作区的扫描结果里：${p}`)
        return hit
      })
    } else {
      picked = importCandidates(abs, wanted)
    }
    const seen = new Set()
    for (const cand of picked) {
      const targetName = cand.fileName.replace(/\.disabled$/i, '')
      if (seen.has(lowerKey(targetName))) throw new Error(`多个候选 mod 同名（${targetName}），请只选一个来源`)
      seen.add(lowerKey(targetName))
      importMod(profile, cand.path, true)
      changed.push(`导入 ${cand.fileName}`)
    }
  } else if (action === 'remove') {
    for (const name of wanted) {
      for (const file of [name, `${name}.disabled`]) {
        const p = path.join(profile.modsDir, file)
        try {
          if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); changed.push(`删除 ${file}`) }
        } catch { /* ignore */ }
      }
    }
  } else {
    throw new Error(`不支持的 mod 操作：${action}`)
  }

  // 重新读一次，让 UI 拿到真实文件名与启用状态。
  const fresh = readProfile(projectOf(result, profile), profile.name)
  runtime.invalidate(abs)
  return { instanceId: fresh.instanceId, runConfigName: fresh.runConfigName, mods: fresh.mods, candidates: [], changed }
}

function createAction(runtime, workspace, payload) {
  const abs = path.resolve(workspace)
  const created = createInstance(abs, {
    project: payload.project,
    instance: payload.instance,
    copyOptions: payload.copyOptions !== false,
  })
  const copiedMods = []
  if (typeof payload.copyFrom === 'string' && payload.copyFrom !== '') {
    const result = runtime.scan(abs)
    const source = findProfile(result, payload.copyFrom)
    for (const mod of source.mods) {
      const onPath = path.join(source.modsDir, mod.fileName)
      const offPath = `${onPath}.disabled`
      const candidate = fs.existsSync(onPath) ? onPath : (fs.existsSync(offPath) ? offPath : null)
      if (candidate === null) continue
      importMod(created.profile, candidate, mod.enabled)
      copiedMods.push(mod.fileName)
    }
  }
  let ideFile = ''
  if (payload.writeIde !== false) {
    // 用相对路径而不是工程名：工作区里可能有两个同名工程（Fabric/jojo 与 NeoForge/jojo）。
    const res = writeRunConfigs(abs, { project: created.project.relPath })
    ideFile = res.written.find((w) => w.instanceId === created.profile.instanceId)?.file ?? ''
  }
  runtime.invalidate(abs)
  const fresh = runtime.scan(abs)
  const profile = findProfile(fresh, created.profile.instanceId)
  return {
    instance: enrichInstance(runtime, abs, profile, projectOf(fresh, profile)),
    inheritedOptions: created.inheritedOptions,
    copiedMods,
    ideFile,
  }
}

function deleteAction(runtime, workspace, payload) {
  if (payload.confirm !== true) throw new Error('删除实例需要显式确认')
  const abs = path.resolve(workspace)
  const result = runtime.scan(abs)
  const profile = findProfile(result, payload.instanceId ?? payload.runConfigName)
  if (runtime.activeLaunch(abs, profile.instanceId)) throw new Error('实例正在运行，请先停止再删除')
  const deleted = deleteInstance(abs, { project: profile.projectRelPath, instance: profile.name })
  runtime.invalidate(abs)
  return { instanceId: deleted.instanceId, runConfigName: deleted.runConfigName, gameDir: deleted.gameDir }
}

function assertInside(workspace, target) {
  const abs = path.resolve(target)
  const rel = path.relative(path.resolve(workspace), abs)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return abs
  throw new Error('目标路径不在当前工作区内，已拒绝')
}

/** child 是否位于 parent 内（含 parent 本身）。 */
function isWithin(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function realpathSafe(value) {
  try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
}

/** child 的真实路径是否位于 parent 的真实路径内（阻断 junction/symlink 跳出）。 */
function isReallyWithin(parent, child) {
  return isWithin(realpathSafe(parent), realpathSafe(child))
}

/** 允许“用默认程序打开”的扩展名：面板只需要目录、日志、崩溃报告与预览图。 */
const SAFE_OPEN_EXTENSIONS = new Set([
  '', '.log', '.txt', '.json', '.md', '.markdown', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
])

function assertTrusted(runtime, workspace) {
  if (runtime.isTrusted(workspace)) return
  // Host 重载后内存里的 trust 集合会清空；重新扫描一次，确认这里确实有 MC 工程。
  // 破坏性操作仍然只会落在扫描结果里的实例上，open 也只允许实例/工程目录。
  const result = runtime.scan(path.resolve(workspace))
  if (result.projects.length === 0) throw new Error('这个工作区尚未被面板扫描，请先刷新面板再操作')
  runtime.trust(workspace)
}

function openPath(runtime, workspace, payload) {
  if (typeof payload.path !== 'string' || payload.path.trim() === '') throw new Error('缺少要打开的路径')
  const abs = assertInside(workspace, payload.path)
  let st
  try { st = fs.statSync(abs) } catch { throw new Error(`路径不存在：${abs}`) }
  // 只允许打开扫描结果里的实例目录 / 工程目录及其子路径：
  // 工作区参数由客户端提供，不能让它变成任意路径的 ShellExecute 入口。
  const result = runtime.scan(path.resolve(workspace))
  const allowed = result.profiles.some((profile) => isReallyWithin(profile.gameDir, abs) || (profile.projectDir && isReallyWithin(profile.projectDir, abs)))
  if (!allowed) throw new Error('只允许打开扫描到的实例目录、工程目录或它们的日志')
  if (!st.isDirectory()) {
    const ext = path.extname(abs).toLowerCase()
    if (!SAFE_OPEN_EXTENSIONS.has(ext)) throw new Error(`拒绝用默认程序打开 ${ext || '无扩展名'} 文件`)
  }
  const reveal = payload.reveal === true
  if (process.platform === 'win32') {
    const args = reveal ? ['/select,', abs] : [abs]
    const child = spawn('explorer.exe', args, { windowsHide: true, detached: true, stdio: 'ignore' })
    child.on('error', () => { /* explorer 的退出码不可靠 */ })
    child.unref()
  } else if (process.platform === 'darwin') {
    const child = spawn('open', reveal ? ['-R', abs] : [abs], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } else {
    const child = spawn('xdg-open', reveal ? [path.dirname(abs)] : [abs], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  }
  return { path: abs, reveal }
}

function logAction(runtime, workspace, payload) {
  const abs = path.resolve(workspace)
  const result = runtime.scan(abs)
  const profile = findProfile(result, payload.instanceId ?? payload.runConfigName)
  const kind = payload.kind === 'launch' ? 'launch' : 'game'
  const tail = Math.max(20, Math.min(1000, Number(payload.tail) || 200))
  if (kind === 'game') {
    const data = readTextTail(profile.logFile, tail)
    return { kind, instanceId: profile.instanceId, ...data, runConfigName: profile.runConfigName }
  }
  let file = null
  if (typeof payload.launchId === 'string' && payload.launchId !== '') {
    const rec = runtime.launches.get(payload.launchId)
    if (rec) file = rec.logFile
  }
  if (file === null) {
    const side = payload.side === 'server' ? 'server' : 'client'
    file = path.join(projectOf(result, profile).dir, 'logs', `launch-${profile.name || 'default'}-${side}.log`)
  }
  const data = readTextTail(file, tail)
  return { kind, instanceId: profile.instanceId, ...data, runConfigName: profile.runConfigName }
}

function dispatch(runtime, workspace, payload) {
  const op = typeof payload.op === 'string' ? payload.op : ''
  const abs = path.resolve(workspace)
  switch (op) {
    case 'scan':
      return stateData(runtime, abs)
    case 'instance':
      assertTrusted(runtime, abs)
      return { instance: instanceData(runtime, abs, payload.instanceId ?? payload.runConfigName) }
    case 'create':
      assertTrusted(runtime, abs)
      return createAction(runtime, abs, payload)
    case 'delete':
      assertTrusted(runtime, abs)
      return deleteAction(runtime, abs, payload)
    case 'mods':
      assertTrusted(runtime, abs)
      return modsAction(runtime, abs, payload.instanceId ?? payload.runConfigName, payload.action, payload.mods, payload.paths)
    case 'launch': {
      assertTrusted(runtime, abs)
      const result = runtime.scan(abs)
      const profile = findProfile(result, payload.instanceId ?? payload.runConfigName)
      const project = projectOf(result, profile)
      const side = payload.side === 'server' ? 'server' : 'client'
      const extraArgs = Array.isArray(payload.extraArgs)
        ? payload.extraArgs.filter((a) => typeof a === 'string' && a.length < 200).slice(0, 20)
        : []
      const launch = runtime.startLaunch({ workspace: abs, project, profile, side, extraArgs })
      return { launch, instance: enrichInstance(runtime, abs, profile, project) }
    }
    case 'stop':
      return { launch: runtime.stopLaunch(payload.launchId) }
    case 'launches':
      return { launches: runtime.launchesView() }
    case 'log':
      assertTrusted(runtime, abs)
      return logAction(runtime, abs, payload)
    case 'ide': {
      assertTrusted(runtime, abs)
      const res = writeRunConfigs(abs, { project: payload.project, server: payload.server === true })
      runtime.invalidate(abs)
      return res
    }
    case 'open':
      assertTrusted(runtime, abs)
      return openPath(runtime, abs, payload)
    case 'roots':
      return { roots: runtime.rootsView() }
    case 'neighborhood':
      return runtime.neighborhood(abs)
    default:
      throw new Error(`不支持的操作：${op || '(空)'}`)
  }
}

function defaultWorkspace(runtime) {
  const roots = runtime.rootsView()
  const withProjects = roots.find((r) => r.exists && r.projectCount > 0)
  return withProjects?.path ?? runtime.defaultWorkspace ?? process.env.DSH_MC_WORKSPACE ?? DEFAULT_WORKSPACE
}

/**
 * 把面板 API 注册到 webServer。webServer 缺席时（纯 CLI 组合）静默不注册，
 * Agent 工具仍然可用。
 * @param ctx - Host 插件上下文。
 */
export function registerPanelApi(ctx, options = {}) {
  // 纯工具测试或极简组合里可能没有 Cordis 的 ctx.inject；面板 API 是可选能力。
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    const runtime = new PanelRuntime(scope, options)
    const server = scope.webServer
    let expectedPort = ''
    try {
      const origin = new URL(server.getOrigin())
      expectedPort = origin.port || (origin.protocol === 'https:' ? '443' : '80')
    } catch { /* 端口尚未绑定：只校验回环主机名 */ }
    scope.effect(() => {
      const disposeState = server.register({
        kind: 'exact',
        path: `${API_BASE}/state`,
        handler: (req, res) => {
          try {
            if (!allowed(req, expectedPort)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '拒绝非本机回环页面的请求' } })
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: { code: 'method', message: '只支持 GET' } })
            const url = new URL(req.url ?? '/', 'http://localhost')
            const requested = url.searchParams.get('workspace')
            const workspace = requested && requested.trim() !== '' ? path.resolve(requested) : defaultWorkspace(runtime)
            const probeRoots = url.searchParams.get('probeRoots') !== '0'
            ok(res, stateData(runtime, workspace, { probeRoots }))
          } catch (error) {
            fail(res, error?.message ?? error)
          }
        },
      })
      const disposeAction = server.register({
        kind: 'exact',
        path: `${API_BASE}/action`,
        handler: async (req, res) => {
          try {
            if (!allowed(req, expectedPort)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '拒绝非本机回环页面的请求' } })
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'method', message: '只支持 POST' } })
            const type = String(req.headers?.['content-type'] ?? '').toLowerCase().split(';')[0].trim()
            if (type !== 'application/json') return sendJson(res, 415, { ok: false, error: { code: 'content-type', message: '需要 application/json' } })
            const payload = await readJsonBody(req)
            if (payload === TOO_LARGE) return sendJson(res, 413, { ok: false, error: { code: 'too-large', message: '请求体超过 256 KiB' } })
            if (payload === TIMED_OUT) return sendJson(res, 408, { ok: false, error: { code: 'timeout', message: '读取请求体超时' } })
            if (payload === null) return sendJson(res, 400, { ok: false, error: { code: 'body', message: '请求体不是合法 JSON' } })
            const requested = typeof payload.workspace === 'string' && payload.workspace.trim() !== '' ? payload.workspace : null
            const workspace = requested !== null ? path.resolve(requested) : defaultWorkspace(runtime)
            const data = dispatch(runtime, workspace, payload)
            ok(res, data)
          } catch (error) {
            fail(res, error?.message ?? error)
          }
        },
      })
      return () => {
        try { disposeAction() } catch { /* ignore */ }
        try { disposeState() } catch { /* ignore */ }
        runtime.dispose()
      }
    }, 'mc-instances: panel routes')
  })
}
