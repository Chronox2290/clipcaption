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

/// Resolve a sidecar binary that lives in its own subdirectory of
/// `binaries/`, rather than alongside ffmpeg/whisper-cli/sherpa at the top
/// level.
///
/// llama-server needs this: it and whisper-cli are both built on the ggml
/// tensor library, and both ship `ggml.dll`, `ggml-cpu-*.dll` and friends -
/// same filenames, different builds, no ABI guarantee between them. Windows
/// resolves a launched exe's DLLs from the directory *that exe lives in*
/// first, so giving llama-server its own subdirectory with its own copies of
/// those DLLs means each tool loads its own, and neither can silently
/// overwrite or shadow the other's at the filesystem level.
pub fn resolve_in(subdir: &str, name: &str) -> PathBuf {
    let env_key = format!(
        "CLIPCAPTION_{}_{}",
        subdir.to_uppercase(),
        name.replace('-', "_").to_uppercase()
    );
    if let Ok(p) = std::env::var(&env_key) {
        return PathBuf::from(p);
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(subdir)
        .join(format!("{name}-{TARGET_TRIPLE}{EXE_SUFFIX}"));
    if cfg!(debug_assertions) && dev.exists() {
        return dev;
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(subdir).join(format!("{name}{EXE_SUFFIX}"));
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

/// `command()` for a sidecar resolved via `resolve_in`.
pub fn command_in(subdir: &str, name: &str) -> Command {
    let cmd = Command::new(resolve_in(subdir, name));
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

/// Resolve a bundled data file (not an executable — e.g. the .onnx model
/// files the speaker-diarization sidecar needs). Same search order as
/// `resolve()` minus the exe-suffix/target-triple handling, since these
/// files are the same bytes on every platform.
pub fn resolve_data(filename: &str) -> PathBuf {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(filename);
    if cfg!(debug_assertions) && dev.exists() {
        return dev;
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(filename);
            if p.exists() {
                return p;
            }
        }
    }

    dev
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
