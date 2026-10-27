/**
 * dsh-archived-digest — Client half.
 *
 * One row in the shell's left sidebar (`sidebar.panellist`) plus the keyed center
 * page (`main`). The page has three jobs, in the order the user needs them:
 *
 *  1. show what the archive is costing (sessions × bytes),
 *  2. let the user pick exactly which archived sessions to distil — the manual
 *     path, which is the whole reason this is a panel and not a cron script,
 *  3. switch the automatic pass off.
 *
 * It also reads the store (memories / skills) so the result is inspectable
 * without leaving the GUI.
 */

window.__ModuleLoader__.load({
  id: 'dsh-archived-digest',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dsh-archived-digest';
    const NS = 'dsh-archived-digest';
    /**
     * Sits after the built-in 插件 (0) / 自动化任务 (10) rows and after
     * github-manager (11), ahead of Jet Hub (20) — the same top-left group.
     */
    const PANEL_ORDER = 12;
    /** Document-relative: the GUI is served with <base href="./">. */
    const API = {
      status: 'api/dsh-archived-digest/status',
      sessions: 'api/dsh-archived-digest/sessions',
      memories: 'api/dsh-archived-digest/memories',
      memory: 'api/dsh-archived-digest/memory',
      skills: 'api/dsh-archived-digest/skills',
      skill: 'api/dsh-archived-digest/skill',
      inspect: 'api/dsh-archived-digest/inspect',
      run: 'api/dsh-archived-digest/run',
      settings: 'api/dsh-archived-digest/settings',
      digest: 'api/dsh-archived-digest/digest',
      cleanup: 'api/dsh-archived-digest/cleanup',
      forget: 'api/dsh-archived-digest/forget',
      stop: 'api/dsh-archived-digest/run/stop',
      facts: 'api/dsh-archived-digest/facts',
      topics: 'api/dsh-archived-digest/topics',
      recall: 'api/dsh-archived-digest/recall',
      consolidate: 'api/dsh-archived-digest/consolidate',
      exportMemory: 'api/dsh-archived-digest/export',
      forgetFact: 'api/dsh-archived-digest/fact/forget',
      live: 'api/dsh-archived-digest/live',
      liveDigest: 'api/dsh-archived-digest/live/digest',
      selfCheck: 'api/dsh-archived-digest/selfcheck',
      health: 'api/dsh-archived-digest/health',
    };
    /** Mutating fetches must carry this (server-side CSRF fence). */
    const MARKER = { 'x-dsh-archived-digest': '1' };

    // ── copy ───────────────────────────────────────────────────────────────
    const COPY = {
      zh: {
        entry: '归档会话提炼',
        title: '归档会话提炼',
        subtitle: '把已归档的会话压缩成一条记忆 + 可复用技能，统一存放在一个目录里，再回收日志占用的空间。',
        loading: '加载中…',
        reload: '刷新',
        tabOverview: '概览',
        tabSessions: '归档会话',
        tabMemories: '记忆',
        tabTopics: '主题记忆',
        tabFacts: '事实',
        tabSkills: '技能',
        tabLive: '进行中',
        tabSelfCheck: '自检',
        tabSettings: '设置',
        // overview
        statArchived: '归档会话',
        statLogs: '归档日志占用',
        statDigested: '已提炼',
        statPending: '待提炼',
        statFreed: '已回收',
        statSkills: '技能',
        allLogs: '全部会话日志',
        storeRoot: '存储目录',
        llmReady: '模型可用',
        llmNotReady: '模型不可用',
        llmHint: '自动提炼需要可用的 provider/model。可在「设置」里指定，或留空自动挑选。',
        autoOn: '自动提炼已开启',
        autoOff: '自动提炼已关闭',
        autoOffHint: '关闭后不会有任何后台任务，只能手动勾选会话提炼。',
        progress: '进行中',
        // memory layer
        statTopics: '主题',
        statFacts: '事实',
        factsHint: '每条事实带强度（越新、被越多会话印证越高）与来源会话；被新结论取代的旧事实保留在「已失效」里。',
        topicsEmpty: '还没有主题。先提炼几个会话，再点「重新整合」。',
        factsEmpty: '还没有事实。',
        consolidate: '重新整合',
        consolidating: '整合中…',
        consolidated: '整合完成',
        exportMemory: '导出到记忆后端',
        exporting: '导出中…',
        recallTitle: '检索记忆',
        recallPlaceholder: '问点什么，例如「zstd 日志怎么解」',
        recallRun: '检索',
        recallEmpty: '没有匹配的事实。',
        recallHits: '命中',
        invalidated: '已失效',
        invalidatedEmpty: '没有被取代的旧事实。',
        showInvalidated: '显示已失效',
        hideInvalidated: '收起已失效',
        strength: '强度',
        fromSessions: '来源',
        forgerFact: '忘记',
        confirmForgetFact: '确定删除这条事实？删除后不会保留历史。',
        backendsNone: '没有检测到记忆插件，本地存储就是唯一落盘处。',
        backendsTitle: '记忆后端',
        topicFacts: '条事实',
        setExtractFacts: '提炼时抽取事实',
        setExtractFactsHint: '把每个会话的结论拆成可去重、可被取代的事实行。',
        setAutoConsolidate: '提炼后自动整合主题',
        setExport: '整合后导出到记忆插件',
        setExportHint: '只有检测到记忆插件时才生效；本地存储始终是真相源。',
        setLive: '提炼实时会话（未归档的）',
        setLiveHint: '归档之前，会话不属于本插件；打开后你刚聊完的对话也会沉淀成记忆。每个会话花一次模型调用。',
        setLiveMax: '每次自动跑批最多提炼几个实时会话',
        setLiveSettle: '实时会话静默多少秒后算结束',
        setLiveSettleHint: '正在进行的对话不会被提炼，避免只记住半截。',
        liveEmpty: '没有未归档的会话。',
        liveTab: '实时会话',
        liveBadge: '未归档',
        liveCount: '未归档会话',
        liveReady: '已静默待提炼',
        digestLive: '提炼最新的实时会话',
        // sessions
        selectAll: '全选待提炼',
        selectNone: '取消选择',
        selected: '已选',
        digestSelected: '提炼所选',
        digestPending: '提炼全部待处理',
        filterSessions: '筛选会话…',
        colSession: '会话',
        colSize: '日志大小',
        colState: '状态',
        stateDigested: '已提炼',
        statePending: '待提炼',
        stateCleaned: '已清理',
        stateMissing: '目录缺失',
        statePinned: '已置顶',
        stateFailed: '失败',
        inspect: '预览',
        inspecting: '正在读取…',
        noSessions: '没有匹配的归档会话。',
        // cleanup
        cleanupTitle: '回收日志空间',
        cleanupHint: '只会清理已经有记忆的会话，且受「最小年龄」限制。',
        cleanupModeOff: '不清理',
        cleanupModeLogs: '只删日志文件',
        cleanupModeDir: '删整个会话目录',
        cleanupModeTrash: '移到回收目录',
        cleanupRun: '清理已提炼的会话',
        freed: '已回收',
        minAge: '最小年龄（天）',
        // memories / skills
        memoriesEmpty: '还没有提炼出任何记忆。',
        skillsEmpty: '还没有提炼出任何技能。',
        mirrorOk: '已发布到技能中心',
        mirrorOccupied: '同名技能已存在，未覆盖',
        mirrorFailed: '发布失败',
        search: '搜索…',
        memorySource: '来源会话',
        skillSources: '来自会话',
        viewRaw: '查看原文',
        hideRaw: '收起原文',
        // settings
        settingsTitle: '设置',
        setAuto: '自动提炼',
        setAutoHint: '定时扫描归档会话并自动提炼。关掉即完全手动。',
        setInterval: '扫描间隔（分钟）',
        setMaxPerRun: '每轮最多提炼',
        setRetry: '重试失败的会话',
        setExtractSkills: '同时提炼技能',
        setCleanupMode: '提炼成功后',
        setMinAge: '清理最小年龄（天）',
        setProvider: 'provider（留空自动）',
        setModel: 'model（留空自动）',
        setMaxChars: '送入模型的字符上限',
        setMaxTokens: '单次输出 token 上限',
        save: '保存',
        saved: '已保存',
        // live (incremental) capture
        liveHint: '进行中的会话只读读取：只取上次提炼之后的新事件，会话日志一个字节都不会被改动。',
        liveTotal: '进行中会话',
        liveCaptured: '已提炼过',
        livePending: '有新内容',
        liveDigestOne: '提炼这条的新内容',
        liveDigestSome: '提炼最需要的一批',
        liveUpToDate: '已是最新',
        liveNothing: '没有可增量提炼的进行中会话',
        liveStarted: '已开始增量提炼',
        liveEmpty: '没有进行中的会话',
        liveReadOnly: '只读',
        liveTurns: '轮',
        liveSeq: '已提炼到',
        // self-check
        selfCheckHint: '长期使用后记忆会累积成噪声。自检会先只读统计，再由你决定是否真的精简。',
        selfCheckRun: '只统计，不改动',
        selfCheckApply: '执行精简',
        selfCheckFacts: '条重复事实',
        selfCheckSkills: '组重复技能',
        selfCheckStale: '条陈旧待办',
        selfCheckCatalog: '技能目录占用',
        selfCheckTrash: '可回收磁盘',
        selfCheckReported: '已生成报告（未改动任何数据）',
        selfCheckApplied: '已精简',
        selfCheckNone: '没有需要精简的内容',
        selfCheckMergeSkills: '同时合并重复技能',
        selfCheckPurgeTrash: '同时清空回收站',
        confirmSelfCheck: '确定执行精简？重复事实会被标记为失效（不删除，可在事实页查看历史），不会丢失原始记录。',
        // misc
        error: '出错了',
        busy: '有任务正在进行，请等待完成。',
        stop: '停止',
        empty: '—',
        confirmCleanup: '确定清理这些已提炼会话的日志？删除后无法从本地恢复。',
      },
      en: {
        entry: 'Archived digest',
        title: 'Archived session digest',
        subtitle: 'Compress archived conversations into one memory + reusable skills in a single managed folder, then reclaim the log space.',
        loading: 'Loading…',
        reload: 'Reload',
        tabOverview: 'Overview',
        tabSessions: 'Archived',
        tabMemories: 'Memories',
        tabTopics: 'Topics',
        tabFacts: 'Facts',
        tabSkills: 'Skills',
        tabLive: 'Live',
        tabSelfCheck: 'Self-check',
        tabSettings: 'Settings',
        statArchived: 'Archived',
        statLogs: 'Log size',
        statDigested: 'Digested',
        statPending: 'Pending',
        statFreed: 'Reclaimed',
        statSkills: 'Skills',
        allLogs: 'All session logs',
        storeRoot: 'Store folder',
        llmReady: 'Model ready',
        llmNotReady: 'Model unavailable',
        llmHint: 'Automatic digesting needs a usable provider/model. Pin one in Settings, or leave it blank to auto-pick.',
        autoOn: 'Auto digest is on',
        autoOff: 'Auto digest is off',
        autoOffHint: 'Nothing runs in the background. Only sessions you tick are digested.',
        progress: 'Running',
        // memory layer
        statTopics: 'Topics',
        statFacts: 'Facts',
        factsHint: 'Each fact carries a strength (fresher and more corroborated ranks higher) and its source sessions. Facts replaced by newer conclusions are kept under "invalidated".',
        topicsEmpty: 'No topics yet. Digest a few sessions, then press "Re-consolidate".',
        factsEmpty: 'No facts yet.',
        consolidate: 'Re-consolidate',
        consolidating: 'Consolidating…',
        consolidated: 'Consolidated',
        exportMemory: 'Export to memory backend',
        exporting: 'Exporting…',
        recallTitle: 'Search memory',
        recallPlaceholder: 'e.g. how do we decode the zstd logs',
        recallRun: 'Search',
        recallEmpty: 'No matching fact.',
        recallHits: 'hits',
        invalidated: 'Invalidated',
        invalidatedEmpty: 'No superseded facts.',
        showInvalidated: 'Show invalidated',
        hideInvalidated: 'Hide invalidated',
        strength: 'strength',
        fromSessions: 'From',
        forgerFact: 'Forget',
        confirmForgetFact: 'Delete this fact? Its history will not be kept.',
        backendsNone: 'No memory plugin detected; the local store is the only sink.',
        backendsTitle: 'Memory backends',
        topicFacts: 'facts',
        setExtractFacts: 'Extract facts when digesting',
        setExtractFactsHint: 'Split each session\'s conclusions into fact rows that can be deduplicated and superseded.',
        setAutoConsolidate: 'Consolidate topics after digesting',
        setExport: 'Export to memory plugin after consolidating',
        setExportHint: 'Only takes effect when a memory plugin is detected; the local store is always the source of truth.',
        setLive: 'Distil live (not-yet-archived) sessions',
        setLiveHint: 'A session is outside this plugin until it is archived; switch this on and the conversation you just finished also reaches memory. Costs one model call per session.',
        setLiveMax: 'Live sessions per automatic pass',
        setLiveSettle: 'Seconds a live session must be quiet before it counts as finished',
        setLiveSettleHint: 'A conversation still in progress is never digested, so half of it cannot be remembered.',
        liveEmpty: 'No unarchived sessions.',
        liveTab: 'Live',
        liveBadge: 'unarchived',
        liveCount: 'Live sessions',
        liveReady: 'settled & pending',
        digestLive: 'Distil newest live sessions',
        selectAll: 'Select pending',
        selectNone: 'Clear',
        selected: 'selected',
        digestSelected: 'Digest selected',
        digestPending: 'Digest all pending',
        filterSessions: 'Filter sessions…',
        colSession: 'Session',
        colSize: 'Log size',
        colState: 'State',
        stateDigested: 'Digested',
        statePending: 'Pending',
        stateCleaned: 'Cleaned',
        stateMissing: 'Missing dir',
        statePinned: 'Pinned',
        stateFailed: 'Failed',
        inspect: 'Preview',
        inspecting: 'Reading…',
        noSessions: 'No archived session matches.',
        cleanupTitle: 'Reclaim log space',
        cleanupHint: 'Only sessions that already have a memory are cleaned, and only past the minimum age.',
        cleanupModeOff: 'Do not clean',
        cleanupModeLogs: 'Delete log files',
        cleanupModeDir: 'Delete session folder',
        cleanupModeTrash: 'Move to trash',
        cleanupRun: 'Clean digested sessions',
        freed: 'Reclaimed',
        minAge: 'Minimum age (days)',
        memoriesEmpty: 'No memories distilled yet.',
        skillsEmpty: 'No skills distilled yet.',
        mirrorOk: 'Published to skills center',
        mirrorOccupied: 'Name taken, not overwritten',
        mirrorFailed: 'Publish failed',
        search: 'Search…',
        memorySource: 'Source session',
        skillSources: 'From sessions',
        viewRaw: 'Show original',
        hideRaw: 'Hide original',
        settingsTitle: 'Settings',
        setAuto: 'Auto digest',
        setAutoHint: 'Scan archived sessions on a timer and distil them. Off means fully manual.',
        setInterval: 'Scan interval (min)',
        setMaxPerRun: 'Max per pass',
        setRetry: 'Retry failed sessions',
        setExtractSkills: 'Extract skills too',
        setCleanupMode: 'After a digest',
        setMinAge: 'Cleanup minimum age (days)',
        setProvider: 'provider (blank = auto)',
        setModel: 'model (blank = auto)',
        setMaxChars: 'Transcript chars to model',
        setMaxTokens: 'Output token ceiling',
        save: 'Save',
        saved: 'Saved',
        // live (incremental) capture
        liveHint: 'Read-only: only events newer than the last pass are taken, and the session log is never modified.',
        liveTotal: 'Live sessions',
        liveCaptured: 'Already captured',
        livePending: 'Has new content',
        liveDigestOne: "Take this one's new part",
        liveDigestSome: 'Take the most-needed batch',
        liveUpToDate: 'Up to date',
        liveNothing: 'No running session has new content to take',
        liveStarted: 'Incremental digest started',
        liveEmpty: 'No running sessions',
        liveReadOnly: 'read-only',
        liveTurns: 'turns',
        liveSeq: 'Captured to',
        // self-check
        selfCheckHint: 'Memory accumulates into noise over long use. The self-check measures first, read-only; you decide whether to compact.',
        selfCheckRun: 'Measure only',
        selfCheckApply: 'Compact now',
        selfCheckFacts: 'duplicate facts',
        selfCheckSkills: 'redundant skill pairs',
        selfCheckStale: 'stale open items',
        selfCheckCatalog: 'Skill catalog cost',
        selfCheckTrash: 'Reclaimable disk',
        selfCheckReported: 'Report ready (nothing changed)',
        selfCheckApplied: 'Compacted',
        selfCheckNone: 'Nothing needs compacting',
        selfCheckMergeSkills: 'Also merge duplicate skills',
        selfCheckPurgeTrash: 'Also empty the trash',
        confirmSelfCheck: 'Compact now? Duplicate facts are marked invalid rather than deleted — the history stays visible on the facts tab, so no original record is lost.',
        error: 'Something went wrong',
        busy: 'A job is running, wait for it to finish.',
        stop: 'Stop',
        empty: '—',
        confirmCleanup: 'Reclaim the logs of these digested sessions? Deleted logs cannot be restored locally.',
      },
    };

    /**
     * Resolve the active UI language.
     *
     * The locale service writes `<html lang>` *after* client plugins load, so a
     * single read at factory time yields '' — and '' does not start with 'zh',
     * which silently fell through to English and stayed there for the whole
     * session. Read it per access instead.
     *
     * An unknown language resolves to Chinese: this plugin's copy is authored in
     * Chinese first, and a Chinese user staring at an English panel is the
     * failure worth defaulting away from.
     */
    function activeLanguage() {
      try {
        const docLang = document.documentElement.lang;
        if (typeof docLang === 'string' && docLang.trim() !== '') return docLang.trim().toLowerCase();
      } catch { /* no document yet */ }
      try {
        const list = globalThis.navigator?.languages;
        const nav = (Array.isArray(list) && list.length > 0 ? list[0] : globalThis.navigator?.language) || '';
        if (String(nav).trim() !== '') return String(nav).trim().toLowerCase();
      } catch { /* no navigator */ }
      return 'zh';
    }

    function pickCopy() {
      return activeLanguage().startsWith('zh') ? COPY.zh : COPY.en;
    }

    /**
     * Live copy handle.
     *
     * A Proxy, so every `t.foo` resolves against the language that is active
     * *now*: the sidebar label is invoked by the host long after load, and
     * switching language in Settings must not require a page reload.
     */
    const t = new Proxy({}, {
      get(_target, key) {
        if (typeof key === 'symbol') return undefined;
        return pickCopy()[key];
      },
      has(_target, key) { return typeof key === 'string' && key in pickCopy(); },
    });

    // ── styles ─────────────────────────────────────────────────────────────
    const CSS = `
.ad-view{height:100%;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:18px 22px;gap:14px;box-sizing:border-box}
.ad-head{display:flex;flex-direction:column;gap:4px}
.ad-title-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.ad-title{font-size:18px;font-weight:650;color:var(--dsw-alias-label-primary,#eee)}
.ad-sub{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.ad-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);padding-bottom:8px}
.ad-tab{cursor:pointer;border:none;background:none;color:var(--dsw-alias-label-tertiary,#a0a0a0);font-size:12.5px;padding:5px 11px;border-radius:7px;font-family:inherit}
.ad-tab:hover{color:var(--dsw-alias-label-primary,#eee)}
.ad-tab-on{background:rgba(79,140,255,.16);color:#6fa4ff;font-weight:600}
.ad-card{border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:10px;padding:13px 15px;background:var(--dsw-alias-bg-l1,#1c1c1c);display:flex;flex-direction:column;gap:11px}
.ad-card-title{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#eee)}
.ad-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ad-btn{flex:none;cursor:pointer;border-radius:7px;border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);background:var(--dsw-alias-interactive-bg-hover,#2a2a2a);color:var(--dsw-alias-label-primary,#eee);font-size:12.5px;padding:6px 12px;font-family:inherit;white-space:nowrap}
.ad-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff)}
.ad-btn:disabled{opacity:.55;cursor:not-allowed}
.ad-btn-primary{border-color:rgba(79,140,255,.5);background:rgba(79,140,255,.16);color:#6fa4ff;font-weight:600}
.ad-btn-ghost{background:none}
.ad-btn-danger{color:#f08080;border-color:rgba(224,92,92,.35)}
.ad-input{flex:1 1 200px;min-width:0;background:var(--dsw-alias-bg-l2,#141414);color:var(--dsw-alias-label-primary,#eee);border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:7px;padding:7px 9px;font-size:12.5px;font-family:inherit;outline:none}
.ad-input:focus{border-color:var(--dsw-alias-brand-primary,#4f8cff)}
.ad-input-num{flex:0 0 88px;min-width:88px}
.ad-select{flex:none;background:var(--dsw-alias-bg-l2,#141414);color:var(--dsw-alias-label-primary,#eee);border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit}
.ad-hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.ad-msg{font-size:12px;padding:7px 10px;border-radius:7px;line-height:17px;word-break:break-word}
.ad-msg-err{background:rgba(224,92,92,.12);color:#f08080;border:0.5px solid rgba(224,92,92,.35)}
.ad-msg-ok{background:rgba(70,170,110,.12);color:#5fc08a;border:0.5px solid rgba(70,170,110,.35)}
.ad-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:9px}
.ad-stat{display:flex;flex-direction:column;gap:1px;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-l2,#141414);border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a)}
.ad-stat-num{font-size:16px;font-weight:650;color:var(--dsw-alias-label-primary,#eee);font-variant-numeric:tabular-nums}
.ad-stat-label{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.ad-subcard{margin-top:12px;padding:11px 12px;border-radius:9px;background:var(--dsw-alias-bg-l2,#141414);border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);display:flex;flex-direction:column;gap:9px}
.ad-subcard-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#eee)}
.ad-check-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8);cursor:pointer;padding:5px 0}
.ad-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}
.ad-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:11.5px;align-items:baseline}
.ad-kv-k{color:var(--dsw-alias-label-tertiary,#a0a0a0);white-space:nowrap}
.ad-kv-v{color:var(--dsw-alias-label-primary,#eee);min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px}
.ad-switch{display:flex;align-items:center;gap:9px;padding:7px 0}.ad-switch-label{font-size:12.5px;color:var(--dsw-alias-label-primary,#eee);flex:1 1 auto}
.ad-track{flex:none;width:38px;height:21px;border-radius:11px;background:var(--dsw-alias-bg-l2,#141414);border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);cursor:pointer;position:relative;transition:background .15s}
.ad-track-on{background:rgba(79,140,255,.55);border-color:rgba(79,140,255,.8)}
.ad-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#eee;transition:transform .15s}
.ad-knob-on{transform:translateX(17px)}
.ad-session{display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-top:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);flex-wrap:wrap}
.ad-session:first-of-type{border-top:0}
.ad-check{margin-top:3px;flex:none;accent-color:#4f8cff;width:14px;height:14px;cursor:pointer}
.ad-session-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 220px}
.ad-session-id{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary,#eee);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad-session-facts{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.ad-tag{font-size:10px;padding:1px 6px;border-radius:4px;border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);color:var(--dsw-alias-label-secondary,#b9b9b9)}
.ad-tag-ok{background:rgba(70,170,110,.13);color:#5fc08a;border-color:rgba(70,170,110,.4)}
.ad-tag-warn{background:rgba(230,180,80,.13);color:#e0b45a;border-color:rgba(230,180,80,.4)}
.ad-tag-err{background:rgba(224,92,92,.13);color:#f08080;border-color:rgba(224,92,92,.4)}
.ad-tag-mute{opacity:.7}
.ad-progress{height:5px;border-radius:3px;background:var(--dsw-alias-bg-l2,#141414);overflow:hidden}
.ad-progress-fill{height:100%;background:#4f8cff;transition:width .2s}
.ad-item{display:flex;flex-direction:column;gap:4px;padding:9px 0;border-top:0.5px solid var(--dsw-alias-border-l1,#3a3a3a)}
.ad-item:first-of-type{border-top:0}
.ad-item-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#eee);cursor:pointer}
.ad-item-title:hover{color:#6fa4ff;text-decoration:underline}
.ad-item-body{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#b9b9b9);white-space:pre-wrap;word-break:break-word}
.ad-pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-l2,#141414);border:0.5px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:7px;padding:9px;max-height:340px;overflow:auto;color:var(--dsw-alias-label-secondary,#b9b9b9)}
`;

    // ── api helpers ────────────────────────────────────────────────────────
    async function fetchView(path) {
      const response = await fetch(path, { method: 'GET', headers: { accept: 'application/json' } });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      if (payload && payload.ok === false) throw new Error(payload.error ?? payload.message ?? t.error);
      return payload;
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...MARKER },
        body: JSON.stringify(body ?? {}),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      if (payload && payload.ok === false) throw new Error(payload.error ?? payload.message ?? t.error);
      return payload;
    }

    function withParams(path, params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue;
        search.set(key, String(value));
      }
      const qs = search.toString();
      return qs === '' ? path : `${path}?${qs}`;
    }

    function formatBytes(bytes) {
      const number = Number(bytes) || 0;
      if (number < 1024) return `${number} B`;
      if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`;
      if (number < 1024 * 1024 * 1024) return `${(number / 1048576).toFixed(1)} MB`;
      return `${(number / 1073741824).toFixed(2)} GB`;
    }

    function formatCount(value) {
      const number = Number(value) || 0;
      if (number < 1000) return String(number);
      if (number < 1_000_000) return `${(number / 1000).toFixed(1)}k`;
      return `${(number / 1_000_000).toFixed(1)}M`;
    }

    function relativeDate(value) {
      if (typeof value !== 'string' || value === '') return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
      if (days <= 0) return 'today';
      if (days === 1) return '1d';
      if (days < 30) return `${days}d`;
      if (days < 365) return `${Math.floor(days / 30)}mo`;
      return `${Math.floor(days / 365)}y`;
    }

    function shortId(sessionId) {
      const raw = String(sessionId ?? '');
      return raw.replace(/^session-/, '').slice(0, 8);
    }

    // ── icons ──────────────────────────────────────────────────────────────
    function PanelIcon({ size }) {
      const edge = typeof size === 'number' ? size : 16;
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16', width: edge, height: edge,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
        // Archive box with a folded corner — "things put away".
        h('path', { d: 'M2 3.2h12v3H2z' }),
        h('path', { d: 'M3 6.2v6.6h10V6.2' }),
        h('path', { d: 'M6.3 9h3.4' }),
      );
    }

    // ── small pieces ───────────────────────────────────────────────────────
    function Stat({ label, value }) {
      return h('div', { className: 'ad-stat' },
        h('div', { className: 'ad-stat-num' }, value),
        h('div', { className: 'ad-stat-label' }, label),
      );
    }

    function Switch({ checked, onChange, label, hint }) {
      return h('div', null,
        h('div', { className: 'ad-switch' },
          h('div', { className: 'ad-switch-label' }, label),
          h('div', {
            className: `ad-track${checked ? ' ad-track-on' : ''}`,
            role: 'switch',
            tabIndex: 0,
            'aria-checked': checked,
            onClick: () => onChange(!checked),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onChange(!checked);
              }
            },
          }, h('div', { className: `ad-knob${checked ? ' ad-knob-on' : ''}` })),
        ),
        hint ? h('div', { className: 'ad-hint' }, hint) : null,
      );
    }

    function SessionRow({ session, checked, onToggle, onInspect, inspecting }) {
      const state = session.cleanedAt
        ? { cls: 'ad-tag ad-tag-mute', text: t.stateCleaned }
        : session.digestedAt
          ? { cls: 'ad-tag ad-tag-ok', text: t.stateDigested }
          : session.failed
            ? { cls: 'ad-tag ad-tag-err', text: t.stateFailed }
            : !session.present
              ? { cls: 'ad-tag ad-tag-err', text: t.stateMissing }
              : session.pinned
                ? { cls: 'ad-tag ad-tag-warn', text: t.statePinned }
                : { cls: 'ad-tag ad-tag-warn', text: t.statePending };
      const selectable = session.present && !session.pinned && !session.cleanedAt;
      return h('div', { className: 'ad-session' },
        h('input', {
          type: 'checkbox',
          className: 'ad-check',
          checked: checked === true,
          disabled: !selectable,
          onChange: () => onToggle(session.sessionId),
          'aria-label': session.sessionId,
        }),
        h('div', { className: 'ad-session-main' },
          h('div', { className: 'ad-session-id', title: session.sessionId },
            session.digestTitle ? `${session.digestTitle}` : shortId(session.sessionId)),
          h('div', { className: 'ad-session-facts' },
            h('span', { className: state.cls }, state.text),
            h('span', null, formatBytes(session.bytes)),
            session.workspaceSlug ? h('span', null, session.workspaceSlug.replace(/^--|--$/g, '').slice(0, 40)) : null,
            session.mtimeMs ? h('span', null, relativeDate(new Date(session.mtimeMs).toISOString())) : null,
            session.freedBytes ? h('span', null, `${t.freed} ${formatBytes(session.freedBytes)}`) : null,
            session.failed ? h('span', { className: 'ad-tag ad-tag-err', title: String(session.failed.message ?? '') }, String(session.failed.code ?? 'error')) : null,
          ),
        ),
        selectable
          ? h('button', {
            type: 'button',
            className: 'ad-btn ad-btn-ghost',
            disabled: inspecting,
            onClick: () => onInspect(session.sessionId),
          }, inspecting ? t.inspecting : t.inspect)
          : null,
      );
    }

    // ── main page ──────────────────────────────────────────────────────────
    function PanelPage() {
      const [tab, setTab] = React.useState('overview');
      const [status, setStatus] = React.useState(null);
      const [sessionList, setSessionList] = React.useState([]);
      const [memoryList, setMemoryList] = React.useState([]);
      const [skillList, setSkillList] = React.useState([]);
      const [run, setRun] = React.useState(null);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [selected, setSelected] = React.useState(() => new Set());
      const [filter, setFilter] = React.useState('');
      const [memoryFilter, setMemoryFilter] = React.useState('');
      const [inspecting, setInspecting] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [openMemory, setOpenMemory] = React.useState(null);
      const [openSkill, setOpenSkill] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      // memory layer
      const [topicList, setTopicList] = React.useState([]);
      const [factList, setFactList] = React.useState([]);
      const [invalidated, setInvalidated] = React.useState([]);
      const [factStats, setFactStats] = React.useState(null);
      const [showInvalidated, setShowInvalidated] = React.useState(false);
      const [recallQuery, setRecallQuery] = React.useState('');
      const [recallResult, setRecallResult] = React.useState(null);
      const [consolidating, setConsolidating] = React.useState(false);
      const [exporting, setExporting] = React.useState(false);
      // incremental live capture + self-check
      const [liveList, setLiveList] = React.useState([]);
      const [liveStats, setLiveStats] = React.useState(null);
      const [liveBusy, setLiveBusy] = React.useState(false);
      const [health, setHealth] = React.useState(null);
      const [checkReport, setCheckReport] = React.useState(null);
      const [checking, setChecking] = React.useState(false);
      const [mergeSkillsOn, setMergeSkillsOn] = React.useState(false);

      const loadStatus = React.useCallback(() => {
        return fetchView(API.status)
          .then((data) => {
            setStatus(data);
            setRun(data?.run ?? null);
            setDraft((current) => current ?? (data?.settings ? { ...data.settings } : null));
            setError('');
          })
          .catch((caught) => setError(String(caught?.message ?? caught)))
          .finally(() => setLoading(false));
      }, []);

      const loadSessions = React.useCallback(() => {
        return fetchView(API.sessions)
          .then((data) => setSessionList(Array.isArray(data?.sessions) ? data.sessions : []))
          .catch((caught) => setError(String(caught?.message ?? caught)));
      }, []);

      const loadMemories = React.useCallback(() => {
        return fetchView(API.memories)
          .then((data) => setMemoryList(Array.isArray(data?.memories) ? data.memories : []))
          .catch((caught) => setError(String(caught?.message ?? caught)));
      }, []);

      const loadSkills = React.useCallback(() => {
        return fetchView(API.skills)
          .then((data) => setSkillList(Array.isArray(data?.skills) ? data.skills : []))
          .catch((caught) => setError(String(caught?.message ?? caught)));
      }, []);

      const loadMemoryLayer = React.useCallback(() => {
        return fetchView(API.facts)
          .then((data) => {
            setTopicList(Array.isArray(data?.topics) ? data.topics : []);
            setFactList(Array.isArray(data?.facts) ? data.facts : []);
            setInvalidated(Array.isArray(data?.invalidated) ? data.invalidated : []);
            setFactStats(data?.stats ?? null);
          })
          .catch((caught) => setError(String(caught?.message ?? caught)));
      }, []);

      const loadLive = React.useCallback(() => {
        return fetchView(API.live)
          .then((data) => {
            setLiveList(Array.isArray(data?.sessions) ? data.sessions : []);
            setLiveStats({
              total: data?.total ?? 0,
              capturing: data?.capturing ?? 0,
              pending: data?.pending ?? 0,
              stats: data?.stats ?? null,
            });
          })
          .catch((caught) => setError(String(caught?.message ?? caught)));
      }, []);

      const loadHealth = React.useCallback(() => {
        return fetchView(API.health)
          .then((data) => setHealth(data ?? null))
          .catch((caught) => setError(String(caught?.message ?? caught)));
      }, []);

      React.useEffect(() => {
        loadStatus();
        loadSessions();
        loadMemories();
        loadSkills();
        loadMemoryLayer();
        loadLive();
        loadHealth();
      }, [loadStatus, loadSessions, loadMemories, loadSkills, loadMemoryLayer, loadLive, loadHealth]);

      // Poll only while a batch is running: a permanent interval here would spin
      // the machine for a panel nobody is looking at.
      const running = run && run.phase === 'running';
      React.useEffect(() => {
        if (!running) return undefined;
        const timer = setInterval(() => {
          fetchView(API.run)
            .then((data) => {
              setRun(data?.run ?? null);
              if (!data?.run || data.run.phase !== 'running') {
                loadStatus();
                loadSessions();
                loadMemories();
                loadSkills();
                loadLive();
              }
            })
            .catch(() => {});
        }, 1200);
        return () => clearInterval(timer);
      }, [running, loadStatus, loadSessions, loadMemories, loadSkills, loadLive]);

      const toggleSession = (sessionId) => {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(sessionId)) next.delete(sessionId);
          else next.add(sessionId);
          return next;
        });
      };

      const selectPending = () => {
        const pending = sessionList
          .filter((session) => session.present && !session.pinned && !session.cleanedAt && !session.digestedAt)
          .slice(0, 200);
        setSelected(new Set(pending.map((session) => session.sessionId)));
      };

      const startDigest = async (ids) => {
        setError('');
        setNotice('');
        try {
          const result = await postJson(API.digest, { sessionIds: ids });
          if (result?.started) {
            setNotice(`${t.progress}: ${result.count}`);
            setSelected(new Set());
            setTab('overview');
          } else {
            setNotice(String(result?.message ?? ''));
          }
          await loadStatus();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      };

      const runCleanup = async () => {
        if (!window.confirm(t.confirmCleanup)) return;
        setError('');
        setNotice('');
        try {
          const result = await postJson(API.cleanup, { allDigested: true, onlyDigested: true });
          setNotice(`${t.freed}: ${formatBytes(result?.freed)} (${result?.cleaned ?? 0})`);
          await Promise.all([loadStatus(), loadSessions()]);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      };

      const saveSettings = async (patch) => {
        setError('');
        setNotice('');
        try {
          const result = await postJson(API.settings, patch);
          if (result?.settings) setDraft({ ...result.settings });
          setNotice(t.saved);
          await loadStatus();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      };

      const inspect = async (sessionId) => {
        setInspecting(sessionId);
        setPreview(null);
        try {
          const result = await fetchView(withParams(API.inspect, { sessionId }));
          setPreview(result);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setInspecting('');
        }
      };

      const openMemoryDetail = async (sessionId) => {
        if (openMemory && openMemory.sessionId === sessionId) {
          setOpenMemory(null);
          return;
        }
        try {
          const result = await fetchView(withParams(API.memory, { sessionId }));
          setOpenMemory(result);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      };

      const openSkillDetail = async (slug) => {
        if (openSkill && openSkill.slug === slug) {
          setOpenSkill(null);
          return;
        }
        try {
          const result = await fetchView(withParams(API.skill, { name: slug }));
          setOpenSkill(result);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      };

      const counts = status?.counts ?? {};
      const settings = draft ?? status?.settings ?? {};
      const autoOn = settings.autoEnabled === true;

      const visibleSessions = React.useMemo(() => {
        const q = filter.trim().toLowerCase();
        const list = sessionList.filter((session) => {
          if (q === '') return true;
          return `${session.sessionId} ${session.digestTitle ?? ''} ${session.workspaceSlug ?? ''}`.toLowerCase().includes(q);
        });
        // Unhandled first — that is what the user came here to act on.
        return list.sort((a, b) => {
          const rank = (session) => (session.cleanedAt ? 3 : session.digestedAt ? 2 : session.present ? 0 : 1);
          return rank(a) - rank(b) || (b.bytes || 0) - (a.bytes || 0);
        });
      }, [sessionList, filter]);

      const visibleMemories = React.useMemo(() => {
        const q = memoryFilter.trim().toLowerCase();
        if (q === '') return memoryList;
        return memoryList.filter((entry) => `${entry.title} ${entry.summary} ${(entry.tags ?? []).join(' ')}`.toLowerCase().includes(q));
      }, [memoryList, memoryFilter]);

      const overview = h(React.Fragment, null,
        h('div', { className: 'ad-card' },
          h('div', { className: 'ad-row' },
            h('div', { className: 'ad-card-title', style: { flex: '1 1 auto' } }, t.title),
            autoOn
              ? h('span', { className: 'ad-tag ad-tag-ok' }, t.autoOn)
              : h('span', { className: 'ad-tag ad-tag-mute' }, t.autoOff),
            status?.llm && status.llm.ready
              ? h('span', { className: 'ad-tag ad-tag-ok' }, t.llmReady)
              : h('span', { className: 'ad-tag ad-tag-err', title: status?.llm?.note ?? '' }, t.llmNotReady),
          ),
          h('div', { className: 'ad-stats' },
            h(Stat, { label: t.statArchived, value: formatCount(counts.archived) }),
            h(Stat, { label: t.statLogs, value: formatBytes(status?.bytes?.archivedLogs) }),
            h(Stat, { label: t.statDigested, value: formatCount(counts.memories) }),
            h(Stat, { label: t.statPending, value: formatCount(counts.pending) }),
            h(Stat, { label: t.statSkills, value: formatCount(counts.skills) }),
            h(Stat, { label: t.statFreed, value: formatBytes(status?.bytes?.freed) }),
          ),
          !autoOn ? h('div', { className: 'ad-hint' }, t.autoOffHint) : null,
          status?.llm && !status.llm.ready ? h('div', { className: 'ad-hint' }, t.llmHint) : null,
          h('div', { className: 'ad-kv' },
            h('span', { className: 'ad-kv-k' }, t.storeRoot),
            h('span', { className: 'ad-kv-v', title: status?.store?.root ?? '' }, status?.store?.root ?? t.empty),
            h('span', { className: 'ad-kv-k' }, t.allLogs),
            h('span', { className: 'ad-kv-v' }, `${formatBytes(status?.bytes?.allLogs)} · ${counts.present ?? 0}/${counts.archived ?? 0}`),
          ),
          h('div', { className: 'ad-row' },
            h('button', {
              type: 'button',
              className: 'ad-btn ad-btn-primary',
              disabled: running || (counts.pending ?? 0) === 0,
              onClick: () => startDigest([]),
            }, `${t.digestPending}${counts.pending ? ` (${counts.pending})` : ''}`),
            h('button', {
              type: 'button',
              className: 'ad-btn ad-btn-ghost',
              disabled: !running,
              onClick: () => postJson(API.stop, {}).catch((caught) => setError(String(caught?.message ?? caught))),
            }, t.stop),
            h('button', { type: 'button', className: 'ad-btn ad-btn-ghost', onClick: () => { loadStatus(); loadSessions(); loadMemories(); loadSkills(); } }, t.reload),
          ),
        ),

        running
          ? h('div', { className: 'ad-card' },
              h('div', { className: 'ad-row' },
                h('div', { className: 'ad-card-title', style: { flex: '1 1 auto' } }, t.progress),
                h('span', { className: 'ad-hint' }, `${run.done ?? 0}/${run.total ?? 0}`),
              ),
              h('div', { className: 'ad-progress' },
                h('div', {
                  className: 'ad-progress-fill',
                  style: { width: `${Math.min(100, Math.round((100 * (run.done ?? 0)) / Math.max(1, run.total ?? 1)))}%` },
                }),
              ),
              run.current ? h('div', { className: 'ad-hint' }, shortId(run.current)) : null,
              Array.isArray(run.results) && run.results.length > 0
                ? h('div', null, run.results.slice(-6).map((entry) => h('div', { className: 'ad-session-facts', key: entry.sessionId },
                    h('span', { className: entry.ok ? 'ad-tag ad-tag-ok' : 'ad-tag ad-tag-err' }, entry.code),
                    h('span', null, entry.title ?? shortId(entry.sessionId)),
                  )))
                : null,
            )
          : null,

        h('div', { className: 'ad-card' },
          h('div', { className: 'ad-card-title' }, t.cleanupTitle),
          h('div', { className: 'ad-hint' }, t.cleanupHint),
          h('div', { className: 'ad-row' },
            h('select', {
              className: 'ad-select',
              value: settings.cleanupMode ?? 'off',
              onChange: (event) => saveSettings({ cleanupMode: event.target.value }),
            },
              h('option', { value: 'off' }, t.cleanupModeOff),
              h('option', { value: 'logs' }, t.cleanupModeLogs),
              h('option', { value: 'dir' }, t.cleanupModeDir),
              h('option', { value: 'trash' }, t.cleanupModeTrash),
            ),
            h('input', {
              className: 'ad-input ad-input-num',
              type: 'number',
              min: 0,
              max: 3650,
              value: settings.cleanupMinAgeDays ?? 7,
              onChange: (event) => setDraft({ ...settings, cleanupMinAgeDays: Number(event.target.value) || 0 }),
              onBlur: (event) => saveSettings({ cleanupMinAgeDays: Number(event.target.value) || 0 }),
            }),
            h('span', { className: 'ad-hint' }, t.minAge),
            h('button', {
              type: 'button',
              className: 'ad-btn ad-btn-ghost ad-btn-danger',
              disabled: running || (counts.digested ?? 0) === 0 || (settings.cleanupMode ?? 'off') === 'off',
              onClick: runCleanup,
            }, t.cleanupRun),
          ),
        ),
      );

      const sessionsTab = h('div', { className: 'ad-card' },
        h('div', { className: 'ad-row' },
          h('div', { className: 'ad-card-title', style: { flex: '1 1 auto' } }, `${t.tabSessions} (${sessionList.length})`),
          h('span', { className: 'ad-hint' }, `${t.selected}: ${selected.size}`),
        ),
        h('div', { className: 'ad-row' },
          h('input', {
            className: 'ad-input',
            type: 'search',
            placeholder: t.filterSessions,
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
        ),
        h('div', { className: 'ad-row' },
          h('button', { type: 'button', className: 'ad-btn ad-btn-ghost', onClick: selectPending }, t.selectAll),
          h('button', { type: 'button', className: 'ad-btn ad-btn-ghost', onClick: () => setSelected(new Set()) }, t.selectNone),
          h('button', {
            type: 'button',
            className: 'ad-btn ad-btn-primary',
            disabled: running || selected.size === 0,
            onClick: () => startDigest([...selected]),
          }, `${t.digestSelected} (${selected.size})`),
        ),
        preview
          ? h('div', { className: 'ad-item' },
              h('div', { className: 'ad-item-title', onClick: () => setPreview(null) }, `${t.hideRaw} — ${shortId(preview.sessionId ?? '')}`),
              preview.ok
                ? h('div', null,
                    h('div', { className: 'ad-session-facts' },
                      h('span', null, `${preview.events} events`),
                      h('span', null, `${preview.keptTurns}/${preview.turns} turns`),
                      h('span', null, `${preview.chars} chars`),
                      Array.isArray(preview.toolNames) && preview.toolNames.length > 0 ? h('span', null, preview.toolNames.slice(0, 8).join(', ')) : null,
                    ),
                    h('div', { className: 'ad-pre' }, preview.preview ?? ''),
                  )
                : h('div', { className: 'ad-msg ad-msg-err' }, `${preview.code}: ${preview.message}`),
            )
          : null,
        visibleSessions.length === 0
          ? h('div', { className: 'ad-hint' }, t.noSessions)
          : visibleSessions.map((session) => h(SessionRow, {
              key: session.sessionId,
              session,
              checked: selected.has(session.sessionId),
              onToggle: toggleSession,
              onInspect: inspect,
              inspecting: inspecting === session.sessionId,
            })),
      );

      const consolidateNow = async () => {
        setConsolidating(true);
        setError('');
        setNotice('');
        try {
          const result = await postJson(API.consolidate, {});
          setNotice(`${t.consolidated}: ${result?.topics ?? 0}`);
          await loadMemoryLayer();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setConsolidating(false);
        }
      };

      const exportNow = async () => {
        setExporting(true);
        setError('');
        setNotice('');
        try {
          const result = await postJson(API.exportMemory, {});
          const ok = (result?.results ?? []).filter((entry) => entry.ok).length;
          const total = (result?.backends ?? []).length;
          setNotice(total === 0 ? t.backendsNone : `${t.exportMemory}: ${ok}/${total}`);
          // A backend that refuses is worth showing, not swallowing.
          const refused = (result?.results ?? []).find((entry) => !entry.ok);
          if (refused) setError(`${refused.backend}: ${refused.code} — ${refused.message}`);
          await loadStatus();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setExporting(false);
        }
      };

      const runRecall = async () => {
        setError('');
        try {
          const result = await fetchView(withParams(API.recall, { q: recallQuery.trim() }));
          setRecallResult(result);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      };

      /** Take the new part of a running session without touching its log. */
      const digestLiveNow = async (sessionId) => {
        setLiveBusy(true);
        setError('');
        setNotice('');
        try {
          const body = typeof sessionId === 'string' && sessionId !== ''
            ? { sessionIds: [sessionId], limit: 1 }
            : { limit: 2 };
          const result = await postJson(API.liveDigest, body);
          if (result?.started === false) {
            setNotice(result.message ?? t.liveNothing);
          } else {
            setNotice(`${t.liveStarted}: ${result?.count ?? 0}`);
            setTab('overview');
            await loadStatus();
          }
          await loadLive();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setLiveBusy(false);
        }
      };

      /**
       * Run the self-check.
       *
       * `apply: false` is the default and the button says so, because a compaction
       * that can retire facts must be inspectable before it runs. The report is kept
       * on screen either way — that is what makes the next decision possible.
       */
      const runSelfCheck = async ({ apply = false, mergeSkills = false, purgeTrash = false } = {}) => {
        if (apply && !window.confirm(t.confirmSelfCheck)) return;
        setChecking(true);
        setError('');
        setNotice('');
        try {
          const result = await postJson(API.selfCheck, { apply, mergeSkills, purgeTrash });
          setCheckReport(result ?? null);
          if (apply) {
            setNotice(`${t.selfCheckApplied}: ${result?.facts?.retiredDuplicates ?? 0} ${t.selfCheckFacts}`);
            await loadMemoryLayer();
            await loadStatus();
            await loadHealth();
          } else {
            setNotice(t.selfCheckReported);
          }
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setChecking(false);
        }
      };

      const forgetOneFact = async (id) => {
        if (!window.confirm(t.confirmForgetFact)) return;
        setError('');
        try {
          await postJson(API.forgetFact, { id });          await loadMemoryLayer();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      };

      const memoriesTab = h('div', { className: 'ad-card' },
        h('div', { className: 'ad-row' },
          h('div', { className: 'ad-card-title', style: { flex: '1 1 auto' } }, `${t.tabMemories} (${memoryList.length})`),
        ),
        h('div', { className: 'ad-row' },
          h('input', {
            className: 'ad-input',
            type: 'search',
            placeholder: t.search,
            value: memoryFilter,
            onChange: (event) => setMemoryFilter(event.target.value),
          }),
          h('button', { type: 'button', className: 'ad-btn ad-btn-ghost', onClick: loadMemories }, t.reload),
        ),
        visibleMemories.length === 0
          ? h('div', { className: 'ad-hint' }, t.memoriesEmpty)
          : visibleMemories.map((entry) => h('div', { className: 'ad-item', key: entry.sessionId },
              h('div', { className: 'ad-item-title', onClick: () => openMemoryDetail(entry.sessionId) }, entry.title),
              h('div', { className: 'ad-session-facts' },
                h('span', null, formatBytes(entry.chars)),
                h('span', null, relativeDate(entry.digestedAt)),
                Array.isArray(entry.tags) ? entry.tags.slice(0, 6).map((tag) => h('span', { className: 'ad-tag', key: tag }, tag)) : null,
                h('span', { className: 'ad-hint' }, `${t.memorySource}: ${shortId(entry.sessionId)}`),
              ),
              entry.summary ? h('div', { className: 'ad-item-body' }, entry.summary) : null,
              openMemory && openMemory.entry && openMemory.entry.sessionId === entry.sessionId
                ? h('div', { className: 'ad-pre' }, openMemory.text ?? '')
                : null,
            )),
      );

      // ── consolidated topics ──
      const topicsTab = h('div', { className: 'ad-card' },
        h('div', { className: 'ad-row' },
          h('div', { className: 'ad-card-title', style: { flex: '1 1 auto' } },
            `${t.tabTopics} (${topicList.length})`),
          h('button', {
            type: 'button',
            className: 'ad-btn ad-btn-primary',
            disabled: consolidating,
            onClick: consolidateNow,
          }, consolidating ? t.consolidating : t.consolidate),
          h('button', {
            type: 'button',
            className: 'ad-btn ad-btn-ghost',
            disabled: exporting,
            onClick: exportNow,
          }, exporting ? t.exporting : t.exportMemory),
        ),
        h('div', { className: 'ad-hint' }, t.factsHint),
        // Backend detection is per composition; say plainly when there is none
        // rather than offering an export that cannot go anywhere.
        (() => {
          const ids = status?.memory?.backends ?? [];
          return ids.length === 0
            ? h('div', { className: 'ad-hint' }, t.backendsNone)
            : h('div', { className: 'ad-session-facts' },
                h('span', { className: 'ad-hint' }, t.backendsTitle),
                ids.map((id) => h('span', { className: 'ad-tag ad-tag-ok', key: id }, id)),
              );
        })(),
        h('div', { className: 'ad-row' },
          h('input', {
            className: 'ad-input',
            type: 'search',
            placeholder: t.recallPlaceholder,
            value: recallQuery,
            onChange: (event) => setRecallQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') runRecall(); },
          }),
          h('button', { type: 'button', className: 'ad-btn', onClick: runRecall }, t.recallRun),
        ),
        recallResult
          ? h('div', { className: 'ad-item' },
              h('div', { className: 'ad-item-title' },
                `${t.recallHits}: ${(recallResult.topics?.length ?? 0) + (recallResult.facts?.length ?? 0)}`),
              (recallResult.facts ?? []).length === 0
                ? h('div', { className: 'ad-hint' }, t.recallEmpty)
                : (recallResult.facts ?? []).map((fact) => h('div', { className: 'ad-session-facts', key: fact.id },
                    h('span', { className: 'ad-tag' }, fact.kind),
                    h('span', { className: 'ad-tag ad-tag-ok' }, `${t.strength} ${fact.strength}`),
                    h('span', null, fact.text),
                  )),
            )
          : null,
        topicList.length === 0
          ? h('div', { className: 'ad-hint' }, t.topicsEmpty)
          : topicList.map((topic) => h('div', { className: 'ad-item', key: topic.id },
              h('div', { className: 'ad-item-title' }, topic.label),
              h('div', { className: 'ad-session-facts' },
                h('span', { className: 'ad-tag ad-tag-ok' }, `${topic.factIds?.length ?? 0} ${t.topicFacts}`),
                h('span', { className: 'ad-tag' }, `${t.strength} ${topic.strength}`),
                (topic.kinds ?? []).map((kind) => h('span', { className: 'ad-tag ad-tag-mute', key: kind }, kind)),
                h('span', null, relativeDate(topic.updatedAt)),
              ),
              h('div', { className: 'ad-pre' }, topic.body ?? ''),
            )),
      );

      // ── fact ledger ──
      const factsTab = h('div', { className: 'ad-card' },
        h('div', { className: 'ad-row' },
          h('div', { className: 'ad-card-title', style: { flex: '1 1 auto' } },
            `${t.tabFacts} (${factList.length})`),
          h('button', { type: 'button', className: 'ad-btn ad-btn-ghost', onClick: loadMemoryLayer }, t.reload),
          h('button', {
            type: 'button',
            className: 'ad-btn ad-btn-ghost',
            onClick: () => setShowInvalidated((current) => !current),
          }, showInvalidated ? t.hideInvalidated : `${t.showInvalidated} (${invalidated.length})`),
        ),
        factStats
          ? h('div', { className: 'ad-session-facts' },
              h('span', { className: 'ad-tag ad-tag-ok' }, `${t.statFacts} ${factStats.live}`),
              h('span', { className: 'ad-tag ad-tag-mute' }, `${t.invalidated} ${factStats.invalidated}`),
              (factStats.byKind ? Object.entries(factStats.byKind) : []).map(([kind, count]) =>
                h('span', { className: 'ad-tag', key: kind }, `${kind} ${count}`)),
            )
          : null,
        factList.length === 0
          ? h('div', { className: 'ad-hint' }, t.factsEmpty)
          : factList.map((fact) => h('div', { className: 'ad-item', key: fact.id },
              h('div', { className: 'ad-item-body' }, fact.text),
              h('div', { className: 'ad-session-facts' },
                h('span', { className: 'ad-tag ad-tag-mute' }, fact.kind),
                h('span', { className: 'ad-tag ad-tag-ok' }, `${t.strength} ${fact.strength}`),
                h('span', { className: 'ad-hint' }, `^${fact.id}`),
                (fact.sources ?? []).slice(0, 5).map((source) => h('span', { className: 'ad-tag', key: source }, shortId(source))),
                h('button', {
                  type: 'button',
                  className: 'ad-btn ad-btn-ghost ad-btn-danger',
                  onClick: () => forgetOneFact(fact.id),
                }, t.forgerFact),
              ),
            )),
        showInvalidated
          ? h('div', { className: 'ad-card' },
              h('div', { className: 'ad-card-title' }, `${t.invalidated} (${invalidated.length})`),
              invalidated.length === 0
                ? h('div', { className: 'ad-hint' }, t.invalidatedEmpty)
                : invalidated.map((fact) => h('div', { className: 'ad-item', key: fact.id },
                    h('div', { className: 'ad-item-body' }, fact.text),
                    h('div', { className: 'ad-session-facts' },
                      h('span', { className: 'ad-tag ad-tag-mute' }, fact.kind),
                      h('span', { className: 'ad-hint' }, `^${fact.id} → ${fact.supersededBy ?? '—'}`),
                      h('span', null, relativeDate(fact.validUntil)),
                    ),
                  )),
            )
          : null,
      );

      const skillsTab = h('div', { className: 'ad-card' },
        h('div', { className: 'ad-row' },
          h('div', { className: 'ad-card-title', style: { flex: '1 1 auto' } }, `${t.tabSkills} (${skillList.length})`),
          h('button', { type: 'button', className: 'ad-btn ad-btn-ghost', onClick: loadSkills }, t.reload),
        ),
        skillList.length === 0
          ? h('div', { className: 'ad-hint' }, t.skillsEmpty)
          : skillList.map((entry) => h('div', { className: 'ad-item', key: entry.slug },
              h('div', { className: 'ad-item-title', onClick: () => openSkillDetail(entry.slug) }, entry.title || entry.slug),
              h('div', { className: 'ad-item-body' }, entry.description ?? ''),
              h('div', { className: 'ad-session-facts' },
                // The skill only becomes usable by the agent once it is published
                // into $DSH_HOME/skills. Say so when that did not happen, or the
                // panel would list a skill that nothing else can load.
                entry.mirrorError === 'MIRROR_OCCUPIED'
                  ? h('span', { className: 'ad-tag ad-tag-warn', title: t.mirrorOccupied }, t.mirrorOccupied)
                  : entry.mirrorError
                    ? h('span', { className: 'ad-tag ad-tag-err', title: String(entry.mirrorError) }, t.mirrorFailed)
                    : entry.mirror
                      ? h('span', { className: 'ad-tag ad-tag-ok', title: entry.mirror }, t.mirrorOk)
                      : null,
                Array.isArray(entry.sources) ? entry.sources.slice(0, 5).map((source) => h('span', { className: 'ad-tag', key: source }, shortId(source))) : null,
                h('span', null, relativeDate(entry.updatedAt)),
              ),
              openSkill && openSkill.entry && openSkill.entry.slug === entry.slug
                ? h('div', { className: 'ad-pre' }, openSkill.text ?? '')
                : null,
            )),
      );

      /**
       * Live tab: running sessions and what part of each is already in memory.
       *
       * The whole tab is built around one promise the server keeps — the log is
       * only ever read — so the hint says so plainly and every row shows how far
       * the watermark has advanced instead of a vague "done" badge.
       */
      const liveTab = h('div', { className: 'ad-card' },
        h('div', { className: 'ad-card-title' }, t.tabLive),
        h('div', { className: 'ad-hint' }, t.liveHint),
        h('div', { className: 'ad-stats' },
          h(Stat, { label: t.liveTotal, value: String(liveStats?.total ?? 0) }),
          h(Stat, { label: t.liveCaptured, value: String(liveStats?.capturing ?? 0) }),
          h(Stat, { label: t.livePending, value: String(liveStats?.pending ?? 0) }),
        ),
        h('div', { className: 'ad-toolbar' },
          h('button', {
            type: 'button',
            className: 'ad-btn',
            disabled: liveBusy || (liveStats?.pending ?? 0) === 0,
            onClick: () => digestLiveNow(),
          }, t.liveDigestSome),
          h('button', { type: 'button', className: 'ad-btn ad-btn-ghost', onClick: loadLive }, t.reload),
        ),
        liveList.length === 0
          ? h('div', { className: 'ad-hint' }, t.liveEmpty)
          : h('div', { className: 'ad-list' },
            liveList.slice(0, 60).map((session) => h('div', { className: 'ad-session', key: session.sessionId },
              h('div', { className: 'ad-session-main' },
                h('div', { className: 'ad-session-id', title: session.sessionId },
                  session.title ? String(session.title) : shortId(session.sessionId)),
                h('div', { className: 'ad-session-facts' },
                  h('span', { className: session.upToDate ? 'ad-tag ad-tag-ok' : 'ad-tag ad-tag-warn' },
                    session.upToDate ? t.liveUpToDate : `${t.livePending} ${formatBytes(session.pendingBytes)}`),
                  h('span', { className: 'ad-tag ad-tag-ok', title: t.liveHint }, t.liveReadOnly),
                  session.lastSeq > 0 ? h('span', null, `${t.liveSeq} seq ${session.lastSeq}`) : null,
                  session.totalTurns > 0 ? h('span', null, `${session.totalTurns} ${t.liveTurns}`) : null,
                  session.segments > 0 ? h('span', null, `${session.segments}×`) : null,
                  h('span', null, formatBytes(session.bytes)),
                  session.mtimeMs ? h('span', null, relativeDate(new Date(session.mtimeMs).toISOString())) : null,
                  session.pinned ? h('span', { className: 'ad-tag ad-tag-warn' }, t.statePinned) : null,
                ),
              ),
              h('button', {
                type: 'button',
                className: 'ad-btn ad-btn-ghost',
                disabled: liveBusy || session.pinned,
                onClick: () => digestLiveNow(session.sessionId),
              }, t.liveDigestOne),
            )),
          ),
      );

      /**
       * Self-check tab.
       *
       * Two distinct buttons on purpose: measuring is free and safe, compacting
       * changes stored memory. Keeping them separate is what lets the user see the
       * plan before authorising it.
       */
      const reportCard = (() => {
        if (checkReport === null) return null;
        const facts = checkReport.facts ?? {};
        const skills = checkReport.skills ?? {};
        const catalog = skills.catalog ?? {};
        return h('div', { className: 'ad-subcard' },
          h('div', { className: 'ad-subcard-title' }, checkReport.applied ? t.selfCheckApplied : t.selfCheckReported),
          h('div', { className: 'ad-stats' },
            h(Stat, { label: t.selfCheckFacts, value: String(facts.retiredDuplicates ?? 0) }),
            h(Stat, { label: t.selfCheckSkills, value: String(skills.redundantCount ?? 0) }),
            h(Stat, { label: t.selfCheckStale, value: String(facts.stalePruned ?? 0) }),
            h(Stat, { label: t.selfCheckCatalog, value: `${catalog.skills ?? 0} / ~${catalog.tokens ?? 0} tok` }),
            h(Stat, { label: t.selfCheckTrash, value: formatBytes(checkReport.trash?.freed || checkReport.trash?.pendingBytes || 0) }),
          ),
          facts.before || facts.after
            ? h('div', { className: 'ad-session-facts' },
              h('span', { className: 'ad-tag ad-tag-ok' },
                `${t.tabFacts}: ${facts.before?.live ?? 0} → ${facts.after?.live ?? 0}`),
              h('span', null, `${t.tabTopics}: ${facts.after?.topics ?? 0}`),
              h('span', null, facts.retiredDuplicates > 0 ? t.selfCheckFacts : t.selfCheckNone),
            )
            : null,
        );
      })();

      const mergeToggle = h('label', { className: 'ad-check-row' },
        h('input', {
          type: 'checkbox',
          className: 'ad-check',
          checked: mergeSkillsOn,
          onChange: (event) => setMergeSkillsOn(event.target.checked === true),
        }),
        h('span', null, t.selfCheckMergeSkills),
      );

      const selfCheckTab = h('div', { className: 'ad-card' },
        h('div', { className: 'ad-card-title' }, t.tabSelfCheck),
        h('div', { className: 'ad-hint' }, t.selfCheckHint),
        h('div', { className: 'ad-stats' },
          h(Stat, { label: t.tabFacts, value: String(health?.facts?.live ?? status?.counts?.facts ?? 0) }),
          h(Stat, { label: t.tabTopics, value: String(health?.facts?.topics ?? status?.counts?.topics ?? 0) }),
          h(Stat, { label: t.tabSkills, value: String(health?.skills?.skills ?? status?.counts?.skills ?? 0) }),
          h(Stat, { label: t.selfCheckCatalog, value: `~${health?.skills?.tokens ?? 0} tok` }),
        ),
        h('div', { className: 'ad-toolbar' },
          h('button', {
            type: 'button',
            className: 'ad-btn ad-btn-ghost',
            disabled: checking,
            onClick: () => runSelfCheck({ apply: false }),
          }, t.selfCheckRun),
          h('button', {
            type: 'button',
            className: 'ad-btn',
            disabled: checking,
            onClick: () => runSelfCheck({ apply: true, mergeSkills: mergeSkillsOn }),
          }, t.selfCheckApply),
        ),
        mergeToggle,
        reportCard,
      );

      const settingsTab = h('div', { className: 'ad-card' },
        h('div', { className: 'ad-card-title' }, t.settingsTitle),
        h(Switch, {
          checked: autoOn,
          label: t.setAuto,
          hint: t.setAutoHint,
          onChange: (next) => saveSettings({ autoEnabled: next }),
        }),
        h('div', { className: 'ad-row' },
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setInterval),
          h('input', {
            className: 'ad-input ad-input-num',
            type: 'number', min: 5, max: 1440,
            value: settings.autoIntervalMinutes ?? 30,
            onChange: (event) => setDraft({ ...settings, autoIntervalMinutes: Number(event.target.value) || 30 }),
            onBlur: (event) => saveSettings({ autoIntervalMinutes: Number(event.target.value) || 30 }),
          }),
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setMaxPerRun),
          h('input', {
            className: 'ad-input ad-input-num',
            type: 'number', min: 1, max: 20,
            value: settings.autoMaxPerRun ?? 3,
            onChange: (event) => setDraft({ ...settings, autoMaxPerRun: Number(event.target.value) || 3 }),
            onBlur: (event) => saveSettings({ autoMaxPerRun: Number(event.target.value) || 3 }),
          }),
        ),
        h(Switch, {
          checked: settings.autoRetryFailed !== false,
          label: t.setRetry,
          onChange: (next) => saveSettings({ autoRetryFailed: next }),
        }),
        h(Switch, {
          checked: settings.extractSkills !== false,
          label: t.setExtractSkills,
          onChange: (next) => saveSettings({ extractSkills: next }),
        }),
        h(Switch, {
          checked: settings.extractFacts !== false,
          label: t.setExtractFacts,
          hint: t.setExtractFactsHint,
          onChange: (next) => saveSettings({ extractFacts: next }),
        }),
        h(Switch, {
          checked: settings.autoConsolidate !== false,
          label: t.setAutoConsolidate,
          onChange: (next) => saveSettings({ autoConsolidate: next }),
        }),
        h(Switch, {
          checked: settings.exportToBackend !== false,
          label: t.setExport,
          hint: t.setExportHint,
          onChange: (next) => saveSettings({ exportToBackend: next }),
        }),
        // Live capture is opt-in and costs a model call per session: on a machine
        // with hundreds of unarchived sessions, turning it on silently would be
        // an expensive surprise.
        h(Switch, {
          checked: settings.captureLiveSessions === true,
          label: t.setLive,
          hint: t.setLiveHint,
          onChange: (next) => saveSettings({ captureLiveSessions: next }),
        }),
        h('div', { className: 'ad-row' },
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setLiveMax),
          h('input', {
            className: 'ad-input ad-input-num',
            type: 'number', min: 1, max: 20,
            value: settings.liveMaxPerRun ?? 2,
            onChange: (event) => setDraft({ ...settings, liveMaxPerRun: Number(event.target.value) || 1 }),
            onBlur: (event) => saveSettings({ liveMaxPerRun: Number(event.target.value) || 1 }),
          }),
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setLiveSettle),
          h('input', {
            className: 'ad-input ad-input-num',
            type: 'number', min: 10, max: 86400,
            value: settings.liveSettleSeconds ?? 90,
            onChange: (event) => setDraft({ ...settings, liveSettleSeconds: Number(event.target.value) || 90 }),
            onBlur: (event) => saveSettings({ liveSettleSeconds: Number(event.target.value) || 90 }),
          }),
          h('span', { className: 'ad-hint' }, t.setLiveSettleHint),
        ),
        h('div', { className: 'ad-row' },
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setCleanupMode),
          h('select', {
            className: 'ad-select',
            value: settings.cleanupMode ?? 'off',
            onChange: (event) => saveSettings({ cleanupMode: event.target.value }),
          },
            h('option', { value: 'off' }, t.cleanupModeOff),
            h('option', { value: 'logs' }, t.cleanupModeLogs),
            h('option', { value: 'dir' }, t.cleanupModeDir),
            h('option', { value: 'trash' }, t.cleanupModeTrash),
          ),
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setMinAge),
          h('input', {
            className: 'ad-input ad-input-num',
            type: 'number', min: 0, max: 3650,
            value: settings.cleanupMinAgeDays ?? 7,
            onChange: (event) => setDraft({ ...settings, cleanupMinAgeDays: Number(event.target.value) || 0 }),
            onBlur: (event) => saveSettings({ cleanupMinAgeDays: Number(event.target.value) || 0 }),
          }),
        ),
        h('div', { className: 'ad-row' },
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setProvider),
          h('input', {
            className: 'ad-input',
            type: 'text',
            value: settings.provider ?? '',
            placeholder: 'deepseek-official',
            onChange: (event) => setDraft({ ...settings, provider: event.target.value }),
            onBlur: (event) => saveSettings({ provider: event.target.value }),
          }),
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setModel),
          h('input', {
            className: 'ad-input',
            type: 'text',
            value: settings.model ?? '',
            placeholder: 'deepseek-v4-flash',
            onChange: (event) => setDraft({ ...settings, model: event.target.value }),
            onBlur: (event) => saveSettings({ model: event.target.value }),
          }),
        ),
        h('div', { className: 'ad-row' },
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setMaxChars),
          h('input', {
            className: 'ad-input ad-input-num',
            type: 'number', min: 2000, max: 120000, step: 1000,
            value: settings.maxSourceChars ?? 14000,
            onChange: (event) => setDraft({ ...settings, maxSourceChars: Number(event.target.value) || 14000 }),
            onBlur: (event) => saveSettings({ maxSourceChars: Number(event.target.value) || 14000 }),
          }),
          h('span', { className: 'ad-hint', style: { flex: '0 0 auto' } }, t.setMaxTokens),
          h('input', {
            className: 'ad-input ad-input-num',
            type: 'number', min: 400, max: 16000, step: 100,
            value: settings.maxTokens ?? 2400,
            onChange: (event) => setDraft({ ...settings, maxTokens: Number(event.target.value) || 2400 }),
            onBlur: (event) => saveSettings({ maxTokens: Number(event.target.value) || 2400 }),
          }),
        ),
        h('div', { className: 'ad-hint' }, t.llmHint),
      );

      return h('div', { className: 'ad-view', 'data-dsh-plugin': PANEL_ID },
        h('style', null, CSS),
        h('div', { className: 'ad-head' },
          h('div', { className: 'ad-title-row' },
            h('div', { className: 'ad-title' }, t.title),
            h('button', { type: 'button', className: 'ad-btn ad-btn-ghost', onClick: loadStatus }, t.reload),
          ),
          h('div', { className: 'ad-sub' }, t.subtitle),
        ),
        h('div', { className: 'ad-tabs' },
          ['overview', 'sessions', 'live', 'topics', 'facts', 'memories', 'skills', 'selfcheck', 'settings'].map((key) => h('button', {
            type: 'button',
            key,
            className: `ad-tab${tab === key ? ' ad-tab-on' : ''}`,
            onClick: () => setTab(key),
          }, {
            overview: t.tabOverview,
            sessions: `${t.tabSessions}${sessionList.length > 0 ? ` (${sessionList.length})` : ''}`,
            live: `${t.tabLive}${(liveStats?.pending ?? 0) > 0 ? ` (${liveStats.pending})` : ''}`,
            topics: `${t.tabTopics}${topicList.length > 0 ? ` (${topicList.length})` : ''}`,
            facts: `${t.tabFacts}${factList.length > 0 ? ` (${factList.length})` : ''}`,
            memories: `${t.tabMemories}${memoryList.length > 0 ? ` (${memoryList.length})` : ''}`,
            skills: `${t.tabSkills}${skillList.length > 0 ? ` (${skillList.length})` : ''}`,
            selfcheck: t.tabSelfCheck,
            settings: t.tabSettings,
          }[key])),
        ),
        error !== '' ? h('div', { className: 'ad-msg ad-msg-err' }, error) : null,
        notice !== '' ? h('div', { className: 'ad-msg ad-msg-ok' }, notice) : null,
        loading ? h('div', { className: 'ad-hint' }, t.loading) : null,
        tab === 'overview' ? overview : null,
        tab === 'sessions' ? sessionsTab : null,
        tab === 'live' ? liveTab : null,
        tab === 'topics' ? topicsTab : null,
        tab === 'facts' ? factsTab : null,
        tab === 'memories' ? memoriesTab : null,
        tab === 'skills' ? skillsTab : null,
        tab === 'selfcheck' ? selfCheckTab : null,
        tab === 'settings' ? settingsTab : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = [];
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => t.entry,
        }, PanelIcon)));
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, PanelPage)));

        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) {
            try { dispose(); } catch { /* already released */ }
          }
        }, `${NS}: panel registrations`);
      },
    };
  },
});
