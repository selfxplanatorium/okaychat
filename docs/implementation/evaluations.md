# Evaluations

`/evaluations` is a private per-account workspace for repeatable prompt and model testing: datasets of
cases, immutable runs, manual scoring, one rubric-judge pass, comparison, and export.

## Isolation

An evaluation turn is not a chat. It never creates a `threads` or `messages` row, an upload, an
artifact, a `generation_runs` receipt, or a memory fact, and it never uses a chat id or `tmp_` id.
The five `evaluation_*` tables reference no chat table, and no route calls the thread/history code.
Every case runs with no tools, so a hostile case can at most produce a hostile answer.

## Tables

`evaluation_datasets`, `evaluation_cases`, `evaluation_runs`, `evaluation_results`, and
`evaluation_scores` are one append-only migration at the tail of `db.ts`, with
`OKAYCHAT_TEST_FAIL_MIGRATION=evaluations` as its failure seam.

- A dataset has a `revision`; every case write sends `expectedRevision` and is a compare-and-set. One
  mutation bumps the revision and `updated_at` once. `position` is dense; a reorder must be an exact
  permutation.
- A run snapshots `target_json` and every selected `case_json` at launch. Editing the dataset or an
  assistant preset afterwards changes nothing about it.
- `evaluation_results` has no foreign key to cases: the snapshot is what ran.
- `evaluation_scores` keeps one manual and one judge row per result. Manual comments are encrypted;
  judge rationales are plain model output about the owner's own data.
- A partial unique index (`evaluation_runs_active`) allows one non-terminal run per account. The route
  also checks first and maps the insert's unique violation to the same 409.

## Launch and worker

Launch validates the dataset, subset, model (`resolveModel`), effort and sampling (`validateSampling`),
optional assistant preset (`getPreset`, revision check), the active-run/run-count limits, and the
storage reservation. It then inserts the run and all pending result rows in one transaction and queues
it. The concurrency stored is the request clamped by the account's `concurrentOperations` policy.

The in-process worker keeps at most two executing runs (generation and judging share the slots). It:

- calls `resolveModel()` → `createModel()` → `generateText()` with `maxRetries: 0`, so entitlements,
  per-model instructions, provider retries, rate windows, leases, and usage stay on the normal path;
- aborts each case at 120 s, retries one `rate_limited`, records usage with kinds `evaluation` and
  `evaluation_judge`, and truncates stored output to 32 KiB of UTF-8;
- re-checks `featureAllowed(…, "evaluations")` before each dispatch, skips the remaining cases when a
  budget or feature revocation stops the run, and recounts counters from result rows after each case;
- never resumes. `initEvaluations()` runs once from `index.ts` after `interruptOpenRuns()` and marks
  every open run `failed`/`interrupted`, unfinished results `skipped`, and open judge passes `failed`.

A budget is checked before dispatch, so a run can overshoot by one case (or by the in-flight
concurrency). Cancel writes `cancelling` and aborts the controller; the worker writes the terminal
state. A queued run the worker never picked up is finalized by the route.

## Prompts and the judge

`evaluationCase` is the stable system message shared by every case of an account and model, so prompt
caching covers a whole run. Case instructions go in system 2 after the preset instructions; expected
answer, notes, and tags never enter the target request. Assistant instructions copied from a published
preset are wrapped with the shared untrusted envelope.

Judging is a second phase of the same run row. `queueJudge()` writes `judge_json`, resets counters, and
deletes old judge rows atomically; manual scores and raw outputs are untouched. The judge runs
sequentially, receives the rubric, the case input, the optional reference answer, and the candidate
answer — both answers inside `wrapUntrusted` as `evaluation_output` / `evaluation_expected`. A reply
must be one JSON object with an in-range score and a reason; anything else is a failed case with no
score row. The pass stops at $2 of judge spend. Judge cost is summed from score rows, never stored on
the run.

## API

Mounted at `/api/evaluations`, every route behind `requireUser` and `requireFeature("evaluations")`.
Foreign ids are 404, CAS/state conflicts 409 (a dataset/score conflict carries the stored row), invalid
bodies 400, quota 413. Progress is one small indexed row plus the judge cost sum, so a live view polls
`/runs/:id/progress` every 1.5 s instead of downloading results.

Export is generated on the fly and built completely before writing. CSV uses RFC 4180 quoting and CRLF,
and every cell beginning with `=`, `+`, `-`, `@`, tab, or CR is prefixed with `'` so a case or answer
cannot run as a spreadsheet formula. JSON carries full output text and both score sources.

Comparison matches cases by `case_id`, unions them in position order, and sends summaries plus scores
only; full answers come from the case endpoint when opened.

## Limits

| Bound | Value |
| --- | --- |
| Datasets per account | 50 |
| Cases per dataset / per run | 200 |
| Case text per dataset | 1 MiB |
| Runs per account | 50 |
| Active runs per account | 1 |
| Executing runs per process | 2 |
| Concurrency per run | 1–8, clamped by policy |
| Budget | $0.01–$20 and 10k–20M tokens |
| Per case | 120 s, 32 KiB stored output |
| Judge pass | $2 |
| Rubric / manual comment | 4,000 / 2,000 characters |

## Quota

Dataset text, case text and tags, run target/judge/label/error bytes, result output/error/snapshot
bytes, and score comment/rationale bytes count against the storage quota. Launch reserves each result
at 48 KiB (a true upper bound) plus the snapshot bytes. Case writes charge net growth; manual comments
and judge configs charge their growth.

## Web

One route with query state (`?dataset=`, `&run=`, `?compare=a,b`). Desktop is a 320 px dataset rail
plus the detail area; phones show one panel and Back returns one level. The page loads self permissions
before mounting the workspace, shows a disabled state that links to Account settings, and links to
Providers when no chat model is connected. State lives in `state/evaluations.ts` with per-slice load
tokens; only manual scores are optimistic. Views are `DatasetList`, `DatasetEditor`, `RunLauncher`,
`RunView`, `ResultsTable`, `CaseDetail`, `ScoreControl`, and `CompareRuns`. Answers and judge rationales
render as plain text, never Markdown.

Rebuilds after a dataset or run change never touch an existing run's results; the case detail always
shows the snapshot that actually ran.

## Deferred

CSV/JSON import, dataset templates, rubric libraries, multiple or ensemble judges, pairwise judging,
one-click retry of only failed cases, regression gates, scheduled/webhook runs, sharing or admin
visibility, charts and cost forecasting, tool-using or multi-turn cases, and textual output diffs.
