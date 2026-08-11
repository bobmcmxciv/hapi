# 在 Claude Code 里跑旧版 Opus 并开满 1M 上下文

**结论先行**：模型串直接写 `claude-opus-4-7[1m]` / `claude-opus-4-6[1m]` 即可。
`[1m]` 是 Claude Code 自己的模型 ID 后缀（不是 API 的东西），旧版 Opus 都认。

取证环境：vircs，Claude Code **2.1.220**，Anthropic 账号登录（firstParty，无中转）。

---

## 1. 为什么「Opus 1M」会落到 Opus 5

Claude Code 二进制里内嵌了一张模型注册表，其中别名段是：

```js
aliases:{ opus:{ default:"claude-opus-5", per_provider:{ …, gateway:"claude-opus-4-7" } } }
```

`opus` 这个别名在 firstParty 下**硬编码解析到 `claude-opus-5`**。所以选择器里的
「Opus」「Opus (1M)」都只是这个别名的不同呈现，跟 4.7/4.6 无关——这就是
「开 1M 端口却调到 Opus 5」的原因，不是 bug，是别名设计。

相关内部函数（符号表可见）：`isOpus1mMergeEnabled` 在 firstParty 下返回 true，
把 Opus 与 Opus-1M 两个选择器条目合并成一项，于是列表里看不到「旧版 Opus + 1M」
这种组合。**但这只是选择器的限制，模型串本身完全可用。**

## 2. 各模型的 1M 到底怎么来的

注册表里每个模型的 `context` 字段（原文摘录）：

| 模型 | `window` | `native_1m` | `supports_1m_suffix` | 拿到 1M 的方式 |
|---|---|---|---|---|
| `claude-opus-4-6` | **200000** | 无 | ✅ | **必须**加 `[1m]` |
| `claude-opus-4-7` | 1000000 | ✅ | ✅ | 默认就是 1M，`[1m]` 冗余但无害 |
| `claude-opus-4-8` | 1000000 | ✅ | ✅ | 默认即 1M |
| `claude-opus-5` | 1000000 | ✅ | ✅ | 默认即 1M |
| `claude-sonnet-4-6` | 200000 | 无 | ✅ | 必须加 `[1m]` |
| `claude-fable-5` | 1000000 | ✅ | **无** | 默认即 1M |

**注意 4.6 与 4.7 的差别是实质性的**：4.6 默认只有 200K，不加后缀就少 80% 窗口。

处理后缀的实现（反编译自二进制）：

```js
function strip1mTag(e){ return e.replace(/\[1m\]/gi,"") }   // 取基础模型名
function Wb(e){ if(NVe()) return !1; return /\[1m\]/i.test(e) }  // 用户是否要了 1M
function NVe(){ return Z.CLAUDE_CODE_DISABLE_1M_CONTEXT }   // 全局关闭开关
```

## 3. 实测（本机真跑，非推断）

```console
$ claude --model 'claude-opus-4-6'     --output-format json -p "hi"
  → contextWindow=200000    canonicalModel=claude-opus-4-6  provider=firstParty
$ claude --model 'claude-opus-4-6[1m]' --output-format json -p "hi"
  → contextWindow=1000000   canonicalModel=claude-opus-4-6  provider=firstParty
$ claude --model 'claude-opus-4-7'     --output-format json -p "hi"
  → contextWindow=1000000   canonicalModel=claude-opus-4-7
$ claude --model 'claude-opus-4-7[1m]' --output-format json -p "hi"
  → contextWindow=1000000   canonicalModel=claude-opus-4-7
```

`modelUsage[].contextWindow` 是 Claude Code 自己上报的生效窗口，直接证明后缀起作用；
两条 4.6 的对照把「200K→1M」这件事钉死。

## 4. 四种设置方式（按作用域从窄到宽）

```bash
# 1) 单次会话
claude --model 'claude-opus-4-7[1m]'

# 2) 会话内切换（斜杠命令直接吃完整模型串）
/model claude-opus-4-6[1m]

# 3) 全局默认 —— ~/.claude/settings.json
{ "model": "claude-opus-4-7[1m]" }

# 4) 环境变量（优先级高于 settings.json）
ANTHROPIC_MODEL='claude-opus-4-6[1m]'
```

**注意**：`ANTHROPIC_DEFAULT_OPUS_MODEL` 改的是 `opus` **别名**指向哪个模型，
适合「让选择器里的 Opus 项变成 4.7」；想精确控制主循环模型用上面四种。

## 5. 相关开关

| 变量 | 作用 |
|---|---|
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | 全局关掉 1M，`[1m]` 后缀会被忽略 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 重定向 `opus` 别名 |
| `ANTHROPIC_MODEL` | 直接钉死主循环模型 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子代理模型 |
| `CLAUDE_CODE_EFFORT_LEVEL` | effort（4.7 默认 `xhigh`，4.6 无 `xhigh` 能力） |

## 6. 选型提示

注册表里 4.6 与 4.7 的 `capabilities` 不同：4.7 有 `xhigh_effort` / `fast_mode`，
`default_effort:"xhigh"`；4.6 只有 `effort`/`max_effort`，没有 `xhigh`。
给 4.6 设 `CLAUDE_CODE_EFFORT_LEVEL=xhigh` 不会生效。

## 7. 复跑方式

```bash
claude --model '<模型串>' --output-format json -p "hi" \
  | python -c "import sys,json;print(json.load(sys.stdin)['modelUsage'])"
```

看 `contextWindow` 字段即可。注册表本身可从二进制里捞：

```bash
python -c "
import re;d=open(r'<npm 全局>/@anthropic-ai/claude-code/bin/claude.exe','rb').read()
[print(d[m.start()-1200:m.end()+400].decode('utf-8','replace')) for m in re.finditer(rb'native_1m',d)]"
```
