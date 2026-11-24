# Restore an archive and rehearse the audit migration on a new local cluster.
# NEVER accepts a database URL: all connections are to the cluster created here.
# The stopped cluster is retained because it contains a copy of the archive.
param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$ExpectedSha256,
    [string]$PgBin = "C:\Program Files\PostgreSQL\17\bin"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:TEMP ("hms-prisma-rehearsal-" + [guid]::NewGuid().ToString("N"))
$data = Join-Path $root "data"
$log = Join-Path $root "postgres.log"
$database = "audit_rehearsal_" + [guid]::NewGuid().ToString("N")
$psql = Join-Path $PgBin "psql.exe"
$original = @{}
$started = $false
$failed = $false

# Do not let libpq environment settings override local connections; likewise
# restore application variables after the command, even if a check fails.
$keys = @("DATABASE_URL", "DIRECT_URL", "SAAS_ENVIRONMENT", "SAAS_DATABASE_IDENTIFIER")
$keys += @(Get-ChildItem Env: | Where-Object { $_.Name -match '^PG' } | ForEach-Object { $_.Name })
foreach ($key in ($keys | Select-Object -Unique)) {
    $original[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $null, "Process")
}

try {
    Set-Location $repo
    if ($ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Expected SHA-256 must contain 64 hex digits." }
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ine $ExpectedSha256) { throw "Archive digest mismatch." }
    foreach ($name in @("initdb", "pg_ctl", "psql", "pg_restore")) {
        if (!(Test-Path (Join-Path $PgBin "$name.exe"))) { throw "PostgreSQL tool missing: $name" }
    }
    node scripts/verify-migration-eol.mjs
    if ($LASTEXITCODE -ne 0) { throw "Migration files must have the reviewed LF line endings." }
    node scripts/migration-ledger.mjs manifest --check
    if ($LASTEXITCODE -ne 0) { throw "Migration files differ from the reviewed manifest." }

    New-Item -ItemType Directory -Path $root | Out-Null
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); $port = $listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
    & "$PgBin\initdb.exe" -D $data -U postgres -A trust --encoding=UTF8
    if ($LASTEXITCODE -ne 0) { throw "initdb failed." }
    & "$PgBin\pg_ctl.exe" -D $data -l $log -o "-h 127.0.0.1 -p $port" -w start
    if ($LASTEXITCODE -ne 0) { throw "Local server did not report successful startup. Check the local cluster before cleanup." }
    $started = $true
    $base = "postgresql://postgres@127.0.0.1:$port/postgres"
    $target = "postgresql://postgres@127.0.0.1:$port/$database"
    function Assert-LocalCluster {
        $actual = & $psql -X -v ON_ERROR_STOP=1 -At -d $base -c "SHOW data_directory"
        if ($LASTEXITCODE -ne 0) { throw "Could not inspect local server identity." }
        $expected = [IO.Path]::GetFullPath($data).Replace('/', '\').TrimEnd('\')
        $found = [IO.Path]::GetFullPath($actual.Trim()).Replace('/', '\').TrimEnd('\')
        if ($expected -ine $found) { throw "Server does not match the new local cluster." }
    }
    Assert-LocalCluster
    node scripts/restore-rehearsal.mjs --dump $Archive --expect-sha256 $ExpectedSha256 --base-url $base --database $database --psql $psql --pg-restore "$PgBin\pg_restore.exe" --profile plain --keep
    if ($LASTEXITCODE -ne 0) { throw "Restoring the archive failed." }
    Assert-LocalCluster

    # SQL files avoid Windows' native argument quoting of mixed-case identifiers.
    $ledgerSql = @'
SELECT COALESCE(json_agg(json_build_object('name', migration_name, 'checksum', checksum, 'finished', finished_at IS NOT NULL, 'rolledBack', rolled_back_at IS NOT NULL)), '[]'::json)::text FROM public."_prisma_migrations";
'@
    $fingerprintSql = @'
SELECT count(*)::text || ':' || md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY t.id), '')) FROM public."AuditLog" t;
'@
    $ledgerFile = Join-Path $root "ledger-query.sql"
    $ledgerJson = Join-Path $root "ledger.json"
    $fingerprintFile = Join-Path $root "audit-fingerprint.sql"
    [IO.File]::WriteAllText($ledgerFile, $ledgerSql, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($fingerprintFile, $fingerprintSql, [Text.UTF8Encoding]::new($false))
    $rows = & $psql -X -v ON_ERROR_STOP=1 -At -d $target -f $ledgerFile
    if ($LASTEXITCODE -ne 0) { throw "Could not read the restored migration ledger." }
    [IO.File]::WriteAllText($ledgerJson, ($rows -join "`n"), [Text.UTF8Encoding]::new($false))
    node scripts/audit-rehearsal-ledger.mjs prisma/migration-release-manifest.json $ledgerJson
    if ($LASTEXITCODE -ne 0) { throw "Restored ledger preflight failed." }
    $before = & $psql -X -v ON_ERROR_STOP=1 -At -d $target -f $fingerprintFile
    if ($LASTEXITCODE -ne 0 -or $before -notmatch '^\d+:[0-9a-f]{32}$') { throw "Could not fingerprint restored audit rows." }

    Assert-LocalCluster
    $env:DATABASE_URL = $target
    $env:DIRECT_URL = $target
    $env:SAAS_ENVIRONMENT = "saas"
    $env:SAAS_DATABASE_IDENTIFIER = $database
    # The wrapper independently checks both URLs against the disposable name.
    node scripts/prisma-safe.mjs migrate deploy
    if ($LASTEXITCODE -ne 0) { throw "Prisma migration deployment failed on the local copy." }
    Assert-LocalCluster
    & $psql -X -v ON_ERROR_STOP=1 -d $target -f .github/scripts/ci-audit-protection.sql
    if ($LASTEXITCODE -ne 0) { throw "Audit protection checks failed on the local copy." }
    Assert-LocalCluster
    $after = & $psql -X -v ON_ERROR_STOP=1 -At -d $target -f $fingerprintFile
    if ($LASTEXITCODE -ne 0 -or $before -ne $after) { throw "Restored audit rows changed." }
    node scripts/prisma-safe.mjs migrate status
    if ($LASTEXITCODE -ne 0) { throw "Prisma migration status check failed." }
    Write-Host "PASS: Prisma deployed the pending audit migration on the local copy."
    Write-Host "PASS: Audit protection checks passed and existing audit rows are unchanged."
}
catch {
    $failed = $true
    Write-Host "STOP: $($_.Exception.Message)"
}
finally {
    if ($started) {
        & "$PgBin\pg_ctl.exe" -D $data -m fast -w stop
        if ($LASTEXITCODE -ne 0) { $failed = $true; Write-Host "WARNING: Temporary server did not stop." }
    } elseif (Test-Path (Join-Path $data "postmaster.pid")) {
        $failed = $true
        Write-Host "WARNING: A postmaster PID file exists after failed startup; inspect before cleanup."
    }
    foreach ($key in $original.Keys) { [Environment]::SetEnvironmentVariable($key, $original[$key], "Process") }
    Write-Host "Local rehearsal folder (contains test data if restored): $root"
}
if ($failed) { exit 1 }
