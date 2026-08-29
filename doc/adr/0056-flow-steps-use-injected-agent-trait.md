# Flow Steps invoke agents through an injected Agent trait

Flow Steps do not call an LLM directly. They call an `Agent` trait (`async fn run(ctx: &AgentContext) -> Result<AgentOutput>`), and the Agent Flow orchestrator is given an `AgentRegistry` that maps a typed Step executor to a concrete agent. `AgentOutput` contains one tagged payload, so each Step result has one valid shape and the output commit layer must handle every shape explicitly.

This boundary makes the orchestrator testable without an LLM or API key: tests inject deterministic agents, so scheduling, pause/resume/retry/skip, persistence, and event emission can be verified without changing production behavior at compile time. Asset production follows the same rule through `AssetGeneratorFactory`; production injects configured providers and tests inject a fake generator. Real-provider tests belong at the provider boundary, not behind a scheduler `cfg!(test)` branch.
