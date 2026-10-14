import { createHashRouter } from "react-router";

export const router = createHashRouter([
  {
    path: "/",
    lazy: async () => {
      const { ProjectHome } = await import("./components/ProjectHome");
      return { Component: ProjectHome };
    },
  },
  {
    path: "/flow/:projectId",
    lazy: async () => {
      const { FlowBoardPage } = await import("./components/FlowBoardPage");
      return { Component: FlowBoardPage };
    },
  },
  {
    path: "/editor/:projectId",
    lazy: async () => {
      const { StoryEditor } = await import("./components/StoryEditor");
      return { Component: StoryEditor };
    },
  },
  {
    path: "/editor/:projectId/memory",
    lazy: async () => {
      const { ProjectMemoryPage } = await import("./components/ProjectMemoryPage");
      return { Component: ProjectMemoryPage };
    },
  },
  {
    path: "/editor/:projectId/assets",
    lazy: async () => {
      const { AssetManager } = await import("./components/AssetManager");
      return { Component: AssetManager };
    },
  },
]);
