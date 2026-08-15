/**
 * 会话工作区事实：模型唯一能知道「自己在哪」的来源。
 *
 * 为什么不用全局 section 加 `AssembleContext.scope` 反查 cwd：那要求把
 * `scope` 当成 `Agent` 并读它的 `session.header.cwd`——一条没有契约保证的内部
 * 路径（风险 R1）。cwd 在会话内是常量，建会话时就已知道，因此按 scope 注册
 * 静态文本更稳，也只用到有文档的 API。
 * @module
 */

/** 拼接工作区事实所需的输入；全部显式传入，便于纯函数测试。 */
export interface WorkspaceFacts {
  /** 会话工作区绝对路径 */
  readonly cwd: string
  /** 平台标识，取自 `process.platform` */
  readonly platform: string
  /** 会话开始日期，`YYYY-MM-DD` */
  readonly date: string
}

/** 章节名：与上游 `harness:identity` / `deployment:persona` 并列，前缀区分归属。 */
export const WORKSPACE_SECTION = 'deepseek-acp:workspace'

/**
 * 排在 persona（0）之后：先说「你是谁」，再说「你在哪」。
 * 工具指引约定用 100–199，故取两者之间。
 */
export const WORKSPACE_ORDER = 10

/**
 * 渲染工作区事实。
 *
 * 刻意只陈述事实，不承诺能力——M1-a 没有任何工具，写成「你可以读取该目录下的
 * 文件」会诱导模型去调用不存在的工具，比不给上下文更糟。
 * @param facts - 会话的工作区事实
 * @returns 章节正文；文本中不含 `{{}}`，避免被变量插值当作引用
 */
export function renderWorkspace(facts: WorkspaceFacts): string {
  return [
    '# 工作区',
    '',
    `- 当前工作目录：${facts.cwd}`,
    `- 平台：${facts.platform}`,
    `- 会话开始日期：${facts.date}`,
    '',
    '用户提到的相对路径都相对于上面这个工作目录来理解。',
  ].join('\n')
}

/**
 * 取本地日期（非 UTC）：模型要对齐的是用户的「今天」。
 * @param now - 时间点
 * @returns `YYYY-MM-DD`
 */
export function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
