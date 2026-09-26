# Quiet recurring Stage B readiness monitor (read-only).
#
# Runs the funded-stage-b-readiness CLI for both markets against the running
# production stack, compares the result with the last recorded state, and writes
# a dated receipt plus an alert only when something material changes. It is
# silent when counts, verdicts, digests and integrity findings are unchanged.
#
# It never writes to the database, never creates a Stage B approval, gate
# policy, enrollment, prediction or authority row, and never enables FP04.
#
# Manual run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stage-b-readiness-monitor.ps1
# Force a receipt even without a transition:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stage-b-readiness-monitor.ps1 -Force

param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$readinessDir = Join-Path $repoRoot "docs\operations\stage-b-readiness"
$receiptsDir = Join-Path $readinessDir "receipts"
$stateDir = Join-Path $env:LOCALAPPDATA "tsx-scanner\stage-b-readiness"
$logPath = Join-Path $stateDir "monitor.log"
$statePath = Join-Path $stateDir "state.json"
$alertPath = Join-Path $readinessDir "MONITOR-ALERT.md"
$bundlePath = Join-Path $stateDir "stage-b-readiness.cjs"
$markets = @("CA_TSX", "US_EQUITIES")

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType Directory -Force -Path $receiptsDir | Out-Null

function Write-Log([string]$message) {
  $line = "{0} {1}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $message
  Add-Content -LiteralPath $logPath -Value $line
}

function Write-Alert([string]$market, [string]$headline, [string]$body) {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $entry = "## $stamp - $market - $headline`r`n`r`n$body`r`n"
  if (-not (Test-Path -LiteralPath $alertPath)) {
    Set-Content -LiteralPath $alertPath -Value "# Stage B readiness monitor alerts`r`n"
  }
  Add-Content -LiteralPath $alertPath -Value $entry
}

function Fail-Monitor([string]$reason) {
  Write-Log "MONITOR_FAILED $reason"
  Write-Alert "ALL" "monitor failure" "- reason: $reason`r`n- exact next action: run the manual command and inspect the log at $logPath"
  exit 1
}

try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail-Monitor "docker is unavailable" }

  $esbuild = Get-ChildItem -Path (Join-Path $repoRoot "node_modules\.pnpm") -Directory -Filter "esbuild@*" |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $esbuild) { Fail-Monitor "esbuild was not found in node_modules/.pnpm" }
  $esbuildBin = Join-Path $esbuild.FullName "node_modules\esbuild\bin\esbuild"
  if (-not (Test-Path -LiteralPath $esbuildBin)) { Fail-Monitor "esbuild binary is missing" }

  $sources = @(
    (Join-Path $repoRoot "apps\api\src\paper-bot\stage-b-readiness.ts"),
    (Join-Path $repoRoot "apps\api\src\paper-bot\stage-b-readiness-cli.ts")
  )
  $needsBuild = -not (Test-Path -LiteralPath $bundlePath)
  if (-not $needsBuild) {
    $bundleTime = (Get-Item -LiteralPath $bundlePath).LastWriteTimeUtc
    foreach ($source in $sources) {
      if ((Get-Item -LiteralPath $source).LastWriteTimeUtc -gt $bundleTime) { $needsBuild = $true }
    }
  }
  if ($needsBuild) {
    & node $esbuildBin (Join-Path $repoRoot "apps\api\src\paper-bot\stage-b-readiness-cli.ts") `
      --bundle --platform=node --format=cjs --outfile=$bundlePath | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail-Monitor "esbuild bundling failed" }
    Write-Log "bundle rebuilt"
  }

  $password = (docker exec tsx-scanner-postgres-1 printenv POSTGRES_PASSWORD).Trim()
  $user = (docker exec tsx-scanner-postgres-1 printenv POSTGRES_USER).Trim()
  $database = (docker exec tsx-scanner-postgres-1 printenv POSTGRES_DB).Trim()
  if (-not $password -or -not $user -or -not $database) { Fail-Monitor "database credentials are unavailable" }
  $databaseUrl = "postgresql://${user}:${password}@postgres:5432/${database}"
  $network = (docker inspect tsx-scanner-api-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}').Trim()
  if (-not $network) { Fail-Monitor "the running api network is unavailable" }
  $revision = (git -C $repoRoot rev-parse HEAD).Trim()

  $previous = $null
  if (Test-Path -LiteralPath $statePath) {
    $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  }
  $next = @{}
  $material = $Force.IsPresent -or ($null -eq $previous)
  $summaryLines = @()

  foreach ($market in $markets) {
    $bundle = Get-Content -LiteralPath $bundlePath -Raw
    $raw = $bundle | docker run --rm -i --network $network -e "DATABASE_URL=$databaseUrl" `
      --entrypoint sh tsx-scanner-api `
      -c "cat > /tmp/stage-b-readiness.cjs && node /tmp/stage-b-readiness.cjs --market=$market --code-revision=$revision"
    if ($LASTEXITCODE -ne 0) { Fail-Monitor "readiness command failed for $market" }
    $receipt = ($raw -join "`n") | ConvertFrom-Json
    $report = $receipt.report

    $exclusions = ($report.exclusionsByReason | ConvertTo-Json -Compress)
    if (-not $exclusions) { $exclusions = "{}" }
    $entry = [ordered]@{
      eligible      = [int]$report.eligibleSessionCount
      structural    = [int]$report.structuralSessionCount
      raw           = [int]$report.rawSessionCount
      verdict       = [string]$report.verdict
      digest        = [string]$report.manifestDigest
      exclusions    = [string]$exclusions
      latest        = [string]$report.latestEligibleSession
      remaining     = [int]$report.remainingRequired
      authority     = ($report.authorityState | ConvertTo-Json -Compress)
      checkedAt     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
      receipt       = $receipt
    }
    $next[$market] = $entry

    $changed = $true
    if ($null -ne $previous -and $previous.PSObject.Properties.Name -contains $market) {
      $old = $previous.$market
      $changed = (
        $old.eligible -ne $entry.eligible -or
        $old.structural -ne $entry.structural -or
        $old.raw -ne $entry.raw -or
        $old.verdict -ne $entry.verdict -or
        $old.digest -ne $entry.digest -or
        $old.exclusions -ne $entry.exclusions -or
        $old.latest -ne $entry.latest -or
        $old.authority -ne $entry.authority
      )
    }
    if ($changed) {
      $material = $true
      $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
      $receiptFile = Join-Path $receiptsDir "$stamp-$($market.ToLower().Replace('_','-')).json"
      Set-Content -LiteralPath $receiptFile -Value (($raw -join "`n") + "`n")
      $priorEligible = if ($null -ne $previous -and $previous.PSObject.Properties.Name -contains $market) { $previous.$market.eligible } else { "none" }
      $newExclusions = if ($null -ne $previous -and $previous.PSObject.Properties.Name -contains $market -and $previous.$market.exclusions -eq $entry.exclusions) { "none" } else { $entry.exclusions }
      $body = @(
        "- prior eligible: $priorEligible",
        "- current eligible: $($entry.eligible) (structural $($entry.structural), raw $($entry.raw))",
        "- newest included session: $($entry.latest)",
        "- new exclusions or integrity findings: $newExclusions",
        "- manifest digest: $($entry.digest)",
        "- remaining eligible sessions required: $($entry.remaining)",
        "- exact next action: review the receipt at $receiptFile; record the transition in the readiness ledger; request per-market Stage B approval only when the verdict is READY_FOR_STAGE_B_REVIEW"
      ) -join "`r`n"
      Write-Alert $market "readiness transition: $($entry.verdict)" $body
      Write-Log "TRANSITION $market verdict=$($entry.verdict) eligible=$($entry.eligible) raw=$($entry.raw) digest=$($entry.digest)"
    }
    $summaryLines += "$market eligible=$($entry.eligible)/40 structural=$($entry.structural) raw=$($entry.raw) verdict=$($entry.verdict)"
  }

  $next | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath
  if ($material) {
    Write-Log ("MATERIAL " + ($summaryLines -join " | "))
  } else {
    Write-Log ("quiet " + ($summaryLines -join " | "))
  }
  exit 0
} catch {
  Fail-Monitor $_.Exception.Message
}
