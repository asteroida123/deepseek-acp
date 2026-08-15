/**
 * `session/prompt` —— 提交一轮并等待其结算。
 *
 * 结算规则是本文件的核心，也是最容易做错的地方：
 * **必须等 whole-agent idle，而不是 turn/end**。steering 与注入工作可能在
 * idle 之前继续贡献消息，只看 turn/end 会提前结算（详设 §6.2）。
 * @module
 */

import type { PromptRequest, PromptResponse, StopReason } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { invalidParams, internalError } from '../codec/errors.js'
import { acpPromptToText, promptHasUnsupportedContent } from '../codec/prompt.js'
import { turnEndToStopReason } from '../codec/stop-reason.js'
import type { CommandOutcome } from '../port/types.js'
import type { InflightPrompt, SessionRecord } from '../session/table.js'

/**
 * 若这一行是已注册的 slash 命令就执行它，否则交还给模型（US-18）。
 *
 * 命令**不触发模型请求**是它的全部意义，但「执行完就结束」并不总是对：`/plan
 * 帮我设计 X` 会先开 plan mode，再把消息 steer 进去起一个真回合。所以两种情况
 * 都等整体静默——没起回合时 `whenIdle` 立即返回，起了就正常等它跑完。
 *
 * 命令的产出（成功文本或失败原因）不在这里发：它已经作为 `command/done` 写进
 * 会话日志，由事件映射统一呈现，实时与重放因此是同一份内容。
 * @param bridge - 运行时
 * @param record - 会话记录
 * @param line - 用户输入的整行
 * @returns 命令已处理时返回应答；**不是命令时返回 undefined**
 */
async function runCommand(
  bridge: Bridge,
  record: SessionRecord,
  line: string,
): Promise<PromptResponse | undefined> {
  const commands = bridge.port.commands
  if (commands === undefined) return undefined

  // executor 是同步跑的，所以这两个引用在下一行就已就位。
  let settle!: (reason: StopReason) => void
  let fail!: (error: Error) => void
  const settled = new Promise<StopReason>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const inflight: InflightPrompt = {
    messageId: undefined,
    anyTurn: true,
    turn: undefined,
    endReason: undefined,
    resolve: settle,
    reject: fail,
  }
  // 先武装槽位再执行：命令可能同步起一个回合，晚装就错过了它的 turn/end；
  // 这也让 `session/cancel` 在命令跑着的时候有东西可结算。
  record.inflight = inflight

  let outcome: CommandOutcome | undefined
  try {
    outcome = await commands.run(record.handle.agent, line, new AbortController().signal)
  } catch (error: unknown) {
    // 槽位必须还回去，否则该会话此后每个 prompt 都被判为「已有在途」而永久拒绝。
    record.inflight = undefined
    const detail = error instanceof Error ? error.message : String(error)
    throw internalError(`command failed: ${detail}`)
  }
  // 语法不符或名字未注册：当作普通文本交给模型。用户打的 `/usr/bin/env 是什么`
  // 不该被命令面吞掉。
  if (outcome === undefined) {
    record.inflight = undefined
    return undefined
  }

  void bridge.port.driver.whenIdle(record.handle.agent).then(() => {
    // 槽位可能已被取消或错误路径提前结算。
    if (record.inflight !== inflight) return
    record.inflight = undefined
    // 没有相关联的回合结束 —— 这条命令根本没起回合（`/plan off` 就是如此），
    // 按正常结束处理；prompt 路径下同样的情况意味着入队被丢弃，按取消处理。
    const end = inflight.endReason
    settle(end === undefined ? 'end_turn' : turnEndToStopReason(end))
  })
  return { stopReason: await settled }
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 该轮的 stop reason
 */
export async function handlePrompt(bridge: Bridge, params: PromptRequest): Promise<PromptResponse> {
  bridge.assertOpen()

  const record = bridge.table.get(SessionId(params.sessionId))
  if (record === undefined) throw invalidParams(`unknown session: ${params.sessionId}`)

  // I1：每会话至多一个在途 prompt。
  if (record.inflight !== undefined) {
    throw invalidParams('a prompt is already in flight for this session')
  }
  // AC-G2：不支持的内容显式拒绝，不静默丢弃。
  if (promptHasUnsupportedContent(params.prompt)) {
    throw invalidParams('only text, resource_link and embedded resource prompt content is supported')
  }
  const text = acpPromptToText(params.prompt)
  if (text.trim().length === 0) throw invalidParams('empty prompt')

  // 不驱动已退休的 agent：agent-loop 单独重载会释放其 agent，而本表的记录
  // 仍在；已释放的机器会静默接受入队，prompt 将永不结算。
  if (!bridge.port.sessions.isLive(record.handle.agent)) {
    throw internalError('prompt was not queued: the agent was disposed outside the bridge')
  }

  // 命令面优先：`/` 开头且解析得到的输入不进模型（US-18）。判定交给上游的
  // 注册表，本层不自己认斜杠——两处各判一次迟早会分叉。
  const asCommand = await runCommand(bridge, record, text)
  if (asCommand !== undefined) return asCommand

  // 先构造消息以拿到 id，再武装槽位，最后才入队：监听器驱动的同步回合可能
  // 在入队调用返回前就跑完，槽位晚装或 id 未知都会错过相关性。
  const pending = bridge.port.driver.prepare(text)

  const stopReason = await new Promise<StopReason>((resolve, reject) => {
    const inflight: InflightPrompt = {
      messageId: pending.messageId,
      anyTurn: false,
      turn: undefined,
      endReason: undefined,
      resolve,
      reject,
    }
    record.inflight = inflight

    try {
      pending.submit(record.handle.agent)
    } catch (error: unknown) {
      // 入队同步失败必须释放槽位，否则该会话此后每个 prompt 都会被判为
      // 「已有在途」而永久拒绝。
      record.inflight = undefined
      const detail = error instanceof Error ? error.message : String(error)
      throw internalError(`prompt was not queued: ${detail}`)
    }

    void bridge.port.driver.whenIdle(record.handle.agent).then(() => {
      // 槽位可能已被取消或错误路径提前结算。
      if (record.inflight !== inflight) return
      record.inflight = undefined
      const end = inflight.endReason
      if (end === undefined) {
        // 无相关联的回合结束——入队被丢弃，按取消处理。
        inflight.resolve('cancelled')
        return
      }
      inflight.resolve(turnEndToStopReason(end))
    })
  })

  return { stopReason }
}
