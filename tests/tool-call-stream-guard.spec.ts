/**
 * TC-GUARD-05 —— 流式工具调用头不得以显式 null 到达适配器。
 *
 * 守的是 boot() 里装的 fetch 边界改写（src/launcher/tool-call-stream-guard.ts）。
 * 风险形态：部分上游路径（实测 opencode zen 服务 deepseek-v4-flash）在
 * arguments 分片里用显式 JSON null 重复 `tool_calls` 的 id/name；适配器
 * （纯下游，D4 不改）的捕获守卫是 `!== void 0`，null 会穿透并把首片
 * 捕获覆盖掉 → 空名派发 → `unknown tool ""`。改写把 null 头摘成字段
 * 省略，守卫即正确跳过。
 *
 * 在 fetch 层面喂**真实形状**的 SSE 分片（含行跨块切开），断言适配器
 * 将要读到的流：null 头消失、首片 id/name 与 arguments 分片原样保留。
 * 不起真子进程——这里守的是纯函数式的流改写，内存流就是它的真实介质
 * （对比 TC-GUARD-01：stdout 纯净性必须碰真 process.stdout，介质不同）。
 */

import { describe, expect, it } from 'vitest'
import { installToolCallStreamGuard } from '../src/launcher/tool-call-stream-guard.js'

/** 实测捕获的 flash 分片形状：首片带头，后续片用 null 重复所有字段。 */
const FIRST_CHUNK =
	'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_00_abc","type":"function","function":{"name":"bash","arguments":""}}]}}]}'

const ARGS_CHUNK_WITH_NULLS =
	'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":null,"type":"function","function":{"name":null,"arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}'

const USAGE_CHUNK = 'data: {"choices":[],"usage":{"prompt_tokens":375,"total_tokens":432}}'

/** 把一段文本按 SSE 语义流出去。 */
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			controller.close()
		},
	})
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder()
	let out = ''
	for await (const value of stream) out += decoder.decode(value, { stream: true })
	return out + decoder.decode()
}

const INSTALLED = Symbol.for('deepseek-acp.toolCallStreamGuard')

/**
 * 装桩 → 清幂等标记 → 装防护。防护壳必须包住**当前**全局 fetch，所以
 * 顺序不能反；清标记是为了每条用例拿到一层干净的单壳（boot 里也只会
 * 装一次，这里只是测试需要重建）。
 */
async function runThroughGuard(
	chunks: string[],
	opts: { url?: string; contentType?: string } = {}
): Promise<string> {
	const url = opts.url ?? 'https://example.com/chat/completions'
	const contentType = opts.contentType ?? 'text/event-stream'
	const holder = globalThis as { fetch: typeof fetch; [INSTALLED]?: boolean }
	const realFetch = holder.fetch
	holder.fetch = (async () =>
		new Response(streamFrom(chunks), {
			status: 200,
			headers: { 'content-type': contentType },
		})) as typeof fetch
	holder[INSTALLED] = false
	try {
		installToolCallStreamGuard()
		const response = await holder.fetch(url, { method: 'POST' })
		return await readAll(response.body as ReadableStream<Uint8Array>)
	} finally {
		holder.fetch = realFetch
		holder[INSTALLED] = false
	}
}

describe('TC-GUARD-05 工具调用头的 null 防护', () => {
	it('null 头被摘成省略，首片 id/name 与 arguments 保留', async () => {
		const rewritten = await runThroughGuard([
			FIRST_CHUNK + '\n\n',
			ARGS_CHUNK_WITH_NULLS + '\n\n',
			'data: [DONE]\n\n',
		])
		// 反向对照的第一半：改写确实落地（坏实现会让这两条断言变红）。
		expect(rewritten).not.toContain('"id":null')
		expect(rewritten).not.toContain('"name":null')
		// 首片的头完好——这才是修复的意义：适配器能保住它。
		expect(rewritten).toContain('"id":"call_00_abc"')
		expect(rewritten).toContain('"name":"bash"')
		// arguments 分片内容原样可达。
		expect(rewritten).toContain('\\"command\\":\\"ls\\"')
		// 帧边界与控制行不动。
		expect(rewritten).toContain('data: [DONE]')
		expect(rewritten.split('data: ').length - 1).toBe(3)
	})

	it('非 tool_calls 的分片零改写（usage、不可解析行）', async () => {
		const rewritten = await runThroughGuard([
			'data: not-json-at-all\n\n',
			USAGE_CHUNK + '\n\n',
		])
		expect(rewritten).toContain('data: not-json-at-all')
		expect(rewritten).toContain('"total_tokens":432')
	})

	it('行跨网络块切开时仍按行改写', async () => {
		const whole = FIRST_CHUNK + '\n\n' + ARGS_CHUNK_WITH_NULLS + '\n\n'
		const mid = Math.floor(FIRST_CHUNK.length / 2)
		const rewritten = await runThroughGuard([
			whole.slice(0, mid),
			whole.slice(mid, mid + 3),
			whole.slice(mid + 3),
		])
		expect(rewritten).not.toContain('"id":null')
		expect(rewritten).toContain('"name":"bash"')
	})

	it('非 chat/completions 或非 SSE 的响应不进改写路径', async () => {
		const body = '{"id":null,"function":{"name":null}}'
		const untouched = await runThroughGuard([body], {
			url: 'https://example.com/api/other',
			contentType: 'text/event-stream',
		})
		expect(untouched).toBe(body)
		const untouchedJson = await runThroughGuard([body], {
			url: 'https://example.com/chat/completions',
			contentType: 'application/json',
		})
		expect(untouchedJson).toBe(body)
	})
})
