//! Pipeline Orchestrator (V2 section 3.1). Declares and re-exports the
//! scheduler, run state, events, persistence, and DSL.

mod asset_executor;
pub mod commands;
pub mod dsl;
pub mod events;
mod output_commit;
mod project_state;
mod recovery;
pub mod registry;
mod run_control;
mod run_driver;
pub mod scheduler;
pub mod state;
mod step_executor;
pub mod store;

// Re-exports form the module's public API; in this binary crate they are
// consumed by the test suite and by sibling modules, so allow unused in the
// non-test build.
#[allow(unused_imports)]
pub use dsl::{default_recipe, FlowRecipe, RecipeError, StepDef, StepKind};
#[allow(unused_imports)]
pub use events::{EventSink, PipelineEvent};
#[allow(unused_imports)]
pub use recovery::PipelineError;
#[allow(unused_imports)]
pub use run_control::RunHandle;
#[allow(unused_imports)]
pub use scheduler::Pipeline;
#[allow(unused_imports)]
pub use state::{Clock, RunState, RunStatus, StepRunHistory, StepState, StepStatus, SystemClock};
#[allow(unused_imports)]
pub use store::{list_run_states, load_run_state, run_state_path, save_run_state, RunStoreError};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
