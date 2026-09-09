# Provider Credential Storage

The first-wave credential store is protected local file storage, not an OS
keychain. Chat, image, TTS, and music Provider settings remain portable JSON so
existing installations can migrate without losing configuration.

Provider configuration writes use a synced temporary file followed by atomic
replacement. The previous valid file remains as a `.bak` recovery copy. On
Unix-like systems, the configuration directory is mode `0700` and credential
files, temporary files, and backups are mode `0600`. Existing files are
restricted on first read.

This protects credentials from other operating-system users and interrupted
writes. It does not protect them from software running as the same user. Moving
API keys to platform keychains requires a separate migration design covering
Linux desktop availability, backup behavior, and headless environments.
