//! Posts a finished export straight to a Discord channel via an incoming
//! webhook - "paste a URL into settings, the export shows up," no bot setup,
//! no hosting, no approval step. The channel-side host still enforces its
//! own upload cap (tied to the destination SERVER's boost tier, not the
//! uploading account's Nitro status, and not something this app can query
//! in advance) - rather than guess a number and enforce it client-side,
//! this just attempts the upload and surfaces Discord's own rejection
//! message, pointing at the app's own Discord-sized export presets.
//!
//! `file_path` is optional so the same webhook can also carry a text-only
//! message - the end-of-batch digest (store.ts's watch-folder session
//! summary) needs this when every clip in a run errored or needs review,
//! i.e. there's nothing to attach.

use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

use crate::jobs::{emit_done, emit_error, JobHandle};

pub fn post(
    app: AppHandle,
    job_id: String,
    handle: Arc<JobHandle>,
    webhook_url: String,
    file_path: Option<String>,
    message: Option<String>,
) {
    let stage = "posting";
    let result = post_inner(&webhook_url, file_path.as_deref(), message.as_deref());
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

fn post_inner(
    webhook_url: &str,
    file_path: Option<&str>,
    message: Option<&str>,
) -> Result<(), String> {
    if !webhook_url.starts_with("https://discord.com/api/webhooks/")
        && !webhook_url.starts_with("https://discordapp.com/api/webhooks/")
    {
        return Err(
            "That doesn't look like a Discord webhook URL - it should start with \
             https://discord.com/api/webhooks/. Get one from a channel's Integrations settings."
                .into(),
        );
    }
    let message = message.filter(|m| !m.trim().is_empty());
    if file_path.is_none() && message.is_none() {
        return Err("Nothing to post - no file and no message.".into());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = if let Some(file_path) = file_path {
        let bytes =
            std::fs::read(file_path).map_err(|e| format!("Could not read {file_path}: {e}"))?;
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
            form = form.text("content", msg.to_string());
        }
        client
            .post(webhook_url)
            .multipart(form)
            .send()
            .map_err(|e| format!("Could not reach Discord: {e}"))?
    } else {
        // Text-only digest: Discord's webhook endpoint takes plain JSON with
        // just a "content" field when there's no file to attach.
        let body = serde_json::json!({ "content": message.unwrap_or_default() });
        client
            .post(webhook_url)
            .json(&body)
            .send()
            .map_err(|e| format!("Could not reach Discord: {e}"))?
    };

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
        let err = post_inner(
            "https://example.com/not-a-webhook",
            Some("does-not-matter.mp4"),
            None,
        )
        .unwrap_err();
        assert!(err.contains("doesn't look like a Discord webhook URL"), "{err}");
    }

    #[test]
    fn rejects_a_plausible_but_wrong_discord_url() {
        // A real Discord URL, just not a webhook endpoint - should still be
        // caught by the prefix check rather than falling through to a
        // confusing network-level error.
        let err = post_inner("https://discord.com/channels/123/456", Some("x.mp4"), None)
            .unwrap_err();
        assert!(err.contains("doesn't look like a Discord webhook URL"), "{err}");
    }

    #[test]
    fn accepts_the_real_webhook_url_shape_and_fails_later_on_the_missing_file() {
        // Confirms the prefix check itself doesn't reject a genuine webhook
        // URL - the failure here should come from the (deliberately) missing
        // file, proving control passed the URL check.
        let err = post_inner(
            "https://discord.com/api/webhooks/123456789/abcDEF-token",
            Some("definitely-does-not-exist-on-disk.mp4"),
            None,
        )
        .unwrap_err();
        assert!(err.contains("Could not read"), "{err}");
    }

    #[test]
    fn rejects_neither_file_nor_message() {
        let err = post_inner(
            "https://discord.com/api/webhooks/123456789/abcDEF-token",
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("Nothing to post"), "{err}");
    }

    #[test]
    fn a_blank_message_with_no_file_is_treated_as_nothing_to_post() {
        let err = post_inner(
            "https://discord.com/api/webhooks/123456789/abcDEF-token",
            None,
            Some("   "),
        )
        .unwrap_err();
        assert!(err.contains("Nothing to post"), "{err}");
    }
}
