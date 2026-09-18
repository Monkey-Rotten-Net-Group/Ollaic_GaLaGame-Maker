//! Terminal output. Every command renders through here so `--json` is a real
//! contract (one JSON value on stdout, nothing else) rather than a per-command
//! afterthought.

use serde::Serialize;
use serde_json::{json, Value};

use crate::ai::commands::{AiLogOutput, AiTurnResult, AiValidationResult};
use crate::ai::config::{AiConfig, AiProviderConfig};
use crate::ai::provider_capability::ProviderCapability;

use super::chain::{self, ChainReport};

pub struct Renderer {
    json: bool,
}

impl Renderer {
    pub fn new(json: bool) -> Self {
        Self { json }
    }

    pub fn is_json(&self) -> bool {
        self.json
    }

    /// Emit the machine-readable form; returns false when the caller should
    /// print its own human report instead.
    fn emit(&self, value: &impl Serialize) -> bool {
        if !self.json {
            return false;
        }
        match serde_json::to_string_pretty(value) {
            Ok(text) => println!("{text}"),
            Err(error) => eprintln!("failed to serialize output: {error}"),
        }
        true
    }

    pub fn config(
        &self,
        chat: &AiConfig,
        chat_endpoint: &str,
        image: (&AiProviderConfig, String),
        tts: (&AiProviderConfig, String),
        music: (&AiProviderConfig, String),
        config_dir: &str,
        log_path: &str,
        trace_path: &str,
    ) {
        let payload = json!({
            "configDir": config_dir,
            "logPath": log_path,
            "agentTracePath": trace_path,
            "chat": provider_json(&chat.provider, &chat.model, &chat.base_url, &chat.api_key, chat_endpoint),
            "image": media_json(image.0, &image.1),
            "tts": media_json(tts.0, &tts.1),
            "music": media_json(music.0, &music.1),
        });
        if self.emit(&payload) {
            return;
        }

        println!("config dir   {config_dir}");
        println!("log          {log_path}");
        println!("agent trace  {trace_path}");
        println!();
        print_provider_row("chat ", &chat.provider, &chat.model, &chat.api_key, chat_endpoint);
        print_provider_row("image", &image.0.provider, &image.0.model, &image.0.api_key, &image.1);
        print_provider_row("tts  ", &tts.0.provider, &tts.0.model, &tts.0.api_key, &tts.1);
        print_provider_row("music", &music.0.provider, &music.0.model, &music.0.api_key, &music.1);
    }

    pub fn probe(
        &self,
        validation: Option<&AiValidationResult>,
        capability: &ProviderCapability,
        round_trip: Option<&Result<AiTurnResult, String>>,
    ) {
        let payload = json!({
            "validation": validation.map(|v| json!({
                "ok": v.ok,
                "provider": v.provider,
                "model": v.model,
                "endpoint": v.endpoint,
                "message": v.message,
            })),
            "capability": capability,
            "roundTrip": round_trip.map(|result| match result {
                Ok(turn) => json!({
                    "ok": true,
                    "text": turn.text,
                    "toolCalls": turn.tool_calls.iter().map(|c| &c.name).collect::<Vec<_>>(),
                }),
                Err(message) => json!({ "ok": false, "message": message }),
            }),
        });
        if self.emit(&payload) {
            return;
        }

        if let Some(validation) = validation {
            println!(
                "{} connect     {} {} @ {}",
                mark(validation.ok),
                validation.provider,
                validation.model,
                short(&validation.endpoint)
            );
            if !validation.message.trim().is_empty() {
                println!("           {}", validation.message);
            }
        }
        println!("{} chat tools", mark(capability.chat_tools));
        println!("{} json mode", mark(capability.json_mode));
        println!("{} stream cancel", mark(capability.streaming_cancellation));
        println!("{} media url output", mark(capability.media_url_output));
        println!(
            "  deadlines   chat {}ms / flow step {}ms / media fetch {}ms",
            capability.chat_deadline_ms,
            capability.flow_step_deadline_ms,
            capability.media_fetch_deadline_ms
        );

        match round_trip {
            Some(Ok(turn)) => {
                println!("{} live round-trip", mark(true));
                if !turn.tool_calls.is_empty() {
                    let names: Vec<&str> =
                        turn.tool_calls.iter().map(|c| c.name.as_str()).collect();
                    println!("           tool calls: {}", names.join(", "));
                }
                if let Some(text) = &turn.text {
                    println!("           {}", first_line(text));
                }
            }
            Some(Err(message)) => {
                println!("{} live round-trip", mark(false));
                println!("           {message}");
            }
            None => println!("- live round-trip skipped (--offline)"),
        }
    }

    pub fn turn(&self, result: &AiTurnResult) {
        if self.emit(result) {
            return;
        }
        if let Some(text) = &result.text {
            println!("{text}");
        }
        for call in &result.tool_calls {
            println!(
                "→ {}({})",
                call.name,
                serde_json::to_string(&call.arguments).unwrap_or_default()
            );
        }
        if result.text.is_none() && result.tool_calls.is_empty() {
            println!("(the model returned neither text nor a tool call)");
        }
    }

    /// One agent run. `payload` is the serialized `AgentOutput`.
    pub fn agent(&self, kind: &str, payload: &Value, elapsed_ms: u64) {
        if self.emit(payload) {
            return;
        }
        println!("{kind} completed in {elapsed_ms}ms");
        if let Some(model) = payload.get("model").and_then(Value::as_str) {
            let prompt = payload.get("promptTokens").and_then(Value::as_u64);
            let completion = payload.get("completionTokens").and_then(Value::as_u64);
            match (prompt, completion) {
                (Some(p), Some(c)) => println!("model {model}  tokens {p} in / {c} out"),
                _ => println!("model {model}"),
            }
        }
        if let Some(downgrade) = payload.get("downgrade").and_then(Value::as_str) {
            println!("downgrade: {downgrade}");
        }
        for warning in payload
            .get("warnings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            println!("warning: {warning}");
        }
        println!();
        println!(
            "{}",
            serde_json::to_string_pretty(payload).unwrap_or_default()
        );
    }

    /// The full-chain table. Reads top-to-bottom as the Flow's own step order,
    /// so a failure shows both what broke and how far the chain got.
    pub fn chain(&self, report: &ChainReport) {
        let payload = json!({
            "ok": !report.failed(),
            "steps": report.steps.iter().map(|step| json!({
                "id": step.id,
                "kind": step.kind,
                "executor": step.executor,
                "elapsedMs": step.elapsed_ms,
                "model": step.model,
                "promptTokens": step.prompt_tokens,
                "completionTokens": step.completion_tokens,
                "interactions": step.interactions,
                "warnings": step.warnings,
                "downgrade": step.downgrade,
                "ok": step.outcome.is_ok(),
                "summary": step.outcome.as_ref().ok(),
                "error": step.outcome.as_ref().err(),
            })).collect::<Vec<_>>(),
            "plan": report.plan,
        });
        if self.emit(&payload) {
            return;
        }

        let mut prompt_total = 0u64;
        let mut completion_total = 0u64;
        let mut elapsed_total = 0u64;

        println!(
            "{:<11} {:<13} {:>7}  {:>4}  {}",
            "STEP", "EXECUTOR", "TIME", "CALL", "RESULT"
        );
        for step in &report.steps {
            prompt_total += step.prompt_tokens.unwrap_or(0) as u64;
            completion_total += step.completion_tokens.unwrap_or(0) as u64;
            elapsed_total += step.elapsed_ms;

            let detail = match &step.outcome {
                Ok(summary) => summary.clone(),
                Err(error) => first_line(error),
            };
            println!(
                "{} {:<9} {:<13} {:>6}s  {:>4}  {}",
                mark(step.outcome.is_ok()),
                step.id,
                step.executor,
                format_args!("{:.1}", step.elapsed_ms as f64 / 1000.0),
                step.interactions,
                detail
            );
            // A repair turn is the single most useful thing to notice here:
            // the step passed, but only after the model was corrected once.
            if step.interactions > 1 {
                println!("             ↳ {} 轮（含 JSON 修复）", step.interactions);
            }
            for warning in &step.warnings {
                println!("             ⚠ {warning}");
            }
            if let Some(downgrade) = &step.downgrade {
                println!("             ↓ downgrade: {downgrade}");
            }
            if let Err(error) = &step.outcome {
                for line in error.lines().skip(1).take(6) {
                    println!("               {line}");
                }
            }
        }

        let total = chain::chain_steps().len();
        let passed = report.steps.iter().filter(|s| s.outcome.is_ok()).count();
        println!();
        println!(
            "{passed}/{total} 步通过 · {:.1}s · tokens {prompt_total} in / {completion_total} out",
            elapsed_total as f64 / 1000.0
        );
        if passed < total && !report.failed() {
            println!("（其余步骤未运行：--stop-after）");
        }
    }

    pub fn media(&self, path: &str, bytes: usize, elapsed_ms: u64) {
        let payload = json!({ "path": path, "bytes": bytes, "elapsedMs": elapsed_ms });
        if self.emit(&payload) {
            return;
        }
        println!("wrote {path} ({} KiB) in {elapsed_ms}ms", bytes / 1024);
    }

    pub fn logs(&self, entries: &[AiLogOutput]) {
        if self.emit(&entries) {
            return;
        }
        if entries.is_empty() {
            println!("(no log entries)");
            return;
        }
        for entry in entries {
            println!(
                "{} {:<14} {:<10} {:<24} {}",
                mark(entry.success),
                entry.action,
                entry.provider,
                entry.model,
                first_line(&entry.message)
            );
        }
    }

    pub fn raw_lines(&self, lines: &[String]) {
        if self.emit(&lines) {
            return;
        }
        for line in lines {
            println!("{line}");
        }
    }

    pub fn cassette_list(&self, names: &[String], root: &str) {
        if self.emit(&json!({ "root": root, "cassettes": names })) {
            return;
        }
        if names.is_empty() {
            println!("(no cassettes under {root})");
            return;
        }
        for name in names {
            println!("{name}");
        }
    }

    pub fn note(&self, message: &str) {
        if self.json {
            return;
        }
        println!("{message}");
    }
}

fn provider_json(
    provider: &str,
    model: &str,
    base_url: &str,
    api_key: &str,
    endpoint: &str,
) -> Value {
    json!({
        "provider": provider,
        "model": model,
        "baseUrl": base_url,
        "apiKey": key_state(api_key),
        "endpoint": endpoint,
    })
}

fn media_json(config: &AiProviderConfig, endpoint: &str) -> Value {
    provider_json(
        &config.provider,
        &config.model,
        &config.base_url,
        &config.api_key,
        endpoint,
    )
}

fn print_provider_row(label: &str, provider: &str, model: &str, api_key: &str, endpoint: &str) {
    println!(
        "{label}  {:<12} {:<24} key {:<9} {}",
        blank_as_dash(provider),
        blank_as_dash(model),
        key_state(api_key),
        short(endpoint)
    );
}

/// Never print the key itself — only whether one is present and how long it is,
/// which is enough to tell "empty" from "pasted the wrong thing".
fn key_state(api_key: &str) -> String {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        "unset".to_string()
    } else {
        format!("set({})", trimmed.chars().count())
    }
}

fn blank_as_dash(value: &str) -> &str {
    if value.trim().is_empty() {
        "-"
    } else {
        value
    }
}

fn short(endpoint: &str) -> &str {
    if endpoint.trim().is_empty() {
        "(provider default)"
    } else {
        endpoint
    }
}

fn mark(ok: bool) -> &'static str {
    if ok {
        "✓"
    } else {
        "✗"
    }
}

fn first_line(value: &str) -> String {
    let line = value.lines().next().unwrap_or("").trim();
    if line.chars().count() <= 120 {
        return line.to_string();
    }
    let kept: String = line.chars().take(120).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_state_never_leaks_the_key() {
        let state = key_state("sk-supersecret");
        assert!(!state.contains("sk-"), "{state}");
        assert_eq!(state, "set(14)");
        assert_eq!(key_state("   "), "unset");
    }

    #[test]
    fn provider_json_reports_key_presence_not_value() {
        let value = provider_json("openai", "gpt-4o", "", "sk-abc", "https://api.openai.com/v1");
        assert_eq!(value["apiKey"], "set(6)");
        assert!(!value.to_string().contains("sk-abc"));
    }

    #[test]
    fn first_line_truncates_a_wall_of_text() {
        let long = "x".repeat(500);
        let shown = first_line(&long);
        assert!(shown.chars().count() <= 121, "{}", shown.chars().count());
        assert!(shown.ends_with('…'));
    }

    #[test]
    fn first_line_stops_at_the_newline() {
        assert_eq!(first_line("head\ntail"), "head");
    }
}
