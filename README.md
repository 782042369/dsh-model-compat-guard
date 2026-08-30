# dsh-compat-guard

DSH（DeepSeek Harness）第三方模型兼容守卫插件，修复两个高频问题：

## 1. GPT / 思考型模型自动压缩失败

**根因**：`dsh-compaction-basic` 压缩摘要请求硬性 `maxTokens` 上限默认 8192，且摘要被截断时 fail-closed 直接报
`summarization truncated at the token cap (incomplete checkpoint)`。思考型模型（GPT-5.x、Qwen-thinking 等）
的思考 token 计入同一输出预算，默认思考档位轻松烧穿 8192 → 压缩必败。

**修复**：拦截 `purpose === "compaction"` 的 LLM 请求（`llm/stream` waterfall）：

- `maxTokens` 提升到 32768（可配），已知模型声明上限时自动 clamp；
- 推理档位降到该模型支持的最便宜档（优先 off > minimal > low，按模型 efforts 列表实际可选值挑选）；
- 不支持思考档位的模型不会强行设置（避免 UNSUPPORTED_REASONING_EFFORT）。

## 2. Error: invalid arguments: missing required property "description"

**根因**：`bash` / `run_code` / `subagent` 等工具把 `description`（UI 标签用）声明为必填，
参数严格校验（`dsh-tools` JSON Schema 校验）缺字段即整体拒绝。很多模型经常漏传。

**修复**：拦截 `tools/execute` waterfall，在严格校验前检查工具 schema：

- 若 `description` 必填且缺失/为空白，从调用负载自动合成：
  - `bash` → 命令首行（`Run: cd /tmp && rm -rf build`）
  - `run_code` → 首行有效代码（跳过注释/花括号）
  - `subagent`/`subagent_fork` → prompt 首行
  - `workflow` → 补齐嵌套 `meta.description`
- 已有合法 description 的调用不受影响；frozen 参数对象以替换方式更新（`exec` 本身是 waterfall 约定的可变载体）。

## 配置（可选）

`~/.dsh/compat-guard.json`：

```json
{
  "compactionMaxTokens": 32768,
  "compactionEffort": "auto",
  "compactionStripTools": false,
  "compactionPurposes": ["compaction"],
  "fillDescription": true,
  "logFixes": true
}
```

- `compactionEffort`：`"auto"`（最便宜档）/ `"keep"`（不动）/ 具体档位 id。
- `compactionStripTools`：true 时压缩请求去掉 tools 列表（防模型压缩时调工具，代价是丢前缀 KV cache）。
- cordis 插件 config 传入的同名字段优先于该文件。

## 安装 / 测试

```bash
dsh plugin --profile web add /www/wwwroot/dsh-compat-guard   # 装入 profile，重启 dsh web 后生效
node test/smoke.mjs                                           # 24 项 mock 断言
```

日志关键字：`compat-guard:`（tuned compaction request / filled missing description）。
