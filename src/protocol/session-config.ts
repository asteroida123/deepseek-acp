/**
 * `session/set_config_option` —— 会话内切模型与切权限（US-16 / US-17）。
 * @module
 */

import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { invalidParams } from '../codec/errors.js'
import { MODEL_OPTION, REASONING_OPTION, SANDBOX_OPTION, configOptions } from '../config/options.js'
import type { SessionRecord } from '../session/table.js'

/**
 * 读取某会话当前的全部配置项。
 *
 * `session/new`、`session/load`、`set_config_option` 三处共用：三处各算一遍
 * 迟早会出现「新建时有模型项、切换后应答里没有」这种客户端侧看着像 bug 的分叉。
 * @param bridge - 运行时
 * @param record - 会话记录
 * @returns 配置项数组
 */
export async function optionsFor(bridge: Bridge, record: SessionRecord): Promise<SessionConfigOption[]> {
  const provider = bridge.config.provider
  const model = record.handle.controls.model()
  // 档位词表按**当前**模型查。切模型的应答走的也是这个函数，所以列表在同一次
  // 往返里就换成新模型的了——不需要另开一条 `config_option_update` 推送。
  const reasoning =
    provider === undefined || model === undefined
      ? undefined
      : await bridge.port.reasoningEfforts(provider, model)
  return configOptions({
    controls: record.handle.controls,
    models: provider === undefined ? [] : await bridge.port.listModels(provider),
    sandboxModes: bridge.port.sandboxModes,
    ...(reasoning === undefined ? {} : { reasoning }),
  })
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 变更后的**全部**配置项
 */
export async function handleSetConfigOption(
  bridge: Bridge,
  params: SetSessionConfigOptionRequest,
): Promise<SetSessionConfigOptionResponse> {
  bridge.assertOpen()
  const record = bridge.table.get(params.sessionId as SessionId)
  if (record === undefined) throw invalidParams(`unknown session: ${params.sessionId}`)

  const current = await optionsFor(bridge, record)
  const target = current.find((option) => option.id === params.configId)
  // 未 advertise 的配置项一律拒绝。静默接受会让客户端以为设置生效了。
  if (target === undefined) throw invalidParams(`unknown config option: ${params.configId}`)

  if ('type' in params && params.type === 'boolean') {
    throw invalidParams(`config option "${params.configId}" is a select, not a boolean`)
  }
  const value = params.value as string

  // 值必须在 advertise 过的候选里。不校验的话，一个拼错的模型 id 会一路带到
  // 下一步的请求里，表现为「换了模型之后就报 404」。
  if (target.type === 'select' && !selectValues(target).includes(value)) {
    throw invalidParams(`config option "${params.configId}" has no value "${value}"`)
  }

  switch (params.configId) {
    case MODEL_OPTION:
      record.handle.controls.setModel(value)
      break
    case REASONING_OPTION:
      record.handle.controls.setReasoningEffort(value)
      break
    case SANDBOX_OPTION:
      record.handle.controls.setSandboxMode(value)
      break
    default:
      throw invalidParams(`config option "${params.configId}" is not settable`)
  }

  // 回**全部**配置项而非只回改动的那个：协议要求应答带完整列表，客户端据此
  // 整体重绘；只回一项会让别的控件保持在旧值上。
  return { configOptions: await optionsFor(bridge, record) }
}

/** 某个 select 配置项的合法值集合（options 可能是分组形式）。 */
function selectValues(option: Extract<SessionConfigOption, { type: 'select' }>): string[] {
  return option.options.flatMap((entry) => ('group' in entry ? entry.options.map((o) => o.value) : [entry.value]))
}
