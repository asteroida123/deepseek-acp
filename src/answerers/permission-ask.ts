/**
 * 提问的降级通道：客户端没有表单征询时，把带选项的问题映射成一次
 * `session/request_permission`（US-21 的兜底路径）。
 *
 * 存在的理由是能力面的一个硬事实：`elicitation/create` 在 ACP 1.3.0 里仍标
 * UNSTABLE，客户端方法是可选的（`unstable_createElicitation?`）且由能力位
 * `elicitation.form` 门控；而 `session/request_permission` 在 SDK 的 `Client`
 * 接口里是**必选**方法，不受任何能力位约束。也就是说前者可能不存在，后者一定
 * 存在——codeg 就是前一种。没有这条降级，`ask_user_question` 与
 * `exit_plan_mode`（计划评审只有这一个出口）在这类客户端上整个不可用。
 *
 * 代价是通道本身只能表达「一次一个决定」：
 * - 自由文本题无处输入 → 整体拒绝，让模型改用纯文本提问；
 * - 多选题只能选一项 → 标题里写明，答案回一项（对上游是合法答案，只是选得少）。
 * @module
 */

import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse, ToolCallContent } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'

/** 客户端不支持表单、且问题也无法降级时给模型的说法。 */
export const PLAIN_TEXT_ADVICE =
  'this editor does not support form elicitation; ask the user in plain text instead'

/** 多选题降级为单选时追加到标题上的提示。 */
const SINGLE_PICK_NOTE = '（只能选一项）'

/** 选项下标 → optionId。 */
function optionId(index: number): string {
  return `opt-${index}`
}

/**
 * 一个选项的按钮语义。
 *
 * 计划评审时 `intent.approve` 命名的那项是批准、其余都是否决，映射成
 * allow/reject 两种 kind 后按钮配色才是对的。普通问题的选项之间没有褒贬，
 * 一律 `allow_once`。
 *
 * **永不产出 `allow_always`**：那是在告诉客户端「可以记住这个选择」，而下一个
 * 问题与这一个毫无关系——记住的结果就是替用户答了一个他没看过的问题。
 */
function optionKind(item: AskUserQuestionItem, label: string): PermissionOption['kind'] {
  const intent = item.intent
  if (intent === undefined || intent.kind !== 'plan-review') return 'allow_once'
  return label === intent.approve ? 'allow_once' : 'reject_once'
}

/** 卡片正文：先是问题自带的细节，再是各选项的说明。 */
function cardContent(item: AskUserQuestionItem): ToolCallContent[] {
  const parts: string[] = []
  // 计划评审时这里就是整份方案 markdown —— 看不到方案的「批准」按钮毫无意义。
  if (item.detail !== undefined && item.detail !== '') parts.push(item.detail)

  // 选项说明放正文而不是拼进按钮名：`PermissionOption` 没有 description 槽位，
  // 拼进 `name` 会得到一排长到没法看的按钮。
  const explained = (item.options ?? []).filter((option) => option.description !== undefined)
  if (explained.length > 0) {
    parts.push(explained.map((option) => `- **${option.label}** — ${option.description ?? ''}`).join('\n'))
  }
  if (parts.length === 0) return []
  return [{ type: 'content', content: { type: 'text', text: parts.join('\n\n') } }]
}

/**
 * 一个问题 → 一次授权请求。
 * @param sessionId - 提问方所属的 ACP 会话
 * @param item - 待问的问题（必须带选项，调用方先行校验）
 * @param toolCallId - 提示挂靠的工具卡片
 * @returns ACP 授权请求
 */
export function toPermissionRequest(
  sessionId: SessionId,
  item: AskUserQuestionItem,
  toolCallId: string,
): RequestPermissionRequest {
  const content = cardContent(item)
  return {
    sessionId,
    toolCall: {
      toolCallId,
      // 多选降级要说出来：用户点不了第二项时，「界面坏了」和「本来就只能选一项」
      // 是两种完全不同的体验。
      title: item.multiSelect === true ? `${item.question}${SINGLE_PICK_NOTE}` : item.question,
      kind: item.intent?.kind === 'plan-review' ? 'switch_mode' : 'other',
      status: 'pending',
      ...(content.length === 0 ? {} : { content }),
    },
    options: (item.options ?? []).map((option, index) => ({
      optionId: optionId(index),
      name: option.label,
      kind: optionKind(item, option.label),
    })),
  }
}

/**
 * 客户端应答 → 上游的答案项。
 *
 * **不产出 `custom`**：`exit_plan_mode` 判定批准的条件是 `selected` 恰好一项且
 * `custom` 不存在，塞一个空串会让任何计划都通不过评审——而那种错误在「按钮显示
 * 出来了」这层完全看不见。这条与表单路径是同一条约束。
 * @param item - 当初提的问题，用于把 optionId 映射回标签
 * @param response - 客户端应答
 * @returns 该问题的答案
 * @throws {UserQuestionError} 用户放弃作答，或应答里是个不认识的选项
 */
export function answerFromOutcome(
  item: AskUserQuestionItem,
  response: RequestPermissionResponse,
): AskUserQuestionAnswerItem {
  const outcome = response.outcome
  // 与表单路径统一成 `ASK_CANCELLED`：plan mode 认这个 code，据此告诉模型
  // 「用户想改说别的，留在计划模式等消息」。换个 code 就退回通用失败文案了。
  if (outcome.outcome === 'cancelled') {
    throw new UserQuestionError('the user dismissed the question', 'ASK_CANCELLED')
  }

  const options = item.options ?? []
  const index = options.findIndex((_, position) => optionId(position) === outcome.optionId)
  // 不猜：不合规客户端回一个未知 optionId 时，按下标取近似值会把答案静默换成
  // 另一个选项——在计划评审里那等于替用户点了「批准」。
  if (index === -1) {
    throw new UserQuestionError(`the client returned an unknown option: ${outcome.optionId}`, 'NO_ANSWER')
  }
  return { id: item.id, selected: [options[index]?.label ?? ''] }
}

/** {@link askViaPermission} 所需的外部依赖，便于单测注入。 */
export interface PermissionAskDeps {
  /** 发起 `session/request_permission`；无连接时 undefined */
  readonly requestPermission?: (
    params: RequestPermissionRequest,
    options?: { cancellationSignal?: AbortSignal },
  ) => Promise<RequestPermissionResponse>
  /** 提问方 agent → ACP 会话 id；不属于本 bridge 时返回 undefined */
  readonly sessionOf: (agent: unknown) => SessionId | undefined
  /** 提问方 agent → 当前唯一在飞的调用 id；判定不了时 undefined */
  readonly soleCallOf: (agent: unknown) => string | undefined
}

/**
 * 用授权通道向客户端提问并等待作答。
 * @param request - 上游的提问（问题、提问方 agent、中止信号）
 * @param deps - 外部依赖
 * @returns 结构化答案
 * @throws {UserQuestionError} 无法提问或用户未作答
 */
export async function askViaPermission(
  request: { questions: AskUserQuestionItem[]; agent?: unknown; signal?: AbortSignal },
  deps: PermissionAskDeps,
): Promise<AskUserQuestionAnswer> {
  const requestPermission = deps.requestPermission
  if (requestPermission === undefined) {
    throw new UserQuestionError('no ACP connection to ask the user through', 'NO_CONNECTION')
  }
  const sessionId = request.agent === undefined ? undefined : deps.sessionOf(request.agent)
  if (sessionId === undefined) {
    throw new UserQuestionError('the question does not belong to an ACP session', 'NO_SESSION')
  }
  // **先把全部问题验一遍再问第一个**：放在循环里检查的话，一组「选项题 + 自由
  // 文本题」会让用户答完第一题才撞上失败，那一次作答完全白费。
  if (request.questions.some((item) => (item.options ?? []).length === 0)) {
    throw new UserQuestionError(PLAIN_TEXT_ADVICE, 'UNSUPPORTED')
  }

  // 挂到**正在执行的那次调用**的卡片上：提问时该工具就是唯一在飞的调用，所以
  // 这条判据不必知道工具叫什么。判定不了（并行工具）时退回合成 id——宁可多出
  // 一张卡片，也不要把提示挂到隔壁工具头上。
  const liveCall = deps.soleCallOf(request.agent)

  const answers: AskUserQuestionAnswerItem[] = []
  for (const item of request.questions) {
    let response: RequestPermissionResponse
    try {
      response = await requestPermission(
        toPermissionRequest(sessionId, item, liveCall ?? `ask-${item.id}`),
        request.signal === undefined ? {} : { cancellationSignal: request.signal },
      )
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new UserQuestionError(`the permission request failed: ${detail}`, 'REQUEST_FAILED')
    }
    answers.push(answerFromOutcome(item, response))
  }
  return { answers }
}
