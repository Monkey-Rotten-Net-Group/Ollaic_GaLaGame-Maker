# Scene-Centric Production Workflow Plan

> **Status:** Proposal (Target Architecture & Implementation Plan)
>
> This document defines the engineering plan to evolve Ollaic's Agent Flow from a whole-project batch pipeline into a **two-stage, scene-centric production workflow** with strong narrative contracts, provider-verified reference-anchored visual consistency, sprite stage normalization, WebGAL label-block variable branching, and per-scene playable review. For currently implemented V2 behavior, see [`v2-agent-pipeline.md`](./v2-agent-pipeline.md) and [`agent-flow-contracts.md`](./agent-flow-contracts.md).

---

## 1. Deep Codebase Audit: Why Current Outputs Fall Short of Mature Products

An inspection of `pipeline/`, `agents/`, `asset_queue/`, `ai/gateway/`, and `webgal/` reveals **seven concrete code-level bottlenecks** that prevent the current 8-step batch flow (`plan → memory → outline → character → dialogist → assetPlan → scene → assetQueue`) from producing a cohesive, commercially playable Galgame:

### 1.1 Whole-Project Batching & Destructive Re-runs
- **Monolithic DAG (`pipeline/dsl.rs:184`)**: `default_recipe()` schedules global stages rather than scene-scoped units. `DialogistAgent` (`agents/dialogist.rs:42`) and `AssetPlannerAgent` (`agents/asset_planner.rs:186`) process all `scenePlans` in a single LLM request.
- **Destructive Output Commits (`pipeline/output_commit.rs:56`)**: `apply_output()` wipes downstream vectors (`plan.scene_drafts.clear()`, `plan.asset_plan.clear()`, `plan.scenes.clear()`) whenever an upstream stage re-runs. Revising one weak scene requires regenerating the entire story's dialogue and asset plan.
- **Non-Empty Project Block (`pipeline/scheduler.rs:207`)**: `create_new_story_run_with_timeout()` rejects any project where `project_has_story_content_locked()` is true, preventing iterative scene-by-scene expansion or continuation of a project with pre-existing scenes.

### 1.2 Broken Reference-Image & Aspect-Ratio Pipeline in Media Gateway
- **Dropped Reference Image in Workflow (`pipeline/asset_executor.rs:139`)**: `generate_configured_asset()` calls `crate::ai::commands::generate_image_media(None, task.prompt.clone(), configured_model(&config.model)?, None)`—hardcoding `reference_image_path` to `None`. Even when a user uploads character reference sheets in `CharacterPanel.tsx` (stored under `game/config/references/<characterId>/`), the Workflow ignores them.
- **Concurrent Anchor & Variant Race (`asset_queue/scheduler.rs:144`)**: `run_queue_cancellable()` pushes all runnable `AssetKind::Figure` tasks into `FuturesUnordered` simultaneously (`limits.image = 2`). A character's `angry` or `smile` variant runs concurrently with (or before) their `default` sprite, so `default` cannot act as an image-to-image anchor for expression variants.
- **Silent Reference Dropping & Square `1024x1024` Hardcoding Across Adaptors (`ai/gateway/adaptors/`)**:
  - `openai.rs:51`: Only passes `request.reference` when `is_seedream_model(request.model)` is true; standard OpenAI-compatible endpoints silently ignore `request.reference` and hardcode `"size": "1024x1024"`.
  - `sd_webui.rs:16`: Always hits `sdapi/v1/txt2img` with hardcoded `width: 1024, height: 1024`, completely ignoring `request.reference` (never routes to `sdapi/v1/img2img`).
  - `dashscope.rs:94`: Hardcodes `"size": "1024*1024"` and ignores `request.reference`.
  - `gemini.rs:52`: Properly passes `request.reference` as `inline_data`, but receives no aspect-ratio parameter (`16:9` for backgrounds vs. `3:4` for standing sprites).
- **No Post-Matting Sprite Framing Normalization (`matting/commands.rs` & `asset_queue/binder.rs`)**: `isnet-anime.onnx` removes the background, but the resulting transparent PNG is saved as-is. If one sprite is generated full-body and another waist-up, or off-center within the `1024x1024` canvas, characters appear at wildly mismatched scales and heights on the WebGAL stage.

### 1.3 WebGAL Syntax Limitation on Choice Effects & Conditions
- **WebGAL `choose:` Syntax Constraint (`webgal/serializer.rs:129` & `agents/scene.rs:64`)**: In WebGAL script syntax, `choose:Option A:target_a.txt|Option B:target_b.txt;` only jumps to a scene file or a `label:` name; it **cannot** inline `setVar:` mutations or per-option `-when=` predicates inside the `choose:` string itself.
- **Stateless `BranchGraph` (`story_plan/types.rs:124`)**: `BranchEdge` only has `from`, `to`, and `choice`. Without compiling choice targets through intermediate `label:` blocks in the current scene (`choose:Trust her:lbl_choice_0; ... label:lbl_choice_0; setVar:trust=trust+1; changeScene:ending_trust.txt;`), a generated game cannot track affection or route flags.

### 1.4 Token Compression & Missing Narrative Craft Guardrails
- **The "8-Beat Summary" Trap (`agents/dialogist.rs:255`)**: Because one LLM completion must return JSON for all 6–12 scenes at once, the model compresses each scene to the bare validation minimum (`beats.len() >= 8`). Dialogues read like plot outlines rather than Galgame scripts (missing protagonist first-person internal monologue, environmental sensory hooks, subtext, and emotional pacing).
- **Under-Specified `ScenePlan` (`story_plan/types.rs:111`)**: `ScenePlan` only contains `id`, `file`, `chapter_id`, `title`, `summary`, and `character_ids`. It does not constrain POV, location/time lighting, entry/exit facts, mandatory dramatic beats, or forbidden spoilers (causing early scenes to leak late-game reveals).

---

## 2. Target Architecture: Two-Stage Director Workflow

To match and exceed mature tools (such as Fictoi's reference-locked workstation, Pominis's consequential scene loop, Sudowrite's Story Bible + Scene Draft split, and articy:draft's stateful node simulation), Ollaic separates **Project Setup (Stage 1)** from **Per-Scene Production (Stage 2)**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Stage 1: Project Setup & Visual Anchor Flow (Global Bible & Locks)         │
│                                                                            │
│  [1. Asset & Brief Intake] ──▶ Scans existing `game/` & user uploads       │
│             │                                                              │
│             ▼                                                              │
│  [2. Canon, Style Spec & Flag Registry] (`memory` + `visualStyle`)         │
│             │                                                              │
│             ▼                                                              │
│  [3. Character Bible & Anchor Sprite Pass] (`character` + `anchorSprites`) │
│      • Generates ONLY `default` sprite per character (`3:4`, `#FFFFFF` bg) │
│      • Runs `isnet-anime` matting + Bounding-Box Scale Normalization       │
│      • Saves canonical anchor to `game/config/references/<id>/anchor.png`  │
│             │                                                              │
│             ▼                                                              │
│  [4. Consequential Route & Scene Contract Map] (`outline` + `lint`)        │
│      • Validates reachability, flag set/read pairing, and merge safety     │
│                                                                            │
│  🔒 STAGE 1 GATE: Author reviews Cast, Anchor Portraits, Style & Route Map │
└────────────────────────────────────────────────────────┬───────────────────┘
                                                         │
                                                         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Stage 2: Single-Scene Production Transaction (Run 1 Scene at a Time)       │
│                                                                            │
│  Target: `scene_id` (Selected by user or next in topological route order)  │
│    ├── [S.1 Context & Rolling State Assembly]                              │
│    │     Reads locked Canon + `SceneContract` + Preceding Scene Tail       │
│    ├── [S.2 Single-Scene Dialogist (25–45 Beats)]                          │
│    │     Interleaves Narration, Inner Monologue, Dialogue & Stage Cues     │
│    ├── [S.3 Incremental Scene Asset Delta]                                 │
│    │     Reuses existing backgrounds/sprites; queues only missing emotions │
│    ├── [S.4 Two-Pass Reference-Conditioned Asset Execution]                │
│    │     Pass A: Scene BG (`16:9`) | Pass B: Variant Sprites (`anchor.png`)│
│    ├── [S.5 WebGAL Script Compiler (with `label:` + `setVar:` blocks)]     │
│    └── 🎮 SCENE ACCEPTANCE GATE: Live Runtime Preview (with Entry State)   │
│          ├── [Approve & Lock Scene] ──▶ Persist Rolling Summary, Advance   │
│          ├── [Rewrite Dialogue / Beats] ──▶ Re-run S.2 only for `scene_id` │
│          └── [Redraw Single Sprite/BG] ──▶ Re-run 1 task in S.4            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Technical Specifications

### 3.1 Domain Schema Upgrades (`apps/desktop/src-tauri/src/story_plan/types.rs`)

All new fields use `#[serde(default)]` so existing `version: 1` `.ollaic/plan.json` files deserialize without breaking:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VisualStyleSpec {
    /// Prepended to every image prompt: rendering style, lineart weight, shading.
    pub style_prompt: String,
    /// Appended negative constraints (e.g., "multiple people, cropped head, messy background, text, watermark").
    pub negative_prompt: String,
    /// Shared color palette and lighting direction.
    pub palette_and_lighting: String,
    /// Optional style exemplar image path relative to project root.
    pub style_reference_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VariableDef {
    pub id: String,            // Safe WebGAL identifier, e.g., "linxia_trust"
    pub kind: VariableKind,    // Integer | Boolean
    pub initial_value: String, // e.g., "0" or "false"
    pub description: String,   // Narrative meaning of the variable
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SceneApprovalStatus {
    #[default]
    Pending,
    Drafted,
    Approved,
    Stale,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BeatKind {
    #[default]
    Dialogue,
    Narration,
    Monologue,
}
```

#### Upgraded `ScenePlan` (The Scene Contract)
- `location_id: Option<String>`: Canonical location key so multiple scenes in the same place reuse the same background asset (`bg_<location_id>_<time_of_day>`).
- `time_of_day: Option<String>`: `"morning" | "day" | "sunset" | "night"`.
- `pov_character_id: Option<String>`: Whose internal monologue (`BeatKind::Monologue`) drives the narration.
- `entry_state: Vec<String>`: Required narrative facts or variable preconditions entering this scene.
- `emotional_arc: String`: Required shift from opening to closing (e.g., `"defensive banter -> shared vulnerability -> reluctant alliance"`).
- `required_beats: Vec<String>`: 3–4 concrete micro-events that must happen in order (Hook, Escalation, Turning Point, Exit/Choice setup).
- `forbidden_reveals: Vec<String>`: Facts from `worldbook` that must **not** be spoken or revealed in this scene.
- `min_beats: usize`: Defaults to `24` in production mode (`8` permitted only when `allow_local_fallback` is active for deterministic offline tests).
- `approval_status: SceneApprovalStatus` and `rolling_summary: Option<String>`.

#### Upgraded `BranchEdge` (Stateful Consequential Choices)
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchEdge {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub choice: Option<String>,
    /// Optional WebGAL boolean expression gating this choice/transition (e.g., "linxia_trust>=2").
    #[serde(default)]
    pub condition: Option<String>,
    /// State mutations executed when this edge is taken (e.g., ["linxia_trust=linxia_trust+1"]).
    #[serde(default)]
    pub effects: Vec<String>,
}
```

---

### 3.2 WebGAL Stateful Branch & Beat Compilation (`agents/scene.rs`)

Because WebGAL's `choose:` command only jumps to a scene file or a local `label:`, `SceneAgent` will compile stateful choices using **local trampoline labels** at the bottom of the scene script:

```txt
; Main scene beats
changeBg:bg_rooftop_sunset.png -next;
changeFigure:linxia_default.png -id=heroine -figureCharacter=heroine -figureEmotion=default -right -next;
:夕阳把天台铁丝网的影子拉得很长，风里带着旧磁带受潮的味道。;
陆川（独白）:（她刚才按下暂停键的动作太熟练了，简直像演练过上百次。）;
林夏:现在反悔还来得及。|握住她的手，一起承担:lbl_edge_0|遵守静默协议，退回日常:lbl_edge_1;
choose:握住她的手，一起承担:lbl_edge_0|遵守静默协议，退回日常:lbl_edge_1;
label:lbl_edge_0;
setVar:linxia_trust=linxia_trust+1;
changeScene:ending_trust.txt;
label:lbl_edge_1;
setVar:protocol_obeyed=true;
changeScene:ending_depart.txt;
```

- **Entry Variable Initialization (`start.txt`)**: When compiling the entry scene (`branches.entry_scene`), `SceneAgent` emits `setVar:<id>=<initial_value>;` at the top of `start.txt` for every variable in `StoryPlan.variables`.
- **Conditional Transitions**: When an unconditional outgoing edge has `condition: Some("linxia_trust>=2")`, `SceneAgent` emits `changeScene:true_end.txt -when=linxia_trust>=2;` followed by the fallback edge.
- **Monologue vs. Narration Compilation**:
  - `BeatKind::Narration` (`speaker: None`) compiles to `:环境与动作描写;`.
  - `BeatKind::Monologue` (`speaker: Some("陆川")`) compiles to `陆川:（第一人称内心戏与吐槽）;` without triggering a `changeFigure` show cue for the first-person protagonist unless explicitly staged.
- **Stage Hygiene (`changeBg` & `changeFigure` `-next` flag)**: Automatically append `-next` to `changeBg:` and `changeFigure:` commands that precede a dialogue beat in the same turn so background/sprite changes happen simultaneously with the text line rather than requiring an extra blank click from the player.

---

### 3.3 Visual Consistency, Provider Reference Routing & Sprite Normalization

To ensure generated images look like a cohesive commercial Galgame rather than a collage of random AI outputs:

1. **Provider Reference Capability Enforcement (`ai/provider_capability.rs` & `ai/gateway/adaptors/`)**:
   - Introduce `MediaCapability::ReferenceImageConditioning`.
   - **Gemini (`gemini.rs`)** and **Volcengine Seedream (`openai.rs`)**: Native support for reference images (`inline_data` / `image` data URI).
   - **SD WebUI (`sd_webui.rs`)**: Upgrade adaptor so that when `request.reference` is `Some(ref_img)`, it routes to `sdapi/v1/img2img` with `init_images: [ref_img.base64]` and `denoising_strength: 0.45` (preserving character face/outfit while altering facial expression), and sets `width: 832, height: 1216` (`~3:4`) for figures or `width: 1344, height: 768` (`16:9`) for backgrounds.
   - **Capability Warning**: If the user configures an image provider/model that ignores reference images (e.g., standard DALL-E 3), surface a clear warning in `FlowBoard` preflight: *"当前图片模型不支持参考图垫图，角色不同表情可能出现长相漂移；建议切换至 Gemini、Seedream 或 SD WebUI。"*

2. **Two-Pass Anchor-First Scheduling (`asset_queue/scheduler.rs` & `pipeline/asset_executor.rs`)**:
   - **Pass 1 (Anchors & Backgrounds)**: Execute all `AssetKind::Background` tasks and all `AssetKind::Figure` tasks where `emotion == "default"`.
   - If the character already has a user-uploaded reference image in `game/config/references/<characterId>/`, Pass 1 uses that image as the reference for generating `default` (or directly promotes the user's existing `default` sprite in `game/figure/`).
   - Once a character's `default` sprite succeeds (before or after matting), copy the clean unmatted raw image to `game/config/references/<characterId>/anchor_raw.png` and the matted PNG to `game/figure/<characterId>_default.png`.
   - **Pass 2 (Expression Variants)**: Execute `AssetKind::Figure` tasks where `emotion != "default"` **only after** that character's `default` task has succeeded. `asset_executor.rs` resolves `anchor_raw.png` (or the user's primary reference image) and passes it as `Some(reference_path)` to `generate_image_media` with an edit-style prompt:
     > `"Keep the exact same character identity, hairstyle, hair color, eye color, clothing, camera angle, and knee-up standing pose from the reference image. Only change the facial expression to: {emotion_description}. Pure solid flat white background #FFFFFF."`

3. **Post-Matting Sprite Bounding-Box Normalization (`matting/commands.rs`)**:
   - After `isnet-anime.onnx` produces the alpha mask, compute the non-transparent bounding box (`alpha > 16`).
   - Standardize the canvas to `900 × 1400` (or `1024 × 1536`) transparent PNG, scaling and horizontally centering the character silhouette so the top of the head sits at `~8%` from the top edge and the bottom aligns flush with the bottom canvas edge. This guarantees that two characters standing at `-left` and `-right` in WebGAL share consistent head heights and proportions.

---

### 3.4 Narrative Craft Prompting & Few-Shot Golden Exemplars (`agents/dialogist.rs`)

Schema rules alone do not make dialogue engaging. `DialogistAgent` will be upgraded with:

1. **Single-Scene Focus**: `DialogistAgent` runs per `scene_id`, receiving the full output token budget for a single scene (`24–45` beats).
2. **4-Beat Dramatic Structure Prompting**:
   - **Phase A — Sensory Hook & Entry State (Beats 1–5)**: Establish atmosphere, time of day, ambient sound, and protagonist's immediate physical/mental state. No immediate exposition dump.
   - **Phase B — Friction & Subtext (Beats 6–15)**: Characters interact with distinct speech patterns (`dialogue_style`, sentence length, verbal tics). Conflicts are expressed through action cues and subtext rather than stating themes aloud.
   - **Phase C — Turning Point / Reveal (Beats 16–22)**: Execute the `ScenePlan.required_beats` and shift the emotional dynamic along `ScenePlan.emotional_arc` (accompanied by `figureCues` emotion shifts).
   - **Phase D — Decision Pressure / Scene Exit (Beats 23+)**: Build concrete stakes directly motivating the outgoing `choose:` options or transition hook.
3. **Anti-Cliche & Anti-AI-Prose Guardrails**:
   - Explicitly forbid abstract summary lines (e.g., *"在这一刻，我们的命运开始交织"*, *"这不仅是选择，更是代价"*).
   - Require concrete nouns, physical micro-actions (e.g., pressing a cassette button, looking away, tightening grip on a railing), and natural Galgame rhythm (short spoken lines paired with protagonist inner monologue reactions).
4. **Rolling Context Injection**:
   - Before running Scene $N$, read the actual `.txt` script of the parent scene(s) from `game/scene/`, extract the last 10 dialogue/narration lines, and pass them in `AgentContext.preceding_scene_tail`. If the user manually edited Scene $N-1$ in `StoryEditor`, Scene $N$ naturally adapts to the user's edits.

---

## 4. Phased Implementation Plan

### Phase 1: Reference-Anchored Visual Pipeline & Pre-Supplied Asset Reuse
**Goal**: Eliminate character identity drift across expressions, normalize sprite framing on stage, and honor user-imported assets.

- **Files to Modify**:
  - `apps/desktop/src-tauri/src/story_plan/types.rs` (Add `VisualStyleSpec`, `location_id`, `time_of_day`, `reference_image`, `aspect_ratio`)
  - `apps/desktop/src-tauri/src/pipeline/asset_executor.rs` (Resolve and pass `reference_image_path` to `generate_image_media`)
  - `apps/desktop/src-tauri/src/asset_queue/scheduler.rs` (Two-pass execution: run `default` anchor figures before non-default expression variants; skip AI generation when user-supplied file already exists in `game/figure/` or `game/background/`)
  - `apps/desktop/src-tauri/src/ai/gateway/adaptors/sd_webui.rs` & `openai.rs` (Support `img2img` when `request.reference` is present; pass aspect ratio dimensions)
  - `apps/desktop/src-tauri/src/matting/commands.rs` (Add post-matting bounding-box alignment and bottom-flush canvas normalization)
  - `apps/desktop/src-tauri/src/agents/asset_planner.rs` (Deduplicate backgrounds by `location_id + time_of_day`; build structured style-locked and edit-style prompts)
- **Acceptance & Tests**:
  - Unit test in `asset_queue/scheduler_tests.rs` proving `figure_<char>_default` finishes and writes its reference anchor before `figure_<char>_smile` starts.
  - Unit test in `pipeline/asset_executor.rs` proving variant tasks pass `Some(reference_path)` to the image generator.
  - Unit test in `matting/commands.rs` verifying bounding-box centering and bottom alignment on synthetic RGBA images.

### Phase 2: Scene-Scoped Execution, Upsert Commits & Continuation Support
**Goal**: Enable running, reviewing, and re-running a single scene (`scene_id`) in isolation without wiping other scenes, and allow running Scene Production on projects with existing content.

- **Files to Modify**:
  - `apps/desktop/src-tauri/src/pipeline/dsl.rs` (Add `setup_recipe()` for Stage 1 and `scene_recipe(scene_id)` for Stage 2 while keeping `default_recipe()` backward-compatible)
  - `apps/desktop/src-tauri/src/pipeline/output_commit.rs` (Change `apply_output()` for `SceneDrafts`, `AssetPlan`, and `Scenes` from full-vector replacement to keyed upsert by `scene_id` / `task.id`; mark only downstream dependents of the edited `scene_id` as stale)
  - `apps/desktop/src-tauri/src/pipeline/scheduler.rs` (Allow Stage 2 scene runs on projects with existing `StoryPlan` / scenes; inject `preceding_scene_tail` into `AgentContext`)
  - `apps/desktop/src-tauri/src/pipeline/commands.rs` (Expose `pipeline_run_scene(project_path, scene_id)` and `pipeline_approve_scene(project_path, scene_id)`)
- **Acceptance & Tests**:
  - Unit tests in `pipeline/output_commit_tests.rs` verifying that committing `SceneDrafts` and `Scenes` for `scene_02` preserves `scene_01` and `scene_03` untouched on disk and in `StoryPlan`.
  - Integration test in `pipeline/tests.rs` running Stage 1 setup followed by two sequential single-scene runs (`opening` then `encounter`).

### Phase 3: Strong Narrative Contracts, Stateful WebGAL Branches & Graph Lint
**Goal**: Upgrade script quality to 25–45 beats per scene with inner monologue, compile `setVar` / conditional choices via WebGAL labels, and enforce graph/variable integrity.

- **Files to Modify**:
  - `apps/desktop/src-tauri/src/story_plan/types.rs` (Add `VariableDef`, `BeatKind`, `BranchEdge.condition`, `BranchEdge.effects`, `ScenePlan.required_beats`, `ScenePlan.forbidden_reveals`, `ScenePlan.emotional_arc`)
  - `apps/desktop/src-tauri/src/agents/outline.rs` (Prompt and validate `variables`, `required_beats`, `emotional_arc`, and `BranchEdge` effects/conditions)
  - `apps/desktop/src-tauri/src/agents/dialogist.rs` (Single-scene prompt with 4-phase beat structure, `Monologue` / `Narration` / `Dialogue` interleaving, and anti-cliche exemplars)
  - `apps/desktop/src-tauri/src/agents/scene.rs` (Compile choice `effects` into `label:` + `setVar:` + `changeScene:` blocks; emit `-next` on staged `changeBg`/`changeFigure` commands)
  - `apps/desktop/src-tauri/src/story_plan/store.rs` (Add BFS reachability check from `entry_scene` to all scenes, dead-end check for non-ending scenes, and variable set/read cross-check)
- **Acceptance & Tests**:
  - Unit tests in `agents/scene.rs` verifying `choose:` with `effects` compiles into valid WebGAL `label:` + `setVar:` blocks and round-trips through `webgal::parser::parse_script`.
  - Unit tests in `story_plan/tests.rs` rejecting unreachable scenes, uninitialized condition variables, and dead-end branches.

### Phase 4: Scene Director UI, Entry-State Live Preview & Bundled Mood Audio
**Goal**: Surface the Two-Stage Director workflow in `FlowBoard`, allow one-click scene preview with simulated entry variables, and provide built-in fallback BGM/SFX.

- **Files to Modify**:
  - `apps/desktop/src/app/components/FlowBoard.tsx` & `FlowStepInspector.tsx` (Render Stage 1 Setup Card + Stage 2 Interactive Scene Queue with per-scene `生成本场`, `试玩本场`, `重抽立绘/背景`, and `通过并锁定` actions)
  - `apps/desktop/src/app/hooks/useRuntimePreview.ts` (Support previewing a target `scene.file` with pre-injected `setVar` entry state via `TEMP_SCENE` harness)
  - `apps/desktop/src-tauri/src/asset_queue/binder.rs` & bundled resources (Provide a lightweight royalty-free mood audio fallback pack for `daily`, `mystery`, `tension`, `warm`, `sad`, `climax` when user audio is not imported)
- **Acceptance & Tests**:
  - Frontend tests for `FlowBoard` scene queue transitions (`pending → drafted → approved → stale`).
  - End-to-end verification via `agent-harness` on a **Golden Vertical Slice** (2 characters, 1 pre-supplied sprite, 4 scenes, 1 affection variable, 2 endings) confirming visual consistency, playable WebGAL branch execution, and zero unreferenced assets.
