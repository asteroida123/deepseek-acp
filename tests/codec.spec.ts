/**
 * TC-CODEC-* —— 纯函数编解码。无任何运行时依赖。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { acpPromptToText, promptHasUnsupportedContent } from '../src/codec/prompt.js'
import { turnEndToStopReason } from '../src/codec/stop-reason.js'
import { mapEvent } from '../src/mapping/updates.js'
import { handleInitialize } from '../src/protocol/initialize.js'

describe('turnEndToStopReason', () => {
  it('把每个已知 TurnEndReason 映射为合法 StopReason', () => {
    const cases: Array<[TurnEndReason['kind'], string]> = [
      ['completed', 'end_turn'],
      ['max-tokens', 'max_tokens'],
      ['aborted', 'end_turn'],
      ['interrupted', 'cancelled'],
      ['blocked', 'end_turn'],
    ]
    for (const [kind, expected] of cases) {
      expect(turnEndToStopReason({ kind } as TurnEndReason), kind).toBe(expected)
    }
  })

  it('error 结束不产出误导性的 max_tokens/cancelled', () => {
    const reason = { kind: 'error', error: new Error('boom') } as unknown as TurnEndReason
    expect(turnEndToStopReason(reason)).toBe('end_turn')
  })

  it('对未来新增的 kind 回退 end_turn 而非抛错', () => {
    // TurnEndReason 可被插件声明合并扩展；抛错会让 prompt 永挂。
    const future = { kind: 'some-future-kind' } as unknown as TurnEndReason
    expect(turnEndToStopReason(future)).toBe('end_turn')
  })
})

describe('acpPromptToText', () => {
  it('按线序拼接 text 块', () => {
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]
    expect(acpPromptToText(prompt)).toBe('ab')
  })

  it('把 resource_link 渲染为显式文本引用而非丢弃', () => {
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'see ' },
      { type: 'resource_link', uri: 'file:///a/b.ts', name: 'b.ts' },
    ]
    const text = acpPromptToText(prompt)
    expect(text).toContain('resource_link')
    expect(text).toContain('file:///a/b.ts')
    expect(text).toContain('b.ts')
  })

  it('内嵌 resource 的文本整段内联 —— 这才是 embeddedContext 的用处', () => {
    // 它带得动**磁盘上没有**的内容：未保存的缓冲区、剪贴板片段、diff 视图里
    // 选中的一段。渲染成引用而非直接拼接，是为了让模型分得清哪段是附件。
    const prompt: ContentBlock[] = [
      { type: 'text', text: '看这个：' },
      { type: 'resource', resource: { uri: 'file:///a/b.ts', mimeType: 'text/x-typescript', text: 'const x = 1' } },
    ]
    const text = acpPromptToText(prompt)
    expect(text).toContain('const x = 1')
    expect(text).toContain('file:///a/b.ts')
    expect(text).toContain('text/x-typescript')
  })

  it('二进制 resource 渲染成引用，不把 base64 塞进提示词', () => {
    // 内联 base64 既贵又没用；但也**不能静默丢掉**——模型看得见「这有个附件
    // 我读不了」，比凭空少一段上下文强。
    const prompt: ContentBlock[] = [
      { type: 'resource', resource: { uri: 'file:///a/x.png', mimeType: 'image/png', blob: 'iVBORw0KGgo=' } },
    ]
    const text = acpPromptToText(prompt)
    expect(text).toContain('file:///a/x.png')
    expect(text).toContain('image/png')
    expect(text).not.toContain('iVBORw0KGgo=')
  })

  it('无文本块时返回空串', () => {
    expect(acpPromptToText([])).toBe('')
  })
})

describe('promptHasUnsupportedContent', () => {
  it('放行 text、resource_link 与内嵌 resource', () => {
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'x' },
      { type: 'resource_link', uri: 'file:///a', name: 'a' },
      { type: 'resource', resource: { uri: 'file:///b', text: 'y' } },
    ]
    expect(promptHasUnsupportedContent(prompt)).toBe(false)
  })

  it('识别出 audio —— 上游没有音频路由，它确实未 advertise', () => {
    expect(promptHasUnsupportedContent([{ type: 'audio', data: 'x', mimeType: 'audio/wav' }])).toBe(true)
  })

  it('放行 image —— 它能不能真的收下不是纯函数判得了的', () => {
    // 图片要不要拒绝取决于两件运行时的事：组合挂没挂附件服务、以及会话**当前**
    // 这条路由收不收图。所以这里放行，由 `handlePrompt` 用具体理由拒绝——那种
    // 拒绝说得出「换哪个模型」，而这里只能说「不支持」。
    expect(promptHasUnsupportedContent([{ type: 'image', data: 'x', mimeType: 'image/png' }])).toBe(false)
  })

  it('放行集合与 initialize 声明的能力**逐项一致**', () => {
    // 两处是同一件事的两半，分开写就会分叉：那边多声明一项而这边不放行，
    // 客户端收到的是「你说你支持」的困惑错误；这边多放行而那边不声明，
    // 规矩的客户端根本不会发过来。这条用例就是把它们钉在一起。
    //
    // `image: true` 是必须传的：它**按组合动态声明**（挂了附件服务才为真），
    // 而纯函数这边没有组合可看，恒放行。拿默认参数去比等于拿「没挂附件服务的
    // 部署」跟「放行集合」比，那两者本来就不该相等。
    const caps = handleInitialize({ persistent: false, image: true }).agentCapabilities
      ?.promptCapabilities
    const probe = (block: ContentBlock): boolean => !promptHasUnsupportedContent([block])
    expect(probe({ type: 'image', data: 'x', mimeType: 'image/png' })).toBe(caps?.image ?? false)
    expect(probe({ type: 'audio', data: 'x', mimeType: 'audio/wav' })).toBe(caps?.audio ?? false)
    expect(probe({ type: 'resource', resource: { uri: 'file:///a', text: 'x' } })).toBe(
      caps?.embeddedContext ?? false,
    )
  })

  it('没挂附件服务时 initialize 不声明 image', () => {
    // 与上面那条互补：动态声明真的是动态的，不是恒 true。
    expect(handleInitialize().agentCapabilities?.promptCapabilities?.image).toBe(false)
  })
})

describe('mapEvent', () => {
  const chunkEvent = (chunk: unknown, turn = 1, step = 1) =>
    ({ type: 'assistant/chunk', data: { turn, step, chunk } }) as never

  it('把 text-delta 映射为 agent_message_chunk（增量，US-03）', () => {
    const updates = mapEvent(chunkEvent({ type: 'text-delta', text: 'hi' }))
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: '1:1', content: { type: 'text', text: 'hi' } },
    ])
  })

  it('把 reasoning-delta 映射为 agent_thought_chunk', () => {
    const updates = mapEvent(chunkEvent({ type: 'reasoning-delta', text: 'think' }))
    expect(updates).toEqual([
      { sessionUpdate: 'agent_thought_chunk', messageId: '1:1', content: { type: 'text', text: 'think' } },
    ])
  })

  it('正文与推理共享同一个 messageId，换一步就换一个', () => {
    // ACP 对 `messageId` 的语义是「值变了即新消息开始」。推理与正文属于同一条
    // 助手消息，必须同 id；下一步（工具跑完之后那次模型调用）才是新消息。
    const same = (chunk: unknown, turn?: number, step?: number): unknown =>
      (mapEvent(chunkEvent(chunk, turn, step))[0] as { messageId?: string }).messageId
    expect(same({ type: 'text-delta', text: 'a' })).toBe(same({ type: 'reasoning-delta', text: 'b' }))
    expect(same({ type: 'text-delta', text: 'a' })).not.toBe(same({ type: 'text-delta', text: 'a' }, 1, 2))
    expect(same({ type: 'text-delta', text: 'a' })).not.toBe(same({ type: 'text-delta', text: 'a' }, 2, 1))
  })

  it('非文本增量（如 block-start）不产出更新', () => {
    expect(mapEvent(chunkEvent({ type: 'block-start' }))).toEqual([])
  })

  it('未知事件类型静默忽略而非抛错', () => {
    // SessionEventMap 由各插件声明合并，组合可插拔，未知事件是正常状态。
    expect(() => mapEvent({ type: 'some/future-event', data: {} } as never)).not.toThrow()
    expect(mapEvent({ type: 'some/future-event', data: {} } as never)).toEqual([])
  })

  it('是事件的纯函数：同一输入恒产出相等输出（TC-PROP-03 基础）', () => {
    const event = chunkEvent({ type: 'text-delta', text: 'same' })
    expect(mapEvent(event)).toEqual(mapEvent(event))
  })
})
