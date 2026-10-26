# NOTICE

varproof is an independent derived project. It is **not** a fork of css-tree and
contains no copied css-tree source. It depends on css-tree as an ordinary npm
package and calls only its public API.

## Runtime dependency

### css-tree 3.2.1 — MIT

- Repository: https://github.com/csstree/csstree
- Used for: CSS parsing (with source positions) and the property value grammar
  (`lexer.matchProperty`).
- API surface used: `parse`, `fork`, `lexer.matchProperty`, `generate`.
- Modifications: none. Not vendored into this repository.

Licence text as distributed by the upstream project:

```
Copyright (C) 2016-2026 by Roman Dvornov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Development-only dependencies

Used by `npm run oracle` (browser measurement). Not required at runtime and not
redistributed:

- **playwright-core** — Apache-2.0. Launches the locally installed browser; no
  browser binaries are bundled here.

## Upstream defects referenced by this project

These are reported, not patched. No upstream code is modified.

| Reference | Subject | Status when this was written |
|---|---|---|
| csstree/csstree#379 | parse() slowdown after one large stylesheet | open, no maintainer response |
| csstree/csstree#388 | parse() never returns for a specific input | open, no maintainer response |
| csstree/csstree#256 | typed custom properties | open, no maintainer response |
| csstree/csstree#321 | var() in property values | open, no maintainer response |
| csstree/csstree#62 | custom property validation | open, no maintainer response |
| csstree/csstree#325 | "Custom variable replacement for validation" | closed, unmerged |

The whitespace-loss behaviour of `generate()` documented in README §4 was found
while building this project; it is pinned by `test/collect.test.mjs` rather than
reported, because it may be a known trade-off in the upstream generator.

## Test data

- `test/fixtures/*.css` — written for this project.
- `test/fixtures/browser-oracle.json` — generated locally by
  `scripts/browser-oracle.mjs` against Edge 156.0.4314.42; contains measurements only, no
  third-party content.
- The third-party stylesheets used for the false-positive review (docsify,
  playwright-core) were read from an existing `node_modules` tree during
  verification. They are **not** included in this package.

## Trademarks

"CSS", "Chromium" and "Microsoft Edge" are used descriptively. This project is not
affiliated with or endorsed by the css-tree maintainers, the CSS Working Group, or
any browser vendor.
