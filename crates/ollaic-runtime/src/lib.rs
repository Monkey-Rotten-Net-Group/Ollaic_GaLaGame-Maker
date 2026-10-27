pub mod engine;
pub mod server;
pub mod session;

pub fn engine_version() -> &'static str {
    include_str!("../webgal-version.txt").trim()
}
