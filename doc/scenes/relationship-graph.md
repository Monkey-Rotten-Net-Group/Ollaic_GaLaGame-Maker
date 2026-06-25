# 场景关系图

以**不可拖动**的关系图展示场景间的跳转关系,点击节点即可切换场景。

## 布局与渲染

- **自动布局**:以 `start.txt`(否则首个场景)为根做 **BFS 分层**,每层一行、行内均匀居中;无入边的孤立场景归到末行。当用户在编辑器中修改当前场景的跳转/选择节点时，关系图会自动提取并对比最新连线，实时触发更新重排，无需等待保存落盘。
- **SVG 连线 + HTML 节点**:节点为圆角矩形(当前场景高亮),连线为**正交直角路径 + 箭头**;全屏视图会适配容器宽度,侧栏视图保留节点可读尺寸并在密集项目中横向滚动。
- **节点标签**:优先显示章节名(`chapter`)，并且现在会**直接在分支卡片中显示场景大纲(`outline`)**；悬停 `<title>` 依然可显示完整的文件名/章节/大纲。

## 连线

由 `sceneLinkMap` 推导:每条 `changeScene`/`callScene`/`choose` 目标生成一条边。**目标按精确文件名匹配场景**——目标值须等于真实场景文件名才会连线(在详情面板用[场景下拉选择器](../editor/node-editing.md)可保证一致)。

## 交互

- **点击**节点:切换/打开该场景。
- **内嵌面板** `SceneWorldlinePanel`:左侧小图 + 当前场景的指令索引列表。
- **全屏视图** `FullScreenWorldline`:更大的关系图 + 工具栏(返回、场景计数、新建、管理)+ 右侧当前场景索引;**节点右键菜单**支持切换/重命名/删除场景。

## 相关源码
- `design/src/app/components/SceneGraph.tsx`(`computeSceneGraphLayout` / `buildOrthogonalPath`)
- `design/src/app/components/StoryEditor.tsx`(`SceneWorldlinePanel` / `FullScreenWorldline`)
