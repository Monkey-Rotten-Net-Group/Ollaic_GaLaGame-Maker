//! `ChatGateway` decorators for record and replay.
//!
//! Sitting on `ChatGateway` rather than on the HTTP client is deliberate: the
//! router's JSON repair turn (`agents::router::generate_structured_validated`)
//! goes through the same trait, so a bad-JSON-then-repair sequence is captured
//! and replayed with no extra code — and that is the path most worth pinning.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::Instant;

use crate::agents::router::ChatGateway;

use super::cassette::{
    self, Cassette, Interaction, InteractionKind, Request, Response,
};

type ModelCompletion = (String, String, Option<u32>, Option<u32>);
type CompleteFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<ModelCompletion>, String>> + Send + 'a>>;

/// Wraps a live gateway and appends every exchange to an in-memory cassette.
/// Call [`RecordingGateway::into_cassette`] when the run finishes to persist it.
pub struct RecordingGateway<G: ChatGateway> {
    inner: G,
    api_key: String,
    cassette: Mutex<Cassette>,
}

impl<G: ChatGateway> RecordingGateway<G> {
    pub fn new(inner: G, provider: String, model: String, api_key: String) -> Self {
        Self {
            inner,
            api_key,
            cassette: Mutex::new(Cassette::new(provider, model)),
        }
    }

    pub fn into_cassette(self) -> Cassette {
        self.cassette
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl<G: ChatGateway> ChatGateway for RecordingGateway<G> {
    fn complete<'a>(&'a self, system: &'a str, user: &'a str) -> CompleteFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let result = self.inner.complete(system, user).await;
            let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;

            // Only a completed turn is worth recording. A `None` (no model
            // configured) or an error carries no provider output to replay, so
            // recording it would produce a cassette that cannot drive an agent.
            if let Ok(Some((text, model, prompt_tokens, completion_tokens))) = &result {
                let mut cassette = self
                    .cassette
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let seq = cassette.interactions.len();
                let system = cassette::redact(system, &self.api_key);
                let user = cassette::redact(user, &self.api_key);
                cassette.interactions.push(Interaction {
                    seq,
                    kind: InteractionKind::Chat,
                    request_hash: cassette::request_hash(&system, &user),
                    request: Request { system, user },
                    response: Response {
                        text: Some(cassette::redact(text, &self.api_key)),
                        model: Some(model.clone()),
                        prompt_tokens: *prompt_tokens,
                        completion_tokens: *completion_tokens,
                        blob: None,
                    },
                    elapsed_ms,
                });
            }

            result
        })
    }
}

/// Serves recorded exchanges. Holds no network client, so a replay run cannot
/// reach a provider even if the cassette is incomplete.
pub struct ReplayGateway {
    cassette: Cassette,
    name: String,
}

impl ReplayGateway {
    pub fn new(cassette: Cassette, name: impl Into<String>) -> Self {
        Self {
            cassette,
            name: name.into(),
        }
    }
}

impl ChatGateway for ReplayGateway {
    fn complete<'a>(&'a self, system: &'a str, user: &'a str) -> CompleteFuture<'a> {
        Box::pin(async move {
            match self.cassette.find(system, user) {
                Some(interaction) => Ok(Some((
                    interaction.response.text.clone().unwrap_or_default(),
                    interaction
                        .response
                        .model
                        .clone()
                        .unwrap_or_else(|| self.cassette.model.clone()),
                    interaction.response.prompt_tokens,
                    interaction.response.completion_tokens,
                ))),
                None => Err(miss_report(&self.cassette, &self.name, system, user)),
            }
        })
    }
}

/// Explain a replay miss in terms of *what changed*, not just "not found".
/// The nearest recorded prompt is shown as a line diff, because the usual cause
/// is an ordinary prompt edit and the useful question is which line moved.
fn miss_report(cassette: &Cassette, name: &str, system: &str, user: &str) -> String {
    let wanted = cassette::request_hash(system, user);
    let mut report = format!(
        "cassette `{name}` has nothing recorded for this prompt ({wanted}).\n\
         It was recorded for different wording, or this path never ran.\n\
         Re-record with --record {name}, or restore the earlier prompt."
    );

    if let Some(nearest) = nearest_interaction(cassette, system, user) {
        report.push_str(&format!(
            "\n\nNearest recorded interaction is #{}:\n",
            nearest.seq
        ));
        if nearest.request.system != system {
            report.push_str("\n--- system prompt ---\n");
            report.push_str(&line_diff(&nearest.request.system, system));
        }
        if nearest.request.user != user {
            report.push_str("\n--- user prompt ---\n");
            report.push_str(&line_diff(&nearest.request.user, user));
        }
    }
    report
}

/// The recorded interaction sharing the most leading lines with the live
/// request. Good enough to point at the edit without pulling in a diff crate.
fn nearest_interaction<'a>(
    cassette: &'a Cassette,
    system: &str,
    user: &str,
) -> Option<&'a Interaction> {
    cassette.interactions.iter().max_by_key(|interaction| {
        common_prefix_lines(&interaction.request.system, system)
            + common_prefix_lines(&interaction.request.user, user)
    })
}

fn common_prefix_lines(left: &str, right: &str) -> usize {
    left.lines()
        .zip(right.lines())
        .take_while(|(a, b)| a == b)
        .count()
}

/// Minimal line diff: every differing line, marked. Both sides are truncated so
/// a 40KB context dump cannot bury the one line that actually moved.
fn line_diff(recorded: &str, live: &str) -> String {
    const MAX_LINES: usize = 12;
    const MAX_LINE_CHARS: usize = 200;

    let recorded_lines: Vec<&str> = recorded.lines().collect();
    let live_lines: Vec<&str> = live.lines().collect();
    let mut out = String::new();
    let mut shown = 0;

    for index in 0..recorded_lines.len().max(live_lines.len()) {
        let before = recorded_lines.get(index).copied();
        let after = live_lines.get(index).copied();
        if before == after {
            continue;
        }
        if shown == MAX_LINES {
            out.push_str("… (further differences omitted)\n");
            break;
        }
        if let Some(before) = before {
            out.push_str(&format!("-{:>4} {}\n", index + 1, truncate(before, MAX_LINE_CHARS)));
        }
        if let Some(after) = after {
            out.push_str(&format!("+{:>4} {}\n", index + 1, truncate(after, MAX_LINE_CHARS)));
        }
        shown += 1;
    }

    if out.is_empty() {
        out.push_str("(identical line-by-line; difference is in trailing whitespace)\n");
    }
    out
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let kept: String = value.chars().take(max_chars).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_harness::cassette::Cassette;

    struct StubGateway {
        answer: Option<ModelCompletion>,
    }

    impl ChatGateway for StubGateway {
        fn complete<'a>(&'a self, _system: &'a str, _user: &'a str) -> CompleteFuture<'a> {
            let answer = self.answer.clone();
            Box::pin(async move { Ok(answer) })
        }
    }

    struct FailingGateway;

    impl ChatGateway for FailingGateway {
        fn complete<'a>(&'a self, _system: &'a str, _user: &'a str) -> CompleteFuture<'a> {
            Box::pin(async { Err("provider exploded".to_string()) })
        }
    }

    #[tokio::test]
    async fn recording_passes_through_and_captures_the_exchange() {
        let recorder = RecordingGateway::new(
            StubGateway {
                answer: Some((
                    r#"{"ok":true}"#.into(),
                    "model-a".into(),
                    Some(11),
                    Some(22),
                )),
            },
            "custom".into(),
            "model-a".into(),
            String::new(),
        );

        let result = recorder.complete("sys", "usr").await.unwrap().unwrap();
        assert_eq!(result.0, r#"{"ok":true}"#);

        let cassette = recorder.into_cassette();
        assert_eq!(cassette.interactions.len(), 1);
        let recorded = &cassette.interactions[0];
        assert_eq!(recorded.request.user, "usr");
        assert_eq!(recorded.response.prompt_tokens, Some(11));
        assert!(cassette::verify(&cassette).is_ok());
    }

    #[tokio::test]
    async fn recording_captures_each_turn_of_a_repair_sequence() {
        // Two distinct prompts (original + repair) must land as two lookups.
        let recorder = RecordingGateway::new(
            StubGateway {
                answer: Some(("{}".into(), "model-a".into(), None, None)),
            },
            "custom".into(),
            "model-a".into(),
            String::new(),
        );
        recorder.complete("sys", "first").await.unwrap();
        recorder.complete("repair-sys", "second").await.unwrap();

        let cassette = recorder.into_cassette();
        assert_eq!(cassette.interactions.len(), 2);
        assert!(cassette.find("sys", "first").is_some());
        assert!(cassette.find("repair-sys", "second").is_some());
        assert!(cassette::verify(&cassette).is_ok());
    }

    #[tokio::test]
    async fn a_provider_error_is_not_recorded() {
        let recorder = RecordingGateway::new(
            FailingGateway,
            "custom".into(),
            "model-a".into(),
            String::new(),
        );
        assert!(recorder.complete("sys", "usr").await.is_err());
        assert!(recorder.into_cassette().interactions.is_empty());
    }

    #[tokio::test]
    async fn an_unconfigured_model_is_not_recorded() {
        let recorder = RecordingGateway::new(
            StubGateway { answer: None },
            "custom".into(),
            "model-a".into(),
            String::new(),
        );
        assert!(recorder.complete("sys", "usr").await.unwrap().is_none());
        assert!(recorder.into_cassette().interactions.is_empty());
    }

    #[tokio::test]
    async fn recording_redacts_the_api_key_from_the_prompt() {
        let recorder = RecordingGateway::new(
            StubGateway {
                answer: Some(("fine".into(), "model-a".into(), None, None)),
            },
            "custom".into(),
            "model-a".into(),
            "sk-live-key".into(),
        );
        recorder.complete("sys", "use sk-live-key please").await.unwrap();

        let cassette = recorder.into_cassette();
        let recorded = &cassette.interactions[0];
        assert!(!recorded.request.user.contains("sk-live-key"));
        // The hash must cover the redacted text, or verify() would reject it.
        assert!(cassette::verify(&cassette).is_ok());
    }

    #[tokio::test]
    async fn replay_serves_a_recorded_exchange() {
        let recorder = RecordingGateway::new(
            StubGateway {
                answer: Some(("recorded answer".into(), "model-a".into(), Some(5), Some(7))),
            },
            "custom".into(),
            "model-a".into(),
            String::new(),
        );
        recorder.complete("sys", "usr").await.unwrap();
        let replay = ReplayGateway::new(recorder.into_cassette(), "demo");

        let (text, model, prompt, completion) =
            replay.complete("sys", "usr").await.unwrap().unwrap();
        assert_eq!(text, "recorded answer");
        assert_eq!(model, "model-a");
        assert_eq!((prompt, completion), (Some(5), Some(7)));
    }

    #[tokio::test]
    async fn replay_miss_names_the_cassette_and_shows_the_changed_line() {
        let mut cassette = Cassette::new("custom".into(), "model-a".into());
        cassette.interactions.push(Interaction {
            seq: 0,
            kind: InteractionKind::Chat,
            request_hash: cassette::request_hash("sys", "line one\nline two"),
            request: Request {
                system: "sys".into(),
                user: "line one\nline two".into(),
            },
            response: Response {
                text: Some("answer".into()),
                model: None,
                prompt_tokens: None,
                completion_tokens: None,
                blob: None,
            },
            elapsed_ms: 1,
        });
        let replay = ReplayGateway::new(cassette, "outline-01");

        let error = replay
            .complete("sys", "line one\nline TWO")
            .await
            .expect_err("a drifted prompt must fail loudly");

        assert!(error.contains("outline-01"), "{error}");
        assert!(error.contains("--- user prompt ---"), "{error}");
        assert!(error.contains("-   2 line two"), "{error}");
        assert!(error.contains("+   2 line TWO"), "{error}");
    }

    #[tokio::test]
    async fn replay_never_reaches_a_provider_on_an_empty_cassette() {
        let replay = ReplayGateway::new(Cassette::new("custom".into(), "m".into()), "empty");
        assert!(replay.complete("sys", "usr").await.is_err());
    }
}
