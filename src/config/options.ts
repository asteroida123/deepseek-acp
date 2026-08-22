/**
 * 会话配置项：模型（US-16）与权限预设（US-17）。
 *
 * ACP 没有「支持配置项」这个能力位——**声明方式就是在 `session/new` /
 * `session/load` 的应答里把 `configOptions` 带回去**。因此这里返回空数组等价于
 * 「本会话没有可配置项」，客户端不会显示控件，也不会去调 `set_config_option`。
 * @module
 */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { SessionControls } from '../port/types.js'

/** 模型选择的配置项 id。 */
export const MODEL_OPTION = 'model'

/** 沙箱模式（权限预设）的配置项 id。 */
export const SANDBOX_OPTION = 'sandbox'

/** 推理档位的配置项 id。 */
export const REASONING_OPTION = 'reasoning'

/** 推理档位的展示名。词表由适配器给，这里只把已知 id 翻成中文。 */
const REASONING_LABELS: Record<string, { name: string; description: string }> = {
  off: { name: '关闭', description: '不做推理，直接作答；最快' },
  low: { name: '低', description: '略作推理；比关闭稳，比高档快' },
  high: { name: '高', description: '推理后作答；日常编码的默认档' },
  max: { name: '最高', description: '推理更久；难题更稳，但慢且更费 token' },
}

/** 沙箱模式的展示名与说明。用户看到的是后果，不是词表里的字面量。 */
const SANDBOX_LABELS: Record<string, { name: string; description: string }> = {
  'read-only': { name: '只读', description: '不允许任何写操作；越界的命令会被拒绝' },
  'workspace-write': { name: '可写工作区', description: '可读写会话工作区与 /tmp；越界需要单次授权' },
  'danger-full-access': { name: '完全访问', description: '不做任何文件限制。仅在你清楚后果时选择' },
}

/**
 * 一个推理档位 → 下拉项。
 *
 * 本地译名优先于适配器给的名字：词表 id 是稳定的（`off` / `high` / `max`），
 * 而适配器的 `name` 是英文的展示串。认得的 id 用中文说明后果，认不得的原样透传
 * ——新增档位不会因此消失，只是没有中文说明。
 */
function effortChoice(effort: { id: string; name: string; description?: string }): {
  value: string
  name: string
  description?: string
} {
  const label = REASONING_LABELS[effort.id]
  if (label !== undefined) return { value: effort.id, name: label.name, description: label.description }
  if (effort.description !== undefined) {
    return { value: effort.id, name: effort.name, description: effort.description }
  }
  return { value: effort.id, name: effort.name }
}

/** 组装配置项所需的会话事实。 */
export interface ConfigInputs {
  readonly controls: SessionControls
  /** 该 provider 下可选的模型；空数组表示不 advertise 模型项 */
  readonly models: readonly { id: string; name: string }[]
  /** 部署支持的沙箱模式；空数组表示没挂 sandboxPolicy */
  readonly sandboxModes: readonly string[]
  /**
   * 当前模型的推理档位词表与适配器默认；空数组表示这个路由不暴露推理档位。
   *
   * **随模型而变**，不是全局常量：某些部署只剩 `off` 一项。
   */
  readonly reasoning?: {
    readonly efforts: readonly { id: string; name: string; description?: string }[]
    readonly defaultEffort?: string
  }
}

/**
 * 按当前会话状态组装配置项。
 *
 * 每次都**重新读取**当前值而不是缓存：`set_config_option` 的应答与后续的
 * `session/new` 都要反映真实状态，缓存一份就会出现「界面显示已切换、实际没切」。
 * @param inputs - 会话事实
 * @returns 配置项数组；无可配置项时为空
 */
export function configOptions(inputs: ConfigInputs): SessionConfigOption[] {
  const options: SessionConfigOption[] = []

  const currentModel = inputs.controls.model()
  // 只有一个候选时不 advertise：给用户一个选不动的下拉框没有意义。
  if (currentModel !== undefined && inputs.models.length > 1) {
    options.push({
      type: 'select',
      id: MODEL_OPTION,
      name: '模型',
      category: 'model',
      currentValue: currentModel,
      options: inputs.models.map((m) => ({ value: m.id, name: m.name })),
    })
  }

  const efforts = inputs.reasoning?.efforts ?? []
  // 同样只有一个候选时不 advertise：选不动的下拉框没有意义。
  if (efforts.length > 1) {
    // 会话没显式选过就显示适配器的默认档——这与实际发送的是同一个值：
    // `LlmRuntime` 也按 `requested ?? defaultEffort` 物化。同源，但那是运行时的
    // 行为而非本模块能保证的事，所以有用例钉着（TC-REASON-02）。
    const current = inputs.controls.reasoningEffort() ?? inputs.reasoning?.defaultEffort
    // 当前值必须在词表里，否则客户端会拿到一个选不中的下拉框。
    if (current !== undefined && efforts.some((effort) => effort.id === current)) {
      options.push({
        type: 'select',
        id: REASONING_OPTION,
        name: '推理档位',
        description: '越高越慢越费 token，难题更稳',
        category: 'model',
        currentValue: current,
        options: efforts.map((effort) => effortChoice(effort)),
      })
    }
  }

  const currentSandbox = inputs.controls.sandboxMode()
  if (currentSandbox !== undefined && inputs.sandboxModes.length > 0) {
    options.push({
      type: 'select',
      id: SANDBOX_OPTION,
      name: '文件权限',
      description: '命令与文件工具共用这一条边界',
      category: 'mode',
      currentValue: currentSandbox,
      options: inputs.sandboxModes.map((mode) => ({
        value: mode,
        name: SANDBOX_LABELS[mode]?.name ?? mode,
        ...(SANDBOX_LABELS[mode] !== undefined ? { description: SANDBOX_LABELS[mode].description } : {}),
      })),
    })
  }

  return options
}
