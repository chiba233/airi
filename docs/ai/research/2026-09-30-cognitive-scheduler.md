# AIRI 动态认知调度架构调研

状态：探索性调研，不是 ADR，也没有实现
基线：`main` @ `07c6353`（2026-09-30）
范围：`packages/core-agent`、`packages/stage-ui`、`packages/plugin-protocol`、`packages/server-runtime`、`packages/provider-inference`、`integrations/*`、`plugins/*`、`server/apps/api`

本文用 `path:line` 引用代码。“已验证”表示跑过临时测试（见附录 A），“静态推断”表示只读了代码、没有执行。

---

## 0. 先校正几个事实

调研输入里有几条设想和仓库现状对不上。后面的设计都基于校正后的事实。

| 设想 | 代码事实 | 影响 |
| --- | --- | --- |
| AIRI 已经有 JEV | 全仓库（含 git 历史、fork 的 issue 和 PR）找不到 `JEV`、`jev`，也没有同义实现。离它最近的是 5 套互不相通的优先级词汇（见 §2.6） | JEV 的定义要由你们给出。本文只给出它在调度链路里的**插槽**，不猜它的语义 |
| 已经有直播模块 | `plugins/airi-plugin-bilibili-laplace/src/index.ts` 只有一行 `console.warn('WIP')`。`danmaku` 只是 tamagotchi 浮动聊天窗口的显示样式（#2704）。没有弹幕接入、直播状态或推流控制 | 直播 workload 要从零设计。好在它可以直接复用 `spark:notify` 和 `context:update`，不需要新的传输层 |
| 主 Agent 的长期 memory 可以复用 | stage 侧**没有任何长期记忆**。`packages/memory-pgvector/src/index.ts` 是空的 server-sdk 客户端（`module:configure` 的处理函数为空）。`server/apps/api/src/schemas/characters.ts:117` 的 `initialMemories` 还是 TODO。唯一真正的向量记忆在 `integrations/telegram-bot`（pgvector + `findRelevantMessages`），而且和 AIRI 主体完全隔离 | 主 memory 是**最大的空白**，不是升级对象。好处是没有历史包袱，可以直接按 persona 安全要求设计 |
| 现在是一个“大 Agent” | 实际上已经有 **6 个彼此独立的 Agent 循环**：stage chat orchestrator、spark-notify agent、Minecraft `Brain`、satori-bot loop、telegram-bot agent、artistry “Director”。它们各自实现队列、预算、中断和历史 | 问题不是“大 Agent 太大”，而是“小 Agent 各自为政”。调度器的首要价值是给它们**统一的生命周期和路由契约** |

还有一条比较微妙：仓库作者已经在往“Agent 是调度结果”这个方向写了。`createSparkNotifyAgent` 的注释原文是 “The host resolves model selection and schedules work. This agent only prepares and runs one notify turn.”（`packages/core-agent/src/agents/spark-notify/agent.ts:177-178`）。也就是说，Agent = 纯函数，host 负责调度，这个理念在代码里已经立住了，只是 host 这一侧还很弱。

---

## 1. 现有架构地图

### 1.1 进程与所有权

```
┌──────────────────────── 外部模块进程 ────────────────────────┐
│ minecraft Brain │ discord-bot │ satori/telegram │ web-ext │ HA │
└────────┬───────────────┬─────────────────────────────────────┘
         │ plugin-protocol over WS (spark:* / context:update / input:*)
┌────────▼─────────────────────────────────────────────────────┐
│ server-runtime（tamagotchi 内嵌或独立）                          │
│  peer 注册 · 心跳健康 · destinations 路由 · consumer-group 投递   │
└────────┬─────────────────────────────────────────────────────┘
         │ 每个 renderer 窗口 / 浏览器 tab 都各自连一条
┌────────▼──────────────── stage renderer ─────────────────────┐
│ context-bridge（每个窗口都跑，input:text 用 Web Lock 去重）       │
│ character-orchestrator = spark-notify agent（每个非 widget 窗口 │
│                          都跑一个 2s ticker）                    │
│ chat store（pinia-plugin-synced，actions 路由到选举出的 leader）  │
│   └─ createChatOrchestratorRuntime（core-agent，与 Vue 无关）    │
│        ├─ session port → chat-session store → IndexedDB / 云同步 │
│        ├─ context port → chat-context store → ContextRegistry   │
│        └─ llm port → useLLM → streamFrom → provider-inference   │
│ consciousness store（全局唯一 provider/model）                   │
│ airi-card store（全局唯一 activeCard = persona）                 │
│ speech-runtime（intent 优先级：queue/interrupt/replace）          │
└──────────────────────────────────────────────────────────────┘
```

stage 侧同时存在三种所有权模型：

1. **synced leader**：chat 的 `send/retry/cleanup` 等（`packages/stage-ui/src/stores/chat.ts:742-746`）。
2. **每个窗口各跑一份**：spark-notify ticker（`apps/stage-web/src/App.vue:137`，`apps/stage-tamagotchi/src/renderer/App.vue:298-299`）。
3. **Web Locks 抢占**：`input:text` 入口（`packages/stage-ui/src/stores/mods/api/context-bridge.ts:733-756`）。那里的 TODO 自己也写了：需要 leader election 或分布式锁。

调度器必须只有一个 owner，所以这是第一个要收敛的点（§3 B6）。

### 1.2 一次聊天请求的真实路径

1. 入口：UI 调用 `chatStore.send`，或者外部 `input:text` 经 context-bridge 进来。两条路都会带 `overrides.sessionId`。
2. `executeSend`（`packages/stage-ui/src/stores/chat.ts:553-595`）读取**全局** `consciousness.activeProvider/activeModel`，再 `loadSession`。
3. `runtime.ingest` 进入**全局唯一** FIFO 队列（`packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:1046`）。
4. `performSend` 依次执行下面几步：
   - `ingestRuntimeContexts()`：情绪 runtime prompt 和 Minecraft 状态会在**每次发送前**写进全局 registry。
   - `buildContext(history)`：把 session 历史转成 `Conversation.turns`。有 `generationTranscript` 的消息会原样回放 native continuation。user 消息前面加 `[HH:MM]` 和 `[Replying to: …]`。
   - 把 `getSystemPromptSupplement()`（toolset prompts）拼到 system turn 末尾。
   - 把 registry 快照作为 `runtime-context` segment 挂到**最后一条 user turn**。渲染出来是 `[Context]\n- source: text`（`packages/core-agent/src/messages/context-prompt.ts:37`）。
   - 调 `llm.stream` → `streamWithStageAdapters`（处理视觉转述、tool 图片）→ `useLLM.stream`（按 modelKey 学习兼容性，失败时降级）→ `streamFrom`。
   - 流事件经 marker parser 和 categorizer 分成 speech 与 reasoning。foreground stream 只 patch 到当前可见的 session。
   - 结束时追加 assistant 消息（带 `generationTranscript`），然后依次触发 hooks、analytics 和云同步。

### 1.3 Prompt 构成（现状）

| 层 | 来源 | 位置 |
| --- | --- | --- |
| identity | `card.systemPrompt + description + personality + scenario + widgetInstruction` | `packages/stage-ui/src/stores/modules/airi-card.ts:28-42` |
| 格式规则 | codeblock、math 规则，在创建 session 时**写进第一条 system 消息** | `packages/stage-ui/src/stores/chat/session-store.ts:196-209` |
| toolset | 各扩展注册的 toolset prompt，拼到 system 末尾 | `packages/stage-ui/src/stores/ai/chat-llm/toolset-prompts.ts` |
| runtime context | registry 快照（情绪 prompt、Minecraft、账户、所有 `context:update`） | `chat-orchestrator-runtime.ts:765-774` |
| 时间与引用 | `[HH:MM]`、`[Replying to]` 前缀 | `chat-orchestrator-runtime.ts:500-514` |
| 历史 | session 全量消息，**没有任何裁剪或压缩** | 同上 |

core-agent 的 `messages/types.ts` 已经定义了一套结构化 prompt 语言：`SystemTurn.authority: 'system' | 'developer' | 'context'`，以及 `ContextSegment` 下的 `instruction(priority)`、`domain-event`、`state-snapshot`、`history-block`、`summary(fromTurnIndex/toTurnIndex)`、`reference(refType, targetId)`。但是：

- 生产代码只用到 `runtime-context`。
- `compactConversationEntries` 和 `projection.ts` **没有从包入口导出**（`packages/core-agent/src/index.ts` 里没有它们），stage-ui 也从未调用。

这些是**已设计但休眠的原语**，正好是动态 prompt composition 需要的零件（§4.5）。

### 1.4 协议层（plugin-protocol）

这是整个仓库里最接近“认知总线”的部分，而且设计得相当完整：

| 原语 | 字段 | 可以承担的角色 |
| --- | --- | --- |
| `spark:notify` `events.ts:1087` | `kind: alarm/ping/reminder`、`urgency: immediate/soon/later`、`ttlMs`、`requiresAck`、`lane`、`destinations` | workload 入口事件 |
| `spark:command` `events.ts:1139` | `interrupt: force/soft/false`、`priority: critical..low`、`intent: plan/proposal/action/pause/resume/reroute/context`、`guidance.persona`、`contexts[]`、`parentEventId` | 调度器对子 Agent 或模块的下行指令，自带抢占语义 |
| `spark:emit` `events.ts:1102` | `state: queued/working/done/dropped/blocked/expired` | **现成的 run 生命周期词汇** |
| `context:update` `events.ts:563` | `contextId`、`lane`、`strategy: replace-self/append-self`、`destinations`、`ideas/hints`、`content` | 共享工作记忆的写入原语 |
| `DeliveryConfig` `events.ts:463-473` | `broadcast/consumer/consumer-group` × `first/round-robin/priority/sticky` + `stickyKey` | 模块接管和负载归属的底层机制 |
| `RouteTargetExpression` `events.ts:497` | and/or/glob/ids/plugin/instance/label/module/source | 按 relevance 定向投递 |
| `ModuleCapability` `events.ts:388` | `id`（注释里的例子就是 `"memory.write"`）、`configSchema`、`metadata` | 调度器可读的能力清单 |
| `ModuleConfigEnvelope.baseRevision` `events.ts:383` | 乐观并发 | 共享池并发写的现成模式 |

server-runtime 实现了 peer 心跳健康（`registry:modules:health:*`）、consumer 注册（带 priority）、按 destinations 过滤广播（`packages/server-runtime/src/index.ts:343-383, 881-960`）。

### 1.5 各业务域的真实状态

| 域 | durable state 在哪 | 与 AIRI 主体的关系 |
| --- | --- | --- |
| Minecraft | bot 进程内的 `Brain`：`conversationHistory`（内存，上限 200 条）、`llmLog`、action queue、reflex、perception | 上行 `spark:notify`、`context:update`、`spark:emit`，下行 `spark:command`。stage 只收一条 `latestRuntimeContextText`，每次发送前注入 |
| Discord | bot 进程几乎无状态。stage 侧按 `discord-guild-{id}` 或 `discord-dm-{id}` 设 sessionId | 走 `input:text` + `overrides.sessionId`，输出靠监听 `output:gen-ai:chat:message` |
| 直播 | 不存在 | — |
| satori / telegram | 自有 DB（telegram 有 pgvector）和自有 LLM 循环 | 与主体没有连接 |
| Vision | `vision:{workload}:{source}` 作为 replace-self 的 context | 通过 context registry 进入 prompt |
| Notebook / 任务 | `useCharacterNotebookStore`，**纯内存、不持久化** | spark-notify ticker 扫描到期任务 |

---

## 2. 与目标方向最相关的现有设施

按“能直接升级、不用新造”的程度排序。

### 2.1 Chat session = 可恢复 Agent context 的雏形 ★★★

- 分区键已经是 `userId → characterId → sessionId`（`packages/stage-ui/src/types/chat-session.ts:3-39`）。**persona 已经是 context 的一级分区**。
- 每条 assistant 消息保存 `generationTranscript`：完整的 `AssistantTurn`，包括每个 round 的 model、finishReason、usage、tool invocation 和 native continuation（`packages/core-agent/src/messages/types.ts:48-83`）。恢复时 `buildContext` 会原样回放。这比大多数框架的“只存文本”强得多，**恢复一个 Agent context 时不丢 tool 轨迹**。
- continuation 自带 scope（provider、endpoint、model、conversation）。跨模型恢复时自动降级为可移植内容，并记录 `projectionIssues`，不会静默丢内容（`packages/core-agent/src/runtime/request-context.ts:44-49`）。这让“恢复旧 context 并换模型”天然安全。
- 已经有 IndexedDB 持久化、云同步、墓碑、outbox、`sessionGenerations`（代际号，用来拒绝过期任务）。
- `forkSession` 已经存在（`session-store.ts:1481`），就是“从父 context 派生子 context”。

### 2.2 core-agent 的端口化运行时 ★★★

`createChatOrchestratorRuntime` 已经和 Vue、Pinia 解耦，session、context、LLM、stream 全部以端口注入（`chat-orchestrator-runtime.ts:247-400`）。它本质上就是一个“Agent 实例执行器”。要支持多实例，改的是队列和 foreground 的假设，不是整体结构。

`streamFrom` 的 `resolveStep`（`packages/core-agent/src/types/llm.ts:31-41`）可以在**每个模型步骤之前**重新决定 model、provider、systemPrompt、tools 和温度。如果 scope 变了，就抛 `RequestSwitch`，保留已完成的 round（`request-switch.ts`）。这就是**步骤级动态模型路由**的执行原语。代码已经合入（#2709），但 stage-ui 还没有任何调用方（见 `chat.ts:278-281` 的 NOTICE）。

### 2.3 spark-notify agent + character-orchestrator = 调度器的种子 ★★★

- `processSparkNotify` 已经在做“选 model → 组 prompt → 跑一个一次性 Agent → 把结果变成 `spark:command` 下发”（`packages/stage-ui/src/stores/character/orchestrator/store.ts:119-160`）。
- 已经有 urgency 到延迟的映射、重试、`maxAttempts`、2s tick、notebook 到期任务注入（`store.ts:73-94, 183-252`）。
- LLM 可以选择 `builtIn_sparkNoResponse` 表示“这件事不值得反应”。这就是**让 LLM 做 triage 的现成开关**。
- plugin 机制（`SparkNotifyPlugin.prepare → systemInstructions/userSections/tools/getResult`）就是一个小型的 **prompt composition 管线**。

### 2.4 Minecraft `Brain` = 监督机制的参考实现 ★★★

用户问“子 Agent 卡住、循环、自认完成怎么办”，`integrations/minecraft/src/cognitive/conscious/brain.ts` 已经实现了一整套**不依赖 LLM 的监督手段**：

| 机制 | 常量或位置 |
| --- | --- |
| 事件优先级分层 + 合并 + 按优先级稳定排序 | `EVENT_PRIORITY_*`，`coalesceQueue` `:1585` |
| 防饿死（连续高优先级 8 轮后强制放行低优先级） | `MAX_CONSECUTIVE_HIGH_PRIORITY_TURNS` `:1683` |
| no-action 预算 + 停滞检测 | `NO_ACTION_FOLLOWUP_BUDGET_DEFAULT=3`，`NO_ACTION_STAGNATION_REPEAT_LIMIT=2` |
| 错误爆发熔断（5 轮内 3 次错误） | `ERROR_BURST_THRESHOLD`、`ERROR_BURST_WINDOW_TURNS` |
| 单次 LLM 超时 60s + AbortController | `DEFAULT_LLM_ATTEMPT_TIMEOUT_MS` `:544` |
| action 队列状态机 pending/executing/succeeded/failed/cancelled + cancellation token | `:140, :1223-1400` |
| 结构化调度日志（`llmLog`，带 tags） | 全文 |
| 队列上限与溢出丢弃 | `MAX_EVENT_QUEUE_LENGTH=256` |

它的注释自己写了 “FIXME: Replace with weighted-fair scheduling once queue model is refactored”。它等的正是本调研要设计的东西。

### 2.5 ContextRegistry = tiny shared context 的现成骨架 ★★

`createContextRegistry`（`packages/core-agent/src/runtime/context-registry.ts`）已经有：

- 按 `sourceKey` 分桶。
- `replace-self`（槽位语义）和 `append-self`（日志语义）。
- 有上限的 ingest 历史（400 条），以及克隆快照。

它缺的恰好就是“共享工作记忆”的全部约束：容量预算、TTL、按 `destinations` 或 `lane` 过滤、按读者投影、优先级、版本。协议里的 `ContextUpdate` 已经带了 `destinations` 和 `lane`，但 registry 和 context-bridge **都没用它们做过滤**（§3 B2）。

### 2.6 分散的优先级与显著性词汇 ★

| 位置 | 词汇 |
| --- | --- |
| `spark:notify` | urgency: immediate/soon/later |
| `spark:command` | priority: critical/high/normal/low；interrupt: force/soft |
| `pipelines-audio` | `PriorityLevel` + `IntentBehavior: queue/interrupt/replace` |
| Minecraft Brain | 4 级事件 tier |
| artistry Director | LLM 输出 `intensity: 0-100` + `autonomousThreshold` 阈值 |
| `SegmentInstruction` | priority: low..critical |

JEV 如果要进入调度，第一件事是把这些词汇映射到**一个标量显著性**（§8）。

### 2.7 其他可直接用的零件

- **模型元数据**：`ModelInfo.metadata`（model-bank 的 `abilities/maxOutput/pricing`）、`contextLength`（`packages/provider-inference/src/types.ts:226-237`）。还有运行时学到的 `toolsCompatibility` 和 `contentArrayCompatibility`（`packages/stage-ui/src/stores/ai/chat-llm/llm.ts`）。遥测里已经有 `onLlmFirstToken.ttfbMs` 和 usage。这些拼起来就是 ModelProfile。
- **服务端 llm-router**：alias → 有序候选组 + 失败触发器 + key 轮换（`server/apps/api/src/services/domain/llm-router`）。它负责**可用性路由**，不负责能力路由。这条边界应该保留。
- **Vision workload 表**：`VisionWorkloadId → prompt`（`packages/stage-ui/src/composables/vision/use-vision-workloads.ts`）。这是“workload 模板化 prompt”的最小先例。context id 用 `vision:{workload}:{source}`，也是很好的 state-handle 命名先例。
- **tool 激活元数据**：`RegisteredPluginToolDescriptor.activation: { keywords, patterns }`（`packages/plugin-sdk-tamagotchi/src/tools/registry.ts`）。这是按 relevance 选 capability 的现成钩子。另外 `requiresExplicitSelection` 是 capability 授权边界。
- **服务端 chats schema**：`chatMembers.memberType: 'user' | 'character' | 'bot'`，`ChatType` 含 `group/channel`（`server/apps/api/src/schemas/chats.ts:41-42`）。多 persona 同场的数据模型在云端已经有了。
- **speech intent**：一张嘴、多个说话者的仲裁已经存在（`ownerId + priority + behavior`）。多个 Agent 同时想“说话”时，最后都要在这里仲裁。

---

## 3. 当前最大的架构阻力

| # | 阻力 | 证据 | 验证 |
| --- | --- | --- | --- |
| B1 | **全局单队列、单 `sending`、单 foreground stream**。不同 session 的请求严格串行。游戏规划跑 30s，这期间用户聊天只能排队 | `chat-orchestrator-runtime.ts:421-431, 1046`。`chat.ts:576` 的注释写的是 “per-session queue”，实际是全局队列 | **已验证**（附录 A 测试 1） |
| B2 | **ContextRegistry 全局唯一，不按 session、读者或 destinations 隔离，也没有 TTL**。Discord guild A 的 append-self 通知会出现在主人私聊的 prompt 里，而且一直累积 | registry 忽略 `destinations/lane`。`chat-orchestrator-runtime.ts:544` 有 TODO。只有 `cleanup` 会整体 `resetContexts`（`chat.ts:662`） | **已验证**（附录 A 测试 2） |
| B3 | **模型是全局单例**。chat 和 spark-notify 共用 `consciousness.activeModel`，切 card 会改写它（`airi-card.ts:118-125`） | `consciousness.ts`、`orchestrator/store.ts:123-125` | 静态推断 |
| B4 | **persona 是全局单例**。system prompt 从 `activeCard` 取，并作为快照写进 session 第一条消息。切 card 时 `refreshActiveSessionSystemMessage` 会改写当前 session 的 system 消息。runtime 不能同时跑两个 persona 的 context | `session-store.ts:211-242`、`airi-card.ts:28-42` | 静态推断 |
| B5 | **外部来源的 session 身份无法持久化，甚至无法执行**。Discord 送来 `discord-guild-*`，但没有任何代码为它创建 `ChatSessionMeta`。`loadSession` 在 `!sessionMetas[sessionId]` 时返回 false（`session-store.ts:399`），`executeSend` 随后抛 `Failed to load the target chat session`（`chat.ts:560`），错误被 context-bridge 吞掉。即使绕过去，`persistSession` 也会因为缺 meta 直接返回（`:285-287`） | 同左 | 静态推断（没跑 stage-ui store 测试，依赖太重。结论依据是上面三处代码的组合，把握较高，建议用 Discord 实测复核） |
| B6 | **所有权碎片化**：leader、每窗口、Web Lock 三套模型并存。Web 多 tab 时 spark ticker 每个 tab 各跑一份 | §1.1 | 静态推断 |
| B7 | **6 个独立 Agent 循环**，没有共同的 run 契约、监督、记忆和路由 | §0 | — |
| B8 | **prompt 组装逻辑焊在 chat facade 里**：视觉转述、tool 图片、toolset、账户 context 都在 `streamWithStageAdapters` 或 `chat.ts` 的端口闭包里，其他 Agent 类型复用不了 | `chat.ts:254-380` | — |
| B9 | **没有长上下文治理**。可恢复 context 会无限增长。压缩原语处于休眠状态 | §1.3 | — |
| B10 | **fork 不记血缘**。`forkSession` 忽略 `reason/hidden`，也不写 `parentSessionId`，`ingestOnFork` 没有调用方 | `session-store.ts:1481-1488` | 静态推断 |
| B11 | **run 身份未贯通**。`AssistantTurn.runId` 和 `requestCorrelation.runId` 字段存在，但 orchestrator 从不填（只传 `conversationId/turnId`） | `chat-orchestrator-runtime.ts:819-822` | 静态推断 |

B1、B2、B5 目前表现为 bug，本质上是同一个假设：**整个系统只有一个前台对话**。动态 Agent 要推翻的就是这个假设。

---

## 4. 目标架构（基于仓库推演）

### 4.1 核心判断

1. **Agent context 的载体就是 session**。只需要扩展 meta，不需要新造存储。session 已经具备：persona 分区、完整 turn 轨迹、跨模型安全恢复、持久化和云同步、代际号、fork。
2. **Agent 的执行体就是 core-agent runtime**。去掉“全局单前台”假设，改成 lane 化的多实例。
3. **调度器从 character-orchestrator（spark-notify host）长出来**，不从 chat facade 长出来。它已经在做 triage、定时、重试和下行指令。
4. **总线就是 plugin-protocol**。共享工作记忆、run 状态、下行指令都已经有事件类型，缺的是 stage 侧对这些字段的尊重。
5. **主 memory 是真正要新建的东西**。按 server-sdk 模块形态做（`memory-pgvector` 的壳已经在），能力声明用 `ModuleCapability`（`memory.read/write`）。

### 4.2 分层

```
L5  Scheduler（单 owner：synced leader，长期可移到 main 或 headless peer）
      workload 队列 · salience/JEV · 选 context（resume/fork/create）
      · 选模型 · 组 prompt 配方 · 监督 · 结果路由
L4  Agent Runtime Pool（core-agent）
      每个 AgentContext 一条 lane · 全局并发信号量 · 每个 run 一个 AbortController
      · resolveStep · Supervisor（从 Brain 抽出的确定性看门狗）
L3  Context 层
      AgentContext Store（扩展 ChatSession）  ← 各 Agent 私有 context
      Working Memory（改造 ContextRegistry）  ← tiny shared context
      Memory Service（新建）                  ← 主长期记忆
L2  Module durable state（各模块自己持有，调度器只拿 handle）
L1  Bus：plugin-protocol + server-runtime（spark:* / context:update / delivery）
```

### 4.3 核心数据形态（示意，不是 API 定稿）

```ts
// 在 ChatSessionMeta 上扩展，不新建表
interface AgentContextMeta extends ChatSessionMeta {
  kind: 'conversation' | 'module-agent' | 'task' | 'triage'
  personaId: string // 即现有 characterId
  bindings: string[] // 例如 'discord:guild:123'、'minecraft:bot:alice'、'owner:private'
  workload?: string // 例如 'chat'、'game:plan'、'stream:commentary'
  parentContextId?: string // fork 血缘（修 B10）
  status: 'active' | 'idle' | 'dormant' | 'retired'
  digest?: { text: string, upToMessageId: string, updatedAt: number } // 供检索和冷启动
  lastRunAt?: number
  openThreads?: string[] // 未完成事项，决定是否优先 resume
}

// run 与 context 分离，状态词汇直接复用 spark:emit
interface AgentRun {
  runId: string // 贯通到 AssistantTurn.runId（修 B11）
  contextId: string
  parentRunId?: string // 动态 DAG 的边
  workloadId: string
  state: 'queued' | 'working' | 'done' | 'dropped' | 'blocked' | 'expired'
  model: { providerId: string, model: string, reason: string }
  budget: { deadlineAt: number, maxSteps: number, maxTokens: number }
  progress: { lastTokenAt?: number, lastToolCallHash?: string, repeatCount: number }
}
```

### 4.4 Scheduler 应该放在哪一层

- **短期**：stage-ui 的 synced leader。原因是 chat runtime、tools executor（leader-local，`tools.ts` 的注释写明了）和 provider 实例都在 leader，放在别处要跨进程搬运 provider 凭据和 tool 执行器。调度核心写成 core-agent 里与平台无关的纯逻辑（和 `createChatOrchestratorRuntime` 同一形态），stage-ui 只做端口适配。
- **长期**：桌面端移到 Electron main，或者做成一个 headless 的 server-runtime peer（“brain module”）。理由是 Discord 和直播需要在所有 UI 窗口关闭时继续运转，而 renderer leader 的生命周期绑定在窗口上。这是 §12 的决策点之一。
- **明确不放**：chat facade（B8），以及每个窗口各一份（B6）。

### 4.5 Prompt 编排：配方而不是模板

不维护 `game-agent.prompt` 这类文件，而是让调度器产出一个 **PromptRecipe**，由组装器映射到现有的 `Turn/ContextSegment`：

| 配方槽 | 映射到的现有原语 | authority |
| --- | --- | --- |
| identity(persona) | card 字段（每次运行时取，**不再**快照进 session 第一条消息，修 B4） | `system` |
| rules / 格式 | 现有 codeblock 和 math 规则、`base.prompt.*` | `system` |
| workload 指令 | workload 表（仿 `VISION_WORKLOADS`），`SegmentInstruction(priority)` | `developer` |
| capabilities | toolset prompts + `activation` 选出的 tools | `developer` |
| relevant memory | Memory Service 检索结果，`SegmentSummary` + `SegmentReference` | `context` |
| agent context | session 历史，超预算时用 `history-block` + `compactConversationEntries` 压缩 | — |
| working memory | 按读者投影的共享池条目，`runtime-context` | `context` |
| 触发事件 | `SegmentDomainEvent` / `SegmentStateSnapshot` | `context` |
| 其他 Agent 的更新 | `SegmentReference(refType='run', targetId=runId)` + 一句摘要 | `context` |

`authority: 'context'` 是关键。README 写明了 “Application context does not gain instruction authority merely because the application supplied it.”。跨 persona 的记忆、其他 Agent 的输出、外部模块数据，一律以 `context` 权威进入，不能冒充指令。这是 prompt 注入防护和 persona 安全共用的底座。

---

## 5. Scheduler 的职责边界

**做**：

1. 把输入归一成 workload。来源有 `input:*`、`spark:notify`、带 `destinations` 的 `context:update`、notebook 到期任务、run 结果、定时器。
2. 给 workload 打分（salience 和 JEV 插槽），决定立即执行、延迟、合并或丢弃。
3. 选 context：resume、fork 或 create（§6.2）。
4. 选模型（§8.3），产出 PromptRecipe。
5. 发起 run，维护 run 表，执行监督策略（§6.3）。
6. 路由结果：写 working memory、定向 `spark:command`、触发后续 workload（DAG 的下一跳）。
7. 做生命周期整理：idle 到 dormant 的降级、digest 更新、记忆回写的触发。

**不做**：

- 不亲自生成对用户的回复。对话由 conversation context 的 run 完成。
- 不保存模块状态。模块自己持有状态，调度器只拿 handle，也就是 `contextId`。
- 不做上游可用性路由。那是服务端 llm-router 的事。
- 不在热路径上每一步都调 LLM。默认走确定性策略，只有歧义时才调用 triage 模型。现有 spark-notify agent 本身就是一个 triage agent，可以直接复用。

---

## 6. Agent context 生命周期

### 6.1 两个正交的状态机

**context 的状态**（长寿命，持久化）：

```
            create/fork
   (none) ─────────────► idle ◄────────────┐
                          │ run 开始       │ run 结束
                          ▼                │
                        active ────────────┘
                          │
   idle 超过 T_warm ──► dormant（从内存卸载，只剩 IndexedDB 或云端，保留 digest）
   dormant 且被选中 ──► idle（resume = loadSession + 必要的压缩）
   dormant 超过 T_retire，或被显式归档 ──► retired
        （只读。蒸馏进主 memory。不参与 resume 候选，但仍可作为 reference 源）
   用户删除 ──► purged（走现有 deleteSession 和墓碑）
```

**run 的状态**（短寿命）：直接复用 `spark:emit` 的 `queued/working/done/dropped/blocked/expired`。

两者的关系：context 为 `active` 当且仅当它有一个 `working` 的 run，或者持有一个模块租约（§8.4）。**run 结束绝不删除 context**。这正是你们要求的“inactive ≠ 销毁”。在现有代码里，session 本来就不会因为请求结束而消失，缺的只是 `idle/dormant/retired` 这几个显式状态，以及卸载和降级逻辑。

**persist 的时机**：沿用现有的 `appendSessionMessage → persistSession`。前提是先修 B5，外部绑定来源也必须有 meta。

### 6.2 resume 还是 create：调度器怎么发现旧 Agent

分两步，**确定性检索优先，语义检索兜底**。

1. **按绑定键精确命中**。`bindings` 包含 `discord:guild:123`、`owner:private`、`minecraft:bot:alice` 这类键。绝大多数 workload（Discord 频道、私聊、某个游戏 bot）都有天然的绑定键，命中就直接 resume，不需要任何模型参与。现在 Discord adapter 拼的 `discord-guild-{id}` 就是一个绑定键，只是被错误地当成了 sessionId。
2. **没有精确命中时打分**。候选集为同 persona、同 workload 族、状态不是 retired 的 context。

   ```
   score(c) = 0.35·sim(query, c.digest)
            + 0.25·exp(-(now - c.lastRunAt)/τ)      // 新鲜度，τ 按 workload 设定
            + 0.25·[c.openThreads 与当前事件相关]
            + 0.15·[c.bindings 部分重叠]
            - λ·max(0, tokens(c) - B_ctx)/B_ctx     // 过大的 context 要付压缩成本
   ```

   - `score ≥ θ_resume` 时 resume。
   - 前两名得分接近，或都低于阈值时，交给 triage 模型二选一。
   - 都很低时 create。create 时如果存在相关的父 context，就 fork，继承它的 digest 而不是全量历史。

**推演示例**。假设 τ = 6h，θ = 0.55。用户隔天回来聊前一天的话题：

| 候选 | sim | 新鲜度（相隔） | openThreads | 部分绑定 | 超预算项 | 得分 |
| --- | --- | --- | --- | --- | --- | --- |
| 昨天的私聊 | 0.8 | 0.02（24h） | 1 | 1 | 0 | 0.28 + 0.005 + 0.25 + 0.15 ≈ **0.69** |
| 今早的闲聊 | 0.2 | 0.61（3h） | 0 | 1 | 0 | 0.07 + 0.15 + 0 + 0.15 ≈ **0.37** |

结果选昨天的私聊，符合直觉。权重只是起点，应该用 `contextObservability` 已有的事件记录做离线回放来调参。

**新 Agent 的记忆初始化**顺序：

1. persona identity。
2. 父 context 的 digest（如果是 fork）。
3. Memory Service 里按 persona 可见性过滤后的 top-k 条目，以 `summary + reference` 形式注入。
4. 当前 working memory 的投影。
5. 触发事件本身。

**不要**把父 context 的全量历史复制过去。现有 `forkSession` 正是这么做的（复制前缀消息），这只适合“分支对话”，不适合“派生子任务”。

### 6.3 监督（check）机制

直接从 Minecraft `Brain` 抽象出一个 core-agent 的 `RunSupervisor`，大部分检查不需要调用模型：

| 症状 | 确定性信号 | 动作 |
| --- | --- | --- |
| 卡住 | `lastTokenAt` 或最后一个 stream 事件距今超过 T_idle | 先 abort 本步，用 `resolveStep` 换到更快的模型重试一次，再失败就标为 `blocked` |
| 循环 | 连续 N 次同名 tool 且参数哈希相同，或 no-action 轮数超过预算 | 注入一条 `SegmentInstruction(priority='high')` 纠偏，再犯就终止 |
| 超时或超预算 | `deadlineAt`、`maxSteps`、`maxTokens`（usage 已有） | `expired`，结果以“部分完成”回报 |
| 错误爆发 | 窗口内错误数超过阈值 | 熔断，冷却 |
| 目标漂移或误判完成 | 前几种都查不出来 | **这时才**调用 judge 模型，而且只在 run 结束时或每隔 K 步调一次 |
| 被抢占 | 来了更高 salience 的 workload，同时要抢同一个资源（例如 speech 通道、模块租约） | 按 `interrupt: force/soft` 语义处理，复用 `spark:command` |

执行层的所有零件都已具备：`AbortController`（runtime）、`sessionGeneration`（拒绝过期结果）、stream 事件、usage。

---

## 7. Memory 分层

| 层 | 内容 | 载体 | 写入者 | 读取方式 | 生命周期 |
| --- | --- | --- | --- | --- | --- |
| **M1 主长期 memory** | 跨 context、跨模块、有长期价值的事实、关系、偏好，以及调度史（哪个 context 做过什么） | **新建** Memory Service（server-sdk 模块，pgvector 或 duckdb-wasm）。每条记录带 provenance 和可见性标签 | 调度器（蒸馏）、Agent 通过显式 `memory.write` tool（需要调度器审批或按策略自动通过） | 检索 → `summary + reference` 段 | 长期，可衰减，可纠错 |
| **M2 Agent 私有 context** | 某个对话、某个任务的完整轨迹 | 扩展后的 session（IndexedDB + 云） | 该 context 的 run | 整体回放，超预算时压缩成 `history-block` | 按 §6.1 |
| **M3 tiny shared context** | “此刻”需要跨 Agent 共享的少量事实 | 改造后的 ContextRegistry（只在内存，leader 持有，可以镜像到 synced state 供 devtools 查看） | 任何 Agent 或模块（`context:update`） | 按读者投影后放进 `runtime-context` | 秒到分钟级，TTL |
| **M4 模块 durable state** | 游戏世界、Discord 频道历史、直播弹幕流 | 模块自己的进程或 DB | 模块 | 通过 handle（`contextId`、查询 tool）按需重读 | 模块决定 |

### 7.1 M3（共享池）具体约束

在 `createContextRegistry` 上加这些约束，而不是新造结构：

```ts
interface WorkingMemoryEntry extends ContextMessage {
  // 已有：id, contextId(=slot key), lane, strategy, text, destinations, metadata, createdAt
  writer: string // agentContextId 或 module id
  salience: number // 0..1，JEV 插槽
  expiresAt: number // TTL
  version: number // 同 slot 的乐观并发，仿 baseRevision
  sourceRef?: { refType: string, targetId: string } // 指回原始来源
}
```

- **容量**：总预算 `B_wm` 按 token 计（建议 300–800），每个 writer 有配额，单条 ≤ 80 token。超出时**写入被拒**，写入方必须改写成一个 reference。
- **准入与淘汰**：`keep = salience × freshness(age, ttl)`。写入时如果放不下，就淘汰 keep 最低的条目。低于新条目的 keep 才淘汰，否则拒绝新条目。
- **并发**：按 `contextId` 分槽，默认 replace-self，单写者覆盖。多写者用 `version` 做 CAS，冲突时后到的写入以“追加一个带 writer 的变体”落地，由调度器下个 tick 合并。`append-self` 只允许固定几个事件型槽位，并设条数上限。
- **读取投影**：读者只看到 `destinations` 包含自己（或 `all`）、`lane` 匹配的条目。这就修掉了 B2。
- **整理**：调度器每个 tick 做确定性清理（过期、超额、孤儿 writer）。LLM 合并只在超过预算的次数达到阈值时触发。

**为什么预算要小，一个推演**。池内容会进入**每个** Agent 的**每次**调用。设 `B_wm = 1000` token，5 个活跃 Agent，每个每分钟 20 次调用，光共享池就是 5 × 20 × 1000 = 10 万 token/分钟，而且每个 Agent 都要为和自己无关的内容分散注意力。把 `B_wm` 降到 400，再加上读者投影（平均每个读者只看到 40%），每分钟降到 1.6 万 token。这个量级差距就是“按读者投影 + 小预算”必须同时存在的理由。

### 7.2 回写路径

- **run 结束时**：Agent 可以在输出里调用 `memory.propose` tool，提出候选记忆。调度器按策略决定：自动写入、丢弃、或者先写成 dormant 候选。候选记录上带 provenance（`contextId`、`runId`、`messageId`）。
- **context 降级为 dormant 时**：用廉价模型生成或更新 `digest`（写回 meta，供 §6.2 检索），同时提取候选记忆。
- **context 退役时**：做一次完整蒸馏，然后把 context 标为 retired。原文不删，作为 reference 源保留。

### 7.3 什么进哪层（判定规则）

| 信息 | 层 |
| --- | --- |
| 用户长期偏好、身份事实、关系 | M1 |
| “今天和 Discord 某群聊了什么” | M2（该 context）。它的 digest 可以进 M1 的调度史 |
| “玩家正被苦力怕追”“主播 30 秒后下播” | M3，TTL 很短，带模块 reference |
| 游戏地图、背包、弹幕全文 | M4，只给 handle |
| 某个 Agent 的中间推理 | M2（该 run 的 turn），不进 M3 |

---

## 8. Workload、JEV 与 model routing

### 8.1 Workload 形态

```ts
interface Workload {
  id: string
  kind: string // 'chat' | 'game:react' | 'game:plan' | 'discord:reply' | 'stream:commentary' | ...
  origin: { event: string, eventId: string, source: string } // 指回 spark:notify 或 input 等
  bindings: string[]
  salience: number // 0..1，见 8.2
  deadlineAt?: number // 例如 spark:notify.ttlMs 换算
  coalesceKey?: string // 同 key 合并，仿 Brain.coalesceQueue
  requirements: ModelRequirements
}
```

### 8.2 salience（JEV 插槽）

JEV 在仓库里不存在，这里只定义接口：

```ts
type SalienceFn = (w: Workload, world: SchedulerSnapshot) => number // 0..1
```

- 在拿到 JEV 定义之前，先用**现有词汇的统一映射**作为基线：`critical/immediate → 0.9`、`high/soon → 0.7`、`normal → 0.5`、`low/later → 0.3`。用户直接对话固定在 ≥ 0.8，artistry 的 `intensity/100` 直接用。
- JEV 接入后，作为 `SalienceFn` 的一项，与基线加权。

salience 驱动的决策：

| salience | 队列 | 抢占 | 模型档 | 并行度 | 共享池准入 |
| --- | --- | --- | --- | --- | --- |
| ≥ 0.85 | 立即 | 可以对同资源 `interrupt: force` | 低延迟档（反应）或强档（关键判断），由 requirements 决定 | 可以拆成多 run | 优先 |
| 0.6–0.85 | 下一个空位 | `soft` | 默认档 | 1 | 正常 |
| 0.3–0.6 | 可延迟，可合并 | 不抢占 | 廉价档 | 1 | 仅 slot 覆盖 |
| < 0.3 | 批处理或丢弃（先走 triage no-response） | — | 廉价档或不跑 | 0 | 不准入 |

**关于“Agent 按 JEV 动态接管模块”，我建议换一个形态**。不要让 LLM 自己“抢”模块，改成**调度器授予的租约**：

```
lease(moduleId, holderContextId, expiresAt, salienceAtGrant)
```

- 更高 salience 的 workload 可以请求转移租约。
- 租约过期自动释放，这借鉴了 server-runtime 的心跳思路。
- 模块侧只认 `stickyKey = holderContextId`。server-runtime 的 `DeliveryConfig.selection='sticky'` 和 consumer priority 已经存在，下行 `spark:command` 带上 holder 即可。

这样“接管”是可审计、可回收的，不会出现两个 Agent 同时给同一个游戏 bot 下相反指令。

### 8.3 Model routing

**ModelProfile** 全部由现有数据派生：

| 维度 | 来源 |
| --- | --- |
| 能力（tools、vision、reasoning） | model-bank `abilities`，以及学习到的 `toolsCompatibility`、`contentArrayCompatibility` |
| 上下文长度 | `contextLength` 或 `contextWindowTokens` |
| 价格 | model-bank `pricing`。官方 provider 走 Flux 计价 |
| 延迟 | `onLlmFirstToken.ttfbMs` 和 `onMessageRound.durationMs` 按 `modelKey` 做 EWMA（遥测已经在发，只差聚合） |
| 可用性 | 用户已配置的 provider，官方模型走服务端 llm-router alias |

**选择**：先按 requirements 过滤硬约束（needsTools、needsVision、`minContext ≥ 预计 prompt tokens`），再打分：

```
cost(m) = α·latency(m) + β·price(m) − γ·quality(m, kind)
```

α、β、γ 由 workload 档位决定：反应档重 α，规划档重 γ。`quality` 初期由用户在设置里给模型打标签，例如 fast、strong、local，不要自动推断。

**步骤级切换**：用 `resolveStep`。例如 game:react 第一步用快模型；如果它调用了 `escalate` tool，或者 supervisor 判定卡住，下一步切到强模型。continuation scope 的变化会自动走 `RequestSwitch`，已完成的 round 不会丢。

**当前距离**：执行原语（`resolveStep`、`RequestSwitch`、continuation scope）是齐的。缺三样东西：ModelProfile 聚合、requirements 声明、“consciousness = 唯一模型”的假设被替换成“consciousness = 默认档或兜底档”。这属于中等工作量，不需要重写。

---

## 9. 信息同步与信息丢失

### 9.1 丢失最容易发生在哪

1. **模块 → stage 的单行文本化**。Minecraft 的全部状态被压成 `latestRuntimeContextText` 一行字符串，再拼成一大段英文放进 `[Context]`（`context-providers/minecraft.ts`）。结构化信息在第一跳就丢了。
2. **spark:notify → 反应文本**。notify agent 的输出只是一段 reaction 文本，或者一组 command。这次判断的依据（为什么忽略、为什么下发）不进任何 context，下一次无法追溯。
3. **Minecraft Brain 注入 AIRI context**。收到的 `airi_context` 会以 `[AIRI_CONTEXT] …` 塞进它自己的对话历史，并受 200 条上限裁剪。
4. **session 无压缩**。超过窗口时只能靠 provider 截断或报错，谁先丢完全不可控。

### 9.2 传值、传引用、重查

| 类型 | 规则 | 载体 |
| --- | --- | --- |
| **传值** | 小（≤ 80 token）、时效强、读者多，而且读者要基于它**立即**决策。例如“正在被攻击”“主人刚上线” | M3 条目，必须带 `sourceRef` |
| **传引用** | 大、结构化、读者只在少数情况下需要细节。例如对局历史、某个 run 的完整推理、Discord 频道历史 | `SegmentReference(refType, targetId)` + 一句话摘要。`refType` 取值：`session-message`、`run`、`module-state`、`notify` |
| **重查源头** | 要对外部世界**执行动作**之前，或者引用的版本已经过期 | 模块的查询 tool（Minecraft 已有 query DSL），或者 `loadSession(targetId)` 按消息 id 精确取回 |

硬规则：**摘要永远不是唯一副本**。任何摘要（digest、`HistorySummary`、M3 条目、M1 记忆）都必须带能回到原文的 reference。现有原语已经够用：

- `HistorySummary.fromTurnIndex/toTurnIndex`
- 消息 id / `roundId` / `generationTranscript`
- `spark:*` 的 `eventId/parentEventId`
- `ContextUpdate.contextId`
- `SegmentReference`

缺的只是**强制使用**它们。

### 9.3 一个简化推演

设每次“读原文 → 写摘要”只保留比例为 r 的任务相关事实，而且各跳相互独立。经过 k 跳后，期望保留率为 r^k：

| r | k=2 | k=4 | k=6 |
| --- | --- | --- | --- |
| 0.9 | 0.81 | 0.66 | 0.53 |
| 0.8 | 0.64 | 0.41 | 0.26 |

如果每一跳都带 reference，下游在发现缺信息时可以回源，保留率的下界就不再随 k 衰减，而是取决于“下游能否意识到缺信息”，也就是 recall 能力。这是一个玩具模型（假设各跳独立且丢失均匀），但它足以说明：**要限制的是摘要链的深度，不是摘要本身**。调度器路由结果时，默认转发“原始结果的 reference + 这一跳的摘要”，而不是“上一跳摘要的摘要”。

### 9.4 结果并行传播

run 结束后，调度器按以下规则决定把结果发给谁。

- **候选读者**：持有相关 `bindings` 的 active 或 idle context，外加订阅了该 `lane` 的 context。
- **路由判断**（确定性）：
  - `relevance = lane 匹配 + bindings 交集 + workload 依赖边`。
  - 只有“下一步决策依赖它”的读者才会收到**推送**（新 workload，或者 `spark:command intent=context`）。
  - 其他读者只能在 M3 里**拉取**到它（投影可见）。
- 全局广播被禁止。协议 DO/DON'T 注释（`packages/plugin-protocol/src/types/events.ts:1461-1476`）本来就这么要求，只是 stage 侧没有执行。

---

## 10. Conversation 与 persona 的动态模型

### 10.1 多个 conversation 实例

- 一个 conversation context = 一个带 `bindings` 的 session。Discord 每个 guild、每个 DM、主人私聊、每个直播间各一个。修完 B5 后，这件事几乎是免费的。
- 并发：修完 B1 后，每个 context 一条 lane，全局并发由信号量控制（例如本地模型 1、云端 4）。只有“UI 当前可见”的 context 走 foreground stream，其他 context 的输出走各自的出口：Discord 走 `output:gen-ai:chat:message`，语音走 speech intent。

### 10.2 persona、记忆与 disclosure

现有基础：persona = card，而且 session 已按 `characterId` 分区。缺的是“多 card 并存”和“记忆的可见性”。

**分类放在 M1 的记录上，在 prompt 组装时强制执行，在输出侧再做一道检查**。三道都要有，不能只靠一句“请不要提及”：

```ts
interface MemoryRecord {
  id: string
  text: string
  provenance: { personaId: string, contextId: string, messageId?: string, runId?: string }
  about: string[] // 主体，例如 user:owner、topic:xxx
  interop: 'shared' | 'persona-private' // 能否被其他 persona 检索
  disclosure: 'speakable' | 'internal-only' | 'origin-persona-only'
  // speakable：任何能检索到它的 persona 都能说出来
  // internal-only：可以影响判断，不能说出来，也不能表现得像亲历过
  // origin-persona-only：只有来源 persona 能说
}
```

组装规则：

1. 检索时先按 `interop` 过滤，`persona-private` 对其他 persona 不可见。
2. 对当前 persona 来说，`disclosure !== speakable` 且来源不是自己的记录，**改写成第三人称的 context 事实**（“已知：用户对 X 过敏”）。不带来源 persona，不带“你们聊过”这类经历性措辞，并以 `authority: 'context'` + `SegmentInstruction('不要声称亲历，不要提及来源')` 注入。
3. 输出侧做一次廉价检查（规则或小模型）：回复里是否出现来源 persona 的名字或“上次你和…说过”这类句式。命中就重写或拦截。这一层可以延后，但数据标签必须一开始就有，否则以后无法回填。

默认值的建议：用户自己陈述的事实默认 `shared + speakable`。某个 persona 在私下场景得到的信息默认 `shared + internal-only`。明确的秘密设定默认 `persona-private`。

**persona 切换**：切换的是 conversation context，不是全局 card。

- **带过去**：当前 workload 的 M3 投影、该用户的 M1 可见记忆、切换原因（作为 context 事实）。
- **不带过去**：前一个 persona 的 M2 历史、它的口吻和自称。
- 全局 `activeCard` 只保留为“UI 当前展示的 persona”，runtime 不再读它（修 B4）。identity 在每次 run 时从 context 的 `personaId` 取。

**多 persona 同场**（群聊、直播联动）：服务端 `chats` 已经支持多个 `character` 成员。本地侧给每个 persona 各开一个 context，共享同一个 M3 lane，由调度器轮转发言权。speech intent 的 `ownerId` 已经能区分说话者。

---

## 11. 渐进式演进路径

每一步都能独立合入，也都先修一个真实的 bug。

| 阶段 | 内容 | 顺手解决 | 触及范围 |
| --- | --- | --- | --- |
| **P0 纠偏** | registry 按 `destinations/lane` 投影，加 TTL 和总预算。外部绑定来源自动创建 meta（Discord 的 sessionId 变成 bindings）。`forkSession` 记录 `parentSessionId`。spark ticker 收归 synced leader | B2、B5、B6、B10 | core-agent registry、session-store、character-orchestrator |
| **P1 AgentContext** | 扩展 `ChatSessionMeta`（kind、personaId、bindings、status、digest）。按绑定键 resume。run 表 + 贯通 `runId` | B11、§6.1 | stage-ui 类型、session-store、orchestrator |
| **P2 多 lane runtime** | 每个 context 一个队列 + 全局信号量。foreground 只服务可见 context。从 `Brain` 抽出 `RunSupervisor` 放进 core-agent | B1、§6.3 | core-agent runtime，chat facade 适配 |
| **P3 调度器** | character-orchestrator 升级为 Scheduler：统一 workload 入口、salience 基线映射、coalesce、租约。spark-notify agent 作为 triage | B7（第一批：spark 与 chat 合流） | core-agent 新模块 + stage-ui 适配 |
| **P4 模型路由** | ModelProfile 聚合 + requirements + `resolveStep` 接入。consciousness 降级为默认档 | B3 | provider-inference、stage-ui |
| **P5 Prompt 配方** | 把 `streamWithStageAdapters` 里的组装逻辑下沉成 recipe 组装器。启用 `history-block` 压缩并导出 compaction。identity 不再快照进 session | B4、B8、B9 | core-agent messages、chat facade |
| **P6 主 memory** | Memory Service（模块形态）+ provenance + 可见性标签 + 回写管线 | §7 | 新包 + memory-pgvector |
| **P7 persona 并存** | 多 card 同时持有 context。disclosure 组装规则 + 输出检查 | §10 | airi-card、组装器 |
| **P8 动态 DAG 与外部 Agent 接入** | `parentRunId` 驱动的派生与结果路由。Minecraft Brain、satori 等通过 `spark:*` 接入统一 run 契约 | B7（其余） | 协议扩展（需要讨论） |

P0–P2 不改变任何产品行为，但做完以后，“动态 Agent”就只剩调度策略这一件事了。

---

## 12. 需要你们决定的问题

1. **JEV 的定义**。它是情绪、价值还是注意力模型？输入和输出是什么？是否需要持久状态？没有定义之前，本文只保留 `SalienceFn` 插槽和基线映射。
2. **调度器的宿主**。是长期留在 renderer leader，还是移到 Electron main 或 headless peer？这决定了 Discord 和直播能否在 UI 关闭时继续运转，也决定了 stage-web 和 stage-pocket 是否是一等公民。
3. **主 memory 存哪里**。是纯本地（duckdb-wasm 或 IndexedDB）、自托管 pgvector、还是官方云端？这会影响隐私承诺，以及跨设备的 persona 一致性。
4. **persona 可见性的默认值**。§10.2 的建议默认值是否符合产品设定？用户能否在 UI 里查看和改写记忆的可见性？
5. **自动记忆写入的门槛**。全自动、调度器审批、还是用户确认？
6. **并发与成本上限**。本地模型和云模型的并发数、每分钟 token 预算、谁能触发强模型。
7. **直播 workload 的最小范围**。只做弹幕到 commentary，还是包含推流控制？它是 persona 驱动还是独立皮套？
8. **外部 Agent 的接入深度**。Minecraft Brain、satori、telegram 是保持自治，只通过 `spark:*` 协作；还是把它们的 LLM 调用也交给中央调度器（统一模型路由和预算）？前者改动小，后者一致性强。
9. **Discord 会话的粒度**。按 guild、按频道，还是按 thread？B5 修复时就要确定，因为它就是 bindings 的形状。
10. **本文档的去向**。仓库规则要求文档用 simple English。如果要提交到上游 `moeru-ai/airi`，需要改写成英文，并拆成 ADR。

---

## 附录 A：验证用的临时测试

在 `packages/core-agent/src/runtime/` 下临时创建，跑完后已删除，没有进入提交。运行方式：先 `pnpm install --filter "@proj-airi/core-agent..."`，再 build `stream-kit`、`server-shared`、`provider-inference`，然后执行 `pnpm exec vitest run --config vitest.config.ts <file>`（在 `packages/core-agent` 目录下）。

结果：`Test Files 1 passed, Tests 2 passed`。两条断言都描述了**当前行为**，所以通过即证实了 B1 和 B2。

```ts
// 测试 1（B1）：game 会话的请求未结束时，chat 会话的请求根本没有开始
const a = runtime.ingest('slow game planning', opts, 'game')
const b = runtime.ingest('hi', opts, 'chat')
await sleep(20)
expect(timeline).toEqual(['start:game'])
releaseA()
await Promise.all([a, b])
expect(timeline).toEqual(['start:game', 'end:game', 'start:chat', 'end:chat'])

// 测试 2（B2）：两个 Discord guild 的 append-self 通知都出现在主人私聊的 prompt 中
registry.ingest(discordNotice('g1'))
await runtime.ingest('from discord g1', opts, 'discord-guild-g1')
registry.ingest(discordNotice('g2'))
await runtime.ingest('from discord g2', opts, 'discord-guild-g2')
await runtime.ingest('private chat with the owner', opts, 'owner-private')
expect(seen['owner-private']).toEqual([
  'discord-bot:The input is coming from Discord guild g1.',
  'discord-bot:The input is coming from Discord guild g2.',
])
```

测试 harness 直接用 `createChatOrchestratorRuntime` 和 `createContextRegistry`。LLM 端口是假的，只记录每个 session 收到的 `runtime-context` 条目。

## 附录 B：本文未覆盖或未验证的部分

- B5 没有在真实 Discord 环境里复现。
- stage-pocket（Capacitor）的后台生命周期限制没有调研。它会影响“调度器宿主”这个决策。
- `services/computer-use-mcp` 和 `airi-plugin-claude-code` 只看了入口，没有评估它们能否作为“子 Agent”接入 run 契约。
- 服务端 `chat-ws` 的实时路由没有深入。如果调度器上云，需要补这部分。
