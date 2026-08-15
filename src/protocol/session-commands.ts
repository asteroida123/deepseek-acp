/**
 * `available_commands_update` —— 把命令注册表与技能目录投影成 ACP 的斜杠目录
 * （US-18 + US-27）。
 *
 * ACP 这条更新是**全量快照**，不是增量：客户端收到就整体替换自己的缓存。因此
 * 每次都推完整列表，也因此不需要「哪些变了」这种差异计算。
 *
 * 两个来源合在一条更新里，是因为它们在用户那边**本来就是一件事**：都是敲
 * `/名字`。协议侧也没有第二个面可放——ACP 不认识「技能」这个概念。
 * @module
 */

import type { AvailableCommand, SessionUpdate } from '@agentclientprotocol/sdk'
import type { Bridge } from '../bridge.js'
import type { CommandInfo, SkillInfo } from '../port/types.js'
import type { SessionRecord } from '../session/table.js'

/**
 * 技能条目在下拉框里的描述前缀。
 *
 * 命令与技能在一个扁平列表里长得一模一样，但**行为差得很远**：命令不进模型
 * （`/plan` 就地切模式），技能进——它把一整份指令注入这一回合，是要花 token 的。
 * 用户有权在点下去之前知道自己点的是哪一种。
 */
const SKILL_LABEL = '技能：'

/**
 * 技能条目的输入提示。
 *
 * 技能**收**自由文本：上游扫的是「消息里任意位置的 `/名字` 空白分隔 token」，
 * 所以 `/写周报 这周做了 A 和 B` 是正常用法而不是语法错误。不给 hint 的话，
 * 一部分客户端会把这一项当成不收参数的命令，敲完名字就不让往下打了。
 */
const SKILL_HINT = '补充说明（可选）'

/**
 * 命令与技能 → ACP 发现结构。
 *
 * **命令赢重名，技能整条丢掉。** 因为真正执行的是命令：`commands.run()` 对已注册
 * 的名字返回非 undefined，请求根本到不了模型侧，技能手势也就永远不会触发。两个都
 * 登记等于给客户端一个点了不生效的条目。
 * @param commands - 该会话可见的命令
 * @param skills - 该会话可见的用户可调用技能
 * @returns ACP 斜杠目录，命令在前
 */
export function toAvailableCommands(
  commands: readonly CommandInfo[],
  skills: readonly SkillInfo[] = [],
): AvailableCommand[] {
  const taken = new Set(commands.map((command) => command.name))
  return [
    ...commands.map((command) => ({
      // ACP 的 `name` 不含斜杠 —— 斜杠是客户端输入框的触发符，不是名字的一部分。
      name: command.name,
      description: command.description,
      ...(command.hint === undefined ? {} : { input: { hint: command.hint } }),
    })),
    ...skills
      .filter((skill) => !taken.has(skill.name))
      .map((skill) => ({
        name: skill.name,
        description: `${SKILL_LABEL}${skill.description}`,
        input: { hint: SKILL_HINT },
      })),
  ]
}

/**
 * 某会话当前的斜杠目录快照。
 *
 * **异步**，因为技能发现可能要问远程提供方。等待是有界的，超时退化成「这一次没有
 * 技能」而不是让调用方挂住（见 `SkillPlane.list`）。
 * @param bridge - 运行时
 * @param record - 会话记录
 * @returns 快照更新；两个面都没挂时 undefined
 */
export async function commandsUpdate(
  bridge: Bridge,
  record: SessionRecord,
): Promise<SessionUpdate | undefined> {
  const commands = bridge.port.commands
  const skills = bridge.port.skills
  // 两个都没有才什么都不发。只挂了技能面也要发：那种组合里 `/名字` 照样穿透到
  // 模型侧并触发注入（命令面缺席时 `runCommand` 直接返回 undefined），功能是真的
  // 可用，只是没有命令而已。
  if (commands === undefined && skills === undefined) return undefined
  // 按**这个 agent** 解析而非取全局视图：命令与技能都可以注册在 agent 作用域上
  // 遮蔽同名全局项，用错 scope 不会报错，只会给出一份别人的目录。
  const agent = record.handle.agent
  return {
    sessionUpdate: 'available_commands_update',
    availableCommands: toAvailableCommands(
      commands?.list(agent) ?? [],
      (await skills?.list(agent, record.cwd)) ?? [],
    ),
  }
}

/**
 * 注册表变更后刷新**全部**在册会话。
 *
 * 变更可能是全局的，也可能只影响某一个 agent 的遮蔽层，从这两条事件上都分辨不出来
 * ——它们连参数都没有（`skills/change` 上游明说是「不带 diff 的失效通知」）。逐个
 * 会话各自重新解析是唯一正确的做法。
 *
 * 各会话**并发**刷新：技能发现是 IO，串行会让 N 个会话各自等一遍上限。
 * @param bridge - 运行时
 */
export async function refreshCommands(bridge: Bridge): Promise<void> {
  await Promise.all(
    [...bridge.table.values()].map(async (record) => {
      const update = await commandsUpdate(bridge, record)
      if (update !== undefined) bridge.notify(record.acpSessionId, update)
    }),
  )
}
