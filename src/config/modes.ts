/**
 * 会话模式的线上词表（US-19）。
 *
 * **词表由 bridge 拥有，不是上游的**：ACP 的 `session/set_mode` 是一个通用的
 * 模式选择器（任意 id 集合），而上游只有 plan 这一个协作状态（一个布尔）。
 * 这里把那个布尔投影成固定的 `default` / `plan` 两项——不是把上游的内部状态
 * 直接搬上线，也不打算让部署方自定义模式名：多出来的 id 没有任何东西去实现它。
 *
 * 与配置项的分工：**协作状态归模式，环境旋钮归配置项**。模型选择和文件权限
 * 是旋钮（见 config/options.ts），不是模式。
 * @module
 */

import type { SessionMode, SessionModeState } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModePlane } from '../port/types.js'

/** 常规模式的线上 id。 */
export const DEFAULT_MODE = 'default'

/** Plan 模式的线上 id。 */
export const PLAN_MODE = 'plan'

/**
 * 可选模式，固定两项。
 *
 * plan 的说明里点明「引导而非强制」是有意的：一个叫「计划模式」的开关很容易
 * 被当成「它不会动我的文件」，而上游明确说了 plan mode 只贡献提示词，真正的
 * 边界在沙箱与审批那边。让用户以为自己开了保险，比没有保险更危险。
 */
export const AVAILABLE_MODES: readonly SessionMode[] = [
  { id: DEFAULT_MODE, name: '常规', description: '直接读写文件、执行命令完成任务' },
  {
    id: PLAN_MODE,
    name: '计划',
    description: '先调研再给出完整方案，经你确认后才动手；这是对模型的引导，实际权限仍由「文件权限」决定',
  },
]

/**
 * 布尔状态 → 线上 id。
 * @param active - plan mode 是否生效
 */
export function modeId(active: boolean): string {
  return active ? PLAN_MODE : DEFAULT_MODE
}

/**
 * 线上 id → 布尔状态。
 * @param id - 客户端给的模式 id
 * @returns 对应的 plan 状态；**未知 id 返回 undefined**，调用方据此拒绝而不是
 *   悄悄落到 `default`——静默降级会让用户以为自己切到了某个模式
 */
export function modeActive(id: string): boolean | undefined {
  if (id === PLAN_MODE) return true
  if (id === DEFAULT_MODE) return false
  return undefined
}

/**
 * 某会话当前的模式状态。
 *
 * 取 `pending ?? active`：用户在回合进行中切了模式，日志里那条要等下一个被接受
 * 的步骤边界才落地，但选择器该立刻显示他刚选的那个。
 * @param modes - 模式面；undefined 表示组合没挂 plan-mode
 * @param agent - 会话 agent
 * @returns 模式状态；没挂 plan-mode 时 undefined（于是不 advertise）
 */
export function modeStateFor(modes: ModePlane | undefined, agent: Agent): SessionModeState | undefined {
  if (modes === undefined) return undefined
  const { active, pending } = modes.get(agent)
  return { availableModes: [...AVAILABLE_MODES], currentModeId: modeId(pending ?? active) }
}
