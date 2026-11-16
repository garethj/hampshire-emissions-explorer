# What else could we add?

This dashboard deliberately starts small — a few headline figures, built on data we're confident in. This is the longer list of what the same underlying dataset (and some others) could support if there's interest. It used to live in an in-app tab; it's kept here instead so the idea isn't lost even though the tab is gone.

## More regions

- **Build-your-own region** — Let anyone tick any combination of current districts and get an instant combined chart — useful if boundaries change again, or to test other groupings.

## Targets

- **Compare against a net-zero pathway** — Add a target trajectory line — e.g. the Tyndall Centre's local carbon budget, or a locally agreed net-zero target — so the trend can be read against what's actually needed.
- **Trend projection** — Extend each area's past trend forward to show when it would reach zero at the current rate, as Phil Gagg's WinACC reports do (Winchester District's territorial emissions reach zero in about 2049 on a straight-line projection). Most useful next to the pathway line above, since the gap between the two is the point. Say plainly that it's a straight-line extrapolation, not a forecast.
- **When each sub-sector reaches zero** — The same projection per sub-sector shows which emissions are "persistent": at current rates Winchester's transport reaches zero in 2113 and livestock in 2101 (Phil's figures). Needs the sub-sector history below.
- **Year-on-year change and average rate** — Show the latest year's change and the average annual reduction for the selected area. Winchester's 1.2% rise in 2024, when every other area fell or held flat, is easy to miss on a line chart.

## More detail from the emissions data

- **Sub-sector trends over time** — DESNZ publishes sub-sector figures (motorways, livestock, domestic gas and so on) for every year from 2005, but the site only bakes in the latest year, so sub-sector detail is missing from the historical trend view. `data/process.py` already aggregates every year; it would need to export them all and the sector chart's trend view would need a sub-sector mode. The latest year's sub-sector detail is about 48 KB of JSON, so all 20 years would add roughly 1 MB to a data file that's 340 KB today. Worth checking load time on a phone.
- **Emissions by fuel** — DESNZ's sub-sectors are a sector × fuel grid (for example Domestic Electricity, Domestic Gas, Domestic 'Other'), so emissions can be regrouped into electricity, gas and other fuels (mostly oil). Phil's reports use this to show grid decarbonisation doing most of the work while gas and oil barely move. Distinct from the consumption chart's fuel split, which is energy used, not emissions.
- **Percentage shares** — Show each sector's share of the total in tooltips (for example "Transport 50%"), since that's how reports and officers usually quote these figures.
- **UK average as a reference** — A national per-person line on the trend chart, and the national sector shares (transport is about 32% nationally against about 50% in Winchester). UK totals can be summed from the same DESNZ CSV, which covers every local authority in the UK.

## Other data

- **Housing & retrofit (EPC data)** — Energy Performance Certificate data by district could show housing stock efficiency and retrofit progress, relevant to the large Domestic sector.
- **Transport specifics** — EV charge-point density, ULEV registrations and active travel mode share — useful given transport is the single largest sector here.
- **Local vs imported green energy** — Not really buildable: there's no metering anywhere that ties a unit of electricity consumed in one area back to a specific generator elsewhere, since the GB grid pools everything. The consumption chart's DUKES-based fossil/renewable electricity split (applying the national generation mix uniformly to every area) is the closest honest answer to "how green is my electricity" — a national average, not a true local-origin measurement.

## Visuals

- **Map view** — A choropleth map of the constituent districts, using free ONS boundary files, showing each district's share of the Mid-Hampshire total.
- **Consumption-side sankey (fuel → sector)** — DESNZ's sub-national total final energy consumption dataset is structured as a genuine fuel × sector matrix (Coal/Oil/Gas/Electricity/Bioenergy, by domestic/industrial-commercial/transport), so a sankey from fuel type to sector would represent something DESNZ actually measures, not an inference. Deliberately **not** a sankey from local renewable generation to local consumption sectors — that would visually imply a local wind farm powers local homes directly, which the national grid doesn't do (locally generated power is exported/pooled, not routed to local sectors). Keep generation and consumption-by-fuel as separate charts, as now.

## Usability

- **Download the data** — A one-click CSV export of whatever's currently on screen, for anyone who wants to do their own analysis.
- **Interactive legends** — Click a legend entry to isolate that series on the chart — handy once there are more than two or three regions or sectors on screen at once.
