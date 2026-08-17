/**
 * TC-GUARD-05 —— 流式工具调用头不得以 null / 空串到达适配器。
 *
 * 守的是 boot() 里装的 fetch 边界改写（src/launcher/tool-call-stream-guard.ts）。
 * 风险形态：部分上游路径（实测 opencode zen 服务 deepseek-v4-flash）在 arguments
 * 分片里重复 `tool_calls` 的 id/name，值是显式 null（或空串）；适配器（纯下游，
 * D4 不改）的捕获守卫是 `!== void 0`，两者都会穿透并把首片捕获覆盖掉 → 空名
 * 派发 → `unknown tool ""`；落盘之后还会连累 `session/load`（会话校验要求 tool
 * 源 callId 非空串，整个会话会被拒）。改写把坏头摘成字段省略，守卫即正确跳过。
 *
 * 在 fetch 层面喂**真实形状**的 SSE 分片（含行跨块切开、无空格 `data:`、CRLF
 * 行尾），断言适配器将要读到的流。不起真子进程——这里守的是纯函数式的流改写，
 * 内存流就是它的真实介质（对比 TC-GUARD-01：stdout 纯净性必须碰真
 * `process.stdout`，介质不同）。
 *
 * 除了「改写对不对」，还守三条**不改写**的性质，它们各自对应一次真实的失效面：
 * 背压（`start` 里一次抽干会把整条响应堆进队列）、取消传播（`[DONE]` 后
 * `parseSse` 提前 return 就走这条，不传上游就漏连接）、诊断落在 stderr
 * （stdout 是协议通道，AC-G1）。
 */

import { describe, expect, it, vi } from 'vitest'
import { installToolCallStreamGuard } from '../src/launcher/tool-call-stream-guard.js'

/** 实测捕获的 flash 分片形状：首片带头，后续片用 null 重复所有字段。 */
const FIRST_CHUNK =
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_00_abc","type":"function","function":{"name":"bash","arguments":""}}]}}]}'

const ARGS_CHUNK_WITH_NULLS =
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":null,"type":"function","function":{"name":null,"arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}'

/** 同一个洞的另一半：空串。`'' !== void 0` 同样为真，覆盖后症状一模一样。 */
const ARGS_CHUNK_WITH_EMPTIES =
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","type":"function","function":{"name":"","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}'

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

interface GuardRun {
  url?: string
  contentType?: string
  /**
   * 不传就吞掉诊断：模块默认实现写 stderr，每条用例都吐一遍只会淹掉真正的失败
   * 输出。传 `'default'` 才走模块默认实现（只有守「诊断去哪」的那条用例需要）。
   */
  onFirstRewrite?: ((detail: string) => void) | 'default'
}

/**
 * 装桩 → 装防护 → 跑一次 → 卸载。顺序不能反：防护壳必须包住**当前**这个桩。
 * 卸载走 `installToolCallStreamGuard()` 返回的句柄，不去手改幂等标记——用例
 * 不该知道模块内部拿什么记状态。
 */
async function runThroughGuard(chunks: string[], opts: GuardRun = {}): Promise<string> {
  const url = opts.url ?? 'https://example.com/chat/completions'
  const contentType = opts.contentType ?? 'text/event-stream'
  const holder = globalThis as { fetch: typeof fetch }
  const realFetch = holder.fetch
  holder.fetch = (async () =>
    new Response(streamFrom(chunks), {
      status: 200,
      headers: { 'content-type': contentType },
    })) as typeof fetch
  const uninstall = installToolCallStreamGuard(
    opts.onFirstRewrite === 'default'
      ? {}
      : { onFirstRewrite: opts.onFirstRewrite ?? ((): void => {}) },
  )
  try {
    const response = await holder.fetch(url, { method: 'POST' })
    return await readAll(response.body as ReadableStream<Uint8Array>)
  } finally {
    uninstall()
    holder.fetch = realFetch
  }
}

describe('TC-GUARD-05 工具调用头的坏值防护', () => {
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

  it('空串头同样被摘掉——它落盘后还会连累 session/load', async () => {
    const rewritten = await runThroughGuard([
      FIRST_CHUNK + '\n\n',
      ARGS_CHUNK_WITH_EMPTIES + '\n\n',
    ])
    expect(rewritten).not.toContain('"id":""')
    expect(rewritten).not.toContain('"name":""')
    expect(rewritten).toContain('"id":"call_00_abc"')
    expect(rewritten).toContain('"name":"bash"')
  })

  it('`data:` 不带空格也照改——那个空格在 SSE 规范里是可选的', async () => {
    const noSpace = ARGS_CHUNK_WITH_NULLS.replace('data: ', 'data:')
    const rewritten = await runThroughGuard([
      FIRST_CHUNK.replace('data: ', 'data:') + '\n\n',
      noSpace + '\n\n',
    ])
    expect(rewritten).not.toContain('"id":null')
    expect(rewritten).not.toContain('"name":null')
    // 前缀原样保留，不替上游把行形状规范化。
    expect(rewritten).toContain('data:{"choices"')
    expect(rewritten).not.toContain('data: {"choices"')
  })

  it('CRLF 行尾在改写后仍然是 CRLF', async () => {
    const rewritten = await runThroughGuard([
      FIRST_CHUNK + '\r\n\r\n',
      ARGS_CHUNK_WITH_NULLS + '\r\n\r\n',
    ])
    expect(rewritten).not.toContain('"id":null')
    // 改写过的那一行，行尾不能被我们从 \r\n 偷换成 \n。
    expect(rewritten.endsWith('\r\n\r\n')).toBe(true)
    expect(rewritten).not.toMatch(/[^\r]\n\r\n$/)
  })

  it('非 tool_calls 的分片零改写（usage、不可解析行）', async () => {
    const rewritten = await runThroughGuard(['data: not-json-at-all\n\n', USAGE_CHUNK + '\n\n'])
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

  it('首次改写报一行诊断，且只报一次', async () => {
    const seen: string[] = []
    await runThroughGuard(
      [FIRST_CHUNK + '\n\n', ARGS_CHUNK_WITH_NULLS + '\n\n', ARGS_CHUNK_WITH_NULLS + '\n\n'],
      { onFirstRewrite: (detail) => seen.push(detail) },
    )
    expect(seen).toHaveLength(1)
    // 诊断得说清楚摘到的是什么值，才能跟抓包对上。
    expect(seen[0]).toContain('id=null')
    expect(seen[0]).toContain('name=null')
  })

  it('什么都没摘时不报诊断', async () => {
    const seen: string[] = []
    await runThroughGuard([FIRST_CHUNK + '\n\n', USAGE_CHUNK + '\n\n'], {
      onFirstRewrite: (detail) => seen.push(detail),
    })
    expect(seen).toHaveLength(0)
  })

  /**
   * 只断言「写到了 stderr」，不在这里断言「stdout 一个字节都没有」：进程内用例
   * 与 vitest 的 reporter 共用真的 `process.stdout`，那种断言会被别人的输出打成
   * 偶发红。stdout 纯净性归 TC-GUARD-01 管，它起真子进程，那才是这条性质的
   * 真实介质。
   */
  it('默认诊断落在 stderr', async () => {
    const toStderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      await runThroughGuard([FIRST_CHUNK + '\n\n', ARGS_CHUNK_WITH_NULLS + '\n\n'], {
        onFirstRewrite: 'default',
      })
      expect(toStderr).toHaveBeenCalledTimes(1)
      expect(String(toStderr.mock.calls[0]?.[0])).toContain('tool-call-stream-guard')
    } finally {
      toStderr.mockRestore()
    }
  })

  it('下游取消会传到上游响应体——否则连接一直不释放', async () => {
    let cancelledWith: unknown
    const holder = globalThis as { fetch: typeof fetch }
    const realFetch = holder.fetch
    holder.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(ARGS_CHUNK_WITH_NULLS + '\n\n'))
          },
          cancel(reason) {
            cancelledWith = reason
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch
    const uninstall = installToolCallStreamGuard({ onFirstRewrite: (): void => {} })
    try {
      const response = await holder.fetch('https://example.com/chat/completions')
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      await reader.cancel('done')
      expect(cancelledWith).toBe('done')
    } finally {
      uninstall()
      holder.fetch = realFetch
    }
  })

  it('不预抽干上游——背压能穿过这一层', async () => {
    let produced = 0
    const total = 12
    const holder = globalThis as { fetch: typeof fetch }
    const realFetch = holder.fetch
    holder.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            produced += 1
            if (produced >= total) controller.close()
            else controller.enqueue(new TextEncoder().encode(ARGS_CHUNK_WITH_NULLS + '\n\n'))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch
    const uninstall = installToolCallStreamGuard({ onFirstRewrite: (): void => {} })
    try {
      const response = await holder.fetch('https://example.com/chat/completions')
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      // **必须先让事件循环空转一轮再断言**：抽干是异步推进的，紧接着 read()
      // 断言的话，抽干版本此刻也才产出一两块，用例照样是绿的——这条最初就是
      // 这么假绿的，反向对照才把它抓出来。
      await new Promise((resolve) => setTimeout(resolve, 20))
      // 停在常数级队列深度；一次抽干的写法这里会是 total。
      expect(produced).toBeLessThan(total)
      await reader.cancel('done')
    } finally {
      uninstall()
      holder.fetch = realFetch
    }
  })

  it('重复安装不叠壳，卸载后 fetch 还原', async () => {
    const holder = globalThis as { fetch: typeof fetch }
    const stub = (async () =>
      new Response(streamFrom([ARGS_CHUNK_WITH_NULLS + '\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch
    const realFetch = holder.fetch
    holder.fetch = stub
    const uninstall = installToolCallStreamGuard({ onFirstRewrite: (): void => {} })
    const again = installToolCallStreamGuard({ onFirstRewrite: (): void => {} })
    try {
      // 第二次安装拿到的是同一个句柄，也没在自己身上再包一层。
      expect(again).toBe(uninstall)
      const wrapped = await readAll(
        (await holder.fetch('https://example.com/chat/completions'))
          .body as ReadableStream<Uint8Array>,
      )
      expect(wrapped).not.toContain('"id":null')
    } finally {
      uninstall()
      // 还原到装壳之前那个函数本身，而不是某个绑定副本。
      expect(holder.fetch).toBe(stub)
      holder.fetch = realFetch
    }
  })
})
