# Agent Trace Storage

Agent traces use the versioned `TraceRecord` v1 schema. Default records are
classified as operational data and contain only prompt/response hashes and
sizes, elapsed time, edit/asset counts, tool names, byte counts, and success
status. Prompts, Scene or Memory prose, uploads, tool arguments/results,
project identifiers, and provider credentials are not accepted by the backend
schema.

The local trace file is limited to the newest 200 records and is owner-only on
Unix-like systems. Optional diagnostic excerpts require an explicit caller
opt-in, are capped at 256 characters, and declare a 24-hour expiration. The
application's normal trace path never enables diagnostic excerpts.

Readers must require `version: 1` and `classification: operational`. Unknown
versions and fields fail validation instead of being interpreted as a legacy
full-payload trace. Traces remain local and are not telemetry uploads.
