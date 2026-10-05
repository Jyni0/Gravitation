# Builds the Linux server on Windows: sync-server/dist/gravitation-sync
# (static, runs on any x86-64 Debian/Ubuntu). Copy it to the server and run
#   sudo ./gravitation-sync install
#
#   powershell -ExecutionPolicy Bypass -File sync-server\build.ps1        # x86-64
#   powershell -ExecutionPolicy Bypass -File sync-server\build.ps1 -Arm   # ARM64 (e.g. Raspberry Pi, Ampere)
#
# The first run installs what the cross-build needs: the Rust musl target,
# Zig (as a Python package) and cargo-zigbuild.
param([switch]$Arm)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$target = if ($Arm) { "aarch64-unknown-linux-musl" } else { "x86_64-unknown-linux-musl" }

if (-not ((rustup target list --installed) -contains $target)) {
    Write-Host "Adding Rust target $target..."
    rustup target add $target
}

$zig = (Get-Command zig -ErrorAction SilentlyContinue).Source
if (-not $zig) {
    $zig = python -c "import ziglang,os;print(os.path.join(os.path.dirname(ziglang.__file__),'zig.exe'))" 2>$null
    if (-not $zig -or -not (Test-Path $zig)) {
        Write-Host "Installing Zig (pip install ziglang)..."
        python -m pip install --quiet ziglang
        $zig = python -c "import ziglang,os;print(os.path.join(os.path.dirname(ziglang.__file__),'zig.exe'))"
    }
}
$env:CARGO_ZIGBUILD_ZIG_PATH = $zig

if (-not (Get-Command cargo-zigbuild -ErrorAction SilentlyContinue)) {
    Write-Host "Installing cargo-zigbuild..."
    cargo install cargo-zigbuild --locked
}

cargo zigbuild --release --locked --target $target
if ($LASTEXITCODE -ne 0) { throw "build failed" }

New-Item -ItemType Directory -Force dist | Out-Null
$out = if ($Arm) { "dist\gravitation-sync-arm64" } else { "dist\gravitation-sync" }
Copy-Item "target\$target\release\gravitation-sync" $out -Force
$size = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host ""
Write-Host "Built $out ($size MB). On the server:"
Write-Host "  scp $PSScriptRoot\$out user@server:~/gravitation-sync"
Write-Host "  ssh user@server 'chmod +x gravitation-sync && sudo ./gravitation-sync install'"
