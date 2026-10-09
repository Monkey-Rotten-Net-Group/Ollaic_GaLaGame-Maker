//! Record and replay the command paths that do not use `ChatGateway`.

use std::future::Future;
use std::path::PathBuf;
use std::time::Instant;

use base64::Engine;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::ai::commands::GeneratedMedia;

use super::cassette::{self, Cassette, Interaction, InteractionKind, Request, Response};
use super::cli::GlobalArgs;

pub enum Exchange {
    Live,
    Record {
        root: PathBuf,
        name: String,
        api_key: String,
        cassette: Cassette,
    },
    Replay {
        root: PathBuf,
        name: String,
        api_key: String,
        cassette: Cassette,
    },
}

impl Exchange {
    pub fn new(
        global: &GlobalArgs,
        provider: String,
        model: String,
        api_key: String,
    ) -> Result<Self, String> {
        let root = super::cassette_root(global);
        match (&global.record, &global.replay) {
            (Some(name), _) => Ok(Self::Record {
                root,
                name: name.clone(),
                api_key,
                cassette: Cassette::new(provider, model),
            }),
            (None, Some(name)) => {
                let cassette = cassette::load(&root, name)?;
                cassette::verify(&cassette)?;
                Ok(Self::Replay {
                    root,
                    name: name.clone(),
                    api_key,
                    cassette,
                })
            }
            (None, None) => Ok(Self::Live),
        }
    }

    pub async fn call<T, F>(&mut self, label: &str, request: &Value, live: F) -> Result<T, String>
    where
        T: Serialize + DeserializeOwned,
        F: Future<Output = Result<T, String>>,
    {
        match self {
            Self::Live => live.await,
            Self::Record {
                api_key, cassette, ..
            } => {
                let started = Instant::now();
                let result = live.await;
                let response = serde_json::to_value(&result).map_err(|e| e.to_string())?;
                push(
                    cassette,
                    api_key,
                    label,
                    request,
                    InteractionKind::Chat,
                    serde_json::to_string(&redact_value(response, api_key))
                        .map_err(|e| e.to_string())?,
                    None,
                    started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                );
                result
            }
            Self::Replay {
                api_key, cassette, ..
            } => {
                let interaction = lookup(cassette, api_key, label, request, InteractionKind::Chat)?;
                let recorded: Result<T, String> =
                    serde_json::from_str(interaction.response.text.as_deref().ok_or_else(
                        || format!("cassette interaction #{} has no response", interaction.seq),
                    )?)
                    .map_err(|e| {
                        format!(
                            "cassette interaction #{} has invalid response: {e}",
                            interaction.seq
                        )
                    })?;
                recorded
            }
        }
    }

    pub async fn media<F>(
        &mut self,
        label: &str,
        request: &Value,
        live: F,
    ) -> Result<GeneratedMedia, String>
    where
        F: Future<Output = Result<GeneratedMedia, String>>,
    {
        match self {
            Self::Live => live.await,
            Self::Record {
                root,
                name,
                api_key,
                cassette,
            } => {
                let started = Instant::now();
                let result = live.await;
                let (metadata, blob) = match &result {
                    Ok(media) => {
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(&media.base64_data)
                            .map_err(|e| {
                                format!("provider returned media that is not valid base64: {e}")
                            })?;
                        let blob = cassette::save_blob(root, name, &bytes, &media.extension)?;
                        (Ok(media.extension.clone()), Some(blob))
                    }
                    Err(error) => (Err(error.clone()), None),
                };
                let text = serde_json::to_value(metadata).map_err(|e| e.to_string())?;
                push(
                    cassette,
                    api_key,
                    label,
                    request,
                    InteractionKind::Media,
                    serde_json::to_string(&redact_value(text, api_key))
                        .map_err(|e| e.to_string())?,
                    blob,
                    started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                );
                result
            }
            Self::Replay {
                root,
                name,
                api_key,
                cassette,
            } => {
                let interaction =
                    lookup(cassette, api_key, label, request, InteractionKind::Media)?;
                let extension: Result<String, String> = serde_json::from_str(
                    interaction.response.text.as_deref().ok_or_else(|| {
                        format!(
                            "cassette interaction #{} has no media metadata",
                            interaction.seq
                        )
                    })?,
                )
                .map_err(|e| {
                    format!(
                        "cassette interaction #{} has invalid media metadata: {e}",
                        interaction.seq
                    )
                })?;
                let extension = extension?;
                let blob = interaction.response.blob.as_deref().ok_or_else(|| {
                    format!(
                        "cassette interaction #{} has no media blob",
                        interaction.seq
                    )
                })?;
                let bytes = cassette::load_blob(root, name, blob)?;
                Ok(GeneratedMedia {
                    base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
                    extension,
                })
            }
        }
    }

    pub fn finish(self) -> Result<(), String> {
        if let Self::Record {
            root,
            name,
            cassette,
            ..
        } = self
        {
            cassette::verify(&cassette)?;
            cassette::save(&root, &name, &cassette)?;
        }
        Ok(())
    }
}

fn push(
    cassette: &mut Cassette,
    api_key: &str,
    label: &str,
    request: &Value,
    kind: InteractionKind,
    text: String,
    blob: Option<String>,
    elapsed_ms: u64,
) {
    let user = cassette::redact(&request.to_string(), api_key);
    cassette.interactions.push(Interaction {
        seq: cassette.interactions.len(),
        kind,
        request_hash: cassette::request_hash(label, &user),
        request: Request {
            system: label.to_string(),
            user,
        },
        response: Response {
            text: Some(text),
            model: None,
            prompt_tokens: None,
            completion_tokens: None,
            blob,
        },
        elapsed_ms,
    });
}

fn lookup<'a>(
    cassette: &'a Cassette,
    api_key: &str,
    label: &str,
    request: &Value,
    kind: InteractionKind,
) -> Result<&'a Interaction, String> {
    let user = cassette::redact(&request.to_string(), api_key);
    let interaction = cassette.find(label, &user).ok_or_else(|| {
        format!(
            "cassette has no {:?} interaction for request {}",
            kind,
            cassette::request_hash(label, &user)
        )
    })?;
    if interaction.kind != kind {
        return Err(format!(
            "cassette interaction #{} has the wrong kind",
            interaction.seq
        ));
    }
    Ok(interaction)
}

fn redact_value(value: Value, api_key: &str) -> Value {
    match value {
        Value::String(text) => Value::String(cassette::redact(&text, api_key)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|v| redact_value(v, api_key))
                .collect(),
        ),
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .map(|(k, v)| (k, redact_value(v, api_key)))
                .collect(),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::commands::{AiTurnResult, AiValidationResult};
    use serde_json::json;

    fn args(root: &std::path::Path, record: bool) -> GlobalArgs {
        GlobalArgs {
            profile: None,
            record: record.then(|| "exchange-test".into()),
            replay: (!record).then(|| "exchange-test".into()),
            cassette_dir: Some(root.display().to_string()),
            json: false,
        }
    }

    #[tokio::test]
    async fn chat_probe_and_media_replay_without_running_live_calls() {
        let root = std::env::temp_dir().join(format!(
            "ollaic-exchange-{}-{}",
            std::process::id(),
            cassette::now_ms()
        ));
        let prompt = json!({ "prompt": "api_key=sk-secret" });
        let validation_request = json!({ "provider": "custom" });
        let media_request = json!({ "prompt": "cover", "model": "image-model" });
        let mut recorder = Exchange::new(
            &args(&root, true),
            "custom".into(),
            "model".into(),
            "sk-secret".into(),
        )
        .unwrap();
        let answer: AiTurnResult = recorder
            .call("chat", &prompt, async {
                Ok(AiTurnResult {
                    text: Some("pong".into()),
                    tool_calls: Vec::new(),
                })
            })
            .await
            .unwrap();
        assert_eq!(answer.text.as_deref(), Some("pong"));
        let validation: Result<AiValidationResult, String> = recorder
            .call("probe", &validation_request, async {
                Err("connection refused".into())
            })
            .await;
        assert_eq!(validation.unwrap_err(), "connection refused");
        let media = recorder
            .media("media", &media_request, async {
                Ok(GeneratedMedia {
                    base64_data: base64::engine::general_purpose::STANDARD.encode([0, 1, 255]),
                    extension: "png".into(),
                })
            })
            .await
            .unwrap();
        recorder.finish().unwrap();

        let cassette_text =
            std::fs::read_to_string(root.join("exchange-test/cassette.json")).unwrap();
        assert!(!cassette_text.contains("sk-secret"));
        assert_eq!(media.extension, "png");
        let mut replay = Exchange::new(
            &args(&root, false),
            "custom".into(),
            "model".into(),
            String::new(),
        )
        .unwrap();
        let answer: AiTurnResult = replay
            .call("chat", &prompt, async {
                panic!("replay must not poll the live chat call")
            })
            .await
            .unwrap();
        assert_eq!(answer.text.as_deref(), Some("pong"));
        let error = replay
            .call::<AiValidationResult, _>("probe", &validation_request, async {
                panic!("replay must not poll the live probe call")
            })
            .await
            .unwrap_err();
        assert_eq!(error, "connection refused");
        let media = replay
            .media("media", &media_request, async {
                panic!("replay must not poll the live media call")
            })
            .await
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(media.base64_data)
                .unwrap(),
            [0, 1, 255]
        );
        let error = replay
            .call::<String, _>("chat", &json!({ "prompt": "changed" }), async {
                panic!("a replay miss must not poll the live call")
            })
            .await
            .unwrap_err();
        assert!(error.contains("no Chat interaction"), "{error}");
        replay.finish().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
