/**
 * 语言服务器的发现与组合（模型面 `lsp` 工具）。
 *
 * ## 为什么需要这一层
 *
 * 上游 `dsh-lsp-stdio` 是一个**通用宿主，不是语言服务器目录**（它的 README 明写
 * 「presets belong in `cordis.yml` overlays」）：`servers` 表必须至少有一项、每项
 * 的 `command` 必填，而且——这是关键——**可执行文件在插件加载时就解析**，「a bad
 * later entry prevents every provider from registering」。
 *
 * 也就是说，把一张写死的默认表直接挂上去，只要用户机器上少装一个语言服务器，
 * **整个 agent 就起不来**。对一个 `npx` 装完就跑的编辑器适配器来说这是不可接受
 * 的：绝大多数人不会预装 gopls。
 *
 * 所以这里先按 PATH 把候选表筛一遍，只把**这台机器上真的存在**的那几项交下去，
 * 并且把解析好的绝对路径交下去——让上游再解析一次就等于把「我们筛过了」这件事
 * 交还给运气（PATH 在父子进程之间可以不一样）。一个都没筛出来时整套插件干脆不挂：
 * 一个必然报错的工具比没有工具更坏，何况 `tool-lsp` 还会往**每一次**请求的系统
 * 提示里塞一段固定引导。
 *
 * ## 发现放在 boot、组合放在 composeAgent
 *
 * PATH 是部署环境，随机器变；组合是能力装配，给定输入就该确定。混在一起的后果很
 * 具体：`tests/composition.spec.ts` 断的是 `composeAgent` 的装配结果，而它会变成
 * 「取决于跑测试的这台机器装没装 typescript-language-server」。所以 `servers` 表
 * 是 `composeAgent` 的**入参**，与 `sessionsRoot` 同样的处理。
 * @module
 */

import { access, constants } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'

/** 一条语言服务器配置，形状取自 `dsh-lsp-stdio` 的 Config。 */
export interface LspServerSpec {
  /** 可执行文件；候选表里写命令名，交出去时已解析成绝对路径 */
  readonly command: string
  readonly args?: readonly string[]
  /** 小写带前导点的扩展名 → LSP language id */
  readonly extensionToLanguage: Readonly<Record<string, string>>
}

/**
 * 内置候选表。
 *
 * 挑的是「编辑器用户多半已经装了」的那几个，而不是「我们支持哪些语言」——每一项
 * 都要先在 PATH 上找得到才会进最终的表。想用别的（`deno lsp`、项目本地的
 * `node_modules/.bin/…`、公司自研的服务器）走 {@link LSP_SERVERS_ENV}。
 *
 * TypeScript 那条是上游唯一有 e2e 兜底的（README 称之为 compatibility floor），
 * 其余几条是同样协议下的合理推定，没有上游保证。
 */
const LSP_CANDIDATES: Readonly<Record<string, LspServerSpec>> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.ts': 'typescript',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.jsx': 'javascriptreact',
    },
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
  },
  // gopls 与 rust-analyzer 不带参数时本来就是在 stdio 上跑 LSP 服务端。
  go: { command: 'gopls', extensionToLanguage: { '.go': 'go' } },
  rust: { command: 'rust-analyzer', extensionToLanguage: { '.rs': 'rust' } },
}

/**
 * 覆盖内置候选表的环境变量，值是 `dsh-lsp-stdio` 的 `servers` JSON。
 *
 * 设了就**整表替换**而不是合并：想去掉某一条内置项的人，在合并语义下没有任何
 * 办法表达「不要这个」。
 */
export const LSP_SERVERS_ENV = 'DEEPSEEK_ACP_LSP_SERVERS'

/**
 * 在 PATH 上找一个可执行文件。
 * @param command - 命令名；已经是绝对路径时原样校验
 * @param env - 进程环境
 * @returns 绝对路径；找不到或不可执行时 undefined
 */
async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const executable = async (candidate: string): Promise<boolean> => {
    try {
      await access(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (isAbsolute(command)) return (await executable(command)) ? command : undefined

  // Windows 上命令名与磁盘上的文件名对不上：`typescript-language-server` 实际是
  // 一个 `.cmd` 垫片。PATHEXT 就是这份后缀清单，照它试。
  const suffixes =
    process.platform === 'win32'
      ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)]
      : ['']
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    for (const suffix of suffixes) {
      const candidate = join(dir, `${command}${suffix}`)
      if (await executable(candidate)) return candidate
    }
  }
  return undefined
}

/** 解析 {@link LSP_SERVERS_ENV}；没设或不是合法 JSON 对象时 undefined。 */
function configuredServers(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): Record<string, LspServerSpec> | undefined {
  const raw = env[LSP_SERVERS_ENV]
  if (raw === undefined || raw.trim().length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object keyed by server id')
    }
    return parsed as Record<string, LspServerSpec>
  } catch (error: unknown) {
    // 不因为一个配错的环境变量拒绝启动：LSP 是锦上添花，而这个变量多半是手写的。
    // 退回内置候选表，但把原因说出来——静默忽略会让用户以为配置生效了。
    warn(`${LSP_SERVERS_ENV} is not valid JSON, falling back to built-in candidates: ${String(error)}`)
    return undefined
  }
}

/**
 * 筛出这台机器上真的可用的语言服务器。
 * @param env - 进程环境
 * @param warn - 诊断输出；显式配置的条目找不到时用它说明
 * @returns `servers` 表；一条都没有时 undefined（此时整套 LSP 插件都不该挂）
 */
export async function discoverLspServers(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = () => {},
): Promise<Record<string, LspServerSpec> | undefined> {
  const configured = configuredServers(env, warn)
  const table = configured ?? LSP_CANDIDATES
  const entries = await Promise.all(
    Object.entries(table).map(async ([id, spec]) => {
      const command = await resolveExecutable(spec.command, env)
      if (command === undefined) {
        // 显式配置的条目找不到要出声，内置候选找不到不必——后者的缺席是常态，
        // 每次启动为四个没装的语言服务器各报一句只会变成噪声。
        if (configured !== undefined) {
          warn(`lsp server "${id}" is configured but "${spec.command}" was not found on PATH; skipping`)
        }
        return undefined
      }
      return [id, { ...spec, command }] as const
    }),
  )
  const usable = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  return usable.length === 0 ? undefined : Object.fromEntries(usable)
}

/**
 * 挂上 LSP 三件套。
 *
 * **动态 import**：三个包合计约 0.3 秒的加载开销，而一台没装任何语言服务器的机器
 * 完全用不上它们。这与 pi-ai 那边是同一个取舍（见 `src/composition/pi-ai.ts`），
 * 只是量级小得多，因此这里不需要那套幂等守卫——`composeAgent` 一个进程只跑一次。
 * @param ctx - agent 组合的 context
 * @param servers - 已解析成绝对路径的 `servers` 表，非空
 */
export async function composeLsp(
  ctx: import('@deepseek-ai/cordis').Context,
  servers: Readonly<Record<string, LspServerSpec>>,
): Promise<void> {
  const [{ default: LspService }, LspStdio, ToolLsp] = await Promise.all([
    import('@deepseek-ai/dsh-lsp'),
    import('@deepseek-ai/dsh-lsp-stdio'),
    import('@deepseek-ai/dsh-tool-lsp'),
  ])
  // 服务位先于提供方，提供方先于工具：`lsp-stdio` inject `lsp`，`tool-lsp` 也
  // inject `lsp`，而工具在没有任何提供方时只能对每次调用报「没有路由」。
  // 服务位不收配置（Config 是 `undefined`），传 `{}` 会被类型拒绝。
  await ctx.plugin(LspService)
  await ctx.plugin(LspStdio, { servers } as never)
  await ctx.plugin(ToolLsp, {})
}
