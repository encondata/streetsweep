---
name: factory
description: Run StreetSweep's software factory. /factory <feature>, /factory next, /factory approve <job-id>, /factory rework <job-id> <note>. The session running it is the orchestrator.
---

# The software factory

You are the **orchestrator**. You run the loop below, spawn every agent, and you are the
**only writer of `factory/board.json`**. Agents get their context from files, never from
this conversation, and each writes only its own file.

```
feature → spec-writer → builder ⇄ [security · ux · ui · code] → approver → merge to v2
                          ▲        WAIT FOR ALL 4; any CHANGES:      │
                          └─────── resume builder (max 2 reworks)    └→ needs-human
```

Edit this file to change the factory. The agents are in `.claude/agents/`.

## Places

- Repo: the main checkout (this directory). Base branch **`v2`** (not `main`: that's v1).
- Job folder: `factory/jobs/<job-id>/` (`spec.md`, `build.md`, `round-N/review-*.md`, `decision.md`).
- Job id: `NNN-slug`, NNN one more than the highest folder in `factory/jobs/` (start at 001),
  slug a few words of the feature, lowercase, hyphens.
- Branch: `factory/<job-id>`. Worktree (where the builder works, so the main checkout is
  never switched): `../StreetSweep-factory/<job-id>`.
- Never `git push`. Pushing is the person's call.

## board.json

Create it as `{"jobs": []}` if missing. One entry per job; rewrite the file whole after
every change (the dashboard polls it):

```json
{ "id": "003-rate-limiting", "title": "Rate-limit sign-in", "branch": "factory/003-rate-limiting",
  "stage": "review", "round": 2, "builder": "<agent id>", "updated": "<ISO time>",
  "rounds": [ { "round": 1, "reviews": { "security": "CHANGES", "ux": "PASS", "ui": "PASS", "code": "PASS" } },
              { "round": 2, "reviews": { "security": "pending", "ux": "pending", "ui": "pending", "code": "pending" } } ],
  "reviews": { "security": "pending", "ux": "pending", "ui": "pending", "code": "pending" } }
```

`stage` is one of `spec`, `build`, `review`, `approve`, `merged`, `needs-human`, `failed`.
`reviews` is always a copy of the latest round's.

## /factory <feature>

1. Make the job id and folder; write `factory/jobs/<id>/feature.md` with the feature text.
   Add the job to the board at `stage: "spec"`.
2. `git worktree add ../StreetSweep-factory/<id> -b factory/<id> v2`
3. **Spec.** Spawn `spec-writer` (prompt: the job folder path). Wait for `spec.md`.
4. **Build.** Board → `stage: "build"`. Spawn `builder` with description
   `builder-<id>`, prompt: job folder, worktree path, branch. Record its agent id in the
   board's `builder`. Wait for `build.md`.
5. **Review round N** (N starts at 1). Make `round-N/`; board → `stage: "review"`,
   `round: N`, a new `rounds` entry all `pending`. Spawn the four reviewers **in one
   message**, in parallel: `security-reviewer`, `ux-reviewer`, `ui-reviewer`,
   `code-reviewer`, each told the job folder, worktree and round folder. As each
   finishes, read the first line of its file (`VERDICT: PASS` or `VERDICT: CHANGES`) and
   update its chip on the board.
6. **WAIT FOR ALL.** The round is done only when all four files exist in `round-N/`.
   Never resume the builder mid-round.
   - Any `CHANGES` and fewer than 2 reworks so far: board → `stage: "build"`;
     `SendMessage` to the same builder (its recorded id): "Round N reviews are in
     `<round folder>`. Address every CHANGES item, commit, and rewrite build.md." Wait,
     then go to step 5 with N+1. (If the builder can't be reached, say after a restart,
     spawn a new `builder` the same way and point it at build.md and every round folder.)
   - All `PASS`, or CHANGES left after 2 reworks: go to step 7.
7. **Approve.** Board → `stage: "approve"`. Spawn `approver`. Wait for `decision.md`.
   - First line `APPROVE`: merge (below), board → `stage: "merged"`.
   - First line `ESCALATE`: board → `stage: "needs-human"`. Tell the person why, in one
     or two sentences from decision.md, and that `/factory approve <id>` or
     `/factory rework <id> <note>` decide it.

**Merge**: in the main checkout, only if it's on `v2` with no tracked changes
(`git status --porcelain --untracked-files=no` is empty); otherwise stop and say so.
`git merge --no-ff factory/<id> -m "Factory: <title> (<id>)"`, then
`git worktree remove ../StreetSweep-factory/<id>`. Keep the branch.

## /factory next

Take the first unchecked `- [ ]` item in `factory/backlog.md`, tick it (`- [x]`, add the
job id after it), and run it as `/factory <that text>`.

## /factory approve <job-id>

For a `needs-human` job: the person has decided. Merge it (as above) and set
`stage: "merged"`. Add a line to `decision.md`: `Approved by a person on <date>.`

## /factory rework <job-id> <note>

Write the note to `factory/jobs/<id>/rework-<n>.md`. Board → `stage: "build"`. Resume the
job's builder (or spawn a new one) pointing it at the note, then continue from step 5
with the next round number. The rework count starts again from zero.

## Dashboard

`cd factory && python3 -m http.server 8765`, then open http://localhost:8765/dashboard.html.
