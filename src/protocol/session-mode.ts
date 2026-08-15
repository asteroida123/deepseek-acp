/**
 * `session/set_mode` —— 在常规与 plan 之间切换（US-19）。
 * @module
 */

import type { SetSessionModeRequest, SetSessionModeResponse } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { invalidParams, methodNotFound } from '../codec/errors.js'
import { modeActive } from '../config/modes.js'

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 空应答（模式变更经 `current_mode_update` 通知）
 */
export function handleSetMode(bridge: Bridge, params: SetSessionModeRequest): SetSessionModeResponse {
  bridge.assertOpen()
  const modes = bridge.port.modes
  if (modes === undefined) {
    // 这个部署没挂 plan-mode，`session/new` 也就没 advertise `modes`。客户端仍可
    // 无视能力声明直接调，此处给出的是「能力缺失」而非「参数错了」——后者会让
    // 客户端以为换个 id 重试有用。
    throw methodNotFound('session/set_mode requires @deepseek-ai/dsh-plan-mode')
  }
  const record = bridge.table.get(params.sessionId as SessionId)
  if (record === undefined) throw invalidParams(`unknown session: ${params.sessionId}`)

  const active = modeActive(params.modeId)
  if (active === undefined) throw invalidParams(`unknown mode: ${params.modeId}`)

  modes.set(record.handle.agent, active)
  // 乐观回一条：切换可能要等到下一个被接受的步骤边界才写进日志（回合进行中切换
  // 时如此），但选择器该立刻反映用户刚点的那一下。真正落盘的那条 `plan/mode`
  // 事件会再触发一次同值的 `current_mode_update`——这条更新携带的是完整状态而
  // 非增量，重复一次是幂等的。
  bridge.notify(record.acpSessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId })
  return {}
}
