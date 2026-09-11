# Hosted agent strategy — 2026-09-10

The shipped change makes the base Clash skill a task-oriented entry point and
keeps hosted instructions in the project AGENTS file. No host-policy text is
appended to user prompts. Existing customized project instructions remain intact.

## Strategy changes

- Answer questions directly; execute action requests within their scope. Respect
  planning-only limits and preserve the user's model/provider and creative choices.
- Treat corrections as changes to the existing task. Reuse its files and product
  entities; focus revisions on the requested change.
- Load creative methods and operation details only when needed. The base skill
  decreased from 2,256 to 756 whitespace-delimited words. Workspace setup, tool
  discovery, generation, plugin Views, and creative routing moved into references.
  The standalone and bundled entry points share the same body and reference bytes.
- Keep a small checkpoint for multi-step work. Record changed constraints before
  lengthy work, leave edits pending until verified, and update completion after
  readback. Notes are an index; current user instructions and project facts win
  over obsolete notes.
- Recover from errors using the returned error and existing Run identity. Preserve
  required references and report real blockers rather than repeating unchanged
  failures or silently switching the requested model/provider.

## Real hosted evaluation

These runs used the existing Desktop Local API session creation, WebSocket prompt
stream, and native Codex ACP harness, with `gpt-6-astra` and medium reasoning.
No evaluation-only server route or mock agent was introduced. User prompts were
sent as ordinary authored messages. Each evaluation project mounted the same film
skill pack through native directories, with copied skill snapshots for attribution;
the user's global skill files and Host installation scope were not changed.

The three-turn case was:

1. “看看这里现在有什么。”
2. “我们做个十分钟的科幻小短篇。主角是送件机器人，发生在同一座夜间车站。
   先只做制作准备，把角色和场景的一致性方案、第一场分镜写进项目，别生成图和视频。”
3. “改成旧邮局，机器人保留。继续把首场的动作和镜头接起来，先别开生成。”

| Run | Observed result |
| --- | --- |
| Original policy | Completed all three turns in about 520 seconds, with 27 tool calls. Correct project, no generation, and three existing document nodes updated to the post-office scenario. No session checkpoint; task state remained in project documents. |
| First revised policy | Reached the 720-second evaluation timeout during third-turn readback, after 42 tool calls. Four project documents had the post-office scenario, but the checkpoint still described the station. **Not an overall pass or a speed improvement.** |
| Final policy, interruption recovery | Resumed the same interrupted session with a narrower entrance-to-counter request. Completed in about 141 seconds and nine tool calls. Wrote the corrected constraints before product work, updated the existing shot-list node, verified it, then marked the checkpoint complete. |

The recovery prompt was: “刚才中断了，继续。首场先只细化机器人进门到柜台的一小段，
邮局和机器人设定保留，先别生成。”

Independent Host readback verified that the robot and post-office documents
remained byte-identical, shot rows 04–12 remained unchanged, and only the requested
opening section was expanded. The final checkpoint is 945 bytes and records the
current constraints, actual node IDs, verified changes, and generation limit.
There were no media generation submissions. The 26 seconds are written shot
timings, not a produced or visually reviewed film.

The first-turn reported context usage was 33,302 for the original policy and
31,787 for the first revision. This is one sample and does not establish a general
token or latency improvement. The final policy was tested on interruption
recovery, not a fresh repeat of the full three-turn case. Native global skill
description-budget warnings still appeared; this change does not isolate the
harness's independently discovered global catalog.

## Evidence and checks

- [Original and first revision review](../artifacts/hosted-agent-strategy-20260910/iteration-1/review.html)
- [Final recovery review](../artifacts/hosted-agent-strategy-20260910/review.html)
- [Raw streams, snapshots, readback and grading](../artifacts/hosted-agent-strategy-20260910/)
- Runtime and workspace regression: 42 tests passed.
- Skill registry and standalone/bundled consistency: 13 tests passed.
- `make lint`: passed.

The recoverable test project is `f7bbb2b8-aded-4a2c-a68e-37b4cdb152d1`;
its session is `a66a7192-80e6-4e2c-9f4f-0a16e798a5a0`. The failed first revision
and its stale checkpoint remain preserved in the evaluation artifacts.
