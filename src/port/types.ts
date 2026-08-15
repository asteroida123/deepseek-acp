/**
 * 窄接口层：协议映射层与 dsh 进程内实现之间的唯一边界。
 *
 * 存在理由（架构 §七）：若上游 SDK 通道日后补齐 cancel 与反向请求，可替换本
 * 接口的实现而不动协议层与映射层。同时它也是 R1（上游漂移）的收敛点——契约
 * 测试只需针对这一层。
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ClientTextReader } from '../composition/session-fs.js'
import type { McpMountSpec } from '../mcp/spec.js'
import type { ToolLookup } from '../presentation/presenter.js'

/**
 * agent 句柄。
 *
 * **显式区分 `agent` 与句柄本身**：`ctx.agents.create()` 返回的是句柄，而工具
 * 注册表的 ScopeKey 是 `handle.agent`。传错对象不会报错，只会静默返回空集
 * （spike 结论 C2）。此处从类型上消除该误用。
 */
export interface AgentHandle {
  /** ScopeKey：所有 scope 查询与身份比对都用它 */
  readonly agent: Agent
  /** 幂等释放；resolve 时注册表、loop、持久化均已静默 */
  readonly dispose: () => Promise<void>
  /** 本会话的运行时控制面（US-16 / US-17） */
  readonly controls: SessionControls
}

/**
 * 单个会话的运行时控制面。
 *
 * 每一项都**只影响本会话**。模型走 agent 作用域的选择 ref（下一步生效，不打断
 * 正在跑的那一步）；沙箱模式落在会话日志里（因此随会话恢复而恢复）。
 */
export interface SessionControls {
  /** 当前模型 id；未设置时 undefined */
  model(): string | undefined
  /** 切模型；在下一步进入 prompt 装配时生效 */
  setModel(model: string): void
  /**
   * 当前模型的上下文窗口（token）；未知时 undefined。
   *
   * **同步读**：用量上报走的是事件映射那条纯同步链，而窗口大小要向适配器
   * 异步解析。因此这里读的是缓存，未命中时顺手起一次解析并先返回 undefined
   * ——调用方据此跳过这一条上报。解析是本地目录查表（毫秒级），而两次
   * `assistant/message` 之间隔着一整轮模型往返，所以实际上只有理论上的第一条
   * 会落空。
   */
  contextWindow(): number | undefined
  /**
   * 本会话显式选中的推理档位；没选过时 undefined（此时用适配器的默认）。
   */
  reasoningEffort(): string | undefined
  /**
   * 切推理档位；与切模型同样在下一步进入 prompt 装配时生效。
   */
  setReasoningEffort(effort: string): void
  /** 当前有效沙箱模式（会话覆盖 ?? 部署默认）；组合没挂 sandboxPolicy 时 undefined */
  sandboxMode(): string | undefined
  /** 切沙箱模式；没挂 sandboxPolicy 时为 no-op */
  setSandboxMode(mode: string): void
}

/** 会话生命周期。 */
export interface SessionLifecycle {
  /**
   * @param options.provider - provider 路由；缺失时 agent 无法组装请求
   * @param options.model - 模型 id；同上
   * @param options.mcpServers - 按会话挂载的 MCP server，已翻译为上游配置
   * @param options.readDelegate - 文本读改道到编辑器；`undefined` 表示全走磁盘
   */
  create(options: {
    sessionId: SessionId
    cwd: string
    provider?: string
    model?: string
    mcpServers?: readonly McpMountSpec[]
    readDelegate?: ClientTextReader
  }): Promise<AgentHandle>
  /**
   * 从持久化日志恢复一个已存在的会话。
   *
   * 与 {@link create} 不同，`cwd` 不是入参而是**日志里记着的事实**——工作区
   * 是不可变会话元数据。调用方拿到的 cwd 从返回值取，用请求里的那个去装配
   * 会让恢复出来的会话在另一个工作区里跑历史。
   */
  resume(options: {
    sessionId: SessionId
    provider?: string
    model?: string
    mcpServers?: readonly McpMountSpec[]
    readDelegate?: ClientTextReader
  }): Promise<AgentHandle & { readonly cwd: string | undefined }>
  /** 该 agent 是否仍在活注册表中且为同一对象（防同 id 冒充） */
  isLive(agent: Agent): boolean
}

/** 一条持久化会话的元数据摘要。 */
export interface SessionSummary {
  readonly sessionId: SessionId
  /** 会话创建时的工作区；日志里可能没有 */
  readonly cwd: string | undefined
  /** Unix 毫秒 */
  readonly createdAt: number
  /** 会话标题；组合没挂 `dsh-session-title`、或日志尚无标题时 undefined */
  readonly title: string | undefined
  /** 最后一条事件的时间（Unix 毫秒）；日志空或读不出来时 undefined */
  readonly updatedAt: number | undefined
}

/**
 * 已持久化会话的只读目录。
 *
 * 组合没挂持久化时整体为 undefined —— 那种部署里会话随进程消失，
 * `session/load` 与 `session/list` 都不该被 advertise。
 */
export interface SessionCatalog {
  /** 全部已落盘会话，不做截断 */
  list(): Promise<SessionSummary[]>
  /** 某会话的完整事件日志，按 seq 升序 */
  events(sessionId: SessionId): Promise<readonly SessionEvent[]>
}

/** 一条命令的发现元数据。 */
export interface CommandInfo {
  /** 不带前导斜杠的命令名 */
  readonly name: string
  readonly description: string
  /** 自由文本输入的占位提示；命令不收输入时 undefined */
  readonly hint: string | undefined
}

/** 一条命令的执行结果。 */
export interface CommandOutcome {
  readonly ok: boolean
  /** 直接呈现给用户的文本；命令无话可说时 undefined */
  readonly text: string | undefined
}

/**
 * 人类命令面（US-18）。
 *
 * 组合没挂命令注册表时整体为 undefined —— 那种部署里 `/` 开头的输入就是普通
 * 文本，原样送给模型。
 */
export interface CommandPlane {
  /** 该 agent 可见的命令，已应用作用域遮蔽 */
  list(agent: Agent): readonly CommandInfo[]
  /**
   * 执行一行 slash 命令。
   * @returns 结果；**语法不符或命令名未注册时返回 undefined**，调用方据此
   *   回退到模型——用户打的 `/usr/bin/env 是什么` 不该被当成命令吞掉
   */
  run(agent: Agent, line: string, signal: AbortSignal): Promise<CommandOutcome | undefined>
  /** 注册表变更订阅；返回取消订阅函数 */
  onChange(sink: () => void): () => void
}

/**
 * 会话模式面（US-19）。
 *
 * 只有 plan 这一个协作状态，因此这里是布尔而非任意模式名——ACP 侧的
 * `default` / `plan` 词表由 bridge 拥有（见 config/modes.ts）。组合没挂
 * plan-mode 时整体为 undefined，此时不 advertise `modes`，`session/set_mode`
 * 也直接拒绝。
 */
export interface ModePlane {
  /**
   * @returns `active` 是日志里记着的状态；`pending` 是尚未落实的选择
   *   （回合进行中切换时，要等下一个被接受的步骤边界才写进日志）
   */
  get(agent: Agent): { readonly active: boolean; readonly pending: boolean | undefined }
  set(agent: Agent, active: boolean): void
}

/** 会话事件订阅。 */
export interface EventSource {
  /**
   * 订阅全部会话事件。回调需自行按 agent 解复用。
   * @returns 取消订阅函数
   */
  onSessionEvent(sink: (agent: Agent, event: SessionEvent) => void): () => void
  /** 某条入队消息被认领为某个回合时触发，用于 prompt↔turn 相关性 */
  onInboxClaimed(sink: (agent: Agent, messageId: string, turn: number) => void): () => void
  /** 回合级模型错误 */
  onAgentError(sink: (agent: Agent, turn: number, error: unknown) => void): () => void
}

/** 驱动单个 agent。 */
export interface AgentDriver {
  /**
   * 构造一条用户消息但**不入队**。
   *
   * 分两步是必须的：in-flight 槽位要在入队前武装（监听器驱动的同步回合可能
   * 在入队调用返回前就跑完），而武装时就需要 messageId 才能建立相关性。
   */
  prepare(text: string): { readonly messageId: string; readonly submit: (agent: Agent) => void }
  cancel(agent: Agent): void
  /** 整体静默（非单个回合结束）—— prompt 的正确结算点 */
  whenIdle(agent: Agent): Promise<void>
}

/** 协议层可见的全部宿主能力。 */
export interface HarnessPort {
  readonly sessions: SessionLifecycle
  readonly events: EventSource
  readonly driver: AgentDriver
  /**
   * 工具定义查询，供呈现层读取工具自己声明的卡片。
   *
   * 组合里没挂工具注册表时为 undefined——那种部署只有对话，工具事件根本不会
   * 出现，此时强制要求这个服务只会把 bridge 变得更难嵌入。
   */
  readonly tools: ToolLookup | undefined
  /**
   * 已持久化会话的目录；组合没挂持久化时为 undefined。
   *
   * `initialize` 的能力声明直接读它：advertise 与实现必须严格一致，声明了
   * `loadSession` 却没有持久化，客户端会在恢复时拿到一个无从解释的错误。
   */
  readonly catalog: SessionCatalog | undefined
  /** 人类命令面；组合没挂命令注册表时 undefined */
  readonly commands: CommandPlane | undefined
  /** 会话模式面；组合没挂 plan-mode 时 undefined */
  readonly modes: ModePlane | undefined
  /**
   * 该 provider 下可选的模型。
   *
   * 目录取不到（provider 未注册、适配器不支持枚举）时返回空数组：模型这个
   * 配置项随即不 advertise，好过给客户端一个空下拉框。
   */
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  /**
   * 某个 provider/model 的推理档位词表。
   *
   * **词表随模型变**（某些部署只剩 `off`），所以这是按路由查的、不是全局常量。
   * 这里可以异步：配置项组装本来就是 async 的，因此不必像上下文窗口那样忍受
   * 「缓存没热就先不报」——那边被同步的事件映射逼着只能读缓存。
   * @returns 档位与适配器默认；解析不出来时 efforts 为空
   */
  reasoningEfforts(
    provider: string,
    model: string,
  ): Promise<{ efforts: readonly { id: string; name: string; description?: string }[]; defaultEffort?: string }>
  /** 部署支持的沙箱模式词表；组合没挂 sandboxPolicy 时为空 */
  readonly sandboxModes: readonly string[]
}
