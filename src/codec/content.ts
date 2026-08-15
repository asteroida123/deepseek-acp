/**
 * harness `ContentBlock` → ACP `ContentBlock`。
 *
 * `ContentBlockMap` 是声明合并可扩展的：组合里多挂一个插件就可能多出一种块。
 * 因此这里是**部分函数**——不认识的块返回 `undefined` 由调用方跳过，而不是
 * 抛错或编造一个占位文本。让一个未知块把整条工具卡片打掉是最糟的结果。
 * @module
 */

import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * 映射一个内容块。
 * @param block - harness 内容块
 * @returns 对应的 ACP 块；无法表达时 undefined
 */
export function harnessBlockToAcpContent(block: ContentBlock): AcpContentBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      // ACP 的内容块里没有「思考」这一类。思考走 `agent_thought_chunk` 那条
      // 独立通道；混进工具卡片正文会把它当普通文本展示，反而抹掉了区分。
      return undefined
    default:
      // image 需要 attachment 服务解引用（M2）；tool-call / tool-result 是
      // 转录结构而非可呈现内容。
      return undefined
  }
}

/**
 * 映射一组内容块，丢弃无法表达的。
 * @param blocks - harness 内容块
 * @returns ACP 工具卡片内容项
 */
export function toolResultContent(blocks: readonly ContentBlock[]): { type: 'content'; content: AcpContentBlock }[] {
  const out: { type: 'content'; content: AcpContentBlock }[] = []
  for (const block of blocks) {
    const content = harnessBlockToAcpContent(block)
    if (content !== undefined) out.push({ type: 'content', content })
  }
  return out
}
