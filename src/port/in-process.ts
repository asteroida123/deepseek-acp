/**
 * `HarnessPort` 的进程内实现：直接消费 dsh 的接口级服务。
 *
 * 只用接口级服务（`ctx.agents` 及事件），不依赖具体的 agent loop——这保持了
 * 上游对 UI/客户端驱动型插件的依赖方向约定。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// `model-selection` 由包根 re-export（`export * from './model-selection.ts'`），
// 没有 `./model-selection` 子路径导出。
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { ReasoningEffortId, createUserMessage, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// 侧效应类型导入：把 `sessionPersistence` 合并到 Context 的服务表上。本 port
// 只 inject `agents`，持久化通过 `ctx.get` 走可选路径；没有这行 `get` 的返回
// 值是 any，下面的 header 映射会静默失去类型检查。
import type {} from '@deepseek-ai/dsh-session-persistence'
// 这个不是纯类型导入：`foldSessionTitle` 是个不依赖服务的纯函数，日志里没有
// 标题事件时它返回 undefined，因此组合没挂标题服务时照样安全。
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
// 同样是侧效应类型导入：命令面与 plan mode 都是**可选**组合件，只经 `ctx.get`
// 取用；没有这两行，`get` 的返回值退化成 any，下面的窄化就静默失去类型检查。
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-plan-mode'
// 技能注册表同样是可选组合件。这一行**不是**纯类型导入：`isUserInvocable` 是个
// 读 `invocation.userInvocable` 的纯函数谓词，自己判等于把上游的策略规则抄一遍。
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as FsTool from '@deepseek-ai/dsh-tool-fs'
import { mountSessionFs, type ClientTextReader } from '../composition/session-fs.js'
import { WORKSPACE_ORDER, WORKSPACE_SECTION, localDate, renderWorkspace } from '../composition/workspace.js'
import { mountMcpServers } from '../mcp/mount.js'
import type { McpMountSpec } from '../mcp/spec.js'
import type {
  AgentHandle,
  CommandPlane,
  HarnessPort,
  ModePlane,
  SessionCatalog,
  SessionControls,
  SessionSummary,
  SkillPlane,
} from './types.js'

/** 本插件需要注入的服务名。 */
export const REQUIRED_SERVICES = ['agents'] as const

/**
 * `session/list` 折标题时同时读取的日志条数上限。
 *
 * 不设上限会在会话多的机器上一次性打开成百上千个文件句柄；设成 1 又会让列表
 * 变成串行 IO。
 */
const LIST_READ_CONCURRENCY = 8

/**
 * 技能发现的等待上限（毫秒）。
 *
 * 本项目默认只挂本地提供方（读几个目录，毫秒级），这个上限对它形同不存在。它挡的
 * 是宿主自己 `registerProvider` 进来的远程源：注册表**会**把 `signal` 透传给提供方
 * 并在取消后停止等待，所以超时能把「会话永远打不开」降级成「这一次列表里没有技能」。
 *
 * 数值取 2 秒：斜杠补全的目录是打开会话时算的，用户此刻在等界面，再久就该先给他
 * 一个能用的会话。
 */
const SKILL_DISCOVERY_TIMEOUT_MS = 2_000

/**
 * 技能描述在**斜杠补全里**的长度上限。
 *
 * `SkillSummary.description` 本身没有上限——`dsh-tool-skill` 那个 500 字的上限只
 * 作用于模型侧目录渲染，管不到这里。frontmatter 里写一整段的技能是存在的（本机
 * `~/.agents/skills` 里就有），原样塞进下拉框会把列表撑坏。
 */
const SKILL_DESCRIPTION_MAX = 120

/**
 * 单行化并截断到 `max` 个**码位**。
 *
 * 按码位而非 `.length` 切：后者切的是 UTF-16 码元，正好落在代理对中间时会产出半个
 * 字符，客户端那边显示成替换符。中文全在 BMP 里察觉不到，emoji 一试就现形。
 *
 * 先把换行折成空格：frontmatter 的 `description` 允许多行，而这个值要进的是下拉框
 * 的一行。
 * @param text - 原文
 * @param max - 上限（含省略号）
 * @returns 单行、不超过 max 个码位的文本
 */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const points = [...flat]
  if (points.length <= max) return flat
  return `${points.slice(0, max - 1).join('')}…`
}

/**
 * 带并发上限的 map，保持输入顺序。
 * @param items - 输入
 * @param limit - 同时进行的任务数上限
 * @param fn - 每项的处理函数
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * 会话建立时的模型选择。
 *
 * provider 缺失时整个 ref 留空：没有 provider 的选择无法路由，装上去只会在
 * 下一步把请求送进空处。此时模型配置项也不会 advertise。
 * @param provider - provider 路由
 * @param model - 模型 id
 */
function initialSelection(provider: string | undefined, model: string | undefined): ModelSelectionRef {
  return {
    current: provider !== undefined && model !== undefined ? { provider, model } : undefined,
    assembled: undefined,
  }
}

/**
 * 基于 Cordis context 构造进程内 port。
 * @param ctx - 已注入 `agents` 的插件 context
 */
export function createInProcessPort(ctx: Context): HarnessPort {
  // ACP 处理器在本插件的注入作用域之外执行，故在 apply 期捕获服务，
  // 而不是在回调里惰性读取。
  const agents = ctx.agents
  // 工具注册表是可选的：本插件只 inject `agents`，读一个未注入的服务在 Cordis
  // 下会抛错，所以走 `get` 这条明确的可选路径。
  const tools = ctx.get('tools')
  const persistence = ctx.get('sessionPersistence')
  const commandRuntime = ctx.get('commands')
  const planMode = ctx.get('planMode')
  const skillRegistry = ctx.get('skills')

  /** 会话工作区那一段；新建与恢复共用，两条路径的上下文必须一致。 */
  const workspaceSection = (agentCtx: Context, cwd: string | undefined): void => {
    // 宿主组合可能没挂 systemPrompt——本 port 只声明依赖 `agents`，
    // 缺席时安静跳过而不是让建会话失败。
    if (cwd === undefined) return
    agentCtx.systemPrompt?.section({
      name: WORKSPACE_SECTION,
      order: WORKSPACE_ORDER,
      text: renderWorkspace({ cwd, platform: process.platform, date: localDate(new Date()) }),
    })
  }

  /**
   * 会话作用域的完整装配。
   *
   * `async` 且返回 `void`：工厂会对 setup 的返回值调 `.commit()`，直接把
   * Promise 交回去会崩（约束 C3，TC-CONTRACT-02 守护）。
   *
   * `selection` 由调用方在 create 之前建好并传进来：装配发生在工厂内部，
   * 而 bridge 需要在会话建成之后**长期持有**这个 ref 才能切模型。
   */
  const setupSession =
    (
      cwd: string | undefined,
      mcpServers: readonly McpMountSpec[] | undefined,
      selection: ModelSelectionRef,
      readDelegate: ClientTextReader | undefined,
    ) =>
    async (agentCtx: Context): Promise<void> => {
      workspaceSection(agentCtx, cwd)
      // 装到 agent 作用域：切换在**下一步**进入 prompt 装配时生效，不会把
      // 正在跑的那一步劈成两半（一半用旧模型的提示词、一半发给新模型）。
      installModelSelection(agentCtx, selection)
      // 文件工具也装在这里（US-25）：它是唯一读 `ctx.fs` 的插件，而它捕获
      // 自己的挂载 context，所以只有装在会话作用域，读改道才可能生效。
      await mountSessionFs(agentCtx, FsTool, readDelegate)
      if (mcpServers !== undefined && mcpServers.length > 0) {
        await mountMcpServers(agentCtx, mcpServers, McpClient)
      }
    }

  /** 一次成功解析的模型元数据；`undefined` 表示解析过但拿不到。 */
  type ResolvedModel = LlmResolvedModelInfo | undefined

  /**
   * provider/model → 已解析的模型元数据。**键存在即「解析已完成」**，值为
   * `undefined` 表示解析失败或适配器没给——与「还没解析」（键不存在）是两回事：
   * 前者不该反复重试。
   *
   * 键的分隔符写成 U+0000 转义而非裸字节：NUL 拼不出歧义（provider/model 的 id
   * 里不可能有），但源码里躺一个不可见控制字符会让 grep 把整个文件当二进制跳过
   * ——那正是它被发现的方式。
   */
  const resolved = new Map<string, ResolvedModel>()
  /** 同一路由的在途解析，供需要**等**结果的调用方复用，避免并发重复请求。 */
  const resolving = new Map<string, Promise<ResolvedModel>>()

  const routeKey = (provider: string, model: string): string => `${provider}\u0000${model}`

  /** 起一次解析，或复用在途的那次。 */
  const resolveModel = (provider: string, model: string): Promise<ResolvedModel> => {
    const key = routeKey(provider, model)
    const inflight = resolving.get(key)
    if (inflight !== undefined) return inflight
    if (resolved.has(key)) return Promise.resolve(resolved.get(key))
    const llm = ctx.get('llm')
    if (llm === undefined) {
      resolved.set(key, undefined)
      return Promise.resolve(undefined)
    }
    const task = llm
      .resolveModelInfo(provider, model)
      .then(
        (info): ResolvedModel => info,
        // 失败也记住：适配器没有目录条目、或解析要走网络而网络不通时，
        // 每次都重试是纯粹的浪费，而结果不会变好。
        (): ResolvedModel => undefined,
      )
      .then((info) => {
        resolved.set(key, info)
        resolving.delete(key)
        return info
      })
    resolving.set(key, task)
    return task
  }

  /**
   * **同步**取上下文窗口，未命中时顺手起一次解析并先返回 undefined。
   *
   * 只有这一处非同步不可：用量上报走的是事件映射那条纯同步链。其余读元数据的
   * 地方（配置项组装）本来就是 async 的，直接 await {@link resolveModel} 更准，
   * 不必忍受「缓存没热就先不报」。
   */
  const contextWindowOf = (provider: string, model: string): number | undefined => {
    const key = routeKey(provider, model)
    if (resolved.has(key)) return resolved.get(key)?.context?.contextWindow
    void resolveModel(provider, model)
    return undefined
  }

  /**
   * 组装单会话控制面。
   * @param agent - 该会话的 agent
   * @param selection - 与 agent 作用域绑定的模型选择 ref
   */
  const controlsFor = (agent: Agent, selection: ModelSelectionRef): SessionControls => {
    /** 读当前选择的窗口；顺带把未命中的解析起起来。 */
    const windowNow = (): number | undefined => {
      // 读的是**当前**选择：会话内换了模型，窗口大小要跟着换，否则用量条的
      // 分母还停在旧模型上——那种错误看起来完全正常。
      const current = selection.current
      return current === undefined ? undefined : contextWindowOf(current.provider, current.model)
    }
    // 建会话时先热一次：否则本会话第一条 `assistant/message` 必然读到空缓存，
    // 用量要等到第二轮才出现。
    windowNow()

    return {
      model: () => selection.current?.model,
      contextWindow: windowNow,
      reasoningEffort: () => selection.current?.reasoningEffort,
      setModel: (model: string) => {
        const current = selection.current
        // provider 保持不变：ACP 的模型下拉是**在当前 provider 内**选择，换 provider
        // 是另一件事（`session/set_provider`，尚未实现）。丢掉 provider 会让下一步
        // 路由不到任何适配器。
        //
        // **推理档位一并清空**：词表随模型变（有的路由只剩 `off`）。留着旧模型
        // 的选择，`LlmRuntime` 会在下一次请求里抛 `UNSUPPORTED_REASONING_EFFORT`
        // ——它校验有效档位在新词表里。也就是说不清空的后果是一次响亮的失败，
        // 不是静默走偏；清空把它变成一次平滑的重置，回到新模型的默认档，这正是
        // 上游对「未选中档位」的定义。
        selection.current = current === undefined ? undefined : { provider: current.provider, model }
        // 换模型同样要热：新模型的窗口没解析过，不热的话切换后第一轮的用量条
        // 会整条消失，看起来像功能坏了。
        windowNow()
      },
      setReasoningEffort: (effort: string) => {
        const current = selection.current
        // 没有选择 ref 就无处安放（缺 provider 的会话，档位项也不会 advertise）。
        if (current === undefined) return
        selection.current = { ...current, reasoningEffort: ReasoningEffortId(effort) }
      },
      sandboxMode: () => {
        const policy = ctx.get('sandboxPolicy')
        if (policy === undefined) return undefined
        return policy.overrideOf(agent.session) ?? policy.defaultMode
      },
      setSandboxMode: (mode: string) => {
        // 组合没挂 sandboxPolicy 时不该走到这里——该配置项根本不会 advertise。
        if (ctx.get('sandboxPolicy') === undefined) return
        // 写进**会话日志**而非内存：模式因此随 `session/load` 一起恢复，
        // 而不是恢复出一个看起来一样、实际权限被悄悄放宽或收紧的会话。
        setSandboxMode(agent.session, mode as SandboxMode)
      },
    }
  }

  const catalog: SessionCatalog | undefined =
    persistence === undefined
      ? undefined
      : {
          async list(): Promise<SessionSummary[]> {
            const headers = await persistence.list()
            // header 里没有标题，也没有「最后活动时间」，两者都只能从日志折出来
            // ——于是列表要把每条日志读一遍。这是有代价的，但会话选择器不给标题
            // 就只剩一串 id，那正是这个功能唯一要回答的问题。并发有上限，
            // 单条读失败不影响其余条目。
            return await mapWithLimit(headers, LIST_READ_CONCURRENCY, async (header) => {
              const base = { sessionId: header.id, cwd: header.cwd, createdAt: header.createdAt }
              try {
                const { events } = await persistence.inspect(header.id)
                return {
                  ...base,
                  title: foldSessionTitle(events)?.title,
                  updatedAt: events.at(-1)?.time,
                }
              } catch {
                // 日志损坏或读不到：仍然列出这个会话（用户可能想去恢复它），
                // 只是没有标题。整份列表不该因为一条坏日志而失败。
                return { ...base, title: undefined, updatedAt: undefined }
              }
            })
          },
          async events(sessionId: SessionId): Promise<readonly SessionEvent[]> {
            // `inspect` 而非 `load`：后者会对中断的尾回合提交冷恢复（写盘）。
            // 只是要把历史念给客户端听，不该顺手改动日志。
            const inspection = await persistence.inspect(sessionId)
            return inspection.events
          },
        }

  const commands: CommandPlane | undefined =
    commandRuntime === undefined
      ? undefined
      : {
          list(agent: Agent) {
            return commandRuntime.list(agent).map((command) => ({
              name: command.name,
              description: command.description,
              hint: command.input?.hint,
            }))
          },
          async run(agent: Agent, line: string, signal: AbortSignal) {
            // 第三个参数是随这一行命令提交的图片。恒空：ACP 的 prompt 目前只走文本
            // （`promptCapabilities.image` 报 false），命令面自然也没有图片可带。
            // 上游对空批次有专门的常量（`NO_ATTACHMENTS`），不会因此进入附件准入路径。
            const execution = await commandRuntime.execute(agent, line, [], signal)
            // 语法不符或名字未注册 —— 上游此时什么都没记进日志，本就该当成普通文本。
            if (execution === undefined) return undefined
            return { ok: execution.result.kind === 'success', text: execution.result.text }
          },
          onChange(sink: () => void) {
            return ctx.on('commands/change', sink)
          },
        }

  const skills: SkillPlane | undefined =
    skillRegistry === undefined
      ? undefined
      : {
          async list(agent: Agent, cwd: string | undefined) {
            // 有界等待：见 SKILL_DISCOVERY_TIMEOUT_MS。`AbortSignal.timeout` 的定时器
            // 是 unref 的，不会把进程留住。
            const signal = AbortSignal.timeout(SKILL_DISCOVERY_TIMEOUT_MS)
            let summaries
            try {
              // `scope` 传 agent 而非省略：技能与工具一样分层，省略只读全局层，
              // 会漏掉挂在这个 agent 组合里的那些。传错 scope 不报错，只少东西。
              summaries = await skillRegistry.list({ scope: agent, signal, ...(cwd === undefined ? {} : { cwd }) })
            } catch (error: unknown) {
              // 超时、取消、提供方炸了——都退化成「这一次没有技能」。斜杠补全少几项
              // 是可以接受的，建会话失败不是。
              ctx.logger?.warn?.(`skill discovery failed: ${String(error)}`)
              return []
            }
            return summaries.filter(isUserInvocable).map((skill) => ({
              name: skill.name,
              description: truncate(skill.description, SKILL_DESCRIPTION_MAX),
            }))
          },
          onChange(sink: () => void) {
            return ctx.on('skills/change', sink)
          },
        }

  const modes: ModePlane | undefined =
    planMode === undefined
      ? undefined
      : {
          get: (agent: Agent) => {
            const state = planMode.get(agent)
            return { active: state.active, pending: state.pending }
          },
          // 上游返回 committed / queued / cancelled / noop 四种结果，这里一律丢弃：
          // ACP 的模式选择器没有「待生效」这个态，能表达的只有当前是哪个模式。
          set: (agent: Agent, active: boolean) => {
            planMode.set(agent, active)
          },
        }

  return {
    tools,
    catalog,
    commands,
    skills,
    modes,
    sandboxModes: ctx.get('sandboxPolicy') === undefined ? [] : SANDBOX_MODES,
    async listModels(provider: string) {
      const llm = ctx.get('llm')
      if (llm === undefined) return []
      try {
        return (await llm.listModels(provider)).map((m) => ({ id: m.id, name: m.name ?? m.id }))
      } catch {
        // 目录取不到不该让建会话失败：模型配置项不 advertise 就是了，对话本身
        // 与「能不能列出别的模型」无关。
        return []
      }
    },

    async reasoningEfforts(provider: string, model: string) {
      // 这里**等**解析而不是读缓存：配置项组装本来就是 async 的，等一下换来的是
      // 「切模型之后档位列表立刻是新模型的」——读缓存则会在切换后的那一次应答里
      // 给出旧词表，而那正是用户马上要点的那个下拉框。
      const info = await resolveModel(provider, model)
      const reasoning = info?.reasoning
      if (reasoning === undefined) return { efforts: [] }
      return {
        efforts: reasoning.efforts.map((effort) => ({
          id: String(effort.id),
          name: effort.name,
          ...(effort.description === undefined ? {} : { description: effort.description }),
        })),
        ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: String(reasoning.defaultEffort) }),
      }
    },

    sessions: {
      async create({ sessionId, cwd, provider, model, mcpServers, readDelegate }): Promise<AgentHandle> {
        const selection = initialSelection(provider, model)
        const handle = await agents.create({
          sessionId,
          meta: { cwd },
          // 只带上确实存在的字段：agentOptions 的可选字段被显式赋 undefined
          // 与缺失并不等价。
          agentOptions: {
            ...(provider !== undefined ? { provider } : {}),
            ...(model !== undefined ? { model } : {}),
          },
          setup: setupSession(cwd, mcpServers, selection, readDelegate),
        })
        return {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          controls: controlsFor(handle.agent, selection),
        }
      },
      async resume({ sessionId, provider, model, mcpServers, readDelegate }) {
        const selection = initialSelection(provider, model)
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: {
            ...(provider !== undefined ? { provider } : {}),
            ...(model !== undefined ? { model } : {}),
          },
          // 工作区取自**日志里的 header**，不取请求参数：cwd 是不可变会话
          // 元数据，用请求里的那个会让恢复出来的会话在别的工作区跑历史。
          setup: async (agentCtx: Context) => {
            await setupSession(
              agentCtx.agent?.session.header.cwd,
              mcpServers,
              selection,
              readDelegate,
            )(agentCtx)
          },
        })
        return {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          controls: controlsFor(handle.agent, selection),
          cwd: handle.agent.session.header.cwd,
        }
      },
      isLive(agent: Agent): boolean {
        // 身份比对而非仅比 id：agent-loop 单独重载会释放其 agent，
        // 而 bridge 的会话记录可能仍存活，此时驱动一个已退休的 agent
        // 会被静默接受。
        return agents.get(agent.id) === agent
      },
    },

    events: {
      onSessionEvent(sink) {
        return ctx.on('session/event', (session, event: SessionEvent) => {
          const agent = agents.get(session.header.id)
          if (agent === undefined || agent.session !== session) return
          sink(agent, event)
        })
      },
      onInboxClaimed(sink) {
        return ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
          sink(agent, message.id, turn)
        })
      },
      onAgentError(sink) {
        return ctx.on('agent/error', ({ agent, turn, error }) => {
          sink(agent, turn, error)
        })
      },
    },

    driver: {
      prepare(text: string) {
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        return {
          messageId: message.id,
          submit: (agent: Agent): void => {
            agent.followup(message)
          },
        }
      },
      cancel(agent: Agent): void {
        agent.cancel({ kind: 'user' })
      },
      whenIdle(agent: Agent): Promise<void> {
        return agent.whenIdle()
      },
    },
  }
}
