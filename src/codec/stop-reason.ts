/**
 * 回合结束原因 → ACP StopReason 的全函数映射。
 *
 * 必须对 `TurnEndReason` 的每个成员都有定义，且对未知成员（该联合可被插件
 * 声明合并扩展）有安全回退——否则未来上游新增一种结束原因会让 prompt 永挂。
 * @module
 */

import type { StopReason } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * @param reason - harness 的回合结束原因
 * @returns 最接近的合法 ACP stop reason
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` 专门留给显式的客户端取消（session/cancel）与 disposal，
    // 二者在带外结算。被 hook 或其它所有者中止的回合属于正常静默，报 end_turn。
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    default:
      // TurnEndReason 可被插件声明合并扩展；未知成员回退而非抛错。
      return 'end_turn'
  }
}
