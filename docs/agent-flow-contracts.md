# Agent Flow Data Contracts

Agent Flow only passes typed, validated values between Flow Steps. LLM text is not a
handoff format: `generate_structured_validated` extracts JSON, deserializes it,
normalizes compatible historical variants, and performs semantic validation.
Syntax or semantic failure triggers one repair request containing the original
context, response, and exact error. A second failure stops the step and does not
update `StoryPlan`.

Contract errors use JSONPath, for example
`contract violation at $.sceneDrafts[0].beats[2].speaker: references unknown character`.

## Step Contracts

| Flow Step | Input source | Typed output | Persisted handoff |
| --- | --- | --- | --- |
| Plan | Production Brief, step instruction | `{ synopsis: string }` | `StoryPlan.synopsis` |
| Memory | brief, synopsis, instruction | `{ worldbook: string, glossary: Record<string,string> }` | `StoryPlan.memory` |
| Outline | brief, synopsis, memory, instruction | `{ chapters: ChapterPlan[], scenePlans: ScenePlan[], branches: BranchGraph }` | matching `StoryPlan` fields |
| Character | brief, synopsis, worldbook, scene plans | `{ characters: Character[] }` | `StoryPlan.characters` and `characters.json` |
| Dialogist | brief, story context, characters, outline | `{ sceneDrafts: SceneDraft[] }` | `StoryPlan.sceneDrafts` |
| AssetPlanner | brief, story context, characters, drafts | `{ assetPlan: AssetTaskPlan[] }` | `StoryPlan.assetPlan` |
| SceneScript | scene plans, branches, drafts, asset plan | `SceneScript[]` | `game/scene/*.txt`, then `StoryPlan.scenes` |
| AssetQueue | asset plan, compiled scenes, characters | `AssetQueue` | `.ollaic/assets/queue.json` and promoted assets |

All JSON field names are camelCase. Strings described as required are trimmed
before emptiness checks. IDs and filename stems use ASCII letters, digits, `_`,
or `-`; scene files are single safe path components ending in `.txt`.

### Plan

- `synopsis` is required and non-empty.
- Historical malformed JSON with literal control characters inside strings is
  escaped before the repair attempt.

### Memory

- `worldbook` is required.
- `glossary` requires at least four non-empty terms with non-empty definitions.

### Outline

- `chapters[]`: required unique `id`, `title`, and `summary`.
- `scenePlans[]`: required unique `id`, unique safe `file`, valid `chapterId`,
  `title`, `summary`, and provisional `characterIds[]`.
- `branches.entryScene` and every edge `from`/`to` must reference a scene ID.

### Character

- Character `id` and `name` are unique; descriptive card fields required by the
  generation contract are non-empty.
- Numeric legacy `age` values deserialize as text.
- Incomplete optional relation objects are dropped. Complete relation
  `targetId` values must reference another generated character.
- Every provisional scene cast value must resolve to a generated ID, name, or
  alias; normalized IDs remain attached to the scene plan.

### Dialogist

- Exactly one unique draft is required for every scene plan; `sceneId` is the
  reference and a missing historical `title` is filled from the scene plan.
- Each draft contains at least eight non-empty beats. `speaker` is null or an
  existing character name/alias.
- Figure cue `action` is `show` or `hide`. `characterId` references the scene
  cast. `show` also requires `position` in `left|center|right` and a safe
  `emotion`; `hide` does not require a position.

### AssetPlanner

- Every task has a unique safe `id`, safe `targetStem`, non-empty `prompt`, and
  `status: "pending"`.
- `kind` is `background|figure|bgm|sfx`.
- `sceneRef` and `characterRef`, when present, reference existing IDs.
- Figure tasks require `characterRef` and a safe `emotion`; other kinds forbid
  `emotion`. Missing historical task IDs are deterministically filled.
- Every staged figure cue has a corresponding character/emotion figure task.

### SceneScript

- Draft coverage, branch endpoints, cast membership, cue position/emotion, and
  figure-task coverage are revalidated before deterministic compilation.
- Invalid multi-choice targets never fall back to `start.txt`; the error points
  to `$.branches.edges[index].to`.
- Each output has a safe scene filename and terminated WebGAL commands.

### Visual Production

- Optional `visualStyle` fields carry style, negative constraints, palette/lighting,
  and a project-owned style reference. Historical plans default to an empty style.
- Figure and background tasks carry `referenceImage` and `aspectRatio`. Character
  references prefer user uploads (including the historical `game/reference/`
  location), then the successful raw anchor, then a registered default sprite.
  Resolved reference files must remain inside the project.
- Default figures bind before expression variants. Failed defaults block variants
  even when an older raw anchor exists. Existing user sprites/backgrounds bind
  without an AI request; generated assets retain task history on resume.
- Backgrounds share a task only for the same explicit location and time tuple.
  One shared task can bind each matching scene without duplicating generation.
- SD WebUI uses img2img with denoising strength 0.45 when conditioning is requested.
  Seedream and Gemini route supported reference requests explicitly. Unsupported
  conditioning fails before transport and is reported in Flow preflight.
- Figure/background requests use portrait/landscape ratios, constrained to each
  model's supported dimensions. Successful raw anchors are persisted as PNG, and
  matted figures use a transparent 900 × 1400 canvas with centered, bottom-aligned
  silhouettes and approximately 8% headroom when the silhouette width permits it.

### AssetQueue

- Queue schema version is `1`; absent legacy `version`, `limits`, and task
  `status` migrate to version 1, default limits, and `pending`.
- Task `kind` is the typed enum `background|figure|bgm|sfx|tts`; status is
  `pending|running|retrying|succeeded|failed`.
- IDs are unique and safe. Figure and TTS fields are validated before save and
  after load. TTS requires `sceneRef`, `dialogueIndex`, and `text`.
- On same-run recovery, the queue is rederived from the latest plan and scenes.
  Semantically identical succeeded tasks are rebound, while `running`,
  `retrying`, and other unfinished tasks return to `pending` with their attempt
  history retained. Changed or missing promoted assets regenerate.

## Persistence and Compatibility

`StoryPlan` and `AssetQueue` both use schema version `1`. A missing version is
treated as version 1 for pre-version files; unknown future versions fail at
`$.version`. Both stores validate before crash-safe save and validate every
primary/backup candidate after structured deserialization. Cross-step errors
retain indexed paths such as `$.scenePlans[0].chapterId` and
`$.assetPlan[3].characterRef`, so a resumed run cannot silently lose a reference.
