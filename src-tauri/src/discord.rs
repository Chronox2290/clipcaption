//! Posts a finished export straight to a Discord channel via an incoming
//! webhook - "paste a URL into settings, the export shows up," no bot setup,
//! no hosting, no approval step. The channel-side host still enforces its
//! own upload cap (tied to the destination SERVER's boost tier, not the
//! uploading account's Nitro status, and not something this app can query
//! in advance) - rather than guess a number and enforce it client-side,
//! this just attempts the upload and surfaces Discord's own rejection
//! message, pointing at the app's own Discord-sized export presets.

use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

use crate::jobs::{emit_done, emit_error, JobHandle};

pub fn post(
    app: AppHandle,
    job_id: String,
    handle: Arc<JobHandle>,
    webhook_url: String,
    file_path: String,
    message: Option<String>,
) {
    let stage = "posting";
    let result = post_inner(&webhook_url, &file_path, message.as_deref());
    match result {
        Ok(()) => emit_done(&app, &job_id, stage, None),
        Err(e) => {
            if handle.is_cancelled() {
                emit_error(&app, &job_id, stage, "Cancelled".into());
            } else {
                emit_error(&app, &job_id, stage, e);
            }
        }
    }
}

fn post_inner(webhook_url: &str, file_path: &str, message: Option<&str>) -> Result<(), String> {
    if !webhook_url.starts_with("https://discord.com/api/webhooks/")
        && !webhook_url.starts_with("https://discordapp.com/api/webhooks/")
    {
        return Err(
            "That doesn't look like a Discord webhook URL - it should start with \
             https://discord.com/api/webhooks/. Get one from a channel's Integrations settings."
                .into(),
        );
    }

    let bytes = std::fs::read(file_path).map_err(|e| format!("Could not read {file_path}: {e}"))?;
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("clip.mp4")
        .to_string();

    let part = reqwest::blocking::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("video/mp4")
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::blocking::multipart::Form::new().part("file", part);
    if let Some(msg) = message {
        if !msg.trim().is_empty() {
            form = form.text("content", msg.to_string());
        }
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(webhook_url)
        .multipart(form)
        .send()
        .map_err(|e| format!("Could not reach Discord: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        // A 413/400-with-file-size-wording almost always means the clip is
        // bigger than this server's current boost tier allows - worth
        // saying plainly rather than just dumping Discord's raw JSON error.
        if status.as_u16() == 413 || body.to_lowercase().contains("too large") {
            return Err(format!(
                "Discord rejected the upload as too large for this server's current boost \
                 tier (HTTP {status}). Try one of the Discord-sized export presets (20/50/100/500 MB)."
            ));
        }
        return Err(format!("Discord rejected the upload (HTTP {status}): {body}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_non_discord_url_before_touching_the_network() {
        let err = post_inner("https://example.com/not-a-webhook", "does-not-matter.mp4", None)
            .unwrap_err();
        assert!(err.contains("doesn't look like a Discord webhook URL"), "{err}");
    }

    #[test]
    fn rejects_a_plausible_but_wrong_discord_url() {
        // A real Discord URL, just not a webhook endpoint - should still be
        // caught by the prefix check rather than falling through to a
        // confusing network-level error.
        let err = post_inner("https://discord.com/channels/123/456", "x.mp4", None).unwrap_err();
        assert!(err.contains("doesn't look like a Discord webhook URL"), "{err}");
    }

    #[test]
    fn accepts_the_real_webhook_url_shape_and_fails_later_on_the_missing_file() {
        // Confirms the prefix check itself doesn't reject a genuine webhook
        // URL - the failure here should come from the (deliberately) missing
        // file, proving control passed the URL check.
        let err = post_inner(
            "https://discord.com/api/webhooks/123456789/abcDEF-token",
            "definitely-does-not-exist-on-disk.mp4",
            None,
        )
        .unwrap_err();
        assert!(err.contains("Could not read"), "{err}");
    }
}
