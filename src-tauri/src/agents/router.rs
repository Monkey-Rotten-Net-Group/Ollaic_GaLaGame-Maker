use serde::de::DeserializeOwned;
use std::fmt::Write as _;
use std::future::Future;
use std::pin::Pin;

use super::AgentError;

type ModelCompletion = (String, String, Option<u32>, Option<u32>);

pub trait ChatGateway: Send + Sync {
    fn complete<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<ModelCompletion>, String>> + Send + 'a>>;
}

pub struct ConfiguredChatGateway;

impl ChatGateway for ConfiguredChatGateway {
    fn complete<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<ModelCompletion>, String>> + Send + 'a>> {
        Box::pin(crate::ai::commands::complete_agent_text(system, user))
    }
}

#[cfg(test)]
pub struct NoChatGateway;

#[cfg(test)]
impl ChatGateway for NoChatGateway {
    fn complete<'a>(
        &'a self,
        _system: &'a str,
        _user: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<ModelCompletion>, String>> + Send + 'a>> {
        Box::pin(async { Ok(None) })
    }
}

pub struct Routed<T> {
    pub value: T,
    pub model: String,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
}

pub async fn generate_structured_validated<T, V>(
    gateway: &dyn ChatGateway,
    role: &str,
    task: &str,
    context: &serde_json::Value,
    allow_local_fallback: bool,
    validate: V,
) -> Result<Option<Routed<T>>, AgentError>
where
    T: DeserializeOwned,
    V: Fn(&mut T) -> Result<(), AgentError>,
{
    let system = format!(
        "你是 Ollaic 的 {role} Agent。{task}\n只输出一个符合要求的 JSON 对象，不要 Markdown，不要解释。"
    );
    let user = serde_json::to_string_pretty(context)
        .map_err(|error| AgentError(format!("failed to serialize Agent context: {error}")))?;
    let Some(first) = gateway
        .complete(&system, &user)
        .await
        .map_err(|error| AgentError(format!("{role} model failed: {error}")))?
    else {
        return if allow_local_fallback {
            Ok(None)
        } else {
            Err(AgentError(format!(
                "{role} requires a configured chat model; this run did not approve local fallback"
            )))
        };
    };
    let (value, (_, model, prompt_tokens, completion_tokens)) =
        repair_once_validated(
            role,
            task,
            &user,
            first,
            &validate,
            |repair_system, repair_user| async move {
                gateway.complete(&repair_system, &repair_user).await
            },
        )
        .await?;
    Ok(Some(Routed {
        value,
        model,
        prompt_tokens,
        completion_tokens,
    }))
}

#[cfg(test)]
async fn repair_once<T, F, Fut>(
    role: &str,
    task: &str,
    original_context: &str,
    first: ModelCompletion,
    repair: F,
) -> Result<(T, ModelCompletion), AgentError>
where
    T: DeserializeOwned,
    F: FnOnce(String, String) -> Fut,
    Fut: Future<Output = Result<Option<ModelCompletion>, String>>,
{
    repair_once_validated(role, task, original_context, first, &|_| Ok(()), repair).await
}

async fn repair_once_validated<T, F, Fut, V>(
    role: &str,
    task: &str,
    original_context: &str,
    first: ModelCompletion,
    validate: &V,
    repair: F,
) -> Result<(T, ModelCompletion), AgentError>
where
    T: DeserializeOwned,
    F: FnOnce(String, String) -> Fut,
    Fut: Future<Output = Result<Option<ModelCompletion>, String>>,
    V: Fn(&mut T) -> Result<(), AgentError>,
{
    let first_error = match parse_and_validate::<T, V>(role, &first.0, validate) {
        Ok(value) => return Ok((value, first)),
        Err(error) => error,
    };
    let repair_system = format!(
        "你是 Ollaic 的 JSON 修复器。原角色是 {role}，原任务是：{task}\n根据校验错误修复响应，只输出一个完整 JSON 对象，不要 Markdown，不要解释。"
    );
    let repair_user = format!(
        "原始任务上下文：\n{original_context}\n\n校验错误：\n{}\n\n需要修复的响应：\n{}",
        first_error.0, first.0
    );
    let Some(mut second) = repair(repair_system, repair_user)
        .await
        .map_err(|error| AgentError(format!("{role} JSON repair failed: {error}")))?
    else {
        return Err(first_error);
    };
    let value = parse_and_validate::<T, V>(role, &second.0, validate).map_err(|second_error| {
        AgentError(format!(
            "{}; automatic repair also failed: {}",
            first_error.0, second_error.0
        ))
    })?;
    second.2 = first.2.zip(second.2).map(|(a, b)| a.saturating_add(b));
    second.3 = first.3.zip(second.3).map(|(a, b)| a.saturating_add(b));
    Ok((value, second))
}

fn parse_and_validate<T, V>(role: &str, text: &str, validate: &V) -> Result<T, AgentError>
where
    T: DeserializeOwned,
    V: Fn(&mut T) -> Result<(), AgentError>,
{
    let mut value = parse_structured(role, text)?;
    validate(&mut value)?;
    Ok(value)
}

pub fn contract_error(path: impl AsRef<str>, message: impl AsRef<str>) -> AgentError {
    AgentError(format!(
        "contract violation at {}: {}",
        path.as_ref(),
        message.as_ref()
    ))
}

fn parse_structured<T: DeserializeOwned>(role: &str, text: &str) -> Result<T, AgentError> {
    let json =
        extract_json(text).ok_or_else(|| AgentError(format!("{role} returned no JSON object")))?;
    serde_json::from_str(json)
        .or_else(|_| serde_json::from_str(&escape_string_control_characters(json)))
        .map_err(|error| {
            AgentError(format!(
                "{role} returned JSON with an invalid structure: {error}"
            ))
        })
}

fn escape_string_control_characters(json: &str) -> String {
    let mut escaped_json = String::with_capacity(json.len());
    let mut in_string = false;
    let mut after_escape = false;

    for character in json.chars() {
        if !in_string {
            escaped_json.push(character);
            in_string = character == '"';
        } else if after_escape {
            escaped_json.push(character);
            after_escape = false;
        } else {
            match character {
                '\\' => {
                    escaped_json.push(character);
                    after_escape = true;
                }
                '"' => {
                    escaped_json.push(character);
                    in_string = false;
                }
                '\u{0000}'..='\u{001f}' => {
                    write!(escaped_json, "\\u{:04x}", character as u32).unwrap();
                }
                _ => escaped_json.push(character),
            }
        }
    }
    escaped_json
}

fn extract_json(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end >= start).then_some(&text[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    struct UnavailableGateway;

    impl ChatGateway for UnavailableGateway {
        fn complete<'a>(
            &'a self,
            _system: &'a str,
            _user: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Option<ModelCompletion>, String>> + Send + 'a>>
        {
            Box::pin(async { Ok(None) })
        }
    }

    #[test]
    fn extracts_json_from_markdown_wrapped_response() {
        assert_eq!(
            extract_json("```json\n{\"ok\":true}\n```"),
            Some("{\"ok\":true}")
        );
    }

    #[tokio::test]
    async fn unavailable_gateway_does_not_implicitly_authorize_local_fallback() {
        let error = generate_structured_validated::<RequiredResponse, _>(
            &UnavailableGateway,
            "Test Agent",
            "return an id",
            &serde_json::json!({}),
            false,
            |_| Ok(()),
        )
        .await
        .err()
        .expect("an unavailable gateway should require run authorization");

        assert!(error.0.contains("did not approve local fallback"));
    }

    #[tokio::test]
    async fn parses_unescaped_control_characters_without_model_repair() {
        let first = (
            "{\"id\":\"line one\nline two\"}".to_string(),
            "model-a".to_string(),
            Some(2),
            Some(3),
        );
        let (parsed, _) = repair_once::<RequiredResponse, _, _>(
            "Dialogist",
            "write dialogue",
            "{}",
            first,
            |_, _| async { Err("model repair should not be called".to_string()) },
        )
        .await
        .unwrap();
        assert_eq!(parsed.id, "line one\nline two");
    }

    #[derive(Debug, Deserialize)]
    struct RequiredResponse {
        id: String,
    }

    #[tokio::test]
    async fn repairs_an_invalid_structure_once_and_counts_both_calls() {
        let first = ("{}".to_string(), "model-a".to_string(), Some(2), Some(3));
        let (value, completion) = repair_once::<RequiredResponse, _, _>(
            "Test Agent",
            "返回 id",
            "{}",
            first,
            |system, user| async move {
                assert!(system.contains("JSON 修复器"));
                assert!(user.contains("missing field `id`"));
                Ok(Some((
                    r#"{"id":"fixed"}"#.to_string(),
                    "model-a".to_string(),
                    Some(5),
                    Some(7),
                )))
            },
        )
        .await
        .unwrap();

        assert_eq!(value.id, "fixed");
        assert_eq!(completion.2, Some(7));
        assert_eq!(completion.3, Some(10));
    }

    #[tokio::test]
    async fn semantic_failure_uses_the_same_repair_loop_and_field_path() {
        let first = (
            r#"{"id":""}"#.to_string(),
            "model-a".to_string(),
            Some(2),
            Some(3),
        );
        let (value, _) = repair_once_validated::<RequiredResponse, _, _, _>(
            "Test Agent",
            "返回非空 id",
            "{}",
            first,
            &|value| {
                (!value.id.trim().is_empty())
                    .then_some(())
                    .ok_or_else(|| contract_error("$.id", "must not be empty"))
            },
            |_, repair_user| async move {
                assert!(repair_user.contains("$.id"));
                Ok(Some((
                    r#"{"id":"fixed"}"#.to_string(),
                    "model-a".to_string(),
                    None,
                    None,
                )))
            },
        )
        .await
        .unwrap();
        assert_eq!(value.id, "fixed");
    }

    #[tokio::test]
    async fn semantic_failure_after_repair_keeps_both_field_paths() {
        let error = repair_once_validated::<RequiredResponse, _, _, _>(
            "Test Agent",
            "返回非空 id",
            "{}",
            (r#"{"id":""}"#.into(), "model-a".into(), None, None),
            &|value| {
                (!value.id.trim().is_empty())
                    .then_some(())
                    .ok_or_else(|| contract_error("$.id", "must not be empty"))
            },
            |_, _| async {
                Ok(Some((
                    r#"{"id":""}"#.to_string(),
                    "model-a".to_string(),
                    None,
                    None,
                )))
            },
        )
        .await
        .unwrap_err();
        assert!(error.0.contains("$.id"));
        assert!(error.0.contains("automatic repair also failed"));
    }
}
