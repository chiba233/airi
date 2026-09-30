# AIRI 动态认知调度架构白皮书

版本：v0.3（可行性评估版）
状态：调研与可行性评估，不是 ADR，也没有实现
基线：`main` @ `07c6353`（2026-09-30）
范围：`packages/core-agent`、`packages/stage-ui`、`packages/plugin-protocol`、`packages/server-runtime`、`packages/provider-inference`、`integrations/*`、`plugins/*`、`server/apps/api`，以及外部的 TypeSafe Jev、moeru-ai/apeira、pi

修订记录：

- v0.1：现状调研与目标架构（§0–§12）。
- v0.2：架构张力复核（§13），并修订 §7.1、§8.1、§8.2。
- v0.3：校正 JEV 的定义（TypeSafe 的 System 1 决策模型），新增执行摘要、JEV 决策层（§14）、能力矩阵（§15）、实测数据（§16）和风险登记（§17）。

本文用 `path:line` 引用代码。“已验证”表示跑过临时测试（见附录 A），“静态推断”表示只读了代码、没有执行。

---

## 执行摘要

**结论：有条件可行。** 执行层的原语大部分已经存在，阻碍都能定位，并且已经量化。真正需要新建的只有三样：调度器、主 memory、共享工作记忆的约束。项目处在最早期，迁移成本低，这是有利条件。

| 维度 | 判断 | 依据 |
| --- | --- | --- |
| 技术可行性 | 高 | session 已经能充当可恢复的认知线；`resolveStep` 已经能逐步切换模型；协议层已经有路由和状态字段（§2）。阻碍集中在“全局只有一个前台对话”这个假设上（§3） |
| 性能可行性 | 取决于算力容量 | 在模拟负载（1.7 Erlang）下，现有全局队列让主人私聊的 p95 等待达到 113 秒。改成每个 context 一条 lane、2 个模型槽后降到 1.7 秒。只有 1 个模型槽（单个本地模型）时系统过载：优先级只能决定谁挨饿，必须靠合并和丢弃来卸载（§16.2） |
| 经济可行性 | 高（用 JEV 做 triage 时） | 现在的 LLM triage 每次约 1,611 个输入 token。换成 JEV 后，每 1 万次决策的成本从 1.41–23.61 美元降到约 0.09 美元（§16.5） |
| 上下文可行性 | 需要先做治理 | 当前的共享上下文每小时增长约 2.6 万 token，而且每次聊天都会附带（§16.3）。一个 2000 条消息的 session 恢复时约需 7.7 万 token（§16.4）。压缩和预算是前置条件，不是优化项 |
| 生态 | 借鉴设计，不替换运行时 | pi 的执行层最完整，但运行时栈和浏览器约束与 AIRI 不同。apeira 与 AIRI 同属 moeru-ai、同样基于 xsAI，但 0.0.8 版本已宣布要完全重写。两者都没有调度器、长期记忆、共享工作记忆和 persona（§15） |

**最高的四个风险**（完整清单见 §17）：

1. 算力不足时，调度器只是在转移饥饿。
2. 共享上下文已经在膨胀。
3. JEV 会被不可信文本注入。有公开测试中，注入指令让它以 82% 的置信度给出错误答案。
4. 低信任来源的说法可能被误写进主 memory。

**建议的起步顺序**：

1. 先做 P0–P2（§11）：修上下文隔离、会话持久化，改成多 lane runtime。这一步不依赖任何新的产品决策。
2. 把 JEV 接到 spark-notify 的 triage 上做小规模试点，用 AIRI 自己的事件和中日英三语样本测准确率和校准度。

---

## 0. 先校正几个事实

调研输入里有几条设想和仓库现状对不上。后面的设计都基于校正后的事实。

| 设想 | 代码事实 | 影响 |
| --- | --- | --- |
| JEV 在调度里的角色需要另行定义 | **v0.1 这一行写错了。** JEV 是 TypeSafe 在 2026-09-15 发布的 System 1 决策模型：不生成文本，只对给定的 `state` 回答 `choice`、`score`、`noul` 三类有类型的问题，并返回概率（§14）。仓库里确实还没有接入它（代码零命中），这一点仍然成立 | JEV 正好补上调度器的“快判断”层：显著性、路由、resume 还是 create、是否值得记忆。原先留给 `SalienceFn` 的插槽，就是 JEV 的位置 |
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

接入 JEV（§14）后，这些词汇降级为生产者提供的先验。最终显著性由 JEV 的 `score` 问题给出，再与先验合成（§8.2）。

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
2. 给 workload 打分（先验 + JEV，§8.2），决定立即执行、延迟、合并或丢弃。
3. 选 context：resume、fork 或 create（§6.2）。
4. 选模型（§8.3），产出 PromptRecipe。
5. 发起 run，维护 run 表，执行监督策略（§6.3）。
6. 路由结果：写 working memory、定向 `spark:command`、触发后续 workload（DAG 的下一跳）。
7. 做生命周期整理：idle 到 dormant 的降级、digest 更新、记忆回写的触发。

**不做**：

- 不亲自生成对用户的回复。对话由 conversation context 的 run 完成。
- 不保存模块状态。模块自己持有状态，调度器只拿 handle，也就是 `contextId`。
- 不做上游可用性路由。那是服务端 llm-router 的事。
- 不在热路径上每一步都调 LLM。默认走确定性策略。v0.1 原本写的是“只有歧义时才调用 triage 模型”。§14.4 的成本数据改变了这个前提：可以对每个后台 workload 都问一次 JEV。现有的 spark-notify agent 保留为 LLM 回退。

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
  salience: number // 0..1，由 JEV 的 score 给出（§14）
  expiresAt: number // TTL
  version?: number // 可选。见 §13.10，初期不需要
  sourceRef?: { refType: string, targetId: string } // 指回原始来源
}
```

- **容量**：总预算 `B_wm` 按 token 计（建议 300–800），每个 writer 有配额，单条 ≤ 80 token。超出时**写入被拒**，写入方必须改写成一个 reference。
- **准入与淘汰**：`keep = salience × freshness(age, ttl)`。写入时如果放不下，就淘汰 keep 最低的条目。低于新条目的 keep 才淘汰，否则拒绝新条目。
- **并发**：按 `contextId` 分槽，默认 replace-self，同一槽位后写覆盖（LWW）。registry 只在 leader 里同步执行，本来就是串行的，所以初期不需要 CAS（§13.10 修订）。`append-self` 只允许固定几个事件型槽位，并设条数上限。
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
  kind: string // 由生产者声明的不透明字符串，调度器不解析含义（§13.1 修订）
  origin: { event: string, eventId: string, source: string } // 指回 spark:notify 或 input 等
  bindings: string[]
  salience: number // 0..1，见 8.2
  deadlineAt?: number // 例如 spark:notify.ttlMs 换算
  coalesceKey?: string // 同 key 合并，仿 Brain.coalesceQueue
  requirements: ModelRequirements // 由生产者或模块 manifest 声明，调度器不推断
}
```

### 8.2 salience（先验 + JEV）

JEV 是一个决策模型，不是一段需要我们实现的算法（§14）。调度器把显著性定义成一个函数：

```ts
type SalienceFn = (w: Workload, world: SchedulerSnapshot) => number // 0..1
```

它的实现分两层：

- **先验**：来自**生产者自己填的** urgency 或 priority 字段，映射为 `critical/immediate → 0.9`、`high/soon → 0.7`、`normal → 0.5`、`low/later → 0.3`。Minecraft Brain 的 LLM 已经在自己决定 `notifyAiri` 的 urgency。调度器只做数值映射。“用户直接对话 ≥ 0.8”这类跨来源偏好属于用户配置，不是调度器内置的领域知识（§13.1）。
- **JEV 判断**：一次 `score` 问题（例如 1–5 级紧急度），`criteria` 由模块 manifest 提供。最终值等于先验与 JEV 期望值的加权，再乘以来源信任系数（§14.5，防注入）。JEV 不可用时，只用先验。

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
| **P0 纠偏** | registry 按 `destinations/lane` 投影，加 TTL 和总预算。外部绑定来源自动创建 meta（Discord 的 sessionId 变成 bindings）。`forkSession` 记录 `parentSessionId`。spark ticker 收归 synced leader。`context-providers/minecraft.ts` 的领域文案移回 Minecraft 模块（§13.1） | B2、B5、B6、B10 | core-agent registry、session-store、character-orchestrator |
| **P1 AgentContext** | 扩展 `ChatSessionMeta`（kind、personaId、bindings、status、digest）。按绑定键 resume。run 表 + 贯通 `runId` | B11、§6.1 | stage-ui 类型、session-store、orchestrator |
| **P2 多 lane runtime** | 每个 context 一个队列 + 全局信号量。foreground 只服务可见 context。从 `Brain` 抽出 `RunSupervisor` 放进 core-agent | B1、§6.3 | core-agent runtime，chat facade 适配 |
| **P3 调度器** | character-orchestrator 升级为 Scheduler：统一 workload 入口、salience 先验映射、合并与丢弃（§16.2）、租约。先用 JEV 做 triage 试点（§14），spark-notify agent 作为 LLM 回退。`module:announce` 增加可选的 `cognition` 块作为目录。chat 的 `spark_command` 工具收进准入层（§13.1、§13.7） | B7（第一批：spark 与 chat 合流） | core-agent 新模块 + stage-ui 适配 |
| **P4 模型路由** | ModelProfile 聚合 + requirements + `resolveStep` 接入。consciousness 降级为默认档 | B3 | provider-inference、stage-ui |
| **P5 Prompt 配方** | 把 `streamWithStageAdapters` 里的组装逻辑下沉成 recipe 组装器。启用 `history-block` 压缩并导出 compaction。identity 不再快照进 session | B4、B8、B9 | core-agent messages、chat facade |
| **P6 主 memory** | Memory Service（模块形态）+ provenance + 可见性标签 + 回写管线 | §7 | 新包 + memory-pgvector |
| **P7 persona 并存** | 多 card 同时持有 context。disclosure 组装规则 + 输出检查 | §10 | airi-card、组装器 |
| **P8 动态 DAG 与外部 Agent 接入** | `parentRunId` 驱动的派生与结果路由。Minecraft Brain、satori 等通过 `spark:*` 接入统一 run 契约 | B7（其余） | 协议扩展（需要讨论） |

P0–P2 不改变任何产品行为，但做完以后，“动态 Agent”就只剩调度策略这一件事了。

---

## 12. 需要你们决定的问题

1. **哪些决策交给 JEV**。§14.2 给出了建议清单。需要确认三件事：是否接受 JEV 作为云端依赖（目前没有本地版本）；中文和日文输入的置信度是否达标（§14.5，尚未实测）；事件内容发给第三方是否符合 AIRI 的隐私承诺。
2. **调度器的宿主**。是长期留在 renderer leader，还是移到 Electron main 或 headless peer？这决定了 Discord 和直播能否在 UI 关闭时继续运转，也决定了 stage-web 和 stage-pocket 是否是一等公民。
3. **主 memory 存哪里**。是纯本地（duckdb-wasm 或 IndexedDB）、自托管 pgvector、还是官方云端？这会影响隐私承诺，以及跨设备的 persona 一致性。
4. **persona 可见性的默认值**。§10.2 的建议默认值是否符合产品设定？用户能否在 UI 里查看和改写记忆的可见性？
5. **自动记忆写入的门槛**。全自动、调度器审批、还是用户确认？
6. **并发与成本上限**。本地模型和云模型的并发数、每分钟 token 预算、谁能触发强模型。
7. **直播 workload 的最小范围**。只做弹幕到 commentary，还是包含推流控制？它是 persona 驱动还是独立皮套？
8. **外部 Agent 的接入深度**。Minecraft Brain、satori、telegram 是保持自治，只通过 `spark:*` 协作；还是把它们的 LLM 调用也交给中央调度器（统一模型路由和预算）？前者改动小，后者一致性强。
9. **Discord 会话的粒度**。按 guild、按频道，还是按 thread？B5 修复时就要确定，因为它就是 bindings 的形状。
10. **本文档的去向**。仓库规则要求文档用 simple English。如果要提交到上游 `moeru-ai/airi`，需要改写成英文，并拆成 ADR。
11. **模型池策略**。§16.2 表明，只用一个本地模型撑不住多场景并发。可选的方向有三种：混合云端模型池、限制同时开启的场景数、接受后台场景长时间延迟。
12. **core-agent 与 apeira 是否合流**。两者同源同栈，apeira 正在重写。是现在就参与它的新设计，还是等它稳定后再评估？

---

## 13. 架构张力复核（A–G）

这一节逐条检验讨论中提出的 7 个 design tension。每条先给代码事实，再给判断。有几条会推翻本文前面的写法，已经在正文对应位置标了“§13 修订”。

### 13.1 A：scheduler 会不会变成新的单体

**代码事实：领域知识目前一半在模块里，一半漏进了 stage 核心。**

模块自己持有的部分，比预想的多：

- **Minecraft 自己决定什么值得上报、有多紧急。** `Brain` 把 `notifyAiri(headline, note, urgency)` 和 `updateAiriContext(text, hints, lane)` 作为工具交给它自己的 LLM（`integrations/minecraft/src/cognitive/conscious/brain.ts:765-768`）。状态发布器用固定的 `contextId + lane + hints` 做 replace-self（`integrations/minecraft/src/airi/minecraft-context-service.ts:171-197`）。也就是说，“这件事重不重要”是 Minecraft 的认知在判断，不是 stage 在判断。
- **Discord adapter 自己决定会话粒度和上下文**，包括 guild 或 DM 的 sessionId、`messagePrefix`、`contextUpdates`（`integrations/discord-bot/src/adapters/airi-adapter.ts:249-276`）。
- **extension 自己拥有 toolset prompt**：`SerializedToolsetPromptDefinition.ownerExtensionId`。tool 的 relevance 线索也由 extension 声明：`activation.keywords/patterns`（`packages/plugin-sdk-tamagotchi/src/tools/registry.ts`）。

漏进 stage 核心的部分：

- `packages/stage-ui/src/stores/chat/context-providers/minecraft.ts` 在 chat store 里硬编码了一整段 Minecraft 语义说明，而且**每次发送都注入**。
- `gaming-minecraft` store 自己处理 `spark:command` 和 registry 健康事件。
- `VISION_WORKLOADS` 表写在 stage-ui 里。
- `useModulesList` 是手写的模块清单。

所以风险是真的，而且**已经在小规模发生**：现在没有 scheduler，领域知识就漏进了 chat facade。以后有了 scheduler，它会自然成为下一个漏斗。

**第二个事实：调度方没有“目录”。** spark-notify 的 `builtIn_sparkCommand` 要求 LLM 填 `destinations: string[]`（“List of sub-agent IDs”，`packages/core-agent/src/agents/spark-notify/schema.ts:90`），但 prompt 里只告诉它触发事件的来源模块名（`agent.ts` 的 `getSparkNotifyHandlingAgentInstruction`），没有可用 destination 的清单。LLM 只能猜。缺目录的系统，最后都会靠在中心写死名字来补洞。

**已有的声明机制，以及它们缺什么：**

| 机制 | 已经声明了 | 缺的认知路由信息 |
| --- | --- | --- |
| `module:announce` | `possibleEvents`、`permissions`、`configSchema`、`dependencies` | 发布哪些 lane，接受哪些 destination 或 intent |
| kit descriptor | `capabilities: [{ key, actions }]`（权限用，例如 `kit.gamelet.runtime`） | 与认知无关 |
| tool descriptor | `activation.keywords/patterns`、toolset prompt | 已经够用 |
| `registry:modules:sync` | 在线模块列表 + identity | 能力摘要 |
| 事件信封 | urgency、priority、interrupt、ttl、lane、destinations、contextId、hints | 已经够用 |

**判断**：

scheduler 可以理解名字和数字，不理解含义。它能读的字段全在信封和 manifest 上：workload `kind`（不透明字符串）、`lane`、`bindings`、salience、deadline、requirements、`parentRunId`、资源占用。领域含义放在三个地方：

1. **生产者**：模块决定 urgency、lane、destinations。Minecraft 已经这么做了。
2. **模块 manifest 里的认知块**：在 `module:announce` 上加一个可选的 `cognition` 字段，声明 lanes、可接收的 intent、它产出的 workload kind 及默认 requirements，以及一段“如何理解我的 context”的 prompt 片段。这和 toolset prompt 由 extension 拥有是同一个模式，不是新机制。
3. **执行 context 的 prompt recipe**：领域 prompt 片段由模块提供，scheduler 只负责按 `kind` 把片段接上。

需要 LLM 做 triage 时，triage prompt 由各模块 manifest 的描述**拼接**而成，scheduler 代码里不写任何领域句子。

**一条可检查的适应度规则**：新增一个模块（例如直播）时，scheduler 的代码改动必须为零，只允许改模块自己和用户配置。`context-providers/minecraft.ts` 就是违反这条规则的现存反例，它应该在 P0 时移回 Minecraft 模块，以 manifest 的 prompt 片段或 replace-self 状态的形式提供。

**对前文的修订**：§8.1 和 §8.2 原来的写法里有 `'game:react'` 这类 kind 示例，还有“用户对话 ≥ 0.8”这种内置偏好，暗示 scheduler 懂领域，已经改掉。跨来源的偏好（例如“主人私聊优先于 Discord 群”）是**用户配置**，不是 scheduler 的知识。

### 13.2 B：三层状态的认知语义

**代码里已经隐含了分层，而且作者已经写出过其中一条语义边界。**

- `createUserAccountContext` 的 prompt 原文：“A requested nickname in chat applies to this conversation. Do not claim that it updates the account or persistent memory.”（`packages/stage-ui/src/stores/chat/context-providers/user-account.ts`）。它明确区分了“会话内成立的说法”和“权威记录”，而且把“persistent memory”当成第三种东西。它的注释还写了 “The caller must not persist this snapshot.”，说明这个快照属于 request 作用域。
- Minecraft context 的 prompt 写着 “AIRI should still rely on live bot context before assuming the bot can act”（`context-providers/minecraft.ts`）。这是在 prompt 里手工表达新鲜度。
- session 的云合并按指纹取并集，只追加不改写（`packages/core-agent/src/session/merge-loaded-session-messages.ts`）。它把会话当成**事件日志**，不当成可变状态。
- registry 的 replace-self 是“最新观察覆盖旧观察”，没有持久化，`cleanup` 时整体清空。

**当前的 source of truth**：会话历史以 leader 的 IndexedDB 为准，云端按 seq 合并进来。registry 没有 source of truth，只是内存。模块状态由模块自己负责。主 memory 不存在。

三层之间**没有任何一致性机制**。实际的“冲突解决”靠的是 prompt 位置：`runtime-context` 挂在最后一条 user turn 上，所以离生成最近，LLM 天然更相信它。这是一个偶然结果，不是设计出来的。

**判断：三层不是同一事实的三级缓存，而是三种认识论类型。**

| 层 | 本质 | 对什么有权威 | 不对什么有权威 |
| --- | --- | --- | --- |
| 主 memory | **信念**：经过整合、带出处、可修订的长期判断，加上调度史 | 持久的偏好、关系、承诺，“哪条 context 做过什么” | 世界此刻的状态 |
| Agent context | **情节**：一条认知线看到和说过的东西 | “在这条线里发生过什么” | 现在是否仍然成立 |
| shared context | **注意力面**：此刻值得共同注意的少量观察和指针 | 无。它只表达“这件事现在值得看” | 任何事实 |
| 模块状态 | **世界**：唯一描述当前状态的来源 | 现在是什么样 | 历史意义 |

照这个语义，“主 memory 说 A、Agent context 说 B、shared context 说 C”**不是冲突**。它说的是：“我们一直相信 A；在这条对话里曾经出现过 B；此刻有人提醒大家注意 C”。三句话可以同时为真。要回答的问题，决定该读哪一层：

- 问**此刻的世界**：模块 > 新鲜的 shared 条目（它只是指路，最终要回源）> memory > context。
- 问**用户在这里说过什么**：context 是唯一权威。
- 问**长期应该相信什么**：memory。新情节和旧信念不一致时，整合环节写一条**新的**带出处的信念，不覆盖旧的，也不去改写情节。

**需要的显式语义只有三样**，而且大部分已经存在：

1. **authority**：由所在层决定。进 prompt 时映射到 `SystemTurn.authority`，外部事实一律用 `context`。
2. **freshness**：`observedAt` 或 `createdAt`。`ContextMessage.createdAt` 已经有。
3. **scope**：`personaId`、`bindings`、`destinations`。前两个在 §4.3 里，第三个协议里已经有。

不需要通用的 merge 算法。

**哪些可以从 Agent context 回写主 memory**：用户陈述的稳定事实和偏好、关系事件、做出的承诺、有持久后果的任务结果，以及 context 的 digest（写入调度史）。

**哪些不应该升级为全局知识**：

- 会话内约定。昵称就是现成的例子，代码已经禁止它“更新 persistent memory”。
- 中间推理。
- 模块某一时刻的状态快照。
- 角色扮演中的设定性内容，除非明确打了标签。
- **低信任来源对高信任主体的断言**，例如 Discord 陌生人关于主人的说法。按现在的 `messagePrefix` 设计，这些说法会以 user 身份进入会话，最危险的误升级路径就在这里。

**shared context 是 attention surface，不是权威状态。** 正因为它不是权威，它才可以很小、可以丢、可以不持久化，也不需要强一致。如果把它当成权威，就必须给它持久化、版本和冲突处理，它就会长成第二个数据库。这就是你们担心的膨胀路径。

### 13.3 C：Agent identity 与 execution instance 要不要拆

**代码里已经拆开了，只是没有叫“Agent”。**

| 代码概念 | 实际承担的身份 |
| --- | --- |
| character（card） | persona 配置：identity prompt + 形象（VRM、Live2D、声音）+ 默认模型 |
| session（meta + messages） | **认知线（lineage）**：不运行也存在，持久化，按 `characterId` 分区 |
| `QueuedSend` / `performSend` | **一次执行**：有 `AbortController` 和 `generation`，结束即消失 |
| `AssistantTurn` | 一次执行的产物记录 |
| `GenerationRound` | 一次模型调用 |
| spark-notify agent | 执行**程序**：无状态的 handler |
| Minecraft `Brain` | 程序、线程、执行**三者合一**的长驻对象，历史只在内存，进程重启就丢 |

最有力的证据是字段注释：`AssistantTurn.runId` 写着 “Supplied by the agent scheduler when this turn belongs to an identified run”（`packages/core-agent/src/messages/types.ts:51`）。core-agent README 也写了 “A run id refers to a real scheduler execution, not the number of rounds.”。作者在数据模型里已经给“调度器发起的一次执行”预留了身份，只是还没有调度器来填它（B11）。

**判断：值得明确拆开，但要拆成三样，而不是两样。**

- **recipe（程序）**：怎样处理某类 workload。例如 spark-notify 的 plugin 组合、conversation 的 prompt 配方。无状态，可以共享。
- **lineage（认知线）**：就是 session。持有情节、persona、bindings 和 digest。
- **run（执行）**：recipe × lineage × 模型选择 × 预算。由 scheduler 发起，产出若干 `AssistantTurn`。

之所以要把 recipe 单独拎出来，是因为同一条 lineage 可以先后被不同 recipe 执行。比如同一个 Discord 频道的 context，一次是回复，一次是整理摘要。同一个 recipe 也可以同时跑在很多 lineage 上。两者混在一起，就会重新得到“一个 Agent = 一个 prompt 文件”，正好是你们想避免的配置地狱。

**不需要为 identity 新建注册表**，session index 就是。要补的只有三处：meta 上的 status、bindings、digest，填上 `runId`，以及 fork 的血缘。

### 13.4 “Agent 可以 inactive 但仍然存在”在 AIRI 里怎么理解

就是 **session 存在但没有 run 在引用它**。这在今天已经是常态：你关掉一个聊天窗口，它的 session 还在 IndexedDB 里，下次 `loadSession` 就恢复了。

所以这不是需要发明的能力，只是需要**被调度器看见**的能力。现在的缺口在于：

- 外部来源的 lineage 根本建不起来（B5）。
- lineage 没有可以检索的元数据（bindings、digest）。
- 没有降级和卸载策略，所以无法区分 idle 和 dormant。

反例是 Minecraft `Brain`。它的“存在”依赖进程在运行，历史只在内存，上限 200 条。它是全仓库里唯一一个“不运行就不存在”的认知体。是否要把它的 lineage 也外置成 session 形态，属于 §12 第 8 条的决策。

### 13.5 F：workload 应不应该比 Agent 更接近一等对象

**应该。代码里的一等调度对象本来就不是 Agent，而是各种 workload：**

| 形态 | 位置 | 字段 |
| --- | --- | --- |
| `QueuedSend` | core-agent runtime | sessionId、generation、cancelled |
| `spark:notify` | 协议 | kind、urgency、ttl、destinations |
| `ScheduledTask` | notebook | priority、status、dueAt、nextNotifyAt |
| `VisionWorkloadId` | stage-ui | 按 id 取 prompt |
| `BotEvent` + 优先级层 | Minecraft Brain | 4 级、coalesce |
| action queue entry | Minecraft Brain | pending/executing/… |
| unread events | satori-bot | 队列 + 循环上限 |

仓库里叫 “agent” 的东西（spark-notify agent、spark-command 的 “sub-agents”）全都是**处理 workload 的 handler 或接收方**，没有一个是被调度的对象。

所以“调度 workload，再决定用哪条 lineage 和哪个 recipe 去执行”不是新范式，而是**把 7 种分散的 workload 形态收敛成一个信封**。信封只需要一个最小公共子集：`id / kind / origin ref / bindings / salience / deadline / coalesceKey / requirements / parentRunId`，业务负载以引用的形式挂在上面。不要把它做成一个大而全的 Task 模型，否则各模块的 workload 语义又会被迫汇进中心。

### 13.6 D：multi-agent 还是 distributed cognition runtime

**判断：两者都对，但各自只对一侧的边界成立。以网络协议为界。**

- **协议边界之外是联邦式 multi-agent。** plugin-protocol 的词汇就是这么写的：“agents in a network”、“sub-agents”、`destinations`、`ack`、“Assume exactly-once 是错的”。Minecraft Brain、satori、telegram 是真正自治的：各自有快循环、反射层、记忆和失败处理，还可能跑在别的机器上。对它们只能协商（`spark:*`），不能接管。
- **协议边界之内是共享底座的认知 runtime。** stage 里所有“认知线”共用一个 provider 池、一个 session 存储、一个 speech 出口、一套 persona、一个 leader。它们没有独立的资源，也没有独立的失败域，把它们称为自治 Agent 是不准确的。

混用两种模型会把系统往两个错误方向拉：

- 在边界内用 multi-agent 思维，会推出 Agent 之间互相聊天、每个 Agent 一套私有记忆、Agent 注册中心这些东西。这和“共享底座”正好相反，§9 里的信息丢失问题会被放大。
- 在边界外用 runtime 思维，会想把 Minecraft 的反射层和 60s 超时收进中央 scheduler。这就是 A 里的 God Object。

边界内最稳定的一等概念是：**workload、lineage（context）、memory、persona（perspective）、capability（模块声明）**。Agent 退化成一次 run，是一个执行单元，而不是最高层抽象。

如果一定要类比，最贴近的是操作系统：

- recipe ≈ 程序
- lineage ≈ 进程（可以挂起）
- run ≈ 调度时间片
- shared context ≈ 共享内存里的一小块
- 模块 ≈ 设备和驱动
- 协议 ≈ IPC 和网络

### 13.7 E：动态图的创建权放在哪

**代码里三种模式已经同时存在：**

1. **提议、由 host 落地**：spark-notify 的 LLM 只产出 command 草稿。id、`parentEventId` 由 host 生成，没有 destinations 的草稿直接丢弃（`agent.ts` 的 `expandCommand`）。
2. **直接下发**：chat LLM 的 `spark_command` 工具在 `execute` 里立即 `sendSparkCommand`（`packages/core-agent/src/agents/spark-command/tools.ts:40-72`），不经过任何准入。
3. **向上提议**：Minecraft 的 LLM 调 `notifyAiri`，由 AIRI 侧决定是否处理。

**判断：只有 scheduler 能让一个 run 真正存在。其他 run 只能提议。**

- 子 run 通过一个 tool 提交 workload 请求，拿到 ticket。scheduler 同步做准入：接受、合并到已有 workload、拒绝或延迟。子 run 可以按 ticket 等待结果（join）。准入是确定性逻辑，而且 leader 是单线程 JS，不需要任何分布式协商，所以这层中转的延迟可以忽略。§9.3 担心的延迟来自“中转时再调一次 LLM”，不是来自中心化本身。
- 这样 `parentRunId` 总是由 scheduler 写，因此取消可以级联，预算可以按子树统计，trace 是一棵完整的树。
- 给**外部自治模块**发 `spark:command` 是效果，不是 spawn。可以从 run 里发出，但要经过 scheduler 的租约检查（§8.2）。今天 chat 工具绕开检查直接发送的路径，P3 时要收进准入层。
- 深度和扇出设硬上限。

不选“子 Agent 直接 spawn”的原因是它破坏了三件已经靠单点得到的东西：取消（`AbortController` 只在发起方手里）、代际拒绝（`sessionGeneration`）和资源预算。

### 13.8 G：persona 是 Agent 还是 perspective

**代码事实：persona 从来没有进程。**

- card 是纯配置，包括 identity prompt、形象（`vrm/live2d/displayModelId`）、声音、默认模型和 artistry（`packages/stage-ui/src/types/airiCard.ts`）。
- 没有任何东西按 character 运行。切 card 就是换一套配置。
- session 按 `characterId` 分区，所以 persona 的连续性已经存放在它的 lineage 里。

**判断：persona 是 persistent perspective + embodiment，不是 Agent。**

它由这些部分构成：

- identity 和风格 prompt。
- lineage 集合（它参与过的认知线）。
- memory 的检索边界与 disclosure 策略（§10.2）。
- **形象资源**：声音和舞台上的模型。

最后一项常被忽略，但它是真实的资源约束。舞台上同一时间通常只显示一个模型，speech 通道也只有一个。多个 persona 同时活跃时，scheduler 需要仲裁的是**形象租约**，不是“哪个 persona 进程在跑”。

有两个容易混淆的东西需要标出来：

- `spark:command.guidance.persona` 是给下游模块的**行为倾向向量**（勇敢度、谨慎度等），和“人格或皮套”不是一个概念。后续命名上最好分开，否则会误导设计。
- `AiriExtension.agents: Record<string, { prompt, enabled }>` 是一个**从未被使用**的字段，所有写入点都是 `{}`（`airi-card.ts:383, 507`，`airi-card-import-export.ts:244`）。它通往的正是“每个 persona 一套固定 Agent prompt”的配置地狱，不应该作为扩展点。

### 13.9 现有抽象已经回答了的部分

| 问题 | 现有答案 |
| --- | --- |
| identity 与 execution 分离 | session 与 `QueuedSend`、`AssistantTurn.runId` 的注释 |
| inactive 但存在 | session 持久化 + `loadSession` |
| 由模块判断显著性 | Minecraft `notifyAiri(urgency)`，事件信封字段 |
| 状态槽位与覆盖语义 | `context:update` 的 `contextId` + replace-self |
| 会话内说法与权威记录的区分 | `user-account` context 的昵称规则 |
| 外部事实不获得指令权 | `SystemTurn.authority: 'context'` |
| 提议、由 host 落地 | spark-notify 的 `expandCommand` |
| 跨模型恢复不丢内容 | continuation scope + `projectionIssues` |
| 外部 peer 活性 | server-runtime 心跳与健康事件 |
| 运行中 run 的取消与过期拒绝 | `AbortController` + `sessionGeneration` |

### 13.10 伪问题：不需要为它们增加架构复杂度

1. **共享池的并发写冲突。** registry 只在 leader 里同步执行，JS 单线程天然串行，同一槽位后写覆盖即可。既然 shared context 不是权威（§13.2），偶尔覆盖错也不会造成事实错误。本文 §7.1 原来提议的 `version/CAS` 已经降为可选。
2. **进程内 run 的心跳。** 在同一进程里，promise 是否 pending、最近一次 stream 事件的时间、`AbortController` 已经足够。心跳只对跨进程 peer 有意义，而 server-runtime 已经实现了。
3. **三层记忆的通用 merge 算法。** 三层的语义不同，“不一致”大多是正常状态。真正需要处理的只有信念整合，而那是一个写入新信念的过程，不是 merge。
4. **Agent 注册中心或 identity 服务。** session index 就是。
5. **用 LLM 做信息路由。** 有了 lane、destinations、bindings 和 manifest 之后，绝大多数路由是查表。LLM 只用于歧义 triage。
6. **persona 的 active/inactive 状态。** persona 从不运行，只有 lineage 和 run 有状态。
7. **通用 DAG 引擎。** 仓库里能看到的所有多步流程（notify → command → emit，Minecraft action queue，artistry 旁路）深度都是 1–2 层，而且是树。有 `parentRunId` 就够了，DAG 执行器等真的出现 join 型 workload 再说。
8. **由 scheduler 判断“哪个人格适合当前场景”。** 大多数场景由 binding 决定。哪个 Discord 服务器、哪个直播间用哪个皮套，是用户配置，不是认知问题。只有“同一场景里要不要切人格”才需要判断，而这属于 conversation recipe 的职责。

**反过来，这些是真问题，不能当成伪问题：**

- 领域知识漏进 stage 核心（§13.1）。
- 调度方没有目录（§13.1）。
- chat 工具绕过准入直接下发 command（§13.7）。
- `runId` 没有贯通（B11）。
- 低信任来源的断言可能被误升级成主 memory（§13.2）。

---

## 14. JEV：System 1 决策层

### 14.1 事实

下表只收录能找到来源的内容。来源之间有冲突的地方，照实列出。

| 项 | 内容 | 来源 |
| --- | --- | --- |
| 发布方与日期 | TypeSafe AI，2026-09-15 发布。`jev-latest` 别名于 2026-09-17 更新，当前固定版本为 `jev-1.13.0` | Respan、DataLearner、TanStack AI 文档 |
| 形态 | “System 1” 决策模型，**不生成文本**。输入 `state` 和一组有类型的问题，输出每个问题的答案和概率 | Respan、Datacamp |
| 问题类型 | `choice`：从最多 255 个选项里选一个，返回各选项概率和 `confidence`。`score`：2–10 级有序量表，返回按概率加权的期望值（可以是小数），以及各级概率。`noul`：是或否，返回 0–1 的单个值，没有 `confidence` | daleseo.com、Portkey 文档 |
| 接口 | `POST https://api.typesafe.ai/v1/systemone`，请求体为 `{ model, state, questions: { <name>: { type, instructions, criteria } } }`，响应为 `{ model, answers, usage }`。**本环境实测**：不带 key 调用时，返回 TypeSafe 自己的 `authentication_error`，说明 endpoint 真实存在 | daleseo.com，本文实测 |
| 延迟 | 厂商宣称 70–500ms。一位作者从多伦多实测 197–531ms。加问题数量几乎不影响响应时间 | Datacamp、daleseo.com、Respan |
| 上下文 | 多数来源写 32K token。daleseo.com 写的是请求上限 64K，其中 `state` 加最长问题不超过 32K。**两种说法有冲突，以官方文档为准，尚未核实** | 同左 |
| 价格 | 输入 0.042 美元每百万 token，输出免费 | Respan、Datacamp |
| 限流 | 250,000 token/秒，1,200 次请求/分钟 | Respan、daleseo.com |
| 流式 | 不支持 | Portkey 文档 |
| 渠道 | TypeSafe 直连，以及 OpenRouter、Cloudflare Workers AI、Vercel AI Gateway、OpenCode | pi 的 `docs/models.md` |
| 已知弱点 | 按字面理解文本，容易被误导性指令影响。注入测试中给出错误答案的置信度分别为 82% 和 73%。算术和多步日期比较不可靠。韩语的主观判断置信度比英语低 40–70%。不支持微调 | Respan、daleseo.com |

**生态先例。** pi 已经把 classifier 做成一种独立的模型类型（`findOfType('classifier', …)`，`classify()`）。它的示例 `jev-router.ts` 用 Jev 判断任务复杂度，决定用强模型规划、再切到便宜模型实现，并把路由阶段存在会话分支上。pi 还用 llama.cpp 在本地模拟同样的问答语义：读取单 token 标签的概率，文档里提到用 “JevBench” 评估。这是离线回退的现成思路。

### 14.2 JEV 在架构里的位置

JEV 的价值不只是“便宜的 LLM 替代品”，而在于它的输出是**概率，而不是文字**。调度决策因此变成“JEV 给出概率，确定性阈值做决定”，每一步都可审计，也可以回放调参。这也是 §13.1 那个问题的答案：领域含义写在问题的 `criteria` 里，而 `criteria` 由模块 manifest 提供；调度器只持有阈值。

| 决策 | 现在由谁做 | JEV 问题 | JEV 不可用时 |
| --- | --- | --- | --- |
| 要不要反应 | spark-notify 的 LLM，调 `builtIn_sparkNoResponse` | `noul` | 生产者给的 urgency |
| 路由给谁 | LLM 猜 `destinations`（§13.1） | `choice`，选项来自 manifest 目录（≤ 255） | bindings 查表 |
| 显著性 | 5 套词汇各自为政 | `score` 1–5 | 先验映射（§8.2） |
| resume 还是 create | 无 | `choice`，候选是确定性过滤后的 top-k context | §6.2 打分 |
| 模型档位 | 全局单模型 | `choice`：fast、default、strong（有 pi `jev-router` 先例） | consciousness 的默认模型 |
| 是否写入长期记忆 | 无 | `noul`（是否持久）+ `score`（重要度） | 不写 |
| disclosure 检查 | 无 | `noul`：回复是否暗示经历过其他 persona 的事 | 规则匹配 |
| run 是否偏离或已完成 | 无 | 对 run 摘要问 `noul` | 确定性监督（§6.3） |
| 共享池准入 | 无 | 复用显著性 `score` | 先验 |

**不交给 JEV 的决策**：任何需要生成内容的步骤，任何授予权限的步骤（租约、tool 授权、写 memory 的最终确认），以及需要算术或时间计算的判断。

### 14.3 延迟预算

- 本环境到 `api.typesafe.ai` 的网络往返：热连接 p50 75ms、p90 79ms，首个冷连接 233ms（§16.6）。这只是下限，不含推理时间。
- 按厂商宣称的 70–500ms 计算，每次同步的 JEV 调用会给首 token 增加最多 0.5 秒。pi 的文档也提醒，路由分类会增加首 token 前的延迟。

由此得出三条规则：

1. **用户直接发起的对话不经过 triage**，一定要回应。JEV 只用来选模型档位，而且和 context 组装并行执行。
2. **后台事件**（模块通知、Discord 群聊、弹幕）可以同步 triage，这些场景对 0.5 秒不敏感。
3. **同一批事件合批**。多个问题放进一次请求，延迟基本不变（Respan），所以一个事件的“是否反应、给谁、多紧急”三个问题合成一次调用。

### 14.4 成本

实测数据见 §16.5。结论：按每 1 万次决策计，JEV 约 0.09 美元，现在的 LLM triage 在 1.41–23.61 美元之间，差 15–250 倍。这个差距让“每个事件都做一次判断”从奢侈变成默认选项，也改变了 §5 的前提：调度器可以对每个 workload 都问一次 JEV，而不只在“歧义时”才调用。

### 14.5 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| **注入**：Discord 消息和弹幕会进入 `state`，可能被人利用来抬高显著性、改变路由 | 不可信文本放在独立字段，并在 `instructions` 里标明它只是数据。最终显著性乘以来源信任系数，陌生人来源设上限。JEV 的结果**永远不能单独授予权限** |
| **非英语校准未知**：已知韩语置信度明显下降，中文和日文没有公开数据 | 上线前用 AIRI 的真实事件做中日英三语标注集，测准确率和校准曲线。置信度低于阈值时退回先验 |
| **云依赖与隐私**：事件内容会发送给第三方 | 对 `state` 做脱敏，只发送判断需要的字段。提供 pi 那种本地 classifier 回退 |
| **可用性**：服务故障或限流 | 每个决策都有确定性回退（§14.2 表的最后一列）。JEV 只提升质量，不作为必需依赖 |

### 14.6 还缺的实测

以下三项都需要 API key，本环境没有：

- 在 AIRI 事件上的准确率和校准度。
- 从主要用户地区发起时的真实延迟分布。
- 中文和日文的置信度表现。

---

## 15. 能力矩阵：AIRI、apeira、pi

版本：AIRI 取 `main@07c6353`（core-agent 与 stage-ui）。apeira 取 npm `@apeira/core`、`@apeira/session`、`@apeira/storage` 0.0.8。pi 取 npm `@earendil-works/pi-agent-core` 与 `pi-coding-agent` 0.99.2。三者的判断都来自类型声明、源码和包内文档，没有运行 apeira 和 pi。

图例：✅ 已具备，⚠️ 部分具备或有前提，❌ 没有。

| 能力 | AIRI 现状 | apeira 0.0.8 | pi 0.99.2 |
| --- | --- | --- | --- |
| 定位 | AI VTuber 运行时，Agent 逻辑在 core-agent | stream-first 通用 Agent runtime，与 AIRI 同属 moeru-ai | 终端编码 Agent，底层是通用 agent core 与 harness |
| 成熟度 | 已在生产使用 | ⚠️ 0.0.8，README 写明 “A complete rewrite is being planned” | ✅ 0.99.2，npm 在 2026-09-30 仍有更新 |
| 运行环境 | ✅ 浏览器、Electron、Capacitor | ✅ Node、浏览器、Edge（按文档） | ⚠️ 以 Node 为主。浏览器需要经后端 proxy。SQLite 后端在独立包里 |
| LLM 抽象 | xsAI + provider-inference，支持 Chat 与 Responses | xsAI（`responses()` 等 runner） | 自有的 pi-ai，封装 OpenAI、Anthropic、Google、Mistral、Bedrock 的 SDK |
| 流式事件 | ✅ `StreamEvent` + hooks | ✅ 返回 `ReadableStream<AgentEvent>` | ✅ 从 `agent_start` 到 `agent_end` 的完整事件序列 |
| 并发模型 | ❌ 全局单队列（§16.2 实测） | ✅ 每个 agent 一条队列，多个 agent 天然并行。没有全局并发控制 | ✅ harness 支持多个命名 lane，每个 lane 持有一个 session，operation 有准入判断 |
| 运行中插话（steering） | ❌ 新输入只能排队 | ✅ 活跃 turn 期间 `send()`，内容在下一步边界注入 | ✅ `steer` 和 `followUp` 两种队列，可选逐条或批量 |
| 中断与取消 | ⚠️ 只在会话重置时 abort | ✅ `interrupt`、`abort`，中断后注入一条说明 | ✅ `abort`。operation 终态分为 completed、declined、aborted、failed |
| 步数上限 | ✅ 10 步（`stepCountAtLeast(10)`） | ❌ 核心循环没有上限，只要还有 tool call 就继续 | ✅ `finishTurn` 决策 + tool 结果的 `terminate` 提示 |
| 重试 | ⚠️ tool 或 content 数组不兼容时降级重试一次 | ❌ | ✅ 重试策略（`maxAttempts`、退避） |
| 历史模型 | 线性消息 + `generationTranscript`（含 native continuation） | append-only entry，带 `parentId` | 会话树，entry 分为 message、compaction、branch_summary、custom |
| 分支与 fork | ⚠️ `forkSession` 只复制前缀，不记录血缘 | ✅ git 式的 refs、checkout、fork、rebase、clone | ✅ 分支、`/tree` 导航、fork policy、分支摘要 |
| 持久化 | ✅ IndexedDB + 云同步 | ⚠️ mem、none、json、jsonl、kv（接口与 localStorage 同形） | ✅ JSONL，SQLite（独立包） |
| 崩溃后恢复 | ⚠️ 已输出的部分标记为 `interrupted` | ❌ 没有找到 | ✅ checkpoint + `resume()` |
| 上下文压缩 | ❌ 原语存在但没有启用（§1.3） | ⚠️ 有 `transformEntries` 钩子和 Responses 的 compaction item，没有内置策略 | ✅ 内置压缩，上下文溢出时自动压缩 |
| 子 Agent | ❌ 只能给外部模块发 `spark:command` | ✅ `asTool(agent)`、`fork(agent)` | ⚠️ 核心刻意不内置。示例扩展用独立的 pi 进程运行子 Agent |
| 按请求切换模型 | ⚠️ `resolveStep` 原语已合入，但没有调用方 | ⚠️ xsAI 的 `prepareStep` 钩子 | ✅ virtual model router：每个请求选择物理模型，路由状态存在会话分支上。文档建议 continuation 和 retry 保持同一模型，以保住 prompt cache |
| classifier 与 JEV | ❌ | ❌ | ✅ classifier 是一种模型类型。JEV 可经 5 个 provider 接入，llama.cpp 可在本地模拟 |
| tool 钩子 | ⚠️ 只有 chat 生命周期 hooks | ✅ `preToolCall`、`postToolCall` | ✅ `beforeToolCall`、`afterToolCall`，可以阻断执行或提示终止 |
| MCP | ✅ tamagotchi 主进程的 MCP servers + stage-ui 的 MCP tools | ⚠️ 文档称以插件提供，0.0.8 的 core、session、storage 包里没有找到 | ✅ 独立包 `pi-mcp` + codemode |
| 插件与扩展 | ✅ plugin-sdk extension host（权限、kit） | ✅ `AgentPlugin`（`extendInstructions`、`extendTools`、`transformEntries` 等） | ✅ extensions、skills、prompt templates |
| 长期记忆 | ❌ | ❌ | ❌ |
| 共享工作记忆 | ⚠️ `ContextRegistry`，全局且没有预算（§16.3） | ❌ | ❌ |
| 跨进程协议 | ✅ plugin-protocol + server-runtime | ❌ | ⚠️ RPC 模式；chord（实验性） |
| persona 与形象 | ✅ card（prompt、声音、模型、形象） | ⚠️ state 里只有 `agentName`、`userDescription` | ❌ |
| 调度与准入 | ❌ | ❌ | ⚠️ 单个 lane 内有 operation 准入，没有跨 lane 调度 |
| 许可 | MIT | MIT | MIT |

**从矩阵得出的三点判断：**

1. **执行层的缺口，别人已经解决了**。多 lane、插话、重试、恢复、压缩、按请求路由，这些在 pi 里都有成熟设计，apeira 也覆盖了其中一部分。AIRI 应该借鉴设计，不必自己发明：
   - 借鉴 pi：lane 与 operation 的准入和终态、带状态的 virtual model router、classifier 作为独立的模型类型、continuation 保持同一模型。
   - 借鉴 apeira：git 式的 session refs。
2. **认知层的部分，三方都没有**：调度器、长期记忆、共享工作记忆、persona 的 disclosure 边界。这些是 AIRI 必须自己建的部分，也是这个架构方向的独特价值所在。
3. **不建议替换运行时**：
   - pi-ai 与 xsAI 是两套 provider 栈，而 AIRI 的 provider-inference、计费网关和 native continuation 都建立在 xsAI 上。
   - pi 以 Node 为主，AIRI 需要跑在浏览器和手机上。
   - apeira 与 AIRI 同源同栈，最容易合流，但它正在重写。

   建议把“core-agent 的执行循环是否与 apeira 的新版合流”列为一个待定决策（§12），而不是现在就依赖它。

---

## 16. 实测数据

### 16.1 方法

- **环境**：云端容器，Node 22.22.2，Vitest 4.1.11。
- **被测代码**：真实的 `createChatOrchestratorRuntime`、`createContextRegistry`、`createSparkNotifyAgent`。LLM 端口是假的，只负责计时。
- **token 计数**：js-tiktoken `o200k_base`。这是近似值，各模型的实际 tokenizer 不同。
- **时间缩放**：B1 里 1 个模拟秒等于 20ms 真实时间。计时抖动约为 ±0.5 模拟秒。
- **复现**：harness 源码和原始数据见附录 A。

### 16.2 B1：队头阻塞与调度策略

**负载**：180 个模拟秒，种子 42。

| 来源 | 请求数 | 单次时长 | 平均间隔 |
| --- | --- | --- | --- |
| 游戏规划 | 11 | 8–16 秒 | 约 17 秒一次 |
| 两个 Discord 群 | 48 | 2–4 秒 | 约 4 秒一次 |
| 主人私聊 | 15 | 1.5–3 秒 | 约 12 秒一次 |

总负载为 **1.7 Erlang**，也就是平均同时需要 1.7 个模型槽。

表中数值为等待开始的时间，单位是模拟秒：

| 配置 | 主人 p50 | 主人 p95 | Discord p95 | 游戏 p95 | 被合并的请求 |
| --- | --- | --- | --- | --- | --- |
| 现状：全局单队列 | 67.5 | **113.2** | 114.0 | 108.8 | 0 |
| 每 context 一条 lane，不限并发 | 0.0 | 0.0 | 1.3 | 0.0 | 0 |
| lane + 2 槽，FIFO | 0.3 | **1.7** | 4.2 | 0.0 | 0 |
| lane + 2 槽，优先级 | 0.3 | 1.7 | 4.2 | 0.0 | 0 |
| lane + 1 槽，FIFO | 67.4 | 91.0 | 157.0 | 27.5 | 0 |
| lane + 1 槽，优先级 | 1.2 | 7.9 | 92.3 | **134.2** | 0 |
| lane + 1 槽，优先级 + 同群合并 | 4.3 | 9.5 | 15.5 | 51.3 | 26/48 |

换种子复测，趋势稳定：

| 种子 | 全局队列：主人 p95 | 2 槽 + 优先级：主人 p95 | 1 槽 + 优先级 + 合并：主人 p95 | 同一配置：游戏 p95 |
| --- | --- | --- | --- | --- |
| 1 | 117.8 | 2.0 | 10.9 | 83.8 |
| 2 | 119.0 | 2.5 | 9.9 | 80.9 |
| 3 | 109.9 | 2.0 | 11.1 | 67.2 |

**解读：**

1. **现状的问题是结构性的**。只要有持续的后台负载，主人私聊就要排将近 2 分钟的队。这里的瓶颈不是算力，而是全局单队列（B1）。
2. **容量够的时候，优先级没有作用**。2 槽时 FIFO 和优先级的结果几乎一样。所以调度器的复杂度只在资源紧张时才有回报，不要在 P2 之前先做复杂的优先级。
3. **容量不够的时候，优先级只是把饥饿转给别人**。1 槽加优先级后，主人等待降到 7.9 秒，但游戏等待涨到 134 秒。真正让系统恢复稳定的是**合并**：同一个群的排队请求合成一个，26 个请求被吸收，三方的等待都回到可接受范围。这是一条有数据支撑的设计结论：**合并与丢弃要作为调度器的一等能力**，排在优先级之前。
4. **推论**：只用一个本地模型，撑不住“同时直播、玩游戏、在 Discord 聊天”这样的负载。产品层面要在“混合云端模型池”和“限制同时开启的场景”之间做选择（§12）。

### 16.3 B2：共享上下文的膨胀

**模拟**：1 小时，使用现有 registry 与协议的默认行为。

- Minecraft 状态每 5 秒发一次，replace-self。
- Minecraft Brain 的 `updateAiriContext` 每 30 秒发一次，AiriBridge 默认 append-self。
- 两个 Discord 群每 4 秒来一条消息，每条附带一次 append-self 的通知。

| 分钟 | 条目数 | `[Context]` 块的 token 数 |
| --- | --- | --- |
| 0 | 3 | 202 |
| 10 | 173 | 4,472 |
| 30 | 513 | 13,012 |
| 60 | 1,023 | **25,822** |

增长是线性的，约每分钟 430 token。这些 token 会**附在每一次聊天请求上**。原因有两个：registry 的 `historyLimit` 只限制历史记录，不限制活跃桶；而 append-self 的条目永远不会过期。一小时后，主人说一句“你好”，也要先付出约 2.6 万 token 的上下文成本。§7.1 提出的预算、TTL 和按读者投影，是**必须修的缺陷，不是优化**。

### 16.4 B3：恢复长 context 的代价

| session 消息数 | 组装耗时 p50 | 组装耗时 p95 | prompt token 数 |
| --- | --- | --- | --- |
| 50 | 0.21 ms | 0.28 ms | 2,240 |
| 500 | 0.90 ms | 1.35 ms | 19,541 |
| 2,000 | 2.03 ms | 4.20 ms | 77,036 |
| 5,000 | 7.80 ms | 9.52 ms | 192,152 |

**解读：**

- 恢复旧 context 的 **CPU 成本可以忽略**，5000 条消息也不到 10ms。“恢复旧 Agent 很慢”这个担心是伪问题。
- **token 成本才是真问题**。2000 条消息就有 7.7 万 token，5000 条已经超过大多数模型的上下文窗口。
- 因此 dormant 阶段生成 digest（§6.1）、resume 时先压缩成 `history-block`，是恢复能力的**前提**。

本测试不含 IndexedDB 的读取时间，也不含云端拉取时间。

### 16.5 B4：triage 的 token 与成本

**现在的 LLM triage（spark-notify）**，每次调用的输入：

| 组成 | token 数 |
| --- | --- |
| 默认 persona 与 runtime prompt（`base.yaml` 的 prompt 段，近似） | 743 |
| triage 脚手架 | 161 |
| tool schema | 707 |
| **合计** | **约 1,611** |

输出按一次 tool call 约 150 token 估算（这是假设值）。

**JEV 请求**：一个真实形状的请求，包含一个事件、三条状态和三个问题（是否反应、路由、紧急度），约 222 token（o200k 近似）。

**每 1 万次 triage 的成本**。价格取自仓库依赖的 model-bank，JEV 的价格见 §14.1：

| 方案 | 美元 |
| --- | --- |
| gpt-5-nano | 1.41 |
| gemini-2.5-flash-lite | 2.21 |
| gpt-5-mini | 7.03 |
| claude-haiku-4-5 | 23.61 |
| **JEV** | **0.09** |

一个忙碌的直播或 Discord 场景，每天轻松产生上万个事件。按这个量级，JEV 让“每个事件都判断一次”变得可以负担。

### 16.6 JEV 网络基线

从本容器（出站经过代理）向 `POST /v1/systemone` 发送 25 次不带 key 的请求。只测网络和鉴权层，不含推理：

| 指标 | 数值 |
| --- | --- |
| 首次（冷连接） | 233ms |
| 热连接 p50 | 75ms |
| 热连接 p90 | 79ms |
| 最小值 | 72ms |
| 最大值 | 171ms |

### 16.7 没有测的部分

- JEV 的推理延迟和准确率（需要 API key）。
- 真实 LLM 的首 token 延迟。
- 浏览器里同时开多个 lane 时的内存占用。
- IndexedDB 读取大 session 的时间。
- 多窗口 leader 切换时正在执行的 run 会怎样。

---

## 17. 风险登记

| ID | 风险 | 严重度 | 证据 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | 算力不足时，调度只是转移饥饿 | 高 | §16.2：1 槽加优先级后，游戏 p95 等待 134 秒 | 合并与丢弃作为一等能力；混合云端模型池；限制同时开启的场景数 |
| R2 | 共享上下文膨胀 | 高（已发生） | §16.3：每小时 2.6 万 token；§3 的 B2 | 预算、TTL、按读者投影；append-self 只允许白名单槽位 |
| R3 | 长 context 恢复的 token 成本 | 高 | §16.4：2000 条消息 7.7 万 token | dormant 阶段生成 digest；resume 前压缩；启用 `history-block` |
| R4 | JEV 被不可信文本注入 | 高 | 公开测试中注入后以 82% 和 73% 的置信度给出错误答案 | 来源信任系数与上限；JEV 永不单独授予权限 |
| R5 | 低信任来源的说法被写进主 memory | 高 | §13.2：Discord 陌生人的发言以 user 身份进入会话 | provenance 与信任门槛；写入需要调度器批准 |
| R6 | JEV 在中文和日文上的校准未知 | 中 | 韩语置信度下降 40–70%，中日文没有数据 | 三语标注集实测；置信度不足时退回先验 |
| R7 | 云依赖与隐私 | 中 | JEV 只有云端服务 | 脱敏；本地 classifier 回退（参考 pi 的 llama.cpp 方案） |
| R8 | 调度器变成新的单体 | 中 | §13.1：领域知识已经漏进 chat store | manifest 的 `cognition` 块；“新增模块时调度器零改动”的适应度规则 |
| R9 | renderer 宿主的生命周期 | 中 | leader 随窗口存亡 | 在 §12 决定宿主位置 |
| R10 | 多 lane 下语音和舞台形象冲突 | 中 | 只有一个 speech 通道，舞台上通常只显示一个模型 | 形象租约（§13.8） |
| R11 | 并行 run 增多后难以调试 | 中 | `runId` 没有贯通（B11） | 贯通 `runId`、`parentRunId`；接入 `contextObservability` |
| R12 | 依赖外部运行时的成熟度 | 中 | apeira 宣布将重写 | 只借鉴设计，不引入依赖 |
| R13 | 路由切换模型导致 prompt cache 失效 | 低 | pi 的文档明确提醒 | continuation 和 retry 保持同一模型；只在 turn 边界切换 |
| R14 | 在项目最早期过度工程化 | 中 | §16.2 解读第 2 点：容量充足时优先级没有收益 | 先做 P0–P2；DAG 和 persona 并存往后放 |

---

## 附录 A：测试与数据

**v0.1 的行为验证**（B1、B2 的存在性证明）：两个临时测试放在 `packages/core-agent/src/runtime/` 下，跑完即删，没有进入提交。结果是 2 个测试全部通过。

- 测试 1：game 会话的请求没有结束时，chat 会话的请求根本没有开始。
- 测试 2：两个 Discord 群的 append-self 通知，都出现在主人私聊的 prompt 里。

**v0.3 的量化实测**（§16）：

- harness 源码：[`2026-09-30-cognitive-scheduler-bench.md`](./2026-09-30-cognitive-scheduler-bench.md)
- 原始数据：[`data/2026-09-30-cognitive-scheduler-bench.json`](./data/2026-09-30-cognitive-scheduler-bench.json)

**复现步骤**：

1. 执行 `pnpm install --filter "@proj-airi/core-agent..."`。
2. build `stream-kit`、`server-shared`、`provider-inference`。
3. 在仓库外安装 `js-tiktoken`。
4. 按 harness 文件开头的说明，把它放进 core-agent 运行。

## 附录 B：本文未覆盖或未验证的部分

- B5 没有在真实 Discord 环境里复现。
- stage-pocket（Capacitor）的后台生命周期限制没有调研。它会影响“调度器宿主”这个决策。
- `services/computer-use-mcp` 和 `airi-plugin-claude-code` 只看了入口，没有评估它们能否作为“子 Agent”接入 run 契约。
- 服务端 `chat-ws` 的实时路由没有深入。如果调度器上云，需要补这部分。
- JEV 的推理延迟、准确率和多语言校准没有实测（没有 API key，见 §14.6）。
- apeira 和 pi 只读了 npm 包的类型、源码和文档，没有运行。

## 附录 C：外部来源

- TypeSafe Jev：[Respan](https://www.respan.ai/articles/what-is-the-jev-ai-model)、[Datacamp](https://www.datacamp.com/blog/system-one-models-jev)、[daleseo.com](https://daleseo.com/jev/)、[Portkey 文档](https://portkey.ai/docs/integrations/llms/typesafe)、[TanStack AI 适配器](https://tanstack.com/ai/latest/docs/adapters/typesafe)、[DataLearner](https://www.datalearner.com/en/ai-models/pretrained-models/jev)
- apeira：[moeru-ai/apeira](https://github.com/moeru-ai/apeira)、[文档站](https://apeira.moeru.ai/)，npm `@apeira/core`、`@apeira/session`、`@apeira/storage` 0.0.8
- pi：[badlogic/pi-mono](https://github.com/badlogic/pi-mono)，npm `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` 0.99.2（包内的 `docs/models.md`、`docs/virtual-models.md`、`docs/llama-cpp.md`、`examples/extensions/jev-router.ts`）
- 模型价格：仓库依赖 `model-bank@1.0.20260904203849`
