# 测试报告图源说明

| 文件 | 类型 | 用途 |
|---|---|---|
| defect-trend.mmd | Mermaid xychart-beta | 第 3 节「缺陷统计」的发现趋势图（柱状新增 + 折线累计） |

xychart-beta 是 Mermaid 较新版本内置的图表类型，走 design.md §4.1 的 Mermaid 主引擎通道。若 doc-figures 实现时 vendoring 的 mermaid.min.js 版本（design.md §7 阶段 0 锁定 11.17.2）不支持 xychart-beta，退化方案：改用数据表（通过率/缺陷数按周列成表格）替代图表，不强制要求图；已记入 OPEN-QUESTIONS.md 供实现子代理核实版本支持情况。
