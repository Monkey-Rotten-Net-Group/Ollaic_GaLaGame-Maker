# WebGAL Editor Context

This repository builds a local desktop editor for authoring and exporting WebGAL visual novels.

## Terms

### Project

A local WebGAL work directory containing `game/`, its configuration, scenes, and assets.

### Scene

A WebGAL `.txt` script in `game/scene/`. A scene is edited visually as an ordered collection of nodes and exported as script text.

### Scene Editing

The authoring behaviour for a scene: inserting, removing, reordering, connecting, saving, restoring drafts, and adding generated nodes. Sequential connections stop at terminal nodes.

### Asset

A media file owned by a project and stored in an appropriate `game/` category directory, such as `background`, `figure`, `bgm`, `sfx`, `vocal`, or `video`.

### Asset Reference

A semantic reference from a Scene command to an Asset file. It is discovered from parsed Scene meaning rather than arbitrary text matches, and follows its Asset when the Asset is renamed.

### Asset Metadata

Editor-managed information associated with an Asset, including its display alias, tags, and Reference Material index. It is stored with the Project and identified by Asset category and filename. Metadata follows the Asset when it is renamed and is removed when the Asset is deleted.

### Reference Material

Supplemental source media associated with an asset for creation workflows. It is stored below `game/config/references/` and follows the owning asset lifecycle.

### AI Reference Upload

A local text file the author attaches to the AI workflow as reference material. It is copied into the Project editor state below `.webgal-editor/ai-uploads/`, never into `game/`, so it is not exported and never becomes a playable project file. Agent read tools may list it and read its content; changing the Project from it still goes through the normal change approval path.

### Character

A person authored for a Project, with stable identity, dialogue context, relationships, and figure sprite mappings. Character reads expose one canonical entry per identity.
