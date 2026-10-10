//! `agent-harness` command tree.
//!
//! Only argument shapes live here; every subcommand body is in the sibling
//! modules so this file stays scannable.

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "agent-harness",
    about = "Headless driver for Ollaic's AI code paths: probe providers, run one Flow Agent, generate media, record and replay cassettes.",
    version
)]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalArgs,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Args, Clone)]
pub struct GlobalArgs {
    /// Config/log directory to use instead of the desktop app's. Sets
    /// OLLAIC_CONFIG_DIR, so a probe never clobbers your saved settings.
    #[arg(long, global = true, value_name = "DIR")]
    pub profile: Option<String>,

    /// Record every provider exchange into this cassette.
    #[arg(long, global = true, value_name = "NAME", conflicts_with = "replay")]
    pub record: Option<String>,

    /// Serve every provider exchange from this cassette. No network.
    #[arg(long, global = true, value_name = "NAME")]
    pub replay: Option<String>,

    /// Root holding cassettes. Defaults to <manifest>/fixtures/agent-harness.
    #[arg(long, global = true, value_name = "DIR")]
    pub cassette_dir: Option<String>,

    /// Emit machine-readable JSON instead of the human report.
    #[arg(long, global = true)]
    pub json: bool,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Show the effective chat/image/TTS/music configuration.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },

    /// Validate the chat provider: config, declared capability, live round-trip.
    Probe(ProbeArgs),

    /// Run one non-streaming chat turn, optionally with tool definitions.
    Chat(ChatArgs),

    /// Run a single Production Flow Agent against a StoryPlan.
    Agent(AgentArgs),

    /// Drive every agent step from one Production Brief, contract-checking
    /// each output and feeding it to the next. The full-chain smoke test.
    Chain(ChainArgs),

    /// Generate an image, a TTS clip, or background music.
    Media {
        #[command(subcommand)]
        action: MediaAction,
    },

    /// Inspect the AI call log and the agent trace.
    Log(LogArgs),

    /// List, show, or verify recorded cassettes.
    Cassette {
        #[command(subcommand)]
        action: CassetteAction,
    },
}

#[derive(Debug, Subcommand)]
pub enum ConfigAction {
    /// Print all four provider configs with credentials redacted.
    Show,
}

#[derive(Debug, Args)]
pub struct ProbeArgs {
    /// Override the saved provider for this invocation only.
    #[arg(long)]
    pub provider: Option<String>,
    #[arg(long)]
    pub model: Option<String>,
    #[arg(long)]
    pub base_url: Option<String>,
    /// Prefer AI_LAB_API_KEY in a shared shell; this lands in your history.
    #[arg(long)]
    pub api_key: Option<String>,
    /// Skip the live round-trip; only report config and declared capability.
    #[arg(long)]
    pub offline: bool,
}

#[derive(Debug, Args)]
pub struct ChatArgs {
    /// The user message.
    pub prompt: String,

    /// System prompt. Defaults to the app's story-editing system prompt.
    #[arg(long)]
    pub system: Option<String>,

    /// JSON file holding a `[{name, description, parameters}, ...]` tool array.
    #[arg(long, value_name = "FILE")]
    pub tools: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum AgentKind {
    Plan,
    Memory,
    Outline,
    Character,
    Asset,
    Scene,
    Dialogist,
}

#[derive(Debug, Args)]
pub struct AgentArgs {
    /// Which agent to run.
    pub kind: AgentKind,

    /// Project directory; its .ollaic/plan.json supplies the StoryPlan.
    #[arg(long, value_name = "DIR", conflicts_with = "scenario")]
    pub project: Option<String>,

    /// A StoryPlan JSON file, for running without a project on disk.
    #[arg(long, value_name = "FILE")]
    pub scenario: Option<String>,

    /// Production Brief. Defaults to the StoryPlan's synopsis.
    #[arg(long)]
    pub brief: Option<String>,

    /// Per-step instruction, as edited in the Flow inspector.
    #[arg(long, default_value = "")]
    pub instruction: String,

    /// Permit the agent's local template fallback when no model is configured.
    #[arg(long)]
    pub allow_local_fallback: bool,

    /// Write the resulting payload here (defaults to stdout).
    #[arg(long, short = 'o', value_name = "FILE")]
    pub out: Option<String>,
}

#[derive(Debug, Args)]
pub struct ChainArgs {
    /// The Production Brief. Omit to use the built-in coverage brief, which is
    /// written to exercise every agent's contract (see `agent-harness chain --show-brief`).
    pub brief: Option<String>,

    /// Read the brief from a file instead.
    #[arg(long, value_name = "FILE", conflicts_with = "brief")]
    pub brief_file: Option<String>,

    /// Print the built-in coverage brief and exit, without calling anything.
    #[arg(long)]
    pub show_brief: bool,

    /// Permit each agent's local template fallback when no model is configured.
    #[arg(long)]
    pub allow_local_fallback: bool,

    /// Stop after this step id (plan|memory|outline|character|dialogist|assetPlan|scene).
    #[arg(long, value_name = "STEP")]
    pub stop_after: Option<String>,

    /// Write the accumulated StoryPlan here.
    #[arg(long, short = 'o', value_name = "FILE")]
    pub out: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum MediaAction {
    Image {
        prompt: String,
        #[arg(long)]
        model: Option<String>,
        /// Optional reference image for image-to-image providers.
        #[arg(long, value_name = "FILE")]
        reference: Option<String>,
        #[arg(long, short = 'o', value_name = "FILE")]
        out: String,
    },
    Tts {
        text: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, default_value = "")]
        voice: String,
        #[arg(long, default_value = "mp3")]
        format: String,
        #[arg(long, short = 'o', value_name = "FILE")]
        out: String,
    },
    Music {
        prompt: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, default_value = "mp3")]
        format: String,
        #[arg(long, short = 'o', value_name = "FILE")]
        out: String,
    },
}

#[derive(Debug, Args)]
pub struct LogArgs {
    /// How many trailing lines to show.
    #[arg(long, short = 'n', default_value_t = 20)]
    pub lines: usize,

    /// Read the agent trace instead of the AI call log.
    #[arg(long)]
    pub trace: bool,
}

#[derive(Debug, Subcommand)]
pub enum CassetteAction {
    /// List cassettes under the cassette directory.
    Ls,
    /// Print one cassette's interactions.
    Show { name: String },
    /// Check a cassette parses and has no duplicate request hashes.
    Verify { name: String },
}
