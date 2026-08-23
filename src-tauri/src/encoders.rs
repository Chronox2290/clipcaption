//! Hardware encoder detection. `ffmpeg -encoders` only proves the build has
//! the codec compiled in — the real test is encoding a few frames, which fails
//! fast when the GPU/driver isn't there. Results are cached for the app's
//! lifetime.

use std::sync::OnceLock;

use crate::sidecar;

pub const CANDIDATES: [(&str, &str, &str); 3] = [
    ("nvenc", "h264_nvenc", "NVIDIA NVENC"),
    ("amf", "h264_amf", "AMD AMF"),
    ("qsv", "h264_qsv", "Intel QuickSync"),
];

/// Short names of encoders that actually work on this machine ("x264" always).
pub fn available() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut v = vec!["x264".to_string()];
            for (name, codec, _) in CANDIDATES {
                if test_encoder(codec) {
                    v.push(name.to_string());
                }
            }
            v
        })
        .clone()
}

/// Resolve "auto"/None to a concrete encoder: prefer the GPU when present.
pub fn resolve(requested: Option<&str>) -> String {
    let avail = available();
    match requested {
        Some("auto") | None | Some("") => {
            for pref in ["nvenc", "amf", "qsv"] {
                if avail.iter().any(|a| a == pref) {
                    return pref.to_string();
                }
            }
            "x264".to_string()
        }
        Some(e) if avail.iter().any(|a| a == e) => e.to_string(),
        // requested a specific encoder that isn't available — fall back safely
        Some(_) => "x264".to_string(),
    }
}

fn test_encoder(codec: &str) -> bool {
    sidecar::command("ffmpeg")
        .args([
            "-v", "error",
            "-f", "lavfi",
            "-i", "color=black:s=256x256:d=0.2:r=30",
            "-frames:v", "3",
            "-c:v", codec,
            "-f", "null",
            "-",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// ffmpeg args for quality-targeted (CRF-style) encoding.
pub fn quality_args(encoder: &str, crf: u32) -> Vec<String> {
    let q = crf.to_string();
    match encoder {
        "nvenc" => svec(&[
            "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", &q, "-b:v", "0",
        ]),
        "amf" => svec(&[
            "-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", &q, "-qp_p", &q,
        ]),
        "qsv" => svec(&["-c:v", "h264_qsv", "-global_quality", &q]),
        _ => svec(&["-c:v", "libx264", "-preset", "medium", "-crf", &q]),
    }
}

/// ffmpeg args for bitrate-capped encoding (target file size) on GPU encoders.
/// (x264 uses its own two-pass path instead.)
pub fn bitrate_args(encoder: &str, kbps: u64) -> Vec<String> {
    let b = format!("{kbps}k");
    let buf = format!("{}k", kbps * 2);
    match encoder {
        "nvenc" => svec(&[
            "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr",
            "-b:v", &b, "-maxrate", &b, "-bufsize", &buf,
        ]),
        "amf" => svec(&[
            "-c:v", "h264_amf", "-rc", "vbr_peak",
            "-b:v", &b, "-maxrate", &b, "-bufsize", &buf,
        ]),
        "qsv" => svec(&["-c:v", "h264_qsv", "-b:v", &b, "-maxrate", &b, "-bufsize", &buf]),
        _ => svec(&["-c:v", "libx264", "-preset", "medium", "-b:v", &b]),
    }
}

fn svec(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_falls_back_when_gpu_missing() {
        // this test container has no GPU: available() == ["x264"]
        let avail = available();
        if avail.len() == 1 {
            assert_eq!(resolve(None), "x264");
            assert_eq!(resolve(Some("auto")), "x264");
            assert_eq!(resolve(Some("nvenc")), "x264"); // graceful fallback
        } else {
            // on a GPU machine auto must pick a GPU encoder
            assert_ne!(resolve(Some("auto")), "x264");
        }
        assert_eq!(resolve(Some("x264")), "x264");
    }

    #[test]
    fn arg_builders_name_the_right_codec() {
        assert!(quality_args("nvenc", 20).contains(&"h264_nvenc".to_string()));
        assert!(quality_args("amf", 20).contains(&"h264_amf".to_string()));
        assert!(quality_args("qsv", 20).contains(&"h264_qsv".to_string()));
        assert!(quality_args("x264", 20).contains(&"libx264".to_string()));
        let b = bitrate_args("nvenc", 4000);
        assert!(b.contains(&"4000k".to_string()) && b.contains(&"-maxrate".to_string()));
    }
}
