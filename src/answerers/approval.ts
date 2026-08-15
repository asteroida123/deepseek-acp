/**
 * 审批应答器：把 dsh 的 `approval/request` waterfall 转成 ACP
 * `session/request_permission`（US-12）。
 *
 * 这是挂任何写/执行类工具的**前置安全条件**。没有它，组合里要么没有应答器
 * （每次请求都 fail-closed 成 `unavailable`，工具全废），要么由别的应答器
 * 自动放行（模型可以无提示改用户的代码）。
 * @module
 */

import type { PermissionOption, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * dsh 侧的审批结论。与 `@deepseek-ai/dsh-user-approval` 的 `ApprovalOutcome`
 * 结构一致；此处重述是为了让本模块不依赖该包——组合里没挂它时本文件仍可编译。
 */
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 一次待决的审批问题（`ApprovalRequest` 中本模块用得到的部分）。 */
export interface PendingApproval {
  /** 被决定的那一次工具调用；缺席时无处可挂，见 {@link answerApproval} */
  readonly callId?: string
  /** 工具名，供无 callId 时的诊断使用 */
  readonly toolName: string
  /** 提问方给出的人类可读理由 */
  readonly reason?: string
}

/**
 * advertise 给客户端的选项。
 *
 * 只给一次性选项：dsh 的 `ApprovalOutcome` 里没有「始终允许」——授权只对本次
 * 请求生效。给出一个 `allow_always` 会让客户端以为记住了选择，而下一次照样再问。
 */
export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow-once', name: '允许本次', kind: 'allow_once' },
  { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
]

/** 唯一代表「放行」的 optionId。 */
export const ALLOW_OPTION_ID = 'allow-once'

/**
 * 把客户端的应答映射为 dsh 结论。
 *
 * **只有精确等于 {@link ALLOW_OPTION_ID} 才算放行**：不合规客户端回一个未知
 * optionId 时必须当作拒绝。反过来写（「不是 reject 就放行」）会让任何拼写错误
 * 变成静默授权。
 * @param response - 客户端应答
 * @returns dsh 侧结论
 */
export function decisionFromResponse(response: RequestPermissionResponse): ApprovalDecision {
  const outcome = response.outcome
  if (outcome.outcome === 'cancelled') return 'cancelled'
  return outcome.optionId === ALLOW_OPTION_ID ? 'allowed-once' : 'rejected'
}

/** {@link answerApproval} 所需的外部依赖，便于单测注入。 */
export interface ApprovalDeps {
  /** 向客户端发起 `session/request_permission`；无连接时为 undefined */
  readonly requestPermission?: (params: {
    sessionId: SessionId
    toolCall: { toolCallId: string }
    options: PermissionOption[]
  }) => Promise<RequestPermissionResponse>
  readonly warn: (message: string) => void
}

/**
 * 应答一个属于本 bridge 的审批请求。
 *
 * 返回 `undefined` 表示**不认领**，交给 waterfall 的下一个应答器（调用方
 * 转成 `next()`）。这与「拒绝」是两回事：不认领是「这个问题不归我管」。
 * @param acpSessionId - 该 agent 对应的 ACP 会话 id
 * @param pending - 待决问题
 * @param deps - 外部依赖
 * @returns 结论；不认领时 undefined
 */
export async function answerApproval(
  acpSessionId: SessionId,
  pending: PendingApproval,
  deps: ApprovalDeps,
): Promise<ApprovalDecision | undefined> {
  // 协议要求带 `toolCall`——授权提示是挂在那张工具卡片上呈现的。没有 callId
  // 就无处可挂，交给别的应答器比编一个假 id 好。
  if (pending.callId === undefined) return undefined

  const requestPermission = deps.requestPermission
  if (requestPermission === undefined) {
    // 连接已断或尚未建立。此时**不能**交给下一个应答器：链尾若有自动放行的
    // 应答器，断连反而成了提权路径。显式拒绝。
    deps.warn(`approval for ${pending.toolName} rejected: no ACP connection`)
    return 'rejected'
  }

  try {
    const response = await requestPermission({
      sessionId: acpSessionId,
      toolCall: { toolCallId: pending.callId },
      options: [...PERMISSION_OPTIONS],
    })
    return decisionFromResponse(response)
  } catch (error) {
    // 客户端报错或中途断开。同样 fail-closed。
    deps.warn(`approval for ${pending.toolName} rejected: ${String(error)}`)
    return 'rejected'
  }
}
