# dsh-archived-digest · 归档会话提炼

把**已归档的会话**压缩成一条条记忆和可复用技能，统一存放管理；再可选地回收那些日志占用的磁盘空间。自动清理可以整个关掉，也可以手动挑选要提炼哪几个归档会话。

DSH 的归档只是把会话从列表里收起来——日志文件仍然完整躺在 `$DSH_HOME/sessions/` 下，一条都不少。本机实测：**77 条归档会话占 411 MB**，其中绝大部分是重复的流式 chunk、工具结果、推理块，以及每一轮都被重新注入的环境说明。这些内容对后来的会话毫无价值，但它们一直占着磁盘，而且在归档列表里堆成一片噪音。

这个插件做的事很直接：把每个归档会话读一遍，只留下值得留的部分（结论、决策、坑、可复用的做法），写成人类和 agent 都能读的 markdown，然后把日志删掉。**提炼在前，删除在后**，顺序在代码里是强制的。

## 记忆层：事实、时效、主题

逐会话的摘要够用来"留个记录"，但不够用来"回忆"：77 个会话就是 77 段各自讲一角的文字，而真正想知道的是「这个项目我到底知道些什么」。

所以提炼之后还有一层，参考了社区里已经跑通的做法：

- **事实级写入（mem0）**——把每个会话的结论拆成一条条事实，逐条决定 `ADD / UPDATE / NOOP`。同一件事换个说法说是 **UPDATE**（旧结论标 `validUntil` 退役，不删），一模一样是 **NOOP**（只刷新 `lastSeenAt`），只有新话题才 **ADD**。这样纠正过的结论不会和错误的旧结论并排躺着。</br>参考：[mem0 的 ADD/UPDATE/DELETE 抽取管线](https://github.com/mem0ai/mem0)
- **时效而非覆盖（Zep/Graphiti）**——退役的事实保留 `validUntil` 和 `supersededBy`，所以"八月时我们以为是什么"仍然答得出来。</br>参考：[Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- **主题聚合**——事实按主题聚成尽量少的几块，每块正文里的每个条目都带 `^f00012` 这样的出处，可以追回产生它的会话。整合是**幂等**的：主题是事实的纯函数，跑两遍不会变成两份。
- **可选导出**——检测到本机装了记忆插件（OpenViking / Mnemon）时可以把聚合结果推过去；**本地台账始终是真相源**，推送失败只记录原因，不回写。

聚合这一层有两个坑，都靠能在真实台账上跑的数字才发现：

1. **拿候选事实去和「簇里所有成员拼起来的长文本」比相似度是自毁的**。候选只有一句话，而簇的文本随成员增加而变长，共享词占比反而下降——簇越大越难加入，正好反了。改成**最近成员（single-linkage）**：一个事实只要和簇里任何一条足够像就算同一主题。修前实测 `127/156` 个主题只含一条事实，等于没聚合。
2. **光靠字面相似度根本跨不了会话**。事实来自不同会话时，讲同一件事也常常不共享任何字：「碰撞体穿透」vs「ShipHullCollision 扫掠」的字面重合远低于任何阈值。所以每个事实还带一个**主题名（subject）**——由该会话记忆的标题给出——同一会话的事实天然同主题；老台账里没有主题名的事实会在整合时用标题回填一次。修后同一台账是 `188/188` 个事实进入多事实主题、共 7 个主题。

跑 `node scripts/clustermetric.mjs` 可以直接在真实 `facts.json` 上打出聚类分布——区分「在聚合」和「没在聚合」只能靠这个数。

相似度用的是免 embedding 的混合度量（拉丁词 Dice + 中文**单字** Dice）。这里踩过一个坑：最初用中文二元组，结果是「日志要先按 magic 切帧」和「日志需要按 magic bytes 切帧」只得了 0.33——人类的同义复述被判定为不同事实。换成单字集合后同一对是 0.77，而不相干的两句稳定在 0.05 以下。阈值因此落在 0.5（合并）与 0.3（聚类）这两个空档里。

## 它产出什么

```
$DSH_HOME/archived-digest/
├── memories/          # 一个归档会话 → 一条记忆 <slug>.md
│   ├── <slug>.md
│   └── index.json
├── skills/            # 可复用的做法 → 一个技能 <name>/SKILL.md
│   ├── <name>/SKILL.md
│   └── index.json
├── facts.json         # 事实台账（含 validUntil 历史）+ 聚合出的主题
├── trash/             # cleanupMode=trash 时的回收站
├── state.json         # 哪些提炼过 / 失败过 / 清理过
└── settings.json      # 面板里的设置（唯一真相）
```

技能同时**发布一份**到 `$DSH_HOME/skills/<name>/SKILL.md`——这是技能中心和 agent 技能目录扫描的位置。只写在插件自己的目录里，技能就只会在本面板里可见，agent 永远加载不到（这个缺口在开发时抓到并补掉了，见 `scripts/mirrortest.mjs`）。发布失败（比如同名技能是你手写的）不会覆盖对方的文件，面板里会标成「同名技能已存在，未覆盖」。

## 面板

左侧栏多一个「归档会话提炼」入口（`order: 12`，在 github-manager 之后），七个标签页：

- **总览** — 归档条数、磁盘占用、提炼进度、自动开关状态、最近几次跑批记录。
- **归档会话** — 一列所有归档会话，带状态徽章（待提炼 / 已提炼 / 已清理 / 失败 / 缺失 / 已固定）。前有复选框，可以手动勾选要提炼哪几个；顶部有「全选待提炼」「提炼所选」。
- **主题记忆** — 聚合出的主题，每个条目带 `^f00001` 出处；顶部有「重新整合」「导出到记忆后端」和检索框。
- **事实** — 事实台账：文本、类型、强度、出处；「显示已失效」展开被取代的旧事实（带 `→ 新 id`）；每条可以「忘记」（唯一会真正删行的操作，会二次确认）。
- **记忆** — 逐会话的 markdown 记忆，可搜索、可展开看原文。
- **技能** — 已提炼的技能，标注是否已发布到技能中心。
- **设置** — 下面那些开关，改完即存。

## 设置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `autoEnabled` | `false` | 后台自动提炼总开关。**默认关闭**，因为提炼要花 token |
| `autoIntervalMinutes` | `30` | 自动跑批间隔 |
| `autoMaxPerRun` | `3` | 每次自动跑批最多提炼几个会话（串行，避免抢你交互的 token） |
| `autoRetryFailed` | `true` | 失败过的会话下次是否重试（最多 3 次） |
| `cleanupMode` | `'off'` | 提炼成功后怎么处理日志：`off` / `logs`（只删 `.zstd`）/ `dir`（删整个会话目录）/ `trash`（丢回收站） |
| `cleanupMinAgeDays` | `7` | 只清理**日志 mtime** 超过这么多天的会话 |
| `extractSkills` | `true` | 是否顺带提炼可复用技能 |
| `extractFacts` | `true` | 是否把结论拆成事实行进台账（去重/可被取代） |
| `autoConsolidate` | `true` | 提炼后是否自动重算主题 |
| `exportToBackend` | `true` | 整合后是否推给已挂载的记忆插件（没有就跳过） |
| `captureLiveSessions` | `false` | 是否也提炼**未归档**的实时会话（见下节） |
| `liveMaxPerRun` | `2` | 每次自动跑批最多提炼几个实时会话 |
| `liveSettleSeconds` | `90` | 实时会话静默多少秒后算结束 |
| `maxSourceChars` | `14000` | 送给模型的原始转录上限（从尾部往前截，结论在尾部） |
| `maxTokens` | `2400` | 模型输出上限 |
| `provider` / `model` | 空 | 自动跑批用哪条路由；留空则按 provider 注册顺序兜底 |

三处需要强调：

**自动提炼默认是关的。** 关着的时候调度器仍然每 60 秒醒一次，但只读设置、什么都不做。要它自己干活，得在面板里打开。

**`cleanupMode` 默认 `'off'`。** 提炼完不会自动删任何东西，直到你显式选一种清理模式。即使选了，也只会动**已经有记忆落盘**的会话——没有记忆的会话会被拒绝（`NOT_DIGESTED`），除非走强制路径。

**`captureLiveSessions` 默认 `false`。** 见下节。

## 实时会话：为什么「刚聊完的」原来不在范围内

这是个容易被忽略的边界：**没有归档的会话，本插件看不到。** 归档动作由你触发，所以一段刚结束的对话要等你归档它才可能进记忆——而大多数人从不归档，于是记忆一直是空的。本机实测：某天写了 11 个会话，其中归档数为 **0**；全机 502 个会话里只有 77 个是归档的。

打开「提炼实时会话」后，本插件会把**已静默**的未归档会话也当作提炼对象。

**不需要任何会话钩子。** 这一点是实测出来的，不是猜的：正在进行的会话，它在磁盘上的日志已经完整且同步——从一段**运行中**的会话解出了 23609 个事件，包括它的最后一句话（见 `scripts/livee2e.mjs`）。日志按 flush 追加，所以「日志不再变化」就等于「这段对话结束了」，不需要向宿主询问任何东西。

**静默窗口（默认 90 秒）。** 正在写的会话不会被提炼，否则只会记住半截对话；下次跑批再收它。窗口比任何一次模型调用加长工具执行的时间都长。

**成本是有意的上限。** 未归档会话很多（本机 426 个 / 245 MB，其中 422 个已静默），所以实时通道单独限流（默认每轮 2 个），不会把归档那部分的任务挤掉。这也是它默认关闭的原因。

**安全不变式：清理永远只作用于归档会话。** `cleanup` 的 id 映射只从归档清单构建，所以实时会话不可能被删——实时通道只写记忆，从不回收磁盘。`scripts/livetest.mjs` 把这条钉住了。

**「没有可记的」不是失败。** 一行字的会话被记为 `state.skipped` 而不是 `state.failed`，否则几百个短会话会把真正的失败埋掉；同时它也不会每轮都被重新解码。

## Agent 工具

注册了一个 `archived_digest` 工具，所以你也可以直接在对话里让它干活：

```
action: status       # 库存与进度
action: sessions     # 列出归档会话
action: digest       # 提炼（可带 sessionIds）
action: cleanup      # 清理已提炼的会话
action: memories     # 逐会话记忆列表
action: skills       # 技能列表
action: inspect      # 预览某个会话会被提炼成什么（不花 token）
# 记忆层
action: topics       # 聚合出的主题
action: facts        # 事实台账（含失效历史）
action: recall       # 检索记忆（query=...）
action: remember     # 手动加一条事实，走同一套合并管线
action: consolidate  # 重算主题
action: export       # 推给已挂载的记忆插件
```

`inspect` 只是解码加去噪，不调模型，适合先看看这个会话到底有没有值得留的东西。`remember` 也走同一个合并管线，所以你补一条和已有结论同义的事实会更新它，而不是并存。

## 和记忆插件的关系

本机装过三个记忆插件，但它们的状态不一样，这决定了插件怎么对接：

| 插件 | 本机状态 | 对接方式 |
| --- | --- | --- |
| `@openviking/dsh-memory-plugin` | 已启用，但服务端 `127.0.0.1:1933` **从未监听** | 只做检测：它 `provide('openvikingMemory')` 但**没有文档写入 API**，只有会话捕获。明确返回 `NO_WRITE_API` 而不是伪造一次调用 |
| `dsh-mnemon` | 已安装但**未启用**（不在 bundles 里） | 检测 `mnemon_*` 工具，有就调 `mnemon_remember` |
| `memory-eternal` | 已安装但**未启用** | 未对接 |

判据写在 `lib/backends.js` 里：**本地台账是真相源，后端只是镜像**。导出失败记录原因并显示，不回写台账；没有后端时面板直接说「本地存储就是唯一落盘处」，而不是给一个点了没反应的按钮。

## 安装

```bash
# 从 GitHub 装（推荐）
dsh plugin add github:LLL-lyh0/dsh-archived-digest

# 或者先 clone 再按本地路径装
git clone https://github.com/LLL-lyh0/dsh-archived-digest
dsh plugin add link:./dsh-archived-digest
```

装完**重启宿主**才生效（bundles 只在启动时读一次）。

本插件依赖宿主自带的 `@deepseek-ai/dsh-llm`（LLM 后端），以 `peerDependencies` 声明、`optional: true`。它是懒加载的：加载不到时插件不会挂掉，而是退化成"只做本地提炼、不调模型"。

### 从源码开发

把插件目录链进 profile 的 `node_modules`，改源码即刻生效。**必须是链接，不能是拷贝**——用 `cp -r` 或某些 `ln -s` 在 Windows 上会得到一份拷贝，之后改源码不再生效，而且不报任何错：

```bash
cmd //c "mklink /J dsh-archived-digest D:\path\to\dsh-archived-digest"
stat -c '%i' node_modules/dsh-archived-digest/index.js /d/path/to/dsh-archived-digest/index.js
# 两个 inode 必须相同
```

探针确认插件真的加载了：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:58902/api/dsh-archived-digest/status
# 200 = 已加载；401 = 没加载（宿主网关直接拒了）
```

## 测试

```bash
node scripts/selftest.mjs      # 解码 / 提炼 / 清理 / JSON 修复 / 截断收缩，19 项
node scripts/hosttest.mjs      # 假 ctx 挂载整个 Host，35 项
node scripts/clienttest.mjs    # 迷你 React 渲染面板（含记忆 tab），76 项
node scripts/memorytest.mjs    # 事实合并 / 时效 / 主题 / 检索 / 后端，27 项
node scripts/livetest.mjs      # 实时会话范围 / 静默窗口 / 清理不变式，21 项
node scripts/assemblertest.mjs # 流式分片归类 / 降级 shim / 预算升级，27 项
node scripts/copytest.mjs      # 面板语言：中文界面必须是中文，16 项
node scripts/skillcompat.mjs  # SKILL.md 对技能中心可解析，23 项
node scripts/mirrortest.mjs   # 技能发布与不覆盖用户技能，14 项
node scripts/e2e.mjs          # 真实归档会话（63.6 MB / 4063 轮）走完提炼 → 事实 → 主题
node scripts/livee2e.mjs      # 真实未归档会话（27 MB / 501 轮）同样走完整条路
node scripts/clustermetric.mjs # 在真实 facts.json 上打出聚类分布（不是测试，是判据）
```

全部离线跑，不发网络请求，不碰真实 store。测试里临时改了 `DSH_HOME` 或 `DSH_ARCHIVED_DIGEST_SKILLS`，所以不会往你真实的 `~/.dsh/skills` 里丢假技能。

记忆层的关键性质都配了**反向验证**——把实现改回错误的写法，对应用例必须变红。已验证的有：改回粗粒度分词会让三条用例红（同义复述被判为新事实）；让 `validUntil` 不落盘会让三条红；去掉检索相关性闸门会让「不相关查询返回 0 条」变红（它返回了全部 3 条）；去掉静默窗口会让「正在进行的会话不该被提炼」变红；去掉归档排除会让「实时清单不得包含归档会话」变红（它多吐了一条）；把流分片里的 `reasoning-delta` 改回写进 text 槽位会让 5 条红，忽略 `finish.reason` 会让 3 条红；让主题聚类的 `subject()` 无视显式主题名，会让「同一主题、毫无共同用词的两条事实必须聚到一起」变红（它裂成了 2 个主题）；把「截断后缩小输入」的循环停掉，会让「截断的提炼要缩小转录而不是只加预算」变红（它报 `MAX_TOKENS` 而不是成功）。

## 十三个实现上的坑（都已在代码里处理）

**zstd 日志是多帧追加的。** `zstdDecompressSync(整个文件)` 和流式解码都**只吐出第一帧**——一个 16703 字节的文件只解出 211 字节，看起来像"日志是空的"。正确做法是按 magic bytes `28 b5 2f fd` 切帧逐段解压（`lib/session-log.js` 的 `decodeZstdFrames`）。

**单条 `tool/result` 可以到 12958 字符。** 直接喂给模型会把上下文塞满，还会把 token 预算烧光在 glob 文件清单上。所以解析时只取 `user/message` 和 `assistant/message` 的 `text` 块，推理块和工具结果一律丢弃；再剥掉每轮注入的 `<system-reminder>`、`<available_skills>`、`<environment_context>` 整块。一个 174 轮、3.7 MB 的会话，去噪后送去提炼的正文是 14292 字符。

**自动清理的顺序必须是把 state 落盘再删。** `cleanupSession` 会**从磁盘重读** state 来判断这个会话到底提炼过没有；如果 `digestOne` 只在内存里 `recordDigest` 就去调它，读到的还是"未提炼"，于是被 `NOT_DIGESTED` 挡回去——而提炼本身是成功的，所以界面上一切正常，只有磁盘没被回收。这个 bug 一度存在，`scripts/selftest.mjs` 里的 `digestOne honours cleanupMode by itself` 就是为它加的回归（撤掉那行 `writeState` 该用例会红）。

**`document.documentElement.lang` 在客户端插件加载时还是空的。** locale 服务要稍后才写这个属性，而 `''` 不以 `zh` 开头，所以 `lang.startsWith('zh') ? zh : en` 会落到英文分支；更糟的是 `const t = pickCopy()` 只在工厂执行时算一次，整个会话就一直是英文。修法：改成每次取用时现读（`activeLanguage()`，空值按中文兜底，再看 `navigator.languages`），并把 `t` 换成 Proxy 让 `t.xxx` 每次解析当前语言——这样在设置里切语言不用刷新页面。`scripts/copytest.mjs` 把这条钉住了：撤掉修复该用例会红。

**宿主只在启动时快照客户端 bundle。** `dsh-client-modules` 用 `readFileSync` 在激活时读一次 `client.js` 缓存成 `record.bundle`，HMR 只重载 ESM 模块、不会重建客户端 combo。所以**改完 `client.js` 必须重启宿主**，否则浏览器拿到的还是旧代码，而且不会有任何报错。

**「会话」和「归档会话」不是一回事，这个差集会把功能整体架空。** 插件最初的取数口是 `workspace.json` 的 `archivedSessionIds`，而没有归档动作的会话永远不在里面——于是"边聊边攒记忆"完全不会发生，而且**不报任何错**：面板照常显示 77 条归档、进度正常、没有任何失败。实测本机 502 个会话里只有 77 个已归档，某天新写的 11 个全是 0 归档。修法是补一条实时通道（`listLiveSessions` + 静默窗口），并且在设计时确认了一个关键事实：**正在进行的会话，它在磁盘上的日志已经是完整的**（从一段运行中的会话解出 23609 个事件、含最后一句），所以实时提炼不需要任何会话钩子，只需要一个"日志不再变化"的静默判据。

**中文相似度不能用二元组。** 中文没有空格，二元组看起来是自然选择，但它对同义复述几乎失效：「日志要先按 magic 切帧」vs「日志需要按 magic bytes 切帧」只共享 `日志` 一个二元组，得分 0.33——低于任何合理阈值，于是同一件事会被反复 ADD 成多条。换成**单字集合**的 Dice 后同一对是 0.77，而无关句仍稳定在 0.05 以下。`scripts/memorytest.mjs` 里改了会红的正是这两条。

**检索必须有相关性闸门，不能只靠权重。** 原来的 `score = relevance*0.7 + strength*0.3` 里，一条完全不相干的事实也能靠强度拿到 ≈0.25 分，于是「这次查询没有命中」被表达成「返回全部事实，按新旧排序」——使用者看到一堆结果，却一条都不对题。修法是先过 `MIN_RELEVANCE`（0.12）再算分；现在无关查询返回 0 条。

**推理通道会泄进正文，而且「被截断」会被当成「成功」。** `import('@deepseek-ai/dsh-llm')` 从插件位置解析会抛 `ERR_MODULE_NOT_FOUND`（profile 的 `node_modules/@deepseek-ai/` 下只有 `cosmokit` 和 `schemastery`），所以实际跑的是包内自带的降级 assembler。它最初把**所有** `*-delta` 都追加进同一个字符串，于是模型的思考（"We need produce JSON only. Need compress session…"）被当成回复正文，JSON 解析必然失败——表面症状是「模型没返回 JSON」，真因是分片归类错了。修法是按 `${index}#${分片自身声明的类型}` 建槽位，并且认 `finish.reason`：`reasoning-delta` 永远进不了 text 通道，`max-tokens` 会被如实报成截断而不是成功。`scripts/assemblerprobe.mjs` 打印真实分片形状，`scripts/assemblertest.mjs`（27 项）把这两条钉住——把 reasoning 改回 text 会让 5 条红，忽略 `finish.reason` 会让 3 条红。

**Windows 路径原样写进 JSON 就是一个坏转义。** 模型把 `"cwd": "D:\\DeepSeekHarness"` 写成 `"cwd": "D:\DeepSeekHarness"`，而 `\D` 不是合法 JSON 转义，`JSON.parse` 报 `Bad escaped character in JSON at position 228`——整个会话的记忆就这么没了，日志里只留一句「不是 JSON」。修法是修好而非放弃：已知转义（`" \ / b f n r t`）和 `\uXXXX` 原样保留，其它反斜杠一律补成真转义。另外输出被截断时会按预算阶梯重试（更大 `maxTokens`），而不是直接判失败。

**「聚合」这个功能会静默地完全不聚合。** 主题是把事实聚成尽量少的几块，但它不报错：面板上「156 个主题」看起来像是聚得很细，实际是 `127` 个主题各含一条事实——等于没有聚合。两个独立原因叠在一起：① 拿候选事实去和「簇内所有成员拼起来的长文本」比相似度，簇越大分母越大、越难加入，正好反了；② 跨会话讲同一件事的两句话常常不共享任何字（「碰撞体穿透」vs「ShipHullCollision 扫掠」），字面相似度永远过不了阈值。修法是**最近成员比较**加**每个事实带主题名**（取自该会话记忆的标题，老台账整合时回填），同一台账变成 `188/188` 个事实进入 7 个多事实主题。判据是能在真实文件上跑的数字：`node scripts/clustermetric.mjs`。

**被截断时加大预算是错的，该缩小输入。** 有一个真实归档会话连续三次失败：`output hit the maxTokens=8000 ceiling and was truncated (reasoning 17853 chars before the answer)` —— 8000 的输出预算全花在思考上，一个答案字符都没写出来。原来的重试只是在 `MAX_TOKENS_CEILING = 8000` 内翻倍预算，对这种「思考占满预算」的情况，加预算只会买到更多思考。修法是**反过来缩输入**：`lib/digester.js` 保留解码后的事件列表（`read.eventList`），遇到 `MAX_TOKENS` 就把 `maxSourceChars` 减半重新抽取正文再试，下界是 `max(1500, 25%)`；要思考的东西少了，答案才装得下。同一个会话缩到 6628 字符后一次性成功。回归在 `selftest.mjs` 的「a truncated digest shrinks the transcript instead of only raising the budget」，停掉这个循环就会红。

**改 `touch cordis.patch.yml` 不会重载插件，看起来"验证通过"其实跑的还是旧代码。** 在 `index.js` 里加 `const BUILD = 'xxx'` 并让 `/status` 返回它之后才看清：`touch` 只改了 mtime，宿主仍在跑旧模块图（`build: undefined`）；**必须改文件内容**（哪怕追加一行注释）才会触发 watcher。这条元缺陷会让所有"修完再验一遍"的结论都不可信，所以 `scripts/reload.sh <build> <port>` 会改内容、等待、并断言 `/status` 里的 `build` 与传入值一致，不一致就报错退出。

## 许可

MIT
