param([switch]$Inspect, [switch]$InstalledRemove, [switch]$Update)
$ErrorActionPreference = 'Stop'

function Assert-PlainPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full -notmatch '^[A-Za-z]:\\' -or $full.Length -le 3) { throw 'A local, non-root directory is required.' }
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -Force -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked paths are not removable: $current" }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $full
}

function Test-Within([string]$Child, [string]$Parent) {
    return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Read-ChorusJson([string]$Path) {
    try { return ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) }
    catch { throw "Cannot validate JSON; no removal is allowed: $Path" }
}

function Get-PlainTree([string]$Root) {
    # Enumerate one level at a time: never recurse through a junction first.
    foreach ($entry in Get-ChildItem -Force -LiteralPath $Root) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked contents are not removable: $($entry.FullName)" }
        $entry
        if ($entry.PSIsContainer) { Get-PlainTree $entry.FullName }
    }
}

function Get-ChorusFileHash([string]$Path) {
    # Native installer launches must not depend on PowerShell module discovery.
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    } finally {
        if ($stream) { $stream.Dispose() }
        $algorithm.Dispose()
    }
}

function Get-FileRecord($Item) {
    return [pscustomobject]@{ path = $Item.FullName; bytes = $Item.Length; sha256 = Get-ChorusFileHash $Item.FullName }
}

function Get-ChorusBundlePlan([string]$Root, [bool]$Installed = $false) {
    $rootPath = Assert-PlainPath $Root
    foreach ($protected in @($env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemRoot, [IO.Path]::GetTempPath())) {
        if ($protected -and $rootPath -eq [IO.Path]::GetFullPath($protected).TrimEnd('\')) { throw 'Refusing a shared system or personal directory.' }
    }
    $tree = @(Get-PlainTree $rootPath)
    $manifestPath = Join-Path $rootPath 'RELEASE-MANIFEST.json'
    $manifest = Read-ChorusJson $manifestPath
    if ($manifest.product -cne 'Chorus' -or $manifest.kind -cne 'desktop' -or $manifest.platform -cne 'win32' -or $manifest.format -ne 1) { throw 'This directory is not a Windows Chorus release.' }
    $expected = @{}
    foreach ($record in $manifest.files) {
        $relative = [string]$record.path
        if ($relative -notmatch '^[^\\:]+$' -or $relative -match '(^|/)(\.|\.\.|)(/|$)' -or $relative -match '[<>"|?*\x00-\x1f]' -or $relative -match '[. ](/|$)' -or $record.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Unsafe release manifest entry.' }
        $file = [IO.Path]::GetFullPath((Join-Path $rootPath $relative))
        if (-not (Test-Within $file $rootPath) -or $expected.ContainsKey($file)) { throw 'Duplicate or escaping release manifest entry.' }
        $expected[$file] = $record
    }
    foreach ($required in @('Chorus.exe', 'uninstall-chorus.ps1', 'Uninstall Chorus.cmd', 'resources/app/package.json', 'resources/app/desktop-bootstrap.js')) {
        if (-not $expected.ContainsKey((Join-Path $rootPath $required))) { throw "Release identity is incomplete: $required" }
    }
    $package = Read-ChorusJson (Join-Path $rootPath 'resources/app/package.json')
    if ($package.name -cne 'agent-room' -or $package.productName -cne 'Chorus' -or $package.version -cne $manifest.version) { throw 'Release identity does not match the application.' }
    $files = @()
    $allowedDirectories = @{}
    foreach ($file in $expected.Keys) {
        $directory = [IO.Path]::GetDirectoryName($file)
        while ($directory -ne $rootPath) { $allowedDirectories[$directory] = $true; $directory = [IO.Path]::GetDirectoryName($directory) }
    }
    foreach ($entry in $tree) {
        if ($entry.PSIsContainer) {
            if (-not $allowedDirectories.ContainsKey($entry.FullName)) { throw "Unrecognized directory; move it outside this app before retrying: $($entry.FullName)" }
            continue
        }
        $record = Get-FileRecord $entry
        if ($expected.ContainsKey($entry.FullName)) {
            $wanted = $expected[$entry.FullName]
            if ($record.sha256 -ne $wanted.sha256 -or $record.bytes -ne $wanted.bytes) { throw "Modified release file; removal stopped: $($entry.FullName)" }
            $expected.Remove($entry.FullName)
        } elseif ($entry.FullName -ne $manifestPath -and -not ($Installed -and $entry.Name -ceq 'Uninstall Chorus.exe' -and $entry.DirectoryName -eq $rootPath)) {
            throw "Unrecognized file; move it outside this app before retrying: $($entry.FullName)"
        }
        $files += $record
    }
    if ($expected.Count) { throw 'Release files are missing; restore this release before retrying.' }
    return [pscustomobject]@{ root = $rootPath; identity = (Get-Item -LiteralPath $rootPath).CreationTimeUtc.Ticks; files = $files; directories = @($tree | Where-Object PSIsContainer | ForEach-Object FullName) }
}

function Find-ProtectedReferences($Value) {
    if ($null -eq $Value) { return }
    if ($Value -is [string]) {
        if ($Value.StartsWith('project:') -and $Value.Substring(8) -match '^[A-Za-z]:[\\/]') { [IO.Path]::GetFullPath($Value.Substring(8)).TrimEnd('\') }
    } elseif ($Value -is [array]) {
        foreach ($item in $Value) { Find-ProtectedReferences $item }
    } elseif ($Value -is [pscustomobject]) {
        foreach ($property in $Value.PSObject.Properties) {
            if ($property.Name -match '^(cwd|defaultCwd|sourcePath)$' -and $property.Value -is [string] -and $property.Value -match '^[A-Za-z]:[\\/]') {
                [IO.Path]::GetFullPath($property.Value).TrimEnd('\')
            }
            Find-ProtectedReferences $property.Name
            Find-ProtectedReferences $property.Value
        }
    }
}

function Test-ChorusCacheEntry([string]$Relative, [bool]$Directory) {
    # Chromium owns these concrete layouts. A familiar top-level cache name
    # does not confer ownership on arbitrary files placed beneath it.
    # net/http/no_vary_search_cache_storage.h defines these two filenames.
    if ($Directory -and $Relative -ceq 'Cache/No_Vary_Search') { return $true }
    if (-not $Directory -and $Relative -cmatch '^Cache/No_Vary_Search/(snapshot\.baf|journal\.baj)$') { return $true }
    # content/browser/network_sandbox.cc creates this empty migration checkpoint.
    if (-not $Directory -and $Relative -ceq 'Network/NetworkDataMigrated') { return $true }
    # Chromium's persistent_cache_sandboxed_file_factory uses a 32-character
    # SHA1/base32 version suffix; sqlite_vfs/constants.h defines these suffixes.
    if ($Directory -and $Relative -cmatch '^GPUPersistentCache(/DawnGraphiteCache(/[A-Z2-7]{32})?)?$') { return $true }
    if (-not $Directory -and $Relative -cmatch '^GPUPersistentCache/DawnGraphiteCache/[A-Z2-7]{32}/cache\.(db(-wal|-shm)?|journal)$') { return $true }
    if ($Directory) {
        return $Relative -match '^(Cache(/Cache_Data(/index-dir)?)?|Code Cache(/(js|wasm)(/index-dir)?)?|GPUCache|GrShaderCache|ShaderCache|DawnGraphiteCache|DawnWebGPUCache|Session Storage|Local Storage(/leveldb)?|Network|Crashpad(/(reports|pending|completed|attachments))?|Dictionaries|blob_storage(/[a-f0-9-]{36})?|IndexedDB(/[^/]+\.indexeddb\.leveldb)?|WebStorage|Shared Dictionary(/cache(/index-dir)?)?)$'
    }
    $diskCache = '(index|data_[0-3]|f_[a-f0-9]+|[a-f0-9]{16}_[0-9s]|index-dir/the-real-index)'
    $levelDb = '(CURRENT|LOCK|LOG(\.old)?|[0-9]+\.(log|ldb)|MANIFEST-[0-9]+)'
    return $Relative -match ('^(Cache/Cache_Data|Code Cache/(js|wasm)|GPUCache|GrShaderCache|ShaderCache|DawnGraphiteCache|DawnWebGPUCache|Shared Dictionary/cache)/' + $diskCache + '$') -or
        $Relative -match ('^(Session Storage|Local Storage/leveldb|IndexedDB/[^/]+\.indexeddb\.leveldb)/' + $levelDb + '$') -or
        $Relative -match '^Network/(Cookies(-journal)?|Network Persistent State|TransportSecurity|Trust Tokens(-journal)?|Reporting and NEL(-journal)?)$' -or
        $Relative -match '^Crashpad/(metadata|settings\.dat|(reports|pending|completed)/[a-f0-9-]{36}\.(dmp|meta))$' -or
        $Relative -match '^Dictionaries/[a-z0-9_-]+\.bdic$' -or
        $Relative -match '^blob_storage/[a-f0-9-]{36}/[a-f0-9-]{36}$' -or
        $Relative -match '^WebStorage/QuotaManager(-journal)?$' -or
        $Relative -match '^Shared Dictionary/db(-journal)?$'
}

function Assert-ChorusRecords($Records, [string]$Path) {
    if ($Records -isnot [array]) { throw "Expected a Chorus record list: $Path" }
    foreach ($record in $Records) {
        if ($record -isnot [pscustomobject] -or $record.id -isnot [string] -or $record.id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw "Unrecognized Chorus record: $Path" }
    }
}

function Read-ChorusRecords([string]$Path) {
    $raw = [IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF).TrimStart()
    if (-not $raw.StartsWith('[')) { throw "Expected a Chorus record list: $Path" }
    $records = @()
    if ($raw -notmatch '^\[\s*\]$') { $decoded = Read-ChorusJson $Path; $records = @($decoded) }
    Assert-ChorusRecords $records $Path
    return $records
}

function Assert-ChorusArchive($Record, [string]$RoomId, [string]$Path) {
    if ($Record -isnot [pscustomobject] -or $Record.id -isnot [string] -or $Record.id -cnotmatch '^arc_[a-f0-9]{32}$' -or $Record.roomId -cne $RoomId) { throw "Unrecognized room archive: $Path" }
    Assert-ChorusRecords $Record.messages $Path
}

function Get-ChorusHistoryRooms([string]$Root, $Tree) {
    $rooms = @{}
    # Archive deletion intentionally leaves empty generated room directories.
    $archiveRoot = Join-Path $Root 'archives'
    foreach ($directory in @($Tree | Where-Object { $_.PSIsContainer -and $_.Parent.FullName -eq $archiveRoot })) {
        if ($directory.Name -cmatch '^room_[a-f0-9]{32}$' -and @(Get-ChildItem -Force -LiteralPath $directory.FullName).Count -eq 0) { $rooms[$directory.Name] = $true }
    }
    if (Test-Path -LiteralPath (Join-Path $Root 'rooms.json')) {
        foreach ($room in @(Read-ChorusRecords (Join-Path $Root 'rooms.json'))) { $rooms[$room.id] = $true }
    }
    $trash = Join-Path $Root 'trash'
    foreach ($directory in @($Tree | Where-Object { $_.PSIsContainer -and $_.Parent.FullName -eq $trash })) {
        $room = Read-ChorusJson (Join-Path $directory.FullName 'room.json')
        if ($room -isnot [pscustomobject] -or $room.id -isnot [string] -or $room.id -notmatch '^[A-Za-z0-9_-]{1,128}$' -or $directory.Name -cnotmatch ('^' + [regex]::Escape($room.id) + '_[0-9]{10,16}$')) { throw "Unrecognized trash snapshot: $($directory.FullName)" }
        Read-ChorusRecords (Join-Path $directory.FullName 'messages.json') | Out-Null
        $rooms[$room.id] = $true
        $restoreFile = Join-Path $directory.FullName 'restore.json'
        if (Test-Path -LiteralPath $restoreFile) {
            $restore = Read-ChorusJson $restoreFile
            if ($restore -isnot [pscustomobject] -or $restore.id -isnot [string] -or $restore.id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw "Unrecognized restored room: $restoreFile" }
            $rooms[$restore.id] = $true
        }
    }
    return $rooms
}

function Assert-ChorusHistoryEntry($Entry, [string[]]$Parts, $Rooms, [string]$Root) {
    $file = $Entry.FullName
    if ($Parts[0] -eq 'messages') {
        if ($Entry.PSIsContainer -or $Parts.Count -ne 2 -or $Entry.Extension -cne '.json') { throw "Unrecognized room transcript: $file" }
        if (-not $Rooms.ContainsKey($Entry.BaseName)) {
            # purgeTrash writes [] before deleting the room's recovery record.
            # Only this content-free tombstone can establish its own scope.
            if ($Entry.BaseName -cnotmatch '^room_[a-f0-9]{32}$' -or [IO.File]::ReadAllText($file).TrimStart([char]0xFEFF) -notmatch '^\s*\[\s*\]\s*$') { throw "Unrecognized room transcript: $file" }
        }
        Read-ChorusRecords $file | Out-Null
    } elseif ($Parts[0] -eq 'archives') {
        if (-not $Rooms.ContainsKey($Parts[1]) -or ($Entry.PSIsContainer -and $Parts.Count -ne 2) -or (-not $Entry.PSIsContainer -and ($Parts.Count -ne 3 -or $Entry.Extension -cne '.json'))) { throw "Unrecognized archive layout: $file" }
        if (-not $Entry.PSIsContainer) {
            $archive = Read-ChorusJson $file
            Assert-ChorusArchive $archive $Parts[1] $file
            if ($archive.id -cne $Entry.BaseName) { throw "Archive filename does not match its record: $file" }
        }
    } else {
        if (($Entry.PSIsContainer -and $Parts.Count -ne 2) -or (-not $Entry.PSIsContainer -and ($Parts.Count -ne 3 -or $Entry.Name -cnotin @('room.json', 'messages.json', 'archives.json', 'restore.json', 'restore-bots.json')))) { throw "Unrecognized trash layout: $file" }
        if (-not $Entry.PSIsContainer) {
            $room = Read-ChorusJson (Join-Path (Join-Path (Join-Path $Root 'trash') $Parts[1]) 'room.json')
            switch -CaseSensitive ($Entry.Name) {
                'messages.json' { Read-ChorusRecords $file | Out-Null }
                'archives.json' { foreach ($archive in @(Read-ChorusRecords $file)) { Assert-ChorusArchive $archive $room.id $file } }
                'restore-bots.json' {
                    foreach ($profile in @(Read-ChorusRecords $file)) {
                        if ($profile.bot -isnot [pscustomobject] -or $profile.bot.id -isnot [string] -or $profile.bot.id -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw "Unrecognized restored member profile: $file" }
                    }
                }
            }
        }
    }
}

function Get-ChorusDataPlan([string]$AppData, [string]$BundleRoot) {
    $parent = Assert-PlainPath $AppData
    $rootPath = Assert-PlainPath (Join-Path $parent 'agent-room')
    if (-not (Test-Path -LiteralPath $rootPath)) { return $null }
    $tree = @(Get-PlainTree $rootPath)
    if ($tree.Count) {
        foreach ($name in @('bots.json', 'rooms.json', 'settings.json')) {
            $file = Join-Path $rootPath $name
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Cannot establish Chorus data ownership; inspect this directory manually: $rootPath" }
            $raw = [IO.File]::ReadAllText($file).TrimStart([char]0xFEFF).TrimStart()
            $json = Read-ChorusJson $file
            if (($name -eq 'settings.json' -and $raw[0] -ne '{') -or ($name -ne 'settings.json' -and $raw[0] -ne '[')) { throw 'Unrecognized Chorus store shape.' }
            if ($name -ne 'settings.json') {
                foreach ($item in $json) { if (-not ($item.id -is [string]) -or -not $item.id) { throw 'Unrecognized Chorus store records.' } }
            }
        }
    }
    $rootFiles = '^(bots|rooms|settings|sessions|native-capabilities|skill-references|rooms-before-title-migration|rooms-before-local-profiles|side-members-before-sharing)\.json$|^events\.log$|^(Preferences|Local State|Network Persistent State|DIPS|DIPS-wal|DIPS-shm|Trust Tokens|Trust Tokens-journal|SharedStorage|SharedStorage-wal|SharedStorage-shm|TransportSecurity|First Run|DevToolsActivePort|declarative_performance_observer\.db(-journal)?)$|^\.convoke-store-lock(\.stale-[a-f0-9-]+)?$|^\.convoke-lock-owner-[a-f0-9-]+$'
    $appDirs = @('messages', 'archives', 'trash', 'logs', 'skills')
    $cacheDirs = @('Cache', 'Code Cache', 'GPUCache', 'GPUPersistentCache', 'GrShaderCache', 'ShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Session Storage', 'Local Storage', 'Network', 'Crashpad', 'Dictionaries', 'blob_storage', 'IndexedDB', 'WebStorage', 'Shared Dictionary')
    $historyRooms = Get-ChorusHistoryRooms $rootPath $tree
    $files = @()
    $references = @()
    foreach ($entry in $tree) {
        $relative = $entry.FullName.Substring($rootPath.Length + 1).Replace('\', '/')
        $parts = $relative.Split('/')
        if ($parts -match '^(\.git|\.codex|\.claude|\.agents|\.gemini|\.kimi|\.qwen|\.cursor|\.vscode|node_modules)$') { throw "Project or native Agent content is protected: $($entry.FullName)" }
        if ($parts.Count -eq 1) {
            if ($entry.PSIsContainer) {
                if ($entry.Name -notin ($appDirs + $cacheDirs)) { throw "Unrecognized app data directory: $($entry.FullName)" }
            } elseif ($entry.Name -notmatch $rootFiles) { throw "Unrecognized app data file: $($entry.FullName)" }
        } elseif ($parts[0] -in @('messages', 'archives', 'trash')) {
            Assert-ChorusHistoryEntry $entry $parts $historyRooms $rootPath
        } elseif ($parts[0] -eq 'logs' -and ($entry.PSIsContainer -or $parts.Count -ne 2 -or $entry.Extension -cne '.log')) {
            throw "Unrecognized log content: $($entry.FullName)"
        } elseif ($parts[0] -eq 'skills' -and $parts.Count -ge 2) {
            # Legacy imports have no provenance manifest. SKILL.md alone cannot
            # distinguish an imported copy from a user's subsequently edited work.
            throw "Skill contents have no ownership record. Review and move them outside the app data directory before retrying: $(Join-Path $rootPath 'skills')"
        } elseif ($parts[0] -in $cacheDirs -and -not (Test-ChorusCacheEntry $relative $entry.PSIsContainer)) {
            throw "Unrecognized cache content: $($entry.FullName)"
        }
        if (-not $entry.PSIsContainer) {
            if ($relative -ceq 'Network/NetworkDataMigrated' -and $entry.Length -ne 0) { throw "Unexpected content in network migration marker: $($entry.FullName)" }
            if ($relative -ceq 'side-members-before-sharing.json') {
                $backup = Read-ChorusJson $entry.FullName
                Assert-ChorusRecords $backup.rooms $entry.FullName
                Assert-ChorusRecords $backup.bots $entry.FullName
            }
            if ($entry.Extension -eq '.json' -and ($parts.Count -eq 1 -or $parts[0] -in @('messages', 'archives', 'trash'))) {
                $references += @(Find-ProtectedReferences (Read-ChorusJson $entry.FullName))
            }
            $files += Get-FileRecord $entry
        }
    }
    foreach ($reference in $references | Select-Object -Unique) {
        if ((Test-Within $reference $rootPath) -or (Test-Within $rootPath $reference) -or (Test-Within $reference $BundleRoot) -or (Test-Within $BundleRoot $reference)) { throw "A project/reference overlaps removal scope; move the app/data safely before uninstalling: $reference" }
    }
    return [pscustomobject]@{ root = $rootPath; identity = (Get-Item -LiteralPath $rootPath).CreationTimeUtc.Ticks; files = $files; directories = @($tree | Where-Object PSIsContainer | ForEach-Object FullName) }
}

function Resolve-ChorusUninstaller($Entries, [string]$Root) {
    $target = Join-Path (Assert-PlainPath $Root) 'Uninstall Chorus.exe'
    $found = @($Entries | Where-Object {
        $_.DisplayName -match '^Chorus(?: \d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)?$' -and
        $_.UninstallString -match '^"([^"\r\n]+)"(?: /currentuser)?$' -and $Matches[1] -eq $target
    })
    if ($found.Count -gt 1) { throw 'Ambiguous registration for this exact installation.' }
    if ($found.Count -eq 1) {
        Assert-PlainPath $target | Out-Null
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Registered uninstaller is missing.' }
        return $target
    }
    if (Test-Path -LiteralPath $target) { throw 'Unregistered installer executable; use the original installer to repair this installation.' }
    return $null
}

function Assert-ChorusClosed([string]$Root, $DataPlan) {
    foreach ($process in Get-Process -Name Chorus -ErrorAction SilentlyContinue) {
        # Another copy can still hold the shared legacy store: never terminate it.
        if ($DataPlan -or -not $process.Path -or (Test-Within $process.Path $Root)) { throw 'Close all Chorus copies before uninstalling.' }
    }
    if ($DataPlan) {
        $lock = Join-Path $DataPlan.root '.convoke-store-lock'
        if (Test-Path -LiteralPath $lock) {
            $owner = Read-ChorusJson $lock
            if (-not ($owner.pid -is [int]) -or $owner.pid -lt 1 -or (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)) { throw 'Chorus data is in use or its store lock requires inspection.' }
        }
    }
}

function Remove-ChorusPlan($Plan) {
    if ((Assert-PlainPath $Plan.root) -ne $Plan.root -or (Get-Item -LiteralPath $Plan.root).CreationTimeUtc.Ticks -ne $Plan.identity) { throw 'Removal root changed; stopped.' }
    $actual = @(Get-PlainTree $Plan.root)
    if ($actual.Count -ne ($Plan.files.Count + $Plan.directories.Count)) { throw 'Directory contents changed; stopped.' }
    foreach ($file in $Plan.files) {
        Assert-PlainPath $file.path | Out-Null
        if (-not (Test-Within $file.path $Plan.root) -or (Get-ChorusFileHash $file.path) -ne $file.sha256) { throw 'Removal file changed; stopped.' }
    }
    # Literal per-file deletes and empty-only directory deletes never sweep up
    # a project or a file created after confirmation. No recursive removal.
    foreach ($file in $Plan.files) { Assert-PlainPath $file.path | Out-Null; [IO.File]::Delete($file.path) }
    foreach ($directory in @($Plan.directories | Sort-Object Length -Descending)) { Assert-PlainPath $directory | Out-Null; [IO.Directory]::Delete($directory, $false) }
    [IO.Directory]::Delete($Plan.root, $false)
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $root = Assert-PlainPath $PSScriptRoot
        $entries = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue)
        $uninstaller = Resolve-ChorusUninstaller $entries $root
        if (($InstalledRemove -or $Update) -and -not $uninstaller) { throw 'This mode requires registration of this exact installation.' }
        $bundle = Get-ChorusBundlePlan $root ([bool]$uninstaller)
        $data = if (-not $Update) { Get-ChorusDataPlan ([Environment]::GetFolderPath('ApplicationData')) $root } else { $null }
        if ($Inspect) {
            [pscustomobject]@{ mode = $(if ($uninstaller) { 'installed' } else { 'portable' }); bundle = $bundle; sharedData = $data; update = [bool]$Update } | ConvertTo-Json -Depth 8
            exit 0
        }
        if ($uninstaller -and -not $InstalledRemove) {
            Set-Location -LiteralPath ([IO.Path]::GetTempPath())
            $process = Start-Process -FilePath $uninstaller -ArgumentList '/currentuser' -PassThru -Wait
            exit $process.ExitCode
        }
        Assert-ChorusClosed $root $data
        Write-Host ('App files to remove: ' + $root)
        if ($data) {
            Write-Host ('Shared Chorus data to permanently remove: ' + $data.root)
            Write-Host 'This deletes ALL Chorus chats, room settings, logs and caches used by other installed/portable Chorus copies too.'
        }
        Write-Host 'External project folders, exported files, native Agent installations and their configurations are not removal targets.'
        if (-not $Update) {
            foreach ($plan in @($bundle, $data)) { if ($plan) { foreach ($file in $plan.files) { Write-Host ('  ' + $file.path) } } }
            if ((Read-Host 'Type DELETE CHORUS AND SHARED DATA to confirm, or press Enter to cancel') -cne 'DELETE CHORUS AND SHARED DATA') { Write-Host 'Cancelled. Nothing removed.'; exit 2 }
        }
        # Rebuild both scopes after the user has inspected them. Content changes
        # require a fresh confirmation rather than expanding the deletion scope.
        $freshBundle = Get-ChorusBundlePlan $root ([bool]$uninstaller)
        $freshData = if (-not $Update) { Get-ChorusDataPlan ([Environment]::GetFolderPath('ApplicationData')) $root } else { $null }
        if ((ConvertTo-Json @($bundle, $data) -Depth 8 -Compress) -cne (ConvertTo-Json @($freshBundle, $freshData) -Depth 8 -Compress)) { throw 'The deletion plan changed; run uninstall again to review it.' }
        Assert-ChorusClosed $root $freshData
        Set-Location -LiteralPath ([IO.Path]::GetTempPath())
        if ($freshData) { Remove-ChorusPlan $freshData }
        Remove-ChorusPlan $freshBundle
        Write-Host 'Chorus files removed successfully.'
        if (-not $Update) { Read-Host 'Press Enter to close' | Out-Null }
    } catch {
        Write-Host ('Uninstall stopped: ' + $_.Exception.Message)
        if (-not $Inspect -and -not $Update) { Read-Host 'Press Enter to close' | Out-Null }
        exit 1
    }
}
