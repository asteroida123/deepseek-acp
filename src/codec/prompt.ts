/**
 * ACP prompt 内容块的拍平与能力校验。纯函数，无运行时依赖。
 * @module
 */

import type { ContentBlock, EmbeddedResourceResource } from '@agentclientprotocol/sdk'

/**
 * 内嵌资源 → 文本。
 *
 * 文本资源整段内联，这正是 `embeddedContext` 的用处：用户 @ 一个文件时客户端
 * 直接把内容带过来，模型不必再去读一次盘——**而且读得到磁盘上没有的东西**
 * （未保存的缓冲区、剪贴板片段、diff 视图里选中的一段）。
 *
 * 二进制资源没法内联：base64 塞进提示词既贵又没用。渲染成一条带 uri 与
 * mimeType 的引用——**不静默丢弃**，模型看得见「这里有个附件但我读不了」，
 * 比凭空少一段上下文强。真正的图片支持是 US-23，受阻于上游（见 README）。
 * @param resource - 内嵌的资源负载
 * @returns 拍平后的文本
 */
function embeddedResourceToText(resource: EmbeddedResourceResource): string {
  if ('text' in resource) {
    const mime = resource.mimeType == null ? '' : ` mimeType=${JSON.stringify(resource.mimeType)}`
    return `\n[resource uri=${JSON.stringify(resource.uri)}${mime}]\n${resource.text}\n[/resource]\n`
  }
  const mime = resource.mimeType == null ? '' : ` mimeType=${JSON.stringify(resource.mimeType)}`
  return `\n[resource uri=${JSON.stringify(resource.uri)}${mime} 二进制内容，未内联]\n`
}

/**
 * 把内容块拍平成文本。
 *
 * text 块原样拼接；resource_link 渲染为显式的文本引用——这样 baseline 客户端
 * 能指向文件，而 bridge 不会静默丢掉这段上下文；resource 块见
 * {@link embeddedResourceToText}。
 * @param prompt - 受支持的 ACP prompt 块
 * @returns 按线序拼接的文本
 */
export function acpPromptToText(prompt: readonly ContentBlock[]): string {
  return prompt
    .flatMap((block): string[] => {
      switch (block.type) {
        case 'text':
          return [block.text]
        case 'resource_link':
          return [`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`]
        case 'resource':
          return [embeddedResourceToText(block.resource)]
        default:
          return []
      }
    })
    .join('')
}

/**
 * 是否含本 bridge 未 advertise 的内容。
 *
 * 规范要求每个 agent 都接受 `text` 与 `resource_link`；`resource`（内嵌上下文）
 * 是可选能力，本 bridge **已** advertise（`promptCapabilities.embeddedContext`），
 * 因此也在受支持之列。剩下的 image / audio 仍未 advertise，**显式拒绝而非静默
 * 丢弃**（验收标准 AC-G2）。
 *
 * 这个集合与 `handleInitialize` 里的 `promptCapabilities` 是同一件事的两半：
 * 那边多声明一项而这边不放行，客户端会收到「你说你支持」的困惑错误；这边多
 * 放行一项而那边不声明，规矩的客户端根本不会发过来。改一处必须改另一处。
 * @param prompt - 待检查的 ACP prompt 块
 * @returns 存在未 advertise 的块时为 `true`
 */
export function promptHasUnsupportedContent(prompt: readonly ContentBlock[]): boolean {
  return prompt.some(
    (block) => block.type !== 'text' && block.type !== 'resource_link' && block.type !== 'resource',
  )
}
