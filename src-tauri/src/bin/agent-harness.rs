//! Thin shell over `ollaic::agent_harness`. Kept to one line so the harness
//! itself stays inside the crate, where it can reach `pub(crate)` AI entry
//! points.

fn main() {
    ollaic::agent_harness::main()
}
