/**
 * dsh-mc-instances · 右侧栏「MC 实例」面板（浏览器半）
 *
 * 纯 JavaScript React（无 JSX、无构建步骤），通过 window.__ModuleLoader__ 注册。
 * 右侧栏 tab 类型注册在 ctx.sidebarRightTabs，正文注册在 sidebar.right.pane.tab；
 * 数据面由 Host 半的 /dsh-mc-panel/api 提供（见 src/panel-api.js）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mc-instances',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const NS = 'mcInstances';
    const KIND = 'mc-instances';
    const TAB_ID = 'dsh-mc-instances';
    const API_BASE = '/dsh-mc-panel/api';
    const GATE_HEADER = 'x-dsh-mc-panel';

    // ────────────────────────────────────────────────────────────── 基础工具

    const cx = (...parts) => parts.filter(Boolean).join(' ');
    const noWorkspaces = () => [];

    const fmtBytes = (bytes) => {
      const n = Number(bytes) || 0;
      if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
      if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    };

    const fmtDuration = (ms) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const mm = String(minutes).padStart(2, '0');
      const ss = String(seconds).padStart(2, '0');
      return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
    };

    const LOADERS = {
      fabric: { label: 'Fabric', accent: '#d8c7a1', strong: '#a8895c' },
      neoforge: { label: 'NeoForge', accent: '#f16436', strong: '#c94a21' },
      forge: { label: 'Forge', accent: '#5b7fb3', strong: '#3f5f8c' },
      unknown: { label: '未知', accent: '#8b93a1', strong: '#6b7280' },
    };
    const loaderOf = (key) => LOADERS[key] ?? LOADERS.unknown;
    /** 实例身份：新版宿主给 instanceId；旧版或宿主短暂重载期间退回 runConfigName。 */
    const idOf = (entry) => entry?.instanceId || entry?.runConfigName || '';

    // ── 客户端设置（localStorage，按浏览器/桌面 profile 持久化）────────
    const AUTO_HIDE_KEY = 'dsh.mc-instances.autoHideEmpty';
    const settings = {
      autoHide: (() => {
        try { return localStorage.getItem(AUTO_HIDE_KEY) !== '0' } catch { return true }
      })(),
      listeners: new Set(),
    };
    function setAutoHideSetting(value) {
      settings.autoHide = value === true;
      try { localStorage.setItem(AUTO_HIDE_KEY, settings.autoHide ? '1' : '0') } catch { /* 隐私模式等 */ }
      for (const listener of settings.listeners) {
        try { listener(settings.autoHide) } catch { /* ignore */ }
      }
    }
    function useAutoHideSetting() {
      const [value, setValue] = useState(settings.autoHide);
      useEffect(() => {
        const listener = (next) => setValue(next);
        settings.listeners.add(listener);
        setValue(settings.autoHide);
        return () => { settings.listeners.delete(listener) };
      }, []);
      return [value, setAutoHideSetting];
    }

    const statusOf = (launch) => (launch ? launch.status : 'idle');
    const ACTIVE_STATUSES = new Set(['starting', 'running', 'stopping']);
    const isActiveLaunch = (launch) => !!launch && ACTIVE_STATUSES.has(launch.status);

    function fmtRelative(iso, t) {
      if (!iso) return t('time.never');
      const then = new Date(iso).getTime();
      if (!Number.isFinite(then)) return t('time.never');
      const diff = Date.now() - then;
      if (diff < 45000) return t('time.justNow');
      const minutes = Math.floor(diff / 60000);
      if (minutes < 60) return t('time.minutesAgo', { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('time.hoursAgo', { count: hours });
      const days = Math.floor(hours / 24);
      if (days < 30) return t('time.daysAgo', { count: days });
      return new Date(then).toLocaleDateString();
    }

    function fmtTime(iso) {
      if (!iso) return '—';
      try { return new Date(iso).toLocaleString() } catch { return String(iso) }
    }

    // ────────────────────────────────────────────────────────────── 数据面

    async function call(url, options) {
      let response;
      try {
        response = await fetch(url, options);
      } catch (error) {
        throw new Error(`无法连接实例管理器后端：${error?.message ?? error}`);
      }
      let body = null;
      try { body = await response.json() } catch { /* fallthrough */ }
      if (!response.ok) {
        throw new Error(body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
      }
      if (!body || body.ok !== true) {
        throw new Error(body?.error?.message ?? '请求失败');
      }
      return body.data;
    }

    const apiState = (workspace, probeRoots = true) => call(
      `${API_BASE}/state?${new URLSearchParams({ workspace: workspace || '', probeRoots: probeRoots ? '1' : '0' }).toString()}`,
      { headers: { [GATE_HEADER]: '1' }, cache: 'no-store' },
    );

    const apiAction = (payload) => call(`${API_BASE}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [GATE_HEADER]: '1' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });

    // ────────────────────────────────────────────────────────────── 图标

    const svg = (props, children) => h('svg', {
      viewBox: '0 0 24 24', width: props?.size ?? 16, height: props?.size ?? 16,
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
      strokeLinecap: 'round', strokeLinejoin: 'round',
      className: props?.className, 'aria-hidden': true, focusable: 'false',
    }, ...children.filter(Boolean).map((child, index) => (child.key == null ? React.cloneElement(child, { key: index }) : child)));

    const IconRefresh = (p) => svg(p, [
      h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.4 6.4' }),
      h('path', { key: 'b', d: 'M20 4v7h-7' }),
    ]);
    const IconSearch = (p) => svg(p, [
      h('circle', { key: 'a', cx: 11, cy: 11, r: 6.5 }),
      h('path', { key: 'b', d: 'm16 16 4.5 4.5' }),
    ]);
    const IconPlay = (p) => h('svg', {
      viewBox: '0 0 24 24', width: p?.size ?? 14, height: p?.size ?? 14,
      className: p?.className, 'aria-hidden': true, focusable: 'false',
    }, h('path', { d: 'M8 5.5v13l11-6.5z', fill: 'currentColor' }));
    const IconStop = (p) => h('svg', {
      viewBox: '0 0 24 24', width: p?.size ?? 14, height: p?.size ?? 14,
      className: p?.className, 'aria-hidden': true, focusable: 'false',
    }, h('rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2, fill: 'currentColor' }));
    const IconMore = (p) => svg(p, [
      h('circle', { key: 'a', cx: 5, cy: 12, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'b', cx: 12, cy: 12, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'c', cx: 19, cy: 12, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    ]);
    const IconBack = (p) => svg(p, [h('path', { d: 'M15 5l-7 7 7 7' })]);
    const IconFolder = (p) => svg(p, [
      h('path', { key: 'a', d: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.2h8A1.5 1.5 0 0 1 20.5 9.7v8.8A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5z' }),
    ]);
    const IconDoc = (p) => svg(p, [
      h('path', { key: 'a', d: 'M6.5 3.5h7l4 4v13h-11z' }),
      h('path', { key: 'b', d: 'M13.5 3.5v4h4' }),
      h('path', { key: 'c', d: 'M9 12h6M9 15.5h6' }),
    ]);
    const IconTrash = (p) => svg(p, [
      h('path', { key: 'a', d: 'M4 7h16M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7' }),
      h('path', { key: 'b', d: 'M6.5 7l.8 11.2A1.8 1.8 0 0 0 9.1 20h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7' }),
      h('path', { key: 'c', d: 'M10 11v5M14 11v5' }),
    ]);
    const IconPlus = (p) => svg(p, [h('path', { d: 'M12 5v14M5 12h14' })]);
    const IconClose = (p) => svg(p, [h('path', { d: 'M6 6l12 12M18 6L6 18' })]);
    const IconChevron = (p) => svg(p, [h('path', { d: 'm9 6 6 6-6 6' })]);
    const IconMod = (p) => svg(p, [
      h('path', { key: 'a', d: 'M8 4.5h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z' }),
      h('path', { key: 'b', d: 'M9.5 9h5M9.5 12.5h5M9.5 16h3' }),
    ]);
    const IconTerminal = (p) => svg(p, [
      h('rect', { key: 'a', x: 3.5, y: 5, width: 17, height: 14, rx: 2 }),
      h('path', { key: 'b', d: 'm7.5 10 3 2.5-3 2.5M13 15h4' }),
    ]);
    const IconSwitch = (p) => svg(p, [
      h('path', { key: 'a', d: 'M4 8h13l-3-3M20 16H7l3 3' }),
    ]);
    const IconCheck = (p) => svg(p, [h('path', { d: 'm5 12.5 4.5 4.5L19 7' })]);
    const IconAlert = (p) => svg(p, [
      h('path', { key: 'a', d: 'M12 4.5 21 20H3z' }),
      h('path', { key: 'b', d: 'M12 10v5M12 18h.01' }),
    ]);
    const IconBox = (p) => svg(p, [
      h('path', { key: 'a', d: 'M12 3 21 8v8l-9 5-9-5V8z' }),
      h('path', { key: 'b', d: 'M3 8l9 5 9-5M12 13v8' }),
    ]);
    const IconSettings = (p) => svg(p, [
      h('circle', { key: 'a', cx: 12, cy: 12, r: 3 }),
      h('path', { key: 'b', d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.36.36.7.6 1 .3.26.68.4 1.1.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6z' }),
    ]);

    /** 草方块标志：面板/指南卡/标题按钮共用。 */
    function GrassMark({ size = 22, className }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, className,
        'aria-hidden': true, focusable: 'false',
      }, [
        h('path', { key: 'top', d: 'M3.5 8.2 12 3.6l8.5 4.6L12 12.8z', fill: '#79b969' }),
        h('path', { key: 'left', d: 'M3.5 8.2v7.2L12 20v-7.2z', fill: '#8a5a3b' }),
        h('path', { key: 'right', d: 'M20.5 8.2v7.2L12 20v-7.2z', fill: '#6d452b' }),
        h('path', { key: 'lipL', d: 'M3.5 8.2 12 12.8l1.2-.65v2.2L3.5 9.7z', fill: '#5f9e52' }),
        h('path', { key: 'lipR', d: 'M20.5 8.2 12 12.8l-1.2-.65v2.2l9.7-5.25z', fill: '#4f8a45' }),
        h('path', { key: 'edge', d: 'M3.5 8.2 12 3.6l8.5 4.6L12 12.8z', fill: 'none', stroke: 'rgba(30,40,25,.35)', strokeWidth: 0.9, strokeLinejoin: 'round' }),
      ]);
    }

    /** 标题按钮：草方块 + 小播放三角。 */
    function GrassPlayMark({ size = 18, className }) {
      return h('span', { className: cx('mc-mark-wrap', className), style: { width: size, height: size } }, [
        h(GrassMark, { key: 'g', size, className: 'mc-mark-block' }),
        h('svg', {
          key: 'p', viewBox: '0 0 12 12', width: Math.round(size * 0.48), height: Math.round(size * 0.48),
          className: 'mc-mark-play', 'aria-hidden': true,
        }, h('path', { d: 'M3 1.6 10 6l-7 4.4z', fill: 'currentColor' })),
      ]);
    }

    // ────────────────────────────────────────────────────────────── 文案

    const zh = {
      'tab.title': 'MC 实例',
      'guide.title': 'MC 实例管理器',
      'guide.description': '自动检测工作区实例；一键启动/停止、开关 mod、看日志、新建实例、生成 IDE 配置',
      'button.label': 'MC 实例',
      'header.title': 'MC 实例',
      'header.count': '{count} 个实例',
      'header.refresh': '重新扫描',
      'header.switchWorkspace': '切换工作区',
      'settings.title': 'MC 实例设置',
      'settings.autoHide': '附近没有实例时自动隐藏入口',
      'settings.autoHideHint': '隐藏会话头部的 MC 实例按钮，并让右侧栏指南里的 MC 实例卡片一起消失；同时停止自动切换到其它工作区。入口全隐藏时用 Ctrl+Alt+M（macOS 为 ⌘⌥M）打开面板。',
      'settings.scope': '检测范围：当前工作区（含子目录）和直接父目录。此设置保存在当前浏览器 / 桌面 profile。',
      'settings.on': '开',
      'settings.off': '关',
      'shortcut.open': '打开 MC 实例面板',
      'shortcut.noSession': '请先选择会话',
      'empty.noNearby': '当前工作区、父级与子级目录都没有检测到 MC 实例。',
      'search.placeholder': '搜索实例、工程、版本…',
      'filter.all': '全部',
      'filter.running': '运行中',
      'empty.title': '当前工作区没有 MC 测试实例',
      'empty.body': '这里会显示各模组工程 run/<实例>/ 下的测试档案。新建一个实例，或切换到含 MC 工程的工作区。',
      'empty.create': '新建实例',
      'empty.switch': '切换工作区',
      'empty.retry': '重试',
      'empty.noProject': '这个工作区里没有找到支持实例隔离的模组工程（build.gradle 里要有 -Pinstance）。',
      'loading': '正在扫描工作区…',
      'error.title': '面板加载失败',
      'error.retry': '重试',
      'notice.autoSwitch': '当前工作区没有实例，已切换到「{name}」',
      'project.instances': '{count} 个实例',
      'instance.default': '默认',
      'instance.never': '尚未启动',
      'instance.running': '运行中',
      'instance.starting': '启动中',
      'instance.stopping': '停止中',
      'instance.lastLaunch': '上次启动',
      'instance.viewLaunchLog': '查看 Gradle 日志',
      'instance.notCreated': 'run/ 目录尚未创建，首次启动时生成',
      'instance.stopped': '已停止',
      'instance.exited': '已退出',
      'instance.failed': '启动失败',
      'instance.launch': '启动',
      'instance.launchServer': '启动服务端',
      'instance.server': '服务端',
      'instance.stop': '停止',
      'instance.more': '更多操作',
      'instance.openFolder': '打开游戏目录',
      'instance.openLogs': '打开日志目录',
      'instance.ide': '生成 IDE 运行配置',
      'instance.delete': '删除实例',
      'instance.create': '新建实例',
      'instance.lastActivity': '上次活动',
      'instance.mods': '{enabled}/{total} mods',
      'instance.modsEmpty': '0 个 mod',
      'instance.modCount': '{count} 个 mod',
      'instance.jdk': 'JDK {version}',
      'instance.unknownVersion': '未知版本',
      'detail.title': '实例详情',
      'detail.back': '返回列表',
      'detail.overview': '概览',
      'detail.mods': 'Mods',
      'detail.logs': '日志',
      'detail.gameDir': '游戏目录',
      'detail.instanceName': '实例名',
      'detail.runConfig': '运行配置',
      'detail.autoSynced': '启动时自动同步',
      'detail.options': '游戏设置',
      'detail.saves': '存档',
      'detail.screenshots': '截图',
      'detail.crashes': '崩溃报告',
      'detail.latestCrash': '最近崩溃',
      'detail.crashedAt': '崩溃时间',
      'detail.noCrash': '没有崩溃报告',
      'option.lang': '语言',
      'option.renderDistance': '渲染距离',
      'option.maxFps': '最大帧率',
      'option.guiScale': '界面缩放',
      'option.graphicsMode': '图形模式',
      'option.showFps': '显示帧率',
      'option.fov': '视野',
      'detail.noData': '还没有游戏数据，启动一次实例后生成。',
      'detail.launchInfo': '启动信息',
      'detail.pid': 'PID',
      'detail.startedAt': '启动于',
      'detail.javaHome': 'JAVA_HOME',
      'detail.systemPath': '(系统 PATH)',
      'detail.notLaunched': '这个实例当前没有运行。',
      'detail.deleteHint': '删除会清空该实例的 mods、存档与日志，无法恢复。',
      'mods.search': '搜索 mod…',
      'mods.empty': '这个实例还没有 mod',
      'mods.emptyHint': '启动时自动同步的 mod 会出现在这里，也可以从工作区导入。',
      'mods.noMatch': '没有匹配的 mod',
      'mods.restartHint': 'mod 改动在下次启动该实例时生效。',
      'mods.import': '导入 mod',
      'mods.only': '仅留此 mod',
      'mods.remove': '删除这个 mod 文件',
      'mods.enabled': '已启用',
      'mods.disabled': '已禁用',
      'mods.importTitle': '从工作区导入 mod',
      'mods.importSearch': '搜索候选 mod…',
      'mods.importEmpty': '工作区的 _shared、_mods 与各实例 mods 里没有找到 jar。',
      'mods.importCount': '已选 {count} 个',
      'mods.importConfirm': '导入所选',
      'mods.source': '来源',
      'logs.kindGame': '游戏日志',
      'logs.kindLaunch': 'Gradle 日志',
      'logs.auto': '自动刷新',
      'logs.open': '打开日志',
      'logs.copy': '复制路径',
      'logs.empty': '还没有日志。启动一次实例后，最新日志会出现在这里。',
      'logs.loading': '正在读取日志…',
      'logs.updated': '更新于 {time}',
      'logs.followHint': '每 2 秒读取末尾 220 行。',
      'logs.readFailed': '读取日志失败',
      'create.title': '新建测试实例',
      'create.project': '所属工程',
      'create.name': '实例名',
      'create.namePlaceholder': '例如 dev2、测试B',
      'create.nameHint': '会创建 <工程>/run/<实例名>/ 目录，不能包含 \\ / : * ? " < > | %，也不能以点或空格结尾',
      'create.copyOptions': '继承默认实例的 options.txt（键位、画面设置）',
      'create.copyFrom': '复制 mods（可选）',
      'create.copyFromNone': '不复制',
      'create.writeIde': '同时生成 IntelliJ 运行配置',
      'create.submit': '创建实例',
      'create.creating': '正在创建…',
      'create.invalid': '实例名不能为空',
      'delete.title': '删除实例',
      'delete.body': '这会删除「{name}」的整个游戏目录（mods、存档、日志都在里面），无法恢复。',
      'delete.typeHint': '输入实例名「{name}」以确认',
      'delete.placeholder': '输入实例名',
      'delete.submit': '删除',
      'delete.deleting': '正在删除…',
      'delete.defaultProtected': '默认实例 run/ 受保护，不能删除。',
      'delete.running': '实例正在运行，请先停止再删除。',
      'actions.title': '实例操作',
      'actions.cancel': '取消',
      'workspace.title': '选择工作区',
      'workspace.current': '当前会话',
      'workspace.projects': '{count} 个 MC 工程',
      'workspace.empty': '没有 MC 工程',
      'workspace.missing': '目录不存在',
      'workspace.pick': '选择其他文件夹…',
      'workspace.scanning': '正在扫描…',
      'toast.launched': '已启动「{name}」，PID {pid}',
      'toast.launchFailed': '启动失败：{message}',
      'toast.stopped': '已停止「{name}」',
      'toast.stopping': '正在停止「{name}」…',
      'toast.created': '已创建「{name}」',
      'toast.deleted': '已删除「{name}」',
      'toast.ide': '已写入 {count} 个 IDE 运行配置',
      'toast.opened': '已在文件管理器中打开',
      'toast.imported': '已导入 {count} 个 mod',
      'toast.toggledOn': '已启用「{name}」',
      'toast.toggledOff': '已禁用「{name}」',
      'toast.only': '只保留「{name}」',
      'toast.copied': '路径已复制',
      'toast.picked': '已切换工作区，发现 {count} 个 MC 工程',
      'toast.pickedEmpty': '这个文件夹里没有找到 MC 工程',
      'running.uptime': '已运行 {time}',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{count} 分钟前',
      'time.hoursAgo': '{count} 小时前',
      'time.daysAgo': '{count} 天前',
      'time.never': '尚未启动',
      'misc.unknown': '未知',
      'misc.cancel': '取消',
      'misc.close': '关闭',
      'misc.confirm': '确认',
      'misc.loading': '加载中…',
      'misc.empty': '（空）',
      'misc.delete': '删除',
      'misc.clear': '清空',
      'error.noDirectoryPicker': '当前客户端不支持选择目录',
    };

    const en = {
      'tab.title': 'MC instances',
      'guide.title': 'Minecraft instance manager',
      'guide.description': 'Detects workspace instances; launch/stop, toggle mods, read logs, create instances, generate IDE configs',
      'button.label': 'MC instances',
      'header.title': 'MC instances',
      'header.count': '{count} instances',
      'header.refresh': 'Rescan',
      'header.switchWorkspace': 'Switch workspace',
      'settings.title': 'MC instance settings',
      'settings.autoHide': 'Hide the entry when no nearby instances exist',
      'settings.autoHideHint': 'Hides the MC instances button in the session header and the MC instances card on the right-sidebar guide, and stops switching to other workspaces automatically. When every entry is hidden, press Ctrl+Alt+M (⌘⌥M on macOS) to open the panel.',
      'settings.scope': 'Detection scope: the current workspace (including subdirectories) and its direct parent. Saved in this browser / desktop profile.',
      'settings.on': 'On',
      'settings.off': 'Off',
      'shortcut.open': 'Open the MC instances panel',
      'shortcut.noSession': 'Select a session first',
      'empty.noNearby': 'No MC instances found in this workspace, its parent, or its child directories.',
      'search.placeholder': 'Search instances, projects, versions…',
      'filter.all': 'All',
      'filter.running': 'Running',
      'empty.title': 'No Minecraft test instances in this workspace',
      'empty.body': 'Instances live under each project\'s run/<name>/. Create one, or switch to a workspace with MC projects.',
      'empty.create': 'New instance',
      'empty.switch': 'Switch workspace',
      'empty.retry': 'Retry',
      'empty.noProject': 'No project here supports instance isolation (build.gradle needs -Pinstance).',
      'loading': 'Scanning workspace…',
      'error.title': 'Could not load the panel',
      'error.retry': 'Retry',
      'notice.autoSwitch': 'No instances in this workspace; switched to “{name}”',
      'project.instances': '{count} instances',
      'instance.default': 'default',
      'instance.never': 'Never launched',
      'instance.running': 'Running',
      'instance.starting': 'Starting',
      'instance.stopping': 'Stopping',
      'instance.lastLaunch': 'Last launch',
      'instance.viewLaunchLog': 'View Gradle log',
      'instance.notCreated': 'run/ is not created yet; it appears on the first launch',
      'instance.stopped': 'Stopped',
      'instance.exited': 'Exited',
      'instance.failed': 'Launch failed',
      'instance.launch': 'Launch',
      'instance.launchServer': 'Launch server',
      'instance.server': 'server',
      'instance.stop': 'Stop',
      'instance.more': 'More actions',
      'instance.openFolder': 'Open game folder',
      'instance.openLogs': 'Open logs folder',
      'instance.ide': 'Generate IDE run config',
      'instance.delete': 'Delete instance',
      'instance.create': 'New instance',
      'instance.lastActivity': 'Last activity',
      'instance.mods': '{enabled}/{total} mods',
      'instance.modsEmpty': '0 mods',
      'instance.modCount': '{count} mods',
      'instance.jdk': 'JDK {version}',
      'instance.unknownVersion': 'Unknown version',
      'detail.title': 'Instance details',
      'detail.back': 'Back to list',
      'detail.overview': 'Overview',
      'detail.mods': 'Mods',
      'detail.logs': 'Logs',
      'detail.gameDir': 'Game directory',
      'detail.instanceName': 'Instance',
      'detail.runConfig': 'Run configuration',
      'detail.autoSynced': 'Synced on launch',
      'detail.options': 'Game options',
      'detail.saves': 'Saves',
      'detail.screenshots': 'Screenshots',
      'detail.crashes': 'Crash reports',
      'detail.latestCrash': 'Latest crash',
      'detail.crashedAt': 'Crashed',
      'detail.noCrash': 'No crash reports',
      'option.lang': 'Language',
      'option.renderDistance': 'Render distance',
      'option.maxFps': 'Max FPS',
      'option.guiScale': 'GUI scale',
      'option.graphicsMode': 'Graphics',
      'option.showFps': 'Show FPS',
      'option.fov': 'FOV',
      'detail.noData': 'No game data yet; it appears after the first launch.',
      'detail.launchInfo': 'Launch info',
      'detail.pid': 'PID',
      'detail.startedAt': 'Started',
      'detail.javaHome': 'JAVA_HOME',
      'detail.systemPath': '(system PATH)',
      'detail.notLaunched': 'This instance is not running.',
      'detail.deleteHint': 'Deleting clears this instance\'s mods, saves and logs. It cannot be undone.',
      'mods.search': 'Search mods…',
      'mods.empty': 'No mods in this instance',
      'mods.emptyHint': 'Mods synced on launch appear here; you can also import them from the workspace.',
      'mods.noMatch': 'No matching mods',
      'mods.restartHint': 'Mod changes take effect on the next launch of this instance.',
      'mods.import': 'Import mods',
      'mods.only': 'Keep only this',
      'mods.remove': 'Delete this mod file',
      'mods.enabled': 'Enabled',
      'mods.disabled': 'Disabled',
      'mods.importTitle': 'Import mods from the workspace',
      'mods.importSearch': 'Search candidate mods…',
      'mods.importEmpty': 'No jars found in _shared, _mods, or any instance mods folder.',
      'mods.importCount': '{count} selected',
      'mods.importConfirm': 'Import selected',
      'mods.source': 'Source',
      'logs.kindGame': 'Game log',
      'logs.kindLaunch': 'Gradle log',
      'logs.auto': 'Auto refresh',
      'logs.open': 'Open log',
      'logs.copy': 'Copy path',
      'logs.empty': 'No logs yet. Launch the instance once and its latest log will appear here.',
      'logs.loading': 'Reading log…',
      'logs.updated': 'Updated {time}',
      'logs.followHint': 'Reads the last 220 lines every 2 seconds.',
      'logs.readFailed': 'Could not read the log',
      'create.title': 'New test instance',
      'create.project': 'Project',
      'create.name': 'Instance name',
      'create.namePlaceholder': 'e.g. dev2, testB',
      'create.nameHint': 'Creates <project>/run/<name>/. Cannot contain \\ / : * ? " < > | %, or end with a dot or space',
      'create.copyOptions': 'Inherit options.txt from the default instance',
      'create.copyFrom': 'Copy mods (optional)',
      'create.copyFromNone': 'Do not copy',
      'create.writeIde': 'Also write the IntelliJ run configuration',
      'create.submit': 'Create instance',
      'create.creating': 'Creating…',
      'create.invalid': 'Instance name is required',
      'delete.title': 'Delete instance',
      'delete.body': 'This deletes the entire game directory of “{name}” (mods, saves, logs). It cannot be undone.',
      'delete.typeHint': 'Type the instance name “{name}” to confirm',
      'delete.placeholder': 'Instance name',
      'delete.submit': 'Delete',
      'delete.deleting': 'Deleting…',
      'delete.defaultProtected': 'The default run/ instance is protected and cannot be deleted.',
      'delete.running': 'The instance is running; stop it before deleting.',
      'actions.title': 'Instance actions',
      'actions.cancel': 'Cancel',
      'workspace.title': 'Choose workspace',
      'workspace.current': 'This session',
      'workspace.projects': '{count} MC projects',
      'workspace.empty': 'No MC projects',
      'workspace.missing': 'Directory missing',
      'workspace.pick': 'Choose another folder…',
      'workspace.scanning': 'Scanning…',
      'toast.launched': 'Launched “{name}” (PID {pid})',
      'toast.launchFailed': 'Launch failed: {message}',
      'toast.stopped': 'Stopped “{name}”',
      'toast.stopping': 'Stopping “{name}”…',
      'toast.created': 'Created “{name}”',
      'toast.deleted': 'Deleted “{name}”',
      'toast.ide': 'Wrote {count} IDE run configurations',
      'toast.opened': 'Opened in the file manager',
      'toast.imported': 'Imported {count} mods',
      'toast.toggledOn': 'Enabled “{name}”',
      'toast.toggledOff': 'Disabled “{name}”',
      'toast.only': 'Kept only “{name}”',
      'toast.copied': 'Path copied',
      'toast.picked': 'Switched workspace; found {count} MC projects',
      'toast.pickedEmpty': 'No MC projects found in that folder',
      'running.uptime': 'Running {time}',
      'time.justNow': 'just now',
      'time.minutesAgo': '{count} min ago',
      'time.hoursAgo': '{count} h ago',
      'time.daysAgo': '{count} d ago',
      'time.never': 'Never launched',
      'misc.unknown': 'Unknown',
      'misc.cancel': 'Cancel',
      'misc.close': 'Close',
      'misc.confirm': 'Confirm',
      'misc.loading': 'Loading…',
      'misc.empty': '(empty)',
      'misc.delete': 'Delete',
      'misc.clear': 'Clear',
      'error.noDirectoryPicker': 'This client cannot pick directories',
    };

    // ────────────────────────────────────────────────────────────── 样式

    const CSS = `
.mc-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.45; }
.mc-root * { box-sizing: border-box; }
.mc-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.mc-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.mc-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 26%, transparent); border-radius: 99px; }
.mc-head { padding: 10px 12px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.mc-head-row { display: flex; align-items: center; gap: 8px; }
.mc-title { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: .1px; display: flex; align-items: center; gap: 8px; }
.mc-count { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 99px; padding: 1px 7px; }
.mc-head-actions { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.mc-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mc-iconbtn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.mc-iconbtn:active { transform: translateY(.5px); }
.mc-iconbtn:disabled { opacity: .45; cursor: default; }
.mc-ws { margin-top: 8px; display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.mc-ws:hover { border-color: var(--dsw-alias-border-l2); }
.mc-ws-ico { color: var(--dsw-alias-label-secondary); display: inline-flex; }
.mc-ws-text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.mc-ws-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-ws-path { font-size: 10.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-ws-chev { color: var(--dsw-alias-label-secondary); display: inline-flex; transform: rotate(90deg); }
.mc-toolbar { padding: 8px 12px 6px; display: flex; flex-direction: column; gap: 7px; background: var(--dsw-alias-bg-base); }
.mc-search { position: relative; display: flex; align-items: center; }
.mc-search svg { position: absolute; left: 9px; color: var(--dsw-alias-label-secondary); pointer-events: none; }
.mc-search input { width: 100%; height: 30px; padding: 0 28px 0 29px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none; }
.mc-search input::placeholder { color: var(--dsw-alias-label-secondary); }
.mc-search input:focus { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.mc-search-clear { position: absolute; right: 6px; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mc-search-clear:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mc-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.mc-chip { height: 23px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 99px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.mc-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.mc-chip.on { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 48%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 11%, transparent); font-weight: 600; }
.mc-dot { width: 7px; height: 7px; border-radius: 99px; background: var(--mc-accent, var(--dsw-alias-label-secondary)); display: inline-block; flex: none; }
.mc-list { padding: 4px 10px 18px; display: flex; flex-direction: column; gap: 9px; }
.mc-group { display: flex; flex-direction: column; gap: 7px; }
.mc-group-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 3px 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .2px; text-align: left; cursor: pointer; }
.mc-group-head:hover { color: var(--dsw-alias-label-primary); }
.mc-group-head svg { opacity: .8; }
.mc-group-count { margin-left: auto; font-weight: 500; font-size: 10.5px; opacity: .85; }
.mc-chev { transform: rotate(90deg); transition: transform .12s ease; flex: none; }
.mc-chev.collapsed { transform: rotate(0deg); }
.mc-card { position: relative; display: flex; gap: 10px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); cursor: pointer; transition: border-color .12s ease, transform .12s ease, box-shadow .12s ease; outline: none; }
.mc-card:hover { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, var(--dsw-alias-border-l1)); box-shadow: 0 2px 10px rgba(0,0,0,.06); transform: translateY(-1px); }
.mc-card:focus-visible { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); }
.mc-card.running { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 36%, var(--dsw-alias-border-l1)); }
.mc-card-icon { width: 42px; height: 42px; flex: none; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--mc-accent, #8b93a1) 18%, var(--dsw-alias-bg-layer-2)); border: 1px solid color-mix(in srgb, var(--mc-accent, #8b93a1) 34%, transparent); }
.mc-card-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.mc-card-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mc-name { font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-default-tag { flex: none; font-size: 9.5px; font-weight: 600; padding: 0 5px; height: 16px; display: inline-flex; align-items: center; border-radius: 5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.mc-sub { font-size: 10.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-badges { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: 2px; }
.mc-badge { display: inline-flex; align-items: center; gap: 4px; height: 19px; padding: 0 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 10px; font-weight: 500; white-space: nowrap; border: 1px solid transparent; }
.mc-badge.loader { color: color-mix(in srgb, var(--mc-accent, #8b93a1) 62%, var(--dsw-alias-label-primary)); background: color-mix(in srgb, var(--mc-accent, #8b93a1) 15%, transparent); border-color: color-mix(in srgb, var(--mc-accent, #8b93a1) 30%, transparent); }
.mc-card-foot { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 10px; color: var(--dsw-alias-label-secondary); min-height: 14px; }
.mc-card-foot .spacer { flex: 1; }
.mc-running { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-state-success-primary); font-weight: 600; }
.mc-ended { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.mc-ended.err { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.mc-fail-banner { margin: 0 12px 10px; padding: 8px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); display: flex; align-items: center; gap: 7px; font-size: 11px; }
.mc-fail-banner.err { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); color: var(--dsw-alias-state-error-primary); }
.mc-fail-banner .mc-btn { margin-left: auto; }
.mc-pulse { width: 6px; height: 6px; border-radius: 99px; background: currentColor; animation: mcPulse 1.6s ease-out infinite; }
@keyframes mcPulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.mc-card-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 6px; }
.mc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 27px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.mc-btn:hover { border-color: var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, var(--dsw-alias-bg-layer-2)); }
.mc-btn:disabled { opacity: .5; cursor: default; }
.mc-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.mc-btn.primary:hover { filter: brightness(1.06); }
.mc-btn.danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.mc-btn.danger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.mc-btn.ghost { border-color: transparent; background: transparent; }
.mc-btn.ghost:hover { background: var(--dsw-alias-bg-layer-2); }
.mc-btn.small { height: 24px; font-size: 10.5px; padding: 0 7px; }
.mc-stop { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.mc-stop:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent); }
.mc-empty { padding: 34px 20px 26px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; color: var(--dsw-alias-label-secondary); }
.mc-empty-mark { width: 64px; height: 64px; border-radius: 18px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); display: flex; align-items: center; justify-content: center; opacity: .9; }
.mc-empty h3 { margin: 0; font-size: 13.5px; color: var(--dsw-alias-label-primary); font-weight: 650; }
.mc-empty p { margin: 0; font-size: 11.5px; max-width: 300px; line-height: 1.6; }
.mc-empty-actions { display: flex; gap: 7px; margin-top: 4px; flex-wrap: wrap; justify-content: center; }
.mc-skeleton { padding: 10px 10px 18px; display: flex; flex-direction: column; gap: 9px; }
.mc-sk-card { height: 86px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: linear-gradient(100deg, var(--dsw-alias-bg-layer-1) 20%, var(--dsw-alias-bg-layer-2) 40%, var(--dsw-alias-bg-layer-1) 60%); background-size: 220% 100%; animation: mcShimmer 1.4s linear infinite; }
@keyframes mcShimmer { to { background-position: -120% 0; } }
.mc-error { margin: 14px; padding: 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, var(--dsw-alias-border-l1)); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.mc-error strong { color: var(--dsw-alias-state-error-primary); display: flex; align-items: center; gap: 6px; }
.mc-detail { display: flex; flex-direction: column; min-height: 0; }
.mc-detail-top { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); position: sticky; top: 0; z-index: 3; }
.mc-detail-hero { display: flex; gap: 11px; padding: 12px; align-items: flex-start; }
.mc-detail-icon { width: 56px; height: 56px; border-radius: 15px; flex: none; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--mc-accent, #8b93a1) 18%, var(--dsw-alias-bg-layer-2)); border: 1px solid color-mix(in srgb, var(--mc-accent, #8b93a1) 34%, transparent); }
.mc-detail-title { min-width: 0; flex: 1; }
.mc-detail-title h2 { margin: 0; font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mc-detail-sub { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.mc-actions-row { display: flex; gap: 6px; padding: 0 12px 10px; flex-wrap: wrap; }
.mc-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 0 12px 10px; }
.mc-stat { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); padding: 7px 8px; min-width: 0; }
.mc-stat b { display: block; font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-stat span { font-size: 9.5px; color: var(--dsw-alias-label-secondary); display: block; margin-top: 1px; }
.mc-tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); position: sticky; top: 41px; z-index: 2; }
.mc-tab { position: relative; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; font-weight: 600; padding: 8px 9px 9px; cursor: pointer; }
.mc-tab:hover { color: var(--dsw-alias-label-primary); }
.mc-tab.on { color: var(--dsw-alias-label-primary); }
.mc-tab.on::after { content: ""; position: absolute; left: 7px; right: 7px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.mc-tab-count { margin-left: 4px; font-size: 9.5px; color: var(--dsw-alias-label-secondary); }
.mc-section { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.mc-panel { border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.mc-panel-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11.5px; font-weight: 650; }
.mc-panel-head .mc-btn { margin-left: auto; }
.mc-rows { display: flex; flex-direction: column; }
.mc-row { display: flex; gap: 8px; align-items: center; padding: 7px 10px; border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 60%, transparent); font-size: 11.5px; min-width: 0; }
.mc-row:first-child { border-top: 0; }
.mc-row-k { flex: none; width: 74px; color: var(--dsw-alias-label-secondary); font-size: 10.5px; }
.mc-row-v { flex: 1; min-width: 0; word-break: break-all; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 10.5px; }
.mc-row-v.plain { font-family: inherit; font-size: 11.5px; }
.mc-hint { padding: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.mc-warn { color: var(--dsw-alias-state-warn-primary); }
.mc-mods-tools { display: flex; gap: 6px; padding: 10px 12px 2px; }
.mc-mods-tools .mc-search { flex: 1; }
.mc-mod-list { display: flex; flex-direction: column; gap: 5px; padding: 8px 12px 14px; }
.mc-mod { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.mc-mod.off { opacity: .62; }
.mc-mod-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-family: ui-monospace, Consolas, monospace; }
.mc-mod-size { font-size: 9.5px; color: var(--dsw-alias-label-secondary); flex: none; }
.mc-mod-actions { display: flex; gap: 3px; flex: none; }
.mc-only { opacity: 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 9.5px; cursor: pointer; padding: 2px 4px; border-radius: 5px; }
.mc-mod:hover .mc-only, .mc-mod:focus-within .mc-only { opacity: 1; }
.mc-only:focus-visible { opacity: 1; outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); outline-offset: 1px; }
.mc-only:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
@media (hover: none) { .mc-only { opacity: 1; } }
.mc-switch { position: relative; width: 30px; height: 18px; border-radius: 99px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; padding: 0; flex: none; transition: background .12s ease, border-color .12s ease; }
.mc-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 99px; background: var(--dsw-alias-label-secondary); transition: transform .12s ease, background .12s ease; }
.mc-switch[aria-checked="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 82%, #000); border-color: var(--dsw-alias-brand-primary); }
.mc-switch[aria-checked="true"]::after { transform: translateX(12px); background: #fff; }
.mc-switch:disabled { opacity: .5; cursor: default; }
.mc-logbar { display: flex; align-items: center; gap: 6px; padding: 9px 12px 6px; flex-wrap: wrap; }
.mc-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.mc-seg button { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10.5px; padding: 4px 8px; cursor: pointer; }
.mc-seg button.on { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.mc-check { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
.mc-check input { accent-color: var(--dsw-alias-brand-primary); width: 12px; height: 12px; margin: 0; }
.mc-log-info { padding: 0 12px 6px; font-size: 9.5px; color: var(--dsw-alias-label-secondary); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mc-log-info code { font-family: ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.mc-log { margin: 0 12px 12px; padding: 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 94%, #000 6%); font: 10px/1.55 ui-monospace, "Cascadia Code", Consolas, monospace; white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 46vh; color: var(--dsw-alias-label-primary); }
.mc-log .ln { display: block; }
.mc-log .err { color: var(--dsw-alias-state-error-primary); }
.mc-log .warn { color: var(--dsw-alias-state-warn-primary); }
.mc-log .dim { color: var(--dsw-alias-label-secondary); }
.mc-foot { padding: 8px 12px 12px; display: flex; gap: 7px; }
.mc-modal-backdrop { position: absolute; inset: 0; z-index: 40; background: color-mix(in srgb, #000 30%, transparent); display: flex; align-items: center; justify-content: center; padding: 12px; animation: mcFade .12s ease; }
@keyframes mcFade { from { opacity: 0; } }
.mc-modal { width: 100%; max-height: calc(100% - 8px); display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 16px 50px rgba(0,0,0,.35); animation: mcRise .14s ease; overflow: hidden; }
@keyframes mcRise { from { transform: translateY(6px); opacity: .4; } }
.mc-modal-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mc-modal-head h3 { margin: 0; font-size: 13px; font-weight: 700; flex: 1; }
.mc-modal-body { padding: 11px 12px; display: flex; flex-direction: column; gap: 9px; overflow: auto; min-height: 0; }
.mc-modal-foot { display: flex; gap: 7px; justify-content: flex-end; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent); }
.mc-field { display: flex; flex-direction: column; gap: 4px; }
.mc-field > span { font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-weight: 600; }
.mc-input, .mc-select { width: 100%; height: 31px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none; }
.mc-input:focus, .mc-select:focus { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.mc-field-hint { font-size: 10px; color: var(--dsw-alias-label-secondary); line-height: 1.55; }
.mc-checkline { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; cursor: pointer; user-select: none; }
.mc-checkline input { margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }
.mc-ws-list { display: flex; flex-direction: column; gap: 4px; }
.mc-ws-item { display: flex; align-items: center; gap: 8px; padding: 8px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); font: inherit; color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.mc-ws-item:hover { border-color: var(--dsw-alias-border-l2); }
.mc-ws-item.on { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 52%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-1)); }
.mc-ws-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.mc-ws-item-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 5px; }
.mc-ws-item-path { font-size: 10px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-ws-item-meta { flex: none; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.mc-ws-item-meta.ok { color: var(--dsw-alias-state-success-primary); }
.mc-ws-item-meta.missing { color: var(--dsw-alias-state-warn-primary); }
.mc-setting-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.mc-setting-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mc-setting-row-main b { font-size: 12px; font-weight: 600; }
.mc-setting-row-main span { font-size: 10.5px; color: var(--dsw-alias-label-secondary); line-height: 1.55; }
.mc-action-list { display: flex; flex-direction: column; gap: 3px; }
.mc-action { display: flex; align-items: center; gap: 9px; padding: 9px; border: 0; border-radius: 9px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.mc-action:hover { background: var(--dsw-alias-bg-layer-2); }
.mc-action.danger { color: var(--dsw-alias-state-error-primary); }
.mc-action svg { flex: none; opacity: .85; }
.mc-action-sub { display: block; font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 1px; }
.mc-cand-list { display: flex; flex-direction: column; gap: 3px; max-height: 42vh; overflow: auto; }
.mc-cand { display: flex; align-items: center; gap: 8px; padding: 6px 7px; border: 1px solid transparent; border-radius: 8px; cursor: pointer; font-size: 11.5px; }
.mc-cand:hover { background: var(--dsw-alias-bg-layer-2); }
.mc-cand input { accent-color: var(--dsw-alias-brand-primary); margin: 0; }
.mc-cand-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; }
.mc-cand-src { font-size: 9.5px; color: var(--dsw-alias-label-secondary); flex: none; max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-toast { position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 60; display: flex; align-items: flex-start; gap: 7px; padding: 9px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); box-shadow: 0 8px 26px rgba(0,0,0,.28); font-size: 11.5px; animation: mcRise .16s ease; }
.mc-toast.error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-error-primary); }
.mc-toast.ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, var(--dsw-alias-border-l2)); }
.mc-toast.info { color: var(--dsw-alias-label-primary); }
.mc-toast svg { flex: none; margin-top: 1px; }
.mc-toast span { flex: 1; line-height: 1.5; }
.mc-headbtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mc-headbtn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.mc-mark-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.mc-mark-play { position: absolute; right: -2px; bottom: -2px; color: var(--dsw-alias-brand-primary); filter: drop-shadow(0 0 1.5px var(--dsw-alias-bg-base)); }
.mc-title .mc-mark-wrap { color: var(--dsw-alias-brand-primary); }
.mc-tabtitle { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.mc-tabtitle span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-fade-in { animation: mcFade .16s ease; }
.mc-hidden { display: none !important; }
@media (prefers-reduced-motion: reduce) {
  .mc-root *, .mc-root *::before, .mc-root *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;

    // ────────────────────────────────────────────────────────────── 组件

    /** 指南卡片自己带样式：它渲染在指南 slot 里，不随面板 tab 挂载。 */
    const GUIDE_CARD_CSS = `
.mc-guide-card { display: flex; gap: 14px; align-items: center; width: 380px; max-width: 100%; min-height: 56px; padding: 14px 20px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.mc-guide-card:hover { background: var(--dsw-alias-bg-layer-2); }
.mc-guide-icon { width: 26px; height: 26px; flex: none; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); }
.mc-guide-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.mc-guide-title { font-size: 14px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-guide-desc { font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

    function useToast() {
      const [toast, setToast] = useState(null);
      useEffect(() => {
        if (!toast) return undefined;
        const id = setTimeout(() => setToast(null), toast.tone === 'error' ? 6000 : 3800);
        return () => clearTimeout(id);
      }, [toast]);
      return [toast, setToast];
    }

    function Toast({ toast }) {
      if (!toast) return null;
      return h('div', { className: cx('mc-toast', toast.tone || 'info'), role: 'status', 'aria-live': 'polite' },
        toast.tone === 'error' ? h(IconAlert, { size: 14 }) : h(IconCheck, { size: 14 }),
        h('span', null, toast.text));
    }

    function Modal({ title, children, footer, onClose, wide, closeLabel = 'Close' }) {
      const dialogRef = useRef(null);
      const restoreRef = useRef(null);
      const closeRef = useRef(onClose);
      closeRef.current = onClose;
      useEffect(() => {
        restoreRef.current = document.activeElement;
        const node = dialogRef.current;
        const focusables = () => node
          ? [...node.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled)
          : [];
        if (node) {
          const first = focusables()[0];
          (first ?? node).focus();
        }
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); closeRef.current?.(); return; }
          if (event.key !== 'Tab') return;
          const list = focusables();
          if (list.length === 0) { event.preventDefault(); node?.focus(); return; }
          const first = list[0];
          const last = list[list.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          const previous = restoreRef.current;
          if (previous && typeof previous.focus === 'function') {
            try { previous.focus(); } catch { /* 触发元素可能已经卸载 */ }
          }
        };
        // 只在挂载/卸载时处理焦点；onClose 通过 closeRef 读取最新值。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return h('div', {
        className: 'mc-modal-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
      },
      h('div', {
        ref: dialogRef, tabIndex: -1,
        className: 'mc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
        style: wide ? { maxWidth: 460 } : undefined,
      },
      h('div', { className: 'mc-modal-head' },
        h('h3', null, title),
        h('button', { type: 'button', className: 'mc-iconbtn', title: closeLabel, 'aria-label': closeLabel, onClick: onClose }, h(IconClose, { size: 15 }))),
      h('div', { className: 'mc-modal-body' }, children),
      footer ? h('div', { className: 'mc-modal-foot' }, footer) : null));
    }

    function Switch({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button', className: 'mc-switch', role: 'switch', 'aria-checked': checked,
        'aria-label': label, title: label, disabled, onClick: onChange,
      });
    }

    // 这些组件在 apply() 内定义，闭包拿到 t 与 ctx。
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      const KIND_ID = TAB_ID;
      const launchStateLabel = (launch) => launch?.status === 'starting'
        ? t('instance.starting')
        : launch?.status === 'stopping'
          ? t('instance.stopping')
          : t('instance.running');

      const api = { state: apiState, action: apiAction };

      function markStyleFor(instance) {
        const loader = loaderOf(instance.loader);
        return { '--mc-accent': loader.accent, '--mc-accent-text': loader.strong };
      }

      function displayNameOf(instance) {
        return instance.name === '' ? (instance.project || instance.projectRelPath.split(/[\\/]/).pop()) : instance.name;
      }

      function instanceLabel(instance) {
        return `${instance.projectRelPath || instance.project || ''} › ${displayNameOf(instance)}`;
      }

      function openPanel(sessionId) {
        try {
          if (typeof ctx.sidebarRight.openTabIn === 'function') ctx.sidebarRight.openTabIn(sessionId, KIND);
          else ctx.sidebarRight.openTab(KIND);
        } catch (error) {
          console.error('[dsh-mc-instances] cannot open panel:', error);
        }
      }

      function copyText(text) {
        try {
          if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(text);
            return true;
          }
        } catch { /* fallthrough */ }
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
          return true;
        } catch {
          return false;
        }
      }

      function PanelHeader({ data, workspace, onRefresh, onWorkspace, onSettings, busy }) {
        const wsRoot = (data?.roots || []).find((r) => r.path.toLowerCase() === String(workspace || '').toLowerCase());
        return h('div', { className: 'mc-head' },
          h('div', { className: 'mc-head-row' },
            h('h1', { className: 'mc-title' },
              h(GrassMark, { size: 20 }),
              h('span', null, t('header.title')),
              data ? h('span', { className: 'mc-count' }, t('header.count', { count: data.instances.length })) : null),
            h('div', { className: 'mc-head-actions' },
              h('button', {
                type: 'button', className: 'mc-iconbtn', title: t('settings.title'), 'aria-label': t('settings.title'),
                onClick: onSettings,
              }, h(IconSettings, { size: 15 })),
              h('button', {
                type: 'button', className: 'mc-iconbtn', title: t('header.refresh'), 'aria-label': t('header.refresh'),
                onClick: onRefresh, disabled: busy,
              }, h(IconRefresh, { size: 15 })))),
          h('button', {
            type: 'button', className: 'mc-ws', onClick: onWorkspace, title: t('header.switchWorkspace'),
          },
          h('span', { className: 'mc-ws-ico' }, h(IconFolder, { size: 14 })),
          h('span', { className: 'mc-ws-text' },
            h('span', { className: 'mc-ws-name' }, wsRoot?.title || data?.workspaceTitle || t('misc.loading')),
            h('span', { className: 'mc-ws-path' }, workspace || data?.workspace || '')),
          h('span', { className: 'mc-ws-chev' }, h(IconChevron, { size: 13 }))));
      }

      function InstanceCard({ instance, launch, latest, busy, onOpen, onLaunch, onStop, onMore }) {
        const active = isActiveLaunch(launch);
        const title = displayNameOf(instance);
        const mods = instance.mods?.length ?? 0;
        const enabled = instance.enabledModCount ?? instance.mods?.filter((m) => m.enabled).length ?? 0;
        const last = instance.lastActivity || instance.gameLog?.updatedAt;
        const ended = !active && latest && latest.endedAt && (Date.now() - Date.parse(latest.endedAt) < 15 * 60 * 1000) ? latest : null;
        const endedLabel = ended ? (ended.status === 'failed' ? t('instance.failed') : ended.status === 'stopped' ? t('instance.stopped') : t('instance.exited')) : '';
        return h('article', {
          className: cx('mc-card', active && 'running'),
          style: markStyleFor(instance),
          role: 'button', tabIndex: 0,
          onClick: onOpen,
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } },
          'aria-label': instanceLabel(instance),
        },
        h('div', { className: 'mc-card-icon' }, h(GrassMark, { size: 28 })),
        h('div', { className: 'mc-card-body' },
          h('div', { className: 'mc-card-top' },
            h('span', { className: 'mc-name', title }, title),
            instance.name === '' ? h('span', { className: 'mc-default-tag' }, t('instance.default')) : null),
          h('div', { className: 'mc-sub', title: instance.projectRelPath }, instance.runConfigName),
          h('div', { className: 'mc-badges' },
            h('span', { className: 'mc-badge loader' }, h('i', { className: 'mc-dot' }), loaderLabelOf(instance.loader)),
            h('span', { className: 'mc-badge' }, instance.mcVersion || t('instance.unknownVersion')),
            instance.java ? h('span', { className: 'mc-badge' }, t('instance.jdk', { version: instance.java })) : null,
            h('span', { className: 'mc-badge' }, mods > 0 ? t('instance.mods', { enabled, total: mods }) : t('instance.modsEmpty'))),
          h('div', { className: 'mc-card-foot' },
            h('span', null, `${t('instance.lastActivity')} · ${fmtRelative(last, t)}`),
            h('span', { className: 'spacer' }),
            active ? h('span', { className: 'mc-running' },
              h('i', { className: 'mc-pulse' }),
              `${launchStateLabel(launch)} ${launch.status === 'running' ? fmtDuration((Date.now() - launch.startedAtMs)) : ''}`)
              : ended ? h('span', { className: cx('mc-ended', ended.status === 'failed' && 'err') }, endedLabel) : null)),
        h('div', { className: 'mc-card-side', onClick: (event) => event.stopPropagation() },
          active
            ? h('button', {
              type: 'button', className: 'mc-btn small mc-stop', disabled: busy || launch.status === 'stopping',
              title: t('instance.stop'), onClick: onStop,
            }, h(IconStop, { size: 11 }), launch.status === 'stopping' ? t('instance.stopping') : t('instance.stop'))
            : h('button', {
              type: 'button', className: cx('mc-btn small', 'primary'), disabled: busy,
              title: t('instance.launch'), onClick: onLaunch,
            }, h(IconPlay, { size: 11 }), t('instance.launch')),
          h('button', {
            type: 'button', className: 'mc-iconbtn', title: t('instance.more'), 'aria-label': t('instance.more'),
            onClick: onMore,
          }, h(IconMore, { size: 15 }))));
      }

      function DetailView(props) {
        const {
          instance, launch, latest, busy, tab, setTab, onBack, onLaunch, onStop, onMore,
          onOpenFolder, onOpenLogs, onIde, onReload, modQuery, setModQuery,
          pendingMod, onToggle, onOnly, onRemove, onImport, toast,
        } = props;
        const mods = instance.mods || [];
        const enabled = mods.filter((m) => m.enabled).length;
        const active = isActiveLaunch(launch);
        const extras = instance.extras || {};
        const [logKind, setLogKind] = useState(latest?.status === 'failed' ? 'launch' : 'game');
        const [logAuto, setLogAuto] = useState(true);
        const [log, setLog] = useState(null);
        const [logBusy, setLogBusy] = useState(false);
        const logRef = useRef(null);
        const followRef = useRef(true);
        const launchIdRef = useRef(null);
        const activeLaunchId = launch?.id ?? launchIdRef.current;
        if (launch?.id) launchIdRef.current = launch.id;
        const filteredMods = useMemo(() => {
          const q = modQuery.trim().toLowerCase();
          if (q === '') return mods;
          return mods.filter((m) => m.fileName.toLowerCase().includes(q));
        }, [mods, modQuery]);

        useEffect(() => {
          if (tab !== 'logs') return undefined;
          let alive = true;
          const fetchLog = async () => {
            setLogBusy(true);
            try {
              const data = await api.action({
                op: 'log', workspace: instance.workspace, instanceId: idOf(instance), runConfigName: instance.runConfigName,
                kind: logKind, tail: 220, launchId: logKind === 'launch' ? activeLaunchId : undefined,
                side: launch?.side,
              });
              if (alive) setLog(data);
            } catch (error) {
              if (alive) setLog({ exists: false, text: '', error: error.message });
            } finally {
              if (alive) setLogBusy(false);
            }
          };
          void fetchLog();
          let timer = null;
          if (logAuto) timer = setInterval(fetchLog, 2000);
          return () => { alive = false; if (timer) clearInterval(timer); };
        }, [tab, logKind, logAuto, idOf(instance), instance.workspace, activeLaunchId, launch?.side]);

        useEffect(() => {
          if (tab !== 'logs' || !logAuto || !followRef.current || !logRef.current) return;
          logRef.current.scrollTop = logRef.current.scrollHeight;
        }, [log?.text, tab, logAuto, logKind]);

        useEffect(() => { followRef.current = true; }, [logKind]);

        return h('div', { className: 'mc-detail mc-fade-in' },
          h('div', { className: 'mc-detail-top' },
            h('button', { type: 'button', className: 'mc-iconbtn', title: t('detail.back'), 'aria-label': t('detail.back'), onClick: onBack }, h(IconBack, { size: 15 })),
            h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, t('detail.title')),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', className: 'mc-iconbtn', title: t('header.refresh'), 'aria-label': t('header.refresh'), onClick: onReload }, h(IconRefresh, { size: 14 }))),
          h('div', { className: 'mc-detail-hero', style: markStyleFor(instance) },
            h('div', { className: 'mc-detail-icon' }, h(GrassMark, { size: 38 })),
            h('div', { className: 'mc-detail-title' },
              h('h2', null, displayNameOf(instance), instance.name === '' ? h('span', { className: 'mc-default-tag' }, t('instance.default')) : null),
              h('div', { className: 'mc-detail-sub' }, `${instanceLabel(instance)} · ${instance.runConfigName}`),
              instance.exists === false ? h('div', { className: 'mc-field-hint', style: { marginTop: 3 } }, t('instance.notCreated')) : null,
              h('div', { className: 'mc-badges', style: { marginTop: 5 } },
                h('span', { className: 'mc-badge loader' }, h('i', { className: 'mc-dot' }), loaderLabelOf(instance.loader)),
                h('span', { className: 'mc-badge' }, instance.mcVersion || t('instance.unknownVersion')),
                instance.java ? h('span', { className: 'mc-badge' }, t('instance.jdk', { version: instance.java })) : null,
                h('span', { className: 'mc-badge' }, t('instance.mods', { enabled, total: mods.length }))))),
          h('div', { className: 'mc-actions-row' },
            active
              ? h('button', { type: 'button', className: 'mc-btn mc-stop', disabled: busy || launch.status === 'stopping', onClick: onStop }, h(IconStop, { size: 12 }), launch.status === 'stopping' ? t('instance.stopping') : t('instance.stop'))
              : h('button', { type: 'button', className: 'mc-btn primary', disabled: busy, onClick: onLaunch }, h(IconPlay, { size: 12 }), t('instance.launch')),
            h('button', { type: 'button', className: 'mc-btn', onClick: onOpenFolder }, h(IconFolder, { size: 12 }), t('instance.openFolder')),
            h('button', { type: 'button', className: 'mc-btn', onClick: onMore }, h(IconMore, { size: 12 }), t('instance.more'))),
          active ? h('div', { style: { padding: '0 12px 8px', fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } },
            h('span', { className: 'mc-running' }, h('i', { className: 'mc-pulse' }), `${launchStateLabel(launch)} · ${fmtDuration(Date.now() - launch.startedAtMs)}`),
            launch.pid ? ` · PID ${launch.pid}` : '') : null,
          !active && latest && latest.endedAt && (Date.now() - Date.parse(latest.endedAt) < 15 * 60 * 1000) ? h('div', { className: cx('mc-fail-banner', latest.status === 'failed' && 'err') },
            h(IconAlert, { size: 13 }),
            h('span', null, `${t('instance.lastLaunch')} · ${latest.status === 'failed' ? t('instance.failed') : latest.status === 'stopped' ? t('instance.stopped') : t('instance.exited')}${latest.exitCode !== null && latest.exitCode !== undefined ? ` (${latest.exitCode})` : ''}`),
            h('button', {
              type: 'button', className: 'mc-btn small',
              onClick: () => { setLogKind('launch'); setTab('logs'); },
            }, t('instance.viewLaunchLog'))) : null,
          h('div', { className: 'mc-stats' },
            h('div', { className: 'mc-stat' }, h('b', null, String(extras.saves ?? 0)), h('span', null, t('detail.saves'))),
            h('div', { className: 'mc-stat' }, h('b', null, String(extras.screenshots ?? 0)), h('span', null, t('detail.screenshots'))),
            h('div', { className: 'mc-stat' }, h('b', null, String(extras.crashReports ?? 0)), h('span', null, t('detail.crashes'))),
            h('div', { className: 'mc-stat' }, h('b', { style: { fontSize: 11 } }, fmtRelative(instance.lastActivity || instance.gameLog?.updatedAt, t)), h('span', null, t('instance.lastActivity')))),
          h('div', { className: 'mc-tabs', role: 'tablist' },
            h('button', { type: 'button', className: cx('mc-tab', tab === 'overview' && 'on'), role: 'tab', 'aria-selected': tab === 'overview', onClick: () => setTab('overview') }, t('detail.overview')),
            h('button', { type: 'button', className: cx('mc-tab', tab === 'mods' && 'on'), role: 'tab', 'aria-selected': tab === 'mods', onClick: () => setTab('mods') }, t('detail.mods'), h('span', { className: 'mc-tab-count' }, String(mods.length))),
            h('button', { type: 'button', className: cx('mc-tab', tab === 'logs' && 'on'), role: 'tab', 'aria-selected': tab === 'logs', onClick: () => setTab('logs') }, t('detail.logs'))),
          tab === 'overview' ? h('div', { className: 'mc-section' },
            h('div', { className: 'mc-panel' },
              h('div', { className: 'mc-rows' },
                row(t('detail.instanceName'), instance.name === '' ? t('instance.default') : instance.name),
                row(t('detail.runConfig'), instance.runConfigName),
                row(t('detail.gameDir'), instance.gameDir),
                row(t('detail.autoSynced'), instance.autoSyncedMods?.length ? instance.autoSyncedMods.join(', ') : '—'))),
            active ? h('div', { className: 'mc-panel' },
              h('div', { className: 'mc-panel-head' }, h(IconTerminal, { size: 13 }), t('detail.launchInfo')),
              h('div', { className: 'mc-rows' },
                row(t('detail.pid'), String(launch.pid ?? '—')),
                row(t('detail.startedAt'), fmtTime(launch.startedAt)),
                row(t('detail.javaHome'), launch.javaHome || t('detail.systemPath')))) : null,
            Object.keys(extras.options || {}).length > 0 ? h('div', { className: 'mc-panel' },
              h('div', { className: 'mc-panel-head' }, h(IconBox, { size: 13 }), t('detail.options')),
              h('div', { className: 'mc-rows' },
                Object.entries(extras.options).map(([key, value]) => row(optionLabel(key), String(value), key)))) : null,
            extras.latestCrash ? h('div', { className: 'mc-panel' },
              h('div', { className: 'mc-panel-head mc-warn' }, h(IconAlert, { size: 13 }), t('detail.latestCrash')),
              h('div', { className: 'mc-rows' },
                row(t('detail.crashes'), extras.latestCrash.name),
                row(t('detail.crashedAt'), fmtTime(extras.latestCrash.modifiedAt))),
              h('div', { className: 'mc-foot' },
                h('button', {
                  type: 'button', className: 'mc-btn small',
                  onClick: () => onOpenLogs(crashPath(instance, extras.latestCrash.name), true),
                }, h(IconFolder, { size: 12 }), t('logs.open')))) : null,
            h('div', { className: 'mc-hint' }, t('detail.deleteHint')))
          : tab === 'mods' ? h(ModsTab, {
            instance, mods, filteredMods, modQuery, setModQuery, enabled,
            pendingMod, onToggle, onOnly, onRemove,
            onImport,
            onlyLabel: t('mods.only'), removeLabel: t('mods.remove'), searchPlaceholder: t('mods.search'),
            empty: t('mods.empty'), emptyHint: t('mods.emptyHint'), importLabel: t('mods.import'),
            enabledLabel: t('mods.enabled'), disabledLabel: t('mods.disabled'),
          })
          : h(LogsTab, {
            instance, log, logBusy, logKind, setLogKind, logAuto, setLogAuto, logRef,
            activeLaunchId, launch,
            onScroll: (event) => {
              const el = event.currentTarget;
              followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            },
            onOpen: onOpenLogs,
            onCopy: () => { if (log?.path && copyText(log.path)) toast({ tone: 'ok', text: t('toast.copied') }); },
          }));
      }

      function row(key, value, id) {
        return h('div', { className: 'mc-row', key: id ?? key }, h('span', { className: 'mc-row-k' }, key), h('span', { className: 'mc-row-v', title: String(value ?? '') }, String(value ?? '—')));
      }

      function optionLabel(key) {
        const translated = t(`option.${key}`);
        return translated === `option.${key}` ? key : translated;
      }

      function crashPath(instance, name) {
        const sep = /[\\/]/.test(instance.gameDir) ? (instance.gameDir.includes('\\') ? '\\' : '/') : '/';
        return `${instance.gameDir}${sep}crash-reports${sep}${name}`;
      }

      function ModsTab(props) {
        const [confirming, setConfirming] = useState(null);
        return h('div', { className: 'mc-fade-in' },
          h('div', { className: 'mc-mods-tools' },
            h('div', { className: 'mc-search' },
              h(IconSearch, { size: 13 }),
              h('input', {
                value: props.modQuery, placeholder: props.searchPlaceholder, 'aria-label': props.searchPlaceholder,
                onChange: (event) => props.setModQuery(event.target.value),
              }),
              props.modQuery ? h('button', { type: 'button', className: 'mc-search-clear', onClick: () => props.setModQuery(''), 'aria-label': t('misc.clear'), title: t('misc.clear') }, h(IconClose, { size: 12 })) : null),
            h('button', { type: 'button', className: 'mc-btn small', onClick: props.onImport }, h(IconPlus, { size: 12 }), props.importLabel)),
          props.mods.length === 0 ? h('div', { className: 'mc-empty' },
            h('div', { className: 'mc-empty-mark' }, h(IconMod, { size: 28 })),
            h('h3', null, props.empty),
            h('p', null, props.emptyHint),
            h('div', { className: 'mc-empty-actions' },
              h('button', { type: 'button', className: 'mc-btn primary', onClick: props.onImport }, h(IconPlus, { size: 12 }), props.importLabel)))
            : h('div', { className: 'mc-mod-list' }, props.filteredMods.map((mod) => h('div', { className: cx('mc-mod', !mod.enabled && 'off'), key: mod.fileName },
              h('span', { className: 'mc-mod-name', title: mod.fileName }, mod.fileName),
              h('span', { className: 'mc-mod-size' }, fmtBytes(mod.sizeBytes)),
              h('span', { className: 'mc-mod-actions' },
                confirming === mod.fileName
                  ? [
                    h('button', {
                      key: 'cancel', type: 'button', className: 'mc-only', style: { opacity: 1 },
                      onClick: () => setConfirming(null),
                    }, t('misc.cancel')),
                    h('button', {
                      key: 'delete', type: 'button', className: 'mc-only', style: { opacity: 1, color: 'var(--dsw-alias-state-error-primary)' },
                      onClick: () => { setConfirming(null); props.onRemove(mod); },
                    }, t('misc.delete')),
                  ]
                  : [
                    h('button', {
                      key: 'only', type: 'button', className: 'mc-only', title: props.onlyLabel,
                      onClick: () => props.onOnly(mod), disabled: props.pendingMod === mod.fileName,
                    }, props.onlyLabel),
                    h('button', {
                      key: 'remove', type: 'button', className: 'mc-only', title: props.removeLabel, style: { color: 'var(--dsw-alias-state-error-primary)' },
                      onClick: () => setConfirming(mod.fileName), disabled: props.pendingMod === mod.fileName,
                    }, '×'),
                  ]),
              h(Switch, {
                checked: !!mod.enabled, disabled: props.pendingMod === mod.fileName,
                label: `${mod.fileName} · ${mod.enabled ? props.enabledLabel : props.disabledLabel}`,
                onChange: () => props.onToggle(mod, !mod.enabled),
              })))),
          props.filteredMods.length === 0 && props.mods.length > 0 ? h('div', { className: 'mc-empty' }, h('p', null, t('mods.noMatch'))) : null,
          props.mods.length > 0 ? h('div', { className: 'mc-hint' }, t('mods.restartHint')) : null);
      }

      function LogsTab(props) {
        const lines = useMemo(() => {
          const text = props.log?.text ?? '';
          if (text === '') return [];
          return text.split(/\r?\n/).slice(-400);
        }, [props.log?.text]);
        const toneOf = (line) => {
          const low = line.toLowerCase();
          if (/\b(error|exception|fatal|crash|caused by)\b/.test(low)) return 'err';
          if (/\b(warn|warning|deprecated)\b/.test(low)) return 'warn';
          if (/^\s*$/.test(line)) return 'dim';
          return '';
        };
        return h('div', { className: 'mc-fade-in' },
          h('div', { className: 'mc-logbar' },
            h('div', { className: 'mc-seg', role: 'tablist' },
              h('button', { type: 'button', role: 'tab', className: props.logKind === 'game' ? 'on' : '', onClick: () => props.setLogKind('game') }, t('logs.kindGame')),
              h('button', { type: 'button', role: 'tab', className: props.logKind === 'launch' ? 'on' : '', onClick: () => props.setLogKind('launch') }, t('logs.kindLaunch'))),
            h('label', { className: 'mc-check' },
              h('input', { type: 'checkbox', checked: props.logAuto, onChange: (event) => props.setLogAuto(event.target.checked) }),
              t('logs.auto')),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', className: 'mc-iconbtn', title: t('logs.copy'), 'aria-label': t('logs.copy'), onClick: props.onCopy }, h(IconDoc, { size: 14 })),
            h('button', { type: 'button', className: 'mc-iconbtn', title: t('logs.open'), 'aria-label': t('logs.open'), onClick: () => props.log?.path && props.onOpen(props.log.path, true) }, h(IconFolder, { size: 14 }))),
          h('div', { className: 'mc-log-info' },
            props.log?.path ? h('code', { title: props.log.path }, props.log.path) : null,
            props.log?.updatedAt ? h('span', null, t('logs.updated', { time: fmtTime(props.log.updatedAt) })) : null,
            props.log?.exists === false && !props.log?.error ? h('span', null, t('logs.empty')) : null,
            props.logBusy && !props.log ? h('span', null, t('logs.loading')) : null),
          props.log?.error ? h('div', { className: 'mc-error' }, h('strong', null, h(IconAlert, { size: 13 }), t('logs.readFailed')), h('span', null, props.log.error)) : null,
          props.log?.exists === false && !props.log?.error ? h('div', { className: 'mc-hint' }, t('logs.empty'))
            : h('pre', { className: 'mc-log', ref: props.logRef, onScroll: props.onScroll },
              lines.map((line, index) => h('span', { key: index, className: cx('ln', toneOf(line)) }, line === '' ? ' ' : line))),
          h('div', { className: 'mc-hint' }, t('logs.followHint')));
      }

      // 顶层面板：状态编排都在这里。
      function Panel(props) {
        const sessionId = props.sessionId;
        const useWorkspaces = props.useWorkspaces ?? noWorkspaces;
        const workspaceItems = useWorkspaces((state) => state.items) ?? [];
        const workspacePhase = useWorkspaces((state) => state.phase);
        const [workspace, setWorkspace] = useState(null);
        const [data, setData] = useState(null);
        const [roots, setRoots] = useState([]);
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState(null);
        const [query, setQuery] = useState('');
        const [filter, setFilter] = useState('all');
        const [selected, setSelected] = useState(null);
        const [launches, setLaunches] = useState([]);
        const [busy, setBusy] = useState(null);
        const [modal, setModal] = useState(null);
        const [toast, setToast] = useToast();
        const [autoHide, setAutoHide] = useAutoHideSetting();
        const autoHideRef = useRef(autoHide);
        autoHideRef.current = autoHide;
        const [, setTick] = useState(0);
        const manualRef = useRef(false);
        const autoTriedRef = useRef(false);
        const [detail, setDetail] = useState(null);
        const [detailTab, setDetailTab] = useState('overview');
        const [candidates, setCandidates] = useState(null);
        const [candidateQuery, setCandidateQuery] = useState('');
        const [pickedCandidates, setPickedCandidates] = useState([]);
        const [deleteConfirm, setDeleteConfirm] = useState('');
        const [collapsedGroups, setCollapsedGroups] = useState({});

        const toastOk = (text) => setToast({ tone: 'ok', text });
        const toastError = (text) => setToast({ tone: 'error', text });

        // 当前会话所属的工作区（由 Workspace Controller 的 snapshot 给出）。
        const sessionWorkspace = useMemo(() => {
          const owner = workspaceItems.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
          return owner?.path ?? null;
        }, [workspaceItems, sessionId]);

        // 等 Workspace snapshot 就绪后再决定初始工作区；5 秒都没就绪则交给宿主默认值。
        useEffect(() => {
          if (manualRef.current || workspace !== null) return undefined;
          if (workspacePhase === 'ready') {
            setWorkspace(sessionWorkspace ?? '');
            return undefined;
          }
          const timer = setTimeout(() => {
            if (!manualRef.current && workspacePhase !== 'ready') setWorkspace(sessionWorkspace ?? '');
          }, 5000);
          return () => clearTimeout(timer);
        }, [workspacePhase, sessionWorkspace, workspace]);

        const load = useCallback(async (ws, { silent = false } = {}) => {
          if (!silent) setLoading(true);
          setError(null);
          try {
            const state = await apiState(ws ?? '', true);
            setData(state);
            setRoots(state.roots || []);
            setLaunches(state.launches || []);
            if (!ws) setWorkspace(state.workspace);
            // 自动隐藏开启时不再擅自切到别的已注册工作区——其它项目的工作区里不打扰。
            if (!manualRef.current && !autoHideRef.current && !autoTriedRef.current && state.detected === false) {
              const others = (state.roots || []).filter((r) => r.exists && r.projectCount > 0 && r.path.toLowerCase() !== state.workspace.toLowerCase());
              autoTriedRef.current = true;
              if (others.length === 1) {
                setToast({ tone: 'info', text: t('notice.autoSwitch', { name: others[0].title }) });
                setWorkspace(others[0].path);
                return;
              }
            }
            if (autoTriedRef.current === false) autoTriedRef.current = true;
          } catch (err) {
            setError(err.message);
          } finally {
            if (!silent) setLoading(false);
          }
        }, []);

        useEffect(() => {
          if (workspace === null) return undefined;
          void load(workspace);
          return undefined;
        }, [workspace, load]);

        // 启动状态轮询（面板打开期间）。
        useEffect(() => {
          if (workspace === null) return undefined;
          let alive = true;
          const tickLaunches = async () => {
            try {
              const res = await apiAction({ op: 'launches', workspace: workspace || '' });
              if (alive) setLaunches(res.launches || []);
            } catch { /* 面板重连后自动恢复 */ }
          };
          const id = setInterval(tickLaunches, 3000);
          return () => { alive = false; clearInterval(id); };
        }, [workspace]);

        // 有运行中的实例时，每秒刷新运行时显示。
        useEffect(() => {
          const active = launches.some((l) => isActiveLaunch(l));
          if (!active) return undefined;
          const id = setInterval(() => setTick((n) => n + 1), 1000);
          return () => clearInterval(id);
        }, [launches]);

        useEffect(() => {
          if (!selected) { setDetail(null); setDetailTab('overview'); return undefined; }
          let alive = true;
          setDetail(null);
          (async () => {
            try {
              const res = await apiAction({ op: 'instance', workspace: workspace || '', instanceId: selected });
              if (alive) setDetail(res.instance);
            } catch (err) {
              if (alive) toastError(err.message);
            }
          })();
          return () => { alive = false; };
        }, [selected, workspace]);

        useEffect(() => {
          if (modal?.kind !== 'import') return undefined;
          if (candidates !== null) return undefined;
          let alive = true;
          (async () => {
            try {
              const res = await apiAction({ op: 'mods', action: 'candidates', workspace: workspace || '', instanceId: selected, mods: [] });
              if (alive) setCandidates(res.candidates || []);
            } catch (err) {
              if (alive) { setCandidates([]); toastError(err.message); }
            }
          })();
          return () => { alive = false; };
        }, [modal]);

        const instanceList = data?.instances ?? [];
        const selectedInstance = detail ?? instanceList.find((item) => idOf(item) === selected) ?? null;
        const launchOf = (key) => launches.find((l) => isActiveLaunch(l) && (idOf(l) === key || l.runConfigName === key)) ?? null;
        const latestLaunchOf = (key) => launches.find((l) => idOf(l) === key || l.runConfigName === key) ?? null;
        const latest = selected ? latestLaunchOf(selected) : null;
        const activeLaunch = selected ? launchOf(selected) : null;
        const sepOf = (value) => (String(value).includes('\\') ? '\\' : '/');
        const folderOf = (instance) => (instance.exists === false && instance.projectDir ? instance.projectDir : instance.gameDir);
        const logsFolderOf = (instance) => (instance.exists === false ? folderOf(instance) : `${String(folderOf(instance)).replace(/[\\/]$/u, '')}${sepOf(folderOf(instance))}logs`);

        const counts = useMemo(() => {
          const map = { all: instanceList.length, fabric: 0, neoforge: 0, forge: 0, unknown: 0, running: 0 };
          for (const item of instanceList) {
            const key = item.loader in map ? item.loader : 'unknown';
            map[key] = (map[key] || 0) + 1;
            if (launchOf(idOf(item))) map.running += 1;
          }
          return map;
        }, [instanceList, launches]);

        const filtered = useMemo(() => {
          const q = query.trim().toLowerCase();
          return instanceList.filter((item) => {
            if (filter === 'running' && !launchOf(idOf(item))) return false;
            if (filter !== 'all' && filter !== 'running' && item.loader !== filter) return false;
            if (q === '') return true;
            const hay = [idOf(item), item.runConfigName, item.name, item.projectRelPath, item.project, item.mcVersion, item.loader].join(' ').toLowerCase();
            return hay.includes(q);
          });
        }, [instanceList, query, filter, launches]);

        const grouped = useMemo(() => {
          const map = new Map();
          for (const item of filtered) {
            const key = item.projectRelPath || item.project || '';
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(item);
          }
          return [...map.entries()];
        }, [filtered]);

        const busyKey = (suffix) => busy === suffix;

        const labelOf = (instance) => `${instance.projectRelPath} › ${displayNameOf(instance)}`;

        const doLaunch = async (instance, side = 'client') => {
          setBusy(`launch:${idOf(instance)}`);
          try {
            const res = await apiAction({ op: 'launch', workspace: workspace || '', instanceId: idOf(instance), runConfigName: instance.runConfigName, side });
            setLaunches((prev) => [res.launch, ...prev.filter((l) => l.id !== res.launch.id)]);
            if (selected === idOf(instance)) setDetail(res.instance);
            const name = side === 'server' ? `${labelOf(instance)}（${t('instance.server')}）` : labelOf(instance);
            toastOk(t('toast.launched', { name, pid: res.launch.pid }));
          } catch (err) {
            toastError(t('toast.launchFailed', { message: err.message }));
          } finally {
            setBusy(null);
          }
        };

        const doStop = async (instance, launch) => {
          setBusy(`stop:${idOf(instance)}`);
          try {
            const res = await apiAction({ op: 'stop', workspace: workspace || '', launchId: launch.id });
            setLaunches((prev) => prev.map((l) => l.id === res.launch.id ? res.launch : l));
            toastOk(res.launch.status === 'stopping' ? t('toast.stopping', { name: labelOf(instance) }) : t('toast.stopped', { name: labelOf(instance) }));
          } catch (err) {
            toastError(err.message);
          } finally {
            setBusy(null);
          }
        };

        const doOpen = async (path, reveal) => {
          try {
            await apiAction({ op: 'open', workspace: workspace || '', path, reveal: !!reveal });
            toastOk(t('toast.opened'));
          } catch (err) {
            toastError(err.message);
          }
        };

        const doIde = async (instance) => {
          setBusy(`ide:${idOf(instance)}`);
          try {
            const res = await apiAction({ op: 'ide', workspace: workspace || '', project: instance.projectRelPath || instance.project });
            toastOk(t('toast.ide', { count: res.written?.length ?? 0 }));
          } catch (err) {
            toastError(err.message);
          } finally {
            setBusy(null);
          }
        };

        const openDetail = (instance) => { setSelected(idOf(instance)); setDetail(instance); setDetailTab('overview'); };
        const closeDetail = () => { setSelected(null); setDetail(null); };

        const refresh = () => { autoTriedRef.current = true; void load(workspace, { silent: false }); };

        const applyModsChanged = (mods) => {
          const enabled = mods.filter((m) => m.enabled).length;
          setDetail((prev) => prev ? { ...prev, mods, enabledModCount: enabled } : prev);
          setData((prev) => prev ? {
            ...prev,
            instances: prev.instances.map((item) => idOf(item) === selected
              ? { ...item, mods, enabledModCount: enabled }
              : item),
          } : prev);
        };

        const pickWorkspace = async () => {
          try {
            const uiWorkspace = ctx.get('uiWorkspace');
            if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') throw new Error(t('error.noDirectoryPicker'));
            const picked = await uiWorkspace.pickDirectory();
            if (!picked) return;
            manualRef.current = true;
            autoTriedRef.current = true;
            setWindowWorkspace(picked);
          } catch (err) {
            toastError(err.message);
          }
        };

        const setWindowWorkspace = (path) => {
          manualRef.current = true;
          autoTriedRef.current = true;
          setSelected(null);
          setDetail(null);
          setData(null);
          setLaunches([]);
          setError(null);
          setLoading(true);
          setWorkspace(path);
          setModal(null);
        };

        const selectWorkspace = (path) => {
          setWindowWorkspace(path);
        };

        // 新建实例
        const initialCreate = () => {
          const allProjects = data?.projects ?? [];
          const supported = allProjects.filter((p) => p.supportsInstance);
          const projects = supported.length > 0 ? supported : allProjects;
          const first = projects[0];
          setModal({
            kind: 'create',
            project: first?.relPath ?? '',
            name: '',
            copyOptions: true,
            copyFrom: '',
            writeIde: true,
            submitting: false,
            error: '',
          });
        };

        const submitCreate = async () => {
          if (!modal || modal.kind !== 'create') return;
          const name = modal.name.trim();
          if (name === '') { setModal({ ...modal, error: t('create.invalid') }); return; }
          setModal({ ...modal, submitting: true, error: '' });
          try {
            const res = await apiAction({
              op: 'create', workspace: workspace || '',
              project: modal.project, instance: name,
              copyOptions: modal.copyOptions, copyFrom: modal.copyFrom || '', writeIde: modal.writeIde,
            });
            setModal(null);
            toastOk(t('toast.created', { name: labelOf(res.instance) }));
            await load(workspace, { silent: true });
            setSelected(idOf(res.instance));
            setDetail(res.instance);
            setDetailTab('overview');
          } catch (err) {
            setModal({ ...modal, submitting: false, error: err.message });
          }
        };

        const submitDelete = async () => {
          if (!modal || modal.kind !== 'delete' || !selectedInstance) return;
          const expected = selectedInstance.name;
          if (deleteConfirm !== expected) return;
          setModal({ ...modal, submitting: true, error: '' });
          try {
            await apiAction({ op: 'delete', workspace: workspace || '', instanceId: idOf(selectedInstance), runConfigName: selectedInstance.runConfigName, confirm: true });
            setModal(null);
            setDeleteConfirm('');
            setSelected(null);
            setDetail(null);
            toastOk(t('toast.deleted', { name: labelOf(selectedInstance) }));
            await load(workspace, { silent: true });
          } catch (err) {
            setModal({ ...modal, submitting: false, error: err.message });
          }
        };

        // mod 操作（详情页 / 导入）
        const modsRequest = async (action, names, paths) => {
          const res = await apiAction({
            op: 'mods', action, workspace: workspace || '', instanceId: selected, mods: names, paths,
          });
          if (res.mods) {
            const enabled = res.mods.filter((m) => m.enabled).length;
            setDetail((prev) => prev ? { ...prev, mods: res.mods, enabledModCount: enabled } : prev);
            setData((prev) => prev ? {
              ...prev,
              instances: prev.instances.map((item) => idOf(item) === selected
                ? { ...item, mods: res.mods, enabledModCount: enabled }
                : item),
            } : prev);
          }
          return res;
        };

        const toggleMod = async (mod, next) => {
          try {
            await modsRequest(next ? 'enable' : 'disable', [mod.fileName]);
            toastOk(t(next ? 'toast.toggledOn' : 'toast.toggledOff', { name: mod.fileName }));
          } catch (err) { toastError(err.message); }
        };
        const onlyMod = async (mod) => {
          try {
            await modsRequest('only', [mod.fileName]);
            toastOk(t('toast.only', { name: mod.fileName }));
          } catch (err) { toastError(err.message); }
        };
        const removeMod = async (mod) => {
          try {
            await modsRequest('remove', [mod.fileName]);
            toastOk(t('toast.deleted', { name: mod.fileName }));
          } catch (err) { toastError(err.message); }
        };
        const submitImport = async (paths) => {
          if (paths.length === 0) return;
          setBusy('import');
          try {
            await modsRequest('import', [], paths);
            setModal(null);
            setPickedCandidates([]);
            setCandidateQuery('');
            setCandidates(null);
            toastOk(t('toast.imported', { count: paths.length }));
          } catch (err) {
            toastError(err.message);
          } finally {
            setBusy(null);
          }
        };

        const openActions = (instanceId) => {
          const instance = instanceList.find((item) => idOf(item) === instanceId);
          if (!instance) return;
          setModal({ kind: 'actions', instance });
        };

        const detailActions = (instance) => {
          if (!instance) return;
          const instanceActive = !!launchOf(idOf(instance));
          return h('div', { className: 'mc-action-list' },
            instanceActive ? h('button', {
              type: 'button', className: 'mc-action danger',
              onClick: () => { setModal(null); const current = launchOf(idOf(instance)); if (current) void doStop(instance, current); },
            }, h(IconStop, { size: 15 }), t('instance.stop'))
              : h('button', { type: 'button', className: 'mc-action', onClick: () => { setModal(null); void doLaunch(instance, 'client'); } },
                h(IconPlay, { size: 15 }), t('instance.launch')),
            h('button', { type: 'button', className: 'mc-action', disabled: instanceActive, onClick: () => { setModal(null); void doLaunch(instance, 'server'); } },
              h(IconTerminal, { size: 15 }), t('instance.launchServer')),
            h('button', { type: 'button', className: 'mc-action', onClick: () => { setModal(null); void doOpen(folderOf(instance), false); } },
              h(IconFolder, { size: 15 }), t('instance.openFolder')),
            h('button', { type: 'button', className: 'mc-action', onClick: () => { setModal(null); void doOpen(logsFolderOf(instance), false); } },
              h(IconTerminal, { size: 15 }), t('instance.openLogs')),
            h('button', { type: 'button', className: 'mc-action', onClick: () => { setModal(null); setSelected(idOf(instance)); setDetail(instance); setDetailTab('mods'); } },
              h(IconMod, { size: 15 }), t('detail.mods')),
            h('button', { type: 'button', className: 'mc-action', onClick: () => { setModal(null); void doIde(instance); } },
              h(IconDoc, { size: 15 }), t('instance.ide')),
            h('button', {
              type: 'button', className: 'mc-action danger', disabled: instance.name === '' || instanceActive,
              onClick: () => { setModal({ kind: 'delete', instance, submitting: false, error: '' }); setDeleteConfirm(''); },
            }, h(IconTrash, { size: 15 }),
            h('span', null, t('instance.delete'),
              instance.name === '' ? h('span', { className: 'mc-action-sub' }, t('delete.defaultProtected'))
                : instanceActive ? h('span', { className: 'mc-action-sub' }, t('delete.running')) : null)));
        };

        const workspaceModal = () => h(Modal, {
          title: t('workspace.title'),
          closeLabel: t('misc.close'),
          onClose: () => setModal(null),
          footer: h('button', { type: 'button', className: 'mc-btn', onClick: pickWorkspace }, h(IconFolder, { size: 12 }), t('workspace.pick')),
        },
        h('div', { className: 'mc-ws-list' },
          (() => {
            const currentPath = workspace || data?.workspace;
            const list = roots.slice();
            if (currentPath && currentPath !== '' && !list.some((root) => root.path.toLowerCase() === String(currentPath).toLowerCase())) {
              list.unshift({
                path: currentPath,
                title: data?.workspaceTitle || currentPath.split(/[\\/]/).filter(Boolean).pop() || currentPath,
                projectCount: data?.projects?.length ?? 0,
                exists: true,
                kind: 'picked',
              });
            }
            return list;
          })().map((root) => {
            const isCurrent = root.path.toLowerCase() === String(workspace || '').toLowerCase();
            return h('button', {
              key: root.path, type: 'button',
              className: cx('mc-ws-item', isCurrent && 'on'),
              onClick: () => selectWorkspace(root.path),
            },
            h('span', { className: 'mc-ws-item-main' },
              h('span', { className: 'mc-ws-item-title' }, root.title, isCurrent ? h('span', { className: 'mc-ws-item-meta ok' }, t('workspace.current')) : null),
              h('span', { className: 'mc-ws-item-path' }, root.path)),
            h('span', {
              className: cx('mc-ws-item-meta', !root.exists ? 'missing' : root.projectCount > 0 ? 'ok' : ''),
            }, !root.exists ? t('workspace.missing') : root.projectCount > 0 ? t('workspace.projects', { count: root.projectCount }) : t('workspace.empty')));
          })));

        const actionsModal = () => h(Modal, {
          title: t('actions.title'),
          closeLabel: t('misc.close'),
          onClose: () => setModal(null),
          footer: h('button', { type: 'button', className: 'mc-btn', onClick: () => setModal(null) }, t('actions.cancel')),
        }, detailActions(modal.instance));

        const settingsModal = () => h(Modal, {
          title: t('settings.title'),
          closeLabel: t('misc.close'),
          onClose: () => setModal(null),
          footer: h('button', { type: 'button', className: 'mc-btn', onClick: () => setModal(null) }, t('misc.close')),
        },
        h('div', { className: 'mc-setting-row' },
          h('div', { className: 'mc-setting-row-main' },
            h('b', null, t('settings.autoHide')),
            h('span', null, t('settings.autoHideHint'))),
          h(Switch, {
            checked: autoHide,
            label: t('settings.autoHide'),
            onChange: () => setAutoHide(!autoHide),
          })),
        h('div', { className: 'mc-hint', style: { padding: 0 } }, t('settings.scope')));

        const createModal = () => {
          const allProjects = data?.projects ?? [];
          const supported = allProjects.filter((p) => p.supportsInstance);
          const projects = supported.length > 0 ? supported : allProjects;
          return h(Modal, {
            title: t('create.title'),
            closeLabel: t('misc.close'),
            onClose: () => { if (!modal.submitting) setModal(null); },
            footer: [
              h('button', { key: 'cancel', type: 'button', className: 'mc-btn', onClick: () => setModal(null), disabled: modal.submitting }, t('actions.cancel')),
              h('button', { key: 'ok', type: 'button', className: 'mc-btn primary', onClick: submitCreate, disabled: modal.submitting || modal.name.trim() === '' }, modal.submitting ? t('create.creating') : t('create.submit')),
            ],
          },
          h('label', { className: 'mc-field' },
            h('span', null, t('create.project')),
            h('select', {
              className: 'mc-select', value: modal.project,
              onChange: (event) => setModal({ ...modal, project: event.target.value }),
            }, projects.map((project) => h('option', { key: project.relPath, value: project.relPath }, `${project.relPath} · ${loaderLabelOf(project.loader)} ${project.mcVersion || ''}`)))),
          h('label', { className: 'mc-field' },
            h('span', null, t('create.name')),
            h('input', {
              className: 'mc-input', value: modal.name, placeholder: t('create.namePlaceholder'), autoFocus: true,
              onChange: (event) => setModal({ ...modal, name: event.target.value.replace(/[\\/:*?"<>|%]/g, '') }),
              onKeyDown: (event) => { if (event.key === 'Enter' && modal.name.trim() !== '') submitCreate(); },
            }),
            h('span', { className: 'mc-field-hint' }, t('create.nameHint'))),
          h('label', { className: 'mc-checkline' },
            h('input', { type: 'checkbox', checked: modal.copyOptions, onChange: (event) => setModal({ ...modal, copyOptions: event.target.checked }) }),
            t('create.copyOptions')),
          h('label', { className: 'mc-field' },
            h('span', null, t('create.copyFrom')),
            h('select', {
              className: 'mc-select', value: modal.copyFrom,
              onChange: (event) => setModal({ ...modal, copyFrom: event.target.value }),
            },
            h('option', { value: '' }, t('create.copyFromNone')),
            (data?.instances ?? []).filter((item) => item.name !== '').map((item) => h('option', { key: idOf(item), value: idOf(item) }, `${item.projectRelPath} › ${item.name}（${t('instance.modCount', { count: item.mods?.length ?? 0 })}）`)))),
          h('label', { className: 'mc-checkline' },
            h('input', { type: 'checkbox', checked: modal.writeIde, onChange: (event) => setModal({ ...modal, writeIde: event.target.checked }) }),
            t('create.writeIde')),
          modal.error ? h('div', { className: 'mc-error' }, h('strong', null, h(IconAlert, { size: 13 }), h('span', null, modal.error))) : null);
        };

        const deleteModal = () => {
          const instance = modal.instance;
          const expected = instance.name;
          const ready = deleteConfirm === expected;
          return h(Modal, {
            title: t('delete.title'),
            closeLabel: t('misc.close'),
            onClose: () => { if (!modal.submitting) { setModal(null); setDeleteConfirm(''); } },
            footer: [
              h('button', { key: 'cancel', type: 'button', className: 'mc-btn', onClick: () => { setModal(null); setDeleteConfirm(''); }, disabled: modal.submitting }, t('actions.cancel')),
              h('button', { key: 'ok', type: 'button', className: 'mc-btn danger', onClick: submitDelete, disabled: !ready || modal.submitting }, modal.submitting ? t('delete.deleting') : t('delete.submit')),
            ],
          },
          h('div', { className: 'mc-hint', style: { padding: 0 } }, t('delete.body', { name: displayNameOf(instance) })),
          h('label', { className: 'mc-field' },
            h('span', null, t('delete.typeHint', { name: expected })),
            h('input', {
              className: 'mc-input', value: deleteConfirm, placeholder: t('delete.placeholder'), autoFocus: true,
              onChange: (event) => setDeleteConfirm(event.target.value),
            })),
          modal.error ? h('div', { className: 'mc-error' }, h('strong', null, h(IconAlert, { size: 13 }), h('span', null, modal.error))) : null);
        };

        const importModal = () => {
          const list = (candidates || []).filter((candidate) => {
            const q = candidateQuery.trim().toLowerCase();
            return q === '' || candidate.fileName.toLowerCase().includes(q) || candidate.source.toLowerCase().includes(q);
          });
          const selectedSet = new Set(pickedCandidates);
          return h(Modal, {
            title: t('mods.importTitle'),
            closeLabel: t('misc.close'),
            wide: true,
            onClose: () => { setModal(null); setPickedCandidates([]); setCandidateQuery(''); setCandidates(null); },
            footer: [
              h('button', { key: 'cancel', type: 'button', className: 'mc-btn', onClick: () => { setModal(null); setPickedCandidates([]); setCandidateQuery(''); setCandidates(null); }, disabled: busy === 'import' }, t('actions.cancel')),
              h('button', {
                key: 'ok', type: 'button', className: 'mc-btn primary',
                disabled: pickedCandidates.length === 0 || busy === 'import',
                onClick: () => submitImport(pickedCandidates),
              }, busy === 'import' ? t('create.creating') : `${t('mods.importConfirm')} · ${t('mods.importCount', { count: pickedCandidates.length })}`),
            ],
          },
          h('div', { className: 'mc-search' },
            h(IconSearch, { size: 13 }),
            h('input', { value: candidateQuery, placeholder: t('mods.importSearch'), 'aria-label': t('mods.importSearch'), onChange: (event) => setCandidateQuery(event.target.value) })),
          candidates === null ? h('div', { className: 'mc-hint' }, t('misc.loading'))
            : list.length === 0 ? h('div', { className: 'mc-hint' }, t('mods.importEmpty'))
              : h('div', { className: 'mc-cand-list' }, list.map((candidate) => {
                const checked = selectedSet.has(candidate.path);
                return h('label', { key: candidate.path, className: 'mc-cand' },
                  h('input', {
                    type: 'checkbox', checked,
                    onChange: (event) => {
                      setPickedCandidates((prev) => event.target.checked
                        ? [...new Set([...prev, candidate.path])]
                        : prev.filter((value) => value !== candidate.path));
                    },
                  }),
                  h('span', { className: 'mc-cand-name', title: candidate.path }, candidate.fileName),
                  h('span', { className: 'mc-cand-src', title: candidate.source }, candidate.source));
              })));
        };

        // 选择/过滤的结果
        const renderList = () => {
          if (loading && !data) {
            return h('div', { className: 'mc-skeleton' }, [0, 1, 2, 3].map((i) => h('div', { key: i, className: 'mc-sk-card' })));
          }
          if (error) {
            return h('div', { className: 'mc-error' },
              h('strong', null, h(IconAlert, { size: 14 }), t('error.title')),
              h('span', null, error),
              h('div', null, h('button', { type: 'button', className: 'mc-btn small', onClick: refresh }, t('error.retry'))));
          }
          if (instanceList.length === 0) {
            return h('div', { className: 'mc-empty' },
              h('div', { className: 'mc-empty-mark' }, h(GrassMark, { size: 38 })),
              h('h3', null, t('empty.title')),
              h('p', null, t('empty.body')),
              data && (data.projects?.length ?? 0) === 0 ? h('p', { style: { opacity: .8 } }, t('empty.noProject')) : null,
              data && autoHide ? h('p', { style: { opacity: .85 } }, t('empty.noNearby')) : null,
              h('div', { className: 'mc-empty-actions' },
                h('button', { type: 'button', className: 'mc-btn primary', onClick: initialCreate, disabled: (data?.projects?.length ?? 0) === 0 }, h(IconPlus, { size: 12 }), t('empty.create')),
                h('button', { type: 'button', className: 'mc-btn', onClick: () => setModal({ kind: 'workspace' }) }, h(IconSwitch, { size: 12 }), t('empty.switch')),
                h('button', {
                  type: 'button', className: 'mc-btn small',
                  onClick: () => setAutoHide(!autoHide),
                }, h(IconSettings, { size: 12 }), `${t('settings.autoHide')} · ${autoHide ? t('settings.on') : t('settings.off')}`)));
          }
          return h('div', { className: 'mc-list' }, grouped.length === 0
            ? h('div', { className: 'mc-hint' }, t('misc.empty'))
            : grouped.map(([projectPath, items]) => {
              const collapsed = collapsedGroups[projectPath] === true;
              return h('section', { className: 'mc-group', key: projectPath },
                h('button', {
                  type: 'button', className: 'mc-group-head',
                  'aria-expanded': !collapsed,
                  onClick: () => setCollapsedGroups((prev) => ({ ...prev, [projectPath]: !prev[projectPath] })),
                },
                h(IconChevron, { size: 11, className: cx('mc-chev', collapsed && 'collapsed') }),
                h(IconBox, { size: 12 }),
                h('span', { title: projectPath }, projectPath || items[0]?.project || ''),
                h('span', { className: 'mc-group-count' }, t('project.instances', { count: items.length }))),
                collapsed ? null : items.map((instance) => h(InstanceCard, {
                  key: idOf(instance),
                  instance,
                  launch: launchOf(idOf(instance)),
                  latest: latestLaunchOf(idOf(instance)),
                  busy: busy === `launch:${idOf(instance)}` || busy === `stop:${idOf(instance)}`,
                  onOpen: () => openDetail(instance),
                  onLaunch: () => doLaunch(instance),
                  onStop: () => { const launch = launchOf(idOf(instance)); if (launch) doStop(instance, launch); },
                  onMore: () => openActions(idOf(instance)),
                })));
            }));
        };

        return h('div', { className: 'mc-root', style: { '--mc-font': 'inherit' } },
          h('style', { key: 'css', dangerouslySetInnerHTML: { __html: CSS } }),
          h(PanelHeader, {
            data, workspace, busy: loading,
            onRefresh: refresh,
            onWorkspace: () => setModal({ kind: 'workspace' }),
            onSettings: () => setModal({ kind: 'settings' }),
          }),
          selected === null ? h('div', { className: 'mc-toolbar' },
            h('div', { className: 'mc-search' },
              h(IconSearch, { size: 13 }),
              h('input', {
                value: query, placeholder: t('search.placeholder'), 'aria-label': t('search.placeholder'),
                onChange: (event) => setQuery(event.target.value),
              }),
              query ? h('button', { type: 'button', className: 'mc-search-clear', onClick: () => setQuery(''), 'aria-label': t('misc.clear'), title: t('misc.clear') }, h(IconClose, { size: 12 })) : null),
            h('div', { className: 'mc-chips' },
              h('button', { type: 'button', className: cx('mc-chip', filter === 'all' && 'on'), onClick: () => setFilter('all') }, t('filter.all'), h('span', { className: 'mc-tab-count' }, String(counts.all))),
              counts.fabric > 0 ? h('button', { type: 'button', className: cx('mc-chip', filter === 'fabric' && 'on'), style: { '--mc-accent': LOADERS.fabric.accent }, onClick: () => setFilter('fabric') }, h('i', { className: 'mc-dot' }), 'Fabric', h('span', { className: 'mc-tab-count' }, String(counts.fabric))) : null,
              counts.neoforge > 0 ? h('button', { type: 'button', className: cx('mc-chip', filter === 'neoforge' && 'on'), style: { '--mc-accent': LOADERS.neoforge.accent }, onClick: () => setFilter('neoforge') }, h('i', { className: 'mc-dot' }), 'NeoForge', h('span', { className: 'mc-tab-count' }, String(counts.neoforge))) : null,
              counts.forge > 0 ? h('button', { type: 'button', className: cx('mc-chip', filter === 'forge' && 'on'), style: { '--mc-accent': LOADERS.forge.accent }, onClick: () => setFilter('forge') }, h('i', { className: 'mc-dot' }), 'Forge', h('span', { className: 'mc-tab-count' }, String(counts.forge))) : null,
              counts.running > 0 ? h('button', { type: 'button', className: cx('mc-chip', filter === 'running' && 'on'), onClick: () => setFilter('running') }, t('filter.running'), h('span', { className: 'mc-tab-count' }, String(counts.running))) : null),
            h('button', { type: 'button', className: 'mc-btn small', style: { alignSelf: 'flex-start' }, onClick: initialCreate, disabled: (data?.projects?.length ?? 0) === 0 }, h(IconPlus, { size: 12 }), t('instance.create'))) : null,
          h('div', { className: 'mc-scroll' }, selected === null ? renderList() : (selectedInstance
            ? h(DetailRuntime, {
              key: idOf(selectedInstance),
              instance: selectedInstance,
              launch: activeLaunch,
              latest: latestLaunchOf(idOf(selectedInstance)),
              busy: busy === `launch:${selected}` || busy === `stop:${selected}`,
              tab: detailTab,
              setTab: setDetailTab,
              onBack: closeDetail,
              onLaunch: () => doLaunch(selectedInstance),
              onStop: () => activeLaunch && doStop(selectedInstance, activeLaunch),
              onMore: () => openActions(idOf(selectedInstance)),
              onOpenFolder: () => doOpen(folderOf(selectedInstance), false),
              onOpenLogs: (path, reveal) => doOpen(path ?? folderOf(selectedInstance), reveal ?? false),
              onIde: () => doIde(selectedInstance),
              onReload: async () => {
                try {
                  const res = await apiAction({ op: 'instance', workspace: workspace || '', instanceId: idOf(selectedInstance) });
                  setDetail(res.instance);
                } catch (err) { toastError(err.message); }
              },
              onToggle: toggleMod,
              onOnly: onlyMod,
              onRemove: removeMod,
              onImport: () => { setCandidates(null); setPickedCandidates([]); setCandidateQuery(''); setModal({ kind: 'import' }); },
              onModsChanged: applyModsChanged,
              toast: setToast,
            })
            : h('div', { className: 'mc-empty' }, h('p', null, t('misc.loading'))))),
          modal?.kind === 'workspace' ? workspaceModal() : null,
          modal?.kind === 'settings' ? settingsModal() : null,
          modal?.kind === 'actions' ? actionsModal() : null,
          modal?.kind === 'create' ? createModal() : null,
          modal?.kind === 'delete' ? deleteModal() : null,
          modal?.kind === 'import' ? importModal() : null,
          h(Toast, { toast }));
      }

      // DetailView 需要 mod 操作与外层状态联动：这里用一个薄包装，把回调重新绑到组件内部。
      function DetailRuntime(props) {
        const [modQuery, setModQuery] = useState('');
        const [localMods, setLocalMods] = useState(null);
        const [pendingMod, setPendingMod] = useState(null);
        const instance = useMemo(() => {
          if (!props.instance) return null;
          if (!localMods) return props.instance;
          return { ...props.instance, mods: localMods };
        }, [props.instance, localMods]);
        useEffect(() => { setLocalMods(null); setModQuery(''); }, [idOf(props.instance)]);

        const applyResult = (res) => {
          if (res?.mods) {
            setLocalMods(res.mods);
            props.onModsChanged?.(res.mods);
          }
        };
        const doToggle = async (mod, next) => {
          setPendingMod(mod.fileName);
          try {
            const res = await apiAction({
              op: 'mods', action: next ? 'enable' : 'disable', workspace: instance.workspace,
              instanceId: idOf(instance), runConfigName: instance.runConfigName, mods: [mod.fileName],
            });
            applyResult(res);
            props.toast({ tone: 'ok', text: t(next ? 'toast.toggledOn' : 'toast.toggledOff', { name: mod.fileName }) });
          } catch (error) { props.toast({ tone: 'error', text: error.message }); }
          finally { setPendingMod(null); }
        };
        const doOnly = async (mod) => {
          setPendingMod(mod.fileName);
          try {
            const res = await apiAction({
              op: 'mods', action: 'only', workspace: instance.workspace,
              instanceId: idOf(instance), runConfigName: instance.runConfigName, mods: [mod.fileName],
            });
            applyResult(res);
            props.toast({ tone: 'ok', text: t('toast.only', { name: mod.fileName }) });
          } catch (error) { props.toast({ tone: 'error', text: error.message }); }
          finally { setPendingMod(null); }
        };
        const doRemove = async (mod) => {
          try {
            const res = await apiAction({
              op: 'mods', action: 'remove', workspace: instance.workspace,
              instanceId: idOf(instance), runConfigName: instance.runConfigName, mods: [mod.fileName],
            });
            applyResult(res);
            props.toast({ tone: 'ok', text: t('toast.deleted', { name: mod.fileName }) });
          } catch (error) { props.toast({ tone: 'error', text: error.message }); }
        };
        return h(DetailView, {
          ...props,
          instance,
          modQuery, setModQuery, pendingMod,
          onToggle: doToggle, onOnly: doOnly, onRemove: doRemove,
        });
      }

      function loaderLabelOf(key) {
        return loaderOf(key).label;
      }

      /** 共享的「附近有没有实例」检测：头部按钮和指南卡片都用它决定是否隐藏。 */
      function useNearbyDetection(sessionId, useWorkspaces) {
        const [autoHide] = useAutoHideSetting();
        const useWs = useWorkspaces ?? noWorkspaces;
        const workspaceItems = useWs((state) => state.items) ?? [];
        const workspace = useMemo(() => {
          const owner = workspaceItems.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
          return owner?.path ?? null;
        }, [workspaceItems, sessionId]);
        const [nearby, setNearby] = useState(null);
        useEffect(() => {
          if (!autoHide || !workspace) { setNearby(null); return undefined; }
          let alive = true;
          apiAction({ op: 'neighborhood', workspace })
            .then((result) => { if (alive) setNearby(result?.hasInstances === true) })
            .catch(() => { if (alive) setNearby(true); });
          return () => { alive = false; };
        }, [autoHide, workspace]);
        return {
          autoHide,
          workspace,
          nearby,
          hide: autoHide && workspace !== null && nearby === false,
        };
      }

      function HeaderButton({ sessionId, useWorkspaces }) {
        const { hide } = useNearbyDetection(sessionId, useWorkspaces);
        if (hide) return null;
        return h('button', {
          type: 'button', className: 'mc-headbtn', title: t('button.label'), 'aria-label': t('button.label'),
          onClick: () => openPanel(sessionId),
        }, h(GrassPlayMark, { size: 17 }));
      }

      /** 指南页的卡片。附近的实例检测为空且自动隐藏开启时，整张卡片消失。 */
      function GuideEntry(props) {
        const { hide } = useNearbyDetection(props.sessionId, props.useWorkspaces);
        if (hide) return null;
        const title = typeof props.title === 'string' ? props.title : t('guide.title');
        const description = typeof props.description === 'string' ? props.description : t('guide.description');
        return h(React.Fragment, null,
          h('style', { key: 'guide-css', dangerouslySetInnerHTML: { __html: GUIDE_CARD_CSS } }),
          h('button', {
            key: 'card', type: 'button', className: 'mc-guide-card',
            title: t('guide.title'),
            onClick: () => openPanel(props.sessionId),
          },
          h('span', { className: 'mc-guide-icon' }, h(GrassMark, { size: 26 })),
          h('span', { className: 'mc-guide-text' },
            h('span', { className: 'mc-guide-title' }, title),
            h('span', { className: 'mc-guide-desc' }, description))));
      }

      function TabTitle() {
        return h('span', { className: 'mc-tabtitle' }, h(GrassMark, { size: 14 }), h('span', null, t('tab.title')));
      }

      function GuideIcon(props) {
        return h(GrassMark, { size: props?.size ?? 18, className: props?.className });
      }

      // ── 注册 ────────────────────────────────────────────────────
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mc-instances: locale');

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('tab.title'),
        guide: [{
          id: 'instances',
          order: 10,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          icon: GuideIcon,
        }],
      }), 'mc-instances: tab type');

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS,
      }, Panel)), 'mc-instances: tab body');

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS,
      }, TabTitle)), 'mc-instances: tab title');

      // 指南卡片：自动隐藏开启且附近没有实例时，卡片本身也不渲染。
      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
        name: 'sidebar.right.tab.guide.entry', key: TAB_ID, locale: NS,
      }, GuideEntry)), 'mc-instances: guide entry');

      // 入口全隐藏时的可达通道：命令面板 / 快捷键。
      ctx.effect(() => ctx.shortcuts.register({
        id: 'mc-instances.open',
        label: () => t('shortcut.open'),
        aliases: ['mc instances', 'minecraft instance manager', 'mc 实例', '实例管理器'],
        defaults: {
          'desktop:macos': { code: 'KeyM', modifiers: ['meta', 'alt'] },
          'desktop:windows': { code: 'KeyM', modifiers: ['control', 'alt'] },
          'desktop:linux': { code: 'KeyM', modifiers: ['control', 'alt'] },
          'web:macos': { code: 'KeyM', modifiers: ['meta', 'alt'] },
          'web:windows': { code: 'KeyM', modifiers: ['control', 'alt'] },
          // web:linux 不设默认键：DSH 的 Web 快捷键白名单在 Linux 上不接受这个组合。
        },
        regions: ['page', 'editable', 'terminal'],
        modals: [],
        resolve: ({ target: element }) => {
          const target = ctx.sidebarRight.commandTarget(element);
          // 焦点不在会话里时也允许打开当前会话：它是入口全隐藏后的唯一通道。
          return {
            status: 'handled',
            run: () => {
              if (target !== undefined) ctx.sidebarRight.openTabFromTarget(KIND, target);
              else ctx.sidebarRight.openTab(KIND);
            },
          };
        },
      }), 'mc-instances: shortcut');

      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'mc-instances', order: 34,
        label: () => t('button.label'),
      }, HeaderButton)), 'mc-instances: header button');
    }

    return {
      inject: ['slots', 'locale', 'shortcuts', 'sidebarRight', 'sidebarRightTabs', 'workspaces', 'uiWorkspace'],
      apply,
    };
  },
});
