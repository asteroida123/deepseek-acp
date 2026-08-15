/**
 * 在 agent 作用域挂载 MCP server（US-20，ADR-4 已由 Spike 2 实证）。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpMountSpec } from './spec.js'

/**
 * 逐个挂载，全部就绪后返回。
 *
 * **必须在 `setup` 内 await**：工厂会 await 整个 setup，而 `agentCtx.plugin()`
 * 返回 thenable 的 Fiber，因此 `session/new` 返回时工具必然已注册，客户端无需
 * 额外的就绪轮询（Spike 2 A6）。
 *
 * 调用方要注意 setup 的返回值契约：`setup` 必须返回 `void`，直接
 * `setup: (c) => mountMcpServers(c, specs)` 会让工厂对 Promise 调 `.commit()`
 * 而崩溃（约束 C3，TC-CONTRACT-02 守护）。
 * @param agentCtx - agent 作用域 context
 * @param specs - 已翻译的挂载配置
 * @param plugin - MCP 客户端插件（注入以便测试替身）
 */
export async function mountMcpServers(
  agentCtx: Context,
  specs: readonly McpMountSpec[],
  plugin: unknown,
): Promise<void> {
  // 串行而非并行：两个 spec 若算出同名（客户端送了两个同名 server），要的是
  // 一个确定的「第二个失败」，而不是取决于调度的竞态。
  for (const spec of specs) {
    await agentCtx.plugin(plugin as never, spec as never)
  }
}
