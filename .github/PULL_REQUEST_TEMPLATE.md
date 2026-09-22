## Summary

<!-- One paragraph: what changed and why. Not which files changed — the diff shows that. -->

## Type of change

- [ ] feat — new functionality
- [ ] fix — bug fix
- [ ] refactor — behavior-preserving
- [ ] chore / docs / test / ci / build / perf

## Test plan

<!-- Commands run and results, e.g. `bun run test` → 11 pass. "I ran the tests" is not a test plan. -->

## Runtime evidence

<!-- Required. Fresh output from this session: command + exit code + key lines.
     UI changes: screenshot reference (.run/ui-evidence/...) + console error delta.
     Critical paths (see AGENTS.md): state white-box review requested.
     "None — review-only change" allowed only with a stated reason. -->

## Risk

<!-- What could break? Which stored user configs / wire payloads / permissions does this touch?
     Rollback path? Ban-risk relevance if delivery/chat behavior changes. -->

## Canonicality check

- [ ] No `_v1`/`_v2`/`_new`/`_old`/`_backup` suffixes introduced.
- [ ] No duplicated logic (searched for an existing implementation first).
- [ ] No commented-out blocks, dead exports, or scratch directories added.
- [ ] `bun run check:baseline` passes (no new findings; decreases re-recorded in this PR).
- [ ] Generated files (`components.d.ts`, `auto-imports.d.ts`, `.output/`) untouched by hand.

## References

<!-- Issues, PRs, ADRs -->
