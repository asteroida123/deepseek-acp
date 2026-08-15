/**
 * 提问通道的选路：表单征询优先，客户端不支持时降级到授权通道（US-21）。
 *
 * 能力判断只此一处。两条路径各判一次的话，「哪条算可用」迟早会分叉，而分叉的
 * 表现是提问静默走错通道——两条通道的能力上限不同（表单支持多问题、多选、自由
 * 文本，授权通道都不支持），走错了就是功能悄悄缩水。
 * @module
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { askViaElicitation, type ElicitationDeps } from './elicitation.js'
import { askViaPermission, type PermissionAskDeps } from './permission-ask.js'

/** {@link askUser} 所需的外部依赖：两条通道各自的依赖，加一个能力位。 */
export interface AskDeps extends ElicitationDeps, PermissionAskDeps {
  /** 客户端是否 advertise 了 `elicitation.form` */
  readonly elicitation: boolean
}

/**
 * 向客户端提问，自动选路。
 * @param request - 上游的提问（问题、提问方 agent、中止信号）
 * @param deps - 两条通道的依赖与能力位
 * @returns 结构化答案
 * @throws {UserQuestionError} 无法提问或用户未作答
 */
export function askUser(
  request: { questions: AskUserQuestionItem[]; agent?: unknown; signal?: AbortSignal },
  deps: AskDeps,
): Promise<AskUserQuestionAnswer> {
  // 表单是首选：一次问完全部问题，且多选与自由文本都表达得了。降级通道每项
  // 都做不到，只在客户端确实没有表单能力时才用。
  if (deps.elicitation && deps.createElicitation !== undefined) return askViaElicitation(request, deps)
  return askViaPermission(request, deps)
}
