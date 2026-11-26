(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  let DATA = null;
  let ENERGY_DATA = null;
  let currentRegion = "winchester";
  let currentMetric = "per_capita"; // "total" | "per_capita"
  let currentView = "latest"; // "latest" | "historical"
  let currentDetail = false; // show sector chart as sub-sectors (latest view only)
  let currentConsumptionDetail = false; // show consumption chart as all fuel types instead of simple groups
  let currentConsumptionView = "fuel"; // "fuel" (by fuel type) | "sector" (by Domestic/Transport/Industrial)
  let currentHorizon = "gwp100"; // "gwp100" (official DESNZ) | "gwp20"
  // Whether the reader has ticked the trend chart's "estimated consumption footprint" box. Kept
  // separate from whether the line actually shows (footprintActive()), so switching to a view or
  // horizon where it's unavailable and back again restores their choice rather than clearing it.
  let footprintPref = false;
  // "kwh" (GWh / kWh per person) | "toe" (ktoe / toe per person) — shared display unit for the
  // generation and consumption charts, which otherwise show each dataset's own native unit (see
  // KTOE_TO_MWH below).
  let currentEnergyUnit = "kwh";
  // "fixed" (default) or "auto" — governs the y/x-axis scale of the generation and consumption
  // charts. "fixed" uses one shared axis max per region tier (historic districts / current
  // unitaries / proposed unitaries / Hampshire and the Solent) so switching between regions in
  // the same tier doesn't rescale the chart and hide a real difference in volume — e.g. Gosport's
  // renewable generation is genuinely ~30x smaller than Test Valley's, not just differently
  // proportioned. Defaults to "fixed" (not a toggle defaulting to "auto") because a chart that
  // sometimes rescales and sometimes doesn't, depending on a control elsewhere on the page, reads
  // as more confusing than one that's always comparable — "auto" stays available as an escape
  // hatch for the (rarer) case where a small region's own internal composition needs the full
  // width to read clearly. See generationTierMax/consumptionTierMax below.
  let currentScaleMode = "fixed";
  // "context" (self + ancestors up to Hampshire and the Solent, the default) or "constituents"
  // (all siblings at the nearest level with children — see nearestHub() below) — drives the top
  // trend chart's region set. Reset to "context" on every region change, since carrying
  // "constituents" across a region switch would land on a sibling set unrelated to the click
  // that triggered it.
  let compareMode = "context";
  let tooltipEl = null;

  // Headline "Total renewable generation, 2024: X GWh - equivalent to Y% of demand" sentence,
  // recomputed on every buildGenerationChart() call and surfaced inside the generation chart's
  // info modal (dynamicIntro below) rather than as a permanent on-page note, so region/year/
  // metric changes don't need a second render path just to keep this one sentence in sync.
  let generationNoteText = "";

  // "Which control combination currently sets this chart's fixed-scale ceiling" sentences —
  // recomputed on every build*Chart() call for the chart in question and surfaced inside that
  // chart's info modal (dynamicIntro below), the same pattern as generationNoteText above. Useful
  // because the answer is rarely the obviously-selected region/year: for the sector, gas and trend
  // charts it can come from the *other* GWP horizon entirely (see sectorTierMax/gasTierMax/
  // trendGlobalMax's own comments), and for per-person figures it can come from a region outside
  // the selected one's own tier (see tierScopeKey).
  let sectorScaleNoteText = "";
  let gasScaleNoteText = "";
  let generationScaleNoteText = "";
  let consumptionScaleNoteText = "";
  let trendScaleNoteText = "";

  // Every region this site can show — built from DATA.meta.region_index (see region_index in
  // process.py) once data loads, rather than hardcoded here, since there are 20 of them across
  // four tiers (historic districts / current unitaries / Hampshire, the county / proposed
  // unitaries) plus Hampshire and the Solent itself. Populated by initRegions() in init(). `group`
  // and `parent` drive the dropdown grouping and the context-chart hierarchy helpers just below.
  let REGIONS = [];
  let REGION_LABEL = {};
  let REGION_BY_KEY = {};

  function initRegions() {
    REGIONS = DATA.meta.region_index.map(r => ({
      key: r.key,
      label: r.name,
      group: r.group,
      parent: r.parent
    }));
    REGION_LABEL = Object.fromEntries(REGIONS.map(r => [r.key, r.label]));
    REGION_BY_KEY = Object.fromEntries(REGIONS.map(r => [r.key, r]));
  }

  // ---------------- region hierarchy ----------------
  // Two distinct rollups exist for a region and shouldn't be conflated: how its own *figures*
  // are built (which LAs, at what population-weighted share — baked into the data files already,
  // nothing to do with this section) versus which single region it rolls up to in the *UI*
  // hierarchy used here — the dropdown's grouping and the context chart's ancestor chain. E.g.
  // East Hampshire's hierarchy parent is Mid-Hampshire, even though a small population slice of
  // it is also baked into South East Hampshire's own figures.

  function regionParent(key) {
    const r = REGION_BY_KEY[key];
    return r ? r.parent : null;
  }

  // Self, then parent, then grandparent, ... up to and including Hampshire and the Solent.
  function regionAncestors(key) {
    const chain = [];
    let k = key;
    while (k) {
      chain.push(k);
      k = regionParent(k);
    }
    return chain;
  }

  // Excludes "county" (Hampshire) even though its `parent` is hampshire-solent: unlike the
  // proposed unitaries + Isle of Wight, which are a clean, non-overlapping partition of Hampshire
  // and the Solent, Hampshire's total overlaps ~80% with North/Mid/South-East/South-West Hampshire
  // (it's the same 11 districts split a different way). Listing it as a sixth "sibling" there would
  // both mislead (it isn't a distinct partition member) and, being far larger than any one proposed
  // unitary, compress their bars in the very comparison that matters most for LGR. It still climbs
  // the ancestor chain via regionParent/regionAncestors for its own "compare in context" view
  // (Hampshire vs. Hampshire and the Solent) — only this constituents-listing direction is blocked.
  function regionChildren(key) {
    return REGIONS.filter(r => r.parent === key && r.group !== "county").map(r => r.key);
  }

  // The nearest region (self or an ancestor) that has constituents to show — used by the
  // "compare all constituents" mode. A region with its own children (e.g. a proposed unitary)
  // is its own hub; a leaf (a historic district, or a current unitary like Portsmouth) defers to
  // its parent, so picking a leaf and toggling "constituents" shows its siblings, not itself.
  function nearestHub(key) {
    return regionChildren(key).length > 0 ? key : regionParent(key);
  }

  // All regions sharing a region's tier ("group": historic-district / current-unitary /
  // proposed-unitary / aggregate) — the "fixed scale" comparison set for generationTierMax and
  // consumptionTierMax below. Hampshire and the Solent is the only "aggregate" region, so its own
  // tier is just itself (fixed scale there is a no-op, same as auto).
  function regionsInTier(key) {
    const r = REGION_BY_KEY[key];
    if (!r) return [key];
    return REGIONS.filter(x => x.group === r.group).map(x => x.key);
  }

  // Tier grouping exists only because *totals* scale with a region's population/area — a district's
  // total is naturally smaller than a unitary's, so fixed scale keeps them apart to avoid squashing
  // the smaller one. Per-person figures already divide that difference out, so there's no reason a
  // district's per-person value and a unitary's shouldn't share one axis — these two helpers widen
  // the comparison set to every region on a per-person metric, and stay tier-scoped for totals.
  function tierScopeKey(regionKey, metric) {
    if (metric === "per_capita") return "all";
    return REGION_BY_KEY[regionKey] ? REGION_BY_KEY[regionKey].group : regionKey;
  }
  function tierScopeRegions(regionKey, metric) {
    return metric === "per_capita" ? REGIONS.map(r => r.key) : regionsInTier(regionKey);
  }

  // Tracks which single (region, year, category[, horizon]) combination sets a running max/min as
  // a tier-max scan walks its comparison set — used to surface *which* control combination is
  // currently responsible for a fixed-scale ceiling/floor in each chart's info dialog (see e.g.
  // "sector-chart"'s dynamicIntro below), since it's rarely the obviously-selected region/year and
  // can come from the *other* GWP horizon entirely (see the sector-chart info dialog).
  function newExtentTracker() {
    return { max: 0, maxSetter: null, min: 0, minSetter: null };
  }
  function trackMax(t, value, setter) {
    if (value > t.max) { t.max = value; t.maxSetter = setter; }
  }
  function trackMin(t, value, setter) {
    if (value < t.min) { t.min = value; t.minSetter = setter; }
  }

  // Renders a tracked setter as a short clause for an info-dialog sentence, e.g. "New Forest's
  // Industry sector in 2007 (12.9 t CO2e/person, 20-year GWP)". `formatValue` turns the raw number
  // into its displayed units; horizon is omitted from a setter that doesn't track one (generation/
  // consumption figures aren't GWP-weighted, so they never differ by horizon).
  function describeSetter(setter, formatValue) {
    if (!setter) return null;
    const horizonClause = setter.horizon === "gwp20" ? ", 20-year GWP" : "";
    const categoryClause = setter.category ? "'s " + setter.category + " in " + setter.year : "'s " + setter.year + " figure";
    return REGION_LABEL[setter.region] + categoryClause +
      " (" + formatValue(setter.value) + horizonClause + ")";
  }

  // Display heading + explicit order for the region select's <optgroup>s. "aggregate"
  // (Hampshire and the Solent) isn't listed — it renders as a loose top-level option, not inside
  // a group, since it's the one region that isn't a constituent of anything else on this site.
  const REGION_GROUP_LABEL = {
    "historic-district": "Historic districts",
    "current-unitary": "Current unitaries",
    "county": "Hampshire (county)",
    "proposed-unitary": "Proposed unitaries (provisional)"
  };
  // "county" (Hampshire) sits directly after "current-unitary" so it reads as grouped with
  // Portsmouth/Southampton/Isle of Wight in the list, even though it's a separate fixed-scale tier
  // (see REGION_DEFS in la_config.py) and excluded from their "compare all constituents" set (see
  // regionChildren above) — this ordering is purely cosmetic, decoupled from both of those.
  const REGION_GROUP_ORDER = ["historic-district", "current-unitary", "county", "proposed-unitary"];

  // Builds the #region-select's <option>/<optgroup> markup from REGIONS — nothing hardcoded in
  // index.html, so the dropdown always matches whatever region_index the data actually contains.
  function populateRegionSelect() {
    const select = document.getElementById("region-select");
    clearNode(select);
    REGIONS.filter(r => r.group === "aggregate").forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.key; opt.textContent = r.label;
      select.appendChild(opt);
    });
    REGION_GROUP_ORDER.forEach(group => {
      const members = REGIONS.filter(r => r.group === group);
      if (!members.length) return;
      const og = document.createElement("optgroup");
      og.label = REGION_GROUP_LABEL[group];
      // Historic districts are alphabetised (11 of them — easier to scan); the unitary groups
      // keep REGIONS' own order, which already reads sensibly (Isle of Wight, then the two
      // absorbed cities; North, Mid, South East, South West geographically).
      const ordered = group === "historic-district" ? [...members].sort((a, b) => a.label.localeCompare(b.label)) : members;
      ordered.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r.key; opt.textContent = r.label;
        og.appendChild(opt);
      });
      select.appendChild(og);
    });
  }

  // This order is not alphabetical — it's chosen so that consecutive sectors always land on a
  // CVD-safe adjacent pair of colours in the historical (line) chart, which renders sectors in
  // this exact fixed sequence. See the CVD note in CATEGORY_COLOR_SLOT below; don't reorder this
  // casually without re-running the palette validator against the new adjacency.
  const SECTOR_ORDER = ["Transport", "Domestic", "LULUCF", "Waste", "Commercial", "Agriculture", "Public Sector", "Industry"];

  // Gas display order — separate from the 1-8 sector slots since the sector and gas charts are
  // never shown side by side.
  const GAS_ORDER = ["CO2", "CH4", "N2O"];
  const GAS_LABEL = { CO2: "CO2", CH4: "CH4 (methane)", N2O: "N2O (nitrous oxide)" };

  // Matches ENERGY_DATA.meta.technology_groups (see process_energy.py). Also not alphabetical —
  // reordered from the "natural" Solar/Wind/Hydro/Bioenergy/Other grouping for the same
  // CVD-adjacency reason as SECTOR_ORDER above (the historical chart renders this fixed order).
  const ENERGY_TECH_ORDER = ["Solar", "Bioenergy & waste", "Wind", "Hydro", "Other"];

  // Matches ENERGY_DATA.meta.fuel_categories (see process_energy.py) for four of these six —
  // DESNZ's own directly-published fuel categories. "Electricity" isn't one of the six: DESNZ
  // publishes a single Electricity figure with no source attribution, so this site splits it into
  // "Fossil fuel electricity" and "Renewable electricity" using that year's DUKES national
  // generation mix (see electricityFuelSplitKtoe above) — the same split used for both this
  // "complex" (all fuel types) view and the "simple" grouping below.
  const FUEL_ORDER = ["Coal", "Manufactured fuels", "Petroleum", "Gas", "Fossil fuel electricity", "Renewable electricity", "Bioenergy and wastes"];
  const FUEL_LABEL = {
    Coal: "Coal", "Manufactured fuels": "Manufactured fuels", Petroleum: "Oil (petroleum)",
    Gas: "Gas", "Fossil fuel electricity": "Fossil fuel electricity",
    "Renewable electricity": "Renewable electricity", "Bioenergy and wastes": "Bioenergy & waste"
  };
  // "Simple" view groups: not DESNZ categories, a bucketing this site applies for the collapsed
  // default view. "Green energy" combines two different *kinds* of figure — Bioenergy and wastes
  // is a real, measured local quantity (fuel actually burned within the area); Renewable
  // electricity is a national statistical estimate applied uniformly to this area's own
  // electricity ktoe. Both are legitimate and both are genuinely renewable/low-carbon by
  // official convention, but they're not the same kind of "green" — see this chart's "i" button.
  // The same distinction applies to "Fossil fuels": Coal/Manufactured fuels/Petroleum/Gas are
  // measured local combustion; Fossil fuel electricity is the national-mix estimate.
  const FUEL_SIMPLE_GROUPS = {
    "Fossil fuels": ["Coal", "Manufactured fuels", "Petroleum", "Gas", "Fossil fuel electricity"],
    "Green energy": ["Renewable electricity", "Bioenergy and wastes"]
  };

  // Matches ENERGY_DATA.meta.sector_categories (see process_energy.py) — the consumption chart's
  // alternate breakdown axis: the same "All fuels: Total" figure split by sector (Domestic /
  // Transport / Industrial, Commercial and other) instead of by fuel type. Toggled against
  // FUEL_ORDER/FUEL_SIMPLE_GROUPS above, never shown alongside them, so it doesn't need its own
  // simple/detailed split. This view exists specifically to make visible when a large industrial
  // or commercial energy user (not local households) is driving an area's consumption total —
  // see meta.note_industrial_consumption.
  const CONSUMPTION_SECTOR_ORDER = ["Domestic", "Transport", "Industrial, Commercial and other"];
  const CONSUMPTION_SECTOR_LABEL = {
    Domestic: "Domestic",
    Transport: "Transport",
    "Industrial, Commercial and other": "Industrial, commercial & other"
  };

  // ---------------- category colours ----------------
  // Every named category on this site (sector, gas, technology, fuel, region) gets a *fixed*
  // colour by identity, not by its position in whatever array or sort order happens to render
  // it — so "Agriculture" is always the same green whether it's the biggest bar or the
  // smallest, and whether SECTOR_ORDER gets reordered or not. All colours are drawn from the
  // same validated 8-hue --series-1..8 categorical palette (assets/css/style.css) — nothing
  // new is invented here, each category is just pinned to one of those 8 slots by a real-world
  // association (sun = yellow, water = aqua, farming = green, gas's blue flame, etc.) rather
  // than left to whatever index it happens to sit at.
  //
  // The same slot is deliberately reused across *different* chart families where it reinforces
  // the same real-world idea (e.g. green for both Agriculture and Bioenergy & waste; violet for
  // "Other" wherever an "Other" bucket exists) — safe because those charts are never shown side
  // by side.
  //
  // CVD adjacency: for charts that render categories in a *fixed* order (the historical/line
  // charts — sector, gas, generation, consumption), the sequence in which their category slots
  // are actually drawn next to each other was checked with this skill's palette validator
  // (dataviz skill, scripts/validate_palette.js) and passes both light and dark mode. That's why
  // SECTOR_ORDER and ENERGY_TECH_ORDER above aren't alphabetical, and why a couple of picks below
  // (CH4, N2O, the "Fossil fuels" simple-view group) aren't the first-choice mnemonic hue — e.g.
  // red/orange next to each other fails CVD separation, so CH4 couldn't be orange while sitting
  // next to CO2's red. The *sorted-by-value* bar views (sector/generation/consumption "latest")
  // can't get the same guarantee, since which categories end up adjacent depends on that year's
  // data — this was already true before this mapping existed (colour was previously pinned by
  // array position, not identity, but the sort-driven adjacency risk is unchanged either way).
  // Regions aren't in CATEGORY_COLOR_SLOT below: with 20 of them and only 8 slots, no fixed
  // per-region identity colour is possible (or useful — at most ~5 regions are ever on screen
  // together). See contextRegionColor() near the trend chart for how region colour is assigned
  // instead: by role (selected region / its parent / Hampshire and the Solent) in "context" mode,
  // by a fixed validated slot rotation in "constituents" mode.
  const CATEGORY_COLOR_SLOT = {

    // Emissions sectors — all 8 slots used once each.
    "Transport": 1,      // blue
    "Domestic": 2,       // orange — heating/warmth
    "LULUCF": 3,          // aqua — land/forestry carbon sink
    "Waste": 4,           // yellow — recycling-bin yellow
    "Commercial": 5,      // magenta
    "Agriculture": 6,     // green — farming/land
    "Public Sector": 7,   // violet — civic/institutional
    "Industry": 8,        // red

    // Greenhouse gases — CO2 red (the near-universal "warming" hue). CH4 violet and N2O green
    // aren't the first-choice mnemonic (CH4 ties more naturally to gas/orange, N2O to
    // agriculture/orange-ish), but red-orange fails CVD separation, so CH4 couldn't sit next to
    // CO2 as orange; N2O's green at least echoes its main real-world source (agricultural soils
    // and manure — the same association as the Agriculture sector's green).
    "CO2": 8,
    "CH4": 7,
    "N2O": 6,

    // Renewable generation technologies.
    "Solar": 4,               // yellow — the sun
    "Wind": 1,                // blue — the sky
    "Hydro": 3,                // aqua — water
    "Bioenergy & waste": 6,   // green — organic matter (matches the fuel category below)
    "Other": 7,                // violet — the "everything else" bucket, wherever it appears

    // Energy consumption by fuel — "complex" (all fuel types) view. DESNZ's exact spelling
    // ("Bioenergy and wastes") differs slightly from the generation chart's "Bioenergy & waste"
    // but is the same real-world category, so it gets the same green. Fixed order for this list is
    // Coal-Manufactured-Petroleum-Gas-FossilElec-RenewElec-Bioenergy (see FUEL_ORDER) — every
    // adjacent pair below (8-7, 7-5, 5-1, 1-3, 3-4, 4-6) reuses a pairing already validated
    // elsewhere in this file (SECTOR_ORDER/GAS_ORDER/ENERGY_TECH_ORDER), rather than introducing
    // an unvalidated adjacency — deliberately avoiding orange (2) next to either yellow (4, fails
    // CVD separation, see below) or the reds/violets already either side of it in this sequence.
    "Coal": 8,                        // red — combustion
    "Manufactured fuels": 7,          // violet — coal-derived, grouped near Coal's family
    "Petroleum": 5,                   // magenta
    "Gas": 1,                         // blue — the iconic blue gas flame
    "Fossil fuel electricity": 3,     // aqua — sits between Gas and Renewable electricity
    "Renewable electricity": 4,       // yellow — keeps the old "Electricity" slot's lightning-bolt
                                       // association, narrowed to specifically its renewable share
    "Bioenergy and wastes": 6,        // green

    // Energy consumption by fuel — "simple" (grouped) view. Not real DESNZ categories, so these
    // get their own slot rather than inheriting one component's colour arbitrarily.
    // Violet rather than the more obvious orange ("generic fossil" hue) because this group sits
    // next to Green energy's green, and orange-green isn't a pairing validated elsewhere in this
    // file (7-6 is, e.g. Public Sector next to Agriculture).
    "Fossil fuels": 7,    // violet
    "Green energy": 6,    // green — matches Bioenergy and wastes' slot, one of its two constituents

    // Energy consumption by sector — the consumption chart's alternate view (toggled against the
    // by-fuel-type view above, never shown together). "Domestic" and "Transport" reuse the exact
    // same slots as their emissions-sector namesakes above, since they're the same real-world
    // category. "Industrial, Commercial and other" gets its own slot (Industry's red) as the
    // dominant real-world driver of that bucket — CONSUMPTION_SECTOR_ORDER is deliberately
    // ordered (Domestic, Transport, Industrial...) so this red slot sits next to Transport's blue
    // rather than Domestic's orange, since red-orange adjacency fails CVD separation (see above).
    "Industrial, Commercial and other": 8  // red — shares Industry's slot
  };

  // ---------------- helpers ----------------

  // Rough (deliberately generous) estimate of a bold value-label's rendered width in this
  // chart family's font — used to size a "latest" bar chart's right margin from the actual
  // label text, rather than a fixed guess. A fixed margin clips the *longest* bar's label
  // specifically: a shorter bar leaves unused plot space for its label to spill into before
  // hitting the SVG's edge, but the longest bar's bar already fills the full plot width, so its
  // label has only the fixed margin to work with — if that's narrower than the label, it's cut
  // off exactly there (as seen on New Forest's Solar and Fossil fuels bars). Calibrated against
  // real rendered text (Chromium, Roboto, 12.5px bold): observed ~6.1-6.6 px/char across a range
  // of formatted value+unit strings; 7.5 leaves headroom for font-rendering differences across
  // browsers/platforms.
  function estimateLabelWidth(text) {
    return text.length * 7.5;
  }

  // Right margin for a "latest" bar chart's value+unit labels. In auto mode, sizing it from just
  // the rows actually on screen is enough (see estimateLabelWidth's own comment). In fixed mode
  // it isn't: two regions in the same tier share an axis maxVal, but if each region's margin were
  // still sized from its own (smaller-magnitude) labels, their drawable plot widths would differ
  // slightly, so the same shared value would render at very slightly different pixel widths
  // between regions — undermining the whole point of a "fixed" scale. Sizing the margin from the
  // tier's own peak value instead (formatted the same way) gives every region in the tier an
  // identical margin, and therefore an identical plot width.
  function latestBarRightMargin(rows, formatLabel, tierMax) {
    const labels = currentScaleMode === "fixed" ? [formatLabel(tierMax)] : rows.map(r => formatLabel(r.value));
    return Math.ceil(Math.max(80, ...labels.map(estimateLabelWidth)) + 16);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function seriesColor(slot) {
    return cssVar("--series-" + slot);
  }

  // Deterministic (not random) fallback for a category this site doesn't know about yet, e.g.
  // DESNZ adding a 9th sector or a new renewable technology in a future data release. A truly
  // random colour would change on every reload, defeating the whole point of "consistent" —
  // hashing the name instead means the same unknown category always lands on the same slot,
  // for this session and the next. It can still collide with a sibling category in the same
  // chart (a hash has no way to know what else is on screen); the console warning is there so
  // a real new category gets a deliberate, non-colliding slot added to CATEGORY_COLOR_SLOT
  // above rather than being left to chance indefinitely.
  function hashSlot(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) | 0;
    }
    return (Math.abs(h) % 8) + 1;
  }

  function categoryColor(name) {
    const slot = CATEGORY_COLOR_SLOT[name];
    if (slot) return seriesColor(slot);
    console.warn("No colour mapping for \"" + name + "\" — using a hash-derived fallback. Add it to CATEGORY_COLOR_SLOT in app.js.");
    return seriesColor(hashSlot(name));
  }

  function regionColor(key) {
    return categoryColor(key);
  }

  function formatIsoDate(isoDate) {
    const d = new Date(isoDate + "T00:00:00Z");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  }

  function fmtKt(n) {
    return Number(n).toLocaleString("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }

  function fmtInt(n) {
    return Math.round(n).toLocaleString("en-GB");
  }

  function fmtPerCapita(n) {
    return Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }

  function fmtPct(n) {
    const sign = n > 0 ? "+" : "";
    return sign + n.toLocaleString("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + "%";
  }

  // population_thousands (e.g. 212.345) as a person count, rounded to the nearest hundred —
  // DESNZ's mid-year estimates aren't precise to the individual, so showing exact ones would be
  // false precision.
  function fmtPopulation(thousands) {
    return (Math.round(thousands * 10) * 100).toLocaleString("en-GB");
  }

  // Metric-aware formatting: "total" is kt CO2e (whole numbers), "per_capita" is t CO2e per person (2dp).
  function fmtValue(metric, n) {
    return metric === "total" ? fmtKt(n) : fmtPerCapita(n);
  }

  function fmtAxisValue(metric, n) {
    return metric === "total" ? fmtInt(n) : n.toLocaleString("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }

  function unitLabel(metric) {
    return metric === "total" ? "kt CO2e" : "t CO2e / person";
  }

  function unitShort(metric) {
    return metric === "total" ? "kt" : "t";
  }

  // Energy figures are stored in MWh (matching the source workbooks) but always displayed in
  // GWh, since these regions' totals (tens of thousands to ~1M MWh) read better compressed.
  function fmtGwh(mwh) {
    return (Number(mwh) / 1000).toLocaleString("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }

  function fmtRatioPct(n) {
    return Number(n).toLocaleString("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + "%";
  }

  // Same DUKES/IEA factor as data/process_energy.py's KTOE_TO_MWH — used here to let the
  // generation chart (native MWh) and consumption chart (native ktoe) share one display-unit
  // toggle (currentEnergyUnit) instead of each being stuck in its own dataset's native unit.
  const KTOE_TO_MWH = 11630;

  // DUKES table 6.5a: Great Britain's "Share of renewable generation" — a *national* figure, not
  // part of any of the sub-national datasets this site otherwise loads, so it's fetched and parsed
  // separately (data/fetch_energy_source.py + process_energy.py's read_dukes_renewable_share) into
  // ENERGY_DATA.meta.dukes_electricity_mix, keyed by year as {greenPct, fossilPct}. "greenPct" is
  // DUKES's own renewable-generation share; "fossilPct" is the remainder (100 - greenPct), DUKES's
  // usual simplification for a two-way split — it's really "non-renewable" (nuclear and net
  // imports included alongside fossil fuel), not fossil fuel alone. See the consumption chart's
  // "i" button for how this is used and its limits.
  function dukesElectricityMix() {
    return ENERGY_DATA.meta.dukes_electricity_mix || {};
  }

  // Splits a region's electricity consumption (in ktoe, its native unit here) into a fossil and a
  // renewable share, using that year's DUKES national generation mix uniformly — deliberately
  // *not* netted against the region's own local renewable generation (an earlier version of this
  // feature did that, and a concrete case exposed why it doesn't hold up: New Forest hosts
  // Marchwood, a ~900MW gas-fired power station invisible to this calculation since only renewable
  // generation is published by local authority, so netting only local *renewables* off first made
  // New Forest look greener than the national average despite hosting a large fossil plant. Since
  // the grid pools everything, no consumer's actual draw can honestly vary from the national mix
  // by area — this applies the same ratio to every region's electricity, uniformly, matching that
  // physical reality rather than crediting whatever generation happens to be nearby). See
  // note_dukes_electricity_mix in mid_hampshire_energy.json and this chart's "i" button.
  function electricityFuelSplitKtoe(electricityKtoe, year) {
    const mix = dukesElectricityMix()[year];
    // Defensive fallback for a year TFEC consumption data covers but DUKES doesn't (not currently
    // possible — DUKES 6.5a spans 1996–2025, consumption 2005–2024 — see
    // test_dukes_electricity_mix_covers_consumption_years in data/tests): treat as entirely
    // non-renewable rather than assume a green share with no evidence for it.
    const greenPct = mix ? mix.greenPct : 0;
    const fossilPct = mix ? mix.fossilPct : 100;
    return {
      "Fossil fuel electricity": electricityKtoe * (fossilPct / 100),
      "Renewable electricity": electricityKtoe * (greenPct / 100)
    };
  }

  // Single point of access for a fuel-type's ktoe figure, whether it's one of DESNZ's own
  // published categories (straight from fuels_ktoe) or one of the two derived electricity-split
  // categories above — lets consumptionValue/fuelSimpleBreakdown below treat all fuel keys
  // uniformly rather than each needing its own special case.
  function consumptionFuelKtoe(c, year, fuelKey) {
    if (fuelKey === "Fossil fuel electricity" || fuelKey === "Renewable electricity") {
      return electricityFuelSplitKtoe(c.fuels_ktoe.Electricity, year)[fuelKey];
    }
    return c.fuels_ktoe[fuelKey];
  }

  // Consumption-by-fuel figures are stored in ktoe, DESNZ's own native unit for this dataset.
  function fmtKtoe(ktoe) {
    return Number(ktoe).toLocaleString("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }

  // Per-capita generation uses kWh/person rather than GWh/person (which would be a tiny
  // fraction for every region) — values land in the low hundreds to low thousands, so this
  // keeps fmtGwh's 1dp precision.
  function fmtKwhPerCapita(n) {
    return Number(n).toLocaleString("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }

  // Per-capita consumption uses toe/person rather than ktoe/person — values land in the same
  // 1-10 range as emissions' t CO2e/person, so this uses fmtPerCapita's 2dp precision.
  function fmtToePerCapita(n) {
    return Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }

  // Appended to chart/KPI titles whenever the 20-year horizon is active, so it's never ambiguous
  // which set of figures is on screen — this is the one thing distinguishing an unofficial
  // GWP20 view from DESNZ's own published GWP100 numbers.
  function horizonTitleSuffix() {
    return currentHorizon === "gwp20" ? " (20-year GWP)" : "";
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k in attrs) e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "viz-tooltip";
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function showTooltip(x, y, buildFn) {
    const tt = ensureTooltip();
    clearNode(tt);
    buildFn(tt);
    tt.style.left = (x + window.scrollX + 14) + "px";
    tt.style.top = (y + window.scrollY + 14) + "px";
    tt.classList.add("is-visible");
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.classList.remove("is-visible");
  }

  function ttRow(parent, colorHex, label, value) {
    const row = document.createElement("div");
    row.className = "tt-row";
    const key = document.createElement("div");
    key.className = "tt-key";
    if (colorHex) {
      const stroke = document.createElement("span");
      stroke.className = "stroke";
      stroke.style.background = colorHex;
      key.appendChild(stroke);
    }
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    key.appendChild(labelSpan);
    const val = document.createElement("div");
    val.className = "tt-val";
    val.textContent = value;
    row.appendChild(key);
    row.appendChild(val);
    parent.appendChild(row);
  }

  function ttTitle(parent, text) {
    const t = document.createElement("div");
    t.className = "tt-title";
    t.textContent = text;
    parent.appendChild(t);
  }

  // Indented, muted row for a hovered bar's breakdown (e.g. Transport's sub-sectors, or Fossil
  // fuels' constituent fuel types) — visually distinct from ttRow's main aggregate row without
  // a colour swatch, since these all share the parent's identity rather than having their own.
  // groupFirst marks the first row of a breakdown group explicitly (rather than relying on a
  // CSS :first-of-type, which would only catch the very first .tt-subrow in the whole tooltip —
  // wrong when more than one hovered row has its own breakdown, e.g. the historical crosshair
  // showing several series at once). groupLast marks the last row of a group whose tooltip
  // keeps going with another row afterwards belonging to a *different* parent (e.g. the next
  // region in a multi-region crosshair) — the divider goes after this row instead of before it,
  // so it reads as closing this group rather than detaching this row from its own parent above.
  function ttSubRow(parent, label, value, groupFirst, groupLast) {
    const row = document.createElement("div");
    row.className = "tt-row tt-subrow" + (groupFirst ? " tt-subrow-first" : "") + (groupLast ? " tt-subrow-last" : "");
    const key = document.createElement("div");
    key.className = "tt-key";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    key.appendChild(labelSpan);
    const val = document.createElement("div");
    val.className = "tt-val";
    val.textContent = value;
    row.appendChild(key);
    row.appendChild(val);
    parent.appendChild(row);
  }

  // Muted "Population" subrow showing the person count a per-capita figure was divided by —
  // only relevant under the per-capita metric (population isn't part of the "total" calculation,
  // so it'd be noise there), and only when that region/year actually has a population figure
  // (the historical trend chart's post-latest-year "required pathway" points don't).
  function ttPopulationRow(tt, regionKey, year, metric, groupFirst, groupLast) {
    if (metric !== "per_capita") return;
    const yd = DATA.regions[regionKey] && DATA.regions[regionKey].years[year];
    if (!yd) return;
    ttSubRow(tt, "Population", fmtPopulation(yd.population_thousands), groupFirst, groupLast);
  }

  // ---------------- data access ----------------

  function regionYears(regionKey) {
    return DATA.meta.years;
  }

  // Horizon-aware view of a region's year data: under GWP20, total_kt_co2e, per_capita_t_co2e
  // and sectors_kt_co2e are swapped for their .gwp20 counterparts (see process.py) — everything
  // else (population_thousands) is unaffected by the horizon, so it passes through unchanged.
  function yearData(regionKey, year) {
    const yd = DATA.regions[regionKey].years[year];
    return currentHorizon === "gwp20" ? Object.assign({}, yd, yd.gwp20) : yd;
  }

  // Runs fn() under a specific GWP horizon, then restores whatever currentHorizon was before —
  // used by the sector/gas tier-max scans below so they can find the true max across *both*
  // horizons (see those functions for why) without permanently switching the horizon everyone
  // else is reading.
  function withHorizon(horizon, fn) {
    const prev = currentHorizon;
    currentHorizon = horizon;
    try {
      return fn();
    } finally {
      currentHorizon = prev;
    }
  }

  function regionSeriesTotals(regionKey) {
    return DATA.meta.years.map(y => yearData(regionKey, y).total_kt_co2e);
  }

  function latestYear() {
    return DATA.meta.years[DATA.meta.years.length - 1];
  }

  function regionMetricValue(regionKey, year, metric) {
    const yd = yearData(regionKey, year);
    return metric === "total" ? yd.total_kt_co2e : yd.per_capita_t_co2e;
  }

  function sectorMetricValue(regionKey, year, sector, metric) {
    const yd = yearData(regionKey, year);
    const raw = yd.sectors_kt_co2e[sector];
    return metric === "total" ? raw : raw / yd.population_thousands;
  }

  function gasMetricValue(regionKey, year, gas, metric) {
    const yd = yearData(regionKey, year);
    const raw = yd.gases_kt_co2e[gas];
    return metric === "total" ? raw : raw / yd.population_thousands;
  }

  // The site only bakes in sub-sector detail for the latest year (DATA.subsector_detail_latest_year;
  // DESNZ publishes it for every year, but data/process.py exports just the latest),
  // grouped by parent sector (in SECTOR_ORDER) and sorted by magnitude within each sector.
  // Groups sub-sector rows under their parent sector, with sectors ordered by their own total
  // (descending) — the same order the non-detail view sorts by — so toggling "sub-sector
  // detail" on doesn't reshuffle which sector sits at the top; it only expands each one in place.
  // Sub-sector rows for a single sector, sorted by magnitude — the building block both the
  // full sub-sector detail view and the latest-view tooltip's "breakdown" rows are built from.
  function sectorSubrowsFor(regionKey, ly, sector, metric) {
    const detailRoot = currentHorizon === "gwp20" ? DATA.subsector_detail_latest_year.gwp20 : DATA.subsector_detail_latest_year;
    const subs = detailRoot[regionKey][sector] || {};
    const population = DATA.regions[regionKey].years[ly].population_thousands;
    return Object.keys(subs).map(name => ({
      name: name,
      sector: sector,
      value: metric === "total" ? subs[name] : subs[name] / population
    })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  }

  function sectorSubrows(regionKey, ly, metric) {
    const sectorsByTotal = SECTOR_ORDER.slice()
      .sort((a, b) => sectorMetricValue(regionKey, ly, b, metric) - sectorMetricValue(regionKey, ly, a, metric));
    const rows = [];
    sectorsByTotal.forEach(sector => {
      rows.push(...sectorSubrowsFor(regionKey, ly, sector, metric));
    });
    return rows;
  }

  // Sub-sector names repeat their parent sector's name as a prefix (e.g. "Agriculture
  // Livestock", "LULUCF Net Emissions: Forestry") — strip it for the chart row label
  // since the row is already colour-coded by sector; full names still appear in the table.
  function shortSubsectorLabel(sector, name) {
    let label = name;
    if (label.startsWith(sector + " ")) label = label.slice(sector.length + 1);
    if (sector === "LULUCF") label = label.replace(/^Net Emissions:\s*/, "");
    return label.replace(/'/g, "");
  }

  // ---------------- energy data access ----------------

  function energyGenerationYears() {
    return ENERGY_DATA.meta.generation_years;
  }

  function energyLatestGenerationYear() {
    const years = energyGenerationYears();
    return years[years.length - 1];
  }

  function energyGeneration(regionKey, year) {
    return ENERGY_DATA.regions[regionKey].generation[year];
  }

  function energyConsumption(regionKey, year) {
    return ENERGY_DATA.regions[regionKey].consumption[year];
  }

  function energyConsumptionYears() {
    return ENERGY_DATA.meta.consumption_years;
  }

  // Population isn't part of ENERGY_DATA — it's the same DESNZ mid-year estimates already
  // loaded for the emissions dataset, for the same regions and (fully overlapping) years, so
  // energy per-capita figures reuse it rather than duplicating it.
  function regionPopulation(regionKey, year) {
    return DATA.regions[regionKey].years[year].population_thousands;
  }

  // Generation is stored in MWh. "Totals" keeps that (fmtGenerationMetric formats it as GWh);
  // "Per person" divides by population-in-thousands instead, which cancels both factors of
  // 1000 and lands directly on kWh/person — the same trick sectorMetricValue/gasMetricValue
  // use for emissions (kt / population-thousands = t/person).
  function generationMetricValue(regionKey, year, rawMwh, metric) {
    return metric === "total" ? rawMwh : rawMwh / regionPopulation(regionKey, year);
  }

  // unit "kwh" shows generation's native GWh/kWh-per-person; "toe" converts to ktoe/toe-per-person
  // via KTOE_TO_MWH, so the chart can match whatever unit family the consumption chart is on.
  function fmtGenerationMetric(metric, unit, n) {
    if (unit === "toe") {
      return metric === "total" ? fmtKtoe(n / KTOE_TO_MWH) : fmtToePerCapita(n / KTOE_TO_MWH);
    }
    return metric === "total" ? fmtGwh(n) : fmtKwhPerCapita(n);
  }

  function generationUnitLabel(metric, unit) {
    if (unit === "toe") return metric === "total" ? "ktoe" : "toe/person";
    return metric === "total" ? "GWh" : "kWh/person";
  }

  // "Simple" categories collapse FUEL_ORDER into FUEL_SIMPLE_GROUPS; "complex" uses FUEL_ORDER
  // directly; "sector" (axis === "sector") ignores detail entirely and uses
  // CONSUMPTION_SECTOR_ORDER instead — a different breakdown axis of the same total, with no
  // simple/detailed split of its own. "axis" here is currentConsumptionView (fuel/sector) — kept
  // as its own name rather than "breakdown" since that word already means something else nearby
  // (fuelSimpleBreakdown's per-fuel drill-down rows). Returns [{key, label}], where key is what
  // consumptionValue expects back.
  function consumptionCategories(detail, axis) {
    if (axis === "sector") {
      return CONSUMPTION_SECTOR_ORDER.map(s => ({ key: s, label: CONSUMPTION_SECTOR_LABEL[s] }));
    }
    return detail
      ? FUEL_ORDER.map(f => ({ key: f, label: FUEL_LABEL[f] }))
      : Object.keys(FUEL_SIMPLE_GROUPS).map(g => ({ key: g, label: g }));
  }

  // Consumption is stored in ktoe. "Totals" keeps that; "Per person" divides by
  // population-in-thousands, cancelling to toe/person (mirrors generationMetricValue above).
  function consumptionValue(regionKey, year, categoryKey, detail, metric, axis) {
    const c = energyConsumption(regionKey, year);
    if (!c) return null;
    const raw = axis === "sector"
      ? c.sector_ktoe[categoryKey]
      : detail
        ? consumptionFuelKtoe(c, year, categoryKey)
        : FUEL_SIMPLE_GROUPS[categoryKey].reduce((sum, f) => sum + consumptionFuelKtoe(c, year, f), 0);
    return metric === "total" ? raw : raw / regionPopulation(regionKey, year);
  }

  // unit "toe" shows consumption's native ktoe/toe-per-person; "kwh" converts to GWh/kWh-per-person
  // via KTOE_TO_MWH — mirrors fmtGenerationMetric above.
  function fmtConsumptionMetric(metric, unit, n) {
    if (unit === "kwh") {
      return metric === "total" ? fmtGwh(n * KTOE_TO_MWH) : fmtKwhPerCapita(n * KTOE_TO_MWH);
    }
    return metric === "total" ? fmtKtoe(n) : fmtToePerCapita(n);
  }

  function consumptionUnitLabel(metric, unit) {
    if (unit === "kwh") return metric === "total" ? "GWh" : "kWh/person";
    return metric === "total" ? "ktoe" : "toe/person";
  }

  // Tier-wide axis maxima for "fixed scale" mode (currentScaleMode — see its declaration above).
  // Scans every region in the tier so the axis doesn't depend on which region happens to be
  // selected. onlyYear controls how much history that scan covers: the latest-year bar view
  // passes its dataset's own latest year, so a small area's bar isn't shrunk to fit some *other*
  // year's peak elsewhere in the tier's history; the historical trend view omits it, scanning
  // every year, so its line doesn't rescale as you scrub through years within one view. The two
  // views' axes are deliberately allowed to differ from each other now (a bar chart and a line
  // chart aren't being compared side by side, so there's no need for them to share one scale) —
  // see the "Fixed vs auto scale" info dialog. Cheap enough (20 regions x up to ~20 years x a
  // handful of categories) to recompute on demand rather than precompute at load, so it's just
  // memoized per distinct (tier, metric, onlyYear, ...) combination actually asked for.
  const generationTierMaxCache = {};
  const generationTierMaxMetaCache = {};
  function generationTierMaxKey(regionKey, metric, onlyYear) {
    return [tierScopeKey(regionKey, metric), metric, onlyYear || "all"].join("|");
  }
  function generationTierMax(regionKey, metric, onlyYear) {
    const cacheKey = generationTierMaxKey(regionKey, metric, onlyYear);
    if (generationTierMaxCache[cacheKey] !== undefined) return generationTierMaxCache[cacheKey];
    const years = onlyYear ? [onlyYear] : energyGenerationYears();
    const t = newExtentTracker();
    for (const r of tierScopeRegions(regionKey, metric)) {
      for (const year of years) {
        const gen = energyGeneration(r, year);
        if (!gen) continue;
        for (const tech of ENERGY_TECH_ORDER) {
          const v = generationMetricValue(r, year, gen.by_technology_mwh[tech], metric);
          trackMax(t, v, { region: r, year: year, category: tech, value: v });
        }
      }
    }
    generationTierMaxMetaCache[cacheKey] = t.maxSetter;
    return (generationTierMaxCache[cacheKey] = t.max || 1);
  }
  // Which (region, year, technology) currently sets generationTierMax — see describeSetter/the
  // generation chart's dynamicIntro.
  function generationTierMaxSetter(regionKey, metric, onlyYear) {
    generationTierMax(regionKey, metric, onlyYear);
    return generationTierMaxMetaCache[generationTierMaxKey(regionKey, metric, onlyYear)];
  }

  const consumptionTierMaxCache = {};
  const consumptionTierMaxMetaCache = {};
  function consumptionTierMaxKey(regionKey, metric, detail, axis, onlyYear) {
    return [tierScopeKey(regionKey, metric), metric, detail, axis, onlyYear || "all"].join("|");
  }
  function consumptionTierMax(regionKey, metric, detail, axis, onlyYear) {
    const cacheKey = consumptionTierMaxKey(regionKey, metric, detail, axis, onlyYear);
    if (consumptionTierMaxCache[cacheKey] !== undefined) return consumptionTierMaxCache[cacheKey];
    const cats = consumptionCategories(detail, axis);
    const years = onlyYear ? [onlyYear] : energyConsumptionYears();
    const t = newExtentTracker();
    for (const r of tierScopeRegions(regionKey, metric)) {
      for (const year of years) {
        if (!energyConsumption(r, year)) continue;
        for (const c of cats) {
          const v = consumptionValue(r, year, c.key, detail, metric, axis);
          if (v !== null) trackMax(t, v, { region: r, year: year, category: c.label, value: v });
        }
      }
    }
    consumptionTierMaxMetaCache[cacheKey] = t.maxSetter;
    return (consumptionTierMaxCache[cacheKey] = t.max || 1);
  }
  // Which (region, year, category) currently sets consumptionTierMax — see describeSetter/the
  // consumption chart's dynamicIntro.
  function consumptionTierMaxSetter(regionKey, metric, detail, axis, onlyYear) {
    consumptionTierMax(regionKey, metric, detail, axis, onlyYear);
    return consumptionTierMaxMetaCache[consumptionTierMaxKey(regionKey, metric, detail, axis, onlyYear)];
  }

  // Sector chart's bars diverge from a centre zero line (LULUCF usually runs negative), so its
  // fixed-scale maximum is the largest *magnitude* seen either side of zero, not a plain max — the
  // same idea as generationTierMax/consumptionTierMax above (including the onlyYear parameter for
  // the same latest-view-vs-historical-view reason). Also scans *both* GWP horizons rather than
  // just the active one: unlike region tier (a population artifact per-person washes out — see
  // tierScopeKey), a horizon switch is a real change to the underlying numbers, but sharing one
  // range across both means flipping the 100/20-year toggle for a single region doesn't rescale
  // the axis, making that comparison legible too — auto scale is still there for whichever horizon
  // ends up looking compressed. The site only bakes in sub-sector detail for the latest year
  // (DATA.subsector_detail_latest_year has no history) regardless of onlyYear, since there's
  // nothing else to scan.
  const sectorTierMaxCache = {};
  const sectorTierMaxMetaCache = {};
  function sectorTierMaxKey(regionKey, metric, detail, onlyYear) {
    return [tierScopeKey(regionKey, metric), metric, detail, onlyYear || "all"].join("|");
  }
  function sectorTierMax(regionKey, metric, detail, onlyYear) {
    const cacheKey = sectorTierMaxKey(regionKey, metric, detail, onlyYear);
    if (sectorTierMaxCache[cacheKey] !== undefined) return sectorTierMaxCache[cacheKey];
    const regions = tierScopeRegions(regionKey, metric);
    const t = newExtentTracker();
    for (const horizon of ["gwp100", "gwp20"]) {
      withHorizon(horizon, () => {
        if (detail) {
          const ly = latestYear();
          for (const r of regions) {
            for (const sector of SECTOR_ORDER) {
              for (const row of sectorSubrowsFor(r, ly, sector, metric)) {
                const abs = Math.abs(row.value);
                trackMax(t, abs, { region: r, year: ly, category: row.name, value: row.value, horizon: horizon });
              }
            }
          }
        } else {
          const years = onlyYear ? [onlyYear] : DATA.meta.years;
          for (const r of regions) {
            for (const year of years) {
              for (const sector of SECTOR_ORDER) {
                const raw = sectorMetricValue(r, year, sector, metric);
                trackMax(t, Math.abs(raw), { region: r, year: year, category: sector, value: raw, horizon: horizon });
              }
            }
          }
        }
      });
    }
    sectorTierMaxMetaCache[cacheKey] = t.maxSetter;
    return (sectorTierMaxCache[cacheKey] = t.max || 1);
  }
  // Which (region, year, sector[, horizon]) currently sets sectorTierMax's symmetric magnitude —
  // see describeSetter/the sector chart's dynamicIntro.
  function sectorTierMaxSetter(regionKey, metric, detail, onlyYear) {
    sectorTierMax(regionKey, metric, detail, onlyYear);
    return sectorTierMaxMetaCache[sectorTierMaxKey(regionKey, metric, detail, onlyYear)];
  }

  // The historical (line) chart's fixed-scale axis needs the tier's actual positive and negative
  // extents separately, not a symmetric ±sectorTierMax — a line chart's vertical position isn't a
  // left/right length comparison the way the diverging bar chart's is, so there's no need to waste
  // axis space forcing the negative side to match whatever the largest *positive* sector happens
  // to be somewhere in the tier (this was a real bug: LULUCF's actual negative range is far
  // smaller than some other sector's positive peak, so the symmetric version left a large blank
  // band below zero on every region's chart). Only used by the historical view, so always scans
  // every year — no onlyYear parameter needed here.
  const sectorTierRangeCache = {};
  const sectorTierRangeMetaCache = {};
  function sectorTierRangeKey(regionKey, metric) {
    return [tierScopeKey(regionKey, metric), metric].join("|");
  }
  function sectorTierRange(regionKey, metric) {
    const cacheKey = sectorTierRangeKey(regionKey, metric);
    if (sectorTierRangeCache[cacheKey] !== undefined) return sectorTierRangeCache[cacheKey];
    const regions = tierScopeRegions(regionKey, metric);
    const t = newExtentTracker();
    for (const horizon of ["gwp100", "gwp20"]) {
      withHorizon(horizon, () => {
        for (const r of regions) {
          for (const year of DATA.meta.years) {
            for (const sector of SECTOR_ORDER) {
              const v = sectorMetricValue(r, year, sector, metric);
              const setter = { region: r, year: year, category: sector, value: v, horizon: horizon };
              trackMax(t, v, setter);
              trackMin(t, v, setter);
            }
          }
        }
      });
    }
    sectorTierRangeMetaCache[cacheKey] = { maxSetter: t.maxSetter, minSetter: t.minSetter };
    return (sectorTierRangeCache[cacheKey] = { max: t.max || 1, min: t.min });
  }
  // Which (region, year, sector, horizon) currently sets sectorTierRange's ceiling/floor — see
  // describeSetter/the sector chart's dynamicIntro.
  function sectorTierRangeSetter(regionKey, metric) {
    sectorTierRange(regionKey, metric);
    return sectorTierRangeMetaCache[sectorTierRangeKey(regionKey, metric)];
  }

  // Gases are never negative, so this is a plain max (no divergence to account for) — otherwise
  // the same idea as sectorTierMax above, including scanning both horizons and the onlyYear
  // dependence.
  const gasTierMaxCache = {};
  const gasTierMaxMetaCache = {};
  function gasTierMaxKey(regionKey, metric, onlyYear) {
    return [tierScopeKey(regionKey, metric), metric, onlyYear || "all"].join("|");
  }
  function gasTierMax(regionKey, metric, onlyYear) {
    const cacheKey = gasTierMaxKey(regionKey, metric, onlyYear);
    if (gasTierMaxCache[cacheKey] !== undefined) return gasTierMaxCache[cacheKey];
    const regions = tierScopeRegions(regionKey, metric);
    const years = onlyYear ? [onlyYear] : DATA.meta.years;
    const t = newExtentTracker();
    for (const horizon of ["gwp100", "gwp20"]) {
      withHorizon(horizon, () => {
        for (const r of regions) {
          for (const year of years) {
            for (const g of GAS_ORDER) {
              const v = gasMetricValue(r, year, g, metric);
              trackMax(t, v, { region: r, year: year, category: g, value: v, horizon: horizon });
            }
          }
        }
      });
    }
    gasTierMaxMetaCache[cacheKey] = t.maxSetter;
    return (gasTierMaxCache[cacheKey] = t.max || 1);
  }
  // Which (region, year, gas, horizon) currently sets gasTierMax — see describeSetter/the gas
  // chart's dynamicIntro.
  function gasTierMaxSetter(regionKey, metric, onlyYear) {
    gasTierMax(regionKey, metric, onlyYear);
    return gasTierMaxMetaCache[gasTierMaxKey(regionKey, metric, onlyYear)];
  }

  // The trend chart isn't tier-scoped like the charts above — a "context" view can show a
  // district alongside its own unitary and Hampshire and the Solent on one chart, spanning three
  // tiers at once, so "one shared scale per tier" has no single tier to anchor to. Its "fixed"
  // scale is instead one true maximum across every one of the 20 regions (for whichever years
  // onlyYear selects — see generationTierMax above for why the latest and historical views use
  // different scopes), which is what fixes the original reported bug: without scanning across all
  // 20 regions, switching the selected region (e.g. New Forest to Winchester) changed the axis to
  // fit whichever 2-3 regions happened to be on screen, so Hampshire and the Solent's bar/line —
  // present in *every* context view, at the same real value each time — visibly changed size
  // purely because the denominator moved, even though nothing about Hampshire and the Solent
  // itself had changed.
  const trendGlobalMaxCache = {};
  const trendGlobalMaxMetaCache = {};
  // withFootprint also scans every region's estimated footprint (100-year only, the one horizon it
  // exists on), so ticking that box raises the fixed axis to fit it rather than clipping the line.
  function trendGlobalMaxKey(metric, onlyYear, withFootprint) {
    return [metric, onlyYear || "all", withFootprint ? "fp" : ""].join("|");
  }
  function trendGlobalMax(metric, onlyYear, withFootprint) {
    const cacheKey = trendGlobalMaxKey(metric, onlyYear, withFootprint);
    if (trendGlobalMaxCache[cacheKey] !== undefined) return trendGlobalMaxCache[cacheKey];
    const years = onlyYear ? [onlyYear] : DATA.meta.years;
    const t = newExtentTracker();
    for (const horizon of ["gwp100", "gwp20"]) {
      withHorizon(horizon, () => {
        for (const r of REGIONS) {
          for (const year of years) {
            const v = regionMetricValue(r.key, year, metric);
            trackMax(t, v, { region: r.key, year: year, category: null, value: v, horizon: horizon });
            if (withFootprint && horizon === "gwp100") {
              const fv = footprintValue(r.key, year, metric);
              if (fv !== null) trackMax(t, fv, { region: r.key, year: year, category: "estimated consumption footprint", value: fv, horizon: horizon });
            }
          }
        }
      });
    }
    trendGlobalMaxMetaCache[cacheKey] = t.maxSetter;
    return (trendGlobalMaxCache[cacheKey] = t.max || 1);
  }
  // Which (region, year, horizon) currently sets trendGlobalMax — see describeSetter/the trend
  // chart's dynamicIntro. Has no `category` (a region's whole-area total, not split further), so
  // describeSetter's "region's X in year" phrasing is built with a plain "figure" placeholder.
  function trendGlobalMaxSetter(metric, onlyYear, withFootprint) {
    trendGlobalMax(metric, onlyYear, withFootprint);
    return trendGlobalMaxMetaCache[trendGlobalMaxKey(metric, onlyYear, withFootprint)];
  }

  // ---------------- estimated consumption footprint ----------------
  // DESNZ's local figures are territorial only. The trend chart can add an estimate of each area's
  // consumption-based footprint (including imports, excluding exports) by multiplying its
  // territorial figure by that year's UK-wide ratio: UK consumption-based emissions (DEFRA/University
  // of Leeds) ÷ the sum of every UK local authority's territorial emissions (see data/process.py).
  // Null for years DEFRA doesn't cover yet, so the line stops there rather than carrying a stale
  // ratio forward.
  function ukFootprintRatio(year) {
    const fp = DATA.meta.uk_footprint;
    const entry = fp && fp.years[year];
    return entry ? entry.ratio : null;
  }

  function footprintLatestYear() {
    const fp = DATA.meta.uk_footprint;
    const years = fp ? Object.keys(fp.years).map(Number) : [];
    return years.length ? Math.max(...years) : null;
  }

  // Historical view only: a single latest-year bar can't show it, since DEFRA's latest year lags
  // DESNZ's. 100-year horizon only: DEFRA publishes no 20-year figures, and applying a 100-year
  // ratio to 20-year territorial figures would mix the two bases.
  function footprintUnavailableReason() {
    if (!DATA.meta.uk_footprint) return "No UK footprint data loaded";
    if (currentView !== "historical") return "Switch to the historical trend view to show this";
    if (currentHorizon !== "gwp100") return "Only available on the 100-year time horizon";
    return null;
  }

  function footprintActive() {
    return footprintPref && footprintUnavailableReason() === null;
  }

  function footprintValue(regionKey, year, metric) {
    const ratio = ukFootprintRatio(year);
    return ratio === null ? null : regionMetricValue(regionKey, year, metric) * ratio;
  }

  function syncFootprintToggle() {
    const reason = footprintUnavailableReason();
    const toggle = document.getElementById("footprint-toggle");
    toggle.checked = footprintPref && reason === null;
    toggle.disabled = reason !== null;
    document.getElementById("footprint-toggle-group").classList.toggle("is-disabled", reason !== null);
    const label = document.getElementById("footprint-toggle-label");
    if (reason) label.title = reason; else label.removeAttribute("title");
  }

  // For the two derived electricity-split categories only, shows the actual calculation behind
  // the row's own value (total electricity consumed × that year's DUKES share) — the four
  // directly-measured DESNZ categories don't need this, since their tooltip value already *is*
  // the published figure, not something calculated from another number on screen.
  function ttElectricitySplitCalc(tt, regionKey, year, categoryKey, metric, unit) {
    if (categoryKey !== "Fossil fuel electricity" && categoryKey !== "Renewable electricity") return;
    const c = energyConsumption(regionKey, year);
    const mix = dukesElectricityMix()[year];
    if (!c || !mix) return;
    const electricityRaw = metric === "total" ? c.fuels_ktoe.Electricity : c.fuels_ktoe.Electricity / regionPopulation(regionKey, year);
    const pct = categoryKey === "Fossil fuel electricity" ? mix.fossilPct : mix.greenPct;
    ttSubRow(tt, "Total electricity", fmtConsumptionMetric(metric, unit, electricityRaw) + " " + consumptionUnitLabel(metric, unit), true);
    ttSubRow(tt, "× DUKES " + year + " share", fmtRatioPct(pct), false, true);
  }

  // Constituent fuel breakdown for a "simple" group (e.g. "Fossil fuels" -> Coal, Manufactured
  // fuels, Petroleum, Gas, Fossil fuel electricity), sorted by magnitude — shown in each bar's
  // hover, the same breakdown "Show all fuel types" renders as its own rows.
  function fuelSimpleBreakdown(regionKey, year, groupKey, metric) {
    const constituents = FUEL_SIMPLE_GROUPS[groupKey];
    if (!constituents || constituents.length <= 1) return null;
    const c = energyConsumption(regionKey, year);
    if (!c) return null;
    const pop = regionPopulation(regionKey, year);
    return constituents.map(f => {
      const raw = consumptionFuelKtoe(c, year, f);
      return { name: FUEL_LABEL[f], value: metric === "total" ? raw : raw / pop };
    }).sort((a, b) => b.value - a.value);
  }

  // Renewable generation as a % of local electricity demand — not the same as "how much of
  // this area's electricity is renewable", since the grid means generation isn't necessarily
  // consumed where it's produced (see the generation-chart info modal). Null if either figure is
  // missing for that year (consumption data starts 2005, generation data starts 2014). This
  // ratio is metric-invariant (population cancels top and bottom), so it's always computed from
  // raw totals regardless of currentMetric.
  function energyGenerationShareOfDemand(regionKey, year) {
    const gen = energyGeneration(regionKey, year);
    const con = energyConsumption(regionKey, year);
    if (!gen || !con) return null;
    return (gen.total_mwh / con.electricity_consumption_mwh) * 100;
  }

  // ---------------- trend chart (historical line / latest bar) ----------------

  // Which regions the top chart plots: in "context" mode, the selected region and its ancestors
  // up to Hampshire and the Solent (self first); in "constituents" mode, all siblings at the
  // nearest level with children (see nearestHub()) — e.g. all historic districts within the
  // selected region's unitary, or all unitaries within Hampshire and the Solent.
  function contextRegionKeys() {
    return compareMode === "constituents"
      ? regionChildren(nearestHub(currentRegion))
      : regionAncestors(currentRegion);
  }

  // Prefix of the same slot order already validated (dataviz skill's palette validator) for
  // SECTOR_ORDER's 8-category fixed-order chart — a prefix of an adjacency-safe sequence is
  // still adjacency-safe, and this only ever needs up to 5 (Hampshire and the Solent's 5
  // constituent unitaries, the largest sibling group in the hierarchy).
  const CONSTITUENT_SLOT_ORDER = [1, 2, 3, 4, 5, 6, 7, 8];

  // Colour by role, not by fixed per-region identity — with 20 regions and 8 slots, identity
  // colour isn't possible, and isn't needed since at most ~5 regions render together. In
  // "context" mode: the selected region is always blue (slot 1, "you are here"), an intermediate
  // parent (if shown) is always green (slot 6), Hampshire and the Solent is always violet
  // (slot 7) — same visual language regardless of which specific region is selected. In
  // "constituents" mode, the originally-selected region keeps its "you are here" blue if it's
  // one of the siblings shown; everyone else cycles through the remaining validated slots.
  function contextRegionColors(keys) {
    if (compareMode === "context") {
      return keys.map((key, i) => {
        if (key === "hampshire-solent") return seriesColor(7);
        return seriesColor(i === 0 ? 1 : 6);
      });
    }
    const selfIdx = keys.indexOf(currentRegion);
    const slotOrder = selfIdx >= 0 ? CONSTITUENT_SLOT_ORDER.filter(s => s !== 1) : CONSTITUENT_SLOT_ORDER;
    let cursor = 0;
    return keys.map((key, i) => (i === selfIdx ? seriesColor(1) : seriesColor(slotOrder[cursor++])));
  }

  // The regions the top chart should render right now, in display order, with colour attached.
  function contextRegions() {
    const keys = contextRegionKeys();
    const colors = contextRegionColors(keys);
    return keys.map((key, i) => ({ ...REGION_BY_KEY[key], color: colors[i] }));
  }

  function buildTrendChart() {
    const container = document.getElementById("trend-chart");
    clearNode(container);

    const metric = currentMetric;
    const view = currentView;
    const years = DATA.meta.years;
    const ly = latestYear();

    const metricLabel = metric === "total" ? "Total emissions" : "Emissions per person";
    const modeSuffix = compareMode === "constituents" ? " — constituents of " + REGION_LABEL[nearestHub(currentRegion)] : "";
    document.getElementById("trend-chart-title").textContent =
      metricLabel + ", " + (view === "historical" ? (years[0] + "–" + ly) : ly) + horizonTitleSuffix() + modeSuffix;

    syncFootprintToggle();

    const trendValueFmt = v => fmtValue(metric, v) + " " + unitLabel(metric);
    const trendSetter = view === "historical" ? trendGlobalMaxSetter(metric, null, footprintActive()) : trendGlobalMaxSetter(metric, ly);
    trendScaleNoteText = trendSetter
      ? "Currently set by " + describeSetter(trendSetter, trendValueFmt) + "."
      : "";

    if (view === "historical") {
      buildTrendChartHistorical(container, years, metric);
    } else {
      buildTrendChartLatest(container, ly, metric);
    }
  }

  // Target years shown on the historical trend chart. Both are "reach ~zero by year Y"
  // targets, so — unlike the CCC's percentage-vs-1990 pathway, which DESNZ's LA data (starts
  // 2005) can't express exactly — they need no baseline figure to plot.
  const TARGET_NET_ZERO_YEAR = 2050; // Hampshire County Council area target, aligned to UK Gov's legally-binding Climate Change Act target
  const TARGET_WCC_YEAR = 2030; // Winchester City Council's own district-wide carbon-neutral target — more ambitious than, and specific to, Winchester alone
  // No other region has a published net-zero date of its own yet, so every region but Winchester
  // falls back to the shared HCC/UK Gov 2050 goal; only Winchester's own dashed pathway targets
  // its own, earlier, date.
  const REGION_TARGET_YEAR = { winchester: TARGET_WCC_YEAR };

  function buildTrendChartHistorical(container, years, metric) {
    const showFootprint = footprintActive();
    const series = contextRegions().map(r => ({
      key: r.key,
      label: r.label,
      color: r.color,
      targetYear: REGION_TARGET_YEAR[r.key] || TARGET_NET_ZERO_YEAR,
      values: years.map(y => regionMetricValue(r.key, y, metric)),
      footprint: showFootprint ? years.map(y => footprintValue(r.key, y, metric)) : null
    }));

    const lastActualYear = years[years.length - 1];
    const chartMinYear = years[0];
    const chartMaxYear = TARGET_NET_ZERO_YEAR;

    // Straight-line "required" trajectory from each region's latest actual value to zero at
    // *its own* net-zero target year (Winchester: 2030; others: 2050) — not a modelled
    // decarbonisation pathway (real ones are rarely linear), just the simplest honest read of
    // the average pace still needed from here. Flat at zero past a region's own target, rather
    // than continuing to fall, since "required pace" has no meaning once the goal is met.
    function valueAtYear(s, year) {
      if (year <= lastActualYear) {
        const idx = years.indexOf(year);
        return idx >= 0 ? s.values[idx] : null;
      }
      if (year >= s.targetYear) return 0;
      const lastVal = s.values[s.values.length - 1];
      const t = (year - lastActualYear) / (s.targetYear - lastActualYear);
      return Math.max(0, lastVal * (1 - t));
    }

    const W = 860, H = 320;
    const M = { top: 20, right: 30, bottom: 32, left: 56 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const autoMax = Math.max(...series.flatMap(s => s.values.concat((s.footprint || []).filter(v => v !== null))));
    const maxVal = (currentScaleMode === "fixed" ? trendGlobalMax(metric, null, showFootprint) : autoMax) * 1.08;
    const xScale = year => M.left + ((year - chartMinYear) / (chartMaxYear - chartMinYear)) * plotW;
    const yScale = v => M.top + plotH - (v / maxVal) * plotH;

    // gridlines + y ticks
    const yTicks = 5;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxVal / yTicks) * t;
      const yy = yScale(val);
      el("line", { x1: M.left, x2: M.left + plotW, y1: yy, y2: yy, stroke: cssVar("--gridline"), "stroke-width": "1" }, svg);
      const txt = el("text", { x: M.left - 8, y: yy + 4, "text-anchor": "end", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = fmtAxisValue(metric, val);
    }

    // x ticks
    const xTickYears = [chartMinYear, 2015, lastActualYear, TARGET_WCC_YEAR, 2040, TARGET_NET_ZERO_YEAR];
    xTickYears.forEach(year => {
      const xx = xScale(year);
      const txt = el("text", { x: xx, y: M.top + plotH + 20, "text-anchor": "middle", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = year;
    });

    el("line", { x1: M.left, x2: M.left + plotW, y1: M.top + plotH, y2: M.top + plotH, stroke: cssVar("--baseline"), "stroke-width": "1" }, svg);

    // Estimated footprint: same colour as its region's solid line, longer dashes than the faint
    // net-zero pathway (3,3 at 0.3 opacity) and much stronger, so the two dashed styles can't be
    // confused. Drawn first so every solid territorial line sits on top of it.
    if (showFootprint) {
      series.forEach(s => {
        let d = "";
        let pen = "M";
        years.forEach((y, i) => {
          const v = s.footprint[i];
          if (v === null) { pen = "M"; return; }
          d += pen + xScale(y).toFixed(1) + "," + yScale(v).toFixed(1) + " ";
          pen = "L";
        });
        if (d) el("path", { class: "footprint-line", d: d, fill: "none", stroke: s.color, "stroke-width": "1.75", "stroke-dasharray": "6,4", opacity: "0.85", "stroke-linejoin": "round" }, svg);
      });
    }

    series.forEach(s => {
      let d = "";
      years.forEach((y, i) => { d += (i === 0 ? "M" : "L") + xScale(y).toFixed(1) + "," + yScale(s.values[i]).toFixed(1) + " "; });
      el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const lastX = xScale(lastActualYear), lastY = yScale(s.values[s.values.length - 1]);
      el("circle", { cx: lastX, cy: lastY, r: "5", fill: s.color, stroke: cssVar("--surface-1"), "stroke-width": "2" }, svg);

      // dashed "required pathway" continuation, to this region's own target year — kept light
      // (low opacity, thin, tight dashes) so it reads as a background guide, not a fourth data
      // line competing with the actual (solid, full-weight) trend lines above it.
      el("line", {
        x1: lastX, y1: lastY, x2: xScale(s.targetYear), y2: yScale(0),
        stroke: s.color, "stroke-width": "1.5", "stroke-dasharray": "3,3", opacity: "0.3"
      }, svg);
    });

    // Net-zero target markers — one per distinct target year in use (2030 for Winchester's own
    // WCC target, 2050 for the shared HCC/UK Gov target the other two regions fall back to).
    // Single-line labels (not name+sub-label stacked) to keep this corner of the chart calm.
    const NET_ZERO_MARKERS = [
      { year: TARGET_WCC_YEAR, label: "2030: Net zero — WCC (Winchester)" },
      { year: TARGET_NET_ZERO_YEAR, label: "2050: Net zero — HCC & UK Gov" }
    ];
    const nzLabelEls = NET_ZERO_MARKERS.map(m => {
      const nzX = xScale(m.year), nzY = yScale(0);
      el("circle", { cx: nzX, cy: nzY, r: "4", fill: cssVar("--text-muted") }, svg);
      const nzLabel = el("text", { x: nzX - 8, y: nzY - 10, "text-anchor": "end", "font-size": "10.5", "font-weight": "700", fill: cssVar("--text-secondary") }, svg);
      nzLabel.textContent = m.label;
      return nzLabel;
    });

    // End-of-line labels: a single compact "Name value" line per region (not name + value
    // stacked across two rows), sitting at the latest actual year and pushed apart vertically
    // as a group only when series end close together in value, so they don't overlap each
    // other or the dashed lines fanning out just below them.
    const labelX = xScale(lastActualYear);
    const MIN_LABEL_GAP = 18;
    const endLabels = series.map(s => ({ ...s, y: yScale(s.values[s.values.length - 1]) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < endLabels.length; i++) {
      if (endLabels[i].y - endLabels[i - 1].y < MIN_LABEL_GAP) {
        endLabels[i].y = endLabels[i - 1].y + MIN_LABEL_GAP;
      }
    }
    const endLabelEls = endLabels.map(item => {
      const nameText = el("text", { x: labelX + 10, y: item.y + 4, "font-size": "12", "font-weight": "700", fill: item.color }, svg);
      nameText.textContent = item.label;
      const valText = el("tspan", { fill: cssVar("--text-secondary"), "font-weight": "500" });
      valText.textContent = "  " + fmtAxisValue(metric, item.values[item.values.length - 1]) + unitShort(metric);
      nameText.appendChild(valText);
      return nameText;
    });

    // A net-zero marker's label can land right on top of a region's own end-of-line label —
    // guaranteed for Winchester, whose 2030 target sits close in x to its 2024 data point, and
    // whose total emissions are small enough to keep both labels pinned near the zero baseline.
    // getBBox() gives the actual rendered box (no font-metric guessing needed, since both sets
    // of labels are already in the DOM), so nudge a colliding marker label up and clear of
    // whichever end-of-line label(s) it overlaps. Re-measures after each nudge (rather than
    // computing one offset up front) since clearing one label can push it straight into
    // another one stacked above it.
    nzLabelEls.forEach(nzEl => {
      for (let pass = 0; pass < 6; pass++) {
        let moved = false;
        endLabelEls.forEach(endEl => {
          const nzBox = nzEl.getBBox();
          const endBox = endEl.getBBox();
          const overlapsX = nzBox.x < endBox.x + endBox.width && nzBox.x + nzBox.width > endBox.x;
          const overlapsY = nzBox.y < endBox.y + endBox.height && nzBox.y + nzBox.height > endBox.y;
          if (overlapsX && overlapsY) {
            const currentY = parseFloat(nzEl.getAttribute("y"));
            const shift = endBox.y - (nzBox.y + nzBox.height) - 4;
            nzEl.setAttribute("y", currentY + shift);
            moved = true;
          }
        });
        if (!moved) break;
      }
    });

    // crosshair + hover — works across the whole 2005-2050 range; years beyond the latest
    // actual figure show the interpolated pathway value instead of real data.
    const crosshair = el("line", { x1: 0, x2: 0, y1: M.top, y2: M.top + plotH, stroke: cssVar("--text-muted"), "stroke-width": "1", opacity: "0" }, svg);
    const hitRect = el("rect", { x: M.left, y: M.top, width: plotW, height: plotH, fill: "transparent" }, svg);

    hitRect.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = W / rect.width;
      const localX = (ev.clientX - rect.left) * scaleX;
      const yearFloat = chartMinYear + ((localX - M.left) / plotW) * (chartMaxYear - chartMinYear);
      const year = Math.round(Math.max(chartMinYear, Math.min(chartMaxYear, yearFloat)));
      const xx = xScale(year);
      const isFuture = year > lastActualYear;
      crosshair.setAttribute("x1", xx); crosshair.setAttribute("x2", xx); crosshair.setAttribute("opacity", "1");
      const idx = years.indexOf(year);
      showTooltip(ev.clientX, ev.clientY, (tt) => {
        ttTitle(tt, String(year) + (isFuture ? " — required pathway" : ""));
        series.forEach(s => {
          const val = valueAtYear(s, year);
          let text = fmtValue(metric, val) + " " + unitShort(metric);
          if (!isFuture && idx > 0) {
            text += " (" + fmtPct((val - s.values[idx - 1]) / s.values[idx - 1] * 100) + " vs " + years[idx - 1] + ")";
          }
          ttRow(tt, s.color, s.label, text);
          const fv = s.footprint && idx >= 0 ? s.footprint[idx] : null;
          if (fv !== null) {
            ttSubRow(tt, "Consumption footprint (est.)", fmtValue(metric, fv) + " " + unitShort(metric) + " (× " + ukFootprintRatio(year).toFixed(2) + ")", false, metric !== "per_capita");
          }
          ttPopulationRow(tt, s.key, year, metric, false, true);
        });
      });
    });
    hitRect.addEventListener("pointerleave", () => { crosshair.setAttribute("opacity", "0"); hideTooltip(); });

    // legend
    const legendWrap = document.createElement("div");
    legendWrap.className = "legend";
    series.forEach(s => legendWrap.appendChild(legendItemLine(s.color, s.label)));
    if (showFootprint) legendWrap.appendChild(legendItemDashed("Estimated consumption footprint, to " + footprintLatestYear()));
    container.appendChild(legendWrap);

    buildTrendTableHistorical(years, series, metric);
  }

  function buildTrendChartLatest(container, ly, metric) {
    const py = DATA.meta.years[DATA.meta.years.length - 2];
    const regions = contextRegions();
    const values = regions.map(r => regionMetricValue(r.key, ly, metric));
    const prevValues = regions.map(r => regionMetricValue(r.key, py, metric));

    const W = 860, H = 320;
    const M = { top: 20, right: 40, bottom: 40, left: 64 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const maxVal = (currentScaleMode === "fixed" ? trendGlobalMax(metric, ly) : Math.max(...values)) * 1.2;
    const yScale = v => M.top + plotH - (v / maxVal) * plotH;

    const yTicks = 5;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxVal / yTicks) * t;
      const yy = yScale(val);
      el("line", { x1: M.left, x2: M.left + plotW, y1: yy, y2: yy, stroke: cssVar("--gridline"), "stroke-width": "1" }, svg);
      const txt = el("text", { x: M.left - 8, y: yy + 4, "text-anchor": "end", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = fmtAxisValue(metric, val);
    }
    el("line", { x1: M.left, x2: M.left + plotW, y1: M.top + plotH, y2: M.top + plotH, stroke: cssVar("--baseline"), "stroke-width": "1" }, svg);

    const slotW = plotW / regions.length;
    const barW = Math.min(140, slotW * 0.5);

    regions.forEach((r, i) => {
      const value = values[i];
      const cx = M.left + slotW * (i + 0.5);
      const barY = yScale(value);
      const barH = (M.top + plotH) - barY;

      const rect = el("rect", { x: cx - barW / 2, y: barY, width: barW, height: barH, rx: "6", fill: r.color }, svg);
      rect.style.cursor = "pointer";

      const valText = el("text", { x: cx, y: barY - 10, "text-anchor": "middle", "font-size": "13", "font-weight": "700", fill: cssVar("--text-primary") }, svg);
      valText.textContent = fmtAxisValue(metric, value) + " " + unitShort(metric);

      const label = el("text", { x: cx, y: M.top + plotH + 24, "text-anchor": "middle", "font-size": "12.5", fill: cssVar("--text-secondary") }, svg);
      label.textContent = r.label;

      rect.addEventListener("pointerenter", () => rect.setAttribute("opacity", "0.82"));
      rect.addEventListener("pointerleave", () => { rect.setAttribute("opacity", "1"); hideTooltip(); });
      rect.addEventListener("pointermove", (ev) => {
        showTooltip(ev.clientX, ev.clientY, (tt) => {
          ttTitle(tt, r.label + " — " + ly);
          const prev = prevValues[i];
          const deltaText = " (" + fmtPct((value - prev) / prev * 100) + " vs " + py + ")";
          ttRow(tt, r.color, unitLabel(metric), fmtValue(metric, value) + deltaText);
          ttPopulationRow(tt, r.key, ly, metric, true);
        });
      });
    });

    buildTrendTableLatest(ly, regions, values, metric);
  }

  function legendItemLine(color, label) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const sw = document.createElement("span");
    sw.className = "legend-swatch line";
    sw.style.background = color;
    const txt = document.createElement("span");
    txt.textContent = label;
    item.appendChild(sw);
    item.appendChild(txt);
    return item;
  }

  function legendItemDashed(label) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const sw = document.createElement("span");
    sw.className = "legend-swatch dashed";
    const txt = document.createElement("span");
    txt.textContent = label;
    item.appendChild(sw);
    item.appendChild(txt);
    return item;
  }

  function legendItemBox(color, label) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = color;
    const txt = document.createElement("span");
    txt.textContent = label;
    item.appendChild(sw);
    item.appendChild(txt);
    return item;
  }

  function buildTrendTableHistorical(years, series, metric) {
    const wrap = document.getElementById("trend-table");
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    const fpSeries = series.filter(s => s.footprint);
    ["Year"].concat(series.map(s => s.label + " (" + unitLabel(metric) + ")"))
      .concat(fpSeries.map(s => s.label + " consumption footprint, est. (" + unitLabel(metric) + ")")).forEach(h => {
        const th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
      });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    years.forEach((y, i) => {
      const tr = document.createElement("tr");
      const cells = [y].concat(series.map(s => fmtValue(metric, s.values[i])))
        .concat(fpSeries.map(s => (s.footprint[i] === null ? "–" : fmtValue(metric, s.footprint[i]))));
      cells.forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function buildTrendTableLatest(ly, regions, values, metric) {
    const wrap = document.getElementById("trend-table");
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Region", unitLabel(metric) + " (" + ly + ")"].forEach(h => { const th = document.createElement("th"); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    regions.forEach((r, i) => {
      const tr = document.createElement("tr");
      [r.label, fmtValue(metric, values[i])].forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---------------- sector chart (latest bars / historical lines) ----------------

  function buildSectorChart(regionKey) {
    const container = document.getElementById("sector-chart");
    clearNode(container);
    const ly = latestYear();
    const metric = currentMetric;
    const view = currentView;

    // The site only has sub-sector detail for the latest year, so disable it whenever the
    // historical view is active (and force it off so the toggle doesn't lie about state).
    const detailAvailable = view === "latest";
    if (!detailAvailable) currentDetail = false;
    const detailToggle = document.getElementById("sector-detail-toggle");
    detailToggle.checked = currentDetail;
    detailToggle.disabled = !detailAvailable;
    document.getElementById("sector-detail-row").classList.toggle("is-disabled", !detailAvailable);

    const metricLabel = metric === "total" ? "emissions by sector" : "emissions per person by sector";
    document.getElementById("sector-chart-title").textContent =
      REGION_LABEL[regionKey] + " " + metricLabel + ", " + (view === "historical" ? (DATA.meta.years[0] + "–" + ly) : ly) + horizonTitleSuffix();

    const valueFmt = v => fmtValue(metric, v) + " " + unitLabel(metric);
    if (view === "historical") {
      const range = sectorTierRangeSetter(regionKey, metric);
      const topDesc = range && describeSetter(range.maxSetter, valueFmt);
      const bottomDesc = range && describeSetter(range.minSetter, valueFmt);
      sectorScaleNoteText = topDesc
        ? "Currently reaches up to " + topDesc +
          (bottomDesc ? ", and down to " + bottomDesc + "." : ".")
        : "";
    } else {
      const setter = sectorTierMaxSetter(regionKey, metric, currentDetail, ly);
      sectorScaleNoteText = setter
        ? "Currently set by " + describeSetter(setter, valueFmt) + "."
        : "";
    }

    if (view === "historical") {
      buildSectorChartHistorical(container, regionKey, metric);
    } else {
      buildSectorChartLatest(container, regionKey, ly, metric, currentDetail);
    }
  }

  function buildSectorChartLatest(container, regionKey, ly, metric, detail) {
    const regionTotal = regionMetricValue(regionKey, ly, metric);
    const rows = detail
      ? sectorSubrows(regionKey, ly, metric)
      : SECTOR_ORDER.map(s => ({ name: s, value: sectorMetricValue(regionKey, ly, s, metric) }))
          .sort((a, b) => b.value - a.value);

    const W = 860;
    const rowH = detail ? 26 : 34;
    const gap = detail ? 3 : 6;
    const barH = detail ? 18 : 24;
    const labelFontSize = detail ? "11" : "12.5";
    const M = { top: 10, right: 70, bottom: 10, left: detail ? 235 : 130 };
    const plotW = W - M.left - M.right;
    const H = M.top + M.bottom + rows.length * (rowH + gap);

    const maxAbs = currentScaleMode === "fixed"
      ? sectorTierMax(regionKey, metric, detail, ly)
      : Math.max(...rows.map(r => Math.abs(r.value))) || 1;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const xScale = v => (v / maxAbs) * (plotW / 2);
    const zeroX = M.left + plotW / 2;

    el("line", { x1: zeroX, x2: zeroX, y1: M.top, y2: H - M.bottom, stroke: cssVar("--baseline"), "stroke-width": "1" }, svg);

    rows.forEach((r, i) => {
      const y = M.top + i * (rowH + gap);
      const barW = xScale(r.value);
      const barX = r.value >= 0 ? zeroX : zeroX + barW;
      const color = categoryColor(detail ? r.sector : r.name);
      const barY = y + (rowH - barH) / 2;

      const label = el("text", { x: M.left - 12, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": labelFontSize, fill: cssVar("--text-secondary") }, svg);
      label.textContent = detail ? (r.sector + " — " + shortSubsectorLabel(r.sector, r.name)) : r.name;

      const rect = el("rect", {
        x: barX, y: barY, width: Math.abs(barW), height: barH, rx: "4",
        fill: color, class: "sector-bar"
      }, svg);
      rect.style.cursor = "pointer";

      const valX = r.value >= 0 ? barX + Math.abs(barW) + 8 : barX - 8;
      const valAnchor = r.value >= 0 ? "start" : "end";
      const valText = el("text", { x: valX, y: y + rowH / 2 + 4, "text-anchor": valAnchor, "font-size": labelFontSize, "font-weight": "700", fill: cssVar("--text-primary") }, svg);
      valText.textContent = fmtAxisValue(metric, r.value);

      rect.addEventListener("pointerenter", () => rect.setAttribute("opacity", "0.82"));
      rect.addEventListener("pointerleave", () => { rect.setAttribute("opacity", "1"); hideTooltip(); });
      rect.addEventListener("pointermove", (ev) => {
        showTooltip(ev.clientX, ev.clientY, (tt) => {
          ttTitle(tt, detail ? (r.sector + " — " + shortSubsectorLabel(r.sector, r.name)) : r.name);
          ttRow(tt, color, ly + "", fmtValue(metric, r.value) + " " + unitLabel(metric) + " (" + fmtRatioPct(r.value / regionTotal * 100) + " of total)");
          // Non-detail hover shows this sector's own sub-sector breakdown, so a viewer doesn't
          // need to tick "Show sub-sector detail" just to see what's inside e.g. Transport.
          if (!detail) {
            sectorSubrowsFor(regionKey, ly, r.name, metric).forEach((sub, i) => {
              ttSubRow(tt, shortSubsectorLabel(sub.sector, sub.name), fmtValue(metric, sub.value) + " " + unitShort(metric), i === 0);
            });
          }
          ttPopulationRow(tt, regionKey, ly, metric, true);
        });
      });
    });

    buildSectorTableLatest(regionKey, ly, rows, metric, detail);
  }

  function buildSectorChartHistorical(container, regionKey, metric) {
    const years = DATA.meta.years;
    const series = SECTOR_ORDER.map(s => ({
      name: s,
      color: categoryColor(s),
      values: years.map(y => sectorMetricValue(regionKey, y, s, metric))
    }));

    const W = 860, H = 340;
    const M = { top: 20, right: 20, bottom: 32, left: 64 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;

    const allValues = series.flatMap(s => s.values);
    const fixedRange = currentScaleMode === "fixed" ? sectorTierRange(regionKey, metric) : null;
    const maxVal = (fixedRange ? fixedRange.max : Math.max(...allValues, 0)) * 1.08;
    const minVal = (fixedRange ? fixedRange.min : Math.min(...allValues, 0)) * 1.08;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const xScale = i => M.left + (i / (years.length - 1)) * plotW;
    const yScale = v => M.top + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;

    const yTicks = 5;
    for (let t = 0; t <= yTicks; t++) {
      const val = minVal + ((maxVal - minVal) / yTicks) * t;
      const yy = yScale(val);
      el("line", { x1: M.left, x2: M.left + plotW, y1: yy, y2: yy, stroke: cssVar("--gridline"), "stroke-width": "1" }, svg);
      const txt = el("text", { x: M.left - 8, y: yy + 4, "text-anchor": "end", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = fmtAxisValue(metric, val);
    }

    const xTickYears = [years[0], years[Math.round((years.length - 1) * 0.25)], years[Math.round((years.length - 1) * 0.5)], years[Math.round((years.length - 1) * 0.75)], years[years.length - 1]];
    xTickYears.forEach(y => {
      const i = years.indexOf(y);
      const txt = el("text", { x: xScale(i), y: M.top + plotH + 20, "text-anchor": "middle", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = y;
    });

    // zero baseline (LULUCF typically runs negative, so this can sit inside the plot area)
    el("line", { x1: M.left, x2: M.left + plotW, y1: yScale(0), y2: yScale(0), stroke: cssVar("--baseline"), "stroke-width": "1" }, svg);

    series.forEach(s => {
      let d = "";
      s.values.forEach((v, i) => { d += (i === 0 ? "M" : "L") + xScale(i).toFixed(1) + "," + yScale(v).toFixed(1) + " "; });
      el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    });

    const crosshair = el("line", { x1: 0, x2: 0, y1: M.top, y2: M.top + plotH, stroke: cssVar("--text-muted"), "stroke-width": "1", opacity: "0" }, svg);
    const hitRect = el("rect", { x: M.left, y: M.top, width: plotW, height: plotH, fill: "transparent" }, svg);

    hitRect.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = W / rect.width;
      const localX = (ev.clientX - rect.left) * scaleX;
      let idx = Math.round(((localX - M.left) / plotW) * (years.length - 1));
      idx = Math.max(0, Math.min(years.length - 1, idx));
      const xx = xScale(idx);
      crosshair.setAttribute("x1", xx); crosshair.setAttribute("x2", xx); crosshair.setAttribute("opacity", "1");
      const yearTotal = series.reduce((a, s) => a + s.values[idx], 0) || 1;
      showTooltip(ev.clientX, ev.clientY, (tt) => {
        ttTitle(tt, String(years[idx]));
        series.slice().sort((a, b) => b.values[idx] - a.values[idx]).forEach(s => {
          ttRow(tt, s.color, s.name, fmtValue(metric, s.values[idx]) + " " + unitShort(metric) + " (" + fmtRatioPct(s.values[idx] / yearTotal * 100) + ")");
        });
        ttPopulationRow(tt, regionKey, years[idx], metric, true);
      });
    });
    hitRect.addEventListener("pointerleave", () => { crosshair.setAttribute("opacity", "0"); hideTooltip(); });

    const legendWrap = document.createElement("div");
    legendWrap.className = "legend";
    series.forEach(s => legendWrap.appendChild(legendItemLine(s.color, s.name)));
    container.appendChild(legendWrap);

    buildSectorTableHistorical(regionKey, years, series, metric);
  }

  function buildSectorTableLatest(regionKey, ly, rows, metric, detail) {
    const wrap = document.getElementById("sector-table");
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    const headers = detail
      ? ["Sector", "Sub-sector", unitLabel(metric) + " (" + ly + ")"]
      : ["Sector", unitLabel(metric) + " (" + ly + ")"];
    headers.forEach(h => { const th = document.createElement("th"); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    rows.forEach(r => {
      const tr = document.createElement("tr");
      const cells = detail ? [r.sector, r.name, fmtValue(metric, r.value)] : [r.name, fmtValue(metric, r.value)];
      cells.forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function buildSectorTableHistorical(regionKey, years, series, metric) {
    const wrap = document.getElementById("sector-table");
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Year"].concat(series.map(s => s.name + " (" + unitLabel(metric) + ")")).forEach(h => {
      const th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    years.forEach((y, i) => {
      const tr = document.createElement("tr");
      const cells = [y].concat(series.map(s => fmtValue(metric, s.values[i])));
      cells.forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---------------- gas chart (latest bars / historical lines) ----------------
  // Unlike sectors, gases are never negative, so these bars run from a fixed left edge rather
  // than diverging from a centre zero line — a plain left-to-right bar reads better when nothing
  // needs to point the other way. Rows keep GAS_ORDER's fixed CO2/CH4/N2O order rather than
  // sorting by magnitude, since which gas is which is the whole point of this chart.

  function buildGasChart(regionKey) {
    const container = document.getElementById("gas-chart");
    clearNode(container);
    const ly = latestYear();
    const metric = currentMetric;
    const view = currentView;

    const metricLabel = metric === "total" ? "emissions by greenhouse gas" : "emissions per person by greenhouse gas";
    document.getElementById("gas-chart-title").textContent =
      REGION_LABEL[regionKey] + " " + metricLabel + ", " + (view === "historical" ? (DATA.meta.years[0] + "–" + ly) : ly) + horizonTitleSuffix();

    const valueFmt = v => fmtValue(metric, v) + " " + unitLabel(metric);
    const setter = view === "historical" ? gasTierMaxSetter(regionKey, metric) : gasTierMaxSetter(regionKey, metric, ly);
    gasScaleNoteText = setter
      ? "Currently set by " + describeSetter(setter, valueFmt) + "."
      : "";

    if (view === "historical") {
      buildGasChartHistorical(container, regionKey, metric);
    } else {
      buildGasChartLatest(container, regionKey, ly, metric);
    }
  }

  function buildGasChartLatest(container, regionKey, ly, metric) {
    const rows = GAS_ORDER.map(g => ({ key: g, name: GAS_LABEL[g], value: gasMetricValue(regionKey, ly, g, metric) }));
    const regionTotal = rows.reduce((a, r) => a + r.value, 0) || 1;

    const W = 860, rowH = 40, gap = 14, barH = 26, labelFontSize = "12.5";
    const M = { top: 10, right: 80, bottom: 10, left: 150 };
    const plotW = W - M.left - M.right;
    const H = M.top + M.bottom + rows.length * (rowH + gap) - gap;

    const maxVal = (currentScaleMode === "fixed" ? gasTierMax(regionKey, metric, ly) : Math.max(...rows.map(r => r.value))) || 1;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const xScale = v => (v / maxVal) * plotW;

    rows.forEach((r, i) => {
      const y = M.top + i * (rowH + gap);
      const barW = xScale(r.value);
      const color = categoryColor(r.key);
      const barY = y + (rowH - barH) / 2;

      const label = el("text", { x: M.left - 12, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": labelFontSize, fill: cssVar("--text-secondary") }, svg);
      label.textContent = r.name;

      const rect = el("rect", { x: M.left, y: barY, width: Math.max(barW, 0), height: barH, rx: "4", fill: color }, svg);
      rect.style.cursor = "pointer";

      const valText = el("text", { x: M.left + barW + 8, y: y + rowH / 2 + 4, "text-anchor": "start", "font-size": labelFontSize, "font-weight": "700", fill: cssVar("--text-primary") }, svg);
      valText.textContent = fmtAxisValue(metric, r.value);

      rect.addEventListener("pointerenter", () => rect.setAttribute("opacity", "0.82"));
      rect.addEventListener("pointerleave", () => { rect.setAttribute("opacity", "1"); hideTooltip(); });
      rect.addEventListener("pointermove", (ev) => {
        showTooltip(ev.clientX, ev.clientY, (tt) => {
          ttTitle(tt, r.name);
          ttRow(tt, color, ly + "", fmtValue(metric, r.value) + " " + unitLabel(metric) + " (" + fmtRatioPct(r.value / regionTotal * 100) + " of total)");
          ttPopulationRow(tt, regionKey, ly, metric, true);
        });
      });
    });

    buildGasTableLatest(ly, rows, metric);
  }

  function buildGasChartHistorical(container, regionKey, metric) {
    const years = DATA.meta.years;
    const series = GAS_ORDER.map(g => ({
      key: g,
      name: GAS_LABEL[g],
      color: categoryColor(g),
      values: years.map(y => gasMetricValue(regionKey, y, g, metric))
    }));

    const W = 860, H = 340;
    const M = { top: 20, right: 20, bottom: 32, left: 64 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;

    const maxVal = (currentScaleMode === "fixed" ? gasTierMax(regionKey, metric) : Math.max(...series.flatMap(s => s.values), 0)) * 1.08 || 1;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const xScale = i => M.left + (i / (years.length - 1)) * plotW;
    const yScale = v => M.top + plotH - (v / maxVal) * plotH;

    const yTicks = 5;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxVal / yTicks) * t;
      const yy = yScale(val);
      el("line", { x1: M.left, x2: M.left + plotW, y1: yy, y2: yy, stroke: cssVar("--gridline"), "stroke-width": "1" }, svg);
      const txt = el("text", { x: M.left - 8, y: yy + 4, "text-anchor": "end", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = fmtAxisValue(metric, val);
    }

    const xTickYears = [years[0], years[Math.round((years.length - 1) * 0.25)], years[Math.round((years.length - 1) * 0.5)], years[Math.round((years.length - 1) * 0.75)], years[years.length - 1]];
    xTickYears.forEach(y => {
      const i = years.indexOf(y);
      const txt = el("text", { x: xScale(i), y: M.top + plotH + 20, "text-anchor": "middle", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = y;
    });

    el("line", { x1: M.left, x2: M.left + plotW, y1: yScale(0), y2: yScale(0), stroke: cssVar("--baseline"), "stroke-width": "1" }, svg);

    series.forEach(s => {
      let d = "";
      s.values.forEach((v, i) => { d += (i === 0 ? "M" : "L") + xScale(i).toFixed(1) + "," + yScale(v).toFixed(1) + " "; });
      el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    });

    const crosshair = el("line", { x1: 0, x2: 0, y1: M.top, y2: M.top + plotH, stroke: cssVar("--text-muted"), "stroke-width": "1", opacity: "0" }, svg);
    const hitRect = el("rect", { x: M.left, y: M.top, width: plotW, height: plotH, fill: "transparent" }, svg);

    hitRect.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = W / rect.width;
      const localX = (ev.clientX - rect.left) * scaleX;
      let idx = Math.round(((localX - M.left) / plotW) * (years.length - 1));
      idx = Math.max(0, Math.min(years.length - 1, idx));
      const xx = xScale(idx);
      crosshair.setAttribute("x1", xx); crosshair.setAttribute("x2", xx); crosshair.setAttribute("opacity", "1");
      const yearTotal = series.reduce((a, s) => a + s.values[idx], 0) || 1;
      showTooltip(ev.clientX, ev.clientY, (tt) => {
        ttTitle(tt, String(years[idx]));
        series.slice().sort((a, b) => b.values[idx] - a.values[idx]).forEach(s => {
          ttRow(tt, s.color, s.name, fmtValue(metric, s.values[idx]) + " " + unitShort(metric) + " (" + fmtRatioPct(s.values[idx] / yearTotal * 100) + ")");
        });
        ttPopulationRow(tt, regionKey, years[idx], metric, true);
      });
    });
    hitRect.addEventListener("pointerleave", () => { crosshair.setAttribute("opacity", "0"); hideTooltip(); });

    const legendWrap = document.createElement("div");
    legendWrap.className = "legend";
    series.forEach(s => legendWrap.appendChild(legendItemLine(s.color, s.name)));
    container.appendChild(legendWrap);

    buildGasTableHistorical(years, series, metric);
  }

  function buildGasTableLatest(ly, rows, metric) {
    const wrap = document.getElementById("gas-table");
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Gas", unitLabel(metric) + " (" + ly + ")"].forEach(h => { const th = document.createElement("th"); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    rows.forEach(r => {
      const tr = document.createElement("tr");
      [r.name, fmtValue(metric, r.value)].forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function buildGasTableHistorical(years, series, metric) {
    const wrap = document.getElementById("gas-table");
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Year"].concat(series.map(s => s.name + " (" + unitLabel(metric) + ")")).forEach(h => {
      const th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    years.forEach((y, i) => {
      const tr = document.createElement("tr");
      const cells = [y].concat(series.map(s => fmtValue(metric, s.values[i])));
      cells.forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---------------- generation chart (latest bars / historical lines) ----------------
  // Structurally mirrors the gas chart above: technologies, like gases, are never negative, so
  // bars run left-to-right from a fixed edge rather than diverging from a centre zero line.

  function updateGenerationNote(regionKey, gy, metric, unit) {
    const gen = energyGeneration(regionKey, gy);
    const total = generationMetricValue(regionKey, gy, gen.total_mwh, metric);
    const share = energyGenerationShareOfDemand(regionKey, gy);
    const label = metric === "total" ? "Total renewable generation, " : "Renewable generation per person, ";
    generationNoteText = label + gy + ": " + fmtGenerationMetric(metric, unit, total) + " " + generationUnitLabel(metric, unit) +
      (share === null ? "." : " — equivalent to " + fmtRatioPct(share) + " of estimated local electricity demand (generation and demand aren't directly connected via the shared national grid).");
  }

  function buildGenerationChart(regionKey) {
    const container = document.getElementById("generation-chart");
    if (!container || !ENERGY_DATA) return;
    clearNode(container);
    const years = energyGenerationYears();
    const gy = energyLatestGenerationYear();
    const view = currentView;
    const metric = currentMetric;
    const unit = currentEnergyUnit;

    const metricLabel = metric === "total"
      ? "renewable electricity generation by technology"
      : "renewable electricity generation per person by technology";
    document.getElementById("generation-chart-title").textContent =
      REGION_LABEL[regionKey] + " " + metricLabel + ", " +
      (view === "historical" ? (years[0] + "–" + gy) : gy);
    updateGenerationNote(regionKey, gy, metric, unit);

    const genValueFmt = v => fmtGenerationMetric(metric, unit, v) + " " + generationUnitLabel(metric, unit);
    const genSetter = view === "historical" ? generationTierMaxSetter(regionKey, metric) : generationTierMaxSetter(regionKey, metric, gy);
    generationScaleNoteText = genSetter
      ? "Currently set by " + describeSetter(genSetter, genValueFmt) + "."
      : "";

    if (view === "historical") {
      buildGenerationChartHistorical(container, regionKey, years, metric, unit);
    } else {
      buildGenerationChartLatest(container, regionKey, gy, metric, unit);
    }
  }

  function buildGenerationChartLatest(container, regionKey, gy, metric, unit) {
    const gen = energyGeneration(regionKey, gy);
    const total = generationMetricValue(regionKey, gy, gen.total_mwh, metric);
    const rows = ENERGY_TECH_ORDER.map(t => ({ name: t, value: generationMetricValue(regionKey, gy, gen.by_technology_mwh[t], metric) }))
      .sort((a, b) => b.value - a.value);
    const valueLabels = rows.map(r => fmtGenerationMetric(metric, unit, r.value) + " " + generationUnitLabel(metric, unit));
    const formatGenerationLabel = v => fmtGenerationMetric(metric, unit, v) + " " + generationUnitLabel(metric, unit);
    const tierMax = generationTierMax(regionKey, metric, gy);

    const W = 860, rowH = 40, gap = 14, barH = 26, labelFontSize = "12.5";
    const M = { top: 10, right: latestBarRightMargin(rows, formatGenerationLabel, tierMax), bottom: 10, left: 150 };
    const plotW = W - M.left - M.right;
    const H = M.top + M.bottom + rows.length * (rowH + gap) - gap;

    const maxVal = currentScaleMode === "fixed" ? tierMax : (Math.max(...rows.map(r => r.value)) || 1);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const xScale = v => (v / maxVal) * plotW;

    rows.forEach((r, i) => {
      const y = M.top + i * (rowH + gap);
      const barW = xScale(r.value);
      const color = categoryColor(r.name);
      const barY = y + (rowH - barH) / 2;

      const label = el("text", { x: M.left - 12, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": labelFontSize, fill: cssVar("--text-secondary") }, svg);
      label.textContent = r.name;

      const rect = el("rect", { x: M.left, y: barY, width: Math.max(barW, 0), height: barH, rx: "4", fill: color }, svg);
      rect.style.cursor = "pointer";

      const valText = el("text", { x: M.left + barW + 8, y: y + rowH / 2 + 4, "text-anchor": "start", "font-size": labelFontSize, "font-weight": "700", fill: cssVar("--text-primary") }, svg);
      valText.textContent = valueLabels[i];

      rect.addEventListener("pointerenter", () => rect.setAttribute("opacity", "0.82"));
      rect.addEventListener("pointerleave", () => { rect.setAttribute("opacity", "1"); hideTooltip(); });
      rect.addEventListener("pointermove", (ev) => {
        showTooltip(ev.clientX, ev.clientY, (tt) => {
          ttTitle(tt, r.name);
          ttRow(tt, color, gy + "", fmtGenerationMetric(metric, unit, r.value) + " " + generationUnitLabel(metric, unit) + " (" + fmtRatioPct(r.value / total * 100) + " of total)");
          ttPopulationRow(tt, regionKey, gy, metric, true);
        });
      });
    });

    buildGenerationTableLatest(gy, rows, metric, unit);
  }

  function buildGenerationChartHistorical(container, regionKey, years, metric, unit) {
    const series = ENERGY_TECH_ORDER.map(t => ({
      name: t,
      color: categoryColor(t),
      values: years.map(y => generationMetricValue(regionKey, y, energyGeneration(regionKey, y).by_technology_mwh[t], metric))
    }));

    const W = 860, H = 340;
    const M = { top: 20, right: 20, bottom: 32, left: 64 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;

    const maxVal = (currentScaleMode === "fixed" ? generationTierMax(regionKey, metric) : Math.max(...series.flatMap(s => s.values), 0)) * 1.08 || 1;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const xScale = i => M.left + (i / (years.length - 1)) * plotW;
    const yScale = v => M.top + plotH - (v / maxVal) * plotH;

    const yTicks = 5;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxVal / yTicks) * t;
      const yy = yScale(val);
      el("line", { x1: M.left, x2: M.left + plotW, y1: yy, y2: yy, stroke: cssVar("--gridline"), "stroke-width": "1" }, svg);
      const txt = el("text", { x: M.left - 8, y: yy + 4, "text-anchor": "end", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = fmtGenerationMetric(metric, unit, val);
    }

    const xTickYears = [years[0], years[Math.round((years.length - 1) * 0.25)], years[Math.round((years.length - 1) * 0.5)], years[Math.round((years.length - 1) * 0.75)], years[years.length - 1]];
    xTickYears.forEach(y => {
      const i = years.indexOf(y);
      const txt = el("text", { x: xScale(i), y: M.top + plotH + 20, "text-anchor": "middle", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = y;
    });

    el("line", { x1: M.left, x2: M.left + plotW, y1: yScale(0), y2: yScale(0), stroke: cssVar("--baseline"), "stroke-width": "1" }, svg);

    series.forEach(s => {
      let d = "";
      s.values.forEach((v, i) => { d += (i === 0 ? "M" : "L") + xScale(i).toFixed(1) + "," + yScale(v).toFixed(1) + " "; });
      el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    });

    const crosshair = el("line", { x1: 0, x2: 0, y1: M.top, y2: M.top + plotH, stroke: cssVar("--text-muted"), "stroke-width": "1", opacity: "0" }, svg);
    const hitRect = el("rect", { x: M.left, y: M.top, width: plotW, height: plotH, fill: "transparent" }, svg);

    hitRect.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = W / rect.width;
      const localX = (ev.clientX - rect.left) * scaleX;
      let idx = Math.round(((localX - M.left) / plotW) * (years.length - 1));
      idx = Math.max(0, Math.min(years.length - 1, idx));
      const xx = xScale(idx);
      crosshair.setAttribute("x1", xx); crosshair.setAttribute("x2", xx); crosshair.setAttribute("opacity", "1");
      const yearTotal = series.reduce((a, s) => a + s.values[idx], 0) || 1;
      showTooltip(ev.clientX, ev.clientY, (tt) => {
        ttTitle(tt, String(years[idx]));
        series.slice().sort((a, b) => b.values[idx] - a.values[idx]).forEach(s => {
          ttRow(tt, s.color, s.name, fmtGenerationMetric(metric, unit, s.values[idx]) + " " + generationUnitLabel(metric, unit) + " (" + fmtRatioPct(s.values[idx] / yearTotal * 100) + ")");
        });
        ttPopulationRow(tt, regionKey, years[idx], metric, true);
      });
    });
    hitRect.addEventListener("pointerleave", () => { crosshair.setAttribute("opacity", "0"); hideTooltip(); });

    const legendWrap = document.createElement("div");
    legendWrap.className = "legend";
    series.forEach(s => legendWrap.appendChild(legendItemLine(s.color, s.name)));
    container.appendChild(legendWrap);

    buildGenerationTableHistorical(years, series, metric, unit);
  }

  function buildGenerationTableLatest(gy, rows, metric, unit) {
    const wrap = document.getElementById("generation-table");
    if (!wrap) return;
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Technology", generationUnitLabel(metric, unit) + " (" + gy + ")"].forEach(h => { const th = document.createElement("th"); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    rows.forEach(r => {
      const tr = document.createElement("tr");
      [r.name, fmtGenerationMetric(metric, unit, r.value)].forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function buildGenerationTableHistorical(years, series, metric, unit) {
    const wrap = document.getElementById("generation-table");
    if (!wrap) return;
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Year"].concat(series.map(s => s.name + " (" + generationUnitLabel(metric, unit) + ")")).forEach(h => {
      const th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    years.forEach((y, i) => {
      const tr = document.createElement("tr");
      const cells = [y].concat(series.map(s => fmtGenerationMetric(metric, unit, s.values[i])));
      cells.forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---------------- consumption chart (latest bars / historical lines) ----------------
  // Structurally identical to the generation chart above, but categories come from either
  // FUEL_ORDER ("complex") or FUEL_SIMPLE_GROUPS ("simple") depending on currentConsumptionDetail
  // — the same simple/detailed split as the sector chart's sub-sector toggle, but available in
  // both Latest year and Historical trend view here, since (unlike the sector chart's sub-sector
  // detail, which the site only bakes in for the latest year) the full fuel breakdown is in the data for every year.

  function buildConsumptionChart(regionKey) {
    const container = document.getElementById("consumption-chart");
    if (!container || !ENERGY_DATA) return;
    clearNode(container);
    const years = energyConsumptionYears();
    const cy = years[years.length - 1];
    const view = currentView;
    const axis = currentConsumptionView;
    const detail = currentConsumptionDetail;
    const metric = currentMetric;
    const unit = currentEnergyUnit;

    // Browsers restore a checkbox's checked state across a manual refresh independently of the
    // DOM/JS default, so force it back in line with actual app state on every render (same
    // pattern as the sector chart's sub-sector-detail toggle below) — otherwise a page refresh
    // with this ticked leaves the box looking ticked while currentConsumptionDetail (and thus
    // the chart) has already reset to the simple view. The "Show all fuel types" checkbox only
    // means anything in the "by fuel type" axis, so it's disabled (not hidden — its checked
    // state is preserved for when the user switches back) whenever "by sector" is selected.
    document.getElementById("consumption-detail-toggle").checked = detail;
    document.getElementById("consumption-detail-toggle").disabled = axis === "sector";
    document.getElementById("consumption-detail-row").classList.toggle("is-disabled", axis === "sector");
    document.querySelectorAll("[data-consumption-view]").forEach(b => {
      b.classList.toggle("is-active", b.dataset.consumptionView === axis);
    });

    const metricLabel = metric === "total"
      ? "energy consumption by " + (axis === "sector" ? "sector" : (detail ? "fuel type" : "source"))
      : "energy consumption per person by " + (axis === "sector" ? "sector" : (detail ? "fuel type" : "source"));
    document.getElementById("consumption-chart-title").textContent =
      REGION_LABEL[regionKey] + " " + metricLabel + ", " +
      (view === "historical" ? (years[0] + "–" + cy) : cy);

    const conValueFmt = v => fmtConsumptionMetric(metric, unit, v) + " " + consumptionUnitLabel(metric, unit);
    const conSetter = view === "historical"
      ? consumptionTierMaxSetter(regionKey, metric, detail, axis)
      : consumptionTierMaxSetter(regionKey, metric, detail, axis, cy);
    consumptionScaleNoteText = conSetter
      ? "Currently set by " + describeSetter(conSetter, conValueFmt) + "."
      : "";

    if (view === "historical") {
      buildConsumptionChartHistorical(container, regionKey, years, detail, metric, unit, axis);
    } else {
      buildConsumptionChartLatest(container, regionKey, cy, detail, metric, unit, axis);
    }
  }

  function buildConsumptionChartLatest(container, regionKey, cy, detail, metric, unit, axis) {
    const cats = consumptionCategories(detail, axis);
    const allFuelsRaw = energyConsumption(regionKey, cy).all_fuels_ktoe;
    const allFuels = metric === "total" ? allFuelsRaw : allFuelsRaw / regionPopulation(regionKey, cy);
    const rows = cats.map(c => ({ key: c.key, name: c.label, value: consumptionValue(regionKey, cy, c.key, detail, metric, axis) }))
      .sort((a, b) => b.value - a.value);
    const valueLabels = rows.map(r => fmtConsumptionMetric(metric, unit, r.value) + " " + consumptionUnitLabel(metric, unit));
    const formatConsumptionLabel = v => fmtConsumptionMetric(metric, unit, v) + " " + consumptionUnitLabel(metric, unit);
    const tierMax = consumptionTierMax(regionKey, metric, detail, axis, cy);

    const W = 860, rowH = 40, gap = 14, barH = 26, labelFontSize = "12.5";
    // The sector axis's "Industrial, commercial & other" label is longer than any fuel-type
    // label this margin was originally sized for (the previous longest, "Manufactured fuels",
    // fits comfortably at 150) — widen it for that axis so the label isn't clipped.
    const M = { top: 10, right: latestBarRightMargin(rows, formatConsumptionLabel, tierMax), bottom: 10, left: axis === "sector" ? 230 : 150 };
    const plotW = W - M.left - M.right;
    const H = M.top + M.bottom + rows.length * (rowH + gap) - gap;

    const maxVal = currentScaleMode === "fixed" ? tierMax : (Math.max(...rows.map(r => r.value)) || 1);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const xScale = v => (v / maxVal) * plotW;

    rows.forEach((r, i) => {
      const y = M.top + i * (rowH + gap);
      const barW = xScale(r.value);
      const color = categoryColor(r.key);
      const barY = y + (rowH - barH) / 2;

      const label = el("text", { x: M.left - 12, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": labelFontSize, fill: cssVar("--text-secondary") }, svg);
      label.textContent = r.name;

      const rect = el("rect", { x: M.left, y: barY, width: Math.max(barW, 0), height: barH, rx: "4", fill: color }, svg);
      rect.style.cursor = "pointer";

      const valText = el("text", { x: M.left + barW + 8, y: y + rowH / 2 + 4, "text-anchor": "start", "font-size": labelFontSize, "font-weight": "700", fill: cssVar("--text-primary") }, svg);
      valText.textContent = valueLabels[i];

      rect.addEventListener("pointerenter", () => rect.setAttribute("opacity", "0.82"));
      rect.addEventListener("pointerleave", () => { rect.setAttribute("opacity", "1"); hideTooltip(); });
      rect.addEventListener("pointermove", (ev) => {
        showTooltip(ev.clientX, ev.clientY, (tt) => {
          ttTitle(tt, r.name);
          ttRow(tt, color, cy + "", fmtConsumptionMetric(metric, unit, r.value) + " " + consumptionUnitLabel(metric, unit) + " (" + fmtRatioPct(r.value / allFuels * 100) + " of total)");
          if (axis !== "sector" && !detail) {
            const breakdown = fuelSimpleBreakdown(regionKey, cy, r.key, metric);
            if (breakdown) {
              breakdown.forEach((sub, i) => ttSubRow(tt, sub.name, fmtConsumptionMetric(metric, unit, sub.value) + " " + consumptionUnitLabel(metric, unit), i === 0));
            }
          }
          if (axis !== "sector" && detail) {
            ttElectricitySplitCalc(tt, regionKey, cy, r.key, metric, unit);
          }
          ttPopulationRow(tt, regionKey, cy, metric, true);
        });
      });
    });

    buildConsumptionTableLatest(cy, rows, metric, unit);
  }

  function buildConsumptionChartHistorical(container, regionKey, years, detail, metric, unit, axis) {
    const cats = consumptionCategories(detail, axis);
    const series = cats.map(c => ({
      key: c.key,
      name: c.label,
      color: categoryColor(c.key),
      values: years.map(y => consumptionValue(regionKey, y, c.key, detail, metric, axis))
    }));

    const W = 860, H = 340;
    const M = { top: 20, right: 20, bottom: 32, left: 64 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;

    const maxVal = (currentScaleMode === "fixed" ? consumptionTierMax(regionKey, metric, detail, axis) : Math.max(...series.flatMap(s => s.values), 0)) * 1.08 || 1;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    container.appendChild(svg);

    const xScale = i => M.left + (i / (years.length - 1)) * plotW;
    const yScale = v => M.top + plotH - (v / maxVal) * plotH;

    const yTicks = 5;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxVal / yTicks) * t;
      const yy = yScale(val);
      el("line", { x1: M.left, x2: M.left + plotW, y1: yy, y2: yy, stroke: cssVar("--gridline"), "stroke-width": "1" }, svg);
      const txt = el("text", { x: M.left - 8, y: yy + 4, "text-anchor": "end", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = fmtConsumptionMetric(metric, unit, val);
    }

    const xTickYears = [years[0], years[Math.round((years.length - 1) * 0.25)], years[Math.round((years.length - 1) * 0.5)], years[Math.round((years.length - 1) * 0.75)], years[years.length - 1]];
    xTickYears.forEach(y => {
      const i = years.indexOf(y);
      const txt = el("text", { x: xScale(i), y: M.top + plotH + 20, "text-anchor": "middle", fill: cssVar("--text-muted"), "font-size": "11" }, svg);
      txt.textContent = y;
    });

    el("line", { x1: M.left, x2: M.left + plotW, y1: yScale(0), y2: yScale(0), stroke: cssVar("--baseline"), "stroke-width": "1" }, svg);

    series.forEach(s => {
      let d = "";
      s.values.forEach((v, i) => { d += (i === 0 ? "M" : "L") + xScale(i).toFixed(1) + "," + yScale(v).toFixed(1) + " "; });
      el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    });

    const crosshair = el("line", { x1: 0, x2: 0, y1: M.top, y2: M.top + plotH, stroke: cssVar("--text-muted"), "stroke-width": "1", opacity: "0" }, svg);
    const hitRect = el("rect", { x: M.left, y: M.top, width: plotW, height: plotH, fill: "transparent" }, svg);

    hitRect.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = W / rect.width;
      const localX = (ev.clientX - rect.left) * scaleX;
      let idx = Math.round(((localX - M.left) / plotW) * (years.length - 1));
      idx = Math.max(0, Math.min(years.length - 1, idx));
      const xx = xScale(idx);
      crosshair.setAttribute("x1", xx); crosshair.setAttribute("x2", xx); crosshair.setAttribute("opacity", "1");
      const yearTotal = series.reduce((a, s) => a + s.values[idx], 0) || 1;
      showTooltip(ev.clientX, ev.clientY, (tt) => {
        ttTitle(tt, String(years[idx]));
        series.slice().sort((a, b) => b.values[idx] - a.values[idx]).forEach(s => {
          ttRow(tt, s.color, s.name, fmtConsumptionMetric(metric, unit, s.values[idx]) + " " + consumptionUnitLabel(metric, unit) + " (" + fmtRatioPct(s.values[idx] / yearTotal * 100) + ")");
          if (axis !== "sector" && !detail) {
            const breakdown = fuelSimpleBreakdown(regionKey, years[idx], s.key, metric);
            if (breakdown) {
              breakdown.forEach((sub, i) => ttSubRow(tt, sub.name, fmtConsumptionMetric(metric, unit, sub.value) + " " + consumptionUnitLabel(metric, unit), i === 0));
            }
          }
          if (axis !== "sector" && detail) {
            ttElectricitySplitCalc(tt, regionKey, years[idx], s.key, metric, unit);
          }
        });
        ttPopulationRow(tt, regionKey, years[idx], metric, true);
      });
    });
    hitRect.addEventListener("pointerleave", () => { crosshair.setAttribute("opacity", "0"); hideTooltip(); });

    const legendWrap = document.createElement("div");
    legendWrap.className = "legend";
    series.forEach(s => legendWrap.appendChild(legendItemLine(s.color, s.name)));
    container.appendChild(legendWrap);

    buildConsumptionTableHistorical(years, series, metric, unit);
  }

  function buildConsumptionTableLatest(cy, rows, metric, unit) {
    const wrap = document.getElementById("consumption-table");
    if (!wrap) return;
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Source", consumptionUnitLabel(metric, unit) + " (" + cy + ")"].forEach(h => { const th = document.createElement("th"); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    rows.forEach(r => {
      const tr = document.createElement("tr");
      [r.name, fmtConsumptionMetric(metric, unit, r.value)].forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function buildConsumptionTableHistorical(years, series, metric, unit) {
    const wrap = document.getElementById("consumption-table");
    if (!wrap) return;
    clearNode(wrap);
    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Year"].concat(series.map(s => s.name + " (" + consumptionUnitLabel(metric, unit) + ")")).forEach(h => {
      const th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    years.forEach((y, i) => {
      const tr = document.createElement("tr");
      const cells = [y].concat(series.map(s => fmtConsumptionMetric(metric, unit, s.values[i])));
      cells.forEach(v => { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---------------- info modal ----------------

  // Every entry has the same three-part shape, so a reader learns the dialog once:
  //
  //   summary  — one sentence, what this is. Rendered large, read by everyone.
  //   readIt   — a few bullets on how to read what's on screen.
  //   method   — [term, definition] rows behind a "Method, sources & caveats" disclosure,
  //              for someone checking the figures rather than reading them.
  //
  // The split is what lets one dialog serve both audiences: a general reader gets ~70 words
  // and closes it; an expert opens the disclosure once and it stays open site-wide thereafter
  // (see methodOpenPref). Nothing is removed — it's one click away, not gone.
  //
  // Keep "Source", "Basis", "Calculated here" and "Composite regions" as the method row labels
  // wherever they apply, even when the wording would otherwise vary: an expert should learn one
  // place to look for what's official DESNZ data and what this site derived, on every chart.
  //
  // axisNote is the chart's live fixed-scale setter sentence, appended as the final method row.
  // It answers "why is the axis this high" — the wrong first sentence for a general reader, and
  // exactly what someone auditing the chart came for, so it belongs last and inside the method
  // block. dynamicIntro is the opposite case: a finding worth leading with, currently only the
  // generation chart's demand comparison.
  //
  // Any summary/readIt/method string may contain [[key|label]], rendered by renderRichText as an
  // inline button opening that entry. Each concept is explained in exactly one dialog and linked
  // from the rest: GWP weighting in "horizon-toggle", parish apportionment in
  // "general-methodology", grid pooling in "generation-chart", toe/MWh in "energy-unit-toggle".
  const INFO_CONTENT = {
    "about": {
      title: "About this tool",
      summary: "This tool compares greenhouse gas emissions and energy use for Hampshire's councils, today's and the proposed new ones, and it's a work in progress we'd like comments on.",
      readIt: [
        "Pick a council, a proposed unitary, or Hampshire and the Solent. You'll see how its emissions have changed since 2005 and which sectors they come from. You can also see how much renewable energy it generates and how much energy it uses.",
        "The proposed unitaries are provisional while the Government reviews its reorganisation decision. See [[region-toggle|Choosing a region]].",
        "Switch to per-person figures to compare areas of different sizes.",
        "We're still building it. Charts and figures may change, and you may spot mistakes.",
        "Tell us what you think: what's useful, what's confusing, and what's missing, using [[https://www.winacc.org.uk/contact/|WinACC's contact page]]."
      ],
      method: [
        ["Source", "DESNZ (Department for Energy Security and Net Zero) local authority emissions and energy statistics. See [[general-methodology|Full methodology & sources]]."],
        ["Built by", "WinACC (Winchester Action on the Climate Crisis), for the Hampshire Local Government Reorganisation working group. The source code is on [[https://github.com/garethj/hampshire-emissions-explorer|GitHub]]."]
      ]
    },
    "region-toggle": {
      title: "Choosing a region",
      summary: "Every current Hampshire local authority, the Combined County Authority above them, and the four unitaries proposed to replace them.",
      readIt: [
        "\"Historic districts\" are the 11 district and borough councils that exist today, under Hampshire County Council's two-tier system.",
        "\"Current unitaries\" are Portsmouth, Southampton and the Isle of Wight, each already covering only its own area.",
        "\"Proposed unitaries (provisional)\" are the four authorities the Government chose in March 2026 to replace all 14 of the above. It has since withdrawn that decision to review it, so treat their figures as provisional until it decides again, expected early 2027.",
        "\"Hampshire and the Solent\" is the Combined County Authority above all of them. It already exists, and its figures don't depend on how the reorganisation is decided."
      ],
      method: [
        ["The reorganisation", "In March 2026 the Government decided to replace the 11 districts and 3 current unitaries with four mainland unitaries: North Hampshire, Mid-Hampshire, South East Hampshire and South West Hampshire. Portsmouth would join South East Hampshire and Southampton would join South West Hampshire. The Isle of Wight would stay as it is. The proposed unitaries here follow that decision, because it's the only structure the Government has chosen so far."],
        ["Parishes that move", "Under the March 2026 decision, three of the four new unitaries would also gain parishes moving out of a Mid-Hampshire district. South East Hampshire would gain Clanfield, Horndean and Rowlands Castle from East Hampshire, and Newlands from Winchester. South West Hampshire would gain Totton and Eling, Marchwood, Hythe and Dibden and Fawley from New Forest, and Chilworth, Nursling and Rownhams and Valley Park from Test Valley."],
        ["Calculated here", "No official sub-district emissions data exists, so each affected district's contribution is apportioned by 2021 Census parish population share rather than left as a whole-district guess. [[general-methodology|Full methodology & sources]] gives the exact fractions, and where the method is weakest."],
        ["Hampshire and the Solent", "The Combined County Authority established 4 June 2026 (SI 2026/595), covering the whole of Hampshire plus Portsmouth, Southampton and the Isle of Wight. Its footprint doesn't depend on where any moving parish ends up, since they all stay inside it either way."],
        ["What districts show", "Historic districts and current unitaries always show today's whole-district figures, never an LGR-adjusted fragment — even where one of them also contributes a population-weighted slice to a neighbouring proposed unitary's total."],
        ["Current status", "On 7 September 2026 the Government withdrew the March decision following updated legal advice, while Hampshire County Council was seeking a judicial review. On 29 October 2026 it said all options and proposals remain under consideration, with an outcome by early 2027, shadow council elections in May 2028 and new councils from 2029. May 2027 elections go ahead on existing council boundaries. Once the Government decides, the proposed unitaries here will be recalculated to match. The historic districts, current unitaries, Hampshire and Hampshire and the Solent won't change."],
        ["Source", "Ministry of Housing, Communities and Local Government, “Local government reorganisation moves forward in five counties”, 29 October 2026; Minister for Local Government's withdrawal letter to council leaders, 7 September 2026."]
      ]
    },
    "metric-toggle": {
      title: "Totals vs per-person figures",
      summary: "\"Per person\" divides each region's total by its population, so areas of different size can be compared on equal terms.",
      readIt: [
        "\"Totals\" is the raw figure — kt CO2e for emissions, GWh or ktoe for energy.",
        "Southampton's total emissions dwarf Winchester's largely because it has far more people, not because each resident emits more.",
        "Hover any chart while \"Per person\" is selected to see the population that region and year was divided by."
      ],
      method: [
        ["Source", "DESNZ's own mid-year population estimate, published in the same dataset as the emissions figures — not a separate Census or ONS source."],
        ["Composite regions", "For a proposed unitary, or Hampshire and the Solent, population is summed across the constituent local authorities exactly as emissions are, including the same population-weighted scaling for the three districts split by the LGR boundary change. See [[region-toggle|Choosing a region]] and [[general-methodology|Full methodology & sources]]."]
      ]
    },
    "horizon-toggle": {
      title: "100-year vs 20-year time horizon",
      summary: "Greenhouse gases are weighted against CO2 over a chosen time window. This toggle switches that window between 100 years and 20.",
      readIt: [
        "Methane (CH4) traps far more heat than CO2 but breaks down within a decade or two, while CO2 lingers for centuries. The window chosen decides how heavily methane counts.",
        "\"100-year (official)\" is DESNZ's own published basis, and this site's default.",
        "Under \"20-year\", areas with more livestock farming or landfill waste look proportionally worse. Areas dominated by transport and heating barely move."
      ],
      method: [
        ["Global Warming Potential", "Each gas is weighted by how much warming a tonne of it causes relative to a tonne of CO2, over the chosen window. Judged over 100 years, methane is weighted at 28x CO2; over 20 years, 84x — roughly three times heavier. Nitrous oxide (N2O), the other major non-CO2 gas here, barely changes between the two (264x vs 265x), since it persists for over a century either way."],
        ["Official basis", "GWP100 is the international reporting standard, used by DESNZ, the UK Government and the UNFCCC."],
        ["Calculated here", "The 20-year view is not published by DESNZ. This site rescales each gas's contribution to the official CO2e figure by GWP20/GWP100 for that gas, using IPCC AR5 Table 8.A.1 without climate-carbon feedbacks: CO2 = 1/1, CH4 = 84/28, N2O = 264/265. Nothing about the underlying emissions changes, only how heavily methane counts. Every other part of the methodology — boundaries, population, sectors — is identical between the two views."],
        ["Why it matters", "A shorter horizon reflects the urgency of near-term warming, and the fact that cutting methane now has an outsized effect on the next few decades' peak temperature. That case is increasingly made in climate policy discussion, though GWP100 remains the official reporting basis."]
      ]
    },
    "energy-unit-toggle": {
      title: "MWh-based vs ktoe-based units",
      summary: "Puts the generation and consumption charts into one shared unit family, so the two can be compared directly.",
      readIt: [
        "\"MWh-based\" keeps generation as DESNZ publishes it, and converts consumption into GWh or kWh per person.",
        "\"ktoe-based\" keeps consumption as DESNZ publishes it, and converts generation into ktoe or toe per person.",
        "Neither is more correct than the other — pick whichever makes the two charts easier to read together."
      ],
      method: [
        ["Native units", "The two charts come from different DESNZ datasets, each published in its own unit: generation in MWh (shown here as GWh, or kWh per person), consumption in ktoe — kilotonnes of oil equivalent (shown as ktoe, or toe per person). Each option here is named after one dataset's own published unit."],
        ["Conversion", "Whichever chart isn't already in the chosen family is converted using the standard DUKES/IEA factor of 1 toe = 11.63 MWh."]
      ]
    },
    "scale-mode-toggle": {
      title: "Fixed vs auto scale",
      summary: "Fixed scale holds one shared axis maximum across the regions being compared, so a real difference in volume stays visible as a difference in bar height.",
      readIt: [
        "Switching region no longer rescales the axis: a bigger area's bar is genuinely bigger, not just a larger number you'd have to read closely to notice.",
        "The trade-off is that a small area's bar can end up short, which makes its own internal split — which sector, which technology, which fuel — harder to read.",
        "\"Auto scale\" sizes each chart to its own region instead, trading comparability for a clearer read of one area alone."
      ],
      method: [
        ["Totals: one scale per tier", "The sector, gas, generation and consumption charts share one scale within each tier. Historic districts share one, current unitaries another, proposed unitaries another. Tiers differ hugely in population and area, so one scale spanning all of them would flatten the smaller ones. Hampshire and the Solent has no tier-mates, so it's unaffected either way."],
        ["Per person: one scale for all", "Per-person values divide out exactly the population difference that tiers exist to separate, so all 20 regions share one scale — a district's and a unitary's figures are directly comparable."],
        ["The trend chart", "Always one scale across all 20 regions, on either metric, because a single trend chart can show more than one tier at once: a district alongside its own unitary and Hampshire and the Solent."],
        ["Latest year vs historical", "The two views deliberately use different fixed maxima. \"Latest year\" scales to the highest value across the comparison set in that one year, so a genuine decline since 2005 doesn't leave every current bar looking artificially small against a much higher historical peak. \"Historical trend\" scales to the highest value across the set's entire published history, so its line doesn't rescale as you scan across years. The two are never on screen together, so expect the axis to change when you switch — that's by design, not a bug."],
        ["Both GWP horizons at once", "The sector, gas and trend charts' fixed scale spans both time horizons. Sharing one range means flipping that toggle for a single region doesn't rescale the axis either, so a genuine change in the picture — methane-heavy sectors growing under the 20-year weighting — stays visible as a change in bar or line size rather than a moving axis. If that leaves the 100-year view looking compressed, switch to auto scale. See [[horizon-toggle|100-year vs 20-year time horizon]]."],
        ["Sector chart exceptions", "Its latest-year bars use a symmetric axis either side of zero, set by the largest magnitude in either direction, since a diverging bar's left and right lengths need one consistent scale to stay comparable. Its historical trend line instead uses the comparison set's actual highest and lowest values independently, because a line's vertical position isn't a length comparison in the same way. And its sub-sector detail view only ever scans the latest year for a shared maximum, whichever view is selected, because sub-sector figures are published for that year alone."]
      ]
    },
    "trend-chart": {
      title: "Total emissions over time",
      summary: "Total greenhouse gas emissions for each year 2005–2024, summed across all sectors.",
      readIt: [
        "The chart shows the selected region in context: itself, the proposed unitary it rolls up to, and Hampshire and the Solent. Picking Eastleigh shows Eastleigh, South West Hampshire and Hampshire and the Solent.",
        "Tick \"Compare all constituents\" to see every sibling instead — all historic districts within the selected unitary, or all unitaries within Hampshire and the Solent.",
        "In the historical view, faint dashed lines are a straight-line pathway from each region's latest figure to zero at its own net-zero target.",
        "Also in the historical view, tick \"Add estimated consumption footprint\" to add each region's emissions from what its residents buy, including imports. See [[footprint-toggle|Estimated consumption footprint]]."
      ],
      axisNote: () => trendScaleNoteText,
      method: [
        ["Source", "DESNZ UK local authority and regional greenhouse gas emissions statistics, 2005–2024 (published 25 June 2026)."],
        ["Basis", "Territorial emissions — CO2, CH4 and N2O, combined as CO2e — summed across all eight sectors."],
        ["Official vs calculated here", "Historic districts and current unitaries are DESNZ's own published district figures. The four proposed unitaries and Hampshire and the Solent are calculated by summing those district figures, and are not official published figures. See [[general-methodology|Full methodology & sources]]."],
        ["Target pathways", "Winchester's dashed line targets 2030, its district-wide carbon-neutral target from its Carbon Neutrality Action Plan. Every other region has no target of its own yet, so its line targets 2050: the Hampshire County Council area target, aligned to the UK Government's legally-binding 2050 target."],
        ["Caveat", "A target pathway is the simplest honest read of the numbers, not a modelled decarbonisation forecast — real pathways are rarely a straight line."],
        ["Fixed scale", "This chart uses one site-wide maximum, across all 20 regions and both GWP horizons, rather than a per-tier or per-horizon one. See [[scale-mode-toggle|Fixed vs auto scale]]."]
      ],
      link: { href: "https://assets.publishing.service.gov.uk/media/6a3bacc9d52550a19950f2f5/2005-24-local-authority-ghg-emissions-csv-dataset.csv", label: "Download the source CSV" }
    },
    "footprint-toggle": {
      title: "Estimated consumption footprint",
      summary: "An estimate of each area's consumption footprint: emissions from what its residents buy, including imports and excluding exports, scaled from UK-wide figures.",
      readIt: [
        "Each solid line is the official territorial figure: emissions released within the area's boundary. The bolder dashed line in the same colour is the estimated footprint.",
        "The gap between them is emissions embedded in imports, such as manufactured goods, food grown abroad and overseas services, less those from making UK exports, which count towards the buyers' footprints instead.",
        "Across the UK, the footprint has fallen much more slowly than territorial emissions, so territorial figures alone overstate progress.",
        "Available in the historical trend view on the 100-year time horizon. The dashed line stops at the latest year the UK-wide figures cover."
      ],
      method: [
        ["Source", () => "University of Leeds for DEFRA, “" + (DATA.meta.uk_footprint.edition || "UK and England's carbon footprint") + "”, Figure 8: UK consumption-based greenhouse gas emissions. The ratio's denominator comes from the same DESNZ local authority dataset as every other chart here."],
        ["Basis", "Consumption-based emissions count everything emitted, in the UK or abroad, to supply the goods and services UK residents buy, plus their own home heating and driving. Emissions from making UK exports are left out, as they count towards the footprints of the countries that buy them (DEFRA's note 2). Territorial emissions are what's released inside the UK's borders, the same basis as every other chart here."],
        ["Calculated here", () => {
          const ly = footprintLatestYear();
          return "No consumption-based data is published below UK level. For each year, this site divides UK consumption-based emissions by the total territorial emissions of every UK local authority in DESNZ's local data (" +
            ukFootprintRatio(ly).toFixed(2) + " in " + ly + ") and multiplies each area's territorial figure by that ratio. Hover the chart to see the ratio for any year.";
        }],
        ["Denominator", () => {
          const ly = footprintLatestYear();
          const e = DATA.meta.uk_footprint.years[ly];
          const gap = Math.round((1 - e.la_territorial_mt_co2e / e.territorial_mt_co2e) * 100);
          return "DESNZ's local authority figures add up to " + gap + "% less than the UK's national territorial total in " + ly +
            ", because the national total includes emissions DESNZ doesn't assign to any local authority. Dividing by the local authority total keeps the ratio on the same basis as the figures it multiplies, so every UK area's estimate adds up to the UK footprint.";
        }],
        ["UK-wide comparison", () => {
          const years = DATA.meta.uk_footprint.years;
          const first = Math.min(...Object.keys(years).map(Number));
          const ly = footprintLatestYear();
          const change = key => Math.round((years[ly][key] / years[first][key] - 1) * 100);
          return "From " + first + " to " + ly + ", UK territorial emissions fell by " + -change("territorial_mt_co2e") +
            "% and the UK consumption-based footprint by " + -change("consumption_mt_co2e") + "%.";
        }],
        ["Caveat", "Every area gets the same national ratio, which ignores local differences. Higher-income areas tend to have larger footprints, so this probably understates them. Areas with heavy industry release emissions that partly serve consumers elsewhere, so this probably overstates them."],
        ["Time horizon", "DEFRA publishes the footprint on the 100-year basis only. Applying a 100-year ratio to 20-year figures would mix two bases, so the estimate is switched off under the 20-year horizon. See [[horizon-toggle|100-year vs 20-year time horizon]]."],
        ["Latest year", "DEFRA's figures run about a year behind DESNZ's local data. The dashed line stops at DEFRA's latest year rather than reusing an old ratio for later years."],
        ["Target pathways", "Net-zero pathway lines follow territorial figures only, since local and national targets are set on that basis."]
      ],
      link: { href: "https://www.gov.uk/government/statistics/uks-carbon-footprint", label: "gov.uk statistical release" }
    },
    "sector-chart": {
      title: "Emissions by sector",
      summary: "The same total emissions, split across the eight DESNZ sectors.",
      readIt: [
        "The sectors are Agriculture, Commercial, Domestic, Industry, LULUCF, Public Sector, Transport and Waste.",
        "LULUCF (land use, land-use change and forestry) is usually negative: a net carbon sink from woodland, hedgerows and soils, which subtracts from the total rather than adding to it.",
        "In the latest-year view, tick \"Show sub-sector detail\" to break each sector down further, for example Transport into road, rail and other.",
        "Switching the time horizon to \"20-year\" makes Agriculture and Waste noticeably larger, while Transport, Domestic and Commercial barely move. See [[horizon-toggle|100-year vs 20-year time horizon]]."
      ],
      axisNote: () => sectorScaleNoteText,
      method: [
        ["Source", "DESNZ local authority greenhouse gas emissions statistics, each sector summed across its sub-sectors and gases."],
        ["Sub-sector detail", "DESNZ publishes sub-sector figures for every year from 2005, but this site currently includes only the latest year's, so that breakdown isn't available in the historical trend view."],
        ["Composite regions", "Each sector is the sum of that sector's figure across the constituent districts, scaled as described in [[region-toggle|Choosing a region]]."]
      ]
    },
    "gas-chart": {
      title: "Emissions by greenhouse gas",
      summary: "The same total emissions again, split by gas instead of by sector.",
      readIt: [
        "CO2 is almost entirely energy use — heating, electricity, vehicle fuel. CH4 is mostly agriculture (livestock) and waste (landfill). N2O is mostly agriculture, from fertilised soils and manure management.",
        "This is a useful cross-check on the sector chart: two areas can have the same total for very different reasons, one dominated by CO2 from transport and heating, another by CH4 from farming.",
        "Switch the time horizon to \"20-year\" and the CH4 bar roughly triples while CO2 and N2O barely move — the clearest single illustration on this site of what that toggle does. See [[horizon-toggle|100-year vs 20-year time horizon]]."
      ],
      axisNote: () => gasScaleNoteText,
      method: [
        ["Source", "DESNZ publishes three gases at local authority level: CO2, methane (CH4) and nitrous oxide (N2O). Each is already converted to CO2e using the active time horizon."],
        ["Excluded", "Fluorinated gases (HFCs and others), which DESNZ excludes from local authority statistics entirely. They're under 2% of the UK total."],
        ["Composite regions", "Each gas is the sum of that gas's figure across the constituent districts, scaled as described in [[region-toggle|Choosing a region]]."]
      ]
    },
    "generation-chart": {
      title: "Renewable electricity generation by technology",
      summary: "Renewable electricity physically produced within the area, split by technology.",
      dynamicIntro: () => generationNoteText,
      readIt: [
        "The technologies are Solar (photovoltaics), Wind (onshore and offshore), Hydro, Bioenergy & waste, and Other (wave and tidal, plus a small residual).",
        "This is generation, not consumption: how much is produced here, regardless of where it's ultimately used.",
        "The demand comparison is not self-sufficiency. Great Britain runs one shared grid, so local generation is exported and pooled rather than routed to local homes."
      ],
      axisNote: () => generationScaleNoteText,
      method: [
        ["Source", "DESNZ regional renewable electricity statistics, by local authority."],
        ["Coverage", "Generation data starts in 2014, the first year DESNZ publishes it at local authority level. Consumption data runs 2005–2024, so the demand comparison is only available from 2014 onward."],
        ["Why the grid matters", "Electricity from a local wind farm or solar array isn't routed to local homes and businesses. It's exported to the grid and pooled with generation from everywhere else, while local demand draws from that same shared pool. A ratio near or above 100% means an area generates roughly as much renewable electricity as it consumes in total — not that it's disconnected from the grid, or self-sufficient in practice."],
        ["Suppressed figures", "DESNZ suppresses some small per-technology figures, shown as \"[X]\" in its source workbook, to avoid revealing individual plants' output. This mainly affects Wind, Hydro and Bioenergy in these mostly solar-dominated local authorities. This site treats a suppressed cell as 0 for its own technology, and folds the resulting small gap against DESNZ's own published total into \"Other\", so the bars always sum exactly to DESNZ's figure."],
        ["Demand comparison", "The electricity consumption figure behind it is published in ktoe and converted here to MWh — see [[energy-unit-toggle|MWh-based vs ktoe-based units]]. The energy unit toggle doesn't change the percentage, since it's a ratio of two totals."],
        ["Composite regions", "Each technology is the sum of that technology's figure across the constituent districts, scaled as described in [[region-toggle|Choosing a region]]."]
      ],
      link: { href: "https://www.gov.uk/government/statistics/regional-renewable-statistics", label: "gov.uk statistical release" }
    },
    "consumption-chart": {
      title: "Energy consumption by fuel",
      summary: "All energy burned inside the area — heating, industry and road fuel, not just electricity.",
      readIt: [
        "\"By fuel type\" splits everything into Fossil fuels and Green energy; tick \"Show all fuel types\" to break both down. Hovering a bar shows the same breakdown without ticking the box.",
        "\"By sector\" splits the same total into Domestic, Transport, and Industrial, Commercial and other.",
        "A large \"Industrial, Commercial and other\" share is the signal that a big non-household energy user, not local demand, is driving an area's total.",
        "Oil (petroleum) is typically the largest category, dominated by road transport fuel."
      ],
      axisNote: () => consumptionScaleNoteText,
      method: [
        ["Source", "DESNZ sub-national total final energy consumption, 2005–2024, published in ktoe. The energy unit toggle can show it in the same GWh or kWh-per-person units as the generation chart — see [[energy-unit-toggle|MWh-based vs ktoe-based units]]."],
        ["Basis", "Every unit of fuel burned within the local authority's boundary, including fuel used by large industrial sites — oil refining, for instance — to make products consumed elsewhere. It measures fuel burned on-site, not fuel used by local residents and businesses. DESNZ's emissions statistics attribute CO2 by point-source location under separate rules, and don't necessarily move in step with this total."],
        ["Calculated here", "DESNZ publishes six fuel categories — Coal, Manufactured fuels, Petroleum, Gas, Electricity, and Bioenergy and wastes — but doesn't say what generated the electricity, since Great Britain's grid pools generation nationally. This site splits Electricity into \"Fossil fuel electricity\" and \"Renewable electricity\" using DUKES's published national generation mix for that year, applied identically to every area. Hovering either row under \"Show all fuel types\" shows the calculation itself: this area's electricity figure, and that year's DUKES share."],
        ["Why that ratio is uniform", "Since the grid pools everything, no area's actual electricity draw can honestly differ from the national mix based on what's built nearby. Only renewable generation is published by local authority, so netting an area's own renewables off first would credit local green generation while leaving local fossil generation invisible. New Forest is the concrete case: it hosts Marchwood, a roughly 900MW gas-fired power station that no local adjustment can see. Adjusting for local renewables alone would make New Forest look greener than the national average despite that plant sitting inside it. See [[generation-chart|Renewable electricity generation by technology]]."],
        ["Two kinds of \"green\"", "Bioenergy and wastes is a real, measured quantity: fuel actually burned within the area, such as wood pellets, biodiesel and industrial biomass. Renewable electricity is a national statistical estimate applied uniformly to this area's electricity figure. Both are genuinely renewable or low-carbon by official convention, but one is measured here and one is estimated from a national average. The same distinction applies within \"Fossil fuels\": Coal, Manufactured fuels, Petroleum and Gas are measured local combustion, while Fossil fuel electricity is the national-mix estimate."],
        ["What \"Renewable electricity\" covers", "DUKES's renewable-generation figure already includes bioenergy-derived electricity — anaerobic digestion, landfill gas, biomass power stations — alongside solar, wind and hydro, so it isn't solar, wind and hydro only. No further national breakdown by technology is published at this level, so it isn't split further."],
        ["Road transport", "DESNZ's road transport figures are modelled from national and regional fuel sales data apportioned to local authorities, not measured locally."],
        ["Worked example", "Switch to \"By sector\" for New Forest and \"Industrial, Commercial and other\" dwarfs Domestic and Transport combined, driven by oil refining rather than local demand — which is also why New Forest's energy consumption looks high next to its emissions figures elsewhere on this site."],
        ["Composite regions", "Each fuel or sector is the sum of that category's figure across the constituent districts, scaled as described in [[region-toggle|Choosing a region]]."]
      ],
      link: { href: "https://www.gov.uk/government/collections/total-final-energy-consumption-at-sub-national-level", label: "gov.uk statistical release" }
    },
    "general-methodology": {
      title: "Full methodology & sources",
      summary: "Every figure traces back to published DESNZ statistics. The only thing calculated here is the boundary apportionment for the proposed unitaries.",
      // No disclosure on this one: someone who clicked "Full methodology & sources" has already
      // asked for the method, so hiding it behind a second click would be perverse.
      alwaysOpen: true,
      method: [
        ["Primary data source", "DESNZ (Department for Energy Security and Net Zero), “UK local authority and regional greenhouse gas emissions statistics, 2005–2024”, published 25 June 2026."],
        ["Basis", "Territorial emissions — what physically happens within the area's boundary — in kt CO2e (thousand tonnes carbon dioxide equivalent), combining CO2, methane (CH4) and nitrous oxide (N2O)."],
        ["Time horizon", "The default \"100-year\" view is DESNZ's own published figures, weighting CH4 and N2O by their 100-year Global Warming Potential (IPCC AR5: CH4 = 28, N2O = 265, CO2 = 1). The \"20-year\" view is calculated by this site, not DESNZ, by reweighting the same gas quantities using GWP20. See [[horizon-toggle|100-year vs 20-year time horizon]]."],
        ["Historic districts & current unitaries", "The 11 historic districts (Basingstoke and Deane, East Hampshire, Eastleigh, Fareham, Gosport, Hart, Havant, New Forest, Rushmoor, Test Valley, Winchester) and 3 current unitaries (Portsmouth, Southampton, Isle of Wight) are DESNZ's own published district figures, used whole and unadjusted. Each represents the area as it exists today, not an LGR-adjusted fragment."],
        ["Mid-Hampshire boundary", "East Hampshire + Winchester + New Forest + Test Valley, per the Government's March 2026 decision, now withdrawn and under review (see [[region-toggle|Choosing a region]]), each scaled down to exclude the parishes moving to South East and South West Hampshire under the same decision. No official sub-district emissions data exists, so each district's contribution is reduced by its 2021 Census parish population share instead: East Hampshire to 82.0%, Winchester to 97.7%, New Forest to 61.0%, Test Valley to 88.8%."],
        ["Limits of the population split", "Apportioning by population assumes every category is spread proportionally to population. That understates the share moving out for anything geographically concentrated rather than evenly spread across a district — see South West Hampshire below for a concrete case."],
        ["North Hampshire boundary", "Basingstoke and Deane + Hart + Rushmoor, whole districts. No parishes move in or out, so no population weighting is needed."],
        ["South East Hampshire boundary", "Fareham + Gosport + Havant + Portsmouth, whole districts, plus the parishes moving in from Mid-Hampshire: 18.0% of East Hampshire (Clanfield, Horndean, Rowlands Castle) and 2.3% of Winchester (Newlands), by the same 2021 Census parish population share method."],
        ["South West Hampshire boundary", "Eastleigh + Southampton, whole districts, plus the parishes moving in from Mid-Hampshire: 39.0% of New Forest (Totton and Eling, Marchwood, Hythe and Dibden, Fawley) and 11.2% of Test Valley (Chilworth, Nursling and Rownhams, Valley Park), by the same method. Note the concentration problem: Fawley (Esso's oil refinery) and Marchwood (the gas-fired power station) are together only around 11% of New Forest's population. The population split spreads that district's industrial energy consumption 61%/39% between Mid- and South West Hampshire, so a large share stays attributed to Mid-Hampshire even though the sites driving it sit in the parishes moving here."],
        ["Isle of Wight, Portsmouth, Southampton", "Unaffected by the LGR decision as separate regions in their own right. The Isle of Wight stays a standalone unitary under the new structure too; Portsmouth and Southampton would be absorbed into South East and South West Hampshire respectively under the March 2026 decision, but their own figures here are simply today's DESNZ district totals."],
        ["Hampshire and the Solent boundary", "Hampshire County Council + Portsmouth + Southampton + Isle of Wight, per the Hampshire and the Solent Combined County Authority Regulations 2026 (SI 2026/595). Hampshire CC isn't itself a DESNZ-reporting unit, so this is modelled as the sum of all 11 current Hampshire districts plus Portsmouth, Southampton and the Isle of Wight, using whole-district figures throughout. No parish-level adjustment is needed, since it doesn't matter which new unitary those parishes end up in — they stay inside Hampshire and the Solent either way. Equivalently, it's the sum of the four proposed unitaries plus the Isle of Wight, which this site's data pipeline checks against directly."],
        ["Population / per-person", "DESNZ mid-year population estimates, included in the same dataset, summed the same way as emissions for each region — and scaled down per district for Mid-Hampshire, South East and South West Hampshire, as above."],
        ["Update cycle", () => "DESNZ typically publishes new figures each summer, roughly 18–24 months behind the current year. This site's data was last refreshed " + formatIsoDate(DATA.meta.generated) + ", and is updated manually when a new release lands."],
        ["Comparing to other published figures", "DESNZ revises prior years' figures on every release, not just the newest year, so a district's total for a given year can shift slightly between releases. A figure quoted elsewhere — a council webpage, a climate action plan — may be citing an earlier DESNZ release than this site uses. Check the release date before assuming a discrepancy is an error in either source."],
        ["Energy data", "Renewable electricity generation by technology (2014–2024) and energy consumption by fuel (2005–2024), both from DESNZ at local authority level, aggregated to every region here the same way as the emissions figures. See [[generation-chart|Renewable electricity generation by technology]] and [[consumption-chart|Energy consumption by fuel]] for category grouping and unit conversions."],
        ["Estimated footprint", "The trend chart's optional footprint line is the one figure not built from DESNZ local data alone. It scales each area's territorial figure by a UK-wide ratio: UK consumption-based emissions, from DEFRA's carbon footprint statistics, divided by the total of every UK local authority's territorial emissions. See [[footprint-toggle|Estimated consumption footprint]]."],
        ["Data & code", "Every emissions figure traces back to the single published DESNZ CSV linked below, with the affected districts' contributions scaled using 2021 Census parish population shares. Apart from the optional footprint estimate above, nothing else here is estimated or modelled."],
        ["Licence", "Contains public sector information licensed under the Open Government Licence v3.0."]
      ],
      link: { href: "https://www.gov.uk/government/statistics/uk-local-authority-and-regional-greenhouse-gas-emissions-statistics-2005-to-2024/2005-to-2024-uk-local-and-regional-greenhouse-gas-emissions-statistical-release-web-accessible", label: "gov.uk statistical release" }
    }
  };

  // Renders a body/dd string into `el`, turning any [[key|label]] marker into an inline button
  // that opens that entry in this same dialog, and any [[https://…|label]] marker into an external
  // link. Text either side is added as text nodes, so authored content still can't inject markup —
  // the marker syntax is the only thing parsed.
  const CROSS_REF = /\[\[(https:\/\/[^|\]\s]+|[a-z0-9-]+)\|([^\]]+)\]\]/g;

  function renderRichText(el, str) {
    let last = 0;
    str.replace(CROSS_REF, (match, target, label, offset) => {
      if (offset > last) el.appendChild(document.createTextNode(str.slice(last, offset)));
      if (target.startsWith("https://")) {
        const a = document.createElement("a");
        a.href = target; a.target = "_blank"; a.rel = "noopener";
        a.textContent = label;
        el.appendChild(a);
      } else {
        const btn = document.createElement("button");
        btn.className = "info-link";
        btn.type = "button";
        btn.dataset.info = target;
        btn.textContent = label;
        el.appendChild(btn);
      }
      last = offset + match.length;
      return match;
    });
    if (last < str.length) el.appendChild(document.createTextNode(str.slice(last)));
  }

  function appendParagraphs(parent, value, className) {
    const paragraphs = Array.isArray(value) ? value : [value];
    paragraphs.filter(Boolean).forEach(text => {
      const el = document.createElement("p");
      if (className) el.className = className;
      renderRichText(el, text);
      parent.appendChild(el);
    });
  }

  // Whether the "Method, sources & caveats" disclosure starts open. Remembered per browser, so
  // someone who wants the method every time expands it once and every dialog thereafter opens
  // expanded, while a general reader never sees it unless they ask. localStorage can throw
  // outright (private browsing, blocked site data, file:// in some browsers), so every access is
  // guarded and the fall-back is collapsed.
  const METHOD_OPEN_KEY = "hee.methodOpen";

  function methodOpenPref() {
    try { return window.localStorage.getItem(METHOD_OPEN_KEY) === "1"; } catch (e) { return false; }
  }

  function setMethodOpenPref(open) {
    try { window.localStorage.setItem(METHOD_OPEN_KEY, open ? "1" : "0"); } catch (e) { /* not fatal */ }
  }

  function appendMethodRows(parent, info) {
    const dl = document.createElement("dl");
    const rows = (info.method || []).slice();
    // The live axis-setter sentence is always the last row, and drops out entirely under auto
    // scale (where describeSetter returns no text) rather than rendering an empty definition.
    if (info.axisNote) rows.push(["Axis under fixed scale", info.axisNote, "axis"]);
    rows.forEach(([term, definition, rowId]) => {
      const text = typeof definition === "function" ? definition() : definition;
      if (!text) return;
      const dt = document.createElement("dt"); dt.textContent = term;
      const dd = document.createElement("dd");
      if (rowId) dd.dataset.row = rowId;
      renderRichText(dd, text);
      dl.appendChild(dt); dl.appendChild(dd);
    });
    if (dl.childNodes.length) parent.appendChild(dl);
    if (info.link) {
      const p = document.createElement("p");
      p.className = "method-link";
      const a = document.createElement("a");
      a.href = info.link.href; a.target = "_blank"; a.rel = "noopener";
      a.textContent = info.link.label;
      p.appendChild(a);
      parent.appendChild(p);
    }
  }

  // Dialogs opened from inside another dialog stack up, so the breadcrumb can walk back to where
  // the reader came from. Opening one from the page itself is a fresh start and clears the stack.
  let modalStack = [];
  let currentModalKey = null;

  function openModal(key, isCrossRef) {
    if (!INFO_CONTENT[key]) return;
    if (isCrossRef && currentModalKey && currentModalKey !== key) modalStack.push(currentModalKey);
    else if (!isCrossRef) modalStack = [];
    renderModal(key);
  }

  function backModal() {
    const previous = modalStack.pop();
    if (previous) renderModal(previous);
  }

  function renderModal(key) {
    const info = INFO_CONTENT[key];
    if (!info) return;
    currentModalKey = key;

    const overlay = document.getElementById("modal-overlay");
    const body = document.getElementById("modal-body");
    document.getElementById("modal-title").textContent = info.title;

    const back = document.getElementById("modal-back");
    const parentKey = modalStack[modalStack.length - 1];
    back.classList.toggle("is-hidden", !parentKey);
    if (parentKey) {
      back.textContent = "‹ " + INFO_CONTENT[parentKey].title;
      back.setAttribute("aria-label", "Back to " + INFO_CONTENT[parentKey].title);
    }

    clearNode(body);
    if (info.summary) appendParagraphs(body, info.summary, "modal-summary");
    if (info.dynamicIntro) appendParagraphs(body, info.dynamicIntro(), "modal-figure");
    if (info.readIt && info.readIt.length) {
      const ul = document.createElement("ul");
      ul.className = "read-it";
      info.readIt.forEach(text => {
        const li = document.createElement("li");
        renderRichText(li, text);
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    if (info.alwaysOpen) {
      appendMethodRows(body, info);
    } else {
      const details = document.createElement("details");
      details.className = "method-block";
      details.open = methodOpenPref();
      const summary = document.createElement("summary");
      summary.textContent = "Method, sources & caveats";
      details.appendChild(summary);
      appendMethodRows(details, info);
      details.addEventListener("toggle", () => setMethodOpenPref(details.open));
      body.appendChild(details);
    }

    body.scrollTop = 0;
    overlay.classList.remove("is-hidden");
  }

  function closeModal() {
    document.getElementById("modal-overlay").classList.add("is-hidden");
    modalStack = [];
    currentModalKey = null;
  }

  // ---------------- wiring ----------------

  // Every chart that should re-render whenever a page-wide control changes (metric, view,
  // horizon, colour theme) or the app first loads. A new chart added to the page must be added
  // here (and to REGION_SCOPED_CHARTS below, if it takes a region) — that's the only place a
  // control-to-chart wiring can now be forgotten, instead of each control handler needing its
  // own hand-maintained list. Some charts here ignore some controls (generation/consumption
  // read currentMetric but not currentHorizon, since GWP reweighting doesn't apply to physical
  // energy volumes) — re-rendering them anyway on every page-wide control is deliberate: it's
  // cheap, and it means "does chart X react to control Y" is answered by that chart's own code,
  // not by whether someone remembered to list it under every applicable handler.
  const PAGE_WIDE_CHARTS = [
    buildTrendChart,
    () => buildSectorChart(currentRegion),
    () => buildGasChart(currentRegion),
    () => buildGenerationChart(currentRegion),
    () => buildConsumptionChart(currentRegion)
  ];

  // The subset of PAGE_WIDE_CHARTS that also needs re-rendering when the region selector
  // changes — now everything, including the trend chart: it used to always plot the same three
  // regions regardless of selection, but now shows the selected region in its hierarchy context
  // (see contextRegions() above), so it's as region-scoped as the rest.
  const REGION_SCOPED_CHARTS = [
    buildTrendChart,
    () => buildSectorChart(currentRegion),
    () => buildGasChart(currentRegion),
    () => buildGenerationChart(currentRegion),
    () => buildConsumptionChart(currentRegion)
  ];

  function renderPageWideCharts() {
    PAGE_WIDE_CHARTS.forEach(fn => fn());
  }

  function renderRegionScopedCharts() {
    REGION_SCOPED_CHARTS.forEach(fn => fn());
  }

  // Reflects the current region in the URL as a "?region=" param, so a link can point straight
  // at any of the 20 regions — the point of promoting this site across every district and
  // unitary rather than just Winchester's original three geographies. Uses replaceState, not
  // pushState: switching regions is exploratory, like the other page controls, not something
  // that should give every click its own back-button stop. "winchester" (the default) is kept
  // param-free so the plain URL still works exactly as before.
  function syncUrl(regionKey) {
    const url = new URL(location.href);
    if (regionKey === "winchester") {
      url.searchParams.delete("region");
    } else {
      url.searchParams.set("region", regionKey);
    }
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  // The four proposed unitaries follow the Government's March 2026 LGR decision, which it withdrew
  // on 7 September 2026 pending a fresh decision (expected early 2027) — so selecting one shows a
  // "Provisional boundaries" chip that opens the "Choosing a region" dialog explaining why.
  function syncProvisionalChip() {
    const chip = document.getElementById("provisional-chip");
    if (chip) chip.classList.toggle("is-hidden", REGION_BY_KEY[currentRegion].group !== "proposed-unitary");
  }

  function setRegion(regionKey) {
    currentRegion = regionKey;
    compareMode = "context";
    document.getElementById("region-select").value = regionKey;
    syncProvisionalChip();
    const compareToggle = document.getElementById("compare-constituents-toggle");
    if (compareToggle) compareToggle.checked = false;
    syncUrl(regionKey);
    renderRegionScopedCharts();
  }

  // Wired to the trend chart's "Compare all constituents" checkbox — independent of setRegion()
  // since toggling it shouldn't reset the selected region, only which set of regions the trend
  // chart plots (see contextRegionKeys()).
  function setCompareMode(mode) {
    compareMode = mode;
    buildTrendChart();
  }

  function setMetric(metric) {
    currentMetric = metric;
    document.querySelectorAll("[data-metric]").forEach(b => {
      b.classList.toggle("is-active", b.dataset.metric === metric);
    });
    renderPageWideCharts();
  }

  // Page-wide (not per-chart) for the same reason as setMetric/setHorizon above: it's one
  // control-to-chart wiring answered by PAGE_WIDE_CHARTS rather than a hand-picked chart list,
  // even though only generation/consumption actually read currentEnergyUnit.
  function setEnergyUnit(unit) {
    currentEnergyUnit = unit;
    document.querySelectorAll("[data-energy-unit]").forEach(b => {
      b.classList.toggle("is-active", b.dataset.energyUnit === unit);
    });
    renderPageWideCharts();
  }

  // Page-wide for the same reason as setEnergyUnit above — one wiring via PAGE_WIDE_CHARTS,
  // even though only generation/consumption read currentScaleMode.
  function setScaleMode(mode) {
    currentScaleMode = mode;
    document.querySelectorAll("[data-scale-mode]").forEach(b => {
      b.classList.toggle("is-active", b.dataset.scaleMode === mode);
    });
    renderPageWideCharts();
  }

  function setView(view) {
    currentView = view;
    document.querySelectorAll("[data-view]").forEach(b => {
      b.classList.toggle("is-active", b.dataset.view === view);
    });
    renderPageWideCharts();
  }

  // Horizon is deliberately page-wide (not a per-chart control): it changes which numbers are
  // "true" everywhere at once, so a body-level class lets CSS reinforce that (e.g. a themed
  // banner) rather than just re-rendering the two charts in isolation.
  function setHorizon(horizon) {
    currentHorizon = horizon;
    document.querySelectorAll("[data-horizon]").forEach(b => {
      b.classList.toggle("is-active", b.dataset.horizon === horizon);
    });
    document.body.classList.toggle("horizon-gwp20", horizon === "gwp20");
    document.getElementById("horizon-banner").classList.toggle("is-hidden", horizon !== "gwp20");
    renderPageWideCharts();
  }

  // Keeps each sticky bar pinned directly under the one above it, whatever height each actually
  // renders at (the control panel wraps to two rows below ~640px wide, changing everything
  // stacked beneath it): control panel -> region toggle (now including the chart scale toggle,
  // so its height already accounts for that) -> energy unit toggle.
  function setupStickyOffset() {
    const panel = document.getElementById("control-panel");
    const regionRow = document.getElementById("region-scoped").querySelector(".region-toggle-row");
    const energyUnitRow = document.getElementById("energy-unit-row");
    const update = () => {
      document.documentElement.style.setProperty("--control-panel-h", panel.offsetHeight + "px");
      document.documentElement.style.setProperty("--region-toggle-h", regionRow.offsetHeight + "px");
      // Tracks the energy-unit row's own height too — see .card's scroll-margin-top in style.css,
      // which needs this (on top of the two above) to keep a card's own heading clear of the
      // sticky stack when a browser-driven jump (in-page search, fragment link, Tab-to-focus)
      // lands on it, inside #energy-scoped where all three bars stack.
      document.documentElement.style.setProperty("--energy-unit-row-h", energyUnitRow.offsetHeight + "px");
    };
    update();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(update);
      ro.observe(panel);
      ro.observe(regionRow);
      ro.observe(energyUnitRow);
    } else {
      window.addEventListener("resize", update);
    }
  }

  function wireEvents() {
    setupStickyOffset();

    document.getElementById("region-select").addEventListener("change", (ev) => setRegion(ev.target.value));

    document.getElementById("compare-constituents-toggle").addEventListener("change", (ev) => {
      setCompareMode(ev.target.checked ? "constituents" : "context");
    });

    document.getElementById("footprint-toggle").addEventListener("change", (ev) => {
      footprintPref = ev.target.checked;
      buildTrendChart();
    });

    document.querySelectorAll("[data-metric]").forEach(btn => {
      btn.addEventListener("click", () => setMetric(btn.dataset.metric));
    });
    document.querySelectorAll("[data-view]").forEach(btn => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });
    document.querySelectorAll("[data-horizon]").forEach(btn => {
      btn.addEventListener("click", () => setHorizon(btn.dataset.horizon));
    });
    document.querySelectorAll("[data-energy-unit]").forEach(btn => {
      btn.addEventListener("click", () => setEnergyUnit(btn.dataset.energyUnit));
    });
    document.querySelectorAll("[data-scale-mode]").forEach(btn => {
      btn.addEventListener("click", () => setScaleMode(btn.dataset.scaleMode));
    });

    document.getElementById("sector-detail-toggle").addEventListener("change", (ev) => {
      currentDetail = ev.target.checked;
      buildSectorChart(currentRegion);
    });

    document.getElementById("consumption-detail-toggle").addEventListener("change", (ev) => {
      currentConsumptionDetail = ev.target.checked;
      buildConsumptionChart(currentRegion);
    });

    document.querySelectorAll("[data-consumption-view]").forEach(btn => {
      btn.addEventListener("click", () => {
        currentConsumptionView = btn.dataset.consumptionView;
        buildConsumptionChart(currentRegion);
      });
    });

    // Delegated, not bound per-button at wire-up: the cross-reference buttons inside a dialog's
    // own body ([[key|label]], see renderRichText) are created after this runs, every time a
    // dialog opens, so a static querySelectorAll would never see them.
    document.addEventListener("click", (ev) => {
      const btn = ev.target.closest && ev.target.closest("[data-info]");
      if (btn) openModal(btn.dataset.info, !!btn.closest("#modal-body"));
    });
    document.getElementById("modal-back").addEventListener("click", backModal);
    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("modal-overlay").addEventListener("click", (ev) => {
      if (ev.target.id === "modal-overlay") closeModal();
    });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeModal(); });

    document.querySelectorAll(".table-toggle").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.dataset.target);
        const hidden = target.classList.toggle("is-hidden");
        btn.textContent = hidden ? "Show as table" : "Hide table";
      });
    });

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderPageWideCharts);
    }
  }

  // The development version is this repo's own GitHub Pages copy, at exactly DEV_HOST/DEV_PATH,
  // shared for feedback. Every other copy is a packaged release (package_site.py), wherever it's
  // hosted (the release repo's Pages site, a custom domain, another organisation's server), so
  // only that one address is recognised rather than a list of release hosts. Detected by address
  // rather than a per-deploy flag, so the release ships the same code the tests ran against. The
  // dev banner links to PUBLIC_URL, where a release is hosted, so anyone who lands on the dev copy
  // can find the stable one.
  const PUBLIC_URL = "https://cann.network/emissions";
  const DEV_HOST = "garethj.github.io";
  const DEV_PATH = "hampshire-emissions-explorer";

  function deploymentKind(hostname, pathname) {
    const firstSegment = (pathname || "").split("/")[1] || "";
    return (hostname || "").toLowerCase() === DEV_HOST && firstSegment.toLowerCase() === DEV_PATH
      ? "dev" : "public";
  }

  function showDevBanner() {
    if (deploymentKind(location.hostname, location.pathname) !== "dev") return;
    const banner = document.getElementById("dev-banner");
    if (PUBLIC_URL) {
      banner.append(" ");
      const link = document.createElement("a");
      link.href = PUBLIC_URL;
      link.textContent = "Go to the public version";
      banner.append(link);
    }
    banner.classList.remove("is-hidden");
  }

  function init() {
    showDevBanner();
    if (!window.MHE_DATA) {
      document.getElementById("trend-chart").textContent = "Could not load emissions data: data/mid_hampshire_emissions.js did not load.";
      return;
    }
    DATA = window.MHE_DATA;
    ENERGY_DATA = window.MHE_ENERGY_DATA || null;
    initRegions();
    populateRegionSelect();
    wireEvents();
    // Deep link support: "?region=<key>" opens straight into that region instead of the default
    // Winchester — the point of promoting this site across every district and unitary, not just
    // Winchester's original three geographies. Falls back to Winchester for a missing/unknown key.
    const regionParam = new URLSearchParams(location.search).get("region");
    currentRegion = (regionParam && REGION_BY_KEY[regionParam]) ? regionParam : "winchester";
    document.getElementById("region-select").value = currentRegion;
    syncProvisionalChip();
    renderPageWideCharts();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
