# Project instructions — Hampshire Emissions Explorer

## Don't clutter the main page — put explanatory/derived text in the chart's (i) dialog instead

When a chart needs a sentence of context, a derived headline figure, or an explanation of what it's comparing (e.g. "this generation total is equivalent to X% of local demand"), it belongs in that chart's info modal (`INFO_CONTENT` in `assets/js/app.js`, opened via the "i" button) — not as a permanent element on the page next to the chart.

**Why:** The main page is meant to stay a small set of charts and controls. An on-page note next to every chart that needs explaining would turn it into a wall of text before long. The "i" dialog already exists specifically to hold this kind of detail on demand, without competing for space on the page itself.

**How to apply — the dialog's three parts.** Every `INFO_CONTENT` entry has the same shape, and a new one must keep it (`tests/js/app.integration.test.js` enforces it):

- `summary` — one sentence, at most 30 words, saying what this is. Everyone reads it, so it comes first and must not be a caveat.
- `readIt` — a few bullets on reading what's on screen.
- `method` — `[term, definition]` rows behind a "Method, sources & caveats" disclosure, for someone checking the figures rather than reading them. Reuse the labels `Source`, `Basis`, `Calculated here` and `Composite regions` wherever they apply, even when other wording would read better: an expert should learn one place to look for what's official DESNZ data and what this site derived, on every chart.

The disclosure starts collapsed and remembers being opened (`methodOpenPref`, `localStorage`), so a general reader gets ~70 words while an expert expands once and every dialog thereafter opens expanded. That layering is what lets detail stay without the dialog reading as a wall of text — so when a dialog needs more expert detail, add a `method` row rather than trimming the substance. Set `alwaysOpen: true` only where the reader has already explicitly asked for the method, as `general-methodology` has.

**Dynamic text.** Store the computed string in a module-level variable, updated whenever the chart rebuilds, and expose it via a function on that chart's entry. Use `axisNote` for the live fixed-scale setter sentence: it renders as the final method row, because "why is the axis this high" is the wrong opening sentence for a general reader and exactly what someone auditing the chart came for. Use `dynamicIntro` only for a finding worth leading with — currently just the generation chart's demand comparison, which renders as a highlighted figure under the summary.

**Cross-references.** Explain each concept in exactly one dialog and link to it from the others rather than restating it: GWP weighting lives in `horizon-toggle`, parish apportionment in `general-methodology`, national grid pooling in `generation-chart`, the toe/MWh factor in `energy-unit-toggle`. Write a link as `[[key|label]]` in any `summary`, `readIt` or `method` string; `renderRichText()` turns it into an inline button opening that entry, and the breadcrumb in the modal head walks back. The click handler is delegated from `document` — don't revert it to a per-button `querySelectorAll`, which can't see buttons built when a dialog renders.

Reserve genuine on-page real estate for load-bearing UI only — chart titles, axis labels, legends — not commentary or supporting detail.
