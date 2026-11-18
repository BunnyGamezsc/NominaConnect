param($Source,$Fixture)
$ErrorActionPreference = 'Stop'
. $Source
$script:rules = @()
$script:ssidList = @('other')
$script:deny = $false
$script:rootInstalled = $false
$script:dnsByAdapter = @{}
$script:probeOk = $false
function Get-WifiConnections {
    for ($i = 0; $i -lt $script:ssidList.Count; $i++) {
        [pscustomobject]@{ Ssid = $script:ssidList[$i]; AdapterId = $i }
    }
}
function Get-WifiDnsServers($adapterId) { $script:dnsByAdapter[$adapterId] }
function Test-HomeProbe($url) {
    Check ($url -eq 'https://192.168.4.90/health') 'Expected configured HTTPS URL'
    return $script:probeOk
}
function Get-DnsClientNrptRule { $script:rules }
function Get-DnsClientNrptPolicy { param([switch]$Effective) $script:rules }
function Add-DnsClientNrptRule {
    param($Namespace,$NameServers,$Comment,[switch]$PassThru)
    if ($script:deny) { throw 'Permission denied' }
    $rule = [pscustomobject]@{Name=[Guid]::NewGuid().ToString();Comment=$Comment;Namespace=$Namespace;NameServers=$NameServers}
    $script:rules += $rule; return $rule
}
function Remove-DnsClientNrptRule { param($Name,[switch]$Force) $script:rules = @($script:rules | Where-Object Name -ne $Name) }
function Clear-DnsClientCache {}
function Set-Status($message) {}
function Test-Root { $script:rootInstalled }
function Add-Root { $script:rootInstalled = $true }
function Remove-Root { $script:rootInstalled = $false }
function Check($condition,$message) { if (!$condition) { throw $message } }
function Throws([scriptblock]$action,$message) {
    try { & $action } catch { if ($_.Exception.Message -match $message) {return}; throw }
    throw "Expected failure: $message"
}
$base = $Fixture
$assets = $Fixture
$id = 'fixture-one'
$statePath = Join-Path $Fixture 'test-state.json'
$state = @{ruleSettings='';rule='';tag='';names=@();servers=@();roots=@();links=@()}
$cfg = @{addresses=@('10.0.0.53','fd00::53');ssids=@('Home');suffix='home.test';mode='private-domain';sha256=(Get-FileHash (Join-Path $Fixture 'root.cer')).Hash}
Update-Dns
Check ($script:rules.Count -eq 0) 'Away must leave ordinary DNS'
$script:ssidList = @('other','Home')
$script:deny = $true
Throws {Update-Dns} 'Permission denied'
$script:deny = $false
$state = Read-Json $statePath
Update-Dns
Check ($script:rules.Count -eq 1) 'Recover interrupted rule creation'
Check (($script:rules[0].Namespace -join ',') -eq 'home.test,.home.test') 'Suffix and apex'
Check (($script:rules[0].NameServers -join ',') -eq '10.0.0.53,fd00::53') 'IPv4 and IPv6'
$ruleId = $state.rule
Update-Dns
Check ($state.rule -eq $ruleId) 'Duplicate reconciliation'
$cfg.mode = 'whole-system'
Update-Dns
Check ($script:rules.Count -eq 1 -and $script:rules[0].Namespace -eq '.') 'Mode replacement'
$script:rules[0].NameServers = @('10.0.0.1')
$script:ssidList = @()
Throws {Update-Dns} 'changed externally'
Check ($script:rules.Count -eq 1) 'External changes preserved'
$script:rules[0].NameServers = $cfg.addresses
Update-Dns
Check ($script:rules.Count -eq 0) 'Restore on leave'
$cfg.homeCheck = @{dnsServers=@('fd00::53');probeUrl='https://192.168.4.90/health'}
$script:ssidList = @('Home','other')
$script:dnsByAdapter = @{0=@('10.0.0.7');1=@('fd00::53')}
$script:probeOk = $true
Update-Dns
Check ($script:rules.Count -eq 0) 'Wrong DNS on matching SSID with expected DNS on a different interface'
$script:dnsByAdapter[0] = @('fd00:0::53')
$script:probeOk = $false
Update-Dns
Check ($script:rules.Count -eq 0) 'Home DNS requires a working HTTPS check'
$script:probeOk = $true
Update-Dns
Check ($script:rules.Count -eq 1) 'Match the Wi-Fi name, DNS address, and HTTPS endpoint'
$script:dnsByAdapter[0] = @('10.0.0.7')
Update-Dns
Check ($script:rules.Count -eq 0) 'Same Wi-Fi name with different DNS removes the owned rule'
$cfg.Remove('homeCheck')
Check (Overlaps 'home.test' 'A.B.HOME.TEST.') 'Boundary mixed case'
Check (!(Overlaps 'home.test' 'evilhome.test')) 'Suffix boundary'
$key = Claim-Root
Check $script:rootInstalled 'Root installed'
$id = 'fixture-two'
Claim-Root | Out-Null
Release-Root $key
Check $script:rootInstalled 'Shared root preserved'
$id = 'fixture-one'
Release-Root $key
Check (!$script:rootInstalled) 'Final claim removed'
$script:rootInstalled = $true
Claim-Root | Out-Null
Release-Root $key
Check $script:rootInstalled 'Pre-existing trust preserved'
Claim-Root | Out-Null
$script:rootInstalled = $false
Throws { Claim-Root } 'removed externally'
Release-Root $key
$script:rules = @([pscustomobject]@{Name='different';Namespace=@('.home.test');NameServers=@('10.0.0.7')})
$script:ssidList = @('Home')
Throws { Update-Dns } 'Conflicting'
Check ($script:rules[0].Name -eq 'different') 'Independent rule retained'
function Get-ShortcutFolder { Join-Path $Fixture 'menu' }
$dir = $Fixture
$cfg.shortcuts = @(@{name='One';url='https://example.test/a?b=c&d=e'},@{name='Two';url='http://home.test/other';ico='icon-1.ico'})
Install-Links
Check ($state.links.Count -eq 2) 'Multiple shortcuts'
$edited = $state.links[0].path
[IO.File]::WriteAllText($edited,'external edit')
Clear-Links -Removing
Check ([IO.File]::ReadAllText($edited) -eq 'external edit') 'External link edits preserved'
Check (!(Test-Path (Join-Path (Get-ShortcutFolder) 'Two.url'))) 'Owned shortcut removed'
$cfg.shortcuts = @()
Install-Links
Check ($state.links.Count -eq 0) 'Zero shortcuts after replacement'
Write-Output 'Fixture lifecycle passed'
