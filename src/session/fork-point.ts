/**
 * 「从哪条消息分叉」——`session/fork` 的分叉点约定。
 *
 * ACP 的 `ForkSessionRequest` 没有分叉点参数（只有 `sessionId` / `cwd` /
 * `mcpServers`），所以「在第 3 条回答之后另起一支」这件事在协议里无处安放。
 * 生态里已经长出一个既成约定填这个洞：分叉点搭请求的 `_meta` 搭车，键是
 * `jetbrains.air.fork`。**claude-agent-acp 0.73.0** 与 **codex-acp 1.8.0** 读的
 * 是同一个块，缺席时两边都退化成尾部 fork，因此本模块照抄那个形状而不另立一套
 * ——多一种拼写只会让同一个客户端要为每个 agent 各写一遍。
 *
 * ```jsonc
 * "_meta": { "jetbrains": { "air": { "fork": {
 *   "version": 1,
 *   "messageId": "3:1",                  // 必填
 *   "messageFingerprint": "sha256:…",    // 选填，id 认不出来时的兜底
 *   "messageOccurrence": 2               // 选填，默认 1；同样文本重复出现时取第几个
 * } } } }
 * ```
 *
 * **只有助手消息能当分叉点**，子会话的历史截到那条消息所在回合结束为止。这与
 * 另外两个适配器一致：分叉点的意义是「这条回答之后换个方向」，而「从我自己那句
 * 话继续」本来就是普通 fork 加一次 prompt。
 *
 * 本模块同时持有**发出去的那个 id**（{@link assistantMessageId}）——映射层拿它填
 * `agent_message_chunk.messageId`，这里拿它比对客户端送回来的分叉点。两处必须是
 * 同一个定义，否则客户端原样送回自己收到的 id，我们反而认不出来。
 * @module
 */

import { createHash } from 'node:crypto'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { invalidParams } from '../codec/errors.js'

/** 客户端指名的分叉点。 */
export interface ForkPoint {
  /** 客户端认为的消息标识；认不出来时退到指纹 */
  readonly messageId: string
  /** `sha256:<64 位小写十六进制>`；缺席表示不给兜底 */
  readonly messageFingerprint?: string
  /** 同指纹的第几条，从 1 起 */
  readonly messageOccurrence: number
}

/**
 * 分叉点落不到父会话的某个具体位置上。
 *
 * 三种情形共用它——认不出这条消息、它所在的回合没闭合、两种指纹口径指向不同的
 * 回合——因为对客户端来说三者是同一件事：这次分叉点用不了，换一条消息或改送
 * 一个 id 重发。
 *
 * 独立类型而不是裸 `Error`：`session/fork` 失败后要过一道分诊
 * （`src/protocol/session-missing.ts`），裸 `Error` 会被当成「父会话不在了」改判
 * 成 `-32002`，客户端据此把一条好端端的会话从列表里摘掉。这条的正解是 `-32602`。
 */
export class ForkPointUnresolved extends Error {
  override readonly name = 'ForkPointUnresolved'
}

/** ACP `ContentChunk.messageId` 里那条助手消息的标识。 */
export function assistantMessageId(turn: number, step: number): string {
  return `${turn}:${step}`
}

/**
 * 一条助手消息文本的指纹。
 *
 * `sha256:<hex>` 是 codex-acp 比对的形状，客户端算好之后对三个 agent 发的是同一
 * 个值，所以这里不能换算法也不能换前缀。
 * @param text - 该消息的可见文本
 */
export function fingerprintAgentMessage(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** `^sha256:` 加 64 位小写十六进制——与 codex-acp 的校验同款。 */
const FINGERPRINT_SHAPE = /^sha256:[0-9a-f]{64}$/

/** 老客户端会在 id 后缀上可见分段序号，比对前剥掉。 */
const VISIBLE_SEGMENT_SUFFIX = /:segment:\d+$/

/** 只有真正的对象才继续往下钻——数组与 null 都不是 `_meta` 的容器。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 从请求 `_meta` 里读出分叉点。
 *
 * **块缺席、或版本号不是 1，一律当作没给**（返回 undefined，调用方走尾部 fork）：
 * `_meta` 按规范就是「实现方可以互相不认识」的地方，为一个读不懂的扩展块拒绝整次
 * fork，等于让一个装了新客户端的用户连普通分叉都做不了。
 *
 * 但块**在**且版本对得上之后，字段坏了就必须报错而不是忽略：那时客户端明确要求
 * 「在这条消息上分叉」，悄悄给它一个尾部 fork 是拿另一件事冒充成功。
 * @param meta - `ForkSessionRequest._meta`
 * @returns 分叉点；没给该块时 undefined
 * @throws 块在但字段不合法时抛 `-32602`
 */
export function readForkPoint(meta: unknown): ForkPoint | undefined {
  const fork = asRecord(asRecord(asRecord(asRecord(meta)?.['jetbrains'])?.['air'])?.['fork'])
  if (fork === undefined || fork['version'] !== 1) return undefined

  const messageId = fork['messageId']
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    throw invalidParams('fork messageId must be a non-empty string')
  }
  const messageFingerprint = fork['messageFingerprint']
  if (messageFingerprint !== undefined && (typeof messageFingerprint !== 'string' || !FINGERPRINT_SHAPE.test(messageFingerprint))) {
    throw invalidParams('fork messageFingerprint must look like sha256:<64 lowercase hex digits>')
  }
  const messageOccurrence = fork['messageOccurrence'] ?? 1
  if (typeof messageOccurrence !== 'number' || !Number.isSafeInteger(messageOccurrence) || messageOccurrence < 1) {
    throw invalidParams('fork messageOccurrence must be a positive integer')
  }

  return {
    messageId: messageId.trim(),
    ...(typeof messageFingerprint === 'string' ? { messageFingerprint } : {}),
    messageOccurrence,
  }
}

/**
 * 一条助手消息里客户端看得见的那部分文本。
 *
 * 只取 `text` 块并**跳过空白块**，拼接时不加分隔符——这不是随便定的：codeg 的
 * DeepSeek 解析器就是这么把日志翻成气泡的（空白块直接 `continue`，推理块与工具
 * 块归入别的类型），指纹要对得上就得逐条照着来。
 */
function messageText(message: AssistantMessage): string {
  let text = ''
  for (const block of message.content) {
    if (block.type !== 'text' || block.text.trim().length === 0) continue
    text += block.text
  }
  return text
}

/** 一个候选分叉点：某段文本，以及它属于哪个回合。 */
interface Candidate {
  readonly turn: number
  readonly text: string
}

/** 逐条助手消息——codex-acp 的口径（它按 `agentMessage` 项逐条哈希）。 */
function perMessageCandidates(events: readonly SessionEvent[]): Candidate[] {
  const candidates: Candidate[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const text = messageText(event.data.message)
    if (text.length === 0) continue
    candidates.push({ turn: event.data.turn, text })
  }
  return candidates
}

/**
 * 逐回合拼接——codeg 渲染 DeepSeek 的口径。
 *
 * 两种口径都要支持，因为**同一个客户端对不同 agent 用的粒度不一样**：codeg 把
 * Codex 的每条助手消息渲染成一个气泡，却把 DeepSeek 一整个回合的助手输出并成一个
 * （`parsers/deepseek.rs` 的 `ensure_assistant` 一个回合只开一条）。只实现前者，
 * 多步回合（回答—调工具—再回答）在 codeg 上永远匹配不上。
 *
 * 两种口径在**单步回合上给出同一段文本**，只有多步回合才分得开——`matchedTurn`
 * 正是靠这一点：分得开且各自都中时，说明这次指认是真的说不准。
 */
function perTurnCandidates(events: readonly SessionEvent[]): Candidate[] {
  const byTurn = new Map<number, string>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    byTurn.set(event.data.turn, (byTurn.get(event.data.turn) ?? '') + messageText(event.data.message))
  }
  return [...byTurn]
    .filter(([, text]) => text.length > 0)
    .map(([turn, text]) => ({ turn, text }))
}

/** 按日志顺序取第 `occurrence` 个指纹相符的候选，返回它所在的回合。 */
function nthMatch(candidates: readonly Candidate[], fingerprint: string, occurrence: number): number | undefined {
  let seen = 0
  for (const candidate of candidates) {
    if (fingerprintAgentMessage(candidate.text) !== fingerprint) continue
    seen += 1
    if (seen === occurrence) return candidate.turn
  }
  return undefined
}

/**
 * 分叉点指名的助手消息在哪个回合；认不出来时 undefined。
 * @throws 两种指纹口径指向不同回合时抛 {@link ForkPointUnresolved}
 */
function matchedTurn(events: readonly SessionEvent[], point: ForkPoint): number | undefined {
  const stripped = point.messageId.replace(VISIBLE_SEGMENT_SUFFIX, '')
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const { turn, step, message } = event.data
    const wire = assistantMessageId(turn, step)
    // 两种 id 都认。`wire` 是我们自己在 `agent_message_chunk` 上发出去的那个；
    // `message.id` 是日志里的持久身份（上游对它的说法是「stable identity
    // preserved across every representation boundary」），留给直接读 JSONL 的
    // 客户端——codeg 就是这么认识一条 DeepSeek 会话的。
    if (wire === point.messageId || wire === stripped) return turn
    if (message.id === point.messageId || message.id === stripped) return turn
  }

  const fingerprint = point.messageFingerprint
  if (fingerprint === undefined) return undefined
  // **两种口径都要算完再取舍，不能算出一个就收手。** 客户端按哪种粒度算的指纹，
  // 我们无从得知，先查到的那个未必是它指的那个：设回合 1 两步分别是 `same` /
  // `other`（整回合文本 `sameother`），回合 2 只有 `same`。一个按回合算指纹的
  // 客户端选中回合 2 发来 `sha256("same")`，逐条那一档却会先在回合 1 命中——
  // fork 成功了，选中的那一轮却不在里面。这正是本模块最该避免的那种失败。
  const byMessage = nthMatch(perMessageCandidates(events), fingerprint, point.messageOccurrence)
  const byTurn = nthMatch(perTurnCandidates(events), fingerprint, point.messageOccurrence)
  // 两边都中且不是同一个回合，就是**真的说不准**：没有任何信号能指认客户端用的
  // 是哪种粒度。挑一个等于掷硬币决定用户的历史截在哪，所以宁可让他换一条消息、
  // 或改送一个 id。单步回合下两种口径给出同一段文本，因此这条路极少走到。
  if (byMessage !== undefined && byTurn !== undefined && byMessage !== byTurn) {
    throw new ForkPointUnresolved(
      `fork point message ${point.messageId} is ambiguous: fingerprint ${fingerprint} occurrence ` +
        `${point.messageOccurrence} matches turn ${byMessage} read as one assistant message and ` +
        `turn ${byTurn} read as a whole turn; send a messageId to disambiguate`,
    )
  }
  return byMessage ?? byTurn
}

/**
 * 分叉点 → 种子应当截到的事件下标（含）。
 *
 * 截在**该回合的 `turn/end` 上**，而不是那条助手消息本身：上游对种子的唯一硬性
 * 要求就是「不能停在开着的回合里」（`SessionStore._forkSeed` 会为此抛
 * `OPEN_TURN`），而且那条消息之后同回合的工具调用与结果也属于这次回答，切掉会
 * 留下一串没有结果的调用。
 * @param events - 父会话的完整事件日志，按 seq 升序
 * @param point - 客户端指名的分叉点
 * @returns 可安全用作种子的最后一个事件下标
 * @throws 认不出这条消息、或它所在的回合没闭合时抛 {@link ForkPointUnresolved}
 */
export function forkPointBoundary(events: readonly SessionEvent[], point: ForkPoint): number {
  const turn = matchedTurn(events, point)
  if (turn === undefined) {
    throw new ForkPointUnresolved(`fork point message ${point.messageId} was not found in the parent session`)
  }
  const boundary = events.findIndex((event) => event.type === 'turn/end' && event.data.turn === turn)
  // 回合没闭合只可能是进程崩在里面了。**不静默退到上一个完整回合**：用户指名了
  // 一个点，给他另一个点却报成功，比让他换一条消息重试坏得多。
  if (boundary < 0) {
    throw new ForkPointUnresolved(
      `fork point message ${point.messageId} sits in turn ${turn}, which never closed; pick an earlier message`,
    )
  }
  return boundary
}
