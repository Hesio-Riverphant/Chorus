$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'uninstall-chorus.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('chorus-uninstall-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$count = 0
function Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
function Reject([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Check $rejected $Message
}
function Write-Fixture([string]$Relative, [string]$Text) {
    $file = [IO.Path]::GetFullPath((Join-Path $fixture $Relative))
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
    [IO.File]::WriteAllText($file, $Text)
    return $file
}
function New-Bundle([string]$BundleName) {
    $names = @('Chorus.exe', 'Uninstall Chorus.cmd', 'uninstall-chorus.ps1', 'resources/app/package.json', 'resources/app/desktop-bootstrap.js')
    $records = @()
    foreach ($name in $names) {
        $contents = if ($name -eq 'resources/app/package.json') { '{"name":"agent-room","productName":"Chorus","version":"1.0.0"}' } else { 'disposable fixture; never execute' }
        $file = Write-Fixture ($BundleName + '/' + $name) $contents
        $records += @{ path = $name; bytes = (Get-Item -LiteralPath $file).Length; sha256 = (Get-FileHash -LiteralPath $file).Hash }
    }
    Write-Fixture ($BundleName + '/RELEASE-MANIFEST.json') (@{format=1;product='Chorus';kind='desktop';platform='win32';version='1.0.0';files=$records} | ConvertTo-Json -Depth 5) | Out-Null
    return Join-Path $fixture $BundleName
}
$junction = $null
try {
    $portable = New-Bundle 'portable'
    $installed = New-Bundle 'installed'
    $exe = Write-Fixture 'installed/Uninstall Chorus.exe' 'fixture; never execute'
    $registration = [pscustomobject]@{ DisplayName = 'Chorus'; UninstallString = ('"' + $exe + '" /currentuser') }
    Check ($null -eq (Resolve-ChorusUninstaller @($registration) $portable)) 'Portable copy selected another installation'
    Check ((Resolve-ChorusUninstaller @($registration) $installed) -eq $exe) 'Exact installed uninstaller not selected'
    Reject { Resolve-ChorusUninstaller @($registration, $registration) $installed } 'Ambiguous registration accepted'
    Reject { Resolve-ChorusUninstaller @() $installed } 'Unregistered executable accepted'
    $hostile = [pscustomobject]@{ DisplayName='Chorus'; UninstallString=($registration.UninstallString + ' /S & calc') }
    Reject { Resolve-ChorusUninstaller @($hostile) $installed } 'Extra command accepted'
    $plan = Get-ChorusBundlePlan $portable
    Check ($plan.files.Count -eq 6) 'Portable plan is incomplete'
    Check ((Get-ChorusBundlePlan $installed $true).files.Count -eq 7) 'Installed uninstaller absent from plan'
    $unknown = Write-Fixture 'portable/my-project/notes.txt' 'must survive'
    Reject { Get-ChorusBundlePlan $portable } 'Unknown project directory accepted'
    Check ([IO.File]::ReadAllText($unknown) -eq 'must survive') 'Read-only planning changed project'
    [IO.File]::Delete($unknown); [IO.Directory]::Delete([IO.Path]::GetDirectoryName($unknown), $false)
    $exeFile = Join-Path $portable 'Chorus.exe'
    $before = [IO.File]::ReadAllText($exeFile)
    [IO.File]::WriteAllText($exeFile, 'modified')
    Reject { Get-ChorusBundlePlan $portable } 'Modified release accepted'
    [IO.File]::WriteAllText($exeFile, $before)
    $manifestFile = Join-Path $portable 'RELEASE-MANIFEST.json'
    $manifestText = [IO.File]::ReadAllText($manifestFile)
    $manifest = Read-ChorusJson $manifestFile
    $manifest.files[0].path = '../outside.txt'
    [IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json -Depth 5))
    Reject { Get-ChorusBundlePlan $portable } 'Traversal accepted'
    [IO.File]::WriteAllText($manifestFile, $manifestText)
    $appData = Join-Path $fixture 'appdata'
    [IO.Directory]::CreateDirectory($appData) | Out-Null
    Check ($null -eq (Get-ChorusDataPlan $appData $portable)) 'Missing data requires no deletion'
    Write-Fixture 'appdata/agent-room/bots.json' '[{"id":"bot_fixture"}]' | Out-Null
    Write-Fixture 'appdata/agent-room/rooms.json' '[{"id":"room_fixture"}]' | Out-Null
    Write-Fixture 'appdata/agent-room/settings.json' '{}' | Out-Null
    Write-Fixture 'appdata/agent-room/messages/room_fixture.json' '[]' | Out-Null
    $project = Write-Fixture 'external-project/sentinel.txt' 'external project survives'
    $native = Write-Fixture 'native-agent/.codex/sentinel.txt' 'native agent survives'
    $rooms = Join-Path $appData 'agent-room/rooms.json'
    [IO.File]::WriteAllText($rooms, ('[{"id":"room_fixture","cwd":' + ([IO.Path]::GetDirectoryName($project) | ConvertTo-Json) + '}]'))
    $data = Get-ChorusDataPlan $appData $portable
    Check ($data.files.Count -eq 4) 'App store deletion plan is incomplete'
    Check (-not ($data.files.path -contains $project) -and -not ($data.files.path -contains $native)) 'External files entered deletion plan'
    $unknownData = Write-Fixture 'appdata/agent-room/unrelated.txt' 'keep'
    Reject { Get-ChorusDataPlan $appData $portable } 'Unknown data file accepted'
    [IO.File]::Delete($unknownData)
    $unknownCache = Write-Fixture 'appdata/agent-room/Cache/my-secret' 'keep'
    Reject { Get-ChorusDataPlan $appData $portable } 'Unknown cache file accepted'
    [IO.File]::Delete($unknownCache)
    Write-Fixture 'appdata/agent-room/Cache/Cache_Data/index' 'known chromium cache' | Out-Null
    Check ((Get-ChorusDataPlan $appData $portable).files.Count -eq 5) 'Known Chromium cache was not planned'
    $snapshot = Write-Fixture 'appdata/agent-room/Cache/No_Vary_Search/snapshot.baf' 'chromium snapshot fixture'
    $journal = Write-Fixture 'appdata/agent-room/Cache/No_Vary_Search/journal.baj' 'chromium journal fixture'
    Check ((Get-ChorusDataPlan $appData $portable).files.Count -eq 7) 'Exact No-Vary-Search cache files rejected'
    $cacheProject = Write-Fixture 'appdata/agent-room/Cache/No_Vary_Search/package.json' '{"name":"personal-project"}'
    Reject { Get-ChorusDataPlan $appData $portable } 'Unknown No-Vary-Search cache content accepted'
    Check ([IO.File]::ReadAllText($cacheProject) -eq '{"name":"personal-project"}') 'Unknown No-Vary-Search content changed'
    [IO.File]::Delete($cacheProject); [IO.File]::Delete($snapshot); [IO.File]::Delete($journal)
    Check ((Get-ChorusDataPlan $appData $portable).files.Count -eq 5) 'Empty native No-Vary-Search directory rejected'
    [IO.Directory]::Delete([IO.Path]::GetDirectoryName($snapshot), $false)
    $networkMarker = Write-Fixture 'appdata/agent-room/Network/NetworkDataMigrated' ''
    Check ((Get-ChorusDataPlan $appData $portable).files.path -contains $networkMarker) 'Empty native network migration checkpoint rejected'
    [IO.File]::WriteAllText($networkMarker, 'personal content')
    Reject { Get-ChorusDataPlan $appData $portable } 'Nonempty content disguised as migration checkpoint accepted'
    Check ([IO.File]::ReadAllText($networkMarker) -eq 'personal content') 'Disguised marker contents changed'
    [IO.File]::Delete($networkMarker)
    Check (-not (Test-ChorusCacheEntry 'Network/NetworkDataMigrated-copy' $false)) 'Unknown migration marker variant accepted'
    Check (-not (Test-ChorusCacheEntry 'Network/NetworkDataMigrated' $true)) 'Directory disguised as migration marker accepted'
    $gpuHash = 'JDILZQMYHSFMNNX7CM2QEGAFD2VTODWT'
    $gpuPrefix = 'GPUPersistentCache/DawnGraphiteCache/' + $gpuHash
    $nativeFiles = @('ShaderCache/index', 'ShaderCache/data_0', 'GrShaderCache/f_000001', ($gpuPrefix + '/cache.db'), ($gpuPrefix + '/cache.db-wal'), ($gpuPrefix + '/cache.journal'), ($gpuPrefix + '/cache.db-shm'), 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal', 'DevToolsActivePort')
    foreach ($relative in $nativeFiles) { Write-Fixture ('appdata/agent-room/' + $relative) 'native cache fixture' | Out-Null }
    $sharingBackup = Write-Fixture 'appdata/agent-room/side-members-before-sharing.json' '{"rooms":[],"bots":[]}'
    Check ((Get-ChorusDataPlan $appData $portable).files.Count -eq 16) 'Proven native cache layouts or legacy migration backup rejected'
    foreach ($relative in @(($gpuPrefix + '/package.json'), 'GPUPersistentCache/unknown/cache.db', 'ShaderCache/personal.txt', 'declarative_performance_observer.db-personal')) {
        $unexpected = Write-Fixture ('appdata/agent-room/' + $relative) 'personal content'
        Reject { Get-ChorusDataPlan $appData $portable } "Unknown file under native-looking name accepted: $relative"
        Check ([IO.File]::ReadAllText($unexpected) -eq 'personal content') 'Unknown native-cache fixture changed'
        [IO.File]::Delete($unexpected)
        if ($relative -match '/unknown/') { [IO.Directory]::Delete([IO.Path]::GetDirectoryName($unexpected), $false) }
    }
    Check (-not (Test-ChorusCacheEntry 'GPUPersistentCache/DawnGraphiteCache/not-a-version/cache.db' $false)) 'Arbitrary GPU version directory accepted'
    [IO.File]::WriteAllText($sharingBackup, '{"name":"personal project"}')
    Reject { Get-ChorusDataPlan $appData $portable } 'Unknown file disguised as migration backup accepted'
    [IO.File]::Delete($sharingBackup)
    foreach ($relative in $nativeFiles) { [IO.File]::Delete((Join-Path (Join-Path $appData 'agent-room') $relative)) }
    foreach ($relative in @($gpuPrefix, 'GPUPersistentCache/DawnGraphiteCache', 'GPUPersistentCache', 'ShaderCache', 'GrShaderCache')) { [IO.Directory]::Delete((Join-Path (Join-Path $appData 'agent-room') $relative), $false) }
    $skill = Write-Fixture 'appdata/agent-room/skills/personal/SKILL.md' 'A skill-shaped file is not proof of ownership'
    $skillNotes = Write-Fixture 'appdata/agent-room/skills/personal/my-work.txt' 'unrelated personal work'
    Reject { Get-ChorusDataPlan $appData $portable } 'Unproven skill ownership accepted'
    Check ([IO.File]::ReadAllText($skill) -eq 'A skill-shaped file is not proof of ownership') 'Unproven skill changed'
    Check ([IO.File]::ReadAllText($skillNotes) -eq 'unrelated personal work') 'Unknown user content inside skill was changed'
    [IO.File]::Delete($skillNotes)
    [IO.File]::Delete($skill); [IO.Directory]::Delete([IO.Path]::GetDirectoryName($skill), $false)
    $archiveName = 'arc_' + ('a' * 32)
    $archiveJson = '{"id":"' + $archiveName + '","roomId":"room_fixture","messages":[{"id":"msg_fixture","text":"saved"}]}'
    $archiveFile = Write-Fixture ('appdata/agent-room/archives/room_fixture/' + $archiveName + '.json') $archiveJson
    $trashRoom = Write-Fixture 'appdata/agent-room/trash/room_deleted_1700000000000/room.json' '{"id":"room_deleted"}'
    Write-Fixture 'appdata/agent-room/trash/room_deleted_1700000000000/messages.json' '[]' | Out-Null
    Write-Fixture 'appdata/agent-room/trash/room_deleted_1700000000000/archives.json' ($archiveJson.Replace('room_fixture', 'room_deleted').Insert(0, '[') + ']') | Out-Null
    Write-Fixture 'appdata/agent-room/trash/room_deleted_1700000000000/restore.json' '{"id":"room_restored"}' | Out-Null
    Write-Fixture 'appdata/agent-room/trash/room_deleted_1700000000000/restore-bots.json' '[{"id":"bot_original","bot":{"id":"bot_restored"}}]' | Out-Null
    Write-Fixture 'appdata/agent-room/messages/room_deleted.json' '[]' | Out-Null
    Check ((Get-ChorusDataPlan $appData $portable).files.Count -eq 12) 'Real archive/trash/recovery layouts rejected'
    $emptyArchive = Join-Path (Join-Path $appData 'agent-room/archives') ('room_' + ('c' * 32))
    [IO.Directory]::CreateDirectory($emptyArchive) | Out-Null
    Check ((Get-ChorusDataPlan $appData $portable).directories -contains $emptyArchive) 'Empty generated archive directory rejected'
    $unknownArchive = Join-Path (Join-Path $appData 'agent-room/archives') 'personal-project'
    [IO.Directory]::CreateDirectory($unknownArchive) | Out-Null
    Reject { Get-ChorusDataPlan $appData $portable } 'Unknown empty archive directory accepted'
    [IO.Directory]::Delete($unknownArchive, $false)
    $orphan = Write-Fixture ('appdata/agent-room/messages/room_' + ('d' * 32) + '.json') '[]'
    Check ((Get-ChorusDataPlan $appData $portable).files.path -contains $orphan) 'Empty generated transcript tombstone rejected'
    [IO.File]::WriteAllText($orphan, ([string][char]0xFEFF + " `r`n[ `t ]`r`n"))
    Check ((Get-ChorusDataPlan $appData $portable).files.path -contains $orphan) 'Whitespace/BOM empty transcript tombstone rejected'
    [IO.File]::WriteAllText($orphan, '[{"id":"msg_unproven","text":"must preserve"}]')
    Reject { Get-ChorusDataPlan $appData $portable } 'Nonempty orphan transcript accepted'
    Check ([IO.File]::ReadAllText($orphan) -eq '[{"id":"msg_unproven","text":"must preserve"}]') 'Orphan transcript changed'
    foreach ($invalid in @('{}', '[null]', '[]{}', '[', '')) {
        [IO.File]::WriteAllText($orphan, $invalid)
        Reject { Get-ChorusDataPlan $appData $portable } 'Invalid orphan transcript accepted'
    }
    [IO.File]::Delete($orphan)
    $emptyUnknown = Write-Fixture 'appdata/agent-room/messages/personal-project.json' '[]'
    Reject { Get-ChorusDataPlan $appData $portable } 'Unknown filename accepted as an empty transcript'
    [IO.File]::Delete($emptyUnknown)
    foreach ($relative in @('messages/package.json', 'archives/my-project/package.json', 'archives/room_fixture/package.json', 'trash/room_deleted_1700000000000/package.json', 'trash/my-project/package.json', 'logs/package.json')) {
        $unexpected = Write-Fixture ('appdata/agent-room/' + $relative) '{"name":"my-project"}'
        Reject { Get-ChorusDataPlan $appData $portable } "Unknown project JSON accepted: $relative"
        Check ([IO.File]::ReadAllText($unexpected) -eq '{"name":"my-project"}') 'Unknown project JSON changed during planning'
        [IO.File]::Delete($unexpected)
        if ($relative -match '/my-project/') { [IO.Directory]::Delete([IO.Path]::GetDirectoryName($unexpected), $false) }
    }
    $nested = Write-Fixture 'appdata/agent-room/archives/room_fixture/project/package.json' '{}'
    Reject { Get-ChorusDataPlan $appData $portable } 'Nested project directory accepted'
    [IO.File]::Delete($nested); [IO.Directory]::Delete([IO.Path]::GetDirectoryName($nested), $false)
    $messageFile = Join-Path $appData 'agent-room/messages/room_fixture.json'
    [IO.File]::WriteAllText($messageFile, '{"name":"project disguised as transcript"}')
    Reject { Get-ChorusDataPlan $appData $portable } 'Invalid known-room transcript accepted'
    [IO.File]::WriteAllText($messageFile, '[]')
    [IO.File]::WriteAllText($archiveFile, $archiveJson.Replace('room_fixture', 'room_other'))
    Reject { Get-ChorusDataPlan $appData $portable } 'Archive roomId mismatch accepted'
    [IO.File]::WriteAllText($archiveFile, $archiveJson.Replace($archiveName, 'arc_' + ('b' * 32)))
    Reject { Get-ChorusDataPlan $appData $portable } 'Archive filename mismatch accepted'
    [IO.File]::WriteAllText($archiveFile, $archiveJson.Replace('[{"id":"msg_fixture","text":"saved"}]', '{}'))
    Reject { Get-ChorusDataPlan $appData $portable } 'Invalid archive messages accepted'
    [IO.File]::WriteAllText($archiveFile, $archiveJson)
    [IO.File]::WriteAllText($trashRoom, '{"id":"different_room"}')
    Reject { Get-ChorusDataPlan $appData $portable } 'Trash directory/room mismatch accepted'
    [IO.File]::WriteAllText($trashRoom, '{"id":"room_deleted"}')
    [IO.File]::WriteAllText($rooms, ('[{"id":"room_fixture","cwd":' + ((Join-Path $appData 'agent-room/messages') | ConvertTo-Json) + '}]'))
    Reject { Get-ChorusDataPlan $appData $portable } 'Nested project accepted'
    [IO.File]::WriteAllText($rooms, '[{"id":"room_fixture"}]')
    $junction = Join-Path $portable 'linked-project'
    New-Item -ItemType Junction -Path $junction -Target ([IO.Path]::GetDirectoryName($project)) | Out-Null
    Reject { Get-ChorusBundlePlan $portable } 'Junction in bundle accepted'
    Reject { Get-ChorusBundlePlan $junction } 'Junction root accepted'
    [IO.Directory]::Delete($junction, $false); $junction = $null
    # The only actual removals under test target this freshly created fixture.
    $data = Get-ChorusDataPlan $appData $portable
    Remove-ChorusPlan $data
    Check (-not (Test-Path -LiteralPath $data.root)) 'App data fixture was not removed'
    Remove-ChorusPlan (Get-ChorusBundlePlan $portable)
    Check (-not (Test-Path -LiteralPath $portable)) 'Portable fixture was not removed'
    Check (([IO.File]::ReadAllText($project) -eq 'external project survives') -and ([IO.File]::ReadAllText($native) -eq 'native agent survives')) 'External data was modified'
    $changed = New-Bundle 'changed'
    $oldPlan = Get-ChorusBundlePlan $changed
    Write-Fixture 'changed/late-user-file.txt' 'preserve after plan' | Out-Null
    Reject { Remove-ChorusPlan $oldPlan } 'Changes after inspection were deleted'
    Check (Test-Path -LiteralPath (Join-Path $changed 'Chorus.exe')) 'Mutation happened before final validation'
    Write-Output "PASS: $count uninstall safety checks; only disposable fixtures removed; no app or uninstaller launched."
} finally {
    if ($junction -and (Test-Path -LiteralPath $junction)) { [IO.Directory]::Delete($junction, $false) }
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ([IO.Path]::GetDirectoryName($resolved) -eq [IO.Path]::GetTempPath().TrimEnd('\') -and [IO.Path]::GetFileName($resolved).StartsWith('chorus-uninstall-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
