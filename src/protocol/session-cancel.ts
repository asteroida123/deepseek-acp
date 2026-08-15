/**
 * `session/cancel` —— 取消一个会话的当前工作。
 *
 * 严格限定本会话：未知 id 是静默 no-op，绝不波及兄弟会话（AC-G3）。
 * @module
 */

import type { CancelNotification } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { settlePrompt } from '../session/table.js'

/**
 * @param bridge - 运行时
 * @param params - ACP 通知
 */
export function handleCancel(bridge: Bridge, params: CancelNotification): void {
  const record = bridge.table.get(SessionId(params.sessionId))
  // 未知会话 id 是 no-op：通知没有应答，且并发下客户端可能取消一个刚被
  // 释放的会话。
  if (record === undefined) return
  bridge.port.driver.cancel(record.handle.agent)
  settlePrompt(record, 'cancelled')
}
