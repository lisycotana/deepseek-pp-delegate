# Delegate mode

> This is an addition to a fork of [DeepSeek++](https://github.com/zhu1090093659/deepseek-pp) (Apache-2.0). It reuses DS++'s MCP client, tool-call parser, prompt augmentation, and DS API client unchanged; the `core/delegate/` module and the delete-session capability are the fork's additions.

Turns a DeepSeek web conversation into an execution worker for DeepSeek Harness (dsh). Each task from dsh runs in a **fresh DS chat session** that is **deleted** when the task settles, so task contexts never bleed into each other and the sidebar never accumulates spent conversations.

This is the browser side of the dsh subagent bridge. The dsh side (`dsh-subagent-deepseek-web`) queues tasks; this side claims them, runs them in a DS conversation, and reports back.

```
dsh parent agent
 └ subagent_deepseek_web("...")
      │  task queued (dsh-subagent-deepseek-web bridge)
      ▼
 delegate loop (this module, in the extension background)
      ├─ web_task_claim        → take a task
      ├─ createChatSession     → fresh DS conversation
      ├─ submitPrompt + tool loop
      │    └─ model calls dsh tools via the MCP endpoint
      ├─ web_task_settle       → report the result
      └─ deleteChatSession     → remove the conversation
      ▼
 loop back to claim
```

## Why not the existing automation runner

The automation runner is single-shot, scheduled, and reuses a persisted DS session cursor. A delegate is none of those: it is "always available," driven by an external task queue, and must isolate every task in its own conversation. Forcing it into the automation scheduler would fight the lease, retry, 180s timeout, and `maxDepth=3` semantics at every step.

This module reuses the same primitives — `createChatSession`, `submitPrompt`, `createPowHeaders`, `runToolContinuationLoop` — but organizes them into its own loop. It does not touch the automation scheduler, registry, or storage.

## What it adds

| File | Role |
| --- | --- |
| `core/delegate/types.ts` | Config, status, callbacks, defaults |
| `core/delegate/loop.ts` | The loop: claim → fresh session → execute → settle → delete |
| `entrypoints/background/delegate-controller.ts` | Single live run, status surface |
| `entrypoints/background/delegate-handlers.ts` | `START_DELEGATE` / `STOP_DELEGATE` / `GET_DELEGATE_STATUS` messages |

Plus a DS conversation delete capability (previously absent from the extension):

- `core/deepseek/contracts.ts` — `deleteSession: '/api/v0/chat_session/delete'`
- `core/deepseek/request-codec.ts` — route policy + `encodeDeleteSessionRequest`
- `core/deepseek/active-client.ts` — `deleteChatSession` (best-effort: a missing session is the cleanup outcome, not an error)

## Configuration

Defaults are in `core/delegate/types.ts` (`DEFAULT_DELEGATE_CONFIG`):

| Key | Default | Meaning |
| --- | --- | --- |
| `maxTasks` | `100` | Hard ceiling before the loop stops idle. 0 = unbounded. Guards against service-worker termination on an empty loop. |
| `perTaskTimeoutMs` | `1_800_000` | Wall-clock limit for one task, including tool calls. |
| `toolLoopDepth` | `12` | Rounds of tool continuation per task. Each round = one assistant turn of tool calls + one continuation. |
| `locale` | `zh-CN` | Prompt augmentation locale. |

## Triggering

There is no UI button. The loop is started from the DeepSeek++ sidebar DevTools console:

```javascript
chrome.runtime.sendMessage({ type: 'START_DELEGATE' }, (r) => console.log(r))
```

Stop:

```javascript
chrome.runtime.sendMessage({ type: 'STOP_DELEGATE' }, () => console.log('stopped'))
```

Status:

```javascript
chrome.runtime.sendMessage({ type: 'GET_DELEGATE_STATUS' }, (r) => console.log(r))
```

No UI was added on purpose: this is a personal-workflow tool, not a shipped feature, and a console trigger keeps the fork close to upstream.

## Per-task isolation

Every task gets its own DS chat session. The session id is never persisted to the automation cursor, so a crashed loop leaves no stale pointer for a retry to resume. Deletion runs in a `finally` block regardless of outcome — a task that fails to settle is still cleaned up, and the dsh side times out its own claim and moves on.

The user's existing manual conversations are never touched: the loop only ever operates on sessions it created.

## Known limitations

- **One loop at a time.** A second `START_DELEGATE` while one is running is refused.
- **Service-worker termination** can kill a long loop mid-task (MV3 idle timeout). The dsh side times out its claim and re-queues; the next `START_DELEGATE` resumes.
- **DS login must stay valid.** Token loss mid-loop stops the loop with an `auth` stop reason.
- **No browser-control tools inside a task.** The tool-call filter admits MCP and web tools only, matching the automation runner's security boundary. Tasks that need to drive the browser cannot.
