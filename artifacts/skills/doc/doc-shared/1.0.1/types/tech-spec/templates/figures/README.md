# 技术 Spec 图源说明

| 文件 | 类型 | 用途 | 引擎（design.md §4.2） |
|---|---|---|---|
| current-arch.fig.json | svgkit layered-arch | 第 3 节「现状架构」 | svgkit 品牌模板 |
| target-arch.fig.json | svgkit layered-arch | 第 4.1 节「方案设计 - 架构」 | svgkit 品牌模板 |
| sequence.mmd | Mermaid sequence | 第 4.2 节「关键流程时序」 | Mermaid 主引擎 |
| data-model.mmd | Mermaid erDiagram | 第 4.3 节「数据模型」 | Mermaid 主引擎 |
| state-machine.mmd | Mermaid stateDiagram-v2 | 第 4.4 节「状态机」 | Mermaid 主引擎 |

## .fig.json 分层架构 schema（本包自拟，design.md §4.2 未给出具体字段，按其"分层架构需要版式控制"的思路拟定）

```
{
  "kind": "layered-arch",
  "title": "字符串，图题",
  "layers": [
    { "id": "层标识", "label": "层名称", "nodes": [ { "id": "节点标识", "label": "节点名称" } ] }
  ],
  "edges": [
    { "from": "节点标识", "to": "节点标识", "label": "可选，边标注" }
  ]
}
```

渲染规则（设计意图，未实现）：
- layers 数组顺序即渲染顺序，从上到下画水平分层带（客户端层在最上，数据层在最下，符合技术架构图的阅读习惯）。
- 每层内 nodes 横向等宽排列。
- edges 按 from/to 的节点 id 画箭头，可跨层；label 为空时不画标注文字。
- 配色不在本文件内写死，渲染时读取 tokens.json 的 color 组（primary、tint、border 等），保证与其他图表色板一致。
- 该 schema 若与 doc-figures 实现子代理最终采用的字段不一致，以 doc-figures 的实现为准；本文件是内容侧的合理提案，不是引擎侧的最终契约（见 OPEN-QUESTIONS.md）。

架构图为什么不用 Mermaid：design.md §4.2 明确"分层架构需要版式控制，Mermaid 布局不稳定"，故架构图默认走 svgkit，时序/ER/状态机走 Mermaid（两端原生可编辑）。
