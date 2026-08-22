/**
 * ACP prompt 内容块的拍平与能力校验。纯函数，无运行时依赖。
 * @module
 */

import type { ContentBlock, EmbeddedResourceResource } from '@agentclientprotocol/sdk'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { EncodedImage, PromptPart } from '../port/types.js'

/**
 * 内嵌资源 → 文本。
 *
 * 文本资源整段内联，这正是 `embeddedContext` 的用处：用户 @ 一个文件时客户端
 * 直接把内容带过来，模型不必再去读一次盘——**而且读得到磁盘上没有的东西**
 * （未保存的缓冲区、剪贴板片段、diff 视图里选中的一段）。
 *
 * 二进制资源没法内联：base64 塞进提示词既贵又没用。渲染成一条带 uri 与
 * mimeType 的引用——**不静默丢弃**，模型看得见「这里有个附件但我读不了」，
 * 比凭空少一段上下文强。
 *
 * 图片走的是另一条路（顶层的 `image` 块，见 {@link promptImages}），不经过这里
 * ——内嵌资源里的图片字节没有 media type 之外的准入信息，而附件准入要的正是那些。
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
 * 与 `image` 是可选能力，本 bridge 都 advertise（后者按组合动态，见
 * {@link HarnessPort.images}）。剩下的 audio 仍未 advertise，**显式拒绝而非静默
 * 丢弃**（验收标准 AC-G2）。
 *
 * 这个集合与 `handleInitialize` 里的 `promptCapabilities` 是同一件事的两半：
 * 那边多声明一项而这边不放行，客户端会收到「你说你支持」的困惑错误；这边多
 * 放行一项而那边不声明，规矩的客户端根本不会发过来。改一处必须改另一处。
 *
 * **`image` 只在这里放行，能不能真的收下是调用方的事**：图片要不要拒绝取决于
 * 组合挂没挂附件服务、以及会话**当前**这条路由收不收图，两者都不是纯函数看得
 * 到的东西。所以这里放行、由 `handlePrompt` 用具体理由拒绝——那种拒绝信息能
 * 说清楚「换哪个模型」，而这里只能说「不支持」。
 * @param prompt - 待检查的 ACP prompt 块
 * @returns 存在未 advertise 的块时为 `true`
 */
export function promptHasUnsupportedContent(prompt: readonly ContentBlock[]): boolean {
  return prompt.some(
    (block) =>
      block.type !== 'text' &&
      block.type !== 'resource_link' &&
      block.type !== 'resource' &&
      block.type !== 'image',
  )
}

/**
 * 取出顶层的图片块，按线序。
 * @param prompt - ACP prompt 块
 * @returns 待准入的图片；没有图片时空数组
 */
export function promptImages(prompt: readonly ContentBlock[]): EncodedImage[] {
  return prompt.flatMap((block): EncodedImage[] =>
    block.type === 'image'
      ? [{ mediaType: block.mimeType, data: block.data, ...(block.uri == null ? {} : { name: block.uri })}]
      : [],
  )
}

/**
 * 按线序重建内容树：文本累积成段，图片插进它原本的位置。
 *
 * **相邻文本并成一块**而不是一块一块地发：`[文本][文本][图]` 与
 * `[文本+文本][图]` 对模型是同一段内容，但前者会让每个 `resource_link` 各占一
 * 个块，把一句话切得七零八落。
 * @param prompt - ACP prompt 块
 * @param images - 与 {@link promptImages} **同序**的准入结果
 * @returns 可交给 `driver.prepare` 的有序片段
 */
export function acpPromptToParts(
  prompt: readonly ContentBlock[],
  images: readonly ImageAttachmentRef[],
): PromptPart[] {
  const parts: PromptPart[] = []
  let pending = ''
  let taken = 0
  const flush = (): void => {
    if (pending.length === 0) return
    parts.push({ kind: 'text', text: pending })
    pending = ''
  }
  for (const block of prompt) {
    if (block.type === 'image') {
      const image = images[taken]
      taken += 1
      // 引用少于图片块只可能是调用方把两个序列配错了。丢掉一张图是静默的数据
      // 损失（模型看到的问题里少了一张图，而它不知道），所以宁可炸。
      if (image === undefined) throw new Error('image attachment refs are fewer than image blocks')
      flush()
      parts.push({ kind: 'image', image })
      continue
    }
    pending += acpPromptToText([block])
  }
  flush()
  return parts
}
