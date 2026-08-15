/**
 * TC-CARD-* —— 工具卡片的端到端。
 *
 * 前面的 presentation.spec 全是纯函数；这里让**真实的 agent loop** 跑一次真实
 * 的工具调用，验证事件→卡片这条链在真实事件形状下也成立。上游把 `tool/result`
 * 的载荷从 `{callId, content, isError}` 换成 `{message: ToolResultMessage}` 过一次，
 * 纯函数测试用手写事件是发现不了这种漂移的。
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHarness, waitFor, type CapturedUpdate } from './harness.js'

/**
 * 一个**独占**的工作区。
 *
 * 不能拿 `tmpdir()` 当 cwd 再配上写死的 `/tmp/x.ts`：macOS 的 `tmpdir()` 是
 * `/var/folders/...`，与 `/tmp` 毫不相干，于是「路径在工作区内」这条分支永远走不到；
 * 而 Linux 的 `tmpdir()` 就是 `/tmp`，同一份断言立刻两样。CI 上第一次跑 ubuntu
 * 就是栽在这里——本机全绿，改的却不是代码该改的地方。
 *
 * `realpathSync` 不能省：macOS 的 `/var` 是指向 `/private/var` 的符号链接，
 * 工作区内判定按字符串前缀走，不解析就会判成「在工作区外」。
 */
function workspace(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dsacp-cards-')))
}

/** 一个声明 diff 卡片的工具，用来同时覆盖 US-08 与 US-09。 */
const writeTool = defineTool({
  name: 'fake_write',
  description: 'test double for a mutation tool',
  parameters: { path: { type: 'string' }, text: { type: 'string' } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  presentCall: (args: { path: string; text: string }) => ({
    card: 'diff' as const,
    title: `Write ${args.path}`,
    diffs: [{ path: args.path, oldText: null, newText: args.text }],
    locations: [{ path: args.path }],
  }),
  presentResult: (args: { path: string; text: string }) => ({
    card: 'diff' as const,
    title: `Wrote ${args.path}`,
    diffs: [{ path: args.path, oldText: null, newText: args.text }],
  }),
  async execute() {
    return 'ok'
  },
})

/** 只保留工具卡片相关的更新。 */
function cards(updates: CapturedUpdate[]): CapturedUpdate[] {
  return updates.filter((u) => u.kind === 'tool_call' || u.kind === 'tool_call_update')
}

describe('TC-CARD-01 真实回合里的工具卡片', () => {
  it('一次工具调用产出 tool_call 与 tool_call_update', async () => {
    const h = await createHarness()
    h.ctx.tools.register(writeTool)
    const cwd = workspace()
    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })

    h.llm.toolCall = { id: 'c-1', name: 'fake_write', args: JSON.stringify({ path: join(cwd, 'a.ts'), text: 'hi' }) }
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '写个文件' }],
    })
    await waitFor(() => cards(h.updates).length >= 2, 5_000, 'tool card updates')

    const [call, update] = cards(h.updates)
    expect(call?.kind).toBe('tool_call')
    expect(update?.kind).toBe('tool_call_update')
    h.disposeBridge()
  })

  it('卡片带上工具自己声明的 diff、kind 与 locations —— 不做名字嗅探', async () => {
    const h = await createHarness()
    h.ctx.tools.register(writeTool)
    const cwd = workspace()
    const file = join(cwd, 'b.ts')
    const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })

    const raw: Record<string, unknown>[] = []
    h.onUpdate((u) => raw.push(u as Record<string, unknown>))

    h.llm.toolCall = { id: 'c-2', name: 'fake_write', args: JSON.stringify({ path: file, text: 'yo' }) }
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '写个文件' }],
    })
    await waitFor(() => raw.filter((u) => u['sessionUpdate'] === 'tool_call_update').length >= 1, 5_000, 'result card')

    const call = raw.find((u) => u['sessionUpdate'] === 'tool_call')
    expect(call).toMatchObject({
      toolCallId: 'c-2',
      // 标题里的工作区内路径要相对化（给人看），而 diff 与 locations 的 path 保持
      // 绝对（给编辑器跳转用）—— 两者的分工见 src/presentation/paths.ts，
      // 分支本身在 presentation.spec 的 TC-MAP-06 有单测。
      title: 'Write b.ts',
      kind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: file, oldText: null, newText: 'yo' }],
      locations: [{ path: file }],
    })

    const done = raw.find((u) => u['sessionUpdate'] === 'tool_call_update')
    expect(done).toMatchObject({
      toolCallId: 'c-2',
      status: 'completed',
      // **结果卡的标题不相对化**——`toolResultUpdate` 把 `view.title` 原样透传，
      // 没走 `displayTitle`。这里断言的是现状，不是认可：卡片在完成那一刻会从
      // 「Write b.ts」跳成「Wrote /很长的/绝对路径/b.ts」，而 paths.ts 给出的理由
      // （标题是给人看的）对结果侧同样成立。要改的是 src，不是这条断言。
      title: `Wrote ${file}`,
      // 结果侧也发 diff：否则模型可见的结果文本会把调用侧的 diff 冲掉
      content: [{ type: 'diff', path: file, oldText: null, newText: 'yo' }],
    })
    h.disposeBridge()
  })

  it('未注册的工具退回通用卡片，标题即工具名', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })

    const raw: Record<string, unknown>[] = []
    h.onUpdate((u) => raw.push(u as Record<string, unknown>))

    h.llm.toolCall = { id: 'c-3', name: 'nonexistent_tool', args: '{"a":1}' }
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: 'go' }],
    })
    await waitFor(() => raw.some((u) => u['sessionUpdate'] === 'tool_call'), 5_000, 'call card')

    // 工具不存在，调用会失败——但卡片必须照常出现，否则用户只看到一段停顿
    expect(raw.find((u) => u['sessionUpdate'] === 'tool_call')).toMatchObject({
      toolCallId: 'c-3',
      title: 'nonexistent_tool',
      kind: 'other',
    })
    h.disposeBridge()
  })

  it('两个会话的卡片互不串台', async () => {
    const h = await createHarness()
    h.ctx.tools.register(writeTool)
    const wsA = workspace()
    const wsB = workspace()
    const a = await h.acp.request('session/new', { cwd: wsA, mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: wsB, mcpServers: [] })

    h.llm.toolCall = { id: 'same-id', name: 'fake_write', args: JSON.stringify({ path: join(wsA, 'a.ts'), text: 'A' }) }
    await h.acp.request('session/prompt', { sessionId: a.sessionId as never, prompt: [{ type: 'text', text: 'x' }] })
    await waitFor(() => cards(h.updates).length >= 2, 5_000, 'session A cards')

    // 同一个 callId 在另一个会话再来一次：呈现器按会话持有，不该复用 A 的记录
    h.llm.toolCall = { id: 'same-id', name: 'fake_write', args: JSON.stringify({ path: join(wsB, 'b.ts'), text: 'B' }) }
    await h.acp.request('session/prompt', { sessionId: b.sessionId as never, prompt: [{ type: 'text', text: 'x' }] })
    await waitFor(() => cards(h.updates).length >= 4, 5_000, 'session B cards')

    for (const card of cards(h.updates)) {
      expect([a.sessionId, b.sessionId]).toContain(card.sessionId)
    }
    expect(cards(h.updates).filter((c) => c.sessionId === a.sessionId)).toHaveLength(2)
    expect(cards(h.updates).filter((c) => c.sessionId === b.sessionId)).toHaveLength(2)
    h.disposeBridge()
  })
})
