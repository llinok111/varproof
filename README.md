# varproof

Static analyzer for CSS custom properties. It resolves `var()` the way a browser
does, then asks the CSS grammar whether the substituted value actually works.

```console
$ npx varproof "src/**/*.css"

src/button.css:12:3  error  --brand-coler is never declared and has no fallback, so this declaration is dropped  undefined-variable
                              did you mean --brand-color?
src/button.css:19:3  error  substituted value `red` does not match <height> syntax (Mismatch), so the declaration is dropped  invalid-substitution
src/theme.css:44:3   warn   --link-color holds no tokens; var(--link-color) is invalid at computed-value time and its fallback is ignored  empty-value
```

Everything else in the CSS linter space stops at the `var()`. `stylelint` 16.26.1
with `declaration-property-value-no-unknown` reports **nothing** for an undefined
variable, a wrong-type substitution, or a cycle; css-tree's own lexer refuses the
value outright (`Matching for a tree with var() is not supported`,
`lib/lexer/Lexer.js`). varproof closes that gap by substituting first and checking
second.

---

## 1. Why this exists

This is a derived project built on [css-tree](https://github.com/csstree/csstree)
(MIT). The choice was made on evidence, not on popularity:

| Candidate | Stars | Last commit | Verdict |
|---|---|---|---|
| `csstree/csstree` | 2,128 | 2026-09-16 | **Selected.** Parses CSS with positions and ships a property grammar, but has no custom-property resolution layer. Four related issues open with zero response. |
| `liabru/matter-js` | 18,492 | 2026-09-30 | Rejected. Healthy, but a physics engine offers no verifiable correctness gap that a small team could close honestly. |
| `micromatch/micromatch` | 3,044 | 2024-08-26 | Rejected. No commits for ~14 months; glob matching is already covered by `picomatch` and `path-scurry`. |

The gap is documented upstream:

- **#256** typed custom properties — open, no response
- **#321** `var()` in property values — open, no response
- **#62** custom property validation — open, no response
- **PR #325** "Custom variable replacement for validation" — closed unmerged

## 2. What varproof actually does

Pipeline, one file per stage, each independently tested:

```
parse      lib/parser.mjs    isolated css-tree instance (see §4)
collect    lib/collect.mjs   definitions, usages, source-sliced value text
resolve    lib/resolve.mjs   name -> candidate values, memoised
expand     lib/scanner.mjs   token-level var() substitution
grammar    lib/grammar.mjs   css-tree lexer on the substituted text
report     lib/index.mjs     rules, severities, suppression, sorting
```

### Rules

| Rule | Severity | Meaning |
|---|---|---|
| `undefined-variable` | error / warn | name declared nowhere; warn when a fallback exists |
| `fallback-invalid` | error | fallback exists but does not match the property grammar |
| `invalid-substitution` | error | substituted value fails the grammar, declaration is dropped |
| `resolution-cycle` | error | definitions reference each other in a cycle |
| `empty-value` | warn | custom property holds no tokens; its fallback is ignored |
| `malformed-var` | error | first argument is not a custom property name |
| `unused-variable` | warn | declared but never referenced (`--check-unused`) |
| `parse-error` | error | css-tree could not parse the file |

### Semantics, measured not assumed

These behaviours were measured in **Edge 156.0.4314.42** (Chromium) and are replayed on
every `npm test` from `test/fixtures/browser-oracle.json`. Several contradict the
"obvious" reading of the spec, which is why they are pinned by tests:

| Situation | Browser result | Consequence for the analyzer |
|---|---|---|
| undefined `var(--x, 42px)` | fallback used | warning, not error |
| undefined `var(--x, red)` on `width` | declaration dropped | `fallback-invalid` error |
| `--e: ;` then `width: var(--e, 50px)` | **fallback ignored**, dropped | `empty-value` warning |
| `--e: /**/;` (comment only) | same as empty | comment-only counts as empty |
| cycle + `var(--a, 50px)` at the use site | **fallback used** | cycle reported on the declaration only |
| `--s: var(--s, 10px)` | invalid — the fallback does not rescue it | self-cycle is an error |
| `--bad: red` then `height: var(--bad, 50px)` | **fallback ignored**, dropped | wrong type is not rescued by a fallback |
| `var(--light, #fff)var(--dark, #333)` (no space) | declaration dropped | `invalid-substitution` — real, this is what LightningCSS emits |
| `--i: 70px !important` | works | `!important` is stripped before checking |

Regenerate the oracle against your own browser with

```bash
npm install --no-save playwright-core   # not a declared dependency
npm run oracle                          # writes test/fixtures/browser-oracle.json
```

This needs a locally installed Chromium-based browser (Edge or Chrome). It is
optional: the recorded measurements are committed, so `npm test` — including the
oracle comparison — runs with no browser at all.

## 3. Install and run

```bash
npm install --no-audit --no-fund     # one runtime dependency: css-tree
npm test                             # 156 tests
node bin/varproof.mjs "src/**/*.css"
```

No build step: the package ships ES modules and runs on Node 18.17+ (verified on
22.22.2). `npm run bench`, `npm run repro` and `npm run oracle` are development
scripts, not required at runtime.

### CLI

```
varproof [options] <file | directory | glob ...>
varproof -                              # read from stdin
  --check-unused          also report declared-but-unreferenced properties
  --allow-undefined       undefined variables become warnings
  --ignore <glob>         ignore variable names matching a glob (repeatable)
                          `--ignore --brand` and `--ignore=--brand` both work
  --max-candidates <n>    cap distinct resolutions per variable (default 8)
  --format <text|json>    json includes per-declaration verdicts
  --quiet                 summary line only
  --list-rules            print the rule catalogue
```

A directory argument is walked recursively for `.css` files, skipping
`node_modules`, `.git`, `dist`, `build` and `coverage`. When a glob is used it is
expanded by varproof itself, so quoting works the same in bash, cmd and PowerShell.

Exit codes: `0` no errors, `1` at least one error, `2` usage or IO problem.

### Suppressing a finding

```css
/* varproof-disable */                         /* whole file */
/* varproof-disable-next-line */               /* next line, every rule */
/* varproof-disable-next-line empty-value */   /* next line, one rule */
.a { color: var(--runtime); } /* varproof-disable-next-line */  /* same line */
```

A standalone comment governs the following line; a trailing comment governs its
own line. Stacked comments do not leak rules onto each other's target.

### Library

```js
import { analyzeSources, judgeDeclaration } from 'varproof';

const result = analyzeSources([{ path: 'a.css', text: css }], { checkUnused: true });

for (const finding of result.findings) {
  console.log(finding.file, finding.line, finding.rule, finding.message);
}
console.log(result.stats);
```

`analyzeSources` accepts many files at once and shares definitions across them,
which is what a design-token file plus component files actually needs.

## 4. Two upstream defects this project works around

Both are reproduced by `npm run repro` on the published `css-tree@3.2.1`.

**#379 — performance cliff.** `parse()` reuses one `TokenStream` whose buffers only
grow, and every parse calls `balance.fill(0)` over the whole retained array. One
large stylesheet therefore slows every later parse in the same process (medians of
5 rounds × 2,000 parses, Node 22.22.2):

```
clean            0.0050 ms/parse
after 1 MB       0.1401 ms/parse    28x
after 4 MB       0.5455 ms/parse   109x
after 22 MB      3.2099 ms/parse   642x
```

`lib/parser.mjs` recycles the instance via css-tree's public `fork()` when a much
smaller source follows a large one, or after 4 MB of cumulative input. Measured
cost of a recycle is ~3.5 ms, so it is amortized away; the isolated parser stays at
`0.008–0.013 ms/parse` in every configuration above. The wrapper is verified by
`test/parser.test.mjs`, which asserts that the same workload on the shared
singleton *is* slower, so the workaround cannot quietly become a no-op.

**#388 — non-termination.** A 40-byte input makes `parse()` hang forever after an
unrelated earlier parse. Because the hang is synchronous, no in-process watchdog
can catch it; `scripts/repro-upstream.mjs` runs it in a child process and kills it
after 8 s. varproof does not patch the tokenizer — it recycles the instance, which
removes the state the hang depends on.

**A third defect, found while building this: `generate()` loses whitespace.**

```js
generate(parse('.a{border-radius: 0 var(--r) var(--r) 0}').children.first.block.children.first.value)
// => '0 var(--r) var(--r)0'      <- the space before the final 0 is gone
```

This made the analyzer report a *valid* docsify declaration as a syntax error.
`lib/collect.mjs` therefore slices value text out of the source by node offset
instead of regenerating it. `test/collect.test.mjs` asserts the upstream behaviour
still reproduces, so the workaround cannot silently rot.

## 5. Verification

| Claim | How it is checked | Result |
|---|---|---|
| Rules match a real engine | 24 declarations measured in Edge 156.0.4314.42, replayed by `test/oracle.test.mjs` | 24/24 agree |
| No regression | `npm test` | 156 pass, 0 fail |
| Zero false positives on real CSS | 36 third-party stylesheets (docsify, playwright-core, VS Code webview), 7,693 custom properties, 1,392 references | 0 false positives found by manual review |
| Parser workaround is effective | `npm run bench`, medians of 5×2000 parses | 642x → 1.7–2.5x of baseline |
| Upstream defects are real | `npm run repro` | both reproduce |

The 36-file run reports 36 errors and 59 warnings; every error was traced to its
source and is a **true positive**, not an analyzer bug:

- `background: 1px solid var(--vscode-editorGroup-border)` — playwright-core uses a
  colour variable where a `border` shorthand belongs.
- `background: var(--light, #fff)var(--dark, #333)` — LightningCSS output with no
  space between two functions; Edge drops the declaration (verified separately).
- `outline: var(--color-focus-border)` — referenced but never declared in that file.
- 28 `parse-error` — SCSS sources (`.css` extension, nested syntax). These are
  correctly flagged, with a hint to run the analyzer on compiled CSS.

The 58 `empty-value` warnings are the docsify theme's deliberate "let this inherit"
switches (`--link-color: ;`). They are warnings, not errors, precisely because the
construct is intentional there — but it genuinely does kill the declaration, and
Edge confirms the fallback is not consulted.

## 6. Known limitations

These are deliberate scope decisions, not oversights.

1. **No cascade model.** When a variable has several definitions (media queries,
   `@layer`, theme files), varproof returns every distinct expansion and only
   reports a problem when *none* of them matches the grammar. It cannot say which
   one wins at a given viewport. A false negative is possible if one definition
   would be valid; a false positive is not.
2. **Runtime-injected variables.** `el.style.setProperty('--x', v)` is invisible to
   static analysis, so names injected that way look undefined. Use `--ignore` or a
   suppression comment.
3. **Custom property values are not type-checked.** `--gap: red` used in `margin` is
   only caught at the use site, after substitution — that is the check that
   matters, but the definition alone is not flagged.
4. **Grammar coverage is css-tree's.** Unregistered and unknown properties are
   reported as `skipped`, never as errors. `-webkit-line-clamp` happens to be in the
   grammar; a truly unknown property produces no finding.
5. **Non-CSS dialects.** SCSS/Less nesting produces `parse-error` with a hint. No
   preprocessor is bundled.
6. **`@scope` and `@container` do not narrow resolution.** Their inner rules share
   the global definition set, which widens the candidate list and can therefore only
   reduce findings, not create them.
7. **Candidate cap.** More than `--max-candidates` distinct expansions are truncated
   and marked `truncated` in the JSON output.
8. **Performance figures are from one machine** (Windows, Node 22.22.2, quiet).
   Ratios are reproducible; absolute numbers are not. Benchmarks are advisory and
   are not a CI gate.

## 7. Licence and provenance

- varproof: **MIT** (see `LICENSE`).
- Builds on [`css-tree`](https://github.com/csstree/csstree) 3.2.1, **MIT**,
  Copyright (c) 2016-2026 Roman Dvornov and contributors. Not vendored, not
  modified: it is a normal npm dependency, and css-tree's licence text is
  reproduced in `NOTICE.md` as MIT requires for distributions.
- No source code was copied from css-tree into this repository. The integration
  points are its public API: `parse`, `fork`, `lexer.matchProperty`, `generate`
  (the last one only as a fallback path, see §4).
- Test fixtures are synthetic except where noted; the third-party stylesheets used
  for the false-positive review were read from an existing `node_modules` tree and
  are **not** redistributed here.

Upstream defects are reported as findings, not fixed here. If css-tree fixes #379
or #388, `npm run repro` fails and tells you to revisit `lib/parser.mjs` — the
workaround is designed to be removed, not to become permanent.
