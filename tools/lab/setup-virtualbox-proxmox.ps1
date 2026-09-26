# Self-service Windows host setup for a Proxmox VM and nested LXCs.
# Run in an elevated Windows PowerShell 5.1 window while the VM is powered off.
[CmdletBinding()]
param(
    [ValidateSet('setup', 'status', 'remove')][string]$Action = 'setup',
    [string]$VmName,
    [string]$SshTarget,
    [string]$SshIdentityFile,
    [ValidateRange(1, 65535)][int]$SshPort = 22,
    [string]$LabPrefix = '172.28.240',
    [ValidateRange(2, 8)][int]$NicSlot = 2,
    [ValidateSet('gui', 'headless')][string]$StartType = 'gui'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$guestScript = Join-Path $PSScriptRoot 'proxmox-lab-network.sh'
$stateDir = Join-Path $env:LOCALAPPDATA 'NominaConnect\lab'

function Fail([string]$Message) { throw "Nomina lab: $Message" }

function Get-VBoxPath {
    $found = Get-Command VBoxManage.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
    $candidate = Join-Path $env:ProgramFiles 'Oracle\VirtualBox\VBoxManage.exe'
    if (Test-Path $candidate) { return $candidate }
    Fail 'Install VirtualBox, or add VBoxManage.exe to PATH.'
}

$script:vbox = Get-VBoxPath

function Invoke-VBox([string[]]$Arguments) {
    $output = @(& $script:vbox @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Fail "VBoxManage $($Arguments -join ' ') failed: $(($output | Out-String).Trim())"
    }
    return $output
}

function Get-VmInfo {
    $properties = @{}
    foreach ($line in (Invoke-VBox -Arguments @('showvminfo', $VmName, '--machinereadable'))) {
        if ($line -match '^([^=]+)=(.*)$') {
            $properties[$Matches[1]] = $Matches[2].Trim('"')
        }
    }
    if (-not $properties.ContainsKey('UUID')) { Fail "Could not read VirtualBox VM '$VmName'." }
    return $properties
}

function Get-HostOnlyNames {
    $names = @()
    foreach ($line in (Invoke-VBox -Arguments @('list', 'hostonlyifs'))) {
        if ($line -match '^Name:\s*(.+)$') { $names += $Matches[1].Trim() }
    }
    return $names
}

function Require-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Fail 'Open Windows PowerShell as Administrator to create or remove the VirtualBox host-only adapter.'
    }
}

function Confirm-LabPrefix {
    if ($LabPrefix -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') {
        Fail 'LabPrefix must contain the first three octets of a private /24, such as 172.28.240.'
    }
    $parts = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
    if (@($parts | Where-Object { $_ -gt 255 }).Count -gt 0) { Fail 'LabPrefix has an invalid octet.' }
    $private = ($parts[0] -eq 10) -or
        ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31) -or
        ($parts[0] -eq 192 -and $parts[1] -eq 168)
    if (-not $private) { Fail 'Choose a private IPv4 /24 for the lab.' }
}

function Confirm-NoOverlap {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -like "$LabPrefix.*" })
    if ($addresses.Count -gt 0) {
        Fail "$LabPrefix.0/24 already has a Windows interface address. Choose another -LabPrefix."
    }
    $route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$LabPrefix.0/24" -ErrorAction SilentlyContinue
    if ($route) { Fail "$LabPrefix.0/24 already has a Windows route. Choose another -LabPrefix." }
}

function Confirm-SshTarget {
    if (-not $SshTarget) { $script:SshTarget = Read-Host 'Existing Proxmox SSH target (root@address)' }
    if ($SshTarget -notmatch '^root@([A-Za-z0-9.-]+)$') {
        Fail 'Pass an existing root SSH target such as root@192.168.1.3.'
    }
    return $Matches[1]
}

function Wait-ForSsh([string]$HostName) {
    for ($attempt = 1; $attempt -le 24; $attempt++) {
        if (Test-NetConnection -ComputerName $HostName -Port $SshPort -InformationLevel Quiet -WarningAction SilentlyContinue) {
            return
        }
        Start-Sleep -Seconds 5
    }
    Fail "SSH at ${HostName}:$SshPort did not answer. The host-only adapter is saved; rerun setup after fixing the VM's existing management connection."
}

function Invoke-Guest([string]$GuestAction, $State) {
    $hostName = Confirm-SshTarget
    Wait-ForSsh $hostName
    $scp = Get-Command scp.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $scp -or -not $ssh) { Fail 'Install the Windows OpenSSH Client optional feature.' }
    if (-not (Test-Path $guestScript)) { Fail "Missing companion script: $guestScript" }
    $identityArgs = @()
    if ($SshIdentityFile) {
        if (-not (Test-Path $SshIdentityFile)) { Fail "SSH key file does not exist: $SshIdentityFile" }
        $identityArgs = @('-i', (Resolve-Path $SshIdentityFile).Path)
    }
    & $scp.Source @identityArgs -P $SshPort -o ConnectTimeout=10 $guestScript "${SshTarget}:/root/nomina-lab-network.sh"
    if ($LASTEXITCODE -ne 0) { Fail 'Could not copy the Proxmox network script over SSH.' }
    $command = if ($GuestAction -eq 'install') {
        "bash /root/nomina-lab-network.sh install --mac $($State.nicMac) --ip $($State.vmIp)/24 --subnet $($State.subnet)"
    } else {
        "bash /root/nomina-lab-network.sh $GuestAction"
    }
    & $ssh.Source @identityArgs -p $SshPort -o ConnectTimeout=10 $SshTarget $command
    if ($LASTEXITCODE -ne 0) { Fail "Proxmox $GuestAction failed. The Windows adapter and VM settings remain for a retry." }
}

function Save-State($State) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $State | ConvertTo-Json -Depth 4 | Set-Content -Path $script:statePath -Encoding UTF8
}

function Get-State {
    if (Test-Path $script:statePath) {
        return Get-Content -Raw -Path $script:statePath | ConvertFrom-Json
    }
    return $null
}

function Start-VmIfStopped {
    $info = Get-VmInfo
    if ($info.VMState -eq 'poweroff') {
        [void](Invoke-VBox -Arguments @('startvm', $VmName, '--type', $StartType))
        return
    }
    if ($info.VMState -ne 'running') { Fail "VM state '$($info.VMState)' is unsupported. Power it off cleanly first." }
}

function Stop-VmIfRunning {
    $info = Get-VmInfo
    if ($info.VMState -eq 'poweroff') { return $false }
    if ($info.VMState -ne 'running') { Fail 'Power off the VM cleanly before removing its host-only adapter.' }
    [void](Invoke-VBox -Arguments @('controlvm', $VmName, 'acpipowerbutton'))
    for ($attempt = 1; $attempt -le 24; $attempt++) {
        Start-Sleep -Seconds 5
        if ((Get-VmInfo).VMState -eq 'poweroff') { return $true }
    }
    Fail 'The VM did not shut down within two minutes. Shut it down in Proxmox, then rerun remove.'
}

function Setup-Lab($Info) {
    Require-Administrator
    Confirm-LabPrefix
    $existing = Get-State
    if ($existing) {
        if ($existing.vmName -ne $VmName -or $existing.labPrefix -ne $LabPrefix -or $existing.nicSlot -ne $NicSlot) {
            Fail 'Saved lab settings differ from this command. Use the same VM, prefix and NIC slot, or remove the old lab first.'
        }
        $state = $existing
    } else {
        if ($Info.VMState -ne 'poweroff') { Fail 'Shut down the VM before adding its host-only NIC.' }
        $nicKey = "nic$NicSlot"
        if ($Info[$nicKey] -ne 'none') { Fail "VirtualBox NIC $NicSlot is already in use. Choose another -NicSlot." }
        Confirm-NoOverlap
        $before = @(Get-HostOnlyNames)
        $adapter = $null
        try {
            [void](Invoke-VBox -Arguments @('hostonlyif', 'create'))
            $added = @(Get-HostOnlyNames | Where-Object { $before -notcontains $_ })
            if ($added.Count -ne 1) { Fail 'Could not identify the new VirtualBox host-only adapter.' }
            $adapter = $added[0]
            [void](Invoke-VBox -Arguments @('hostonlyif', 'ipconfig', $adapter, "--ip=$LabPrefix.1", '--netmask=255.255.255.0'))
            # New host-only networks can carry a VirtualBox DHCP server. The lab uses static IPs.
            & $script:vbox dhcpserver remove "--interface=$adapter" *> $null
            [void](Invoke-VBox -Arguments @('modifyvm', $VmName, "--nic$NicSlot=hostonly", "--host-only-adapter$NicSlot=$adapter", "--nic-promisc$NicSlot=allow-all", "--cable-connected$NicSlot=on"))
            $rawMac = (Get-VmInfo)["macaddress$NicSlot"]
            if ($rawMac -notmatch '^[0-9A-Fa-f]{12}$') { Fail 'Could not read the new VM NIC MAC address.' }
            $mac = ([regex]::Replace($rawMac, '(.{2})(?=.)', '$1:')).ToLowerInvariant()
            $state = [ordered]@{
                vmName = $VmName
                vmUuid = $Info.UUID
                nicSlot = $NicSlot
                nicMac = $mac
                hostAdapter = $adapter
                labPrefix = $LabPrefix
                hostIp = "$LabPrefix.1"
                vmIp = "$LabPrefix.3"
                subnet = "$LabPrefix.0/24"
                guestRemoved = $false
            }
            Save-State $state
        } catch {
            if ($adapter -and -not (Test-Path $script:statePath)) {
                & $script:vbox modifyvm $VmName "--nic$NicSlot=none" *> $null
                & $script:vbox hostonlyif remove $adapter *> $null
            }
            throw
        }
    }
    Start-VmIfStopped
    Invoke-Guest 'install' $state
    if (-not (Test-Connection -ComputerName $state.vmIp -Count 1 -Quiet -ErrorAction SilentlyContinue)) {
        Fail "Proxmox did not answer at $($state.vmIp). The lab settings are saved; inspect vmbr1 in the VM console, then rerun setup."
    }
    Write-Output "Lab ready: Windows $($state.hostIp), Proxmox $($state.vmIp), LXC subnet $($state.subnet), bridge vmbr1."
    Write-Output "Use $($state.labPrefix).53/.54/.56/.57 for the disposable service LXCs. Their gateway is $($state.vmIp)."
}

function Show-Status($Info) {
    $state = Get-State
    if (-not $state) { Write-Output "No Nomina lab state for '$VmName'."; return }
    Write-Output "VirtualBox VM: $VmName ($($Info.VMState)); host-only adapter: $($state.hostAdapter)"
    Write-Output "Windows: $($state.hostIp); Proxmox: $($state.vmIp); LXC bridge: vmbr1; subnet: $($state.subnet)"
    if ($Info.VMState -eq 'running') {
        $reachable = Test-Connection -ComputerName $state.vmIp -Count 1 -Quiet -ErrorAction SilentlyContinue
        Write-Output "Windows to Proxmox host-only IP: $(if ($reachable) { 'reachable' } else { 'unreachable' })"
        if ($SshTarget) { Invoke-Guest 'status' $state }
    }
}

function Remove-Lab($Info) {
    Require-Administrator
    $state = Get-State
    if (-not $state) { Write-Output 'Nomina lab is already absent.'; return }
    if (-not $state.guestRemoved) {
        Start-VmIfStopped
        Invoke-Guest 'remove' $state
        $state.guestRemoved = $true
        Save-State $state
    }
    $wasRunning = Stop-VmIfRunning
    [void](Invoke-VBox -Arguments @('modifyvm', $VmName, "--nic$($state.nicSlot)=none"))
    [void](Invoke-VBox -Arguments @('hostonlyif', 'remove', $state.hostAdapter))
    Remove-Item -Path $script:statePath -Force
    if ($wasRunning) { [void](Invoke-VBox -Arguments @('startvm', $VmName, '--type', $StartType)) }
    Write-Output 'Nomina lab bridge, NAT, VM NIC and dedicated Windows host-only adapter removed.'
}

try {
    if (-not $VmName) { $VmName = Read-Host 'VirtualBox Proxmox VM name' }
    if (-not $VmName) { Fail 'Pass -VmName or enter a VM name.' }
    $info = Get-VmInfo
    $script:statePath = Join-Path $stateDir "$($info.UUID).json"
    switch ($Action) {
        'setup' { Setup-Lab $info }
        'status' { Show-Status $info }
        'remove' { Remove-Lab $info }
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
