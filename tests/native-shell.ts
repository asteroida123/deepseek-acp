import { nativeShellToolName } from '../src/composition/shell.js'

export const NATIVE_SHELL_TOOL = nativeShellToolName()

export function nativeCommand(commands: { bash: string; pwsh: string }): string {
  return NATIVE_SHELL_TOOL === 'pwsh' ? commands.pwsh : commands.bash
}

export function shellLiteral(value: string): string {
  return NATIVE_SHELL_TOOL === 'pwsh'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`
}

export function stdoutCommand(text: string): string {
  const value = shellLiteral(text)
  return nativeCommand({ bash: `printf '%s\\n' ${value}`, pwsh: `Write-Output ${value}` })
}

export function stderrAndExitCommand(text: string, exitCode: number): string {
  const value = shellLiteral(text)
  return nativeCommand({
    bash: `printf '%s\\n' ${value} >&2; exit ${exitCode}`,
    pwsh: `[Console]::Error.WriteLine(${value}); exit ${exitCode}`,
  })
}

export function cwdCommand(): string {
  return nativeCommand({ bash: 'pwd', pwsh: '(Get-Location).Path' })
}

export function writeFileCommand(path: string, content: string): string {
  const file = shellLiteral(path)
  const value = shellLiteral(content)
  return nativeCommand({
    bash: `printf '%s' ${value} > ${file}`,
    pwsh: `Set-Content -LiteralPath ${file} -Value ${value} -NoNewline`,
  })
}
