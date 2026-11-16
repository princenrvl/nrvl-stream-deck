# NRVL Stream Deck — install or update the agent on a Windows PC.   UNTESTED: written without access to Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -PairingString nrvl1....
# Get the pairing string on the hub Mac with:  npm run pair agent   (omit -PairingString when only updating).
param([string]$PairingString = "")
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA "Programs\NRVLStreamDeck"
$exe = Join-Path $dest "nrvl-agent.exe"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw "The .NET 8 SDK is required: https://dotnet.microsoft.com/download" }

Write-Host "==> Stopping a running agent, if any"
Get-Process nrvl-agent -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "==> Building the agent into $dest"
dotnet publish (Join-Path $repo "agents\windows\NrvlAgent") -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o $dest
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

if ($PairingString) {
    Write-Host "==> Pairing this PC"
    & $exe pair $PairingString | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Pairing failed" }
}

Write-Host "==> Starting the agent (and at every sign-in)"
& $exe install | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Could not start the agent. If this PC is not paired yet, run this script again with -PairingString." }
Write-Host "Done. Log: $env:LOCALAPPDATA\NRVLStreamDeck\agent.log"
