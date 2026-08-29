# Flow Step commits are serial

An Agent Flow executes one ready Flow Step at a time. Serial execution is an invariant of the current commit protocol, not a configurable strategy.

Flow Step outputs replace shared StoryPlan partitions and may update the same character, Scene, asset, and rollback-snapshot files. Running two ready Steps concurrently without isolated snapshots and a conflict-aware commit phase would allow the later save to erase the earlier result. Serial execution therefore protects the existing output commit contract.

The same rule applies across Flow runs: one project may have only one non-terminal Flow. The claim includes persisted unfinished runs so restarting the application does not open a second writer. A Step commit holds the project lock shared with AI change sets continuously while it records its rollback snapshot, writes project outputs and StoryPlan, and persists success.

This does not prohibit concurrency inside a Step. Asset production may generate independent media tasks concurrently under capability-specific limits, then binds successful artifacts serially because binding rewrites shared Scene and metadata files.

Parallel Flow Steps require a separate execution snapshot per Step, declared write resources, and an ordered conflict-aware commit phase. Dependency readiness alone is not sufficient authorization to write shared Project state concurrently.
