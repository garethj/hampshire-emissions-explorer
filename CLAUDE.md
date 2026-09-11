# Project instructions — Hampshire Emissions Explorer

## Don't clutter the main page — put explanatory/derived text in the chart's (i) dialog instead

When a chart needs a sentence of context, a derived headline figure, or an explanation of what it's comparing (e.g. "this generation total is equivalent to X% of local demand"), it belongs in that chart's info modal (`INFO_CONTENT` in `assets/js/app.js`, opened via the "i" button) — not as a permanent element on the page next to the chart.

**Why:** The main page is meant to stay a small set of charts and controls. An on-page note next to every chart that needs explaining would turn it into a wall of text before long. The "i" dialog already exists specifically to hold this kind of detail on demand, without competing for space on the page itself.

**How to apply:** For text that's dynamic (depends on region/year/metric/etc.), store the computed string in a module-level variable, updated whenever the chart rebuilds, and expose it via a function on that chart's `INFO_CONTENT` entry that `openModal()` calls. Use `dynamicIntro` — rendered above the body — only for a finding a reader wants first, like the generation chart's demand-comparison figure, which is the reference implementation. Use `dynamicOutro` — rendered below the body, styled as a muted `.modal-note` aside — for a technical caveat that answers "how was this derived", like each chart's fixed-scale axis-setter sentence. A caveat is the wrong opening sentence for a general reader and exactly what an expert came for, so it belongs last, not first. Static explanatory text goes straight into that chart's `INFO_CONTENT[key].body` array.

Explain each concept in exactly one dialog and link to it from the others, rather than restating it: GWP weighting lives in `horizon-toggle`, parish apportionment in `general-methodology`, national grid pooling in `generation-chart`, the toe/MWh factor in `energy-unit-toggle`. Write a cross-reference as `[[key|label]]` in any `body` string or `dl` definition; `renderRichText()` turns it into an inline button that opens that entry. The click handler is delegated from `document`, so these work even though they're created after wire-up — don't revert it to a per-button `querySelectorAll`.

Reserve genuine on-page real estate for load-bearing UI only — chart titles, axis labels, legends — not commentary or supporting detail.
