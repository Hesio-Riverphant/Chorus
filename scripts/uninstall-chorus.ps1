param([switch]$Inspect)
$ErrorActionPreference = 'Stop'

function Resolve-ChorusUninstaller($Entries) {
    $found = @($Entries | Where-Object { $_.DisplayName -match '^Chorus(?: \d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)?$' } | ForEach-Object {
        if ($_.UninstallString -match '^"([A-Za-z]:\\[^"\r\n]+\\Uninstall Chorus\.exe)"(?: /currentuser)?$') {
            $candidate = $Matches[1]
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate }
        }
    } | Select-Object -Unique)
    if ($found.Count -ne 1) { throw 'A unique installed Chorus was not found. Use Windows Settings > Apps. Portable ZIP copies can be removed after closing the app.' }
    return $found[0]
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $entries = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
        $uninstaller = Resolve-ChorusUninstaller $entries
        if ($Inspect) { Write-Output $uninstaller; exit 0 }
        # The original installer handles running processes and preserves chat data.
        Start-Process -FilePath $uninstaller -ArgumentList '/currentuser' -Wait
    } catch {
        Write-Host $_.Exception.Message
        if (-not $Inspect) { Read-Host 'Press Enter to close' | Out-Null }
        exit 1
    }
}
