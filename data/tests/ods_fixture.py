"""Writes a minimal .ods workbook shaped like DEFRA's UK carbon footprint "figures and tables" file,
for testing data/footprint.py and process.py without the real download.

Only what footprint.py reads is reproduced: a Cover_sheet whose first cell is the edition title,
and a Figure_8 sheet with DEFRA's preamble rows, a "Year" header row (column headers carrying the
same "[note n]" markers as the real file) and one row per year. Cells are written with
number-columns-repeated padding at the end of each row, as LibreOffice and DEFRA's own file do,
so the reader's handling of that is exercised too.
"""
import zipfile
from xml.sax.saxutils import escape

TITLE = "UK and England's carbon footprint, 1990 to 2021"
HEADER = [
    "Year",
    "Consumption-based emissions(MtCO2e)[note 2]",
    "Production-based emissions(MtCO2e)[note 3]",
    "Territorial-based emissions(MtCO2e)[note 4]",
]


def _cell(value):
    if isinstance(value, (int, float)):
        return f'<table:table-cell office:value-type="float" office:value="{value}"><text:p>{value}</text:p></table:table-cell>'
    return f'<table:table-cell office:value-type="string"><text:p>{escape(value)}</text:p></table:table-cell>'


def _row(values):
    cells = "".join(_cell(v) for v in values)
    return f'<table:table-row>{cells}<table:table-cell table:number-columns-repeated="16380"/></table:table-row>'


def _table(name, rows):
    body = "".join(_row(r) for r in rows)
    return f'<table:table table:name="{name}">{body}<table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table>'


def write_footprint_ods(path, years):
    """years: {year: (consumption_mt, territorial_mt)}"""
    figure_rows = [
        ["Figure 8: Relationship between different measures of the UK's greenhouse gas emissions"],
        ["This worksheet contains one table."],
        ["Back to table of contents"],
        HEADER,
    ] + [[float(y), float(c), 500.0, float(t)] for y, (c, t) in sorted(years.items())]
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<office:document-content'
        ' xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
        ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
        ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">'
        "<office:body><office:spreadsheet>"
        + _table("Cover_sheet", [[TITLE]])
        + _table("Figure_8", figure_rows)
        + "</office:spreadsheet></office:body></office:document-content>"
    )
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/vnd.oasis.opendocument.spreadsheet", compress_type=zipfile.ZIP_STORED)
        z.writestr("content.xml", content)
