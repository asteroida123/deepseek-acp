/**
 * TC-FORKPT-* —— `_meta.jetbrains.air.fork` 的读取与解析（`src/session/fork-point.ts`）。
 *
 * 这个模块是**跨实现的线上约定**，不是本仓库自己的内部函数：claude-agent-acp 与
 * codex-acp 读同一个块，codeg 是发送方。因此用例钉的是「与那三边对得上」，而不只是
 * 「自洽」——尤其两处：
 *
 *  1. **两种指纹口径都要认。** 同一个客户端对不同 agent 用的气泡粒度不一样：codeg
 *     把 Codex 的每条助手消息渲染成一个气泡，却把 DeepSeek 一整个回合的助手输出并
 *     成一个。只认前者，多步回合在 codeg 上永远匹配不上。
 *  2. **认不出来要抛得出分诊得了的类型。** 裸 `Error` 会被 `session/fork` 的失败
 *     分诊当成「父会话不在了」改判成 `-32002`，客户端据此把一条好端端的会话摘掉。
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ForkPointUnresolved,
  assistantMessageId,
  fingerprintAgentMessage,
  forkPointBoundary,
  readForkPoint,
  type ForkPoint,
} from '../src/session/fork-point.js'

/** 一步：该步助手消息的持久 id 与它的文本块。 */
interface Step {
  readonly id: string
  readonly texts: readonly string[]
}

/**
 * 造一段事件日志，seq 与下标一致（真实日志也是连续的，上游 `_forkSeed` 为此断言过）。
 * @param turns - 逐回合的步；`closed: false` 表示这个回合没有 `turn/end`
 */
function buildLog(turns: readonly { readonly steps: readonly Step[]; readonly closed?: boolean }[]): SessionEvent[] {
  const events: SessionEvent[] = []
  const push = (type: string, data: unknown): void => {
    events.push({ type, seq: events.length, time: 0, data } as never)
  }
  turns.forEach((turn, index) => {
    const number = index + 1
    push('turn/start', { turn: number })
    turn.steps.forEach((step, stepIndex) => {
      push('assistant/message', {
        turn: number,
        step: stepIndex + 1,
        message: {
          id: step.id,
          role: 'assistant',
          content: step.texts.map((text) => ({ type: 'text', text })),
        },
      })
    })
    if (turn.closed !== false) push('turn/end', { turn: number, reason: { kind: 'done' } })
  })
  return events
}

/** 截到的那个边界属于哪个回合——用例真正关心的是这个，不是下标。 */
function boundaryTurn(events: readonly SessionEvent[], boundary: number): number {
  const event = events[boundary]
  expect(event?.type, '边界必须落在 turn/end 上').toBe('turn/end')
  return (event as { data: { turn: number } }).data.turn
}

const point = (messageId: string, fingerprint?: string, occurrence = 1): ForkPoint => ({
  messageId,
  ...(fingerprint === undefined ? {} : { messageFingerprint: fingerprint }),
  messageOccurrence: occurrence,
})

/** 三步一问一答一问的日志：回合 1 单步，回合 2 两步，回合 3 单步。 */
const sample = (): SessionEvent[] =>
  buildLog([
    { steps: [{ id: 'msg-a', texts: ['第一轮回答'] }] },
    {
      steps: [
        { id: 'msg-b', texts: ['第二轮', '前半'] },
        { id: 'msg-c', texts: ['后半'] },
      ],
    },
    { steps: [{ id: 'msg-d', texts: ['第三轮回答'] }] },
  ])

describe('TC-FORKPT-01 readForkPoint', () => {
  const meta = (fork: unknown): Record<string, unknown> => ({ jetbrains: { air: { fork } } })

  it.each([
    ['整个 _meta 缺席', undefined],
    ['_meta 是 null', null],
    ['没有 jetbrains 这一层', { other: 1 }],
    ['jetbrains 下没有 air', { jetbrains: {} }],
    ['fork 块是数组不是对象', meta([])],
    // 版本不认识时**静默忽略**：`_meta` 按规范就是实现方可以互相不认识的地方，
    // 为一个读不懂的扩展块拒绝整次 fork，等于让装了新客户端的用户连普通分叉都
    // 做不了。
    ['版本号不是 1', meta({ version: 2, messageId: 'x' })],
    ['版本号缺席', meta({ messageId: 'x' })],
  ])('%s → 当作没给（走尾部 fork）', (_name, input) => {
    expect(readForkPoint(input)).toBeUndefined()
  })

  it('版本对得上时读出三个字段，occurrence 默认 1', () => {
    const fingerprint = fingerprintAgentMessage('abc')
    expect(readForkPoint(meta({ version: 1, messageId: ' 3:1 ', messageFingerprint: fingerprint }))).toEqual({
      messageId: '3:1',
      messageFingerprint: fingerprint,
      messageOccurrence: 1,
    })
  })

  it('指纹缺席时字段不出现，而不是 undefined 占位', () => {
    expect(readForkPoint(meta({ version: 1, messageId: '3:1' }))).toEqual({
      messageId: '3:1',
      messageOccurrence: 1,
    })
  })

  it.each([
    ['messageId 不是字符串', { version: 1, messageId: 7 }, /messageId/],
    ['messageId 是空白', { version: 1, messageId: '   ' }, /messageId/],
    ['指纹没有 sha256 前缀', { version: 1, messageId: 'x', messageFingerprint: 'ab'.repeat(32) }, /Fingerprint/],
    ['指纹是大写十六进制', { version: 1, messageId: 'x', messageFingerprint: `sha256:${'AB'.repeat(32)}` }, /Fingerprint/],
    ['指纹长度不对', { version: 1, messageId: 'x', messageFingerprint: 'sha256:abc' }, /Fingerprint/],
    ['occurrence 是 0', { version: 1, messageId: 'x', messageOccurrence: 0 }, /Occurrence/],
    ['occurrence 是小数', { version: 1, messageId: 'x', messageOccurrence: 1.5 }, /Occurrence/],
    ['occurrence 是字符串', { version: 1, messageId: 'x', messageOccurrence: '2' }, /Occurrence/],
  ])('块在但 %s → 抛 -32602', (_name, fork, pattern) => {
    // 与上面那组相反：块**在**且版本对得上，说明客户端明确要求在某条消息上分叉。
    // 这时字段坏了还悄悄给它一个尾部 fork，是拿另一件事冒充成功。
    let failure: { code?: number; message?: string } | undefined
    try {
      readForkPoint(meta(fork))
    } catch (error: unknown) {
      failure = error as never
    }
    expect(failure, '这次读取本该失败').toBeDefined()
    expect(failure?.code).toBe(-32602)
    expect(failure?.message).toMatch(pattern)
  })
})

describe('TC-FORKPT-02 按 id 解析', () => {
  it('认我们自己发出去的 `<turn>:<step>`', () => {
    const events = sample()
    // 这个形式就是 `agent_message_chunk.messageId` 上的那个值，客户端原样送回来。
    expect(boundaryTurn(events, forkPointBoundary(events, point(assistantMessageId(2, 1))))).toBe(2)
  })

  it('也认日志里那条持久 message id', () => {
    // 留给直接读 JSONL 的客户端——codeg 就是这么认识一条 DeepSeek 会话的，它根本
    // 不从 ACP 更新里取气泡。
    const events = sample()
    expect(boundaryTurn(events, forkPointBoundary(events, point('msg-a')))).toBe(1)
  })

  it('剥掉结尾的 `:segment:<n>` 再比', () => {
    // 老客户端会把可见分段序号缀在 id 后面；另外两个适配器也都先剥再比。
    const events = sample()
    expect(boundaryTurn(events, forkPointBoundary(events, point('msg-d:segment:3')))).toBe(3)
  })

  it('回合内任意一步的 id 都截到同一个回合末尾', () => {
    // 分叉点的意义是「这条回答之后换个方向」，而同回合后面的工具调用与结果属于
    // 这次回答；截在消息本身上会留下一串没有结果的调用。
    const events = sample()
    const first = forkPointBoundary(events, point('msg-b'))
    const second = forkPointBoundary(events, point('msg-c'))
    expect(first).toBe(second)
    expect(boundaryTurn(events, first)).toBe(2)
  })

  it('id 命中就不看指纹 —— 两者指向不同回合时以 id 为准', () => {
    const events = sample()
    const boundary = forkPointBoundary(events, point('msg-a', fingerprintAgentMessage('第三轮回答')))
    expect(boundaryTurn(events, boundary)).toBe(1)
  })
})

describe('TC-FORKPT-03 按指纹解析', () => {
  it('逐条助手消息的口径（codex-acp 那一档）', () => {
    const events = sample()
    const boundary = forkPointBoundary(events, point('客户端自己的 id', fingerprintAgentMessage('第一轮回答')))
    expect(boundaryTurn(events, boundary)).toBe(1)
  })

  it('逐回合拼接的口径（codeg 渲染 DeepSeek 那一档）', () => {
    // 回合 2 有两步，codeg 把它渲染成**一个**气泡，指纹算的是全回合文本。少了这
    // 一档，多步回合在 codeg 上永远匹配不上。
    const events = sample()
    const boundary = forkPointBoundary(events, point('x', fingerprintAgentMessage('第二轮前半后半')))
    expect(boundaryTurn(events, boundary)).toBe(2)
  })

  it('同样的回答重复出现时，occurrence 选中第几个', () => {
    const events = buildLog([
      { steps: [{ id: 'a', texts: ['一样的话'] }] },
      { steps: [{ id: 'b', texts: ['别的'] }] },
      { steps: [{ id: 'c', texts: ['一样的话'] }] },
    ])
    const fingerprint = fingerprintAgentMessage('一样的话')
    expect(boundaryTurn(events, forkPointBoundary(events, point('x', fingerprint, 1)))).toBe(1)
    expect(boundaryTurn(events, forkPointBoundary(events, point('x', fingerprint, 2)))).toBe(3)
  })

  it('occurrence 超出命中条数时不回退到最后一条', () => {
    const events = sample()
    expect(() =>
      forkPointBoundary(events, point('x', fingerprintAgentMessage('第一轮回答'), 2)),
    ).toThrow(ForkPointUnresolved)
  })

  it('空白文本块不参与拼接 —— 与 codeg 解析器逐条对齐', () => {
    // codeg 的解析器对 `trim()` 为空的文本块直接 `continue`，指纹要对得上就得
    // 照着跳过。
    const events = buildLog([{ steps: [{ id: 'a', texts: ['前', '   ', '后'] }] }])
    const boundary = forkPointBoundary(events, point('x', fingerprintAgentMessage('前后')))
    expect(boundaryTurn(events, boundary)).toBe(1)
  })

  it('没有可见文本的助手消息不是候选 —— 空串指纹不该扫中它们', () => {
    // 纯工具调用的那一步没有文本。若把它算成一个「文本为空」的候选，一个
    // `sha256("")` 就能扫中会话里所有这样的步。
    const events = buildLog([
      { steps: [{ id: 'a', texts: [] }] },
      { steps: [{ id: 'b', texts: ['有话说'] }] },
    ])
    expect(() => forkPointBoundary(events, point('x', fingerprintAgentMessage('')))).toThrow(ForkPointUnresolved)
  })

  it('两种口径指向不同回合时拒绝，而不是挑先查到的那个', () => {
    // 客户端按哪种粒度算的指纹，我们无从得知，所以「先查到的」不是答案：
    //   回合 1 两步 `same` / `other`（整回合文本 `sameother`）；回合 2 只有 `same`。
    // 一个按回合算指纹的客户端（codeg 渲染 DeepSeek 就是这样）选中回合 2 发来
    // `sha256("same")` occurrence 1 —— 逐条那一档却会先在回合 1 命中。挑它等于
    // fork 成功了、选中的那一轮却不在里面，是本模块最该避免的那种失败。
    const events = buildLog([
      {
        steps: [
          { id: 'a', texts: ['same'] },
          { id: 'b', texts: ['other'] },
        ],
      },
      { steps: [{ id: 'c', texts: ['same'] }] },
    ])
    expect(() => forkPointBoundary(events, point('客户端自己的 id', fingerprintAgentMessage('same')))).toThrow(
      /ambiguous/,
    )
    expect(() => forkPointBoundary(events, point('客户端自己的 id', fingerprintAgentMessage('same')))).toThrow(
      ForkPointUnresolved,
    )
  })

  it('反向的碰撞同样拒绝 —— 谁先查不影响结论', () => {
    // 镜像场景：这次是**整回合**那一档会先在回合 1 命中，而逐条那一档指的是回合 2。
    // 换个先后顺序就能「修好」其中一个方向、悄悄留下另一个，所以两边都要钉。
    const events = buildLog([
      {
        steps: [
          { id: 'a', texts: ['a'] },
          { id: 'b', texts: ['b'] },
        ],
      },
      { steps: [{ id: 'c', texts: ['ab'] }] },
    ])
    // 逐条那一档指回合 2（`ab` 是它的第一条同文本消息），整回合那一档指回合 1
    // （拼出来也是 `ab`，且排在前面）。
    expect(() => forkPointBoundary(events, point('x', fingerprintAgentMessage('ab')))).toThrow(/ambiguous/)
  })

  it('两种口径指向同一个回合时照常放行', () => {
    // 对照组：碰撞发生在**同一个回合内**（单步回合下两档本来就同文本），没有歧义
    // 可言，不该被上面那条拒绝顺手误伤。
    const events = buildLog([
      { steps: [{ id: 'a', texts: ['独一份'] }] },
      { steps: [{ id: 'b', texts: ['别的'] }] },
    ])
    expect(boundaryTurn(events, forkPointBoundary(events, point('x', fingerprintAgentMessage('独一份'))))).toBe(1)
  })

  it('只有一档命中时不受歧义规则影响', () => {
    // 多步回合的整回合文本没有任何单条消息与之相同，因此只有整回合那一档中。
    const events = sample()
    const boundary = forkPointBoundary(events, point('x', fingerprintAgentMessage('第二轮前半后半')))
    expect(boundaryTurn(events, boundary)).toBe(2)
  })

  it('指纹是仓库外算好的 sha256，实现换了算法不能靠自证通过', () => {
    expect(fingerprintAgentMessage('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('TC-FORKPT-04 拒绝路径', () => {
  it('认不出这条消息时抛 ForkPointUnresolved（不是裸 Error）', () => {
    // 类型本身是契约：`session/fork` 靠 `instanceof` 把它与「父会话不在了」分开，
    // 分不开就会把 `-32602` 报成 `-32002`，客户端据此摘掉一条好会话。
    const events = sample()
    expect(() => forkPointBoundary(events, point('从来没有过的 id'))).toThrow(ForkPointUnresolved)
    expect(() => forkPointBoundary(events, point('从来没有过的 id'))).toThrow(/was not found/)
  })

  it('给了指纹但两种口径都不中，同样是认不出来', () => {
    const events = sample()
    expect(() => forkPointBoundary(events, point('x', fingerprintAgentMessage('没说过的话')))).toThrow(
      ForkPointUnresolved,
    )
  })

  it('消息所在回合没闭合时拒绝，而不是悄悄退到上一个完整回合', () => {
    // 用户指名了一个点，给他另一个点却报成功，比让他换一条消息重试坏得多。
    const events = buildLog([
      { steps: [{ id: 'a', texts: ['第一轮'] }] },
      { steps: [{ id: 'b', texts: ['崩在这里'] }], closed: false },
    ])
    expect(() => forkPointBoundary(events, point('b'))).toThrow(/never closed/)
    // 对照：同一段日志里，第一个回合仍然是可用的分叉点。
    expect(boundaryTurn(events, forkPointBoundary(events, point('a')))).toBe(1)
  })

  it('父会话一条事件都没有时也是认不出来', () => {
    expect(() => forkPointBoundary([], point('任意'))).toThrow(ForkPointUnresolved)
  })
})
