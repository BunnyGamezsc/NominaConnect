param([ValidateSet('Install','Reconcile','Status','Remove')][string]$Action, [Guid]$Revision)
$ErrorActionPreference = 'Stop'
function Read-Json($file) { Get-Content -Raw -LiteralPath $file -Encoding UTF8 | ConvertFrom-Json }
function Write-Json($file,$value) {
    $tmp = "$file.tmp"
    [IO.File]::WriteAllText($tmp, (ConvertTo-Json -Depth 10 -InputObject $value))
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($tmp,$file,[NullString]::Value) }
    else { [IO.File]::Move($tmp,$file) }
}
function Save { Write-Json $statePath $state }
function Set-Status($message) { [IO.File]::WriteAllText("$dir\status.txt", "$(Get-Date -Format o) $message") }

function Rule-Settings($rule) {
    $keys = @('DAIPsecCARestriction','DAIPsecRequired','DANameServers','DAProxyName','DAQueryIPsecEncryption','DAQueryIPsecRequired','DirectAccessEnabled','DnsSecEnabled','DnsSecQueryIPsecEncryption','DnsSecQueryIPsecRequired','DnsSecValidationRequired','IPsecCARestriction','NameEncoding','DisplayName')
    $values = [ordered]@{}
    foreach ($key in $keys) { $values[$key] = $rule.$key }
    return (ConvertTo-Json $values -Compress)
}
function Assert-Rule($rule) {
    if (($state.ruleSettings -and $state.ruleSettings -cne (Rule-Settings $rule)) -or $rule.Comment -cne $state.tag -or ($rule.Namespace -join ',') -ine ($state.names -join ',') -or
        ($rule.NameServers -join ',') -ine ($state.servers -join ',')) { throw 'DNS rule changed externally. Inspect NRPT before retrying.' }
}
function Clear-Rule {
    if (!$state.tag) { return }
    $rules = @(Get-DnsClientNrptRule | Where-Object { $_.Name -eq $state.rule -or $_.Comment -ceq $state.tag })
    foreach ($rule in $rules) { Assert-Rule $rule }
    foreach ($rule in $rules) { Remove-DnsClientNrptRule -Name $rule.Name -Force }
    $state.rule = ''; $state.ruleSettings = ''; $state.tag = ''; Save
    Clear-DnsClientCache
}
function Overlaps($a,$b) {
    $x = $a.Trim('.'); $y = $b.Trim('.')
    return (!$x -or !$y -or $x -ieq $y -or $x.EndsWith(".$y",[StringComparison]::OrdinalIgnoreCase) -or $y.EndsWith(".$x",[StringComparison]::OrdinalIgnoreCase))
}
function Get-WifiNames {
    $profiles = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetConnectionProfiles()
    foreach ($profile in $profiles) {
        if ($profile.IsWlanConnectionProfile -and $profile.GetNetworkConnectivityLevel() -ne 'None') {
            $ssid = $profile.WlanConnectionProfileDetails.GetConnectedSsid()
            if (!$ssid) { throw 'SSID unavailable.' }
            $ssid
        }
    }
}
function Get-HomeMatch {
    foreach ($ssid in @(Get-WifiNames)) { if ($cfg.ssids -ccontains $ssid) { return $true } }
    return $false
}
function Confirm-Effective {
    $effective = @(Get-DnsClientNrptPolicy -Effective)
    foreach ($name in $state.names) {
        $match = @($effective | Where-Object { $_.Namespace -icontains $name -and ($_.NameServers -join ',') -ieq ($state.servers -join ',') })
        if (!$match.Count) { throw 'DNS rule is ineffective. Check Group Policy or VPN settings.' }
    }
    foreach ($rule in $effective) {
        foreach ($ns in $rule.Namespace) {
            foreach ($name in $state.names) {
                if ((Overlaps $ns $name) -and ($rule.NameServers -join ',') -ine ($state.servers -join ',')) { throw 'Conflicting effective DNS policy. Inspect VPN or Group Policy settings.' }
            }
        }
    }
}
function Update-Dns {
    try { $matchesHome = Get-HomeMatch } catch { Clear-Rule; throw 'SSID unavailable. Check Wi-Fi and location permissions.' }
    if (!$matchesHome) { Clear-Rule; Set-Status 'Off home Wi-Fi. DNS inactive.'; return }
    $names = if ($cfg.mode -eq 'whole-system') { @('.') } else { @($cfg.suffix, ".$($cfg.suffix)") }
    if ($state.tag) {
        $existing = @(Get-DnsClientNrptRule | Where-Object { $_.Comment -ceq $state.tag -or $_.Name -eq $state.rule })
        if ($existing.Count -eq 1) {
            Assert-Rule $existing[0]
            if (($state.names -join ',') -ieq ($names -join ',') -and ($state.servers -join ',') -ieq ($cfg.addresses -join ',')) {
                Confirm-Effective; Set-Status 'Home DNS policy active.'; return
            }
        } elseif ($state.rule) { throw 'Owned DNS rule was removed externally. Review before repair.' }
        Clear-Rule
    }
    foreach ($other in @(Get-DnsClientNrptPolicy -Effective) + @(Get-DnsClientNrptRule)) {
        foreach ($ns in $other.Namespace) {
            foreach ($name in $names) { if (Overlaps $ns $name) { throw 'Conflicting DNS namespace. Check existing VPN, Group Policy or package rules.' } }
        }
    }
    $state.names = @($names); $state.servers = @($cfg.addresses)
    $state.tag = "NominaDevice-$id-$([Guid]::NewGuid())"; Save
    $added = Add-DnsClientNrptRule -Namespace $state.names -NameServers $state.servers -Comment $state.tag -PassThru
    $state.rule = $added.Name; $state.ruleSettings = Rule-Settings $added; Save
    Clear-DnsClientCache
    Confirm-Effective; Set-Status 'Home DNS policy active.'
}

# Per-root claims live beside all package directories under protected Program Files.
function Test-Root($key) { Test-Path "Cert:\LocalMachine\Root\$key" }
function Add-Root($file) { Import-Certificate -FilePath $file -CertStoreLocation Cert:\LocalMachine\Root | Out-Null }
function Remove-Root($key) { Remove-Item "Cert:\LocalMachine\Root\$key" }
function Claim-Root {
    $certFile = Join-Path $assets 'root.cer'
    $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certFile)
    if ((Get-FileHash $certFile).Hash -ne $cfg.sha256 -or $cert.NotAfter -lt (Get-Date) -or $cert.NotBefore -gt (Get-Date)) { throw 'Invalid packaged root fingerprint or validity period.' }
    $key = $cert.Thumbprint
    $file = Join-Path $base "root-$key.json"
    if (Test-Path $file) {
        $claim = Read-Json $file
        if ($claim.confirmed -and !(Test-Root $key)) { throw 'Reviewed root removed externally. Review trust and existing package claims before repair.' }
    } else { $claim = @{ introduced = !(Test-Root $key); confirmed = $false; owners = @() } }
    $state.roots = @(@($state.roots) + $key | Select-Object -Unique); Save
    $claim.owners = @(@($claim.owners) + $id | Select-Object -Unique); Write-Json $file $claim
    if (!(Test-Root $key)) { Add-Root $certFile }
    $claim.confirmed = $true; Write-Json $file $claim
    return $key
}
function Release-Root($key) {
    $file = Join-Path $base "root-$key.json"
    if (Test-Path $file) {
        $claim = Read-Json $file
        $claim.owners = @($claim.owners | Where-Object { $_ -ne $id })
        if ($claim.owners.Count) { Write-Json $file $claim }
        else {
            if ($claim.introduced -and (Test-Root $key)) { Remove-Root $key }
            Remove-Item $file
        }
    }
    $state.roots = @($state.roots | Where-Object { $_ -ne $key }); Save
}
function Clear-Links([switch]$Removing) {
    foreach ($link in @($state.links)) {
        if (Test-Path -LiteralPath $link.path) {
            if ((Get-FileHash -LiteralPath $link.path).Hash -ne $link.hash) {
                if (!$Removing) { throw "Preserved edited shortcut: $($link.path)" }
                Add-Content -LiteralPath "$dir\preserved.txt" -Value "Preserved modified shortcut $($link.path)"
                continue
            }
            Remove-Item -LiteralPath $link.path
        }
    }
    $state.links = @(); Save
}
function Get-ShortcutFolder { Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "Nomina $id" }
function Install-Links {
    $folder = Get-ShortcutFolder
    foreach ($s in $cfg.shortcuts) {
        [IO.Directory]::CreateDirectory($folder) | Out-Null
        $link = Join-Path $folder ($s.name + '.url')
        if (Test-Path -LiteralPath $link) { throw "Shortcut already exists: $link" }
        $content = "[InternetShortcut]" + [Environment]::NewLine + "URL=$($s.url)" + [Environment]::NewLine
        if ($s.ico) { $content += "IconFile=$assets\$($s.ico)" + [Environment]::NewLine + 'IconIndex=0' + [Environment]::NewLine }
        $bytes = [Text.Encoding]::Unicode.GetPreamble() + [Text.Encoding]::Unicode.GetBytes($content)
        $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','')
        $state.links = @($state.links) + @{path=$link;hash=$hash}; Save
        [IO.File]::WriteAllBytes($link,$bytes)
    }
}
function Managed-Task {
    $task = Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $taskName
    if ($task -and ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine $ps -or $task.Actions[0].Arguments -cne $command)) { throw 'Task name collision or external modification.' }
    if ($task -and $state.taskXml -and (Export-ScheduledTask -TaskName $taskName) -cne $state.taskXml) { throw 'Scheduled task settings changed externally. Inspect before repair.' }
    return $task
}
function Register-Helper {
    if (Managed-Task) { return }
    $event = New-CimInstance -ClientOnly -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger
    $event.Enabled = $true
    $event.Subscription = '<QueryList><Query Id="0"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[(EventID=10000 or EventID=10001)]]</Select><Select Path="System">*[System[Provider[@Name="Microsoft-Windows-Power-Troubleshooter"] and EventID=1]]</Select></Query></QueryList>'
    $triggers = @((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -AtLogOn),$event,(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action (New-ScheduledTaskAction -Execute $ps -Argument $command) -Trigger $triggers -Settings $settings -User SYSTEM -RunLevel Highest | Out-Null
    $state.taskXml = Export-ScheduledTask -TaskName $taskName; Save
}

if ($MyInvocation.InvocationName -eq '.') { return }
$dir = $PSScriptRoot
$base = Split-Path $dir
$id = (Get-Item -LiteralPath $dir).Name
if ($id -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid package installation directory.' }
$taskName = "NominaDevice-$id"
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$command = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File ""$dir\device.ps1"" Reconcile"
$statePath = Join-Path $dir 'state.json'

if ($Action -eq 'Status') { Get-Content "$dir\status.txt"; Read-Host 'Press Enter to close'; exit }
$until = (Get-Date).AddSeconds(30)
do {
    try { $lock = [IO.File]::Open("$base\operation.lock",'OpenOrCreate','ReadWrite','None'); break }
    catch [IO.IOException] { if ((Get-Date) -ge $until) { throw 'Another device setup operation is busy.' }; Start-Sleep -Milliseconds 200 }
} while ($true)
try {
    $configuredPolicy = Get-ExecutionPolicy -List | Where-Object { $_.Scope -ne 'Process' -and $_.ExecutionPolicy -ne 'Undefined' } | Select-Object -First 1
    if ($configuredPolicy.ExecutionPolicy -eq 'Restricted' -or
        ($configuredPolicy.ExecutionPolicy -eq 'AllSigned' -and (Get-AuthenticodeSignature $PSCommandPath).Status -ne 'Valid')) {
        throw 'The configured Windows script policy prevents running this helper.'
    }
    if (Test-Path $statePath) { $state = Read-Json $statePath }
    else { $state = @{revision=''; revisions=@(); removing=$false; taskXml=''; ruleSettings=''; tag='';rule='';names=@();servers=@();roots=@();links=@()} }
    if ($Action -eq 'Reconcile' -and ($state.removing -or !$state.revision)) { return }
    if ($Action -eq 'Remove') {
        $state.removing = $true; Save
        if (Managed-Task) { Stop-ScheduledTask -TaskName $taskName; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
        try { Clear-Rule } catch {
            if ($_.Exception.Message -notmatch '^DNS rule changed externally') { throw }
            Add-Content -LiteralPath "$dir\preserved.txt" -Value "Preserved externally edited DNS rule $($state.rule)"
        }
        Clear-Links -Removing
        foreach ($key in @($state.roots)) { Release-Root $key }
        $folder = Get-ShortcutFolder
        if ((Test-Path $folder) -and !(Get-ChildItem -Force -LiteralPath $folder)) { [IO.Directory]::Delete($folder) }
        foreach ($r in @($state.revisions)) {
            $assets = Join-Path $dir ([Guid]$r).ToString()
            if (Test-Path "$assets\package.json") {
                $oldCfg = Read-Json "$assets\package.json"
                foreach ($s in $oldCfg.shortcuts) { if ($s.ico -match '^icon-[0-9]+\.ico$') { Remove-Item -LiteralPath "$assets\$($s.ico)" -ErrorAction SilentlyContinue } }
                Remove-Item -LiteralPath "$assets\package.json"
            }
            if (Test-Path "$assets\root.cer") { Remove-Item -LiteralPath "$assets\root.cer" }
            if ((Test-Path $assets) -and !(Get-ChildItem -Force -LiteralPath $assets)) { [IO.Directory]::Delete($assets) }
        }
        return
    }
    if ($Action -eq 'Install' -and $Revision) {
        $state.removing = $false
        $state.revision = $Revision.ToString()
        $state.revisions = @(@($state.revisions) + $state.revision | Select-Object -Unique)
        Save
    }
    $assets = Join-Path $dir ([Guid]$state.revision).ToString()
    $cfg = Read-Json "$assets\package.json"
    if ($Action -eq 'Install') {
        if ([int](Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' CurrentBuildNumber) -lt 22000) { throw 'Windows 11 required.' }
        $key = Claim-Root
        Clear-Links; Install-Links; Register-Helper
        foreach ($old in @($state.roots)) { if ($old -ne $key) { Release-Root $old } }
    }
    Update-Dns
} catch { Set-Status $_.Exception.Message; throw }
finally { $lock.Dispose() }
