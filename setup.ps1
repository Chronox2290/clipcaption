# ClipCaption one-shot setup: Rust + VS Build Tools + npm deps, then launch.
# Run via SETUP.cmd (double-click) - logs everything to setup-log.txt.

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
Start-Transcript -Path (Join-Path $PSScriptRoot "setup-log.txt") -Force

Write-Host "=== ClipCaption setup ==="

# ---------- 1. Rust toolchain ----------
$cargoBin = "$env:USERPROFILE\.cargo\bin"
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    if (Test-Path "$cargoBin\cargo.exe") { $env:Path = "$cargoBin;$env:Path" }
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "[1/3] Installing Rust (rustup, silent)..."
    $rustup = "$env:USERPROFILE\Downloads\rustup-init.exe"
    if (-not (Test-Path $rustup)) {
        $rustup = "$env:TEMP\rustup-init.exe"
        Write-Host "  downloading rustup-init..."
        Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustup
    }
    & $rustup -y --default-toolchain stable
    $env:Path = "$cargoBin;$env:Path"
} else {
    Write-Host "[1/3] Rust already installed."
}
cargo --version

# ---------- 2. Visual Studio Build Tools (C++ linker) ----------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVC = $false
if (Test-Path $vswhere) {
    $vcPath = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vcPath) { $hasVC = $true }
}
if ($hasVC) {
    Write-Host "[2/3] Visual Studio C++ Build Tools already installed."
} else {
    Write-Host "[2/3] Installing Visual Studio Build Tools (C++ workload)."
    Write-Host "      This is several GB - it can take 10-30 minutes. A progress window will appear."
    $bt = "$env:TEMP\vs_buildtools.exe"
    Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vs_buildtools.exe" -OutFile $bt
    Start-Process -FilePath $bt -Wait -ArgumentList `
        "--passive", "--wait", "--norestart", `
        "--add", "Microsoft.VisualStudio.Workload.VCTools", "--includeRecommended"
    Write-Host "      Build Tools installer finished."
}

# ---------- 3. npm dependencies ----------
Write-Host "[3/3] Installing npm dependencies..."
npm.cmd install

Write-Host ""
Write-Host "=== Setup complete. Launching ClipCaption ==="
Write-Host "First launch compiles the Rust side - expect several minutes of 'Compiling ...' lines."
Stop-Transcript

npm.cmd run tauri dev
