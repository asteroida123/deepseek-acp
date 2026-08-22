/**
 * TC-SESS-* —— 握手、会话创建、多会话隔离。
 * 走真实的 ndJSON JSON-RPC 帧，不绕过编解码。
 */

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type ClientCapabilities } from '@agentclientprotocol/sdk'
import { parseCli } from '../src/launcher/cli.js'
import { AGENT_INFO } from '../src/protocol/initialize.js'
import { createHarness, type TestHarness } from './harness.js'

const CWD = tmpdir()
let harness: TestHarness | undefined

afterEach(() => {
  harness?.disposeBridge()
  harness = undefined
})

async function boot(): Promise<TestHarness> {
  harness = await createHarness()
  await harness.acp.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  return harness
}

describe('initialize（US-01）', () => {
  it('协商到本服务端唯一支持的协议版本并声明身份', async () => {
    const h = await createHarness()
    harness = h
    const res = await h.acp.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(res.agentInfo?.name).toBe('deepseek-acp')
  })

  it('advertise 的能力与实现严格一致：声明 embeddedContext，不声明 image/audio', async () => {
    const h = await boot()
    const res = await h.acp.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    // `embeddedContext` 自内嵌 resource 支持起为 true（`src/codec/prompt.ts`）；
    // 声明与放行集合的**逐项**一致由 `codec.spec.ts` 那条用例守着，这里守的是
    // 「线上真的这么说」。image / audio 仍是 false —— 上游没有多模态路由。
    expect(res.agentCapabilities?.promptCapabilities).toEqual({
      image: false,
      audio: false,
      embeddedContext: true,
    })
  })

  it('没声明 auth 能力的客户端拿到空 authMethods —— 与本功能之前的行为一致', async () => {
    const h = await boot()
    const res = await h.acp.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    // 终端登录是 **opt-in** 的方法类型（SDK：「the agent **may** include `terminal`
    // entries」当且仅当客户端声明）。塞给没准备好的客户端，轻则被忽略，重则整个
    // 应答解析失败——那是一次静默的互操作回归，本地怎么测都测不出来。
    expect(res.authMethods).toEqual([])
  })

  // 表项显式标注类型：`it.each` 会把字面量放宽，`request('initialize', …)` 的重载
  // 就推不出应答类型，`res` 变成 unknown（用例照跑，typecheck 挂）。
  it.each<[string, ClientCapabilities]>([
    ['正式能力位 auth.terminal', { auth: { terminal: true } }],
    // **ACP registry 的准入校验器发的正是这一个**（`client.py` 的 initialize 只带
    // `terminal`、`fs` 和 `_meta` 里的两条），只认正式能力位的话 CI 会拿到空数组，
    // 直接判「No authMethods in response」，PR 挂掉。
    ['_meta 约定 terminal-auth', { _meta: { 'terminal-auth': true } }],
  ])('%s 的客户端拿到那条 Terminal Auth，且 args 与 CLI 认的开关一致', async (_label, caps) => {
    const h = await boot()
    const res = await h.acp.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: caps,
    })

    // 这三个字段是 registry 的准入判据（要求至少一条 `type` 为 `agent` 或
    // `terminal` 的方法），漂了就是 PR 挂掉，而本地一切照常——所以钉在这里。
    expect(res.authMethods).toHaveLength(1)
    const method = res.authMethods?.[0]
    expect(method).toMatchObject({ id: 'terminal', type: 'terminal', args: ['--setup'] })

    // `args` 与 CLI 之间是**跨文件的一致性**：客户端拿同一个二进制加这串参数另起
    // 进程，对不上的表现是「终端一闪而过，然后仍未登录」。这里从 `parseCli` 那头
    // 反向验一次，两边一起改才不会挂。
    const args = (method as { args?: string[] }).args ?? []
    expect(parseCli(args).kind).toBe('setup')
  })

  it('顶层 clientCapabilities.terminal 不是登录能力位 —— 不能拿它当 opt-in', async () => {
    const h = await boot()
    const res = await h.acp.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    })
    // 那一位说的是「实现了 `terminal/*` 那组方法」（终端卡片），与「认不认得终端
    // 登录」是两件事。registry 的校验器两个都发，正好会把这处混淆掩盖过去——所以
    // 单独钉一条。
    expect(res.authMethods).toEqual([])
  })

  it('agentInfo.version 与 package.json 一致 —— codeg 按这个对账', () => {
    // 两处是独立字面量（`import` 一个 JSON 会让构建产物依赖包布局）。漂移的
    // 表现不是报错：codeg 注册自定义 agent 时按 `deepseek-acp@<版本>` 对账，
    // 对不上就是编辑器里连不上，而两边看起来都「没问题」。
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string; name: string }
    expect(AGENT_INFO.version).toBe(pkg.version)
    expect(AGENT_INFO.name).toBe(pkg.name)
  })

  it('authenticate 是 no-op，不报错', async () => {
    const h = await boot()
    await expect(h.acp.request('authenticate', { methodId: 'whatever' })).resolves.toBeDefined()
  })
})

describe('session/new（US-02）', () => {
  it('以绝对 cwd 创建会话并返回 id', async () => {
    const h = await boot()
    const res = await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
    expect(typeof res.sessionId).toBe('string')
    expect(res.sessionId.length).toBeGreaterThan(0)
  })

  it('拒绝相对 cwd —— 否则会静默跑在启动目录下', async () => {
    const h = await boot()
    await expect(
      h.acp.request('session/new', { cwd: './relative', mcpServers: [] }),
    ).rejects.toThrow(/absolute/i)
  })

  it('显式拒绝不支持的 MCP 传输而非静默忽略（AC-G2）', async () => {
    // M1-c 起 stdio 与 http 都真的挂得上（见 mcp.spec.ts）。「拒绝而非静默忽略」
    // 这条约束幸存下来的形态是：翻译不了的传输要报错。客户端送来 server 就是
    // 指望这些工具可用，假装接受只会让模型看不见它们，而故障现场离原因很远。
    const h = await boot()
    await expect(
      h.acp.request('session/new', {
        cwd: CWD,
        mcpServers: [{ type: 'sse', name: 'legacy', url: 'https://example.com/sse', headers: [] }],
      }),
    ).rejects.toThrow(/sse|not supported/i)
  })

  it('接受空的 additionalDirectories', async () => {
    const h = await boot()
    await expect(
      h.acp.request('session/new', { cwd: CWD, mcpServers: [], additionalDirectories: [] }),
    ).resolves.toBeDefined()
  })
})

describe('多会话隔离（US-05、AC-G3）', () => {
  it('一个连接下可并存多个会话，各自独立 id 与工作区', async () => {
    const h = await boot()
    const a = await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  it('未知会话 id 的 prompt 被拒，且不波及已有会话', async () => {
    const h = await boot()
    const a = await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
    await expect(
      h.acp.request('session/prompt', {
        sessionId: 'no-such-session',
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toThrow(/unknown session/i)
    // 原会话仍可用
    await expect(
      h.acp.request('session/prompt', { sessionId: a.sessionId, prompt: [] }),
    ).rejects.toThrow(/empty prompt/i)
  })

  it('取消一个不存在的会话是静默 no-op', async () => {
    const h = await boot()
    await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
    await expect(
      h.acp.notify('session/cancel', { sessionId: 'no-such-session' }),
    ).resolves.toBeUndefined()
  })
})

describe('prompt 输入校验（AC-G2）', () => {
  it('拒绝空 prompt', async () => {
    const h = await boot()
    const s = await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
    await expect(
      h.acp.request('session/prompt', { sessionId: s.sessionId, prompt: [] }),
    ).rejects.toThrow(/empty prompt/i)
  })

  it('拒绝 baseline 之外的内容块而非静默丢弃', async () => {
    const h = await boot()
    const s = await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
    await expect(
      h.acp.request('session/prompt', {
        sessionId: s.sessionId,
        prompt: [{ type: 'audio', data: 'x', mimeType: 'audio/wav' }],
      }),
    ).rejects.toThrow(/embedded resource/i)
  })

  it('没挂附件服务时发图被拒，且说得清是为什么（AC-G2）', async () => {
    // 这个 harness 不挂附件服务，于是 `promptCapabilities.image` 报 false。
    // 关键是**拒绝的理由要指向缺席的那个服务**——早先这里报的是「只支持
    // text / resource_link / embedded resource」，那句话读起来像「这个协议
    // 不支持图片」，而真相是「这个部署没装」。
    const h = await boot()
    const s = await h.acp.request('session/new', { cwd: CWD, mcpServers: [] })
    await expect(
      h.acp.request('session/prompt', {
        sessionId: s.sessionId,
        prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow(/attachment store/i)
  })
})
