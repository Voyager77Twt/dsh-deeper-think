# 宿主接线清单（D1 的另一半，勿忘）

> 来源：2026-10-19 子智能体审查 D1 ——「开关是安慰剂：宿主 apply 是空函数，policy 层从未被装载」。
> 当前状态：**只上了 UI，宿主未接线**。设置卡已诚实标注"尚未接入宿主"。
> 做接口/整合时，逐条勾掉下面这些；**不要只做 UI 就宣布完成**。


## H0（2026-10-19 新教训，先看这条）

在 `agent/pre-step` 里**手工拼一个 `{role:"user", content:[{type:"text",...}]}` 追加到 messages 会导致 session-error**：
`Cannot read properties of undefined (reading 'kind')`——DSH 的 message 需要完整信封（source/kind 等）。

正确做法：
1. 用 `@deepseek-ai/dsh-llm` 的 `createUserMessage(...)` 构造消息；
2. 先在**子智能体会话**里验证（不影响主会话）；
3. 观察 `harness\logs\harness.log` 无 `session-error` 再放行；
4. 任何钩子异常都必须被 try/catch 吞掉，不能影响会话。

在此之前，宿主保持零接触（`apply(){}`）。

## 一、宿主必须做的五件事

| # | 钩子 | 动作 | 依赖 | 验证 |
|---|---|---|---|---|
| H1 | `agent/pre-step` | 调 `preStepReminder({seatOn, files})` 注入提醒 | 需要 inject 正确的服务；**不能**读未声明的 ctx 属性（上次安全模式的根因） | 日志里能看到注入文本；模型下一步照做 |
| H2 | `tools/pre-execute` | 调 `gateDecision(...)`，拒绝时把 reason 回给模型 | 拿得到 toolName / targetPath / 工作目录文件列表 | 未写边界时写产物被拒；写了边界后放行 |
| H3 | `tools/post-execute` | 调 `postWriteHint(...)`，产物写出后提示验收 | 同上 | 不重复提示验收/日志文件（D2 已修） |
| H4 | `turn/end` | 跑 `v4check.py`，用 `turnEndVerdict` 把失败码写进卡片 | 需要能 spawn 子进程；checker 可能不存在（要降级为"未审查"） | 失败时卡片显示 `未通过核验：T3` 之类 |
| H5 | 客户端 ↔ 宿主通道 | 把闪电开关状态同步给宿主（seat store 同源） | 目前 client 只有模块内 Map，`props.onChange` 无提供者 | 点开关后，宿主读到的状态同步变化 |

## 二、接线时**必须**遵守的安全约束（来自 2026-10-18 安全模式事故）

1. **不读未声明的服务**：`ctx.log` 这类属性访问在 cordis 里会直接抛
   `Error: cannot get property "log" without inject`；可选链救不了。
2. `inject` 先按最小集合声明；不确定的服务名先查 `cordis_inspect_query`，不要猜。
3. 每个钩子内部 `try/catch`，**绝不能因为一个钩子抛错让整机启动失败**。
4. 上真机前先跑 `tests/host-load.test.mjs` 的 strict-proxy 版本（模拟"任何未声明属性即抛"）。
5. 部署顺序：先 workspace 副本 → 单独进程验证 → 再复制到 vendor → 重启 → 观察日志；失败立刻用备份回滚。

## 三、D1 验收标准（做到这些才算"不是安慰剂"）

- [ ] 打开开关后，下一轮对话能被注入 `[dsh-deeper-think]` 提醒（可从会话日志验证 H1 事件）
- [ ] 未写 `boundary.md / criteria.md / pre.md` 时，写产物被拦下（H2 生效）
- [ ] 写完产物后提示继续验收，且写验收文件本身不再重复提示（H3 + D2 修复）
- [ ] 回合末卡片显示校验结果（通过/失败码）（H4 生效）
- [ ] 关掉开关后，以上行为全部停止
- [ ] 重启 DSH 后开关默认关闭，且宿主不残留状态
- [ ] 以上每一步都有可重跑的命令/日志证据

## 四、已知未做（本清单之外，避免遗忘）

| 项 | 状态 |
|---|---|
| 客户端 → 宿主的通道选型（session command / ctx.remote / 服务注入） | 未定 |
| 宿主侧 `inject` 的确切服务名 | 未查（需 cordis_inspect_query） |
| 回合末 checker 的路径与超时 | 未定 |
| 多会话隔离（seat store 按 sessionId） | 已设计，未接 |
| 安全模式回归测试（strict proxy） | 已有用例，接线后需扩展 |

---

**提醒语**：D1 不是"文案问题"，是"功能没接线"。任何一次说"插件做完了"之前，先看这份清单有没有勾满。

## 验证记录（2026-10-19，v0.1.1）

| 项 | 状态 | 证据 |
|---|---|---|
| H1 每步提醒 | 通过 | 会话中出现 `[dsh-deeper-think]` 提醒，相位随文件推进（boundary→pre→build） |
| H2 写前闸门 | 通过 | 规划文件缺失时拒绝写产物；补齐后放行（日志 `gate dir=D:\AI\work phase=build`） |
| H3 写后提示 | 通过 | 产物写出后下一步注入"写 acceptance.md 与 demo_runs.txt" |
| H4 回合末核验 | 通过（轻量版） | `%TEMP%\dsh-deeper-think-verdict.log` 有 FAIL 记录，结论在下一轮开头注入 |
| 状态通道 | 通过（HTTP） | `http set … on=true` → `pre-step … seat=true`；RPC 因注入限制未启用 |
| 目录解析 | 通过 | 从会话日志头读 cwd：`session cwd=D:\AI\work` |

遗留：RPC 通道因 cordis 服务注入限制不可用，HTTP 路由为实际通道；完整 v4check 未内置。
