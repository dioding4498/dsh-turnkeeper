# dsh-turnkeeper

每轮耗时计量 + 运行时护栏。装在本机 DSH profile 里，行 id `include:turnkeeper`。

## 做什么

1. **计量**：`llm/stream` 量模型流耗时，`tools/execute` 量每次根工具调用，`agent/turn-stopping` 汇总成一轮的 模型/工具/其他 三段，写入账本 `$DSH_HOME/turnkeeper.jsonl`。
2. **执法**：`tools/pre-execute` 在调用真正分发前做判断，违规直接 `deny`，模型必须当场改行为。

## 三条护栏

| 护栏 | 触发条件 | 结果 |
| --- | --- | --- |
| 步数闸门 | 本轮连续 `stepGate` 次工具调用没有正文汇报 | 下一次 deny，要求先写进度 |
| 重试熔断 | 同一工具本轮已失败 `retryGate` 次 | 再调 deny，要求换路或报错 |
| 慢命令拦截 | 同一条命令曾前台跑超 `slowBlockMs` | 再跑 deny，要求后台化 |

"汇报"的判定：一条 assistant 消息里有 ≥12 字正文，**带不带工具调用都算**。只有闷头连打才会触发闸门。

## 配置

`$DSH_HOME/turnkeeper.config.json`，文件 mtime 一变就热读取，不用重启：

```json
{
  "stepGate": 8,
  "retryGate": 2,
  "slowLearnMs": 30000,
  "slowBlockMs": 60000,
  "exempt": ["turn_cost", "ask_user_question", "todo_write", "send_message", "exit_plan_mode"],
  "enabled": true
}
```

- `slowLearnMs`：命令跑多久才被记进"慢命令词典"（学习阈值）。
- `slowBlockMs`：词典里的命令再多慢就会被拦（拦截阈值）。学习阈值必须小于拦截阈值，否则永远学不会。
- `exempt`：豁免的工具名，闸门不计数也不拦。
- `enabled: false`：只计时不动手。

## 工具 `turn_cost`

- `{turns: 1..10}`：读内存里最近几轮，含最慢工具、拦截分项、一行建议。
- `{days: 1..365}`：读磁盘账本做区间汇总，含活跃天数、最忙的几天、拦截总数。

## 已验证

- 步数闸门：9 次静默调用，第 9 次 deny；随后带正文，下一次立即放行。
- 重试熔断：同一路径 `read` 失败 2 次，第 3 次 deny。
- 慢命令拦截：阈值临时调到 800/1200ms，`Start-Sleep -Seconds 2` 第二次被 deny。
- 汇总视图：`turn_cost {days:7}` 正确聚合。

## 已知限制

- 慢命令是**学习型**：某条命令第一次慢拦不住，只能事后记住。要"第一次就拦"得靠规则词表，会有误伤。
- 闸门被 deny 后如果模型继续闷头调用，会一直被拦到本轮结束——这是有意为之（逼它汇报），但会让长任务强制收尾。
- 没有客户端 UI 面板，账本只能通过 `turn_cost` 或直接看 JSONL。