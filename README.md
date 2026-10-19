# hermes-token-speed

**Live tokens-per-second for [Hermes Agent](https://hermes-agent.nousresearch.com) desktop.**
A status-bar chip that shows your model's *actual decode speed while it is
still generating* — not a post-turn average.

While the model streams: `⚡ 12.4 t/s` (updates ~4×/sec).
After the turn: `⚡ 13.9 t/s · 4210 tok · 302s` (task-level cumulative, dsh-style).

## Why this exists

Hermes desktop ships a built-in `Tokens per second` status field, but it is a
**rolling average over the last 10 *completed* API calls** (see
`tui_gateway/server.py` + `agent/turn_usage.py`). During one long generation
its counters are frozen — the number you want most (how fast is it going
*right now*) is exactly what it cannot show. Turn-level third-party meters
(hook-based agents: Claude Code / Codex) can't fix this either: hooks only
expose turn boundaries, so they can only report end-to-end speed with prefill
and tool time baked in.

This plugin measures decode speed honestly, inside the desktop renderer's
event stream:

| Mechanism | Detail |
|---|---|
| Sliding window | 1000 ms window, burst-safe same-timestamp span extension (min 100 ms) so a coalesced chunk never fakes a spike |
| Tool time excluded | `tool.start` / `tool.generating` pause the engine; decode seconds never include tool wall time |
| Spinner noise excluded | `thinking.delta` frames are UI spinner rewrites, **not** model tokens — never counted |
| TTFT | time from turn start to first streamed token, surfaced in `turn report` |
| Calibration | mid-turn counts are regex estimates; at turn end authoritative provider usage (`session.usage.output`) reconciles all cumulative totals |

It is a port of the measurement core from my Pi extensions
[pi-token-speed](https://github.com/Ayshinko/pi-token-speed) (sliding window)
and [pi-dsh-tps](https://github.com/Ayshinko/pi-dsh-tps) (task-level TPS
excluding tool time) to the Hermes desktop plugin SDK. If you want the same
numbers in other agents, see [llm-speed-bench](https://github.com/itlmkz/llm-speed-bench)
and openai/codex#54655 — this repo covers Hermes, honestly.

## Install

1. Create the folder `<HERMES_HOME>/desktop-plugins/token-speed/`
   - Windows: `%LOCALAPPDATA%\hermes\desktop-plugins\token-speed\`
   - macOS/Linux: your `$HERMES_HOME/desktop-plugins/token-speed/`
2. Copy [`plugin.js`](plugin.js) into it.
3. Done — standalone desktop plugins load by default. If you don't see the
   `⚡ t/s` chip at the right end of the status bar: `Ctrl+Shift+S` toggles the
   bar, `⌘K` → **Reload desktop plugins** re-scans.

Confirm the plugin is live: open the command palette (`⌘K`), type
`Token Speed` — you should see **turn report / watch events / reset**.
Chip missing but commands present → the status bar is hidden or the window is
too narrow (right-end fields get trimmed first).

## Commands (⌘K)

| Command | What it does |
|---|---|
| `Token Speed: turn report` | toast: est tokens, decode seconds, LLM response count, TTFT, live TPS |
| `Token Speed: watch events (5s)` | collect renderer event names for 5 s into a toast — use it after a Hermes update if the live number stops moving |
| `Token Speed: reset` | zero the session chip totals |

## Tuning

Edit constants at the top of `plugin.js` (saves hot-reload in place):

```js
WINDOW_MS   = 1000  // sliding-window width; raise for a calmer chip
MIN_SPAN    = 100   // burst coalescing floor; keep unless you see fake spikes
THROTTLE_MS = 250   // chip repaint-rate cap
```

Mid-turn token estimates use a word/punctuation regex (CJK = 1/char); expect
±20% drift vs. the provider tokenizer on mixed text — turn-end usage
calibration removes the drift from all cumulative numbers.

## Event contract (tested on Hermes desktop, Oct 2026)

From `apps/desktop/src/app/session/hooks/use-message-stream/gateway-event/`:

- `message.delta`, `reasoning.delta` → real tokens, text in `evt.payload.text`
- `thinking.delta` → UI spinner frames, must NOT count
- `tool.start` / `tool.generating` / `tool.complete` → pause/resume wall time
- `session.usage` → authoritative `output` for calibration

If a Hermes update renames these, `watch events (5s)` shows the real names in
seconds. Note: a plugin that *fails* to load is not retried by the file
watcher — fix + one manual ⌘K reload.

## 中文说明

Hermes 桌面版内置的 tok/s 是"最近 10 个**已完成** API 调用的滚动平均"——一次长
生成进行中数字冻结，看不到实时速度。本插件把我在 Pi 上两个插件
（pi-token-speed / pi-dsh-tps）的测量核心移植到 Hermes 桌面插件 SDK：
1 秒滑动窗口实时读数、同时间戳分片防假尖峰、工具执行时间剔除、UI 转圈动画帧
（`thinking.delta`）不计数、回合结束用官方 usage 校准累计值。
安装：把 `plugin.js` 放进 `%LOCALAPPDATA%\hermes\desktop-plugins\token-speed\`，
状态栏右端出现 `⚡` 芯片；⌘K 搜 `Token Speed` 有三个命令。
Hermes 更新后若实时数字消失，跑 `watch events (5s)` 抓事件名改三行即可。

## License

MIT — see [LICENSE](LICENSE). Hermes is a trademark of Nous Research; this is
an independent community plugin.
