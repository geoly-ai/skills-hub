# PRD 图源说明

| 文件 | 类型 | 用途 |
|---|---|---|
| user-flow.mmd | Mermaid flowchart | 第 4 节「用户与场景」的核心流程图，替换为实际产品路径 |

PRD 通常只需要一张核心流程图（design.md §5.2 质检要求「至少一张用户流程图」）。若功能需求复杂到需要状态图（如审批 / 生命周期类需求），可参照 tech-spec 包的 figures 约定新增 *.mmd（stateDiagram-v2），命名与正文 ![...](figures/x.mmd){#fig:x} 一致。
