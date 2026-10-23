$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
      $k = $matches[1].Trim()
      $v = $matches[2].Trim()
      [Environment]::SetEnvironmentVariable($k, $v, "Process")
    }
  }
}
Set-Location $root
node watcher10.mjs
