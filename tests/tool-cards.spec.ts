/**
 * TC-CARD-* —— 工具卡片的端到端。
 *
 * 前面的 presentation.spec 全是纯函数；这里让**真实的 agent loop** 跑一次真实
 * 的工具调用，验证事件→卡片这条链在真实事件形状下也成立。上游把 `tool/result`
 * 的载荷从 `{callId, content, isError}` 换成 `{message: ToolResultMessage}` 过一次，
 * 纯函数测试用手写事件是发现不了这种漂移的。
 */

import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHarness, waitFor, type CapturedUpdate } from './harness.js'

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
    const { sessionId } = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })

    h.llm.toolCall = { id: 'c-1', name: 'fake_write', args: JSON.stringify({ path: '/tmp/a.ts', text: 'hi' }) }
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
    const { sessionId } = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })

    const raw: Record<string, unknown>[] = []
    h.onUpdate((u) => raw.push(u as Record<string, unknown>))

    h.llm.toolCall = { id: 'c-2', name: 'fake_write', args: JSON.stringify({ path: '/tmp/b.ts', text: 'yo' }) }
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '写个文件' }],
    })
    await waitFor(() => raw.filter((u) => u['sessionUpdate'] === 'tool_call_update').length >= 1, 5_000, 'result card')

    const call = raw.find((u) => u['sessionUpdate'] === 'tool_call')
    expect(call).toMatchObject({
      toolCallId: 'c-2',
      title: 'Write /tmp/b.ts',
      kind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: '/tmp/b.ts', oldText: null, newText: 'yo' }],
      locations: [{ path: '/tmp/b.ts' }],
    })

    const done = raw.find((u) => u['sessionUpdate'] === 'tool_call_update')
    expect(done).toMatchObject({
      toolCallId: 'c-2',
      status: 'completed',
      title: 'Wrote /tmp/b.ts',
      // 结果侧也发 diff：否则模型可见的结果文本会把调用侧的 diff 冲掉
      content: [{ type: 'diff', path: '/tmp/b.ts', oldText: null, newText: 'yo' }],
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
    const a = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: tmpdir(), mcpServers: [] })

    h.llm.toolCall = { id: 'same-id', name: 'fake_write', args: JSON.stringify({ path: '/tmp/a.ts', text: 'A' }) }
    await h.acp.request('session/prompt', { sessionId: a.sessionId as never, prompt: [{ type: 'text', text: 'x' }] })
    await waitFor(() => cards(h.updates).length >= 2, 5_000, 'session A cards')

    // 同一个 callId 在另一个会话再来一次：呈现器按会话持有，不该复用 A 的记录
    h.llm.toolCall = { id: 'same-id', name: 'fake_write', args: JSON.stringify({ path: '/tmp/b.ts', text: 'B' }) }
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
