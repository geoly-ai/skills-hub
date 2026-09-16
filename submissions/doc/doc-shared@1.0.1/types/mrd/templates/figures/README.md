# MRD 图源说明

| 文件 | 类型 | 用途 |
|---|---|---|
| positioning.mmd | Mermaid quadrantChart | 第 3 节「竞争分析」定位象限图，横纵轴替换为实际比较维度（如价格 × 功能完整度） |

quadrantChart 是 Mermaid 内置图类型，走 design.md §4.1 的 Mermaid 主引擎通道，PDF 与飞书画板两端复用同一份源。若需要更复杂的竞品矩阵可视化（如多维度热图），改用 svgkit 模板（参考 test-plan 包的需求覆盖矩阵热图约定）。
