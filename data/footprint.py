"""Reads DEFRA's UK carbon footprint statistics (produced by the University of Leeds) for the
trend chart's "estimated consumption footprint" line.

DESNZ's local authority data is territorial only: emissions released within each area's boundary.
Nobody publishes consumption-based emissions below UK level, so the site estimates them by scaling
each area's territorial figure by a UK-wide ratio. This module reads the ratio's numerator, UK
consumption-based emissions, from Figure_8 of DEFRA's "figures and tables" workbook (AR5 GWP100).
Consumption-based emissions include emissions embedded in imports and exclude those from making
exports (DEFRA's note 2).

The denominator is not read here: process.py sums every local authority's territorial emissions
in the DESNZ CSV instead. Figure_8's own territorial column is the UK national inventory total,
about 7% higher than the local-authority sum, because it includes emissions DESNZ doesn't assign to
any local authority. It's kept in the output for reference.

Deliberately consumption ÷ territorial, not consumption ÷ the UK-produced part of the footprint
(Figure_3's split): the multiplier is applied to DESNZ *territorial* figures, so its denominator
has to be territorial emissions too. (The other ratio comes out around 2.2 for 2022 and overstates
the uplift.)

The workbook is .ods, and the system Python has no ODS library, so this reads the OpenDocument XML
directly with the standard library — an .ods file is a zip whose content.xml holds every sheet.
"""
import re
import zipfile
import xml.etree.ElementTree as ET

SOURCE_LABEL = "University of Leeds for DEFRA, “Carbon footprint for the UK and England”"
SOURCE_URL = "https://www.gov.uk/government/statistics/uks-carbon-footprint"
SHEET = "Figure_8"

_TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
_OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"

# Columns repeated past this are padding (ODS stores "the rest of the row is empty" as one cell
# repeated ~16,000 times); no real table here is anywhere near this wide.
_MAX_REPEAT = 64


def read_ods_sheet(path, sheet_name):
    """Returns one sheet as a list of rows, each a list of float/str/None cell values."""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("content.xml"))
    for table in root.iter(_TABLE + "table"):
        if table.get(_TABLE + "name") != sheet_name:
            continue
        rows = []
        for row in table.iter(_TABLE + "table-row"):
            cells = []
            for cell in row:
                if cell.tag not in (_TABLE + "table-cell", _TABLE + "covered-table-cell"):
                    continue
                repeat = min(int(cell.get(_TABLE + "number-columns-repeated", "1")), _MAX_REPEAT)
                value = cell.get(_OFFICE + "value")
                if value is not None:
                    value = float(value)
                else:
                    value = "".join(cell.itertext()) or None
                cells.extend([value] * repeat)
            while cells and cells[-1] is None:
                cells.pop()
            rows.append(cells)
        return rows
    raise ValueError(f"No sheet named {sheet_name!r} in {path}")


def _find_column(header, prefix):
    for i, h in enumerate(header):
        if isinstance(h, str) and h.strip().lower().startswith(prefix):
            return i
    raise ValueError(f"No column starting {prefix!r} in Figure_8 header {header!r} — has DEFRA changed the table?")


def parse_footprint(path):
    """Returns {year: {"consumption_mt_co2e", "territorial_mt_co2e"}} for every year
    Figure_8 covers. Finds columns by header prefix rather than position, since DEFRA's headers
    carry note markers ("[note 2]") and units that could shift between releases."""
    rows = read_ods_sheet(path, SHEET)
    header_idx = next(
        (i for i, r in enumerate(rows) if r and isinstance(r[0], str) and r[0].strip().lower() == "year"),
        None,
    )
    if header_idx is None:
        raise ValueError(f"No 'Year' header row in {SHEET} — has DEFRA changed the table?")
    header = rows[header_idx]
    cons_col = _find_column(header, "consumption-based")
    terr_col = _find_column(header, "territorial-based")

    out = {}
    for r in rows[header_idx + 1:]:
        if not r or not isinstance(r[0], float):
            continue
        year = int(r[0])
        cons = r[cons_col] if len(r) > cons_col else None
        terr = r[terr_col] if len(r) > terr_col else None
        if not isinstance(cons, float) or not isinstance(terr, float) or terr <= 0:
            continue
        out[year] = {
            "consumption_mt_co2e": round(cons, 3),
            "territorial_mt_co2e": round(terr, 3),
        }
    if not out:
        raise ValueError(f"No year rows parsed from {SHEET} — has DEFRA changed the table?")
    return out


def published_title(path):
    """The workbook's own title (e.g. "UK and England's carbon footprint, 1990 to 2023"), from its
    cover sheet's first cell, so the site can name the edition it's using without hard-coding it."""
    rows = read_ods_sheet(path, "Cover_sheet")
    first = rows[0][0] if rows and rows[0] else None
    return re.sub(r"\s+", " ", first).strip() if isinstance(first, str) else None
