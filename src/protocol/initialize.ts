/**
 * `initialize` —— 版本协商与能力声明。
 *
 * **advertise 与实现必须严格一致**（验收标准 AC-G1 的延伸）：此处只声明
 * M1-a 真正实现了的能力。声明了却没实现，客户端会调用后失败。
 * @module
 */

import { PROTOCOL_VERSION, type InitializeRequest, type InitializeResponse } from '@agentclientprotocol/sdk'

/**
 * 服务端身份，固定字面量而非配置项。
 *
 * **必须与 `package.json` 的 `version` 一致**，且这是两处独立的字面量：`import`
 * 一个 JSON 会让构建产物的相对路径依赖包布局，不值得。一致性由
 * `tests/session.spec.ts` 的一条用例守着——codeg 注册自定义 agent 时按
 * `deepseek-acp@<版本>` 对账，两处一旦漂移，表现是编辑器里连不上而不是报错。
 */
export const AGENT_INFO = { name: 'deepseek-acp', version: '0.1.0' } as const

/**
 * 客户端是否支持 Zed 的终端 `_meta` 约定。
 *
 * ACP 没有为这个约定定义能力位（它本就是 `_meta` 扩展），所以只能读
 * `clientCapabilities._meta.terminal_output`。**严格比 `=== true`**：`_meta`
 * 的值类型是 `unknown`，任何真值判断都会把字符串 `"false"` 当成支持。
 * @param params - initialize 请求
 * @returns 支持终端卡片则 true
 */
export function clientSupportsTerminal(params: InitializeRequest): boolean {
  return params.clientCapabilities?._meta?.['terminal_output'] === true
}

/**
 * 客户端是否支持表单式 elicitation（US-21）。
 *
 * 与终端约定不同，这个有正式能力位——但它在 1.3.0 里仍标着 UNSTABLE。语义是
 * 「给了对象就是支持」：`{}` 表示支持，omit 与 null 都表示不支持。
 * @param params - initialize 请求
 * @returns 支持表单征询则 true
 */
export function clientSupportsElicitation(params: InitializeRequest): boolean {
  const form = params.clientCapabilities?.elicitation?.form
  return form !== undefined && form !== null
}

/**
 * 客户端是否实现 `fs/read_text_file`（US-25）。
 *
 * 这一位是**布尔**而非对象，所以判定与 elicitation 那条不同：`=== true` 才算。
 * 缺席与显式 `false` 在这里没有行为差别（两种都是不能调），但排查时是两种信号
 * ——所以 {@link describeClient} 分得开，这个函数不分。
 *
 * SDK 两侧的注释都写着 "Only available if the client advertises the
 * `fs.readTextFile` capability"：没声明就调，等于对着一个没注册处理器的方法发
 * 请求，拿回 methodNotFound。
 * @param params - initialize 请求
 * @returns 可以把文本读委托给编辑器则 true
 */
export function clientSupportsFsRead(params: InitializeRequest): boolean {
  return params.clientCapabilities?.fs?.readTextFile === true
}

/**
 * 把客户端声明的能力位摘成一行，供握手时记进 stderr。
 *
 * 存在的理由很实际：**「这个编辑器到底支持什么」是排查一切降级行为的起点**。
 * 表单征询没弹出来、终端卡片没画出来、`fs` 委托没生效——三者的第一个问题都是
 * 「它 advertise 了吗」，而在此之前那只能靠猜或者去翻编辑器源码。
 *
 * 每项都如实回显**原始值**而非布尔判定：`readTextFile` 缺席与显式 `false` 在
 * 排查时是两种不同的信号（前者是老客户端，后者是明确不支持）。
 * @param params - initialize 请求
 * @returns 单行摘要
 */
export function describeClient(params: InitializeRequest): string {
  const caps = params.clientCapabilities
  const shown = (value: unknown): string => (value === undefined ? '（未声明）' : JSON.stringify(value))
  return [
    `protocolVersion=${params.protocolVersion}`,
    `fs.readTextFile=${shown(caps?.fs?.readTextFile)}`,
    `fs.writeTextFile=${shown(caps?.fs?.writeTextFile)}`,
    `elicitation.form=${shown(caps?.elicitation?.form)}`,
    `terminal=${shown(caps?.terminal)}`,
    `_meta.terminal_output=${shown(caps?._meta?.['terminal_output'])}`,
  ].join('  ')
}

/**
 * 生成 initialize 应答。
 *
 * `loadSession` 与 `sessionCapabilities` 的 `list` / `resume` 是**按组合动态
 * 声明**的：宿主没挂持久化时会话随进程消失，声明了客户端就会去调，然后拿到一个
 * 无从解释的错误。这些方法本身也会在没有持久化时直接 `methodNotFound`——声明与
 * 实现同一个真值来源。
 *
 * `close` 是例外，无条件声明：它释放的是**进程内**资源（agent、MCP 子进程、
 * 订阅），与会话能不能从日志恢复无关。
 * @param options.persistent - 组合是否挂了持久化后端
 * @returns 本 bridge 的 initialize 应答
 */
export function handleInitialize(options: { persistent: boolean } = { persistent: false }): InitializeResponse {
  return {
    // 单版本 agent：规范里「支持则同版本，否则取最新支持版本」两条分支
    // 都归结到这一个版本。
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { ...AGENT_INFO },
    agentCapabilities: {
      // `embeddedContext` 已实现：内嵌 `resource` 块的文本整段内联（`src/codec/prompt.ts`），
      // 这是「@ 一个文件、内容直接带过来」的通道，也能带上磁盘上根本没有的东西。
      // image / audio 仍未实现，见 README 的「已关闭」一节（上游无多模态路由）。
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      // **`McpCapabilities` 只描述非 stdio 传输**：stdio 是所有 agent 的基线，
      // 没有位可以表示「支持/不支持 stdio」（也因此无法声明「完全不支持 MCP」）。
      // 这里声明的是本部署确实翻译得了的那两种之外的情况：
      //   http → `streamable-http`，`dsh-mcp-client` 支持
      //   sse  → 上游没有这个传输（MCP 规范也已标 deprecated）
      //   acp  → 需要把 MCP 报文经 ACP 连接代理回客户端，那是自研传输，不是配置
      mcpCapabilities: { http: true, sse: false, acp: false },
      // `{}` 才表示「支持」；omit 与 null 都表示不支持。
      //
      // `close` **不**跟随持久化：释放资源与会话能不能恢复无关，没挂持久化时
      // 关掉一个会话同样要把 agent 与它的 MCP 子进程收走。
      sessionCapabilities: {
        close: {},
        ...(options.persistent ? { list: {}, resume: {} } : {}),
      },
      ...(options.persistent ? { loadSession: true } : {}),
    },
    authMethods: [],
  }
}
