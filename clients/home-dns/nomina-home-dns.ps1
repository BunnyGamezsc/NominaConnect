# Optional Windows helper for switching this client between local and tailnet DNS.
$ErrorActionPreference = 'Stop'

$script:TaskName = 'NominaConnect Home DNS'
$script:ConfigDir = Join-Path $env:APPDATA 'NominaConnect'
$script:ConfigPath = Join-Path $script:ConfigDir 'home-dns.json'
$script:InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\NominaConnect'
$script:InstalledScript = Join-Path $script:InstallDir 'nomina-home-dns.ps1'
$script:ShortcutDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\NominaConnect'
$script:ShortcutPath = Join-Path $script:ShortcutDir 'Home DNS.lnk'
$script:LogPath = Join-Path $script:ConfigDir 'home-dns.log'

function Write-HomeDnsLog {
    param([string]$Message)
    try {
        New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null
        if ((Test-Path $script:LogPath) -and (Get-Item $script:LogPath).Length -gt 262144) {
            Remove-Item $script:LogPath -Force
        }
        Add-Content -Path $script:LogPath -Value "$(Get-Date -Format o) $Message"
    } catch { }
}

function Assert-IPv4 {
    param([string]$Value, [string]$Label)
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw "$Label must be a valid IPv4 address."
    }
    return $parsed.ToString()
}

function Assert-Hostname {
    param([string]$Value)
    if ($Value -notmatch '^([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$') {
        throw 'Enter a managed hostname such as stats.bunny.internal.'
    }
    return $Value.ToLowerInvariant()
}

function Get-TailscalePath {
    $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'Tailscale IPN\tailscale.exe'),
        (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe')
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'Install the Tailscale Windows client and its CLI before using this helper.'
}

function Set-TailscaleDns {
    param([bool]$Enabled)
    $cli = Get-TailscalePath
    $value = $Enabled.ToString().ToLowerInvariant()
    $output = & $cli set "--accept-dns=$value" 2>&1
    if ($LASTEXITCODE -ne 0) {
        $detail = ($output | Out-String).Trim()
        if (-not $detail) { $detail = 'Tailscale returned an error.' }
        throw "Could not change the Tailscale DNS preference. $detail"
    }
}

function Get-SavedConfig {
    if (-not (Test-Path $script:ConfigPath)) { return $null }
    try {
        $config = Get-Content -Raw -Path $script:ConfigPath | ConvertFrom-Json
        [void](Assert-IPv4 $config.homeDns 'Technitium address')
        [void](Assert-IPv4 $config.expectedIp 'Probe answer')
        [void](Assert-IPv4 $config.routerIp 'Router address')
        [void](Assert-Hostname $config.probeHost)
        if ($config.routerMac -notmatch '^([0-9a-f]{2}:){5}[0-9a-f]{2}$') {
            throw 'The saved router MAC address is invalid.'
        }
        return $config
    } catch {
        throw "The saved home DNS configuration is invalid. $($_.Exception.Message)"
    }
}

function Get-HomeRouter {
    $routes = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
        Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' }
    $candidates = foreach ($route in $routes) {
        $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
        if ($adapter -and $adapter.Name -notmatch 'Tailscale') {
            $interface = Get-NetIPInterface -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Select-Object -First 1
            [pscustomobject]@{
                RouterIp = $route.NextHop
                InterfaceIndex = $route.InterfaceIndex
                Metric = [int]$route.RouteMetric + [int]$interface.InterfaceMetric
            }
        }
    }
    $router = $candidates | Sort-Object Metric | Select-Object -First 1
    if (-not $router) { throw 'Could not identify the active LAN router.' }

    & "$env:SystemRoot\System32\ping.exe" -n 1 -w 1000 $router.RouterIp *> $null
    $neighbor = Get-NetNeighbor -IPAddress $router.RouterIp -InterfaceIndex $router.InterfaceIndex -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00' } |
        Select-Object -First 1
    if (-not $neighbor) { throw 'Could not read the LAN router MAC address.' }
    $mac = $neighbor.LinkLayerAddress.Replace('-', ':').ToLowerInvariant()
    if ($mac -notmatch '^([0-9a-f]{2}:){5}[0-9a-f]{2}$') { throw 'The router MAC address is invalid.' }
    return [pscustomobject]@{ Ip = $router.RouterIp; Mac = $mac }
}

function Get-ARecords {
    param([string]$Hostname, [string]$Server)
    $parameters = @{ Name = $Hostname; Type = 'A'; DnsOnly = $true; ErrorAction = 'Stop' }
    if ($Server) { $parameters.Server = $Server }
    try {
        return @(Resolve-DnsName @parameters |
            Where-Object { $_.Type -eq 'A' -and $_.IPAddress } |
            ForEach-Object { $_.IPAddress })
    } catch {
        return @()
    }
}

function Test-HomeNetwork {
    param($Config)
    try {
        $router = Get-HomeRouter
        if ($router.Ip -ne $Config.routerIp -or $router.Mac -ne $Config.routerMac) { return $false }
        return (Get-ARecords $Config.probeHost $Config.homeDns) -contains $Config.expectedIp
    } catch {
        return $false
    }
}

function Invoke-Tick {
    $config = Get-SavedConfig
    if (-not $config) { throw 'Install the helper on your home network first.' }
    if (Test-HomeNetwork $config) {
        Set-TailscaleDns $false
        Start-Sleep -Seconds 2
        if ((Get-ARecords $config.probeHost $null) -notcontains $config.expectedIp) {
            Set-TailscaleDns $true
            throw "Local DNS did not resolve $($config.probeHost) to $($config.expectedIp). Tailscale DNS was restored."
        }
    } else {
        Set-TailscaleDns $true
    }
}

function Install-Task {
    New-Item -ItemType Directory -Path $script:InstallDir -Force | Out-Null
    Copy-Item -Path $PSCommandPath -Destination $script:InstalledScript -Force

    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($script:InstalledScript)`" tick"
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $user),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Switch this device between home LAN DNS and Tailscale DNS.' -Force | Out-Null
}

function Install-Shortcut {
    New-Item -ItemType Directory -Path $script:ShortcutDir -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($script:ShortcutPath)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($script:InstalledScript)`" ui"
    $shortcut.WorkingDirectory = $script:InstallDir
    $shortcut.IconLocation = "$env:SystemRoot\System32\imageres.dll,15"
    $shortcut.Save()
}

function Read-InputValue {
    param([string]$Prompt, [string]$DefaultValue)
    if (-not $script:UseGui) {
        if ($DefaultValue) { $answer = Read-Host "$Prompt [$DefaultValue]" } else { $answer = Read-Host $Prompt }
        if (-not $answer) { return $DefaultValue }
        return $answer.Trim()
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'NominaConnect home DNS'
    $form.Width = 430
    $form.Height = 155
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Prompt
    $label.AutoSize = $true
    $label.Left = 12
    $label.Top = 12
    $inputBox = New-Object System.Windows.Forms.TextBox
    $inputBox.Left = 12
    $inputBox.Top = 38
    $inputBox.Width = 390
    $inputBox.Text = $DefaultValue
    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = 'Continue'
    $ok.Left = 242
    $ok.Top = 72
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Left = 322
    $cancel.Top = 72
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.AddRange(@($label, $inputBox, $ok, $cancel))
    $form.AcceptButton = $ok
    $form.CancelButton = $cancel
    $result = $form.ShowDialog()
    $value = $inputBox.Text.Trim()
    $form.Dispose()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
    return $value
}

function Show-Message {
    param([string]$Text, [string]$Title = 'NominaConnect home DNS', [bool]$IsError = $false)
    $icon = [System.Windows.Forms.MessageBoxIcon]::Information
    if ($IsError) { $icon = [System.Windows.Forms.MessageBoxIcon]::Error }
    [void][System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}

function Invoke-Setup {
    param([string]$HomeDns, [string]$ProbeHost)
    $current = Get-SavedConfig
    if (-not $HomeDns) { $HomeDns = Read-InputValue 'Technitium LAN IPv4 address' $current.homeDns }
    if ($null -eq $HomeDns) { return }
    if (-not $ProbeHost) { $ProbeHost = Read-InputValue 'Managed hostname, such as stats.bunny.internal' $current.probeHost }
    if ($null -eq $ProbeHost) { return }

    $HomeDns = Assert-IPv4 $HomeDns.Trim() 'Technitium address'
    $ProbeHost = Assert-Hostname $ProbeHost.Trim()
    $router = Get-HomeRouter
    $answers = Get-ARecords $ProbeHost $HomeDns
    $expectedIp = $answers | Select-Object -First 1
    if (-not $expectedIp) { throw "Technitium at $HomeDns did not return an A record for $ProbeHost." }
    Set-TailscaleDns $true

    New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null
    $config = [ordered]@{
        homeDns = $HomeDns
        probeHost = $ProbeHost
        expectedIp = $expectedIp
        routerIp = $router.Ip
        routerMac = $router.Mac
    }
    $temporary = "$($script:ConfigPath).tmp"
    $config | ConvertTo-Json | Set-Content -Path $temporary -Encoding UTF8
    Move-Item -Path $temporary -Destination $script:ConfigPath -Force
    Install-Task
    Install-Shortcut
    Invoke-Tick
    return "Home DNS helper installed. $ProbeHost resolves locally to $expectedIp. Use NominaConnect Home DNS from the Start menu to edit or remove it."
}

function Get-StatusText {
    $config = Get-SavedConfig
    if (-not $config) { return 'The home DNS helper is not installed.' }
    if (Test-HomeNetwork $config) {
        return "Home router verified. This device should use local DNS for $($config.probeHost)."
    }
    return "Home router not verified. This device should use Tailscale DNS for $($config.probeHost)."
}

function Invoke-Uninstall {
    Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    $dnsWarning = $null
    try { Set-TailscaleDns $true }
    catch { $dnsWarning = $_.Exception.Message }
    Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Path $script:ConfigPath, $script:InstalledScript, $script:ShortcutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $script:LogPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $script:InstallDir, $script:ShortcutDir -Force -Recurse -ErrorAction SilentlyContinue
    if ($dnsWarning) { return "Helper removed, but Tailscale DNS could not be enabled. $dnsWarning" }
    return 'Home DNS helper removed. Tailscale DNS is enabled on this device.'
}

function Show-Ui {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $script:UseGui = $true
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'NominaConnect home DNS'
    $form.Width = 390
    $form.Height = 225
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Switch DNS based on your home network.'
    $title.AutoSize = $true
    $title.Left = 18
    $title.Top = 18

    $install = New-Object System.Windows.Forms.Button
    $install.Text = 'Install or edit'
    $install.Left = 18
    $install.Top = 56
    $install.Width = 160
    $install.Add_Click({
        try {
            $message = Invoke-Setup
            if ($message) { Show-Message $message }
        }
        catch { Show-Message $_.Exception.Message 'NominaConnect home DNS' $true }
    })
    $status = New-Object System.Windows.Forms.Button
    $status.Text = 'Show status'
    $status.Left = 195
    $status.Top = 56
    $status.Width = 160
    $status.Add_Click({
        try { Show-Message (Get-StatusText) }
        catch { Show-Message $_.Exception.Message 'NominaConnect home DNS' $true }
    })
    $remove = New-Object System.Windows.Forms.Button
    $remove.Text = 'Uninstall'
    $remove.Left = 18
    $remove.Top = 101
    $remove.Width = 160
    $remove.Add_Click({
        $answer = [System.Windows.Forms.MessageBox]::Show('Remove the scheduled helper and enable Tailscale DNS?', 'Uninstall home DNS helper', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
            try { Show-Message (Invoke-Uninstall); $form.Close() }
            catch { Show-Message $_.Exception.Message 'NominaConnect home DNS' $true }
        }
    })
    $close = New-Object System.Windows.Forms.Button
    $close.Text = 'Close'
    $close.Left = 195
    $close.Top = 101
    $close.Width = 160
    $close.Add_Click({ $form.Close() })
    $form.Controls.AddRange(@($title, $install, $status, $remove, $close))
    [void]$form.ShowDialog()
    $form.Dispose()
}

function Show-TerminalStatus {
    Write-Output (Get-StatusText)
}

$script:UseGui = $false
$mode = if ($args.Count -gt 0) { $args[0].ToLowerInvariant() } else { 'ui' }
try {
    switch ($mode) {
        'ui' { Show-Ui }
        'setup' {
            $homeDns = if ($args.Count -gt 1) { $args[1] } else { $null }
            $probeHost = if ($args.Count -gt 2) { $args[2] } else { $null }
            Write-Output (Invoke-Setup $homeDns $probeHost)
        }
        'tick' { Invoke-Tick }
        'status' { Show-TerminalStatus }
        'uninstall' { Write-Output (Invoke-Uninstall) }
        default { throw 'Use: nomina-home-dns.ps1 ui | setup [technitium-ip managed-hostname] | status | uninstall | tick' }
    }
} catch {
    Write-HomeDnsLog $_.Exception.Message
    if ($script:UseGui) { Show-Message $_.Exception.Message 'NominaConnect home DNS' $true }
    else { Write-Error $_.Exception.Message; exit 1 }
}
