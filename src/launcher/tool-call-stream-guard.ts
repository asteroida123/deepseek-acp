/**
 * 流式工具调用头的 null 防护（fetch 边界改写）。
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
 * 按 D4（纯下游、不改上游），防护装在本项目这一侧：包一层全局 fetch，
 * 仅对 `/chat/completions` 的 SSE 响应做行级改写——把 `tool_calls[].id`
 * 与 `tool_calls[].function.name` 的显式 null 摘成字段省略，其余字节
 * 原样透传（含 `[DONE]`、usage 分片、无法解析的行）。适配器看到省略，
 * `!== void 0` 守卫即正确跳过，首片捕获得以保留。
 */

/** 幂等标记：装两次不包两层壳（测试与真实 boot 可能先后触发）。 */
const INSTALLED = Symbol.for('deepseek-acp.toolCallStreamGuard')

interface ToolCallDelta {
	id?: string | null
	function?: { name?: string | null; arguments?: string }
	[key: string]: unknown
}

/** 就地摘掉一个分片对象里的显式 null 工具调用头。返回是否改动了。 */
function stripNullToolCallHeaders(payload: unknown): boolean {
	if (typeof payload !== 'object' || payload === null) return false
	const choices = (payload as { choices?: unknown }).choices
	if (!Array.isArray(choices)) return false
	let changed = false
	for (const choice of choices) {
		if (typeof choice !== 'object' || choice === null) continue
		const delta = (choice as { delta?: { tool_calls?: unknown } }).delta
		const calls = delta?.tool_calls
		if (!Array.isArray(calls)) continue
		for (const call of calls) {
			if (typeof call !== 'object' || call === null) continue
			const entry = call as ToolCallDelta
			if (entry.id === null) {
				delete entry.id
				changed = true
			}
			const fn = entry.function
			if (typeof fn === 'object' && fn !== null && fn.name === null) {
				delete fn.name
				changed = true
			}
		}
	}
	return changed
}

/**
 * SSE 是行协议，但网络分块不保证行边界——先攒行再处理，未完结的尾巴
 * 留在缓冲区等下一块。改写只动 `data: ` 前缀的 JSON 行；解析失败的行
 * 原样透传（上游加字段不该被我们改坏）。
 */
function createRewritingStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder()
	const encoder = new TextEncoder()
	let buffer = ''
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = source.getReader()
			try {
				for (;;) {
					const { done, value } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					let newlineIndex: number
					while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
						const line = buffer.slice(0, newlineIndex)
						buffer = buffer.slice(newlineIndex + 1)
						controller.enqueue(encoder.encode(rewriteLine(line) + '\n'))
					}
				}
				buffer += decoder.decode()
				if (buffer.length > 0) controller.enqueue(encoder.encode(rewriteLine(buffer)))
				controller.close()
			} catch (error) {
				controller.error(error)
			} finally {
				reader.releaseLock()
			}
		},
	})
}

function rewriteLine(line: string): string {
	const prefix = 'data: '
	if (!line.startsWith(prefix)) return line
	const payload = line.slice(prefix.length)
	if (payload === '[DONE]') return line
	try {
		const parsed: unknown = JSON.parse(payload)
		if (!stripNullToolCallHeaders(parsed)) return line
		return prefix + JSON.stringify(parsed)
	} catch {
		return line
	}
}

/** 是否是需要改写的响应：chat/completions + SSE。其余请求零接触。 */
function isTargetResponse(url: string | undefined, response: Response): boolean {
	if (url === undefined || !url.includes('/chat/completions')) return false
	const contentType = response.headers.get('content-type') ?? ''
	return contentType.includes('text/event-stream')
}

/**
 * 包一层全局 fetch。只拦截 `/chat/completions` 的 SSE 响应体；请求参数、
 * 状态码、响应头全部原样保留——适配器的错误分支（response.ok 检查、
 * WWW-Authenticate 读取）看到的仍是上游原本的样子。
 */
export function installToolCallStreamGuard(): void {
	const holder = globalThis as { fetch: typeof fetch; [INSTALLED]?: boolean }
	if (holder[INSTALLED]) return
	const original = holder.fetch.bind(holder)
	holder[INSTALLED] = true
	holder.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const response = await original(input, init)
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
		if (!isTargetResponse(url, response) || response.body === null) return response
		return new Response(createRewritingStream(response.body), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		})
	}) as typeof fetch
}
