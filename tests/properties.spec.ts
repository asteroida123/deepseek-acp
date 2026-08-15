/**
 * TC-PROP-01~03 —— 映射层的三条不变量，以**随机事件序列**断言。
 *
 * 为什么这三条必须是属性测试而不是样例测试：它们说的都是「对**任何**事件序列
 * 都成立」，而样例测试只能证明「对我想到的那几串成立」。映射层现在有 9 种输出
 * 变体、十几个分支，手工样例的覆盖面每加一个分支就稀一分。
 *
 * 移植自上游那份已删除的编辑器 bridge 的同名用例，但**不是照搬**：
 * 那边的合法变体只有 4 种、事件只有 4 类，本 bridge 已长到 9 种变体，
 * 且多了用量、标题、模式、计划、命令这几条各有条件的路径。生成器与不变量都按
 * 当前映射面重写。
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mapEvent, type MappingContext } from '../src/mapping/updates.js'
import { ToolPresenter } from '../src/presentation/presenter.js'

/**
 * `mapEvent` 允许产出的全部变体。
 *
 * **不含 `available_commands_update`**：命令目录不由事件推导，是
 * `refreshCommands` 在建会话与命令面变动时直接推的整份快照（见
 * `src/protocol/session-commands.ts`），走的不是这条链。
 */
const LEGAL_UPDATE_KINDS = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'current_mode_update',
  'session_info_update',
  'usage_update',
])

/** 生成器产出的动作；`actionsToEvents` 再把它降成真实事件。 */
type Action =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'call'; id: string; name: string }
  | { kind: 'result'; idx: number; isError: boolean }
  | { kind: 'usage'; input: number; output: number; cacheRead: number }
  | { kind: 'user'; text: string; source: 'user' | 'plugin' }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'commandDone'; text: string }
  | { kind: 'mode'; active: boolean }
  | { kind: 'title'; title: string; time: number }
  | { kind: 'todos'; count: number }
  | { kind: 'unknown' }

function actionsArb(): fc.Arbitrary<Action[]> {
  // **给工具调用加权**：`result` 只有在同一序列里已经出现过 `call` 时才落地成
  // 事件，等权重下 `tool_call_update` 在整轮里只出现个位数次——而 TC-PROP-02
  // 守的正是它。加权把它抬到与其它变体同一量级；下面的覆盖用例负责盯住这件事
  // 不再退化。
  const action: fc.Arbitrary<Action> = fc.oneof(
    { arbitrary: fc.string().map((text): Action => ({ kind: 'text', text })), weight: 1 },
    { arbitrary: fc.string().map((text): Action => ({ kind: 'reasoning', text })), weight: 1 },
    {
      arbitrary: fc
        .record({ id: fc.string({ minLength: 1 }), name: fc.string() })
        .map(({ id, name }): Action => ({ kind: 'call', id, name })),
      weight: 4,
    },
    {
      arbitrary: fc
        .record({ idx: fc.nat(), isError: fc.boolean() })
        .map(({ idx, isError }): Action => ({ kind: 'result', idx, isError })),
      weight: 4,
    },
  )
  return fc.array(fc.oneof(action, otherActions()), { maxLength: 40 })
}

/** 除工具调用外的其余动作，等权重。 */
function otherActions(): fc.Arbitrary<Action> {
  return fc.oneof(
    fc
      .record({ input: fc.nat({ max: 1e6 }), output: fc.nat({ max: 1e6 }), cacheRead: fc.nat({ max: 1e6 }) })
      .map((u): Action => ({ kind: 'usage', ...u })),
    fc
      .record({ text: fc.string(), source: fc.constantFrom<'user' | 'plugin'>('user', 'plugin') })
      .map((u): Action => ({ kind: 'user', ...u })),
    fc
      .record({ name: fc.string({ minLength: 1 }), args: fc.string() })
      .map((c): Action => ({ kind: 'command', ...c })),
    fc.string().map((text): Action => ({ kind: 'commandDone', text })),
    fc.boolean().map((active): Action => ({ kind: 'mode', active })),
    fc
      .record({ title: fc.string(), time: fc.nat({ max: 2e12 }) })
      .map((t): Action => ({ kind: 'title', ...t })),
    fc.nat({ max: 5 }).map((count): Action => ({ kind: 'todos', count })),
    fc.constant<Action>({ kind: 'unknown' }),
  )
}

/**
 * 把动作降成一串**良构**的事件。
 *
 * 「良构」指 `tool/result` 只引用先前已开过的 `tool/call`——这与 agent loop
 * 实际写日志的顺序一致。对完全随机的噪声断言顺序不变量没有意义：那测的是
 * 「垃圾进垃圾出」，而不是本层的行为。
 */
function actionsToEvents(actions: Action[]): SessionEvent[] {
  const events: SessionEvent[] = []
  const openCalls: string[] = []
  const push = (event: unknown): void => {
    events.push(event as SessionEvent)
  }
  for (const a of actions) {
    switch (a.kind) {
      case 'text':
        push({
          type: 'assistant/chunk',
          seq: 0,
          time: 0,
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: a.text } },
        })
        break
      case 'reasoning':
        push({
          type: 'assistant/chunk',
          seq: 0,
          time: 0,
          data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: a.text } },
        })
        break
      case 'call':
        openCalls.push(a.id)
        push({
          type: 'tool/call',
          seq: 0,
          time: 0,
          data: { turn: 1, step: 1, callId: a.id, name: a.name, arguments: '{}' },
        })
        break
      case 'result': {
        if (openCalls.length === 0) break
        const id = openCalls[a.idx % openCalls.length]
        push({
          type: 'tool/result',
          seq: 0,
          time: 0,
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: `r-${id}`,
              role: 'tool',
              content: [{ type: 'tool-result', toolCallId: id, content: [], isError: a.isError }],
            },
          },
        })
        break
      }
      case 'usage':
        push({
          type: 'assistant/message',
          seq: 0,
          time: 0,
          data: {
            turn: 1,
            step: 1,
            message: { id: 'm', role: 'assistant', content: [] },
            usage: {
              inputTokens: a.input,
              outputTokens: a.output,
              cacheReadTokens: a.cacheRead,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          },
        })
        break
      case 'user':
        push({
          type: 'user/message',
          seq: 0,
          time: 0,
          data: {
            id: 'u',
            role: 'user',
            source: { kind: a.source },
            content: [{ type: 'text', text: a.text }],
          },
        })
        break
      case 'command':
        push({ type: 'command/run', seq: 0, time: 0, data: { name: a.name, args: a.args } })
        break
      case 'commandDone':
        push({ type: 'command/done', seq: 0, time: 0, data: { name: 'c', ok: true, text: a.text } })
        break
      case 'mode':
        push({ type: 'plan/mode', seq: 0, time: 0, data: { active: a.active } })
        break
      case 'title':
        push({ type: 'session/title', seq: 0, time: a.time, data: { title: a.title } })
        break
      case 'todos':
        push({
          type: 'todo/write',
          seq: 0,
          time: 0,
          data: {
            todos: Array.from({ length: a.count }, (_, i) => ({
              content: `t${i}`,
              status: i === 0 ? 'in_progress' : 'pending',
            })),
          },
        })
        break
      case 'unknown':
        // 组合可插拔，出现本 bridge 不认识的事件是**正常状态**（详设 §4.3）。
        push({ type: 'turn/end', seq: 0, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
        break
    }
  }
  return events
}

/**
 * 跑一遍映射。
 *
 * **每次都新建 presenter**：它持有待决调用表，是这条链上唯一的可变状态。
 * 「重放等于实时」要成立的正是「同一批事件 + 同一个初始状态 → 同一批更新」，
 * 复用 presenter 就把这条不变量测成了别的东西。
 */
function runStream(events: readonly SessionEvent[], context: MappingContext = {}): SessionUpdate[] {
  const presenter = new ToolPresenter(undefined)
  const out: SessionUpdate[] = []
  for (const event of events) out.push(...mapEvent(event, { presenter, ...context }))
  return out
}

describe('TC-PROP-00 生成器确实覆盖了整个映射面', () => {
  it('每一种合法变体都真的被产出过 —— 否则上面三条不变量是空的', () => {
    // **这条守的是其余三条本身。** 「不会产出非法变体」在一个从不产出任何东西
    // 的序列上平凡成立；「call 先于 update」在从没出现过 update 的序列上同理。
    // 属性测试最典型的失效方式不是断错，是生成器覆盖不到——而那不会变红。
    //
    // 它同时也是映射面变动的提醒：往 `mapEvent` 加一个新变体、却忘了给生成器
    // 加对应动作时，这条会指名道姓地说少了哪个。
    const seen = new Set<string>()
    fc.assert(
      fc.property(actionsArb(), fc.boolean(), (actions, replay) => {
        for (const update of runStream(actionsToEvents(actions), {
          replay,
          contextWindow: () => 200_000,
        })) {
          seen.add(update.sessionUpdate)
        }
      }),
    )
    const missing = [...LEGAL_UPDATE_KINDS].filter((kind) => !seen.has(kind))
    expect(missing, '生成器从未产出这些变体').toEqual([])
  })
})

describe('TC-PROP-01 每条更新都是合法变体', () => {
  it('任意事件序列都不会产出映射面之外的 sessionUpdate', () => {
    fc.assert(
      fc.property(actionsArb(), fc.boolean(), (actions, replay) => {
        for (const update of runStream(actionsToEvents(actions), {
          replay,
          contextWindow: () => 200_000,
        })) {
          expect(LEGAL_UPDATE_KINDS.has(update.sessionUpdate)).toBe(true)
        }
      }),
    )
  })

  it('usage_update 的 used 永不为负，且 size 恒为正', () => {
    // 分母是除法的分母：`size <= 0` 会让客户端画出一根除零的进度条，所以
    // 映射层的约定是**分母不知道就整条不发**。这里同时钉住分子非负——
    // 输入侧三项相加一旦写错符号，表现是进度条倒着走。
    fc.assert(
      fc.property(actionsArb(), (actions) => {
        for (const update of runStream(actionsToEvents(actions), { contextWindow: () => 200_000 })) {
          if (update.sessionUpdate !== 'usage_update') continue
          expect(update.used).toBeGreaterThanOrEqual(0)
          expect(update.size).toBeGreaterThan(0)
        }
      }),
    )
  })
})

describe('TC-PROP-02 tool_call 先于它的 tool_call_update', () => {
  it('任意良构序列下，没有哪个 id 会先收到 update', () => {
    // 客户端拿 `toolCallId` 找卡片。先来 update 的话它要么丢弃、要么凭空造一张
    // 没有标题没有参数的卡片——两种都比崩溃更难查。
    fc.assert(
      fc.property(actionsArb(), (actions) => {
        const announced = new Set<string>()
        for (const update of runStream(actionsToEvents(actions))) {
          if (update.sessionUpdate === 'tool_call') announced.add(String(update.toolCallId))
          else if (update.sessionUpdate === 'tool_call_update') {
            expect(announced.has(String(update.toolCallId))).toBe(true)
          }
        }
      }),
    )
  })
})

describe('TC-PROP-03 映射是事件的纯函数（重放等于实时）', () => {
  it('同一批事件跑两遍，输出逐字节相同', () => {
    // 这是**整个 bridge 的核心约束**：`session/load` 的重放与实时流走的是同一个
    // `mapEvent`，所以「恢复出来的会话和当时看到的一样」不是靠两处代码保持同步
    // 维持的，而是结构上不可能分叉。这条用例存在，那个结构就不会被悄悄破坏
    // （比如有人在映射里读一次 `Date.now()`，或把状态挪到模块级）。
    fc.assert(
      fc.property(actionsArb(), fc.boolean(), (actions, replay) => {
        const events = actionsToEvents(actions)
        const context = { replay, contextWindow: () => 200_000 }
        expect(runStream(events, context)).toEqual(runStream(events, context))
      }),
    )
  })

  it('replay 只改变用户侧回显，不改变助手侧的任何一条', () => {
    // 两个模式的差别必须**恰好**是 `user_message_chunk`（用户消息与命令行回显）。
    // 多一条少一条都意味着重放出来的对话与当时不同——而那正是最难发现的那类
    // 缺陷：它只在用户重开旧会话时才显形。
    fc.assert(
      fc.property(actionsArb(), (actions) => {
        const events = actionsToEvents(actions)
        const window = { contextWindow: () => 200_000 }
        const live = runStream(events, { ...window, replay: false })
        const replayed = runStream(events, { ...window, replay: true })
        const withoutUser = (updates: SessionUpdate[]): SessionUpdate[] =>
          updates.filter((u) => u.sessionUpdate !== 'user_message_chunk')
        expect(withoutUser(replayed)).toEqual(withoutUser(live))
        // 且方向是单调的：重放只会**多**出用户侧回显，不会少。
        expect(replayed.length).toBeGreaterThanOrEqual(live.length)
      }),
    )
  })
})
