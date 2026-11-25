param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
$file = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    [Console]::WriteLine('locked')
    [Console]::Out.Flush()
    [Console]::ReadLine() | Out-Null
} finally {
    $file.Dispose()
}
