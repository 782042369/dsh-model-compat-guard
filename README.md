# dsh-model-compat-guard

[English](README.en.md)

DSH（DeepSeek Harness）第三方模型兼容守卫插件——零配置开箱即用，修复四个高频问题（GPT/思考型模型压缩截断、必败提权请求 fail-close、工具调用缺 description、Code Mode run_code 高频报错）：

## 1. GPT / 思考型模型自动压缩失败

**根因**：`dsh-compaction-basic` 压缩摘要请求硬性 `maxTokens` 上限默认 8192，且摘要被截断时 fail-closed 直接报
`summarization truncated at the token cap (incomplete checkpoint)`。思考型模型（GPT-5.x、Qwen-thinking 等）
的思考 token 计入同一输出预算，默认思考档位轻松烧穿 8192 → 压缩必败。

**修复**：拦截 `purpose === "compaction"` 的 LLM 请求（`llm/stream` waterfall）：

- `maxTokens` 提升到 32768（可配），已知模型声明上限时自动 clamp；
- 推理档位降到该模型支持的最便宜档（优先 off > minimal > low，按模型 efforts 列表实际可选值挑选）；
- 不支持思考档位的模型不会强行设置（避免 UNSUPPORTED_REASONING_EFFORT）。

## 2. GPT 在最高权限下仍申请提权，频繁报错（v0.1.1 新增）

**根因**（官方 Discussion [#3877](https://github.com/deepseek-ai/deepseek-harness/discussions/3877)）：
只要挂了沙箱执行器，`bash`/`write`/`edit` 的工具 schema 就会**全局**广告 `sandbox_permissions` 字段，而有效模式是按会话解析的；执行时 `approveEscalation` 要求**严格更宽**（`WIDER_MODES`：read-only→workspace-write→danger-full-access，full-access 无更宽目标）+ 非空 justification，否则 **fail-closed 整个调用失败**。GPT/Claude 等模型会投机性附加该参数，在 danger-full-access 会话里必然触发：

\`\`\`text
Error: sandbox escalation to "danger-full-access" is not strictly wider than this call's current "danger-full-access" mode
Error: invalid justification: expected a non-empty sentence
\`\`\`

**修复**：`tools/execute` 钩子在执行前解析 `ctx.sandboxPolicy` 的当前会话模式，判定提权请求**必败**（同档/更窄/无沙箱服务/模式未知）时剥离 `sandbox_permissions`+`justification`，按当前模式执行（语义等价——模型要的本就已拥有）。**严格更宽**的合法请求保留，正常走审批流。

配置 `stripEscalation`：`"redundant"`（默认，只剥必败请求）/ `"always"`（连合法提权也剥，适合禁用审批弹窗的会话）/ `"off"`。

## 3. Error: invalid arguments: missing required property "description"

**根因**：`bash` / `run_code` / `subagent` 等工具把 `description`（UI 标签用）声明为必填，
参数严格校验（`dsh-tools` JSON Schema 校验）缺字段即整体拒绝。很多模型经常漏传。

**修复**：拦截 `tools/execute` waterfall，在严格校验前检查工具 schema：

- 若 `description` 必填且缺失/为空白，从调用负载自动合成：
  - `bash` → 命令首行（`Run: cd /tmp && rm -rf build`）
  - `run_code` → 首行有效代码（跳过注释/花括号）
  - `subagent`/`subagent_fork` → prompt 首行
  - `workflow` → 补齐嵌套 `meta.description`
- 已有合法 description 的调用不受影响；frozen 参数对象以替换方式更新（`exec` 本身是 waterfall 约定的可变载体）。

## 4. Code Mode（PTC）run_code 高频报错（v0.3.0 新增）

**症状**（官方 Discussion [#1605](https://github.com/deepseek-ai/deepseek-harness/discussions/1605)）：

```text
Error: code run failed (exception): Expected ',', got '<eof>'
Error: code run failed (exception): TypeError: b.stdout.slice is not a function
```

**根因**：①模型生成的 TS 程序语法不完整——引号/反引号/括号未配对或代码被截断，类型擦除解析器（amaro/SWC）在期望逗号处读到文件尾；②模型把 bash 结果的 `stdout` 当字符串用——实际是结构化对象 `{ text, truncated, spillPath? }`，正确取法是 `res.stdout.text`。两类都是「模型不适应 PTC 用 TS 调用一切工具」+「Harness 只回一行错误无定位」的放大结果。

**修复**：`llm/stream` 钩子检测 Code Mode 请求（wire 上只有 `run_code` 一个工具时），在 system prompt 末尾追加一段紧凑纪律块：工具结果是裸 JSON 值（没有 `.result()` 包装）、bash 结果的正确读法、TS 程序必须完整闭合（多行书写、收尾自查配对）。追加在末尾不动前缀，provider prompt cache 无损。

配置 `codeDiscipline`：`"auto"`（默认，仅 code-mode 请求注入）/ `"always"`（所有主循环请求）/ `"off"`。

## 配置（可选）

`~/.dsh/compat-guard.json`：

```json
{
  "compactionMaxTokens": 32768,
  "compactionEffort": "auto",
  "compactionStripTools": false,
  "compactionPurposes": ["compaction"],
  "fillDescription": true,
  "codeDiscipline": "auto",
  "stripEscalation": "redundant",
  "logFixes": true
}
```

- `compactionEffort`：`"auto"`（最便宜档）/ `"keep"`（不动）/ 具体档位 id。
- `compactionStripTools`：true 时压缩请求去掉 tools 列表（防模型压缩时调工具，代价是丢前缀 KV cache）。
- `codeDiscipline`：`"auto"`（默认，仅 code-mode 请求注入纪律块）/ `"always"`（所有主循环请求）/ `"off"`（关闭）。
- cordis 插件 config 传入的同名字段优先于该文件。

## 安装 / 测试

插件市场（Settings → Plugins → Marketplace 搜索 `dsh-model-compat-guard`）或 GitHub 直装：

```bash
dsh plugin --profile web add github:782042369/dsh-model-compat-guard   # 装入 profile，重启 dsh web 后生效
node test/smoke.mjs                                              # mock 驱动的全量断言
```

卸载：`dsh plugin --profile web remove dsh-model-compat-guard`。

## 许可

[MIT](LICENSE)

日志关键字：`compat-guard:`（tuned compaction request / filled missing description / stripped doomed escalation / injected code-mode discipline）。
