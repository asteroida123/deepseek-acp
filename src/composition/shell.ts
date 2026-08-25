import type { Context } from '@deepseek-ai/cordis'

export type NativeShellMode = 'local' | 'sandbox'
export type NativeShellToolName = 'bash' | 'pwsh'

export interface NativeShellOptions {
  /** Test/deployment override; omitted production calls use upstream discovery. */
  pwshPath?: string
}

/** The one shell dialect exposed to the model on a given platform. */
export function nativeShellToolName(platform: NodeJS.Platform = process.platform): NativeShellToolName {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

/**
 * Mount the platform-native executor and its matching model-facing tool.
 * Subprocess, shell-env, and (for sandbox mode) sandbox services must already
 * be mounted by the owning composition.
 */
export async function mountNativeShell(
  ctx: Context,
  mode: NativeShellMode,
  options: NativeShellOptions = {},
): Promise<NativeShellToolName> {
  if (process.platform === 'win32') {
    const [executors, PwshTool] = await Promise.all([
      import('./pwsh-compat.js'),
      import('@deepseek-ai/dsh-tool-pwsh'),
    ])
    const config = options.pwshPath === undefined ? {} : { pwshPath: options.pwshPath }
    if (mode === 'sandbox') await ctx.plugin(executors.CompatibleSandboxPwshExecutor, config)
    else await ctx.plugin(executors.CompatiblePwshLocalExecutor, config)
    await ctx.plugin(PwshTool, { enableRunInBackground: false })
    return 'pwsh'
  }

  if (mode === 'sandbox') {
    const { default: SandboxBash } = await import('@deepseek-ai/dsh-bash-sandbox')
    await ctx.plugin(SandboxBash, {})
  } else {
    const { default: LocalBash } = await import('@deepseek-ai/dsh-bash-local')
    await ctx.plugin(LocalBash, {})
  }
  const BashTool = await import('@deepseek-ai/dsh-tool-bash')
  await ctx.plugin(BashTool, { enableRunInBackground: false })
  return 'bash'
}
