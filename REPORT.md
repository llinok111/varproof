# Delivery report — varproof 0.1.0

Derived open-source project built on `csstree/csstree` (MIT).
Report covers the six requested phases. Every number below was produced by a
command in this repository, on Windows 11 / Node 22.22.2 / css-tree 3.2.1 /
Edge 156.0.4314.42.

---

## Phase 1 — Candidate discovery and elimination

Three candidates were taken from the GitHub catalogue and checked against their
README, licence, real source, tests, release history and public issue tracker. Star
count was **not** used as a decision criterion; the least-starred candidate won.

| | `csstree/csstree` | `liabru/matter-js` | `micromatch/micromatch` |
|---|---|---|---|
| Stars | 2,128 | 18,492 | 3,044 |
| Licence | MIT | MIT | MIT |
| Last commit | 2026-09-16 | 2026-09-30 | 2024-08-26 |
| Open issues | 83 | 279 | 45 |
| Tests | 16,725 (mocha, run locally: all green) | browser-based | small |
| Verdict | **Selected** | Rejected | Rejected |

**Why matter-js was rejected.** It is healthy and much more popular, but every
improvement candidate (soft-body, CCD, deterministic replay) is a physics-correctness
change whose only cheap verification is visual. The brief explicitly prefers
rejecting a popular repository over producing a mediocre derivative, and a physics
patch written without domain depth would be exactly that.

**Why micromatch was rejected.** No commits since 2024-08-26 — 14 months of silence
at decision time. Its niche is already served by `picomatch` (a faster derivative
maintained by the same community) and `path-scurry`. Scope too narrow to improve
meaningfully.

**Why csstree was selected.** It is the only candidate with a *verifiable capability
gap*: it parses CSS and ships a property grammar, but its lexer refuses to look at
any value containing `var()`.

```js
// lib/lexer/Lexer.js — css-tree 3.2.1
lexer.matchProperty('margin', parse('var(--x)', { context: 'value' }))
// error: "Matching for a tree with var() is not supported"
```

Upstream confirms the gap is known and unattended:

| Reference | Subject | State |
|---|---|---|
| csstree#256 | typed custom properties | open, 0 comments |
| csstree#321 | `var()` in property values | open, 0 comments |
| csstree#62 | custom property validation | open, 0 comments |
| PR #325 | "Custom variable replacement for validation" | closed, unmerged |

Two performance/correctness defects were also reproduced (see Phase 2).

---

## Phase 2 — Deep dissection of csstree

**Core capability.** CSS parser producing a positioned AST, plus a grammar database
(~600 properties, `mdn-data`) usable through `lexer.matchProperty`. Verified:
`width: red` → Mismatch, `-webkit-box-shadow: 0 0 1px red` → matched.

**Internal shape relevant to this project.** Custom property values are stored as
`Raw` nodes — `--gap: var(--space)` arrives as an opaque string and is never parsed
into a `Function` node. Any consumer that wants to understand `var()` must tokenise
that string itself. `Lexer.js` handles custom properties with an explicit
"doesn't applicable" branch, i.e. matching is skipped by design.

**Target users.** Tooling authors: css minifiers/optimisers (csso), editors,
linters, `csstree-validator`. Not end users.

**Existing problems, each reproduced locally:**

1. **csstree#379 — performance cliff** (`npm run repro`).
   `TokenStream.setSource` reuses arrays that only grow and calls
   `balance.fill(0)` over the entire retained buffer each parse.
   Measured: clean `0.0050 ms/parse` → after a 22 MB stylesheet
   `3.2099 ms/parse` (**642x**). Feeding a small source afterwards does not recover
   (`3.5337 ms/parse`).
2. **csstree#388 — non-termination** (`npm run repro`).
   A 40-byte input after an unrelated parse never returns; the child process was
   killed after 8 s. Synchronous, so no in-process watchdog can catch it.
3. **`generate()` loses whitespace** (found during this project, not reported upstream).
   ```js
   generate(parse('.a{border-radius: 0 var(--r) var(--r) 0}')…value)
   // '0 var(--r) var(--r)0'   <- space before the trailing 0 is gone
   ```
   This corrupted the analyzer's own input and produced a false positive on a valid
   docsify declaration.

**Use value of the gap.** A whole class of CSS bugs is invisible to every current
tool. Verified with a negative control: `stylelint@16.26.1` with
`declaration-property-value-no-unknown` correctly flags `width: notalength` (2
problems in the control file) but reports **0 problems** for a stylesheet containing
`margin: var(--nope)` and `width: var(--nope)`. `csstree-validator@4.0.1` also
reports 0 findings on the same input (measured; probe retained in the session log).

---

## Phase 3 — Differentiation design

**Chosen improvement.** Resolve custom properties the way an engine does, then run
the existing grammar against the *substituted* text. This converts an unsupported
case into an answerable one — no css-tree internals are patched.

**What it solves.** Undefined variables, cycles, empty definitions, wrong-type
substitutions, invalid fallbacks and typos now have names, positions and messages.

**Why it is worth doing.** These are silent failures: the declaration is dropped and
the property falls back to its initial or inherited value, so the developer sees
"the style doesn't apply" with no error anywhere.

**Difference from the original project.** csstree is a parser plus grammar. varproof
adds a resolution layer (`resolve.mjs`, `scanner.mjs`) and a verdict engine
(`index.mjs`). It consumes only public API: `parse`, `fork`, `lexer.matchProperty`.

**Difference from neighbouring tools.**

| Tool | Resolves `var()` | Checks substituted type | Detects cycles | Detects empty |
|---|---|---|---|---|
| stylelint 16 (`declaration-property-value-no-unknown`) | no | no | no | no |
| csstree-validator | no | no | no | no |
| `postcss-custom-properties` | yes (build transform) | no | no | no |
| **varproof** | yes | yes | yes | yes (fallback-aware) |

**Licence check.** css-tree is MIT; reuse, modification and redistribution are
permitted with the copyright notice retained. varproof does not copy css-tree source
and does not vendor it — it is a normal dependency, with the upstream MIT text
reproduced in `NOTICE.md`.

**Deliberately rejected ideas** (to avoid padding or over-refactoring): cascade
specificity computation (`csso`/`crassus` already do dead-rule analysis), `@scope`
simulation, a CSS formatter, a PostCSS plugin wrapper, and fixing #379/#388 upstream
(see Phase 5).

---

## Phase 4 — Development

**Baseline first.** Before any change: `npx mocha lib/__tests` on a full clone of
csstree → **16,725 passing**. The three upstream defects were then reproduced against
the published package, not against a modified tree.

**Code written** — 9 library modules, 1 CLI, 3 scripts, 8 test files.

| File | Lines | Purpose |
|---|---|---|
| `lib/parser.mjs` | 89 | isolated css-tree instance with capacity-aware recycling |
| `lib/collect.mjs` | 165 | AST walk → definitions/usages; source-sliced value text |
| `lib/scanner.mjs` | 300 | `var()` token scanner + browser-faithful expansion |
| `lib/resolve.mjs` | 121 | name → candidate values, SCC-aware, memoised |
| `lib/graph.mjs` | 152 | iterative Tarjan SCC + readable cycle paths |
| `lib/grammar.mjs` | 62 | substitution-aware grammar check |
| `lib/directives.mjs` | 91 | suppression comments |
| `lib/suggest.mjs` | 88 | bounded Levenshtein "did you mean" |
| `lib/index.mjs` | 380 | rules, severities, verdicts, statistics |
| `bin/varproof.mjs` | 290 | CLI, glob/dir expansion, text + JSON output |

**Five defects found and fixed during development.** Three appeared first as failing
tests; two were found only by the CI matrix on Node 18/20 after everything passed
locally on Node 22 — the same class of mistake that is easy to ship unnoticed.

1. **Quadratic complexity in cycle detection.** `findCycles` ran a BFS per node pair
   inside each SCC — O(n²·(n+e)). A 5,000-node cycle made the test suite hang for
   **3 min 20 s**. Fixed by using the SCC itself as the member list; the same test now
   runs in **1.4 s**. Caught because the test used a deliberately deep synthetic graph.
2. **Whitespace loss from `generate()`** (Phase 2 defect 3). Fixed by slicing value
   text out of the source by node offset. Pinned by a test that asserts the upstream
   behaviour still reproduces.
3. **`--ignore` could not accept a value.** Every custom property name begins with
   `--`, and the argument parser rejected any value starting with `--`, so
   `varproof --ignore --brand` exited 2. Fixed with an explicit value-option set plus
   `--ignore=--brand` support; a genuinely missing value is still an error.
4. **`fs.promises.glob` in the CLI — Node 22 only, while `engines` declares 18.17.**
   Node 18/20 have no such export. Found by CI (`test (windows-latest, 18)` and `20`
   failed while `22` passed). Replaced with a self-contained `*`/`?`/`**` expander.
5. **`node --test "test/*.test.mjs"` — quoted-glob expansion arrived in Node 21/22.**
   Node 18/20 treat the pattern as a literal path: `Could not find
   'D:\a\varproof\varproof\test\*.test.mjs'`. Found by the same CI run. The test
   script is now bare `node --test`, whose file discovery works on 18 through 22
   (verified locally: 156 tests discovered).

Defects 4 and 5 are now guarded by `test/package.test.mjs`, which fails if a
Node-22-only API is reintroduced or the test script goes back to a shell-dependent
glob. Both were invisible on the development machine.

**Tests added** — 156 total, all passing.

```
$ npm test
# tests 156
# pass 156
# fail 0
```

Per file: scanner 26, analyze 26, oracle 25, cli 24, collect 11, resolve 10,
graph 9, directives 8, parser 7, package 7.

**Build / regression.** No build step (plain ESM, Node 18.17+). The upstream defect
canary is advisory in CI by design: it asserts the *presence* of css-tree bugs, so
it must not break a green build when upstream fixes them.

---

## Phase 5 — Independent verification

| Claim | Method | Result |
|---|---|---|
| Rules match a real engine | 24 declarations measured in Edge 156.0.4314.42 (`npm run oracle`), replayed offline by `test/oracle.test.mjs` | **24/24 agree** |
| No regression | `npm test` on a clean copy with only the declared dependency installed | **156 pass, 0 fail** |
| Runs on the declared engine floor | GitHub Actions matrix: ubuntu/windows/macos x Node 18, 20, 22 | see §Phase 5 note |
| Starts independently | copy of `bin/ lib/ test/ scripts/ package.json` into an empty dir → `npm install` (3 packages) → `npm test` → CLI run | works |
| Packages and runs as published | `npm pack` → install the tarball in an empty project → `npx varproof t.css` | exit 1, correct finding; tarball 23.8 kB, 14 files |
| No false positives on real CSS | 36 third-party stylesheets (docsify, playwright-core, VS Code webview), 7,693 custom properties, 1,392 references | 36 errors / 59 warnings, **every one traced and confirmed a true positive** |
| Parser workaround is effective | `npm run bench`, medians of 5×2,000 parses | shared singleton degrades **642x**; isolated parser stays at 1.7–2.5x of baseline |
| Documented CLI forms work | every command in README §3 executed in CI | all pass |

**The 36-file false-positive review, in detail.** Every finding was read back against
its source:

- `background: 1px solid var(--vscode-editorGroup-border)` — playwright-core uses a
  colour variable where a `border` shorthand belongs. Real bug (variable is defined
  as `#e7e7e7` / `#444`).
- `background: var(--light, #fff)var(--dark, #333)` — LightningCSS output with no
  space between two functions. **Verified in Edge that the declaration is dropped**,
  so this is real, not an analyzer artefact.
- `outline: var(--color-focus-border)` — referenced in the file, declared nowhere.
- 28 `parse-error` — docsify `.css` sources that are SCSS (nested `> .progress`).
  Correct output; the message now carries a hint to run on compiled CSS.

**One rule was deliberately downgraded after this review.** `empty-value` was an
error, which produced 58 errors on docsify's core theme where `--link-color: ;` is a
deliberate "let it inherit" switch. It is now a warning whose message names both
possible intents. This is a real judgement call, made on the evidence that the
construct is intentional in a widely used project, and it is recorded in README §6.

**Unfinished / not done, stated plainly:**

1. **No cascade model.** Multiple definitions are all evaluated; a problem is
   reported only when *none* can satisfy the grammar. Which definition wins at a
   given viewport is not computed.
2. **Runtime-injected variables** are indistinguishable from typos by design; the
   escape hatches are `--ignore` and suppression comments.
3. **No upstream patch for #379/#388.** Deriving a project is not licence to fork
   internals we cannot maintain. The wrapper is designed to be deleted once upstream
   fixes them — `npm run repro` will fail and say so.
4. **No CSS-in-JS or preprocessor support.** SCSS/Less are only reported as
   `parse-error`.
5. **`@scope` / `@container` do not narrow resolution**, which can only reduce
   findings (false negatives), never create them.
6. **`csstree-validator`'s probe was run from an existing install**, not from a
   fresh clone; and the stylelint comparison used version 16.26.1 only.
7. **Performance numbers are from one machine.** Ratios reproduce; absolutes do not.
   They are not a CI gate.

---

## Phase 6 — Deliverables

| Item | Path |
|---|---|
| Library | `lib/*.mjs` (9 modules) |
| CLI entry | `bin/varproof.mjs` |
| Tests | `test/*.test.mjs` (8 files) + `test/fixtures/` |
| Browser ground truth | `test/fixtures/browser-oracle.json` + `scripts/browser-oracle.mjs` |
| Benchmarks and defect reproductions | `scripts/bench-parser.mjs`, `scripts/repro-upstream.mjs` |
| Documentation | `README.md` (rules, semantics table, limitations), `REPORT.md` |
| Licence and attribution | `LICENSE` (MIT), `NOTICE.md` (css-tree MIT text, upstream issue table) |
| CI | `.github/workflows/ci.yml` (3 OS × 3 Node versions + README smoke test) |
| Archive | `varproof-0.1.0.zip` |

**Not published to GitHub at report time** — publication was attempted only after
all verification above passed; see the session record for the final state of the
push and the repository URL. If the push did not happen, the ZIP plus the steps in
README §3 are the complete deliverable.

### Deltas vs. the original project

| Aspect | css-tree | varproof |
|---|---|---|
| Scope | CSS parser + grammar | custom-property semantics on top of that parser |
| `var()` | refused by the lexer | scanned, expanded, resolved |
| Custom property values | `Raw` string, opaque | tokenised, cycle-graph analysed, substituted |
| Large-input behaviour | degrades 642x in-process | recycled instance, stays near baseline |
| Output | AST / generator | findings with positions, severities, suggestions, JSON verdicts |
| Source relationship | — | dependency only; **zero copied code** |