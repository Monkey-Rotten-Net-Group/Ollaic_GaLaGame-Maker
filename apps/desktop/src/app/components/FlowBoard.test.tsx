import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PipelineEvent, RunState } from "../lib/pipeline-types";
import { FlowBoard } from "./FlowBoard";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

let lastListenHandler: ((event: { payload: PipelineEvent }) => void) | null =
  null;
let listenHandlers: Array<(event: { payload: PipelineEvent }) => void> = [];

function runState(status: RunState["status"] = "running"): RunState {
  return {
    scope: { type: "setup" },
    runId: "run_1",
    projectPath: "/tmp/proj",
    prompt: "brief",
    status,
    startedAt: 1,
    updatedAt: 2,
    pinned: false,
    allowLocalFallback: false,
    steps: [
      {
        def: {
          id: "plan",
          kind: "plan",
          dependsOn: [],
          agent: null,
          prompt: "",
        },
        status: status === "completed" ? "succeeded" : "pending",
        attempt: status === "completed" ? 1 : 0,
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
      {
        def: {
          id: "outline",
          kind: "outline",
          dependsOn: ["plan"],
          agent: null,
          prompt: "",
        },
        status: status === "completed" ? "succeeded" : "pending",
        attempt: status === "completed" ? 1 : 0,
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
      {
        def: {
          id: "anchorPlan",
          kind: "asset",
          dependsOn: ["character"],
          agent: "anchorPlanner",
          prompt: "",
        },
        status: status === "completed" ? "succeeded" : "pending",
        attempt: status === "completed" ? 1 : 0,
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
  lastListenHandler = null;
  listenHandlers = [];
  mockedInvoke.mockReset();
  mockedListen.mockReset();
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "pipeline_get_capabilities")
      return Promise.resolve({
        chatError: null,
        assetError: null,
      } as unknown);
    if (cmd === "pipeline_run_setup") return Promise.resolve("run_1" as unknown);
    if (cmd === "pipeline_get_state")
      return Promise.resolve(runState() as unknown);
    if (cmd === "pipeline_list_runs") return Promise.resolve([] as unknown);
    if (cmd === "pipeline_get_plan") return Promise.resolve(null as unknown);
    return Promise.resolve(undefined);
  });
  mockedListen.mockImplementation((_channel, handler) => {
    lastListenHandler = handler as typeof lastListenHandler;
    listenHandlers.push(handler as (event: { payload: PipelineEvent }) => void);
    return Promise.resolve((() => {}) as unknown as ReturnType<typeof listen>);
  });
});

function emit(event: PipelineEvent) {
  act(() => {
    lastListenHandler?.({ payload: event });
  });
}

function stepStatus(id: string): string | null {
  return (
    document
      .querySelector(`[data-step-id="${id}"]`)
      ?.getAttribute("data-step-status") ?? null
  );
}

describe("FlowBoard (Two-Stage Scene-Centric Workflow)", () => {
  it("disables Stage 1 launch while the brief is empty", () => {
    render(<FlowBoard projectPath="/tmp/proj" />);
    expect(
      screen.getByRole("button", { name: /启动 Stage 1：立项与角色定锚/ }),
    ).toBeDisabled();
  });

  it("blocks missing provider capabilities until local fallback is enabled", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pipeline_get_capabilities")
        return Promise.resolve({
          chatError: "未配置对话模型",
          assetError: "未配置素材接口",
        } as unknown);
      if (cmd === "pipeline_list_runs") return Promise.resolve([] as unknown);
      if (cmd === "pipeline_get_plan") return Promise.resolve(null as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() =>
      expect(screen.getByLabelText("production brief")).toBeEnabled(),
    );
    await user.type(screen.getByLabelText("production brief"), "本地草稿");
    const launchBtn = screen.getByRole("button", {
      name: /启动 Stage 1：立项与角色定锚/,
    });
    expect(launchBtn).toBeDisabled();

    await user.click(screen.getByLabelText("允许本地内容降级"));
    expect(launchBtn).toBeEnabled();
    await user.click(launchBtn);
    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_run_setup", {
      projectPath: "/tmp/proj",
      prompt: "本地草稿",
      allowLocalFallback: true,
    });
  });

  it("preserves the brief when Stage 1 launch fails", async () => {
    const initial = mockedInvoke.getMockImplementation()!;
    mockedInvoke.mockImplementation((cmd: string, args) =>
      cmd === "pipeline_run_setup"
        ? Promise.reject(new Error("项目已有故事内容；请使用单场景生产继续编辑。"))
        : initial(cmd, args),
    );
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() =>
      expect(screen.getByLabelText("production brief")).toBeEnabled(),
    );
    await user.type(screen.getByLabelText("production brief"), "保留这份目标");
    await user.click(
      screen.getByRole("button", { name: /启动 Stage 1：立项与角色定锚/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "项目已有故事内容",
    );
    expect(screen.getByLabelText("production brief")).toHaveValue(
      "保留这份目标",
    );
  });

  it("starts Stage 1 setup and updates step statuses from streamed events", async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await vi.waitFor(() =>
      expect(screen.getByLabelText("production brief")).toBeEnabled(),
    );
    await user.type(
      screen.getByLabelText("production brief"),
      "赛博朋克校园恋爱",
    );
    await user.click(
      screen.getByRole("button", { name: /启动 Stage 1：立项与角色定锚/ }),
    );

    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalled());
    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_run_setup", {
      projectPath: "/tmp/proj",
      prompt: "赛博朋克校园恋爱",
      allowLocalFallback: false,
    });
    expect(mockedListen).toHaveBeenCalledWith(
      "pipeline:run_1",
      expect.any(Function),
    );

    expect(stepStatus("plan")).toBe("pending");
    expect(stepStatus("outline")).toBe("pending");
    expect(stepStatus("anchorPlan")).toBe("pending");

    emit({ type: "runStarted", runId: "run_1" });
    emit({ type: "stepStarted", runId: "run_1", stepId: "plan", kind: "plan" });
    expect(stepStatus("plan")).toBe("running");

    emit({
      type: "stepSucceeded",
      runId: "run_1",
      stepId: "plan",
      output: null,
    });
    expect(stepStatus("plan")).toBe("succeeded");

    emit({
      type: "stepStarted",
      runId: "run_1",
      stepId: "outline",
      kind: "outline",
    });
    emit({
      type: "stepSucceeded",
      runId: "run_1",
      stepId: "outline",
      output: null,
    });
    expect(stepStatus("outline")).toBe("succeeded");

    emit({
      type: "stepStarted",
      runId: "run_1",
      stepId: "anchorPlan",
      kind: "asset",
    });
    emit({
      type: "stepSucceeded",
      runId: "run_1",
      stepId: "anchorPlan",
      output: null,
    });
    expect(stepStatus("anchorPlan")).toBe("succeeded");

    emit({ type: "runCompleted", runId: "run_1" });
    expect(screen.getByTestId("flow-run-status")).toHaveTextContent("已完成");
  });

  it("shows live asset queue progress and refreshes it on the asset event", async () => {
    const user = userEvent.setup();
    const queued = runState("running");
    queued.steps.push({
      def: {
        id: "media-production",
        kind: "asset",
        dependsOn: ["anchorPlan"],
        agent: "assetQueue",
        prompt: "",
      },
      status: "running",
      attempt: 1,
      output: null,
      error: null,
      startedAt: 2,
      finishedAt: null,
    });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pipeline_get_capabilities")
        return Promise.resolve({
          chatError: null,
          assetError: null,
        } as unknown);
      if (cmd === "pipeline_list_runs")
        return Promise.resolve([queued] as unknown);
      if (cmd === "pipeline_get_state")
        return Promise.resolve(queued as unknown);
      if (cmd === "asset_queue_get" || cmd === "asset_queue_promote_artifact")
        return Promise.resolve({
          runId: "run_1",
          updatedAt: 3,
          tasks: [
            {
              id: "bg",
              kind: "background",
              targetStem: "bg",
              prompt: "背景",
              status: "succeeded",
              attempts: [
                { attempt: 1, artifact: ".ollaic/artifacts/bg/1.png" },
              ],
              assetFile:
                cmd === "asset_queue_promote_artifact"
                  ? "bg-promoted.png"
                  : "bg.png",
            },
            {
              id: "voice",
              kind: "tts",
              targetStem: "voice",
              prompt: "对白",
              status: "running",
              attempts: [{ attempt: 1 }],
            },
          ],
        } as unknown);
      return Promise.resolve(undefined);
    });

    render(<FlowBoard projectPath="/tmp/proj" />);

    expect(await screen.findByText("1/2 已处理")).toBeInTheDocument();
    expect(mockedInvoke).toHaveBeenCalledWith("asset_queue_get", {
      projectPath: "/tmp/proj",
    });
    expect(screen.getByLabelText("media-production 步骤进度")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    await user.click(
      screen.getByRole("button", { name: "查看media-production" }),
    );
    await user.click(screen.getByRole("tab", { name: "输出" }));
    await user.click(screen.getByRole("button", { name: "应用 bg 候选 1 到素材库" }));
    expect(mockedInvoke).toHaveBeenCalledWith("asset_queue_promote_artifact", {
      projectPath: "/tmp/proj",
      taskId: "bg",
      attempt: 1,
    });
    expect(
      await screen.findByText("正式素材 bg-promoted.png"),
    ).toBeInTheDocument();
  });

  it("switches to pause, resume, stepOnce, and stop controls while active", async () => {
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);
    await vi.waitFor(() =>
      expect(screen.getByLabelText("production brief")).toBeEnabled(),
    );
    await user.type(screen.getByLabelText("production brief"), "x");
    await user.click(
      screen.getByRole("button", { name: /启动 Stage 1：立项与角色定锚/ }),
    );
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalled());

    emit({ type: "runStarted", runId: "run_1" });
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();

    emit({ type: "stepStarted", runId: "run_1", stepId: "plan", kind: "plan" });
    emit({ type: "runPaused", runId: "run_1" });
    expect(
      screen.getByRole("button", { name: "继续运行" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "单步" }));
    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_step_once", {
      runId: "run_1",
      projectPath: "/tmp/proj",
    });

    emit({ type: "runResumed", runId: "run_1" });
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_stop", {
      runId: "run_1",
      projectPath: "/tmp/proj",
    });
  });

  it("discovers a persisted paused run and resumes it through crash recovery", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pipeline_get_capabilities")
        return Promise.resolve({
          chatError: null,
          assetError: null,
        } as unknown);
      if (cmd === "pipeline_list_runs")
        return Promise.resolve([runState("paused")] as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    const resume = await screen.findByRole("button", { name: "恢复运行" });
    await user.click(resume);

    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_resume_run", {
      projectPath: "/tmp/proj",
      runId: "run_1",
    });
  });

  it("edits a step prompt and reruns it from the inspector", async () => {
    const failed = runState("failed");
    failed.steps[0].status = "failed";
    failed.steps[0].def.prompt = "旧提示词";
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pipeline_get_capabilities")
        return Promise.resolve({
          chatError: null,
          assetError: null,
        } as unknown);
      if (cmd === "pipeline_list_runs")
        return Promise.resolve([failed] as unknown);
      if (cmd === "pipeline_get_state")
        return Promise.resolve(failed as unknown);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    await user.click(
      await screen.findByRole("button", { name: "查看故事规划" }),
    );
    const promptEditor = screen.getByLabelText("plan 步骤 Prompt");
    await user.clear(promptEditor);
    await user.type(promptEditor, "突出女主冲突与选择");
    await user.click(screen.getByRole("button", { name: "保存并重跑" }));

    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_update_step_prompt", {
      runId: "run_1",
      stepId: "plan",
      prompt: "突出女主冲突与选择",
      projectPath: "/tmp/proj",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_retry_step", {
      runId: "run_1",
      stepId: "plan",
      projectPath: "/tmp/proj",
    });
  });

  it("renders Stage 2 Scene Production Queue, preserves Stage 1 summary during scene runs, and triggers scene operations", async () => {
    const planWithScenes = {
      version: 1,
      prompt: "brief",
      synopsis: "天台与旧校舍的悬疑故事",
      memory: { worldbook: "", glossary: {} },
      chapters: [{ id: "c1", title: "第一章", summary: "" }],
      characters: [
        {
          id: "heroine",
          name: "林夏",
          aliases: [],
          description: "",
          personality: "",
          dialogueStyle: "",
          gender: "female",
          age: "17",
        },
      ],
      scenes: ["start.txt", "investigation.txt"],
      scenePlans: [
        {
          id: "opening",
          file: "start.txt",
          chapterId: "c1",
          title: "天台黄昏",
          summary: "开场相遇",
          characterIds: ["heroine"],
          approvalStatus: "approved",
        },
        {
          id: "investigation",
          file: "investigation.txt",
          chapterId: "c1",
          title: "旧校舍调查",
          summary: "两人搜集线索",
          characterIds: ["heroine"],
          approvalStatus: "drafted",
        },
        {
          id: "decision",
          file: "decision.txt",
          chapterId: "c1",
          title: "抉择时刻",
          summary: "关键分支",
          characterIds: ["heroine"],
          approvalStatus: "pending",
        },
      ],
      sceneDrafts: [
        {
          sceneId: "investigation",
          title: "旧校舍调查",
          beats: [{ speaker: "林夏", text: "门好像是锁着的。" }],
        },
      ],
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
            to: "investigation",
            effects: ["linxia_trust=linxia_trust+1"],
          },
          {
            from: "investigation",
            to: "decision",
            effects: ["linxia_trust=linxia_trust+2"],
          },
        ],
      },
    };

    const sceneRunState: RunState = {
      scope: { type: "scene", sceneId: "decision" },
      runId: "run_scene_1",
      projectPath: "/tmp/proj",
      prompt: "brief",
      status: "running",
      startedAt: 10,
      updatedAt: 20,
      pinned: false,
      allowLocalFallback: false,
      steps: [
        {
          def: {
            id: "dialogist",
            kind: "scene",
            dependsOn: [],
            agent: "dialogist",
            prompt: "",
          },
          status: "running",
          attempt: 1,
        },
        {
          def: {
            id: "scene",
            kind: "scene",
            dependsOn: ["assetPlan"],
            agent: "sceneScript",
            prompt: "",
          },
          status: "pending",
          attempt: 0,
        },
      ],
    };

    let activeState = runState("completed");
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "pipeline_get_capabilities")
        return Promise.resolve({
          chatError: null,
          assetError: null,
        } as unknown);
      if (cmd === "pipeline_list_runs")
        return Promise.resolve([activeState] as unknown);
      if (cmd === "pipeline_get_state")
        return Promise.resolve(activeState as unknown);
      if (cmd === "pipeline_get_plan")
        return Promise.resolve(planWithScenes as unknown);
      if (cmd === "pipeline_run_scene") {
        activeState = sceneRunState;
        return Promise.resolve("run_scene_1" as unknown);
      }
      if (cmd === "pipeline_approve_scene")
        return Promise.resolve(planWithScenes as unknown);
      if (cmd === "read_file_text")
        return Promise.resolve("林夏:门好像是锁着的。;" as unknown);
      return Promise.resolve(undefined);
    });

    const user = userEvent.setup();
    render(<FlowBoard projectPath="/tmp/proj" />);

    expect(
      await screen.findByText(/Stage 2 · 分场制作队列/),
    ).toBeInTheDocument();
    expect(screen.getByText("天台黄昏")).toBeInTheDocument();
    expect(screen.getByText("旧校舍调查")).toBeInTheDocument();
    expect(screen.getByText("抉择时刻")).toBeInTheDocument();

    await user.click(screen.getByText("抉择时刻"));
    expect(screen.getByText("当前运行没有此场景的执行记录。")).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /步骤 Prompt/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭检查器' }));

    // Trigger 单场景生成「生成本场」 on decision (pending)
    const decisionCard = screen.getByTestId("scene-card-decision");
    const runBtn = withinCard(decisionCard, "生成本场");
    await user.click(runBtn);
    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_run_scene", {
      projectPath: "/tmp/proj",
      sceneId: "decision",
      allowLocalFallback: false,
    });

    // Stage 1 synopsis and character anchors stay visible while Stage 2 single-scene pipeline runs
    expect(
      await screen.findByText("Stage 2 · 单场制作 (decision)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("天台与旧校舍的悬疑故事"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("当前单场制作流水线 (decision)"),
    ).toBeInTheDocument();

    await user.click(screen.getByText("旧校舍调查"));
    expect(screen.getByText("当前运行没有此场景的执行记录。")).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /步骤 Prompt/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭检查器' }));

    // Trigger 「通过并锁定」 on investigation (drafted)
    const invCard = screen.getByTestId("scene-card-investigation");
    const approveBtn = withinCard(invCard, "通过并锁定");
    await user.click(approveBtn);
    expect(mockedInvoke).toHaveBeenCalledWith("pipeline_approve_scene", {
      projectPath: "/tmp/proj",
      sceneId: "investigation",
    });

    // Trigger 「试玩本场」
    const previewBtn = withinCard(invCard, "试玩本场");
    await user.click(previewBtn);
    expect(
      await screen.findByText(/单场即时试玩：旧校舍调查/),
    ).toBeInTheDocument();
    expect(screen.getByText("入场模拟变量")).toBeInTheDocument();
  });
});

function withinCard(container: HTMLElement, buttonText: string): HTMLElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(buttonText),
  );
  if (!btn) throw new Error(`Button ${buttonText} not found in container`);
  return btn;
}
