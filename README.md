# hermes-token-speed

**Live tokens-per-second for [Hermes Agent](https://hermes-agent.nousresearch.com) desktop.**
A status-bar plugin that shows your model's *actual decode speed while it is
still generating*, task-weighted average TPS, cumulative output count, and current Codex quota.

## Codex quota chip

The status bar reports remaining Codex five-hour and weekly quota alongside live and average token metrics. Quotas refresh every five minutes and are cached for 60 seconds. The source is OpenAI's undocumented `chatgpt.com/backend-api/wham/usage` endpoint, so availability and response format may change.

Quota calls use Hermes core's `credentialed_provider_request` for `openai-codex`; Hermes attaches the existing OAuth credential and restricts requests to the provider origin. The plugin never reads or stores Codex token files. Enabling the plugin grants this request capability. A Codex sign-in must be configured in the same Hermes profile.

The status chip is ordered: Codex 5h remaining · weekly remaining · Live tok/s · Avg tok/s · cumulative output tokens. Live returns to an em dash when idle; task average and cumulative output remain visible.

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

1. Install the GitHub plugin package Ayshinko/hermes-token-speed into Hermes; its agent backend retrieves Codex quota through the Hermes credential broker.
2. Enable the hermes-token-speed agent plugin and Token Speed + Codex Quota desktop plugin in Capabilities → Plugins.
3. Reload desktop plugins. Codex must already be signed in to the same Hermes profile.

The standalone desktop-only setup still shows Live / Avg speed, but quota needs the agent half enabled.

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

插件状态栏新增 Codex 五小时/每周额度，以及实时和任务平均 tok/s；Codex 额度通过 Hermes 现有登录代理读取。Hermes 桌面版内置的 tok/s 是"最近 10 个**已完成** API 调用的滚动平均"——一次长
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
