/**
 * TC-WS-* —— 会话工作区上下文。
 *
 * 起因是一次真实观察：模型在 codeg 里回「Since I don't know the context」。
 * dump 出来的 system prompt 只有一句 harness 身份——组合里没有任何东西告诉
 * 模型它在哪个目录。这些用例把「每个会话都拿到自己的工作区事实」钉住。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { WORKSPACE_ORDER, WORKSPACE_SECTION, localDate, renderWorkspace } from '../src/composition/workspace.js'
import { createHarness } from './harness.js'

describe('TC-WS-01 renderWorkspace 纯函数', () => {
  it('陈述 cwd、平台与日期', () => {
    const text = renderWorkspace({ cwd: '/a/b', platform: 'linux', date: '2026-08-14' })
    expect(text).toContain('/a/b')
    expect(text).toContain('linux')
    expect(text).toContain('2026-08-14')
  })

  it('不含 {{}}，否则会被 system-prompt 的严格变量插值当成未知引用而抛错', () => {
    const text = renderWorkspace({ cwd: '/a/{{b}}', platform: 'darwin', date: '2026-08-14' })
    // cwd 由客户端提供，理论上可以含 {{ —— 章节本身的模板不该再引入更多
    expect(text.replace(/\/a\/\{\{b\}\}/g, '')).not.toContain('{{')
  })

  it('不承诺任何工具能力', () => {
    const text = renderWorkspace({ cwd: '/a', platform: 'darwin', date: '2026-08-14' })
    for (const claim of ['可以读', '可以运行', '可以执行', '你能读取']) {
      expect(text, `M1-a 无工具，不得暗示：${claim}`).not.toContain(claim)
    }
  })
})

describe('TC-WS-02 localDate 取本地日期', () => {
  it('补零到 YYYY-MM-DD', () => {
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(localDate(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('用本地时区而非 UTC —— 模型要对齐的是用户的「今天」', () => {
    // 本地时间当日 00:30；UTC 下可能已是前一天
    const local = new Date(2026, 7, 14, 0, 30)
    expect(localDate(local)).toBe('2026-08-14')
  })
})

describe('TC-WS-03 工作区章节按会话隔离', () => {
  it('每个会话拿到自己的 cwd，且不泄漏到全局', async () => {
    const h = await createHarness()
    const cwdA = join(tmpdir(), 'ws-a')
    const cwdB = join(tmpdir(), 'ws-b')

    const a = await h.acp.request('session/new', { cwd: cwdA, mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: cwdB, mcpServers: [] })

    const agentA = h.ctx.agents.get(a.sessionId as never)
    const agentB = h.ctx.agents.get(b.sessionId as never)
    if (agentA === undefined || agentB === undefined) throw new Error('agent 未创建')

    const promptA = renderPrompt(await h.ctx.systemPrompt.assemble({ scope: agentA }))
    const promptB = renderPrompt(await h.ctx.systemPrompt.assemble({ scope: agentB }))
    const promptGlobal = renderPrompt(await h.ctx.systemPrompt.assemble())

    expect(promptA).toContain(cwdA)
    expect(promptA).not.toContain(cwdB)
    expect(promptB).toContain(cwdB)
    expect(promptB).not.toContain(cwdA)
    // 未注册到全局层：否则后建的会话会覆盖先建的
    expect(promptGlobal).not.toContain(cwdA)
    expect(promptGlobal).not.toContain(cwdB)

    h.disposeBridge()
  })

  it('章节顺序排在 persona 之后、工具指引之前', () => {
    expect(WORKSPACE_ORDER).toBeGreaterThan(0)
    expect(WORKSPACE_ORDER).toBeLessThan(100)
    expect(WORKSPACE_SECTION.startsWith('deepseek-acp:')).toBe(true)
  })
})
