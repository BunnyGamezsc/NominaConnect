# Build this checkout on Windows, copy its Linux binary to Proxmox, and verify it.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SshTarget,
    [string]$SshIdentityFile,
    [ValidateRange(1, 65535)][int]$SshPort = 22
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$binary = Join-Path $repo 'dist\nomina-linux-x64'
$remote = '/opt/nominaconnect-test/nomina-linux-x64'
$temporary = '/tmp/nomina-linux-x64-upload'

if ($SshTarget -notmatch '^root@[A-Za-z0-9.-]+$') { throw 'Use a root SSH target such as root@192.168.1.3.' }
$bun = Get-Command bun.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$scp = Get-Command scp.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $bun -or -not $ssh -or -not $scp) { throw 'Install Bun and the Windows OpenSSH Client first.' }
$identity = @()
if ($SshIdentityFile) {
    if (-not (Test-Path $SshIdentityFile)) { throw "SSH key not found: $SshIdentityFile" }
    $identity = @('-i', (Resolve-Path $SshIdentityFile).Path)
}

Push-Location $repo
try {
    & $bun.Source run build:native
    if ($LASTEXITCODE -ne 0) { throw 'Local build:native failed.' }
} finally {
    Pop-Location
}
if (-not (Test-Path $binary)) { throw "Build output is missing: $binary" }
$localHash = (Get-FileHash -Path $binary -Algorithm SHA256).Hash.ToLowerInvariant()

& $scp.Source @identity -P $SshPort -o ConnectTimeout=10 $binary "${SshTarget}:$temporary"
if ($LASTEXITCODE -ne 0) { throw 'Binary copy to Proxmox failed.' }
& $ssh.Source @identity -p $SshPort -o ConnectTimeout=10 $SshTarget "mkdir -p /opt/nominaconnect-test && install -m 755 $temporary $remote && rm -f $temporary"
if ($LASTEXITCODE -ne 0) { throw 'Could not install the copied binary on Proxmox.' }
$remoteHashLine = & $ssh.Source @identity -p $SshPort -o ConnectTimeout=10 $SshTarget "sha256sum $remote"
if ($LASTEXITCODE -ne 0) { throw 'Could not hash the binary on Proxmox.' }
$remoteHash = [string]($remoteHashLine | Select-Object -Last 1)
if (-not ($remoteHash -match '^([0-9a-fA-F]{64})\s+')) { throw "Unexpected remote hash output: $remoteHash" }
if ($Matches[1].ToLowerInvariant() -ne $localHash) { throw 'Local and Proxmox binary hashes differ. Do not run field tests.' }
& $ssh.Source @identity -p $SshPort -o ConnectTimeout=10 $SshTarget "$remote --version"
if ($LASTEXITCODE -ne 0) { throw 'The copied Proxmox binary did not start.' }
Write-Output "Verified $remote on Proxmox (SHA-256 $localHash). Use this absolute path for field tests."
