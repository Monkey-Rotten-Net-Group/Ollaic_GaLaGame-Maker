import { describe, expect, it } from "vitest";
import type { StoryPlan } from "./pipeline-types";
import {
  applyEffectMutation,
  deriveSceneEntryVariables,
  wrapScriptWithEntryVariables,
} from "./scene-entry-state";

describe("scene-entry-state", () => {
  it("applies effect mutations correctly", () => {
    const vars: Record<string, string> = { trust: "0", flag: "false" };
    applyEffectMutation(vars, "trust=trust+2");
    expect(vars.trust).toBe("2");

    applyEffectMutation(vars, "trust+=3");
    expect(vars.trust).toBe("5");

    applyEffectMutation(vars, "trust-=1");
    expect(vars.trust).toBe("4");

    applyEffectMutation(vars, "flag=true");
    expect(vars.flag).toBe("true");
  });

  it("derives entry variables along path from entry scene", () => {
    const plan: StoryPlan = {
      version: 1,
      prompt: "test",
      synopsis: "synopsis",
      memory: { worldbook: "world", glossary: {} },
      chapters: [],
      characters: [],
      scenes: [
        "start.txt",
        "investigation.txt",
        "decision.txt",
        "ending_trust.txt",
      ],
      scenePlans: [
        {
          id: "opening",
          file: "start.txt",
          chapterId: "c1",
          title: "开场",
          summary: "",
          characterIds: [],
        },
        {
          id: "investigation",
          file: "investigation.txt",
          chapterId: "c1",
          title: "调查",
          summary: "",
          characterIds: [],
        },
        {
          id: "decision",
          file: "decision.txt",
          chapterId: "c1",
          title: "决断",
          summary: "",
          characterIds: [],
        },
        {
          id: "ending",
          file: "ending_trust.txt",
          chapterId: "c1",
          title: "结局",
          summary: "",
          characterIds: [],
        },
      ],
      sceneDrafts: [],
      assetPlan: [],
      pipelineRuns: [],
      variables: [
        {
          id: "linxia_trust",
          kind: "integer",
          initialValue: "0",
          description: "好感度",
        },
        {
          id: "investigated",
          kind: "boolean",
          initialValue: "false",
          description: "是否完成调查",
        },
      ],
      branches: {
        entryScene: "start.txt",
        edges: [
          {
            from: "start.txt",
            to: "investigation.txt",
            effects: ["linxia_trust=linxia_trust+1"],
          },
          {
            from: "investigation.txt",
            to: "decision.txt",
            effects: ["investigated=true", "linxia_trust+=2"],
          },
          {
            from: "decision.txt",
            to: "ending_trust.txt",
            effects: ["linxia_trust=linxia_trust+1"],
          },
        ],
      },
    };

    // Entry scene has initial variables
    const entryState = deriveSceneEntryVariables(plan, "start.txt");
    expect(entryState.variables.linxia_trust).toBe("0");
    expect(entryState.variables.investigated).toBe("false");
    expect(entryState.precedingScenes).toEqual([]);

    // Investigation scene has start.txt effects
    const invState = deriveSceneEntryVariables(plan, "investigation");
    expect(invState.variables.linxia_trust).toBe("1");
    expect(invState.precedingScenes).toEqual(["start.txt"]);

    // Decision scene accumulated all effects along path
    const decState = deriveSceneEntryVariables(plan, "decision.txt");
    expect(decState.variables.linxia_trust).toBe("3");
    expect(decState.variables.investigated).toBe("true");
    expect(decState.precedingScenes).toEqual([
      "start.txt",
      "investigation.txt",
    ]);
  });

  it("derives entry variables when branch edges use canonical scene IDs that differ from filenames", () => {
    const plan: StoryPlan = {
      version: 1,
      prompt: "test",
      synopsis: "synopsis",
      memory: { worldbook: "world", glossary: {} },
      chapters: [],
      characters: [],
      scenes: ["start.txt", "chapter_01.txt", "decision.txt"],
      scenePlans: [
        {
          id: "opening",
          file: "start.txt",
          chapterId: "c1",
          title: "开场",
          summary: "",
          characterIds: [],
        },
        {
          id: "encounter",
          file: "chapter_01.txt",
          chapterId: "c1",
          title: "相遇",
          summary: "",
          characterIds: [],
        },
        {
          id: "decision",
          file: "decision.txt",
          chapterId: "c1",
          title: "抉择",
          summary: "",
          characterIds: [],
        },
      ],
      sceneDrafts: [],
      assetPlan: [],
      pipelineRuns: [],
      variables: [
        {
          id: "linxia_trust",
          kind: "integer",
          initialValue: "0",
          description: "好感度",
        },
      ],
      branches: {
        entryScene: "opening",
        edges: [
          {
            from: "opening",
            to: "encounter",
            effects: ["linxia_trust=linxia_trust+1"],
          },
          {
            from: "encounter",
            to: "decision",
            effects: ["linxia_trust=linxia_trust+2"],
          },
        ],
      },
    };

    const byId = deriveSceneEntryVariables(plan, "decision");
    expect(byId.variables.linxia_trust).toBe("3");
    expect(byId.precedingScenes).toEqual(["opening", "encounter"]);

    const byFile = deriveSceneEntryVariables(plan, "decision.txt");
    expect(byFile.variables.linxia_trust).toBe("3");
    expect(byFile.precedingScenes).toEqual(["opening", "encounter"]);
  });

  it("wraps script with setVar statements", () => {
    const raw = ":夕阳下的旧校舍。;\n陆川:我们到了。;";
    const wrapped = wrapScriptWithEntryVariables(raw, {
      linxia_trust: "3",
      investigated: "true",
    });

    expect(wrapped).toContain("; --- Ollaic Injected Entry State ---");
    expect(wrapped).toContain("setVar:linxia_trust=3;");
    expect(wrapped).toContain("setVar:investigated=true;");
    expect(wrapped).toContain("; -----------------------------------");
    expect(wrapped).toContain(":夕阳下的旧校舍。;");
  });
});
