$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'uninstall-chorus.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('chorus-uninstall-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $exe = Join-Path $fixture 'Uninstall Chorus.exe'
    [IO.File]::WriteAllText($exe, 'fixture; never executed')
    $valid = [pscustomobject]@{ DisplayName = 'Chorus'; UninstallString = ('"' + $exe + '" /currentuser') }
    if ((Resolve-ChorusUninstaller @($valid)) -ne $exe) { throw 'Correct installation not found' }
    $versioned = [pscustomobject]@{ DisplayName = 'Chorus 0.5.0'; UninstallString = $valid.UninstallString }
    if ((Resolve-ChorusUninstaller @($versioned)) -ne $exe) { throw 'Previous versioned installation not found' }
    foreach ($entry in @(
        [pscustomobject]@{ DisplayName = 'Another app'; UninstallString = $valid.UninstallString },
        [pscustomobject]@{ DisplayName = 'Chorus malicious'; UninstallString = $valid.UninstallString },
        [pscustomobject]@{ DisplayName = 'Chorus'; UninstallString = $valid.UninstallString + ' /S & calc' },
        [pscustomobject]@{ DisplayName = 'Chorus'; UninstallString = 'cmd /c anything' }
    )) {
        $rejected = $false
        try { Resolve-ChorusUninstaller @($entry) | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw 'Unexpected command was accepted' }
    }
    Write-Output 'PASS: exact installed uninstaller only; unsupported entries rejected; no process launched'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ([IO.Path]::GetDirectoryName($resolved) -eq [IO.Path]::GetTempPath().TrimEnd('\') -and [IO.Path]::GetFileName($resolved).StartsWith('chorus-uninstall-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
