/**
 * 终端卡片：Zed 的 `_meta` 约定（US-10）。
 *
 * **不走 ACP 的 `terminal/*` 子协议。** 那套协议是「客户端替 agent 执行命令」的
 * 模型：agent 请求客户端创建终端并运行。但命令必须跑在 dsh 自己的沙箱与策略
 * 之下——交给客户端执行就绕开了整套约束。Zed 的 `_meta` 约定正好只做呈现：
 * 命令仍在 dsh 侧执行，客户端只负责画那张卡片。
 *
 * 三个键：`terminal_info`（调用侧，cwd 表头）、`terminal_output`、
 * `terminal_exit`（结果侧）。
 * @module
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { TerminalResultView } from '@deepseek-ai/dsh-tools'

/** 终端渲染能力与工作区。 */
export interface TerminalRenderingLike {
  readonly enabled: boolean
  readonly cwd: string | undefined
}

/**
 * 解析终端卡片的 cwd 表头。
 *
 * 工具给的是**模型视角**的路径，可能是相对的（纯呈现函数看不到会话工作区）。
 * 相对路径在这里按会话工作区解析；工具没给就用会话工作区。
 * @param viewCwd - 工具声明的 cwd
 * @param sessionCwd - 会话工作区
 * @returns 展示用的绝对 cwd；都没有则 undefined
 */
export function terminalCwd(viewCwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (viewCwd === undefined) return sessionCwd
  if (isAbsolute(viewCwd)) return viewCwd
  return sessionCwd === undefined ? viewCwd : resolvePath(sessionCwd, viewCwd)
}

/**
 * 调用侧 `_meta`；客户端不支持时为空对象。
 *
 * 返回类型是「有 `_meta` 或什么都没有」的联合，而不是 `{ _meta?: ... }`：在
 * `exactOptionalPropertyTypes` 下后者会把 `undefined` 带进 `_meta`，而该字段
 * 的类型是 `{...} | null`，不接受 `undefined`。
 * @param callId - 调用 id，同时作为终端 id
 * @param viewCwd - 工具声明的 cwd
 * @param terminal - 会话终端能力
 * @returns 可展开进更新对象的片段
 */
export function terminalCallMeta(
  callId: string,
  viewCwd: string | undefined,
  terminal: TerminalRenderingLike,
): { _meta: Record<string, unknown> } | Record<string, never> {
  if (!terminal.enabled) return {}
  const cwd = terminalCwd(viewCwd, terminal.cwd)
  return { _meta: { terminal_info: { terminal_id: callId, ...(cwd !== undefined ? { cwd } : {}) } } }
}

/**
 * 结果侧的退出信息。
 *
 * 信号致死给 `signal`，正常退出给 `exit_code`，两者都无则**什么都不给**——
 * 编一个 `exit_code: 0` 会把「不知道」显示成「成功」。
 * @param callId - 调用 id
 * @param view - 终端结果视图
 * @returns 可展开进 `_meta` 的片段
 */
export function terminalExitMeta(
  callId: string,
  view: TerminalResultView,
): { terminal_exit?: { terminal_id: string; exit_code?: number; signal?: string } } {
  if (view.signal !== undefined) return { terminal_exit: { terminal_id: callId, signal: view.signal } }
  if (view.exitCode !== undefined) return { terminal_exit: { terminal_id: callId, exit_code: view.exitCode } }
  return {}
}

/**
 * 客户端不支持终端卡片时的文本兜底：围栏 console 代码块。
 *
 * 由 bridge 生成而非工具双重编码——工具产出的是裸输出，围栏是呈现层的事。
 * @param view - 终端结果视图
 * @returns ACP 工具卡片内容
 */
export function terminalFallbackContent(view: TerminalResultView): NonNullable<ToolCallUpdate['content']> {
  const output = view.output ?? ''
  const exit =
    view.signal !== undefined
      ? `\n[killed by ${view.signal}]`
      : view.exitCode !== undefined && view.exitCode !== 0
        ? `\n[exit ${view.exitCode}]`
        : ''
  return [{ type: 'content', content: { type: 'text', text: `\`\`\`console\n${output}\n\`\`\`${exit}` } }]
}
