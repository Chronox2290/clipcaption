use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

#[cfg(all(windows, target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";
#[cfg(all(windows, target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-pc-windows-msvc";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-unknown-linux-gnu";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-apple-darwin";

/// Resolve a sidecar binary (ffmpeg / ffprobe / whisper-cli).
///
/// Order:
/// 1. `CLIPCAPTION_<NAME>` env var override
/// 2. next to the app executable (bundled sidecar, production)
/// 3. `src-tauri/binaries/<name>-<triple>` (dev, after scripts/get-sidecars)
/// 4. bare name on PATH (dev fallback: system-installed ffmpeg etc.)
pub fn resolve(name: &str) -> PathBuf {
    let env_key = format!("CLIPCAPTION_{}", name.replace('-', "_").to_uppercase());
    if let Ok(p) = std::env::var(&env_key) {
        return PathBuf::from(p);
    }

    // In dev builds, prefer src-tauri/binaries: Tauri copies the sidecar EXE
    // next to target/debug/clipcaption.exe, but NOT its companion DLLs
    // (whisper-cli needs ggml.dll etc.), so the copy crashes at startup.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{TARGET_TRIPLE}{EXE_SUFFIX}"));
    if cfg!(debug_assertions) && dev.exists() {
        return dev;
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(format!("{name}{EXE_SUFFIX}"));
            if p.exists() {
                return p;
            }
        }
    }

    if dev.exists() {
        return dev;
    }

    PathBuf::from(format!("{name}{EXE_SUFFIX}"))
}

/// Build a Command with the console window hidden on Windows.
pub fn command(name: &str) -> Command {
    let cmd = Command::new(resolve(name));
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = cmd;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    cmd
}
