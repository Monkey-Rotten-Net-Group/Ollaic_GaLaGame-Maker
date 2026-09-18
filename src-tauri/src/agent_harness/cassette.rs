//! Cassette storage: record real provider exchanges, replay them offline.
//!
//! A cassette is a directory holding `cassette.json` plus a `blobs/` folder for
//! binary media. Interactions are looked up by the text of the request, not by
//! arrival order. That matters most for the chain, where each step's prompt is
//! built from the previous step's output: matching on content means a cassette
//! can only answer the prompt it was recorded for, so a stale one is reported
//! instead of quietly producing a StoryPlan no real run could reach.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ai::commands::{redact_common_secrets, redact_known_secret};

pub const CASSETTE_VERSION: u32 = 1;
const CASSETTE_FILE: &str = "cassette.json";
const BLOB_DIR: &str = "blobs";

/// Separator between the two halves of a chat request when hashing. A control
/// character keeps a prompt ending in the other's prefix from colliding.
const HASH_SEPARATOR: u8 = 0x1f;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cassette {
    pub version: u32,
    pub recorded_at_ms: u128,
    /// Provenance only. Credentials are never stored.
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub interactions: Vec<Interaction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    pub seq: usize,
    pub kind: InteractionKind,
    pub request_hash: String,
    pub request: Request,
    pub response: Response,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InteractionKind {
    /// One `ChatGateway::complete` call — including a router repair turn.
    Chat,
    /// One media generation call, whose bytes live in `blobs/`.
    Media,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub system: String,
    pub user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u32>,
    /// `blobs/<sha256>.<ext>` for media interactions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

/// Hash of the exchange's inputs. Replay looks an interaction up by this.
pub fn request_hash(system: &str, user: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(system.as_bytes());
    hasher.update([HASH_SEPARATOR]);
    hasher.update(user.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Default cassette root: `<src-tauri>/fixtures/agent-harness`.
pub fn default_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("agent-harness")
}

pub fn cassette_dir(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

pub fn load(root: &Path, name: &str) -> Result<Cassette, String> {
    let path = cassette_dir(root, name).join(CASSETTE_FILE);
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read cassette {}: {e}", path.display()))?;
    let cassette: Cassette = serde_json::from_str(&text)
        .map_err(|e| format!("cassette {} is not valid JSON: {e}", path.display()))?;
    if cassette.version != CASSETTE_VERSION {
        return Err(format!(
            "cassette {} has version {}, this build understands {CASSETTE_VERSION}",
            path.display(),
            cassette.version
        ));
    }
    Ok(cassette)
}

pub fn save(root: &Path, name: &str, cassette: &Cassette) -> Result<PathBuf, String> {
    let dir = cassette_dir(root, name);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create cassette dir {}: {e}", dir.display()))?;
    let path = dir.join(CASSETTE_FILE);
    let json = serde_json::to_string_pretty(cassette).map_err(|e| e.to_string())?;
    fs::write(&path, json)
        .map_err(|e| format!("failed to write cassette {}: {e}", path.display()))?;
    Ok(path)
}

/// Write media bytes beside the cassette and return the relative `blobs/...` ref.
pub fn save_blob(root: &Path, name: &str, bytes: &[u8], extension: &str) -> Result<String, String> {
    let dir = cassette_dir(root, name).join(BLOB_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create blob dir {}: {e}", dir.display()))?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    let file_name = format!("{digest}.{extension}");
    let path = dir.join(&file_name);
    if !path.exists() {
        fs::write(&path, bytes)
            .map_err(|e| format!("failed to write blob {}: {e}", path.display()))?;
    }
    Ok(format!("{BLOB_DIR}/{file_name}"))
}

pub fn load_blob(root: &Path, name: &str, blob_ref: &str) -> Result<Vec<u8>, String> {
    let path = cassette_dir(root, name).join(blob_ref);
    fs::read(&path).map_err(|e| format!("failed to read blob {}: {e}", path.display()))
}

pub fn list(root: &Path) -> Result<Vec<String>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    let entries = fs::read_dir(root)
        .map_err(|e| format!("failed to list cassettes in {}: {e}", root.display()))?;
    for entry in entries.flatten() {
        if entry.path().join(CASSETTE_FILE).is_file() {
            names.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    names.sort();
    Ok(names)
}

/// Reject a cassette in which one prompt has two different recorded answers:
/// replay would pick whichever came first, so the fixture would not describe a
/// reproducible run. This is a recording defect, not a tampering check.
pub fn verify(cassette: &Cassette) -> Result<(), String> {
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    for interaction in &cassette.interactions {
        if let Some(first) = seen.insert(&interaction.request_hash, interaction.seq) {
            return Err(format!(
                "interactions {} and {} share request hash {} — the same prompt has two recorded answers",
                first, interaction.seq, interaction.request_hash
            ));
        }
    }
    Ok(())
}

/// Strip credentials from anything about to be persisted. `api_key` is the
/// configured key, redacted by exact match; the marker sweep catches keys that
/// arrive inline in a prompt or an error string.
pub fn redact(value: &str, api_key: &str) -> String {
    redact_common_secrets(&redact_known_secret(value, api_key))
}

impl Cassette {
    pub fn new(provider: String, model: String) -> Self {
        Self {
            version: CASSETTE_VERSION,
            recorded_at_ms: now_ms(),
            provider,
            model,
            interactions: Vec::new(),
        }
    }

    /// Look an exchange up by its inputs. `None` means the prompt drifted (or
    /// this path was never recorded).
    pub fn find(&self, system: &str, user: &str) -> Option<&Interaction> {
        let hash = request_hash(system, user);
        self.interactions
            .iter()
            .find(|interaction| interaction.request_hash == hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_separates_system_from_user() {
        // Without the separator these two would hash identically.
        assert_ne!(request_hash("ab", "c"), request_hash("a", "bc"));
    }

    #[test]
    fn find_matches_on_content_not_order() {
        let mut cassette = Cassette::new("custom".into(), "m".into());
        for (seq, user) in ["first", "second"].iter().enumerate() {
            cassette.interactions.push(Interaction {
                seq,
                kind: InteractionKind::Chat,
                request_hash: request_hash("sys", user),
                request: Request {
                    system: "sys".into(),
                    user: (*user).into(),
                },
                response: Response {
                    text: Some(format!("answer to {user}")),
                    model: Some("m".into()),
                    prompt_tokens: None,
                    completion_tokens: None,
                    blob: None,
                },
                elapsed_ms: 1,
            });
        }

        let hit = cassette.find("sys", "second").expect("second is recorded");
        assert_eq!(hit.response.text.as_deref(), Some("answer to second"));
        assert!(cassette.find("sys", "third").is_none());
    }

    #[test]
    fn verify_rejects_two_answers_for_one_prompt() {
        let mut cassette = Cassette::new("custom".into(), "m".into());
        for seq in 0..2 {
            cassette.interactions.push(Interaction {
                seq,
                kind: InteractionKind::Chat,
                request_hash: request_hash("sys", "same"),
                request: Request {
                    system: "sys".into(),
                    user: "same".into(),
                },
                response: Response {
                    text: Some(format!("answer {seq}")),
                    model: None,
                    prompt_tokens: None,
                    completion_tokens: None,
                    blob: None,
                },
                elapsed_ms: 1,
            });
        }

        let error = verify(&cassette).expect_err("duplicate hashes must be rejected");
        assert!(error.contains("share request hash"), "{error}");
    }


    #[test]
    fn redact_removes_the_configured_key_and_inline_credentials() {
        let redacted = redact("call failed for sk-secret-123: authorization=Bearer sk-other", "sk-secret-123");
        assert!(!redacted.contains("sk-secret-123"), "{redacted}");
        assert!(!redacted.contains("sk-other"), "{redacted}");
    }

    #[test]
    fn redact_tolerates_an_empty_key() {
        assert_eq!(redact("plain text", ""), "plain text");
    }
}
