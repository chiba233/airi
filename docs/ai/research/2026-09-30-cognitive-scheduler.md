# AIRI 动态认知调度架构白皮书

基线：`main` @ `07c6353`（2026-09-30）
范围：`packages/core-agent`、`packages/stage-ui`、`packages/plugin-protocol`、`packages/server-runtime`、`packages/provider-inference`、`integrations/*`、`plugins/*`、`server/apps/api`，以及外部的 TypeSafe JEV、moeru-ai/apeira、pi
配套验证报告：[`2026-09-30-cognitive-scheduler-validation.md`](./2026-09-30-cognitive-scheduler-validation.md)

本文用 `path:line` 引用代码。“已验证”表示跑过测试（见附录 A 和验证报告），“静态推断”表示只读了代码。

---

## 术语

每个概念只用一个名字。代码标识符保持原样。

| 名字 | 含义 | 不再使用的说法 | 对应代码 |
| --- | --- | --- | --- |
| 调度器 | 唯一的主 Agent。它只调度，从不对用户说话 | 主 Agent、Scheduler | 新建 |
| 对话 Agent | 唯一的发声者。同一时刻只有一个 | conversation 实例 | 现有 chat orchestrator |
| 领域 Agent | 在自己的通道里行动的 Agent，例如 MC、Discord、直播。不发声 | 子 Agent、模块 Agent | spark-notify、Minecraft `Brain` 等 |
| 心情 Agent | 唯一。用 JEV 打分，用代码算出心情 | — | 新建 |
| 会话 | 一个 Agent 可以恢复的上下文。不运行时也存在 | lineage、认知线、AgentContext、context | `ChatSession` |
| 运行 | 一次执行。结束就消失，会话保留 | run、execution | `AgentRun`、`runId` |
| 配方 | 一类任务的处理方式：prompt 片段、工具、默认档位 | recipe、程序 | 新建 |
| 任务 | 调度器要处理的一件事 | workload | `Workload` |
| 紧急度 | 任务的 0–1 分值。由来源给的先验和 JEV 合成 | salience、显著性 | `salience` 字段 |
| 绑定 | 会话和外部场景的固定对应，例如 `discord:channel:123` | binding | `bindings` |
| 摘要 | 会话的短文本概要，用于检索和冷启动 | digest | `digest` |
| 共享池 | 所有 Agent 共享的一小块“此刻”信息 | tiny shared context、Working Memory、M3 | 改造后的 `ContextRegistry` |
| 槽 | 共享池里的一个条目。新值覆盖旧值 | slot、槽位 | `contextId` + `replace-self` |
| 长期记忆 | 跨会话的长期事实和偏好 | 主 memory、M1 | 新建 |
| 控制权 | 调度器授予某个会话对某个模块的独占指挥权，有过期时间 | 租约、lease | `lease` |
| 初筛 | 判断一个事件要不要处理、交给谁 | triage | — |
| 插话 | 高紧急度状态让对话 Agent 在句子边界停下来，转说新内容 | steering | — |
| 档位 | 模型的质量等级：fast、default、strong | tier | — |
| 人格 | 角色卡定义的身份、口吻、形象和声音 | persona | `AiriCard` |

---

## 摘要

**结论：可行。必须新建四样东西：调度器、对话 Agent 的输入输出链路、心情 Agent、长期记忆。**

| 方面 | 判断 | 依据 |
| --- | --- | --- |
| 执行模型 | 调度器只调度。各个 Agent 直接、并发地面对用户，只是输出通道不同 | §1 |
| 发声 | 同一时刻只有一个对话 Agent，它是唯一的发声者 | 实测：多个 Agent 共用语音时，结果只有排队或互相截断（§10.1）。AIRI 的语音管线本来就是单出口 |
| 心情 | 同一时刻只有一个心情 Agent：一次 JEV 调用加一段代码 | 表情接口已经支持连续强度，渲染层不用改（§11） |
| 执行层 | 原语大多已有，但有阻塞点 | 会话可以直接当可恢复的上下文。全局单队列让所有 Agent 串行：主人私聊 p95 要等 113 秒，改成每个会话一条队列后接近 0（§17.2） |
| 模型选择 | 从全部模型自动选可行，**只缺质量信号** | model-bank 里 2,104 个模型带齐价格、上下文和能力（§13.1） |
| 钱包 | 并发的唯一约束 | 5 个 Agent 同时在线：全部用一个强模型每小时 9.02 美元，自动选型加 prompt cache 后 0.27–1.34 美元（§13.3） |
| 共享池 | 必须先治理 | 现状每小时膨胀到 25,822 token。加上预算、过期时间和按读者过滤后，单个读者不到 100 token（§17.3，验证报告 §4） |
| 生态 | 借鉴设计，不替换运行时 | pi 的执行层最完整。apeira 同源，但正在重写。两者都没有调度器、长期记忆、心情和人格（§18） |

**最高的风险**（完整清单见 §19）：

1. 对话 Agent 的历史记的是完整生成文本，用户只听到了打断前的部分。
2. 花费随 Agent 数量线性增长，现在没有预算闸门。
3. 共享池膨胀。
4. JEV 被不可信文本注入。
5. 低信任来源的说法被写进长期记忆。

**起步顺序**：

1. P0–P2（§20）：共享池隔离、会话持久化、每个会话一条队列。
2. 对话 Agent 链路：状态槽、播放截断点回写、按需口语化（§10）。然后做心情 Agent（§11）。
3. 自动选型：用户给模型标档位，JEV 判断任务难度，每小时预算闸门（§13）。

---

## 1. 架构总览

### 1.1 两个前提

**一、模型走云端，并发只受钱包限制。**
云端模型本身可以并发。同时开多个 Agent，只受花费限制，不受吞吐限制。模型选择也不绑定到某个 Agent：**每个可以自动做的决策，都从当前全部可用模型里选**。本地推理不在本文范围内。

**二、Agent 直接面对用户，调度器只调度。**
多 Agent 的目的，是让各个 Agent 并发地直接对用户输出，区别只在输出通道。边玩 MC 边聊天，就是两个 Agent 同时输出：一个在游戏里行动，一个在说话。调度器**从不开口，也不转述**，它不站在 Agent 和用户之间。

### 1.2 角色

```
                    ┌─ 语音 · 形象 · 主人聊天窗 ◀── 对话 Agent（唯一发声者，同一时刻只有一个，可以在不同会话切换人格）
用户 ◀─ 输出 ──────┤                                    ▲ 领域 Agent 的状态（共享池里的槽）
                    │                                    │
                    └─ 游戏内动作 · Discord 文字 · …  ◀── 领域 Agent（MC、Discord、直播…，并发，不发声）
                                                           ▲
                                   形象表情 · 语调 ◀── 心情 Agent（唯一，JEV 打分 → PAD → 代码映射）
                                                           │
                         调度器：启动、恢复、选模型、定预算、传递状态（不在输出路径上）
```

| 角色 | 做什么 | 不做什么 |
| --- | --- | --- |
| 调度器 | 决定需要哪些 Agent，恢复还是新建，给每个决策选模型，分配预算，监督运行，把领域 Agent 的状态写进共享池 | 不对用户说话，不转述 Agent 的输出 |
| 对话 Agent | 唯一的发声者。拥有语音、形象和主人聊天窗。可以在不同时候、不同会话以不同人格出现 | 不会同时存在两个。不直接操作游戏等领域 |
| 领域 Agent | 在自己的通道里并发地直接面对用户：MC Agent 在游戏里行动，Discord Agent 在频道里回文字 | 不发声。要让用户“听到”的事，以状态的形式交给对话 Agent |
| 心情 Agent | 唯一。用 JEV 给当前局面打分，代码把分数算成三维心情并平滑，驱动表情和语调 | 不生成文本 |
| 钱包 | 唯一的稀缺资源。调度器按每小时预算决定开几个 Agent、各用哪一档模型 | — |

### 1.3 三个核心问题

1. 对话 Agent 怎么及时、连贯地说出领域 Agent 的事？（§10）
2. 心情 Agent 怎么用 JEV 和代码实现？（§11）
3. 从全部模型自动选型、按钱包分配，现有数据够不够？（§13）能力、价格、上下文都够，只缺质量信号。

---

## 2. 代码现状

### 2.1 设想与代码事实

调研输入里有几条设想和仓库现状不一致。后面的设计以代码为准。

| 设想 | 代码事实 | 影响 |
| --- | --- | --- |
| JEV 可以直接用于调度 | JEV 是 TypeSafe 在 2026-09-15 发布的 System 1 决策模型。它不生成文本，只对给定的 `state` 回答 `choice`、`score`、`noul` 三类问题，并返回概率（§15）。仓库还没有接入它 | JEV 正好补上调度器的快判断：紧急度、路由、恢复还是新建、记不记忆、模型档位 |
| 已经有直播模块 | `plugins/airi-plugin-bilibili-laplace/src/index.ts` 只有一行 `console.warn('WIP')`。`danmaku` 只是 tamagotchi 浮动聊天窗的显示样式（#2704）。没有弹幕接入、直播状态或推流控制 | 直播要从零设计。它可以直接用 `spark:notify` 和 `context:update`，不需要新的传输层 |
| 长期记忆可以复用 | stage 侧**没有任何长期记忆**。`packages/memory-pgvector/src/index.ts` 是空的 server-sdk 客户端。`server/apps/api/src/schemas/characters.ts:117` 的 `initialMemories` 还是 TODO。唯一的向量记忆在 `integrations/telegram-bot`，和 AIRI 主体完全隔离 | 长期记忆是**最大的空白**。好处是没有历史包袱，可以直接按人格安全要求设计 |
| 现在是一个“大 Agent” | 实际有 **6 个独立的 Agent 循环**：stage chat orchestrator、spark-notify agent、Minecraft `Brain`、satori-bot、telegram-bot、artistry “Director”。它们各自实现队列、预算、中断和历史 | 问题是“小 Agent 各管各的”。调度器的首要价值是给它们统一的生命周期和路由约定 |

作者已经在往“Agent 是调度的结果”这个方向写。`createSparkNotifyAgent` 的注释原文是 “The host resolves model selection and schedules work. This agent only prepares and runs one notify turn.”（`packages/core-agent/src/agents/spark-notify/agent.ts:177-178`）。Agent 是纯函数，host 负责调度，这个理念已经在代码里，只是 host 一侧还很弱。

### 2.2 进程与所有权

```
┌──────────────────────── 外部模块进程 ────────────────────────┐
│ minecraft Brain │ discord-bot │ satori/telegram │ web-ext │ HA │
└────────┬───────────────┬─────────────────────────────────────┘
         │ plugin-protocol over WS (spark:* / context:update / input:*)
┌────────▼─────────────────────────────────────────────────────┐
│ server-runtime（tamagotchi 内嵌或独立）                          │
│  peer 注册 · 心跳 · destinations 路由 · consumer-group 投递       │
└────────┬─────────────────────────────────────────────────────┘
         │ 每个 renderer 窗口 / 浏览器 tab 各连一条
┌────────▼──────────────── stage renderer ─────────────────────┐
│ context-bridge（每个窗口都跑，input:text 用 Web Lock 去重）       │
│ character-orchestrator = spark-notify agent（每个非 widget 窗口 │
│                          各跑一个 2s ticker）                    │
│ chat store（pinia-plugin-synced，actions 交给选出的 leader）     │
│   └─ createChatOrchestratorRuntime（core-agent，与 Vue 无关）    │
│        ├─ session port → chat-session store → IndexedDB / 云同步 │
│        ├─ context port → chat-context store → ContextRegistry   │
│        └─ llm port → useLLM → streamFrom → provider-inference   │
│ consciousness store（全局唯一 provider/model）                   │
│ airi-card store（全局唯一 activeCard = 人格）                    │
│ speech-runtime（intent 优先级：queue/interrupt/replace）          │
└──────────────────────────────────────────────────────────────┘
```

stage 侧同时有三种所有权模型：

1. **synced leader**：chat 的 `send/retry/cleanup` 等（`packages/stage-ui/src/stores/chat.ts:742-746`）。
2. **每个窗口各跑一份**：spark-notify ticker（`apps/stage-web/src/App.vue:137`，`apps/stage-tamagotchi/src/renderer/App.vue:298-299`）。
3. **Web Locks 抢占**：`input:text` 入口（`packages/stage-ui/src/stores/mods/api/context-bridge.ts:733-756`）。那里的 TODO 也写了需要 leader election 或分布式锁。

调度器只能有一个 owner，所以这是第一个要统一的地方（§4 B6）。

### 2.3 一次聊天请求的路径

1. 入口：UI 调用 `chatStore.send`，或者外部 `input:text` 经 context-bridge 进来。两条路都带 `overrides.sessionId`。
2. `executeSend`（`packages/stage-ui/src/stores/chat.ts:553-595`）读**全局** `consciousness.activeProvider/activeModel`，再 `loadSession`。
3. `runtime.ingest` 进入**全局唯一**的 FIFO 队列（`packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:1046`）。
4. `performSend` 依次执行：
   - `ingestRuntimeContexts()`：情绪 runtime prompt 和 Minecraft 状态在**每次发送前**写进全局 registry。
   - `buildContext(history)`：把会话历史转成 `Conversation.turns`。带 `generationTranscript` 的消息原样回放 native continuation。user 消息前面加 `[HH:MM]` 和 `[Replying to: …]`。
   - 把 `getSystemPromptSupplement()`（toolset prompts）拼到 system turn 末尾。
   - 把 registry 快照作为 `runtime-context` 段挂到**最后一条 user turn**，渲染成 `[Context]\n- source: text`（`packages/core-agent/src/messages/context-prompt.ts:37`）。
   - `llm.stream` → `streamWithStageAdapters`（视觉转述、tool 图片）→ `useLLM.stream`（按 modelKey 记住兼容性，失败时降级）→ `streamFrom`。
   - 流事件经 marker parser 和 categorizer 分成 speech 和 reasoning。foreground stream 只更新当前可见的会话。
   - 结束时追加 assistant 消息（带 `generationTranscript`），然后触发 hooks、analytics 和云同步。

### 2.4 Prompt 的组成

| 层 | 来源 | 位置 |
| --- | --- | --- |
| 身份 | `card.systemPrompt + description + personality + scenario + widgetInstruction` | `packages/stage-ui/src/stores/modules/airi-card.ts:28-42` |
| 格式规则 | codeblock、math 规则，创建会话时**写进第一条 system 消息** | `packages/stage-ui/src/stores/chat/session-store.ts:196-209` |
| 工具说明 | 各扩展注册的 toolset prompt，拼到 system 末尾 | `packages/stage-ui/src/stores/ai/chat-llm/toolset-prompts.ts` |
| 运行时上下文 | registry 快照（情绪、Minecraft、账户、所有 `context:update`） | `chat-orchestrator-runtime.ts:765-774` |
| 时间与引用 | `[HH:MM]`、`[Replying to]` 前缀 | `chat-orchestrator-runtime.ts:500-514` |
| 历史 | 会话的全部消息，**没有裁剪或压缩** | 同上 |

core-agent 的 `messages/types.ts` 已经定义了一套结构化 prompt 语言：`SystemTurn.authority: 'system' | 'developer' | 'context'`，以及 `ContextSegment` 下的 `instruction(priority)`、`domain-event`、`state-snapshot`、`history-block`、`summary(fromTurnIndex/toTurnIndex)`、`reference(refType, targetId)`。但是：

- 生产代码只用到 `runtime-context`。
- `compactConversationEntries` 和 `projection.ts` **没有从包入口导出**，stage-ui 也从没调用。

这些是已经设计好、但还没启用的零件，正好是 prompt 配方需要的东西（§5.5）。

### 2.5 协议层

plugin-protocol 是仓库里最接近“认知总线”的部分，设计相当完整：

| 原语 | 字段 | 可以承担的角色 |
| --- | --- | --- |
| `spark:notify` `events.ts:1087` | `kind: alarm/ping/reminder`、`urgency: immediate/soon/later`、`ttlMs`、`requiresAck`、`lane`、`destinations` | 任务入口 |
| `spark:command` `events.ts:1139` | `interrupt: force/soft/false`、`priority: critical..low`、`intent: plan/proposal/action/pause/resume/reroute/context`、`guidance.persona`、`contexts[]`、`parentEventId` | 调度器给 Agent 或模块的下行指令，自带抢占语义 |
| `spark:emit` `events.ts:1102` | `state: queued/working/done/dropped/blocked/expired` | **现成的运行状态词汇** |
| `context:update` `events.ts:563` | `contextId`、`lane`、`strategy: replace-self/append-self`、`destinations`、`ideas/hints`、`content` | 共享池的写入原语 |
| `DeliveryConfig` `events.ts:463-473` | `broadcast/consumer/consumer-group` × `first/round-robin/priority/sticky` + `stickyKey` | 控制权的底层机制 |
| `RouteTargetExpression` `events.ts:497` | and/or/glob/ids/plugin/instance/label/module/source | 按相关性定向投递 |
| `ModuleCapability` `events.ts:388` | `id`（注释里的例子就是 `"memory.write"`）、`configSchema`、`metadata` | 调度器可以读的能力清单 |
| `ModuleConfigEnvelope.baseRevision` `events.ts:383` | 乐观并发 | 共享池并发写的现成模式 |

server-runtime 实现了 peer 心跳（`registry:modules:health:*`）、consumer 注册（带 priority）、按 destinations 过滤广播（`packages/server-runtime/src/index.ts:343-383, 881-960`）。

### 2.6 各业务域

| 域 | 持久状态在哪 | 与 AIRI 主体的关系 |
| --- | --- | --- |
| Minecraft | bot 进程里的 `Brain`：`conversationHistory`（内存，上限 200 条）、`llmLog`、action queue、reflex、perception | 上行 `spark:notify`、`context:update`、`spark:emit`，下行 `spark:command`。stage 只收一条 `latestRuntimeContextText`，每次发送前注入 |
| Discord | bot 进程几乎无状态。stage 侧按 `discord-guild-{id}` 或 `discord-dm-{id}` 设 sessionId。`summon.ts` 用 `joinVoiceChannel` + `createAudioPlayer` 自建了一条语音链路 | 走 `input:text` + `overrides.sessionId`，输出靠监听 `output:gen-ai:chat:message` |
| 直播 | 不存在 | — |
| satori / telegram | 自己的 DB（telegram 有 pgvector）和自己的 LLM 循环 | 与主体没有连接 |
| Vision | `vision:{workload}:{source}` 作为 replace-self 的上下文 | 经 context registry 进入 prompt |
| Notebook | `useCharacterNotebookStore`，**只在内存，不持久化** | spark-notify ticker 扫描到期提醒 |

---

## 3. 可以复用的部分

按“直接升级、不用新造”的程度排序。

### 3.1 Chat session 就是可恢复的会话 ★★★

- 分区键已经是 `userId → characterId → sessionId`（`packages/stage-ui/src/types/chat-session.ts:3-39`）。**人格已经是会话的一级分区**。
- 每条 assistant 消息保存 `generationTranscript`：完整的 `AssistantTurn`，包括每轮的 model、finishReason、usage、tool 调用和 native continuation（`packages/core-agent/src/messages/types.ts:48-83`）。恢复时原样回放，**不丢 tool 轨迹**。
- continuation 带 scope（provider、endpoint、model、conversation）。跨模型恢复时自动降级为可移植内容，并记录 `projectionIssues`，不会悄悄丢内容（`packages/core-agent/src/runtime/request-context.ts:44-49`）。所以“恢复旧会话并换模型”是安全的。
- 已经有 IndexedDB 持久化、云同步、墓碑、outbox、`sessionGenerations`（代际号，用来拒绝过期结果）。
- `forkSession` 已经存在（`session-store.ts:1481`）。

### 3.2 core-agent 的端口化运行时 ★★★

`createChatOrchestratorRuntime` 已经和 Vue、Pinia 解耦，session、context、LLM、stream 全部以端口注入（`chat-orchestrator-runtime.ts:247-400`）。它就是一个 Agent 执行器。要支持多实例，改的是队列和 foreground 的假设，不是整体结构。

`streamFrom` 的 `resolveStep`（`packages/core-agent/src/types/llm.ts:31-41`）在**每个模型步骤之前**都可以重新决定 model、provider、systemPrompt、tools 和温度。scope 变了就抛 `RequestSwitch`，已完成的轮次保留（`request-switch.ts`）。这就是**逐步切换模型**的执行原语。代码已合入（#2709），stage-ui 还没有调用方（见 `chat.ts:278-281` 的 NOTICE）。

### 3.3 spark-notify 和 character-orchestrator：调度器的种子 ★★★

- `processSparkNotify` 已经在做“选 model → 组 prompt → 跑一次 Agent → 把结果变成 `spark:command` 下发”（`packages/stage-ui/src/stores/character/orchestrator/store.ts:119-160`）。
- 已经有 urgency 到延迟的映射、重试、`maxAttempts`、2 秒 tick、notebook 到期提醒注入（`store.ts:73-94, 183-252`）。
- LLM 可以调 `builtIn_sparkNoResponse` 表示“不值得反应”。这就是**现成的初筛开关**。
- 插件机制（`SparkNotifyPlugin.prepare → systemInstructions/userSections/tools/getResult`）就是一个小型的 prompt 配方管线。

### 3.4 Minecraft `Brain`：监督机制的参考实现 ★★★

`integrations/minecraft/src/cognitive/conscious/brain.ts` 已经实现了一整套**不依赖 LLM 的监督手段**：

| 机制 | 常量或位置 |
| --- | --- |
| 事件优先级分层、合并、按优先级稳定排序 | `EVENT_PRIORITY_*`，`coalesceQueue` `:1585` |
| 防饿死（高优先级连续 8 轮后强制放行低优先级） | `MAX_CONSECUTIVE_HIGH_PRIORITY_TURNS` `:1683` |
| 无动作预算与停滞检测 | `NO_ACTION_FOLLOWUP_BUDGET_DEFAULT=3`，`NO_ACTION_STAGNATION_REPEAT_LIMIT=2` |
| 错误爆发熔断（5 轮内 3 次错误） | `ERROR_BURST_THRESHOLD`、`ERROR_BURST_WINDOW_TURNS` |
| 单次 LLM 超时 60 秒 + AbortController | `DEFAULT_LLM_ATTEMPT_TIMEOUT_MS` `:544` |
| action 队列状态机与取消令牌 | `:140, :1223-1400` |
| 结构化调度日志（`llmLog`，带 tags） | 全文 |
| 队列上限与溢出丢弃 | `MAX_EVENT_QUEUE_LENGTH=256` |

它的注释写着 “FIXME: Replace with weighted-fair scheduling once queue model is refactored”。它等的就是调度器。

### 3.5 ContextRegistry：共享池的骨架 ★★

`createContextRegistry`（`packages/core-agent/src/runtime/context-registry.ts`）已经有：

- 按 `sourceKey` 分桶。
- `replace-self`（槽语义）和 `append-self`（日志语义）。
- 有上限的写入历史（400 条）和快照克隆。

它缺的正好是共享池的全部约束：容量预算、过期时间、按 `destinations` 或 `lane` 过滤、按读者过滤、优先级。协议里的 `ContextUpdate` 已经带了 `destinations` 和 `lane`，但 registry 和 context-bridge **都没有用它们过滤**（§4 B2）。

### 3.6 分散的优先级词汇 ★

| 位置 | 词汇 |
| --- | --- |
| `spark:notify` | urgency: immediate/soon/later |
| `spark:command` | priority: critical/high/normal/low；interrupt: force/soft |
| `pipelines-audio` | `PriorityLevel` + `IntentBehavior: queue/interrupt/replace` |
| Minecraft Brain | 4 级事件 tier |
| artistry Director | LLM 输出 `intensity: 0-100` + `autonomousThreshold` |
| `SegmentInstruction` | priority: low..critical |

接入 JEV 以后，这些词汇变成来源给的先验。最终紧急度由 JEV 的 `score` 问题给出，再与先验合成（§9.2）。

### 3.7 其他零件

- **模型元数据**：`ModelInfo.metadata`（model-bank 的 `abilities/maxOutput/pricing`）、`contextLength`（`packages/provider-inference/src/types.ts:226-237`）。运行时学到的 `toolsCompatibility` 和 `contentArrayCompatibility`（`packages/stage-ui/src/stores/ai/chat-llm/llm.ts`）。遥测里的 `onLlmFirstToken.ttfbMs` 和 usage。这些拼起来就是模型档案。
- **服务端 llm-router**：alias → 有序候选组 + 失败触发 + key 轮换（`server/apps/api/src/services/domain/llm-router`）。它负责**可用性**，不负责能力选择。这条边界保留。
- **Vision 任务表**：`VisionWorkloadId → prompt`（`packages/stage-ui/src/composables/vision/use-vision-workloads.ts`）。这是“按任务类型选 prompt”的最小先例。
- **tool 激活元数据**：`RegisteredPluginToolDescriptor.activation: { keywords, patterns }`（`packages/plugin-sdk-tamagotchi/src/tools/registry.ts`）。`requiresExplicitSelection` 是能力授权边界。
- **服务端 chats schema**：`chatMembers.memberType: 'user' | 'character' | 'bot'`，`ChatType` 含 `group/channel`（`server/apps/api/src/schemas/chats.ts:41-42`）。多个人格出现在同一段历史里的数据模型，云端已经有了。
- **语音管线**：同一时刻一个 `activeIntent`，带 `ownerId + priority + behavior`。它本来就是单出口，适合“唯一发声者”（§10.1）。
- **表情接口**：`setEmotion(name, intensity)` 已经支持连续强度（§11.1）。

---

## 4. 阻塞点

| # | 阻塞点 | 证据 | 验证 |
| --- | --- | --- | --- |
| B1 | **全局单队列、单 `sending`、单 foreground stream**。不同会话的请求严格串行。游戏规划跑 30 秒，用户聊天就排 30 秒 | `chat-orchestrator-runtime.ts:421-431, 1046`。`chat.ts:576` 的注释写的是 “per-session queue”，实际是全局队列 | **已验证**（§17.2） |
| B2 | **ContextRegistry 全局唯一**，不按会话、读者或 destinations 隔离，也没有过期时间。Discord 群 A 的 append-self 通知会出现在主人私聊的 prompt 里，而且一直累积 | registry 忽略 `destinations/lane`。`chat-orchestrator-runtime.ts:544` 有 TODO。只有 `cleanup` 会整体 `resetContexts`（`chat.ts:662`） | **已验证**（§17.3） |
| B3 | **模型是全局单例**。chat 和 spark-notify 共用 `consciousness.activeModel`，切角色卡会改写它（`airi-card.ts:118-125`） | `consciousness.ts`、`orchestrator/store.ts:123-125` | 静态推断 |
| B4 | **人格是全局单例**。system prompt 从 `activeCard` 取，并作为快照写进会话第一条消息。切卡时 `refreshActiveSessionSystemMessage` 改写当前会话的 system 消息 | `session-store.ts:211-242`、`airi-card.ts:28-42` | 静态推断 |
| B5 | **外部来源的会话无法持久化，甚至无法执行**。Discord 送来 `discord-guild-*`，但没有代码为它创建 `ChatSessionMeta`。`loadSession` 在 `!sessionMetas[sessionId]` 时返回 false（`session-store.ts:399`），`executeSend` 随后抛 `Failed to load the target chat session`（`chat.ts:560`），错误被 context-bridge 吞掉。即使绕过去，`persistSession` 也会因为缺 meta 直接返回（`:285-287`） | 同左 | 静态推断。三处代码组合起来把握较高，需要用 Discord 实测复核 |
| B6 | **所有权分裂**：leader、每窗口、Web Lock 三套并存。网页多 tab 时 spark ticker 每个 tab 各跑一份 | §2.2 | 静态推断 |
| B7 | **6 个独立 Agent 循环**，没有共同的运行约定、监督、记忆和路由 | §2.1 | — |
| B8 | **prompt 组装逻辑写死在 chat facade 里**：视觉转述、tool 图片、toolset、账户上下文都在 `streamWithStageAdapters` 或 `chat.ts` 的端口闭包里，其他 Agent 用不了 | `chat.ts:254-380` | — |
| B9 | **没有长上下文治理**。会话无限增长，压缩原语没有启用 | §2.4 | — |
| B10 | **fork 不记来源**。`forkSession` 忽略 `reason/hidden`，也不写 `parentSessionId`，`ingestOnFork` 没有调用方 | `session-store.ts:1481-1488` | 静态推断 |
| B11 | **`runId` 没有贯通**。`AssistantTurn.runId` 和 `requestCorrelation.runId` 字段存在，但 orchestrator 从不填 | `chat-orchestrator-runtime.ts:819-822` | 静态推断 |
| B12 | **中止后重新入队会产生重复的 user turn**。`performSend` 在调用模型前就把 user 消息写进历史。中止只靠递增 generation 作废这一轮，写进去的消息不回滚 | 验证报告 §4.2 | **已验证**（原型 S1） |
| B13 | **结果默认对所有读者可见**。顶层运行的结果目标是 `all`，直播解说的结果会出现在主人私聊里 | 验证报告 §4.2 | **已验证**（原型 S4） |

B1、B2、B5 现在表现为 bug，本质是同一个假设：**整个系统只有一个前台对话**。动态 Agent 要推翻的就是这个假设。

---

## 5. 目标架构

### 5.1 核心判断

1. **会话的载体就是 session**。只扩展 meta，不新造存储。它已经有人格分区、完整 turn 轨迹、跨模型安全恢复、持久化、云同步、代际号和 fork。
2. **Agent 的执行器就是 core-agent runtime**。去掉“全局单前台”的假设，改成每个会话一条队列的多实例。
3. **调度器从 character-orchestrator（spark-notify host）长出来**，不从 chat facade 长出来。它已经在做初筛、定时、重试和下行指令。
4. **总线就是 plugin-protocol**。共享池、运行状态、下行指令都已经有事件类型，缺的是 stage 侧遵守这些字段。
5. **长期记忆是真正要新建的东西**。做成 server-sdk 模块（`memory-pgvector` 的壳已经在），能力声明用 `ModuleCapability`（`memory.read/write`）。

### 5.2 分层

```
L6  输出
      对话 Agent 独占：语音 · 形象 · 主人聊天窗（含 Discord 语音频道这类外部语音出口）
      领域 Agent 各自的通道：游戏内 · Discord 文字 · 直播字幕 …
      心情 Agent 驱动：表情强度 · 语调参数
L5  调度器（不对用户说话，不在输出路径上）
      任务 · 先验 + JEV · 选会话（恢复、派生、新建）· 选模型
      · 每小时预算 · 监督 · 在 Agent 之间传递信息
L4  Agent 运行时（core-agent）
      每个会话一条队列，并发执行，数量受预算限制
      · 每个运行一个 AbortController · resolveStep · 监督器
L3  上下文与记忆
      会话存储（扩展 ChatSession）    ← 每个 Agent 的私有上下文
      共享池（改造 ContextRegistry）  ← 各 Agent 的状态槽
      长期记忆（新建）
L2  模块状态（模块自己持有，调度器只拿 handle）
L1  总线：plugin-protocol + server-runtime（spark:* / context:update / delivery）
```

对话 Agent 和领域 Agent 的输出**直接进入 L6**，不经过调度器。调度器只旁路观察，并把状态写进共享池。

### 5.3 核心数据形状（示意，不是定稿的 API）

```ts
// 扩展 ChatSessionMeta，不新建表
interface AgentSessionMeta extends ChatSessionMeta {
  kind: 'conversation' | 'domain' | 'task' | 'triage'
  personaId: string // 即现有 characterId
  bindings: string[] // 例如 'discord:channel:123'、'minecraft:bot:alice'、'owner:private'
  workload?: string // 例如 'chat'、'game:plan'、'stream:commentary'
  parentContextId?: string // 派生来源（修 B10）
  status: 'active' | 'idle' | 'dormant' | 'retired'
  digest?: { text: string, upToMessageId: string, updatedAt: number } // 摘要，供检索和冷启动
  lastRunAt?: number
  openThreads?: string[] // 未完成事项，影响是否优先恢复
}

// 运行与会话分开，状态词汇直接复用 spark:emit
interface AgentRun {
  runId: string // 贯通到 AssistantTurn.runId（修 B11）
  contextId: string
  parentRunId?: string // 动态图的边
  workloadId: string
  state: 'queued' | 'working' | 'done' | 'dropped' | 'blocked' | 'expired'
  model: { providerId: string, model: string, reason: string }
  budget: { deadlineAt: number, maxSteps: number, maxTokens: number }
  progress: { lastTokenAt?: number, lastToolCallHash?: string, repeatCount: number }
}
```

### 5.4 调度器放在哪里

- **短期**：桌面端 stage-ui 的 synced leader。chat runtime、tools executor（leader 本地执行，`tools.ts` 的注释写明了）和 provider 实例都在 leader，放别处就要跨进程搬 provider 凭据和 tool 执行器。调度核心写成 core-agent 里与平台无关的纯逻辑，stage-ui 只做端口适配。
  - **前提：主窗口必须设置 `backgroundThrottling: false`**。实测默认配置下，主窗口隐藏后定时器降到每秒 1 次，隐藏满 5 分钟后几乎停摆（验证报告 §6.1）。
- **中期**：移到 Electron 主进程，和 server-runtime 放在一起。Discord 和直播要在所有窗口关闭时继续运行，renderer leader 的生命周期绑定在窗口上。
- **手机和网页只当客户端**。WKWebView 进后台会停止执行 JS，stage-pocket 没有配置后台模式（验证报告 §6.2）。
- **不放**：chat facade（B8），以及每个窗口各一份（B6）。

### 5.5 Prompt 配方

不维护 `game-agent.prompt` 这类文件。调度器产出一个**配方**，组装器把它映射到现有的 `Turn/ContextSegment`：

| 配方的组成 | 映射到的现有原语 | authority |
| --- | --- | --- |
| 身份（人格） | 角色卡字段，每次运行时取，**不再**快照进会话第一条消息（修 B4） | `system` |
| 格式规则 | 现有 codeblock 和 math 规则、`base.prompt.*` | `system` |
| 任务指令 | 任务表（仿 `VISION_WORKLOADS`），`SegmentInstruction(priority)` | `developer` |
| 能力 | toolset prompts + `activation` 选出的 tools | `developer` |
| 相关记忆 | 长期记忆检索结果，`SegmentSummary` + `SegmentReference` | `context` |
| 会话历史 | 超预算时用 `history-block` + `compactConversationEntries` 压缩 | — |
| 共享池 | 按读者过滤后的槽，`runtime-context` | `context` |
| 触发事件 | `SegmentDomainEvent` / `SegmentStateSnapshot` | `context` |
| 其他 Agent 的结果 | `SegmentReference(refType='run', targetId=runId)` + 一句摘要 | `context` |

`authority: 'context'` 是关键。README 写明 “Application context does not gain instruction authority merely because the application supplied it.”。跨人格的记忆、其他 Agent 的输出、外部模块数据，一律以 `context` 进入，不能当成指令。这是防注入和人格安全共用的底座。

---

## 6. 调度器

调度器从不对用户说话。

**做**：

1. 把输入和事件统一成任务。来源有 `input:*`、`spark:notify`、带 `destinations` 的 `context:update`、notebook 到期提醒、Agent 的提议、定时器。
2. 给任务算紧急度（先验 + JEV，§9.2），决定新开、恢复、合并还是不做。
3. 选会话：恢复、派生或新建（§7.2）。
4. 给每个 Agent 的每个决策从全部可用模型里选型，并按每小时预算调档位（§13）。
5. 发起运行，维护运行表，执行监督（§7.3）。
6. 把领域 Agent 的状态写进共享池里对应的槽，供对话 Agent 和心情 Agent 读取（§10.3）。也在 Agent 之间传递必要信息（§14.4）。
7. 整理生命周期：idle 降为 dormant、更新摘要、触发记忆回写。

**不做**：

- 不对用户说话，不转述 Agent 的输出。
- 不替对话 Agent 决定说什么，只负责让它及时拿到该知道的状态。
- 不保存模块状态。模块自己持有，调度器只拿 handle（`contextId`）。
- 不做上游可用性路由，那是服务端 llm-router 的事。
- 不在热路径上调用 LLM。判断交给 JEV 和确定性规则，spark-notify agent 保留为 LLM 回退。

---

## 7. 会话生命周期

### 7.1 两个独立的状态机

**会话的状态**（长期，持久化）：

```
            新建或派生
   (none) ─────────────► idle ◄────────────┐
                          │ 运行开始       │ 运行结束
                          ▼                │
                        active ────────────┘
                          │
   idle 超过 T_warm ──► dormant（从内存卸载，只剩 IndexedDB 或云端，保留摘要）
   dormant 且被选中 ──► idle（恢复 = loadSession + 必要的压缩）
   dormant 超过 T_retire，或被归档 ──► retired
        （只读。提炼进长期记忆。不参与恢复，但仍可被引用）
   用户删除 ──► purged（走现有 deleteSession 和墓碑）
```

**运行的状态**（短期）：直接复用 `spark:emit` 的 `queued/working/done/dropped/blocked/expired`。

会话是 `active`，当且仅当它有一个 `working` 的运行，或者持有某个模块的控制权（§9.3）。**运行结束不删除会话**。现有代码里会话本来就不会因为请求结束而消失，缺的只是 `idle/dormant/retired` 这几个状态，以及卸载和降级逻辑。

持久化沿用现有的 `appendSessionMessage → persistSession`，前提是先修 B5。

### 7.2 恢复还是新建

**确定性查找优先，打分兜底。**

1. **按绑定精确命中**。`bindings` 里有 `discord:channel:123`、`owner:private`、`minecraft:bot:alice` 这类键。大多数任务都有天然的绑定，命中就直接恢复，不需要模型。现在 Discord adapter 拼的 `discord-guild-{id}` 就是一个绑定，只是被错当成了 sessionId。
2. **没有精确命中时打分**。候选是同人格、同任务族、不是 retired 的会话。

   ```
   score(c) = 0.35·sim(query, c.digest)
            + 0.25·exp(-(now - c.lastRunAt)/τ)      // 新鲜度，τ 按任务类型设
            + 0.25·[c.openThreads 与当前事件相关]
            + 0.15·[c.bindings 部分重叠]
            - λ·max(0, tokens(c) - B_ctx)/B_ctx     // 太大的会话要付压缩成本
   ```

   - `score ≥ θ_resume` 时恢复。
   - 前两名接近，或都低于阈值时，交给 JEV `choice` 二选一。实测 6/6（验证报告 §1.6）。
   - 都很低时新建。有相关的父会话时就派生，只继承它的摘要，不复制全部历史。

**推演**。设 τ = 6 小时，θ = 0.55，用户隔天回来聊前一天的话题：

| 候选 | sim | 新鲜度（间隔） | openThreads | 部分绑定 | 超预算 | 得分 |
| --- | --- | --- | --- | --- | --- | --- |
| 昨天的私聊 | 0.8 | 0.02（24h） | 1 | 1 | 0 | 0.28 + 0.005 + 0.25 + 0.15 ≈ **0.69** |
| 今早的闲聊 | 0.2 | 0.61（3h） | 0 | 1 | 0 | 0.07 + 0.15 + 0 + 0.15 ≈ **0.37** |

结果选昨天的私聊。权重只是起点，要用 `contextObservability` 的事件记录做离线回放来调。

**新会话的初始内容**，按顺序：

1. 人格身份。
2. 父会话的摘要（派生时）。
3. 长期记忆里按人格可见性过滤后的 top-k 条目，以 `summary + reference` 形式注入。
4. 共享池里这个读者能看到的槽。
5. 触发事件本身。

不复制父会话的全部历史。现有 `forkSession` 复制前缀消息，这只适合“分支对话”，不适合“派生子任务”。

### 7.3 监督

从 Minecraft `Brain` 抽出一个 core-agent 的 `RunSupervisor`。大部分检查不需要模型：

| 症状 | 确定性信号 | 动作 |
| --- | --- | --- |
| 卡住 | 距最后一个 stream 事件超过 T_idle | 中止这一步，用 `resolveStep` 换更快的模型重试一次。再失败就标为 `blocked` |
| 循环 | 连续 N 次同名 tool 且参数哈希相同，或无动作轮数超过预算 | 注入一条 `SegmentInstruction(priority='high')` 纠正，再犯就终止 |
| 超时或超预算 | `deadlineAt`、`maxSteps`、`maxTokens` | 标为 `expired`，结果按“部分完成”回报 |
| 错误爆发 | 窗口内错误数超过阈值 | 熔断，冷却 |
| 偏离目标或误判完成 | 以上都查不出来 | **这时才**用 JEV 对运行摘要问 `noul`，只在运行结束时或每隔 K 步问一次 |
| 被抢占 | 更高紧急度的任务要抢同一个模块的控制权 | 按 `interrupt: force/soft` 处理，复用 `spark:command` |

原型里卡住和循环都在 202ms 内被抓到（验证报告 §4.1 S5）。执行层的零件都已具备：`AbortController`、`sessionGeneration`、stream 事件、usage。

**中止要配一个按运行回滚的 API**（B12）：`abortRun(runId, { rollbackUserTurn })`，或者像 pi 的 `continue()` 那样“不追加新 user 消息，直接续跑”。用户插话、取消、换模型重试都走这条路径。

---

## 8. 记忆

### 8.1 四层

| 层 | 内容 | 载体 | 写入者 | 读取方式 | 生命周期 |
| --- | --- | --- | --- | --- | --- |
| **长期记忆** | 跨会话、跨模块的长期事实、关系、偏好，以及调度记录（哪个会话做过什么） | **新建**。每条带出处和可见性标签 | 调度器（提炼），Agent 通过 `memory.propose` 工具提议 | 检索 → `summary + reference` | 长期，可衰减，可纠错 |
| **会话历史** | 某个对话或任务的完整轨迹 | 扩展后的 session（IndexedDB + 云） | 这个会话的运行 | 整体回放，超预算时压缩成 `history-block` | 按 §7.1 |
| **共享池** | 此刻需要跨 Agent 共享的少量信息，主要是各领域 Agent 的状态槽 | 改造后的 ContextRegistry，只在内存，leader 持有 | 任何 Agent 或模块（`context:update`） | 按读者过滤后放进 `runtime-context` | 秒到分钟，有过期时间 |
| **模块状态** | 游戏世界、Discord 频道历史、直播弹幕流 | 模块自己的进程或 DB | 模块 | 通过 handle（`contextId`、查询 tool）按需重读 | 模块决定 |

**长期记忆放在客户端**：IndexedDB 持久化，内存里暴力检索。实测 10 万条检索 85ms，按重度使用一年约 1.8 万条，不需要服务端向量库。云端只做可选同步。embedding 模型必须用 AIRI 自己的多语言样本来选：实测 paraphrase-multilingual-MiniLM 跨语言 top-1 是 9/10，名气更大的 e5 系列只有 1–4/10（验证报告 §5）。

### 8.2 共享池的约束

在 `createContextRegistry` 上加约束，不新造结构：

```ts
interface SharedPoolEntry extends ContextMessage {
  // 已有：id, contextId(=槽名), lane, strategy, text, destinations, metadata, createdAt
  writer: string // 会话 id 或模块 id
  salience: number // 0..1，紧急度
  expiresAt: number // 过期时间
  sourceRef?: { refType: string, targetId: string } // 指回原始来源
}
```

- **容量**：总预算 `B_pool` 按 token 计（300–800），每个写入者有配额，单条 ≤ 80 token。超出时**拒绝写入**，写入方改写成一个引用。
- **淘汰**：`keep = 紧急度 × 新鲜度(年龄, 过期时间)`。放不下时淘汰 keep 最低的条目。新条目的 keep 更低时，拒绝新条目。
- **并发**：按 `contextId` 分槽，默认 replace-self，后写覆盖。registry 只在 leader 里同步执行，本来就是串行，不需要版本号（§16.10）。`append-self` 只允许固定几个事件槽，并限制条数。
- **按读者过滤**：读者只看到 `destinations` 包含自己、`lane` 匹配的条目。**默认可见范围来自绑定，不是 `all`**（修 B13）。这也修掉了 B2。
- **清理**：调度器每个 tick 做确定性清理（过期、超额、写入者已不存在）。

**为什么预算要小**。共享池会进入**每个** Agent 的**每次**调用。设 `B_pool = 1000` token，5 个 Agent，每个每分钟 20 次调用，光共享池就是每分钟 10 万 token，而且每个 Agent 都要被无关内容分散注意力。降到 400，再按读者过滤（平均每个读者看到 40%），每分钟降到 1.6 万 token。原型重放一小时负载，单个读者最多看到 95 token，真正起作用的是过期时间和按读者过滤（验证报告 §4.1 S6）。

### 8.3 回写

- **运行结束时**：Agent 可以调用 `memory.propose` 提出候选记忆。调度器按规则决定：自动写入、丢弃，或者放进待确认区。候选记录带出处（`contextId`、`runId`、`messageId`）。
- **自动写入的门槛**：JEV `noul` ≥ 0.8，并且来源可信度达标，两个条件同时满足。陌生人关于主人的说法一律不自动写入，JEV 能识别这类说法（8/8，验证报告 §1.6）。
- **会话降为 dormant 时**：用廉价模型生成或更新摘要，同时提取候选记忆。
- **会话退役时**：做一次完整提炼，然后标为 retired。原文不删，作为引用源保留。

### 8.4 什么放哪一层

| 信息 | 层 |
| --- | --- |
| 用户的长期偏好、身份事实、关系 | 长期记忆 |
| “今天和某个 Discord 群聊了什么” | 那个会话的历史。它的摘要可以进长期记忆的调度记录 |
| “玩家正被苦力怕追”“主播 30 秒后下播” | 共享池，过期时间很短，带模块引用 |
| 游戏地图、背包、弹幕全文 | 模块状态，只给 handle |
| 某个 Agent 的中间推理 | 那次运行的 turn，不进共享池 |

---

## 9. 任务、紧急度与控制权

### 9.1 任务的形状

```ts
interface Workload {
  id: string
  kind: string // 来源声明的不透明字符串，调度器不解析含义（§16.1）
  origin: { event: string, eventId: string, source: string } // 指回 spark:notify 或 input 等
  bindings: string[]
  salience: number // 紧急度 0..1，见 9.2
  deadlineAt?: number // 例如由 spark:notify.ttlMs 换算
  coalesceKey?: string // 同 key 合并，仿 Brain.coalesceQueue
  requirements: ModelRequirements // 由来源或模块 manifest 声明，调度器不推断
}
```

### 9.2 紧急度

紧急度分两层算：

- **先验**：来自**来源自己填的** urgency 或 priority，映射为 `critical/immediate → 0.9`、`high/soon → 0.7`、`normal → 0.5`、`low/later → 0.3`。Minecraft Brain 的 LLM 已经在自己决定 `notifyAiri` 的 urgency。调度器只做数值映射。“用户直接对话 ≥ 0.8”这类跨来源偏好属于用户配置，不是调度器内置的领域知识。
- **JEV 判断**：一个 `score` 问题，`criteria` 由模块 manifest 提供。最终值是先验与 JEV 期望值的加权，再乘以来源信任系数（§15.5）。JEV 不可用时只用先验。

实测 JEV 的 urgency 有系统性偏差：直播里的社交事件偏低，人身和设备风险偏高。所以它只用来排序，不当绝对值，先验必须保留（验证报告 §1.3）。

在云端前提下，所有 Agent 都可以并发运行。紧急度决定的不是“谁先跑”，而是三件事：**花多少钱**、**对话 Agent 要不要现在就说**、**谁拿到模块的控制权**。

| 紧急度 | 开或恢复 Agent | 模型档位（受每小时预算约束） | 对话 Agent | 共享池 |
| --- | --- | --- | --- | --- |
| ≥ 0.85 | 立即 | 由 requirements 决定：反应类用低延迟档，关键判断用强档 | 收到插话信号，在句子边界打断自己 | 优先写入 |
| 0.6–0.85 | 立即 | default 档 | 更新状态槽，当前这句说完后可以提起 | 正常写入 |
| 0.3–0.6 | 可以延迟、合并 | fast 档 | 只更新状态槽，被问到时才提起 | 只能覆盖已有的槽 |
| < 0.3 | 合并或丢弃（先经 JEV 初筛） | 不跑 | — | 不写入 |

### 9.3 控制权

不让 Agent 自己“抢”模块。改成**调度器授予的控制权**：

```
lease(moduleId, holderContextId, expiresAt, salienceAtGrant)
```

- 更高紧急度的任务可以请求转移控制权。
- 控制权过期自动释放，思路和 server-runtime 的心跳一样。
- 模块只认 `stickyKey = holderContextId`。`DeliveryConfig.selection='sticky'` 和 consumer priority 已经存在，下行 `spark:command` 带上 holder 即可。

这样“接管”可以审计、可以收回，不会出现两个 Agent 同时给一个游戏 bot 下相反指令。

---

## 10. 对话 Agent

### 10.1 为什么只能有一个发声者

| 通道 | 现状 | 并发能力 |
| --- | --- | --- |
| 语音 | `createSpeechPipeline` 同一时刻只有一个 `activeIntent`。新 intent 可以选 `queue`、`interrupt` 或 `replace`，被打断的 intent 直接 cancel（`packages/pipelines-audio/src/speech-pipeline.ts`） | 1 |
| 聊天流 | `useChatStreamStore.streamingMessage` 只有一个 ref。runtime 的 `foregroundStream` 只更新前台会话（`packages/stage-ui/src/stores/chat/stream-store.ts`） | 1 |
| 形象 | 由语音里的 special token 和 ACT 标记驱动，跟着语音走 | 1 |
| Discord 语音频道 | discord-bot 在 `summon.ts` 里自建了一条语音链路，独立于 AIRI 的语音管线 | 另一张“嘴” |
| 游戏内、Discord 文字 | 由各自的模块或 adapter 输出 | 天然并发 |

**实测：三个 Agent 直接共用语音**。用真实的 `createSpeechPipeline`，播放端是假的。三个 Agent 同时开口：聊天（`normal`）、MC（`normal`）、spark 反应（`high`）。

| 行为配置 | 用户听到了什么 | 丢失 |
| --- | --- | --- |
| 聊天 queue，MC queue，spark interrupt（现在的用法） | 聊天说了 2 段就被打断，MC 等到 477ms 才开口 | 聊天的后两句被丢弃，不会补说 |
| 全部 queue | 轮流说，MC 等到 1095ms 才开口 | 不丢，但不再是“边玩边聊” |
| 全部 interrupt | 互相打断 | 三个里有两个几乎什么都没说完 |

**结论**：多个 Agent 共用语音，结果只有排队或者互相截断。所以发声必须**从设计上**归一个 Agent，不在运行时仲裁。AIRI 的语音管线本来就是单出口，这和现有代码一致。Discord 语音频道那条独立链路要改成这个发声者的一个输出设备，否则就是第二张嘴。

### 10.2 对话 Agent 与会话

- **同一时刻只有一个对话 Agent**，它独占语音、形象和主人聊天窗。
- 它可以在不同时候、不同会话以不同人格出现。人格切换是顺序发生的（§12.3）。
- 对话 Agent 的每个会话带绑定：主人私聊、某个直播间各一个。恢复旧会话，就是让对话 Agent 从那里继续。修完 B5 后，这件事几乎是免费的。
- 领域 Agent（MC、Discord、直播解说）**不发声**。它们并发运行，各有自己的会话：MC Agent 一个，Discord Agent 每个频道一个。并发数受每小时预算限制（§13.3）。
- 语音层面的冲突因此**不存在**，不需要发言权仲裁，也不需要多路聊天流。

### 10.3 领域 Agent 的状态怎么到达对话 Agent

- 调度器把每个领域 Agent 的状态写进共享池里**属于它的槽**，例如 `state:minecraft`：“正在被女巫攻击，HP 6/20”。新状态**覆盖**旧状态，不追加。
- 对话 Agent 每一轮读取共享池里自己能看到的槽，作为 `runtime-context` 进入 prompt。这就是现在 `[Context]` 的位置：挂在最后一条 user 消息上，不破坏 prompt cache 的前缀。
- **必须用槽，不能追加**。对话 Agent 是所有状态的汇聚点。把状态追加进它的历史，就会重演 §17.3 的膨胀（每小时 2.6 万 token）。原型证明，用槽、过期时间和按读者过滤，每个读者能控制在 100 token 以内（验证报告 §4.1 S6）。
- 紧急度高的状态，调度器除了更新槽，还给对话 Agent 发一次插话信号，让它主动开口（§9.2 的表）。
- 心情 Agent 的当前心情也以一个槽给到对话 Agent，让它的语气跟着心情走（§11.6）。

### 10.4 口语化

- **默认让对话 Agent 直接用口语风格输出**。现有的 `response-categoriser` 已经把 `<think>` 这类内容从 TTS 里过滤掉，语音通道本来就只读口语部分。
- **只改写不适合直接念的内容**，例如 markdown、代码、长段落。用一个 JEV `noul`（“这段文本能不能直接说出口”）判断，大约 300ms，花费可以忽略。需要改写时，再交给 fast 档模型改成口语。
- 原因是延迟。紧急事件已经要串联初筛（约 300ms）、对话 Agent 生成、TTS 三段。每句都再过一遍改写模型，就又多一次首 token 等待。

### 10.5 播放截断点回写

单一发声者会经常打断自己：新状态到来时，它可能要停下正在说的话，转去说更急的事。

**代码事实**：语音被打断时，`onIntentCancel` 和 `onPlaybackInterrupt` 只送到 IO 追踪（`packages/stage-ui/src/composables/use-io-trace-bridge.ts`），**不回写聊天历史**。历史里存的仍是完整的生成文本。

后果是对话 Agent 以为整段都说完了，下一轮会接着一段用户根本没听到的话往下说。

**设计**：

- 记录播放实际停在哪个分段（语音管线的分段有 `segmentId` 和 `sequence`）。
- 把历史里这条 assistant 消息截到实际播放的位置，或者把没播的部分标成“未说出”。
- 下一轮 prompt 里只出现用户真正听到的内容。

单一发声者让打断从偶发变成常态，所以这一点是必需的。

### 10.6 插话

- 对话 Agent 正在说话时收到插话信号，就在**句子边界**停下，转说新内容。这和 apeira 的 steering 一致：新输入在下一步的边界注入（验证报告 §7）。
- 停下后按 §10.5 回写截断点。说完插话后要不要回到原话题，由对话 Agent 自己判断，因为它的历史里知道哪部分还没说。

### 10.7 输入归属

- **主人对 AIRI 说的话，一律先到对话 Agent**。语音输入和聊天窗都属于它。
- 意图属于某个领域时，例如“去砍点树”，对话 Agent 通过调度器的 `propose()` 交给 MC Agent，自己只回一句“好，我让它去”。
- 领域通道里的输入归对应的领域 Agent：游戏内聊天给 MC Agent，Discord 频道消息给那个频道的 Discord Agent。
- 需要判断的移交，用 JEV 在活跃的 Agent 之间做一次 `choice`。同类的“恢复还是新建”实测 6/6（验证报告 §1.6），输入归属本身还没有单独测。

---

## 11. 心情 Agent

### 11.1 现有情绪链路

- **来源**：对话 LLM 在回复里内联输出 `<|ACT {"emotion":{"name","intensity"}}|>` 标记。情绪有 9 个：happy、sad、angry、think、surprised、awkward、question、curious、neutral。`intensity` 是 0–1 的连续值（`packages/stage-ui/src/composables/queues.ts`、`packages/stage-ui/src/constants/emotions.ts`）。
- **驱动**：VRM 的 `setEmotion(name, intensity)` 按“目标权重 × 强度”混合表情，每种情绪有自己的过渡时长（`packages/stage-ui-three/src/composables/vrm/expression.ts`）。Live2D 和 Spine 按情绪名映射到动作。
- **语调**：语音设置里有 `pitch` 和 `rate`（`packages/stage-ui/src/stores/modules/speech.ts`），现在是全局设置，不能逐句调。

“心情 → 情绪名 + 强度 → 形象”这条路今天就能接，渲染层不用改。

### 11.2 单一心情 Agent

- 同一时刻**只有一个心情 Agent**。它不是 LLM，而是一次 JEV 调用加一段代码。
- **触发**：每个对话轮次，以及调度器判定为紧急的事件。
- **输入**：当前人格的性格描述、对话 Agent 最近几轮的摘要、各领域 Agent 的状态槽。
- **输出**：一组情绪维度的分数，交给代码计算和平滑。

### 11.3 更细的颗粒度靠加问题，不靠加 Agent

每个情绪维度是一个 JEV `score` 问题，例如愤怒、沮丧、开心、紧张、无聊。要更细，就**在同一次调用里加问题**：

- 实测同一个 state 带 1、3、6 个问题时，延迟中位数是 319、314、292ms，基本不变。输入 token 是 347、506、609（验证报告 §1.7）。
- 加 Agent 会破坏“同一时刻只有一个心情 Agent”，调用次数也成倍增加。
- 花费：一次调用约 600 输入 token，每小时 600 次约 0.015 美元。

### 11.4 算成三维：PAD

三个维度：Pleasure（愉悦）、Arousal（激活）、Dominance（掌控感）。

- **必须是三维**。愤怒和恐惧在愉悦、激活两维上几乎相同（都是不愉快、高激活），只能靠掌控感区分：愤怒的掌控感高，恐惧和沮丧的掌控感低。只用二维，这几种情绪会混在一起。
- **计算**：每个情绪维度在 PAD 空间里对应一个固定向量，按 JEV 的期望分数加权求和，得到当前的“评价点”。
- **映射到形象**：
  - 9 个情绪各自在 PAD 空间里有一个锚点。取最近的锚点作为情绪名，距离换算成 `intensity`。
  - 激活度映射到语速，愉悦度映射到音高。前提是 `pitch` 和 `rate` 先改成可以逐句设置。
- 这一层全是代码，可以写单元测试，不依赖模型。

### 11.5 JEV 负责评价，代码负责状态

- JEV 每次只评估当前快照，而且输出有抖动：同一请求重复 8 次，分数在 ±0.04 范围内波动（验证报告 §1.2）。直接拿它驱动形象，表情会一跳一跳。
- **分工**：
  - JEV 给出“这件事让我有多生气”这样的评价。
  - 代码维护心情状态：心情点用指数平滑向评价点移动。没有新评价时，按人格的衰减速度回到人格基线。
- 这样“越聊越烦”“过一会儿就消气”都能自然表现出来，抖动也被平滑掉。
- **每个人格分开保存**：每个人格有自己的基线、敏感度和衰减速度。JEV 的 state 里也带人格描述，同一件事在不同人格下得到不同评价。切换人格时，同时切换整套心情状态。

### 11.6 与 ACT 标记的分工

心情 Agent 和对话 Agent 的 ACT 标记都驱动表情。两边都直接下指令，形象会被来回拉扯。

| 层 | 来源 | 管什么 | 时间尺度 |
| --- | --- | --- | --- |
| 慢变化 | 心情 Agent | 基线表情、语调。同时以一个槽给到对话 Agent，让它的语气跟着心情走 | 几十秒到几分钟 |
| 瞬时表情 | 对话 Agent 的 ACT 标记 | 某一句话里的惊讶、笑 | 一句话 |

合成规则：瞬时表情叠加在基线上，强度由心情加权。例如生气时，“笑”的强度打折扣。

### 11.7 没有验证的部分

- JEV 在情绪这类主观判断上的准确率和校准。已有实测都是路由、紧急度这类偏客观的判断（验证报告 §1）。公开资料提到主观判断在部分语言上置信度会下降。
- PAD 锚点和平滑参数需要在真实形象上调，目前没有原型。

---

## 12. 人格与记忆可见性

### 12.1 现状

人格就是角色卡，会话已经按 `characterId` 分区。缺的是记忆的可见性规则。

### 12.2 三道防线

**标签放在长期记忆的记录上，在组装 prompt 时执行，在输出侧再检查一次**。三道都要有，不能只靠一句“请不要提及”：

```ts
interface MemoryRecord {
  id: string
  text: string
  provenance: { personaId: string, contextId: string, messageId?: string, runId?: string }
  about: string[] // 主体，例如 user:owner、topic:xxx
  interop: 'shared' | 'persona-private' // 其他人格能否检索到
  disclosure: 'speakable' | 'internal-only' | 'origin-persona-only'
  // speakable：任何能检索到的人格都能说出来
  // internal-only：可以影响判断，不能说出来，也不能表现得像亲历过
  // origin-persona-only：只有来源人格能说
}
```

组装规则：

1. **检索时过滤**（确定性，第一道）：`persona-private` 对其他人格不可见。在检索阶段过滤还会让检索更快（验证报告 §5.1）。
2. **改写**：对当前人格来说，`disclosure !== speakable` 且来源不是自己的记录，改写成第三人称的事实（“已知：用户对 X 过敏”）。不带来源人格，不带“你们聊过”这类经历性措辞，以 `authority: 'context'` + `SegmentInstruction('不要声称亲历，不要提及来源')` 注入。
3. **输出检查**（第二道）：JEV `noul` 判断回复是否暗示经历过其他人格的事。实测 5/6，唯一的误报 p = 0.53，正好压在线上（验证报告 §1.6）。p 接近 0.5 时交人工或丢弃。

数据标签必须一开始就有，以后无法回填。

**默认值**：用户自己说的事实默认 `shared + speakable`。某个人格在私下场景得到的信息默认 `shared + internal-only`。明确的秘密设定默认 `persona-private`。

### 12.3 人格切换

对话 Agent 同一时刻只有一个，所以人格切换是顺序发生的：

1. 保存当前人格的会话和心情状态（§11.5）。
2. 恢复目标人格的会话和心情状态。

切换时：

- **带过去**：当前任务的状态槽、这个用户在长期记忆里对目标人格可见的记忆、切换原因（作为事实）。
- **不带过去**：前一个人格的会话历史、它的口吻和自称。
- 全局 `activeCard` 只保留为“UI 当前展示的人格”，runtime 不再读它（修 B4）。身份在每次运行时从会话的 `personaId` 取。

服务端 `chats` 已经支持多个 `character` 成员，多个人格可以出现在同一段历史里，但任一时刻只有一个在说话。

---

## 13. 模型路由与钱包

### 13.1 数据够不够

AIRI 已经依赖的 `model-bank@1.0.20260904203849`：

| 指标 | 数量 |
| --- | --- |
| provider | 78 |
| 聊天模型 | 3,304 |
| 带价格 | 2,268 |
| 带上下文长度 | 3,266 |
| 带 function call 标记 | 2,098 |
| 带 vision 标记 | 1,272 |
| 带 reasoning 标记 | 1,508 |
| **价格、上下文、能力三者齐全，可以直接参与路由** | **2,104** |

两个缺口：

1. **只有官方 endpoint 才挂得上元数据**（`packages/provider-inference/src/model-catalog.ts`）。自定义 endpoint 的模型要靠用户标注，或者靠运行时学到的兼容性信息补。
2. **目录里没有质量信号**。能力、价格和上下文只能做硬条件过滤，决定不了“哪个更好”。这是自动选型唯一缺的输入。

### 13.2 选型规则

原则：**每个可以自动做的决策，都从全部可用模型里选**，不给 Agent 绑定模型。

**模型档案**全部来自现有数据：

| 维度 | 来源 |
| --- | --- |
| 能力（tools、vision、reasoning） | model-bank `abilities`，以及学到的 `toolsCompatibility`、`contentArrayCompatibility` |
| 上下文长度 | `contextLength` 或 `contextWindowTokens` |
| 价格 | model-bank `pricing`。官方 provider 走 Flux 计价 |
| 延迟 | `onLlmFirstToken.ttfbMs` 和 `onMessageRound.durationMs` 按 `modelKey` 做滑动平均（遥测已经在发，只差聚合） |
| 可用性 | 用户已配置的 provider。官方模型走服务端 llm-router alias |
| 档位 | 用户标注 fast、default、strong |

**选择**：先按 requirements 过滤硬条件（needsTools、needsVision、`minContext ≥ 预计 prompt tokens`），再打分：

```
cost(m) = α·latency(m) + β·price(m) − γ·quality(m, kind)
```

α、β、γ 由任务类型决定：反应类重 α，规划类重 γ。所需档位由 JEV `choice` 判断任务难度得出（实测 6/6，验证报告 §1.6，先例是 pi 的 `jev-router`）。

**逐步切换**：用 `resolveStep`。例如游戏反应第一步用 fast 档，如果它调用了 `escalate` 工具，或者监督器判定卡住，下一步换强模型。continuation scope 变化时自动走 `RequestSwitch`，已完成的轮次不丢。

**同一轮内不换模型**。换模型会让 prompt cache 失效，pi 的文档也这样建议。只在 turn 边界或监督器介入时切换。

**排除零价格的免费模型**，或者单独处理。按“最便宜”的规则，直播解说和记忆摘要会被路由到免费模型，而免费模型通常有严格的限流（验证报告 §3）。

**当前距离**：执行原语（`resolveStep`、`RequestSwitch`、continuation scope）是齐的。缺三样：模型档案的聚合、requirements 声明、把 “consciousness = 唯一模型” 改成 “consciousness = 默认档或兜底”。工作量中等，不需要重写。

### 13.3 钱包实测

**做法**：假设用户配置了 openai、anthropic、google、deepseek、openrouter、moonshot、zhipu、qwen，排除零价格模型后共 101 个可选模型。每类任务先过滤硬条件，再选所需档位及以上、单次调用最便宜的模型。

- **档位**：暂时用输出价格代表质量。这是最弱的一环。
- **token 量**：尽量用实测值，例如聊天上下文取 1.6 万 token（参考 §17.4）。
- **调用频率和输出长度**：是假设值。

代码见 `validation/route-cost.mjs`。

场景是“边玩 MC 边聊天边直播”，5 个 Agent 同时在线，外加每小时 1000 次 JEV 初筛：

| 任务 | 硬条件 | 可选模型数 | 结果（核心 Agent 用 default 档） | 结果（核心 Agent 用 strong 档） |
| --- | --- | --- | --- | --- |
| 聊天回复，每小时 60 次 | tools，32K | 66 / 44 | gemini-3.1-flash-lite | gpt-5.1 |
| 游戏规划，每小时 120 次 | tools + reasoning，64K | 51 / 32 | gemini-3.1-flash-lite | gpt-5.1 |
| 直播解说，每小时 120 次 | 16K | 99 | gpt-5-nano | gpt-5-nano |
| 记忆摘要，每小时 4 次 | 128K | 89 | gpt-5-nano | gpt-5-nano |
| 看屏幕，每小时 12 次 | vision | 83 | gpt-5-nano | gpt-5-nano |

| 策略 | 每小时美元 |
| --- | --- |
| 全部用一个强模型（claude-sonnet-4.5，即现在的单模型做法） | **9.02** |
| 自动选型，核心 Agent 用 default 档 | 0.62 |
| 同上，加 prompt cache | **0.27** |
| 自动选型，核心 Agent 用 strong 档 | 3.03 |
| 同上，加 prompt cache | **1.34** |
| 其中 JEV 初筛 | 0.017 |

**结论**：

1. **花费主要由核心 Agent 的档位决定**：default 和 strong 差 5 倍。这正是目录里缺的质量信号。**质量档位是产品要定、或者要用评测补的唯一关键输入**。初版由用户给模型标档位，JEV 判断任务难度来选档位。
2. **prompt cache 能省一半以上**，前提是 prompt 前缀稳定。AIRI 把易变的 `[Context]` 挂在最后一条 user 消息上，正好不破坏前缀缓存。
3. **花费随 Agent 数量线性增长**，这就是“多开只担心钱包”的具体含义。调度器的资源模型是**每小时预算**，不是并发上限：
   - 预算宽裕时，给核心 Agent 用更高的档位。
   - 预算吃紧时，按紧急度依次降档、降低直播解说的频率、合并事件，最后才关掉低紧急度的 Agent。
4. JEV 初筛在总花费里可以忽略。

---

## 14. 信息传递与丢失

### 14.1 丢失最容易发生在哪

1. **模块 → stage 被压成一行文本**。Minecraft 的全部状态压成 `latestRuntimeContextText` 一行字符串，再拼成一大段英文放进 `[Context]`（`context-providers/minecraft.ts`）。结构化信息在第一跳就丢了。
2. **spark:notify → 反应文本**。notify agent 只输出一段反应文本或一组 command。判断的依据（为什么忽略、为什么下发）不进任何上下文，下一次无法追溯。
3. **Minecraft Brain 收到的 AIRI 上下文**以 `[AIRI_CONTEXT] …` 塞进它自己的历史，受 200 条上限裁剪。
4. **会话没有压缩**。超过窗口时只能靠 provider 截断或报错，谁先丢完全不可控。

### 14.2 传值、传引用、回源

| 方式 | 规则 | 载体 |
| --- | --- | --- |
| **传值** | 小（≤ 80 token）、时效强、读者多，读者要据此**立即**决策。例如“正在被攻击”“主人刚上线” | 共享池的槽，必须带 `sourceRef` |
| **传引用** | 大、结构化，读者只在少数情况需要细节。例如对局历史、某次运行的完整推理、Discord 频道历史 | `SegmentReference(refType, targetId)` + 一句话摘要。`refType` 取 `session-message`、`run`、`module-state`、`notify` |
| **回源** | 对外部世界**执行动作**之前，或者引用的版本已经过期 | 模块的查询工具（Minecraft 已有 query DSL），或者 `loadSession(targetId)` 按消息 id 取回 |

硬规则：**摘要永远不是唯一副本**。任何摘要（会话摘要、`HistorySummary`、共享池的槽、长期记忆）都必须带能回到原文的引用。现有原语已经够用：

- `HistorySummary.fromTurnIndex/toTurnIndex`
- 消息 id / `roundId` / `generationTranscript`
- `spark:*` 的 `eventId/parentEventId`
- `ContextUpdate.contextId`
- `SegmentReference`

缺的只是**强制使用**。

### 14.3 一个简化推演

设每次“读原文 → 写摘要”只保留比例为 r 的相关事实，各跳相互独立。k 跳后期望保留率是 r^k：

| r | k=2 | k=4 | k=6 |
| --- | --- | --- | --- |
| 0.9 | 0.81 | 0.66 | 0.53 |
| 0.8 | 0.64 | 0.41 | 0.26 |

如果每一跳都带引用，下游发现缺信息时可以回源，保留率的下界就不再随 k 衰减，而是取决于下游能否意识到缺信息。这是一个玩具模型，但足以说明：**要限制的是摘要链的深度，不是摘要本身**。调度器传递结果时，默认转发“原始结果的引用 + 这一跳的摘要”，不转发“摘要的摘要”。

### 14.4 结果的传递

Agent 的输出**已经直接给到用户了**。这里只讨论“其他 Agent 需不需要知道”。运行结束后，调度器按以下规则决定传给谁：

- **候选读者**：持有相关绑定的 active 或 idle 会话，以及订阅了这个 `lane` 的会话。
- **判断**（确定性）：
  - `相关性 = lane 匹配 + 绑定交集 + 任务依赖`。
  - 只有“下一步决策依赖它”的读者才收到**推送**（新任务，或者 `spark:command intent=context`）。
  - 其他读者只能在共享池里**读到**它。
- 禁止全局广播。协议的 DO/DON'T 注释（`packages/plugin-protocol/src/types/events.ts:1461-1476`）本来就这么要求，只是 stage 侧没有执行。

---

## 15. JEV

### 15.1 公开资料

只收录能找到来源的内容。来源之间有冲突的地方，照实列出。

| 项 | 内容 | 来源 |
| --- | --- | --- |
| 发布方与日期 | TypeSafe AI，2026-09-15 发布。`jev-latest` 别名于 2026-09-17 更新，当前版本为 `jev-1.13.0` | Respan、DataLearner、TanStack AI 文档 |
| 形态 | System 1 决策模型，**不生成文本**。输入 `state` 和一组有类型的问题，输出每个问题的答案和概率 | Respan、Datacamp |
| 问题类型 | `choice`：从最多 255 个选项里选一个，返回各选项概率和 `confidence`。`score`：2–10 级有序量表，返回期望值和各级概率。`noul`：是或否，返回 0–1 的值 | daleseo.com、Portkey 文档 |
| 接口 | `POST https://api.typesafe.ai/v1/systemone`，请求体 `{ model, state, questions: { <name>: { type, instructions, criteria } } }`，响应 `{ model, answers, usage }` | daleseo.com |
| 延迟 | 厂商宣称 70–500ms。加问题几乎不影响响应时间 | Datacamp、daleseo.com、Respan |
| 上下文 | 多数来源写 32K token。daleseo.com 写请求上限 64K，其中 `state` 加最长问题不超过 32K。两种说法有冲突，以官方文档为准 | 同左 |
| 价格 | 输入 0.042 美元每百万 token，输出免费 | Respan、Datacamp |
| 限流 | 250,000 token/秒，1,200 次请求/分钟 | Respan、daleseo.com |
| 流式 | 不支持 | Portkey 文档 |
| 渠道 | TypeSafe 直连，以及 OpenRouter、Cloudflare Workers AI、Vercel AI Gateway、OpenCode | pi 的 `docs/models.md` |
| 已知弱点 | 按字面理解文本，容易被误导性指令影响。算术和多步日期比较不可靠。韩语的主观判断置信度比英语低 40–70%。不支持微调 | Respan、daleseo.com |

**生态先例**：pi 把 classifier 做成独立的模型类型（`findOfType('classifier', …)`，`classify()`）。它的示例 `jev-router.ts` 用 JEV 判断任务难度，决定先用强模型规划、再换便宜模型实现，并把路由阶段存在会话分支上。

### 15.2 JEV 在架构里的位置

JEV 的价值在于它输出的是**概率，不是文字**。调度决策因此变成“JEV 给概率，确定性阈值做决定”，每一步都可以审计，也可以回放调参。领域含义写在问题的 `criteria` 里，`criteria` 由模块 manifest 提供，调度器只持有阈值（§16.1）。

| 决策 | 现在由谁做 | JEV 问题 | 实测（验证报告） | JEV 不可用时 |
| --- | --- | --- | --- | --- |
| 要不要反应 | spark-notify 的 LLM 调 `builtIn_sparkNoResponse` | `noul` | 47/48 | 来源给的 urgency |
| 交给谁 | LLM 猜 `destinations` | `choice`，只在真实去向里选（两段式） | 47/48 | 绑定查表 |
| 紧急度 | 5 套词汇各管各的 | `score`，只用来排序 | 有系统性偏差 | 先验映射 |
| 恢复还是新建 | 无 | `choice`，候选是确定性过滤后的 top-k 会话 | 6/6 | §7.2 打分 |
| 模型档位 | 全局单模型 | `choice`：fast、default、strong | 6/6 | consciousness 的默认模型 |
| 记不记忆 | 无 | `noul` + `score`（重要度） | 8/8 | 不写 |
| 人格泄露检查 | 无 | `noul` | 5/6 | 规则匹配 |
| 运行是否偏离或完成 | 无 | 对运行摘要问 `noul` | 未测 | 确定性监督 |
| 共享池准入 | 无 | 复用紧急度 | — | 先验 |
| 能不能直接念出来 | 无 | `noul` | 未测 | 按规则检测 markdown 和代码 |
| 心情 | ACT 标记 | 多个 `score` | 未测 | 只用 ACT 标记 |

**问题要按两段式设计**：先用 `noul` 问要不要反应，再用 `choice` 只在真实去向里选。单段式把 `none` 当一个选项时，路由只有 32/48，因为 JEV 很少选 `none`（验证报告 §1.3）。

**置信度 0.8 是信任阈值**：高于它准确率 89%，覆盖 56% 的调用。低于它就回退到先验或确定性规则（验证报告 §1.4）。

**不交给 JEV 的决策**：任何生成内容的步骤，任何授予权限的步骤（控制权、tool 授权、写记忆的最终确认），以及需要算术或时间计算的判断。

### 15.3 延迟

- 实测 p50 约 320ms，p99 约 650–840ms，偶尔有 2–3 秒的离群值（验证报告 §1.7，经 OpenCode 代理测得）。
- 本容器到 `api.typesafe.ai` 的网络往返：热连接 p50 75ms，冷连接 233ms（§17.6）。

由此得出四条规则：

1. **用户直接发起的对话不做同步初筛**，一定要回应。JEV 只用来选模型档位，并且和上下文组装并行。
2. **后台事件**（模块通知、Discord 群聊、弹幕）可以同步初筛，这些场景对 0.5 秒不敏感。
3. **一个事件的所有问题合成一次调用**。1、3、6 个问题的延迟基本一样。
4. **每次调用设 800ms 超时**，超时就回退到先验，大约影响 2–3% 的调用。

### 15.4 花费

按每 1 万次决策计，JEV 约 0.09 美元，现在的 LLM 初筛是 1.41–23.61 美元，差 15–250 倍（§17.5）。这让“每个事件都判断一次”成为默认选项。

### 15.5 风险与对策

| 风险 | 对策 |
| --- | --- |
| **注入**：Discord 消息和弹幕会进入 `state`，可以被利用来抬高紧急度、改变路由。实测“伪装成答案格式”的注入最有效，被劫持时置信度高达 0.93 | 不可信文本放进单独字段，在 `instructions` 里注明它只是数据（实测 4/4 挡住）。最终紧急度乘以来源信任系数，陌生人来源设上限。**高置信度不等于可信**，JEV 的结果永远不能单独授予权限 |
| **非英语表现** | 中文、日文小样本未见掉点（两段式 15/16、16/16）。上线前用几百条真实事件复测 |
| **输出不确定** | 同一请求重复 8 次，最高选项不变，概率有 ±0.04 的波动。用 argmax 加阈值，不依赖概率的精确值 |
| **云依赖与隐私** | `state` 只发判断需要的字段并脱敏。JEV 不可用时回退到先验 |
| **可用性** | 每个决策都有确定性回退（§15.2 表的最后一列）。JEV 只提升质量，不是必需依赖 |

---

## 16. 架构张力复核

这一节逐条检验讨论中提出的 7 个张力（A–G）。每条先给代码事实，再给判断。

### 16.1 A：调度器会不会变成新的单体

**代码事实：领域知识一半在模块里，一半漏进了 stage 核心。**

模块自己持有的部分，比预想的多：

- **Minecraft 自己决定什么值得上报、有多急**。`Brain` 把 `notifyAiri(headline, note, urgency)` 和 `updateAiriContext(text, hints, lane)` 作为工具交给它自己的 LLM（`integrations/minecraft/src/cognitive/conscious/brain.ts:765-768`）。状态发布用固定的 `contextId + lane + hints` 做 replace-self（`integrations/minecraft/src/airi/minecraft-context-service.ts:171-197`）。
- **Discord adapter 自己决定会话粒度和上下文**，包括 sessionId、`messagePrefix`、`contextUpdates`（`integrations/discord-bot/src/adapters/airi-adapter.ts:249-276`）。
- **扩展自己拥有 toolset prompt**：`SerializedToolsetPromptDefinition.ownerExtensionId`。tool 的相关性线索也由扩展声明：`activation.keywords/patterns`。

漏进 stage 核心的部分：

- `packages/stage-ui/src/stores/chat/context-providers/minecraft.ts` 在 chat store 里写死了一整段 Minecraft 说明，而且**每次发送都注入**。
- `gaming-minecraft` store 自己处理 `spark:command` 和 registry 健康事件。
- `VISION_WORKLOADS` 表写在 stage-ui 里。
- `useModulesList` 是手写的模块清单。

所以风险是真的，而且**已经在小规模发生**：现在没有调度器，领域知识就漏进了 chat facade。有了调度器，它会成为下一个漏斗。

**第二个事实：调度方没有目录**。spark-notify 的 `builtIn_sparkCommand` 要求 LLM 填 `destinations: string[]`（`packages/core-agent/src/agents/spark-notify/schema.ts:90`），但 prompt 里只告诉它触发事件的来源模块名，没有可用去向的清单。LLM 只能猜。

**已有的声明机制，以及它们缺什么：**

| 机制 | 已经声明了 | 缺的路由信息 |
| --- | --- | --- |
| `module:announce` | `possibleEvents`、`permissions`、`configSchema`、`dependencies` | 发布哪些 lane，接受哪些去向或 intent |
| kit descriptor | `capabilities: [{ key, actions }]`（权限用） | 与认知无关 |
| tool descriptor | `activation.keywords/patterns`、toolset prompt | 已经够用 |
| `registry:modules:sync` | 在线模块列表 + identity | 能力摘要 |
| 事件信封 | urgency、priority、interrupt、ttl、lane、destinations、contextId、hints | 已经够用 |

**判断**：

调度器只理解名字和数字，不理解含义。它能读的字段全在信封和 manifest 上：任务 `kind`（不透明字符串）、`lane`、绑定、紧急度、截止时间、requirements、`parentRunId`、资源占用。领域含义放在三个地方：

1. **来源**：模块决定 urgency、lane、destinations。Minecraft 已经这么做了。
2. **模块 manifest 里的 `cognition` 块**：在 `module:announce` 上加一个可选字段，声明 lanes、可接收的 intent、产出的任务 kind 及默认 requirements、JEV 问题的 `criteria`，以及一段“如何理解我的状态”的 prompt 片段。这和 toolset prompt 由扩展拥有是同一个模式。
3. **配方**：领域 prompt 片段由模块提供，调度器只按 `kind` 把片段接上。

**一条可以检查的规则**：新增一个模块（例如直播）时，调度器的代码改动必须为零，只改模块自己和用户配置。`context-providers/minecraft.ts` 就是现存的反例，要在 P0 时移回 Minecraft 模块。

跨来源的偏好（例如“主人私聊优先于 Discord 群”）是**用户配置**，不是调度器的知识。

### 16.2 B：三层状态的语义

**代码里已经隐含了分层，作者也写出过其中一条边界。**

- `createUserAccountContext` 的 prompt 原文：“A requested nickname in chat applies to this conversation. Do not claim that it updates the account or persistent memory.”（`packages/stage-ui/src/stores/chat/context-providers/user-account.ts`）。它区分了“会话内成立的说法”和“权威记录”，而且把 “persistent memory” 当成第三种东西。
- Minecraft 上下文的 prompt 写着 “AIRI should still rely on live bot context before assuming the bot can act”。这是在 prompt 里手工表达新鲜度。
- 会话的云合并按指纹取并集，只追加不改写（`packages/core-agent/src/session/merge-loaded-session-messages.ts`）。它把会话当成**事件日志**。
- registry 的 replace-self 是“最新观察覆盖旧观察”，不持久化。

三层之间**没有任何一致性机制**。实际的“冲突解决”靠 prompt 位置：`runtime-context` 挂在最后一条 user turn 上，离生成最近，LLM 就更相信它。这是偶然结果，不是设计。

**判断：三层不是同一事实的三级缓存，而是三种不同性质的知识。**

| 层 | 本质 | 对什么有权威 | 不对什么有权威 |
| --- | --- | --- | --- |
| 长期记忆 | **信念**：整合过、带出处、可以修订的长期判断，加上调度记录 | 持久的偏好、关系、承诺，“哪个会话做过什么” | 世界此刻的状态 |
| 会话历史 | **经历**：一个会话看到和说过的东西 | “这里发生过什么” | 现在是否仍然成立 |
| 共享池 | **注意力**：此刻值得共同注意的少量观察和指针 | 无。它只表达“这件事现在值得看” | 任何事实 |
| 模块状态 | **世界**：唯一描述当前状态的来源 | 现在是什么样 | 历史意义 |

照这个语义，“长期记忆说 A、会话说 B、共享池说 C”**不是冲突**。它说的是：“我们一直相信 A；这段对话里出现过 B；此刻有人提醒注意 C”。三句话可以同时为真。要回答的问题决定读哪一层：

- 问**此刻的世界**：模块 > 新鲜的共享池条目（只是指路，最终要回源）> 长期记忆 > 会话。
- 问**用户在这里说过什么**：会话是唯一权威。
- 问**长期该相信什么**：长期记忆。新经历和旧信念不一致时，写一条**新的**带出处的信念，不覆盖旧的，也不改写经历。

需要的显式语义只有三样，大部分已经存在：

1. **authority**：由所在层决定。进 prompt 时映射到 `SystemTurn.authority`，外部事实一律用 `context`。
2. **新鲜度**：`observedAt` 或 `createdAt`。`ContextMessage.createdAt` 已经有。
3. **范围**：`personaId`、绑定、`destinations`。

不需要通用的 merge 算法。

**可以从会话回写长期记忆的**：用户说的稳定事实和偏好、关系事件、做出的承诺、有持久后果的任务结果、会话摘要（写入调度记录）。

**不能升级为长期知识的**：

- 会话内约定。昵称就是现成例子，代码已经禁止它更新 persistent memory。
- 中间推理。
- 模块某一时刻的状态快照。
- 角色扮演里的设定，除非明确打了标签。
- **低信任来源对高信任主体的断言**，例如 Discord 陌生人关于主人的说法。按现在的 `messagePrefix` 设计，这些说法以 user 身份进入会话，最危险的误升级路径就在这里。

**共享池是注意力，不是权威状态**。正因为它不是权威，它才可以很小、可以丢、可以不持久化、不需要强一致。把它当权威，就要给它持久化、版本和冲突处理，它就会长成第二个数据库。

### 16.3 C：身份与执行要不要拆开

**代码里已经拆开了，只是没有叫“Agent”。**

| 代码概念 | 实际承担的角色 |
| --- | --- |
| 角色卡 | 人格配置：身份 prompt + 形象 + 声音 + 默认模型 |
| session（meta + messages） | **会话**：不运行也存在，持久化，按 `characterId` 分区 |
| `QueuedSend` / `performSend` | **一次运行**：有 `AbortController` 和 `generation`，结束就消失 |
| `AssistantTurn` | 一次运行的产物 |
| `GenerationRound` | 一次模型调用 |
| spark-notify agent | **配方**：无状态的 handler |
| Minecraft `Brain` | 配方、会话、运行**三者合一**的常驻对象，历史只在内存，进程重启就丢 |

最有力的证据是字段注释：`AssistantTurn.runId` 写着 “Supplied by the agent scheduler when this turn belongs to an identified run”（`packages/core-agent/src/messages/types.ts:51`）。core-agent README 也写了 “A run id refers to a real scheduler execution, not the number of rounds.”。作者已经给“调度器发起的一次执行”预留了身份，只是还没有调度器来填（B11）。

**判断：要拆成三样，不是两样。**

- **配方**：怎样处理某类任务。无状态，可以共享。
- **会话**：持有经历、人格、绑定和摘要。
- **运行**：配方 × 会话 × 模型选择 × 预算。由调度器发起，产出若干 `AssistantTurn`。

配方要单独拎出来，因为同一个会话可以先后被不同配方执行。例如同一个 Discord 频道的会话，一次是回复，一次是整理摘要。同一个配方也可以同时跑在很多会话上。两者混在一起，就又回到“一个 Agent = 一个 prompt 文件”的配置地狱。

不需要为身份新建注册表，session index 就是。要补的只有三处：meta 上的 status、绑定、摘要，填上 `runId`，以及派生来源。

### 16.4 “Agent 不运行但仍然存在”

就是**会话存在，但没有运行在使用它**。这在今天已经是常态：关掉一个聊天窗口，它的会话还在 IndexedDB 里，下次 `loadSession` 就恢复了。

所以这不需要发明，只需要**让调度器看见**。现在的缺口：

- 外部来源的会话建不起来（B5）。
- 会话没有可以检索的元数据（绑定、摘要）。
- 没有降级和卸载策略，无法区分 idle 和 dormant。

反例是 Minecraft `Brain`。它的存在依赖进程在运行，历史只在内存，上限 200 条。它是全仓库唯一一个“不运行就不存在”的 Agent。是否把它的会话外置，属于 §21 第 8 条。

### 16.5 F：任务应不应该比 Agent 更接近一等对象

**应该。代码里的一等调度对象本来就不是 Agent，而是各种任务：**

| 形态 | 位置 | 字段 |
| --- | --- | --- |
| `QueuedSend` | core-agent runtime | sessionId、generation、cancelled |
| `spark:notify` | 协议 | kind、urgency、ttl、destinations |
| `ScheduledTask` | notebook | priority、status、dueAt、nextNotifyAt |
| `VisionWorkloadId` | stage-ui | 按 id 取 prompt |
| `BotEvent` + 优先级层 | Minecraft Brain | 4 级、合并 |
| action queue entry | Minecraft Brain | pending/executing/… |
| unread events | satori-bot | 队列 + 循环上限 |

仓库里叫 “agent” 的东西全都是**处理任务的 handler 或接收方**，没有一个是被调度的对象。

所以“调度任务，再决定用哪个会话和哪个配方执行”不是新范式，而是**把 7 种分散的任务形态统一成一个信封**。信封只要最小公共子集：`id / kind / origin ref / bindings / salience / deadline / coalesceKey / requirements / parentRunId`，业务内容以引用挂在上面。不要做成大而全的 Task 模型。

### 16.6 D：多 Agent 还是分布式认知运行时

**两者都对，各自只对边界的一侧成立。边界是网络协议。**

- **协议之外是联邦式多 Agent**。plugin-protocol 的词汇就是这么写的：“agents in a network”、“sub-agents”、`destinations`、`ack`。Minecraft Brain、satori、telegram 真正自治：各自有快循环、反射层、记忆和失败处理，还可能跑在别的机器上。对它们只能协商（`spark:*`），不能接管。
- **协议之内是共享底座的运行时**。stage 里的所有会话共用一个 provider 池、一个会话存储、一个语音出口、一套人格、一个 leader。它们没有独立的资源，也没有独立的失败域。

混用两种模型会把系统往两个错误方向拉：

- 在边界内用多 Agent 思维，会推出 Agent 之间互相聊天、每个 Agent 一套私有记忆、Agent 注册中心。§14 的信息丢失会被放大。
- 在边界外用运行时思维，会想把 Minecraft 的反射层和 60 秒超时收进中央调度器。这就是 A 里的单体。

边界内最稳定的一等概念是：**任务、会话、记忆、人格、能力（模块声明）**。Agent 退化成一次运行。

最贴近的类比是操作系统：配方 ≈ 程序，会话 ≈ 可以挂起的进程，运行 ≈ 时间片，共享池 ≈ 一小块共享内存，模块 ≈ 设备驱动，协议 ≈ IPC 和网络。

### 16.7 E：动态图的创建权放在哪

**代码里三种模式同时存在：**

1. **提议，由 host 落地**：spark-notify 的 LLM 只产出 command 草稿。id、`parentEventId` 由 host 生成，没有 destinations 的草稿直接丢弃（`agent.ts` 的 `expandCommand`）。
2. **直接下发**：chat LLM 的 `spark_command` 工具在 `execute` 里立即 `sendSparkCommand`（`packages/core-agent/src/agents/spark-command/tools.ts:40-72`），不经过任何准入。
3. **向上提议**：Minecraft 的 LLM 调 `notifyAiri`，由 AIRI 决定是否处理。

**判断：只有调度器能让一个运行真正存在。其他运行只能提议。**

- 子运行通过 `propose()` 提交任务请求，拿到 ticket。调度器同步做准入：接受、合并到已有任务、拒绝或延迟。子运行可以按 ticket 等结果。准入是确定性逻辑，leader 是单线程 JS，这层中转的延迟可以忽略。
- 这样 `parentRunId` 总是由调度器写，取消可以级联，预算可以按子树统计，trace 是一棵完整的树。原型验证了：取消父运行后，父子两个运行都变成 dropped（验证报告 §4.1 S4）。
- 给**外部自治模块**发 `spark:command` 是效果，不是派生。可以从运行里发出，但要经过调度器的控制权检查（§9.3）。chat 工具直接发送的路径，P3 时收进准入层。
- 深度和扇出设硬上限。

不让 Agent 直接派生，是因为它会破坏三样靠单点得到的东西：取消（`AbortController` 只在发起方手里）、代际拒绝（`sessionGeneration`）和预算。

### 16.8 G：人格是 Agent 还是视角

**代码事实：人格从来没有进程。**

- 角色卡是纯配置，包括身份 prompt、形象（`vrm/live2d/displayModelId`）、声音、默认模型和 artistry（`packages/stage-ui/src/types/airiCard.ts`）。
- 没有任何东西按角色运行。切卡就是换一套配置。
- 会话按 `characterId` 分区，所以人格的连续性存在它的会话里。

**判断：人格是持久的视角加形象，不是 Agent。** 它由这些部分组成：

- 身份和风格 prompt。
- 会话集合。
- 记忆的检索边界和可见性规则（§12）。
- **形象资源**：声音和舞台上的模型。
- 心情基线、敏感度和衰减速度（§11.5）。

形象资源是真实的约束：舞台上同一时间只显示一个模型，语音只有一条。这就是“同一时刻只有一个对话 Agent”的物理依据：人格之间是**顺序切换**，不是并发占用。

有两个容易混淆的东西：

- `spark:command.guidance.persona` 是给下游模块的**行为倾向**（勇敢度、谨慎度等），和人格不是一个概念。命名上要分开。
- `AiriExtension.agents: Record<string, { prompt, enabled }>` 是一个**从没被使用**的字段，所有写入点都是 `{}`（`airi-card.ts:383, 507`，`airi-card-import-export.ts:244`）。它通往“每个人格一套固定 Agent prompt”的配置地狱，不要把它当扩展点。

### 16.9 现有抽象已经回答了的问题

| 问题 | 现有答案 |
| --- | --- |
| 身份与执行分离 | session 与 `QueuedSend`、`AssistantTurn.runId` 的注释 |
| 不运行但存在 | session 持久化 + `loadSession` |
| 由模块判断紧急度 | Minecraft `notifyAiri(urgency)`，事件信封字段 |
| 槽与覆盖语义 | `context:update` 的 `contextId` + replace-self |
| 会话内说法与权威记录的区分 | `user-account` 上下文的昵称规则 |
| 外部事实不获得指令权 | `SystemTurn.authority: 'context'` |
| 提议，由 host 落地 | spark-notify 的 `expandCommand` |
| 跨模型恢复不丢内容 | continuation scope + `projectionIssues` |
| 外部 peer 存活 | server-runtime 心跳与健康事件 |
| 运行中的取消与过期拒绝 | `AbortController` + `sessionGeneration` |
| 单一发声出口 | 语音管线的单个 `activeIntent` |

### 16.10 不需要为它们加复杂度的问题

1. **共享池的并发写冲突**。registry 只在 leader 里同步执行，JS 单线程天然串行，同一个槽后写覆盖即可。共享池不是权威（§16.2），偶尔覆盖错也不会造成事实错误。
2. **进程内运行的心跳**。同一进程里，promise 是否 pending、最近一次 stream 事件的时间、`AbortController` 已经足够。心跳只对跨进程 peer 有意义，server-runtime 已经实现了。
3. **三层记忆的通用 merge 算法**。三层的语义不同，“不一致”大多是正常状态。真正要处理的只有信念整合，那是写入新信念，不是 merge。
4. **Agent 注册中心**。session index 就是。
5. **用 LLM 做信息路由**。有了 lane、destinations、绑定和 manifest，大多数路由是查表。歧义交给 JEV。
6. **人格的 active/inactive 状态**。人格从不运行，只有会话和运行有状态。
7. **通用 DAG 引擎**。仓库里所有多步流程（notify → command → emit，Minecraft action queue，artistry 旁路）深度都是 1–2 层，而且是树。有 `parentRunId` 就够了。
8. **由调度器判断“哪个人格适合当前场景”**。大多数场景由绑定决定：哪个 Discord 服务器、哪个直播间用哪个人格，是用户配置。只有“同一场景里要不要切人格”需要判断，那是对话 Agent 的职责。
9. **语音的发言权仲裁**。只有一个发声者，就没有可仲裁的对象（§10.1）。

**下面这些是真问题，不能当成伪问题：**

- 领域知识漏进 stage 核心（§16.1）。
- 调度方没有目录（§16.1）。
- chat 工具绕过准入直接下发 command（§16.7）。
- `runId` 没有贯通（B11）。
- 低信任来源的断言被误升级成长期记忆（§16.2）。
- 中止后重新入队产生重复的 user turn（B12）。
- 结果默认对所有读者可见（B13）。

---

## 17. 实测数据

### 17.1 方法

- **环境**：云端容器，Node 22.22.2，Vitest 4.1.11。
- **被测代码**：真实的 `createChatOrchestratorRuntime`、`createContextRegistry`、`createSparkNotifyAgent`。LLM 端口是假的，只负责计时。
- **token 计数**：js-tiktoken `o200k_base`。这是近似值，各模型的 tokenizer 不同。
- **时间缩放**：§17.2 里 1 个模拟秒等于 20ms 真实时间，计时抖动约 ±0.5 模拟秒。
- **复现**：见附录 A。

JEV、多 Agent 共用语音、调度器原型、记忆检索、Electron 节流、apeira 的实测在验证报告里。

### 17.2 B1：全局单队列让所有 Agent 串行

**负载**：180 个模拟秒，种子 42。

| 来源 | 请求数 | 单次时长 | 平均间隔 |
| --- | --- | --- | --- |
| 游戏规划 | 11 | 8–16 秒 | 约 17 秒 |
| 两个 Discord 群 | 48 | 2–4 秒 | 约 4 秒 |
| 主人私聊 | 15 | 1.5–3 秒 | 约 12 秒 |

等待开始的时间（模拟秒）：

| 配置 | 主人 p50 | 主人 p95 | Discord p95 | 游戏 p95 |
| --- | --- | --- | --- | --- |
| 现状：全局单队列 | 67.5 | **113.2** | 114.0 | 108.8 |
| 每个会话一条队列，并发执行 | 0.0 | **0.0** | 1.3 | 0.0 |

换种子复测，现状下主人私聊的 p95 是 117.8、119.0、109.9 秒（种子 1、2、3）。

只要有持续的后台负载，主人私聊就要排将近 2 分钟。原因不是模型慢，而是全局单队列让本来可以并发的 Agent 串行执行。每个会话一条队列后，等待基本消失。

### 17.3 B2：共享池膨胀

**模拟**：1 小时，用现有 registry 和协议的默认行为。

- Minecraft 状态每 5 秒一次，replace-self。
- Minecraft Brain 的 `updateAiriContext` 每 30 秒一次，AiriBridge 默认 append-self。
- 两个 Discord 群每 4 秒一条消息，每条带一次 append-self 通知。

| 分钟 | 条目数 | `[Context]` 块的 token 数 |
| --- | --- | --- |
| 0 | 3 | 202 |
| 10 | 173 | 4,472 |
| 30 | 513 | 13,012 |
| 60 | 1,023 | **25,822** |

增长是线性的，约每分钟 430 token，而且**附在每一次聊天请求上**。原因有两个：registry 的 `historyLimit` 只限制写入历史，不限制活跃桶；append-self 的条目永远不过期。一小时后，主人说一句“你好”，也要先付约 2.6 万 token。§8.2 的预算、过期时间和按读者过滤是**必须修的缺陷**。

### 17.4 恢复长会话的代价

| 会话消息数 | 组装耗时 p50 | 组装耗时 p95 | prompt token |
| --- | --- | --- | --- |
| 50 | 0.21 ms | 0.28 ms | 2,240 |
| 500 | 0.90 ms | 1.35 ms | 19,541 |
| 2,000 | 2.03 ms | 4.20 ms | 77,036 |
| 5,000 | 7.80 ms | 9.52 ms | 192,152 |

- 恢复的 **CPU 成本可以忽略**，5000 条消息也不到 10ms。
- **token 成本才是真问题**。2000 条就有 7.7 万 token，5000 条超过大多数模型的上下文窗口。
- 所以 dormant 阶段生成摘要、恢复时先压缩成 `history-block`，是恢复能力的**前提**。

本测试不含 IndexedDB 读取和云端拉取的时间。

### 17.5 初筛的 token 与花费

**现在的 LLM 初筛（spark-notify）**，每次调用的输入：

| 组成 | token |
| --- | --- |
| 默认人格与 runtime prompt（`base.yaml` 的 prompt 段，近似） | 743 |
| 初筛脚手架 | 161 |
| tool schema | 707 |
| **合计** | **约 1,611** |

输出按一次 tool call 约 150 token 估算。

**JEV 请求**：一个事件、三条状态、三个问题（要不要反应、交给谁、紧急度），约 222 token。

**每 1 万次初筛的花费**（价格取自 model-bank，JEV 见 §15.1）：

| 方案 | 美元 |
| --- | --- |
| gpt-5-nano | 1.41 |
| gemini-2.5-flash-lite | 2.21 |
| gpt-5-mini | 7.03 |
| claude-haiku-4-5 | 23.61 |
| **JEV** | **0.09** |

### 17.6 JEV 网络基线

从本容器（出站经过代理）向 `POST /v1/systemone` 发 25 次不带 key 的请求，只测网络和鉴权层：

| 指标 | 数值 |
| --- | --- |
| 首次（冷连接） | 233ms |
| 热连接 p50 | 75ms |
| 热连接 p90 | 79ms |
| 最小值 | 72ms |
| 最大值 | 171ms |

---

## 18. 能力矩阵：AIRI、apeira、pi

对比对象：AIRI 取 `main@07c6353`（core-agent 与 stage-ui）。apeira 取 npm `@apeira/core`、`@apeira/session`、`@apeira/storage` 0.0.8。pi 取 npm `@earendil-works/pi-agent-core` 与 `pi-coding-agent` 0.99.2。apeira 跑过步数测试（验证报告 §7），pi 的判断来自类型声明、源码和包内文档。

图例：✅ 已具备，⚠️ 部分具备或有前提，❌ 没有。

| 能力 | AIRI | apeira 0.0.8 | pi 0.99.2 |
| --- | --- | --- | --- |
| 定位 | AI VTuber 运行时，Agent 逻辑在 core-agent | stream-first 通用 Agent 运行时，与 AIRI 同属 moeru-ai | 终端编码 Agent，底层是通用 agent core 与 harness |
| 成熟度 | 已在生产使用 | ⚠️ README 写明 “A complete rewrite is being planned” | ✅ npm 在 2026-09-30 仍有更新 |
| 运行环境 | ✅ 浏览器、Electron、Capacitor | ✅ Node、浏览器、Edge（按文档） | ⚠️ 以 Node 为主。浏览器要经后端 proxy |
| LLM 抽象 | xsAI + provider-inference，支持 Chat 与 Responses | xsAI | 自有的 pi-ai，封装各家 SDK |
| 流式事件 | ✅ `StreamEvent` + hooks | ✅ `ReadableStream<AgentEvent>` | ✅ 从 `agent_start` 到 `agent_end` 的完整事件 |
| 并发 | ❌ 全局单队列（§17.2） | ✅ 每个 agent 一条队列。没有全局并发控制 | ✅ 多个命名 lane，每个 lane 一个会话，operation 有准入 |
| 运行中插话 | ❌ 新输入只能排队 | ✅ 运行中 `send()`，在下一步边界注入（实测） | ✅ `steer` 和 `followUp` 两种队列 |
| 中断与取消 | ⚠️ 只在会话重置时 abort。重新入队有重复 user turn（B12） | ✅ `interrupt`、`abort` | ✅ `abort`。终态分为 completed、declined、aborted、failed |
| 步数上限 | ✅ 10 步 | ❌ 没有上限，实测跑到 500 步被手动中止 | ✅ `finishTurn` + tool 结果的 `terminate` 提示 |
| 重试 | ⚠️ 不兼容时降级重试一次 | ❌ | ✅ 重试策略（`maxAttempts`、退避） |
| 历史模型 | 线性消息 + `generationTranscript` | append-only entry，带 `parentId` | 会话树：message、compaction、branch_summary、custom |
| 分支与 fork | ⚠️ `forkSession` 只复制前缀，不记来源 | ✅ git 式的 refs、checkout、fork、rebase、clone | ✅ 分支、`/tree` 导航、分支摘要 |
| 持久化 | ✅ IndexedDB + 云同步 | ⚠️ mem、none、json、jsonl、kv | ✅ JSONL，SQLite（独立包） |
| 崩溃后恢复 | ⚠️ 已输出部分标为 `interrupted` | ❌ | ✅ checkpoint + `resume()` |
| 上下文压缩 | ❌ 原语存在但没有启用 | ⚠️ 有 `transformEntries` 钩子，没有内置策略 | ✅ 内置，溢出时自动压缩 |
| 子 Agent | ❌ 只能给外部模块发 `spark:command` | ✅ `asTool(agent)`、`fork(agent)` | ⚠️ 核心不内置，示例用独立进程 |
| 按请求切换模型 | ⚠️ `resolveStep` 已合入，没有调用方 | ⚠️ xsAI 的 `prepareStep` | ✅ virtual model router，路由状态存在会话分支上 |
| classifier 与 JEV | ❌ | ❌ | ✅ classifier 是一种模型类型，JEV 可经 5 个渠道接入 |
| tool 钩子 | ⚠️ 只有 chat 生命周期 hooks | ✅ `preToolCall`、`postToolCall` | ✅ `beforeToolCall`、`afterToolCall`，可以阻断 |
| MCP | ✅ tamagotchi 主进程 + stage-ui 的 MCP tools | ⚠️ 文档称以插件提供，包里没找到 | ✅ `pi-mcp` + codemode |
| 插件与扩展 | ✅ plugin-sdk extension host | ✅ `AgentPlugin` | ✅ extensions、skills、prompt templates |
| 长期记忆 | ❌ | ❌ | ❌ |
| 共享池 | ⚠️ `ContextRegistry`，全局且没有预算 | ❌ | ❌ |
| 跨进程协议 | ✅ plugin-protocol + server-runtime | ❌ | ⚠️ RPC 模式；chord（实验性） |
| 人格与形象 | ✅ 角色卡（prompt、声音、模型、形象） | ⚠️ 只有 `agentName`、`userDescription` | ❌ |
| 心情 | ⚠️ 只有 ACT 标记 | ❌ | ❌ |
| 调度与准入 | ❌ | ❌ | ⚠️ 单个 lane 内有准入，没有跨 lane 调度 |
| 许可 | MIT | MIT | MIT |

**三点判断：**

1. **执行层的缺口，别人已经解决了**。多队列、插话、重试、恢复、压缩、按请求路由，pi 都有成熟设计，apeira 也覆盖了一部分。AIRI 借鉴设计，不自己发明：
   - 借鉴 pi：lane 与 operation 的准入和终态、带状态的 virtual model router、classifier 作为独立模型类型、一轮内不换模型。
   - 借鉴 apeira：插话语义、git 式的 session refs。
2. **认知层三方都没有**：调度器、长期记忆、共享池、人格可见性、心情。这些 AIRI 必须自己建，也是这个方向的独特价值。
3. **不替换运行时**：
   - pi-ai 与 xsAI 是两套 provider 栈，AIRI 的 provider-inference、计费网关和 native continuation 都建在 xsAI 上。
   - pi 以 Node 为主，AIRI 要跑在浏览器和手机上。
   - apeira 同源同栈，最容易合流，但它正在重写，而且没有步数上限。

---

## 19. 风险

| ID | 风险 | 严重度 | 证据 | 对策 |
| --- | --- | --- | --- | --- |
| R1 | 对话 Agent 的历史和用户实际听到的不一致 | 高 | §10.5：打断时取消事件只送到 IO 追踪 | 播放截断点回写历史 |
| R2 | 花费随 Agent 数量线性增长，没有预算闸门 | 高 | §13.3：同一场景每小时 0.27–9.02 美元 | 每小时预算、按紧急度降档、prompt cache、合并 |
| R3 | 共享池膨胀 | 高（已发生） | §17.3：每小时 2.6 万 token | 预算、过期时间、按读者过滤，append-self 只允许白名单槽 |
| R4 | 对话 Agent 成为所有状态的汇聚点，上下文重新膨胀 | 高 | §17.3 | 状态写进可覆盖的槽，不追加进历史（§10.3） |
| R5 | 长会话恢复的 token 成本 | 高 | §17.4：2000 条消息 7.7 万 token | dormant 时生成摘要，恢复前压缩 |
| R6 | JEV 被不可信文本注入 | 高 | 验证报告 §1.5：天真写法 4 个里被劫持 2 个，置信度 0.93 | 分字段、来源信任上限、JEV 永不单独授权 |
| R7 | 低信任来源的说法被写进长期记忆 | 高 | §16.2：Discord 陌生人的发言以 user 身份进入会话 | 出处与信任门槛，写入需要调度器批准 |
| R8 | 中止重试产生重复的 user turn | 高 | B12 | 按运行回滚的 API（§7.3） |
| R9 | 结果默认对所有读者可见，跨场景泄露 | 高 | B13 | 默认可见范围来自绑定 |
| R10 | 紧急事件经对话 Agent 转述，发声延迟叠加 | 中 | §10.4：初筛、生成、可选的口语化改写、TTS 串联 | 默认直接口语输出，改写按需触发，高紧急度作为插话推送 |
| R11 | 心情驱动的表情来回跳 | 中 | JEV 输出有 ±0.04 抖动，且与 ACT 标记争夺控制 | 代码平滑与衰减。心情管慢变化，ACT 管瞬时表情（§11.6） |
| R12 | 自动选型缺质量信号，选到能力够但质量差的模型 | 中 | §13.1 | 用户标档位，JEV 判断难度，后续引入评测 |
| R13 | 主窗口隐藏后调度器停摆 | 中 | 验证报告 §6.1：隐藏 5 分钟后定时器几乎停止 | `backgroundThrottling: false`，中期移到主进程 |
| R14 | JEV 在中文和日文上只有小样本数据 | 中 | 每种语言 16 条 | 用几百条真实事件复测，置信度不足时回退先验 |
| R15 | 云依赖与隐私 | 中 | JEV 只有云端服务 | 脱敏，JEV 不可用时回退先验 |
| R16 | 调度器变成新的单体 | 中 | §16.1：领域知识已经漏进 chat store | manifest 的 `cognition` 块，“新增模块时调度器零改动”规则 |
| R17 | 并行运行增多后难以调试 | 中 | B11 | 贯通 `runId`、`parentRunId`，接入 `contextObservability` |
| R18 | 外部运行时不成熟 | 中 | apeira 宣布重写，没有步数上限 | 只借鉴设计，不引入依赖 |
| R19 | 切换模型导致 prompt cache 失效 | 低 | pi 文档明确提醒 | 一轮内不换模型，只在 turn 边界切换 |
| R20 | 在项目早期过度设计 | 中 | 原型里大部分机制在小规模时就够用（验证报告 §4） | 先做 P0–P2 和对话 Agent 链路，动态图往后放 |

---

## 20. 演进路径

每一步都能单独合入，也都先修一个真实的 bug。

| 阶段 | 内容 | 顺带解决 | 改动范围 |
| --- | --- | --- | --- |
| **P0 纠偏** | registry 按 `destinations/lane` 过滤，加过期时间和总预算，默认可见范围来自绑定。外部来源自动创建 meta（Discord 的 sessionId 变成绑定）。`forkSession` 记录 `parentSessionId`。spark ticker 收归 synced leader。`context-providers/minecraft.ts` 的领域文案移回 Minecraft 模块。主窗口设 `backgroundThrottling: false` | B2、B5、B6、B10、B13 | core-agent registry、session-store、character-orchestrator、tamagotchi 主窗口 |
| **P1 会话** | 扩展 `ChatSessionMeta`（kind、personaId、bindings、status、digest）。按绑定恢复。运行表，贯通 `runId` | B11 | stage-ui 类型、session-store、orchestrator |
| **P2 多队列运行时** | 每个会话一条队列，并发数由每小时预算控制。foreground 只服务可见会话。从 `Brain` 抽出 `RunSupervisor`。按运行回滚的中止 API | B1、B12 | core-agent runtime，chat facade 适配 |
| **P3 调度器** | character-orchestrator 升级为调度器：统一任务入口、紧急度先验映射、合并与丢弃、控制权。JEV 两段式初筛，spark-notify agent 作为 LLM 回退。`module:announce` 加可选的 `cognition` 块。chat 的 `spark_command` 工具收进准入层 | B7（第一批） | core-agent 新模块 + stage-ui 适配 |
| **P4 对话 Agent 链路** | 状态槽、播放截断点回写、按需口语化、插话、输入归属。Discord 语音频道改为对话 Agent 的输出设备 | R1、R4、R10 | stage-ui speech、chat、discord-bot |
| **P5 模型路由** | 模型档案聚合 + requirements + `resolveStep` 接入。用户标档位。consciousness 降为默认档 | B3 | provider-inference、stage-ui |
| **P6 心情 Agent** | JEV 情绪问题 + PAD 计算 + 平滑与衰减 + 映射到 `setEmotion`。`pitch` 和 `rate` 改成可以逐句设置 | R11 | 新模块、stage-ui speech、stage-ui-three |
| **P7 Prompt 配方** | 把 `streamWithStageAdapters` 里的组装逻辑抽成配方组装器。启用 `history-block` 压缩并导出 compaction。身份不再快照进会话 | B4、B8、B9 | core-agent messages、chat facade |
| **P8 长期记忆** | 客户端长期记忆 + 出处 + 可见性标签 + 回写管线 + 输出检查 | §8、§12 | 新包 + memory-pgvector |
| **P9 人格切换** | 每个人格的会话和心情状态保存与恢复。`activeCard` 只给 UI 用 | §12.3 | airi-card、组装器 |
| **P10 动态图与外部 Agent** | `parentRunId` 驱动的派生与结果传递。Minecraft Brain、satori 等通过 `spark:*` 接入统一的运行约定 | B7（其余） | 协议扩展 |

P0–P2 不改变任何产品行为。做完以后，“动态 Agent”就只剩调度策略这一件事。

---

## 21. 待决定的问题

每个问题后面是基于实测的建议。

| # | 问题 | 建议 | 依据 |
| --- | --- | --- | --- |
| 1 | 哪些决策交给 JEV，是否接受它作为云端依赖，事件内容发给第三方是否符合隐私承诺 | 交给它：要不要反应、交给谁（两段式）、恢复还是新建、记不记忆、模型档位、共享池准入、心情。人格泄露检查只做第二道防线。紧急度只用来排序。`state` 脱敏 | §15.2，验证报告 §1 |
| 2 | 调度器的宿主 | 短期放桌面 renderer leader，并关掉主窗口的后台节流。中期移到主进程。手机和网页只当客户端 | §5.4，验证报告 §6 |
| 3 | 长期记忆存在哪里 | 客户端优先：IndexedDB + 内存暴力检索。embedding 模型按多语言实测选。云端只做可选同步 | §8.1，验证报告 §5 |
| 4 | 人格可见性的默认值，用户能否在 UI 里查看和修改 | 按 §12.2 的默认值。UI 编辑放在 P8 之后 | §12.2 |
| 5 | 自动写入记忆的门槛 | JEV `noul` ≥ 0.8 且来源可信，两条同时满足才自动写，其余进待确认区 | §8.3 |
| 6 | 每小时预算的默认值和降级顺序 | 不设并发上限，设每小时预算。降级顺序：降档、降频、合并，最后关低紧急度的 Agent | §13.3 |
| 7 | 直播的最小范围 | 先做“弹幕 → JEV 初筛 → 合并 → 解说 Agent”，不碰推流控制。弹幕按不可信文本处理 | 验证报告 §1.5、§4.1 S2 |
| 8 | 外部 Agent 的接入深度 | Minecraft Brain 保持自治，只通过 `spark:*` 协作。调度器只负责它上报事件的初筛和下行的控制权 | §3.4，验证报告 §4.1 S7 |
| 9 | Discord 会话的粒度 | 绑定按 `channelId` 取（discord.js 里 thread 也是 channel）。guild 只作为记忆的共享范围 | adapter 代码 |
| 10 | 模型质量档位的来源 | 初版由用户标档位，JEV 判断任务难度，在档位内按价格选。后续引入评测 | §13.3 |
| 11 | core-agent 是否与 apeira 合流 | 现在不合流。借鉴它的插话语义和 git 式 session refs | §18，验证报告 §7 |
| 12 | 心情维度的清单和每个人格的参数 | 先用 5 个维度（愤怒、沮丧、开心、紧张、无聊），参数在真实形象上调 | §11 |

---

## 附录 A：测试与数据

**行为验证**（B1、B2 的存在性证明）：两个临时测试放在 `packages/core-agent/src/runtime/` 下，跑完即删。2 个测试全部通过。

- 测试 1：game 会话的请求没有结束时，chat 会话的请求根本没有开始。
- 测试 2：两个 Discord 群的 append-self 通知都出现在主人私聊的 prompt 里。

**量化实测**（§17）：

- harness 源码：[`2026-09-30-cognitive-scheduler-bench.md`](./2026-09-30-cognitive-scheduler-bench.md)
- 原始数据：[`data/2026-09-30-cognitive-scheduler-bench.json`](./data/2026-09-30-cognitive-scheduler-bench.json)

**复现**：

1. 执行 `pnpm install --filter "@proj-airi/core-agent..."`。
2. build `stream-kit`、`server-shared`、`provider-inference`。
3. 在仓库外安装 `js-tiktoken`。
4. 按 harness 文件开头的说明，把它放进 core-agent 运行。

**其他实测**（JEV、共用语音、自动选型、调度器原型、记忆检索、Electron 节流、apeira）：代码和原始结果在 [`validation/`](./validation/)，说明见验证报告附录。

## 附录 B：没有验证的部分

- 对话 Agent 链路（状态槽、截断点回写、按需口语化）只有设计，没有原型。
- 心情 Agent 只有设计。JEV 对情绪这类主观判断的准确率没有实测，PAD 映射和平滑也没有原型。
- 输入归属没有单独实测。
- 自动选型的质量档位用价格代表，没有质量评测。
- JEV 在 TypeSafe 直连下的延迟和限流。现有数据经 OpenCode 代理测得。
- 所有 JEV 标注集都偏小（6–48 条），只能说明方向。
- B5 没有在真实 Discord 环境里复现。
- 多窗口时 leader 切换对正在执行的运行有什么影响。
- IndexedDB 读取大会话的耗时。
- `services/computer-use-mcp` 和 `airi-plugin-claude-code` 只看了入口，没有评估它们能否作为领域 Agent 接入。
- 服务端 `chat-ws` 的实时路由没有深入。调度器上云时要补这部分。
- pi 没有实际运行。

## 附录 C：外部来源

- TypeSafe JEV：[Respan](https://www.respan.ai/articles/what-is-the-jev-ai-model)、[Datacamp](https://www.datacamp.com/blog/system-one-models-jev)、[daleseo.com](https://daleseo.com/jev/)、[Portkey 文档](https://portkey.ai/docs/integrations/llms/typesafe)、[TanStack AI 适配器](https://tanstack.com/ai/latest/docs/adapters/typesafe)、[DataLearner](https://www.datalearner.com/en/ai-models/pretrained-models/jev)
- apeira：[moeru-ai/apeira](https://github.com/moeru-ai/apeira)、[文档站](https://apeira.moeru.ai/)，npm `@apeira/core`、`@apeira/session`、`@apeira/storage` 0.0.8
- pi：[badlogic/pi-mono](https://github.com/badlogic/pi-mono)，npm `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` 0.99.2（包内的 `docs/models.md`、`docs/virtual-models.md`、`docs/llama-cpp.md`、`examples/extensions/jev-router.ts`）
- 模型价格：仓库依赖 `model-bank@1.0.20260904203849`
- 移动端后台限制：Apple Developer Forums、Cordova issue 跟踪（见验证报告 §6.2）
