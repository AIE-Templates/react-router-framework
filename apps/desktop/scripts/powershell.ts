import { execFileSync } from "node:child_process";

import { parseWindowsListing, type ProcessInfo } from "./release-verdicts.ts";

/** The environment for powershell.exe: without the caller's PSModulePath, which a PowerShell 7 parent sets for itself. */
function powershellEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of Object.keys(env)) if (name.toLowerCase() === "psmodulepath") delete env[name];
  return env;
}

/** Runs a PowerShell command with UTF-8 output, whatever the console's code page. */
export function powershellOutput(command: string, extra: Record<string, string> = {}): string {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: powershellEnv(extra) },
  );
}

export function windowsProcesses(): ProcessInfo[] {
  return parseWindowsListing(
    powershellOutput(
      "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine," +
        "@{n='Created';e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}}" +
        " | ConvertTo-Json -Compress",
    ),
  );
}

/** Pin the process object before checking its creation time, so a recycled Windows PID is never killed. */
export function windowsProcess(process: ProcessInfo, action: "kill" | "check"): boolean {
  if (process.startedAt === undefined) return false;
  const result = powershellOutput(
    [
      "$ErrorActionPreference = 'Stop'",
      "try { $p = [Diagnostics.Process]::GetProcessById([int]$env:REAP_HELPER_PID) } catch [ArgumentException] { exit 0 }",
      "try {",
      "  $null = $p.Handle",
      "  if ($p.HasExited -or [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() -ne [long]$env:REAP_HELPER_CREATED) { exit 0 }",
      ...(action === "kill" ? ["  $p.Kill()"] : []),
      "  'matched'",
      "} catch { if (!$p.HasExited) { throw } } finally { $p.Dispose() }",
      "exit 0",
    ].join("\n"),
    { REAP_HELPER_PID: String(process.pid), REAP_HELPER_CREATED: String(process.startedAt) },
  );
  return result.trim() === "matched";
}
