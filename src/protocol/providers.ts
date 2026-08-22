/**
 * `providers/list` / `providers/set` / `providers/disable` —— 在编辑器里配置
 * LLM provider 路由。
 *
 * 这三个方法在 ACP 里标着 UNSTABLE，但自 1.3.0 起方法名与结构就没动过。它们回答
 * 的是「这个 agent 能连到哪些模型服务、各自连在哪」，与 `session/set_config_option`
 * 的模型下拉正交：那边是**在已有路由里选**，这边是**增删改路由本身**。
 *
 * ## 密钥不进设置文档
 *
 * `providers/set` 的 `headers` 里通常带着 `Authorization`。本模块把它交给凭据
 * 服务（落 `.credentials.yaml`，`0600`），设置文档里只留一个引用名。理由不是
 * 洁癖：`settings.yaml` 会被配置界面整段读出来、会被 `describe()` 发到线上、
 * 也常常被用户连同报错一起贴出来。上游 profile 的 `apiKeyEnv` 本来就定义为
 * **引用**而非明文，所以这是照它的语义用，不是我们发明的约定。
 *
 * ## 脱敏是硬性要求
 *
 * `providers/list` 读设置时必须走 `describe({redactSecrets: true})` —— 上游文档
 * 明写「every wire surface MUST pass it」。这一条在 port 那层执行（见
 * `src/port/in-process.ts` 的 `providers` 面），本模块只负责把结果翻成 ACP 结构。
 * @module
 */

import type {
  DisableProviderRequest,
  DisableProviderResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  SetProviderRequest,
  SetProviderResponse,
} from '@agentclientprotocol/sdk'
import type { Bridge } from '../bridge.js'
import { invalidParams } from '../codec/errors.js'

/**
 * 取 provider 配置面，缺席时拒绝。
 *
 * 缺席只有一个原因：组合没挂可写的设置服务。此时 `initialize` 也不会 advertise
 * `providers` 能力位，因此规矩的客户端根本不会调到这里——真调到了就是它没读
 * 能力位，明确拒绝好过给一个看起来成功的空应答。
 * @param bridge - 运行时
 */
function planeOf(bridge: Bridge) {
  const plane = bridge.port.providers
  if (plane === undefined) {
    throw invalidParams('provider configuration is unavailable: no writable settings provider is composed')
  }
  return plane
}

/**
 * @param bridge - 运行时
 * @returns 全部可配置 provider 及其当前的**非机密**配置
 */
export async function handleListProviders(
  bridge: Bridge,
  _params: ListProvidersRequest,
): Promise<ListProvidersResponse> {
  bridge.assertOpen()
  const plane = planeOf(bridge)
  const protocols = [...(await plane.protocols())]
  return {
    providers: (await plane.list()).map((provider) => ({
      providerId: provider.id,
      // 词表对每条路由都一样：它是「本部署这个二进制认得哪些线协议」，不随路由变。
      supported: protocols,
      required: provider.required,
      // `current` 缺席在 ACP 里的语义就是**该 provider 处于禁用态**，所以这里
      // 的 undefined 是一条信息，不是「读不出来」。
      ...(provider.current === undefined ? {} : { current: { ...provider.current } }),
      _meta: { displayName: provider.displayName },
    })),
  }
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求；`headers` 里的授权项会被摘去凭据服务
 */
export async function handleSetProvider(
  bridge: Bridge,
  params: SetProviderRequest,
): Promise<SetProviderResponse> {
  bridge.assertOpen()
  const plane = planeOf(bridge)

  // 协议不在词表里就拒绝：写进去只会在下一次请求时以一个更难懂的形式失败
  // （上游那边报的是「this build cannot serve api X」，而用户以为自己在配 baseUrl）。
  const protocols = await plane.protocols()
  if (!protocols.includes(params.apiType)) {
    throw invalidParams(
      `unsupported apiType "${params.apiType}"; this build serves ${protocols.join(', ')}`,
    )
  }
  // 空 baseUrl 会让上游按「继承目录默认」处理，与用户「我指定了一个端点」的意图
  // 相反，且事后极难看出来。
  if (params.baseUrl.trim().length === 0) throw invalidParams('baseUrl must not be empty')

  try {
    await plane.set({
      id: params.providerId,
      apiType: params.apiType,
      baseUrl: params.baseUrl,
      headers: params.headers,
    })
  } catch (error: unknown) {
    throw settingsFailure(error)
  }
  return {}
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 */
export async function handleDisableProvider(
  bridge: Bridge,
  params: DisableProviderRequest,
): Promise<DisableProviderResponse> {
  bridge.assertOpen()
  const plane = planeOf(bridge)

  // `required` 的路由不是从设置文档来的，删不掉。规范也要求客户端不要对这类
  // provider 调本方法——但客户端会有 bug，而静默成功会让用户以为禁用生效了。
  const target = (await plane.list()).find((provider) => provider.id === params.providerId)
  if (target === undefined) throw invalidParams(`unknown provider: ${params.providerId}`)
  if (target.required) throw invalidParams(`provider "${params.providerId}" is required and cannot be disabled`)

  try {
    await plane.disable(params.providerId)
  } catch (error: unknown) {
    throw settingsFailure(error)
  }
  return {}
}

/**
 * 设置写入失败 → ACP 错误。
 *
 * `SETTINGS_CONFLICT` 单独拎出来：它表示「你读到的那份已经过期了」，客户端的
 * 正确反应是重新 `providers/list` 再写一次，而不是把同一份重试到底。混在通用
 * 失败里会让它按错误的方式恢复。
 * @param error - 上游抛出的东西
 */
function settingsFailure(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'SETTINGS_CONFLICT') {
    return invalidParams(
      `provider settings changed since they were read; re-read providers/list and retry (${String(
        (error as Error).message,
      )})`,
    )
  }
  return invalidParams(error instanceof Error ? error.message : String(error))
}
