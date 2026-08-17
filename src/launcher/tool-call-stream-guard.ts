/**
 * 流式工具调用头的坏值防护（fetch 边界改写）。
 *
 * 某些上游路径（实测：opencode zen 代理服务 deepseek-v4-flash）在后续
 * arguments 分片里用**显式 JSON null** 重复所有 `tool_calls` 字段：
 *
 *   {"tool_calls":[{"index":0,"id":null,"function":{"name":null,"arguments":"{"}}]}
 *
 * 而适配器（@deepseek-ai/dsh-llm-deepseek，纯下游、不可改）的流式 translate
 * 用 `!== void 0` 守卫 callId/name 的捕获——只防「字段省略」，不防「显式
 * null」。`null !== void 0` 为真，于是每个 arguments 分片都把首片捕获的
 * id/name 覆盖成 null，工具调用以空名派发、全部死于 `unknown tool ""`。
 * v4-pro 不受影响纯属其上游分片省略字段而非置 null——同一适配器两种命运。
 *
 * **空串是同一个洞**：`'' !== void 0` 同样为真，覆盖后的症状一模一样（适配器
 * 的 `?? ''` 兜底让 null 和空串最终都落成空串）。而且它比 null 更毒：落盘之后
 * `dsh-session` 的校验要求 tool 源的 callId 是非空串，一次抖动就让整个会话再也
 * 读不回来（issue #2 的现象 B）。所以这里摘的是 **null 与空串**两种坏头。
 *
 * 按 D4（纯下游、不改上游），防护装在本项目这一侧：包一层全局 fetch，仅对
 * `/chat/completions` 的 SSE 响应做行级改写——把 `tool_calls[].id` 与
 * `tool_calls[].function.name` 的坏值摘成**字段省略**，其余字节原样透传（含
 * `[DONE]`、usage 分片、无法解析的行）。适配器看到省略，`!== void 0` 守卫即
 * 正确跳过，首片捕获得以保留。
 *
 * 治本仍在上游：`@deepseek-ai/dsh-llm-deepseek` 的守卫改成 `!= null` 并另挡
 * 空串即可（rc.7 仍未修）。上游修好后这一层可以整个删掉——所以它第一次真的
 * 改写时会往 stderr 打一行，好让现场能回答「还需不需要它」。不打这一行的话，
 * 这层壳的必要性在生产里是无法证伪的：装着也不知道有没有生效。
 * @module
 */

/** 幂等标记兼卸载句柄：装两次不包两层壳（测试与真实 boot 可能先后触发）。 */
const GUARD = Symbol.for('deepseek-acp.toolCallStreamGuard')

interface ToolCallDelta {
  id?: string | null
  function?: { name?: string | null; arguments?: string }
  [key: string]: unknown
}

export interface ToolCallStreamGuardOptions {
  /**
   * 第一次真的摘掉坏头时调用一次（每次安装各算一次），默认往 stderr 打一行。
   * 留成可注入的，测试才能断言「诊断确实发出去了」而不是只把它静音掉。
   */
  onFirstRewrite?: (detail: string) => void
}

/** 两种坏头：显式 null 与空串——适配器的 `!== void 0` 对它们都不设防。 */
function isBrokenHeader(value: unknown): boolean {
  return value === null || value === ''
}

/** 诊断里把坏值写成它在线上的样子，好跟抓包对得上。 */
function describe(value: unknown): string {
  return value === null ? 'null' : '""'
}

/**
 * 就地摘掉一个分片对象里的坏工具调用头。
 * @returns 摘掉了什么（诊断用），什么都没摘则是 `undefined`——调用方据此决定
 *   是否重新序列化这一行，没改动的行必须原样透传。
 */
function stripBrokenToolCallHeaders(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return undefined
  const stripped = new Set<string>()
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    const delta = (choice as { delta?: { tool_calls?: unknown } }).delta
    const calls = delta?.tool_calls
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (typeof call !== 'object' || call === null) continue
      const entry = call as ToolCallDelta
      if (isBrokenHeader(entry.id)) {
        stripped.add(`id=${describe(entry.id)}`)
        delete entry.id
      }
      const fn = entry.function
      if (typeof fn === 'object' && fn !== null && isBrokenHeader(fn.name)) {
        stripped.add(`name=${describe(fn.name)}`)
        delete fn.name
      }
    }
  }
  return stripped.size > 0 ? [...stripped].join(' ') : undefined
}

/**
 * 拆一行 SSE 字段。`data:` 后面那个空格在规范里是**可选**的（有就吃掉一个），
 * 适配器用的 `EventSourceParserStream` 两种都收——所以这里不能只认 `data: `，
 * 否则遇到不带空格的上游会静默失效，而失效方式正好是「什么都不做」。
 * 前缀原样记下来，改写后拼回去，别顺手改掉上游的行形状。
 */
function splitDataLine(line: string): { prefix: string; payload: string } | undefined {
  if (!line.startsWith('data:')) return undefined
  const rest = line.slice('data:'.length)
  return rest.startsWith(' ')
    ? { prefix: 'data: ', payload: rest.slice(1) }
    : { prefix: 'data:', payload: rest }
}

function rewriteLine(line: string, report: (detail: string) => void): string {
  // SSE 允许 CRLF 行尾，而我们按 \n 切行，\r 会留在行尾。摘出来、改完拼回去：
  // JSON.parse 容忍尾部 \r，直接丢掉不报错，于是行尾会被我们偷偷换掉。
  const carriage = line.endsWith('\r')
  const field = splitDataLine(carriage ? line.slice(0, -1) : line)
  if (field === undefined || field.payload === '[DONE]') return line
  let parsed: unknown
  try {
    parsed = JSON.parse(field.payload)
  } catch {
    // 上游加字段、换形状、发注释行都不该被我们改坏。
    return line
  }
  const stripped = stripBrokenToolCallHeaders(parsed)
  if (stripped === undefined) return line
  report(stripped)
  return field.prefix + JSON.stringify(parsed) + (carriage ? '\r' : '')
}

function createRewritingStream(
  source: ReadableStream<Uint8Array>,
  rewrite: (line: string) => string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  return new ReadableStream<Uint8Array>({
    /**
     * 用 `pull` 而不是在 `start` 里一次抽干：`pull` 只在下游要数据时才被调用，
     * 上游的背压因此能穿过这一层。`start` 版本会把整条响应堆进 controller 的
     * 队列——一个写大文件的工具调用就足以把它顶起来。
     *
     * `read()` 抛出时直接让这个 promise 拒绝即可：ReadableStream 会把它变成流
     * 的错误。自己 try/catch 再 `controller.error()` 反而会吃掉取消时的正常路径。
     */
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          if (buffer.length > 0) controller.enqueue(encoder.encode(rewrite(buffer)))
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        // SSE 是行协议，但网络分块不保证行边界——攒够一行才处理，没完的尾巴
        // 留在缓冲区等下一块。这一块里一行都没凑齐就接着读，别空手返回。
        let newlineIndex = buffer.indexOf('\n')
        if (newlineIndex < 0) continue
        do {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          controller.enqueue(encoder.encode(rewrite(line) + '\n'))
        } while ((newlineIndex = buffer.indexOf('\n')) >= 0)
        return
      }
    },
    /**
     * 下游取消必须传到上游，否则响应体一直不释放、连接回不了池。这不是边角
     * 路径：`parseSse` 读到 `[DONE]` 就 return，`for await` 随即取消整条管道，
     * 每一轮正常对话都会走到这里。
     */
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/** 是否是需要改写的响应：chat/completions + SSE。其余请求零接触。 */
function isTargetResponse(url: string | undefined, response: Response): boolean {
  if (url === undefined || !url.includes('/chat/completions')) return false
  const contentType = response.headers.get('content-type') ?? ''
  return contentType.includes('text/event-stream')
}

/** 诊断走 stderr —— stdout 是协议通道（AC-G1），写一个字节进去就毁掉整条连接。 */
function warnToStderr(detail: string): void {
  process.stderr.write(
    `[warn] tool-call-stream-guard: 上游分片带坏工具调用头（${detail}），已摘除；` +
      `不摘的话本轮工具调用会全部以空名派发。每进程只报一次。\n`,
  )
}

/**
 * 包一层全局 fetch。只拦截 `/chat/completions` 的 SSE 响应体；请求参数、状态码、
 * 响应头全部原样保留——适配器的错误分支（`response.ok` 检查、`retry-after` 与
 * requestId 读取）看到的仍是上游原本的样子。
 * @param options - 诊断回调
 * @returns 卸载句柄；重复安装返回的是**首次**那个句柄，卸载一次即可。仅当最外层
 *   还是本壳时才还原 fetch——别人后装的壳不该被我们顺手摘掉。
 */
export function installToolCallStreamGuard(options: ToolCallStreamGuardOptions = {}): () => void {
  const holder = globalThis as { fetch: typeof fetch; [GUARD]?: () => void }
  const installed = holder[GUARD]
  if (installed !== undefined) return installed
  const notify = options.onFirstRewrite ?? warnToStderr
  let notified = false
  const rewrite = (line: string): string =>
    rewriteLine(line, (detail) => {
      if (notified) return
      notified = true
      notify(detail)
    })
  const original = holder.fetch
  const call = original.bind(holder)
  const patched = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await call(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isTargetResponse(url, response) || response.body === null) return response
    return new Response(createRewritingStream(response.body, rewrite), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }) as typeof fetch
  const uninstall = (): void => {
    if (holder[GUARD] !== uninstall) return
    delete holder[GUARD]
    if (holder.fetch === patched) holder.fetch = original
  }
  holder[GUARD] = uninstall
  holder.fetch = patched
  return uninstall
}
