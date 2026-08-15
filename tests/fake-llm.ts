/**
 * 假模型适配器：让**真实的 agent loop** 完整跑一轮，而不需要 API Key。
 *
 * 只伪造模型这一层，回合生命周期（turn/start、inbox 认领、assistant/chunk、
 * turn/end、whole-agent idle）全部走真实路径——否则测不到结算语义。
 * @module
 */

import {
  LlmAdapter,
  type FinishReason,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'

export const FAKE_PROVIDER = 'fake'
export const FAKE_MODEL = 'fake-model'

/**
 * 第二个可选模型。
 *
 * 模型配置项只在候选**多于一个**时 advertise（选不动的下拉框没有意义），
 * 所以目录里必须有两个，US-16 那条链才测得到。
 */
export const FAKE_MODEL_ALT = 'fake-model-pro'

/** 可编排的假适配器。 */
export class FakeLlmAdapter extends LlmAdapter {
  /** 每次调用产出的文本分片；分成多片以便验证增量转发 */
  deltas: string[] = ['Hel', 'lo']
  /** 每片之间的延迟，用于制造可取消的窗口 */
  delayMs = 0
  /** 置位后 stream 抛错，用于验证回合失败路径 */
  failWith: Error | undefined
  /**
   * 文本流的结束原因。
   *
   * 默认正常结束；改成 `max-tokens` 可以制造一个被截断的回合，用来分辨
   * 「真的读到了这一轮的结束原因」与「没读到、回退成了 end_turn」——两者在
   * 正常结束时给出同一个答案，只有非正常结束才区分得开。
   */
  finishWith: FinishReason = { kind: 'stop' }
  /**
   * 每次流在 finish 之前产出的 token 记账。
   *
   * 默认带缓存字段：输入侧三项是**不相交**的，只加 `inputTokens` 会让开着缓存
   * 的会话显示成只用了一小半——这个默认值让那个错误在用例里现形。置 undefined
   * 则完全不报，用来验证「适配器没给记账时不上报」。
   */
  usage: TokenUsage | undefined = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    reasoningTokens: 8,
  }
  /** 记录收到的调用次数 */
  calls = 0
  /**
   * 置位后本次流产出一次工具调用而非文本；产出后清空，下一步回到文本，
   * 否则真实的 agent loop 会拿着工具结果无限再调。
   */
  toolCall: { id: string; name: string; args: string } | undefined
  /**
   * 回合**进行中**的钩子，在第一片文本之前 await。
   *
   * 审批必须在开着的回合里提出（`ApprovalService.request` 对空闲 agent 直接
   * 拒绝，因为审计事件对要落在日志的 commit/replay 边界内）。靠 sleep 去撞这个
   * 窗口是不稳定的，所以给一个确定的挂钩点。
   */
  duringTurn: (() => Promise<void>) | undefined

  override providerInfo(provider: string) {
    return { id: provider, name: 'Fake' }
  }

  /** 每次 stream 调用实际收到的模型，按顺序；用于验证切换真的改了路由。 */
  modelsUsed: string[] = []

  override async listModels(provider: string) {
    return [
      { provider, id: FAKE_MODEL, name: FAKE_MODEL },
      { provider, id: FAKE_MODEL_ALT, name: FAKE_MODEL_ALT },
    ]
  }

  /**
   * 每个模型暴露的推理档位。
   *
   * 键是模型 id，值是档位 id 列表。默认让两个模型的**词表不同**——真实部署里
   * 词表就是随模型变的（有的只剩 `off`），而「切模型后档位列表要跟着换」正是
   * 这条链最容易漏的地方。
   */
  reasoningByModel: Record<string, string[]> = {
    [FAKE_MODEL]: ['off', 'high', 'max'],
    [FAKE_MODEL_ALT]: ['off'],
  }

  /** 适配器报告的默认档位。 */
  defaultEffort = 'high'

  override async resolveModel(provider: string, model: string) {
    const efforts = this.reasoningByModel[model] ?? []
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 8192 },
      ...(efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map((id) => ({ id: id as never, name: id.toUpperCase() })),
              defaultEffort: (efforts.includes(this.defaultEffort)
                ? this.defaultEffort
                : efforts[0]) as never,
            },
          }),
    }
  }

  /** 每次 stream 实际收到的推理档位，按顺序；用于验证切换真的进了请求。 */
  effortsUsed: (string | undefined)[] = []

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.modelsUsed.push(options.model)
    this.effortsUsed.push(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
    if (this.failWith !== undefined) throw this.failWith

    const pendingCall = this.toolCall
    if (pendingCall !== undefined) {
      this.toolCall = undefined
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: pendingCall.id as never,
        name: pendingCall.name,
        argumentsDelta: pendingCall.args,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: pendingCall.id as never, name: pendingCall.name, arguments: pendingCall.args },
      }
      // 记账在终止性 finish **之前**产出，与上游适配器约定一致。
      if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (this.duringTurn !== undefined) await this.duringTurn()
    for (const text of this.deltas) {
      if (options.signal?.aborted === true) break
      if (this.delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, this.delayMs)
          options.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      }
      yield { type: 'text-delta', index: 0, text }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.deltas.join('') } }
    if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: this.finishWith }
  }
}
