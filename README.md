# dsh-turnkeeper

Per-turn cost meter and tool-loop guard for the DSH web GUI. Every finished turn gets one record — model time, tool time, idle time, retries, errors — and the same plugin can refuse tool calls that are clearly going nowhere.

每轮耗时计量 + 运行时护栏。一轮结束写一条记录（模型/工具/空转、重试、报错），并在工具调用明显失控时直接拒绝。

## Install

- npm: `dsh plugin add dsh-turnkeeper`
- source: point **Plugins → install bundle** at a checkout of this repository

No build step, no runtime dependencies, no network calls. Node.js 22 or newer.

## What it measures

| Hook | What it counts |
| --- | --- |
| `llm/stream` | time to first chunk and total time of every model call |
| `tools/execute` | wall time and outcome of every root tool call (nested calls are skipped) |
| `agent/request-error` | retries requested by the runtime |
| `agent/turn-stopping` | writes the turn's record to `$DSH_HOME/turnkeeper.jsonl` |

One record per turn: `at`, `session`, `turn`, `totalMs`, `modelMs`, `toolMs`, `otherMs`, `modelCalls`, `toolCalls`, `retries`, `errors`, `slowest`, `blocked`, `byStep`, `byRetry`, `bySlow`, `gate`, `suggestion`, `adviceKind`.

## Guardrails

All three run in `tools/pre-execute` and answer `deny` with a reason the model can read and act on.

| Guard | Trigger | Effect |
| --- | --- | --- |
| Step gate | this turn took `stepGate` root tool calls since the agent last reported progress | next call denied until the agent writes a progress message |
| Retry breaker | the same tool already failed `retryGate` times this turn | further calls denied; the agent must change approach |
| Slow-command block | the same command prefix previously ran longer than `slowBlockMs` in the foreground | running it again is denied; the agent must background it |

A message counts as reporting progress when its text is at least 12 characters — with or without tool calls in the same message. Only silent tool-call runs are gated.

### Dynamic step gate

By default the gate is not a constant. Every five minutes the plugin reads the last seven days of the ledger, takes the 80th percentile of root tool calls per turn, multiplies it by 1.4, adds 2, and clamps the result to 4–20. Below five samples it uses the configured `stepGate`. The line in a denial names the limit and the basis it came from.

## Configuration

`$DSH_HOME/turnkeeper.config.json` — re-read whenever the file changes, no restart needed:

```json
{
  "stepGate": 8,
  "stepGateMode": "dynamic",
  "stepGateFloor": 4,
  "stepGateCeil": 20,
  "stepGateMultiplier": 1.4,
  "stepGateMinSamples": 5,
  "stepGateWindowDays": 7,
  "retryGate": 2,
  "slowLearnMs": 30000,
  "slowBlockMs": 60000,
  "exempt": ["turn_cost", "ask_user_question", "todo_write", "send_message", "exit_plan_mode"],
  "enabled": true
}
```

- `stepGateMode: "fixed"` pins the gate to `stepGate` and ignores the ledger.
- `slowLearnMs` is the learning threshold and `slowBlockMs` the blocking threshold. Keep the first below the second, or nothing is ever learned.
- `exempt` lists tools that are neither counted nor denied.
- `enabled: false` keeps measuring and stops guarding.

## Tool `turn_cost`

- `{turns: 1..10}` — recent turns from memory, including the slowest tool, the denial breakdown and one line of advice.
- `{days: 1..365}` — aggregate the on-disk ledger: active days, busiest days, total denials.

## UI

- A card under each reply: the turn's split across model / tools / idle, denials, and the advice line.
- A ledger view (`conversation.view`, labelled 轮次) listing past turns grouped by day, with a per-row detail panel.
- Accepting an advice writes a 24-hour policy that the guards apply immediately — for example a tighter step gate for `model`-heavy turns. Rejecting it mutes that advice kind for seven days.

Data files, all in `$DSH_HOME`:

| File | Contents |
| --- | --- |
| `turnkeeper.jsonl` | one record per finished turn |
| `turnkeeper.decisions.jsonl` | accept / reject decisions with an optional note |
| `turnkeeper.policy.json` | policies currently in force (expire after 24 hours) |

## Limits

- The slow-command guard learns: the first slow run of a command cannot be stopped, only remembered.
- A denial is not a retry. If the agent keeps calling without reporting, it stays denied for the rest of the turn — deliberate, but long tasks can be pushed to finish early.
- Time is wall-clock inside this process; a suspended machine counts as model time.

## License

MIT