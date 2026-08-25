import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import {
  ENCODING_PREAMBLE as UPSTREAM_ENCODING_PREAMBLE,
  PwshLocalExecutor,
} from '@deepseek-ai/dsh-pwsh-local'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'

/**
 * PowerShell 5.1 enters ConstrainedLanguage under the Windows read-only ACL
 * runner. Setting Console.OutputEncoding is forbidden there, while assigning
 * the core Encoding.UTF8 singleton to $OutputEncoding remains available.
 */
export const COMPAT_ENCODING_PREAMBLE = [
  '$OutputEncoding = [System.Text.Encoding]::UTF8;',
  "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {",
  '  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '};',
  '',
].join(' ')

function compatibleArgv(argv: string[], spec: ShellExecSpec): string[] {
  const commandIndex = argv.length - 1
  const expected = `${UPSTREAM_ENCODING_PREAMBLE}${spec.command}`
  if (argv[commandIndex] !== expected) {
    throw new Error('pwsh compatibility contract changed: command is no longer the final argv element')
  }
  argv[commandIndex] = `${COMPAT_ENCODING_PREAMBLE}${spec.command}`
  return argv
}

/** Local executor used by tests and non-confining compositions on Windows. */
export class CompatiblePwshLocalExecutor extends PwshLocalExecutor {
  protected override argv(spec: ShellExecSpec): string[] {
    return compatibleArgv(super.argv(spec), spec)
  }
}

/** Production Windows executor; all sandbox behavior remains upstream-owned. */
export class CompatibleSandboxPwshExecutor extends SandboxPwshExecutor {
  protected override argv(spec: ShellExecSpec): string[] {
    return compatibleArgv(super.argv(spec), spec)
  }
}
