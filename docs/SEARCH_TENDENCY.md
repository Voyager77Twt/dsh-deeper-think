# 搜索倾向测试记录

> 目标：不承诺“搜得更全”，只检验有没有“让模型搜更多”的倾向/迹象。
> 方法：同一提示词、同一默认模型（未指定模型覆盖），分别跑关闭/开启插件的子会话，从 DSH 会话日志统计 `tool/call` 次数与 `usage` token。

## 机制层证据（不依赖模型）

- `search-gate.test.mjs`：research-first 未搜先写被拒；真实搜索后放行；并行搜索计入 in-flight。
- 首步必注入 `SEARCH_PLAN`；用户任务识别会跳过 `runtime-context`/`time-context`/`agent-instructions` 合成消息。
- 结果：装置“会催、会拦”；是否真去搜仍由模型决定。

## 实测 1：MCP 是否官方提供（研究型）

提示词：DeepSeek Harness 是否内置或官方提供 MCP 服务器配置插件？给结论和 1–2 条依据；≤200 字。

| 组 | web_search | web_fetch | total token | 倍率 |
|---|---|---|---|---|
| 基线 | 2 | 8 | 363,091 | 1.00× |
| 0.1.11 research-first | 2 | 2 | 425,376 | 1.17× |

结论：两组搜索查询一样多；插件组 fetch 更少（预算/计划限制）。**这一组没有“搜更多”的迹象。**

## 实测 2：FizzBuzz + “2026 最新最佳实践”（本地实现）

| 组 | web 调用 | total token | 倍率 |
|---|---|---|---|
| 基线 | 0 | 188,865 | 1.00× |
| 0.1.15 build-first | 0 | 293,503 | 1.55× |

插件组模型选择 `build-first`，没有搜索。

## 已定位的干扰

插件旧版读“最后一条用户消息”时，把 `runtime-context`/`time-context` 当成用户任务，导致“最新最佳实践”被误判为本地改动，检索提示未正确出现。0.1.16 已修：
- `lastUserText` 跳过 `dsh-deeper-think`/`runtime-context`/`time-context`/`agent-instructions`；
- 新增测试：合成消息在最后，仍能识别真实任务。

## 待做（需要重启 DSH 加载 0.1.16）

用相同两组提示词重跑：

1. 研究型：预期首步出现 `SEARCH_PLAN`，research-first 时未搜先写被拒；
2. FizzBuzz：预期“最新最佳实践”被识别为 strong，模型更可能选 research-first；
3. 记录 `tool/call`（`web_search`/`web_fetch`）与 token，判断是否出现“搜更多”的倾向。

## 复跑工具

```bash
node D:\AI\work\_dsh_probe\loop\_tools\toolcount.mjs <session-id> [...]
node D:\AI\work\_dsh_probe\loop\_tools\tokens.mjs <session-id> [...]
```

## 修复后实测（0.1.16，严格模式默认关闭）

提示词同“FizzBuzz + 2026 最新最佳实践”；基线仍是 0 次 web 调用、188,865 token。

| 组 | web 调用 | total token | 倍率 |
|---|---|---|---|
| 基线 | 0 | 188,865 | 1.00× |
| 0.1.16 自动判断 | `web_index` 1 + `web_call` 1 | 124,450 | 0.66× |
| 0.1.16 严格模式 | `web_call` 2（1 次报错） | 162,913 | 0.86× |

- 修复后分类正确识别为 strong（`search hint kind=strong userText=yes`）；
- 自动判断下模型仍写 `build-first`，但实际尝试了 `web_call`；
- 严格模式下宿主拦住写文件，模型被迫先搜，出现 2 次 `web_call`。
- 结论：**严格模式有明确的“更多搜索”迹象**；自动模式有提示但模型仍可拒绝。两者都不保证“搜得更全”。
- 补充（5048 自动判断会话）：模型实际用 `web_call` 查了 PEP 649（来源 docs.python.org/3.14），并据此决定保留 `from __future__ import annotations`；说明自动模式也会为“最新最佳实践”真的查一次。

## 0.1.18 预算口径

0.1.18 起“查询”和“抓取”分开计数：`web_search`/`web_call search.run` 算查询（默认上限 8），`web_fetch`/`web_call read.fetch` 算来源（默认上限 24）。所以上表里的 “2 search + 8 fetch” 是 **2 次查询 + 8 个来源**，不是 10 次搜索；旧版把来源也算进同一预算，压低了插件组的抓取数。

