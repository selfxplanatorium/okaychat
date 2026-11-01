# Deep research

Deep research is a per-chat composer mode. With it on, each new user message gets a bounded research run before the chat model answers: plan, collect evidence, review for gaps and conflicts, then a cited report written by the chat model as its normal reply. The report is stored, exported, shared, and branched like any other reply.

The design follows two published systems: Anthropic's multi-agent research system (a lead plans distinct, bounded subtasks; workers search broad then narrow; the lead checks gaps and stops excess effort) and OpenAI's deep research (adaptive search/read/backtrack ending in a cited report). It deliberately stays smaller: one fixed loop with hard limits, no background queue, and no new dependencies.

## Code

| File | Role |
| --- | --- |
| `src/server/research.ts` | `runResearch()` (the loop), `researchTool()` (the tool definition), `researchInput()`, progress and findings formats |
| `src/server/chat.ts` | `turnStream()` runs research when `config.deepResearch` is set and the request ends with a user message, streams its progress, then hands the findings to the chat model |
| `src/server/tools/search-budget.ts` | `StepBudget`, `SearchShare`, and continuation counting of research steps and searches |
| `src/server/prompts.ts` | `researchPlan`, `researchWorker`, `researchReview`, `researchReport` (admin-editable like every prompt) |
| `src/web/state/chat-research.ts` | Research hook over the shared `chat-web-mode.ts` store and the availability reason |
| `src/web/components/chat/ComposerControls.tsx` | `ResearchToggle` (desktop) and the item in the plus menu (touch and narrow layouts) |
| `src/web/components/chat/tool-ui.tsx` | `ResearchCard`: live phase, questions, conflicts, open questions, pages read, cost |

Search and Deep research are mutually exclusive modes in `state/chat-web-mode.ts`. Selecting either replaces the other; toggling the active mode off leaves both off. Choices are kept per chat in page memory and bound from optimistic local ids to remote ids. The command `composer.research` (Alt+Shift+D) toggles it. The composer placeholder changes while it is on, which is the only visible cue on phones, where the toggle sits in the plus menu.

## Flow

1. **Plan** (chat model, no tools). Gets the latest request (8,000 characters) and the conversation before it (newest first, 12,000 characters, text parts only). Returns an objective and at most four distinct questions, fewer when the reply's search or step allowance is smaller.
2. **Collect** (workers). One `streamText` loop per question with only `web_search` and `web_fetch`, built in `research.ts`. The worker prompt asks for broad then narrow searches, reading pages before relying on them, primary sources first, disagreements recorded, and notes in a fixed Answer/Evidence/Open points format with a Markdown link and (primary)/(secondary) per claim. Notes are capped at 8,000 characters.
3. **Review** (chat model, no tools). Lists follow-up questions for unanswered or weakly supported parts and conflicts between sources. If there are follow-ups and allowances remain, one more collect round runs with at most three questions, followed by a final review. Two rounds at most.
4. **Report**. The findings (objective, notes per question, conflicts, open questions, early stop reason, pages read) become the result of a synthetic `deep_research` tool call. The chat model's normal `streamText` loop starts from it, with the `researchReport` instructions in front: answer first, organize by theme, cite only URLs in the findings, say where evidence is weak.

A worker that fails is marked failed and the others' notes are kept. A failed or malformed review stops follow-ups and preserves open questions with an explicit warning in the findings. Research with no notes at all fails the reply with the first worker error instead of letting the model answer without evidence.

## Delegates

When the account allows sub-agents (`settings.subagents`, never in temporary chats), workers run three at a time on the default sub-agent model. Otherwise they run one at a time on the chat model. Planning, review, and worker requests include the current UTC date beside the task, outside the cached system prefix. Plans, reviews, and the report always use the chat model and its reasoning effort. Research does not go through `delegate_task`, because that tool hands sub-agents the MCP and skill tools; research workers get the two web tools only.

## Limits

Research spends the reply's own allowances. Nothing is raised for it:

- **Searches.** Every worker reserves from the turn's `SearchBudget`, through a `SearchShare` fixed when the worker starts (remaining searches divided by unstarted questions), so the first worker cannot spend the others' searches. The share reports the reply's limit, so every worker's tool block is identical.
- **Agent steps.** `StepBudget` holds the account's `maxSteps` for the reply. Each tool-capable worker step reserves one (at most six per worker, and at most the remaining steps divided by unstarted questions); a final `toolChoice: "none"` step needs none, as in the chat loop. The chat model gets what is left; with nothing left it answers without tools. Plan and review calls have no tools and are not agent steps.
- **Rounds and size.** Four questions, then three follow-ups, two rounds, 60 recorded pages.

With the default limits (5 searches, 20 steps) a run is short: about one search per question. The toggle's tooltip states the account's numbers. When research stops on a limit, the card and the findings say so.

Research cannot start when the model cannot call tools, web tools are off, or the search limit is 0. The composer shows the reason (a warning state when the toggle was already on), and the server refuses the request with the same reason before anything runs. Research workers search within the same budget. In research mode the chat model's report loop has no `web_search`, even if a client also sends `webSearch: true`; it keeps `web_fetch` to read sources. Desktop help and the mobile menu explain that research replaces Search.

## Continuations and recovery

The research part's final output carries `steps` and `searches`. `agentStepsInCurrentTurn` and `searchesInCurrentTurn` add them, so a browser-tool or approval continuation of a researched reply cannot restart either allowance. A continuation never researches again (`researchedThisTurn`). Retry and edit end with a user message and research again.

Progress is written into the reply's own stream as `tool-input-available` and preliminary `tool-output-available` chunks, so reload recovery replays it through the existing resumable stream. The research part opens the reply, so `turnStream` writes the message `start` itself and merges the model stream with `sendStart: false`. No `step-start` part is written for it, so it adds no agent step to the count.

## Cancellation

Stop aborts the turn's signal. It reaches every `generateText`/`streamText` call and, through the tools' `abortSignal`, the search engines' fetches, page fetches, and Scrapling jobs (`web.ts` now combines each request timeout with that signal). The research part ends with an error output ("Stopped."). Page unload does not stop it, like any reply.

## Usage

Research model calls are recorded once, at the end (also when stopped or failed), per model, with kind `research`. The chat model's report is recorded as `chat` and shown as the reply's cost. Research cost appears on the card and under Deep research in the Usage page’s purpose breakdown. Temporary chats record nothing.

## Prompt cache

The `deep_research` tool is listed from a chat's first research turn on (`hasResearch`), so chats that never use it keep their tool block, and toggling later does not change it again. The synthetic call and result are converted with `convertToModelMessages` exactly as the stored reply will be converted in the next turn, so the next request extends this one byte for byte. Plan, review, and worker system prompts are constant and marked for caching; the per-run data sits in the user message. Workers' tool descriptions are identical (see `SearchShare`).

## Security

- Read-only by construction: workers receive a tool set built in `research.ts` with `web_search` and `web_fetch`, nothing from MCP, skills, memory, artifacts, images, code, or the browser. Plan and review calls have no tools.
- Web content is untrusted: worker, review, and report prompts say to treat page text and notes as data. Page reads go through `publicFetch` as everywhere else.
- If the chat model calls `deep_research` itself, the call fails with an explanation; research runs only from the user's toggle.

## Tradeoffs

- The chat model writes the report, so it is streamed, persisted, exported, and metered like any reply. The cost is that the findings (up to roughly 60,000 characters) stay in the conversation for later turns until compaction trims them.
- A fixed loop is predictable and testable, but it cannot decide to do a third round or more than seven questions. Raising those would need larger default allowances first.
- Workers see only their question and the objective, not the conversation. The plan step carries the conversation's intent into the objective.

## Tests

`src/server/research.test.ts` drives the real `turnStream` against a fake OpenAI-compatible provider and a fake search engine: stage order, the follow-up round, findings reaching the chat model, worker tool sets, hard search and step caps, worker failure, total failure, Stop during a search, parallel workers with sub-agents, continuation counting, tool block stability, temporary-chat usage, and the `/chat` request config with its unavailable reasons, current-date context, incomplete review warnings, unresolved questions, and client assembly of the progress and report into one replayable assistant message. `src/server/tools/search-budget.test.ts` covers `SearchShare`, `StepBudget`, and research counts in continuations.
