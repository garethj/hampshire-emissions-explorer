"""Unit tests for data/footprint.py, the DEFRA carbon footprint workbook reader, against small
generated .ods fixtures (see ods_fixture.py) rather than the real download."""
import os
import sys
import unittest
import zipfile
from tempfile import TemporaryDirectory

DATA_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, DATA_DIR)

import footprint  # noqa: E402
from tests import ods_fixture  # noqa: E402


class TestParseFootprint(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "fp.ods")

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_consumption_and_territorial_not_production_column(self):
        # The fixture's production-based column is a constant 500; picking it by mistake (it sits
        # between the other two) would give 500 for one of them.
        ods_fixture.write_footprint_ods(self.path, {2022: (700.0, 400.0)})
        out = footprint.parse_footprint(self.path)
        self.assertEqual(out, {2022: {"consumption_mt_co2e": 700.0, "territorial_mt_co2e": 400.0}})

    def test_columns_found_by_header_not_position(self):
        original = ods_fixture.HEADER
        try:
            # Swap the order of the two columns the parser needs; values follow their headers.
            ods_fixture.HEADER = [original[0], original[3], original[2], original[1]]
            ods_fixture.write_footprint_ods(self.path, {2022: (400.0, 700.0)})
        finally:
            ods_fixture.HEADER = original
        out = footprint.parse_footprint(self.path)
        self.assertEqual(out[2022], {"consumption_mt_co2e": 700.0, "territorial_mt_co2e": 400.0})

    def test_preamble_and_padding_rows_are_skipped(self):
        ods_fixture.write_footprint_ods(self.path, {2020: (720.0, 410.0), 2021: (690.0, 420.0)})
        self.assertEqual(sorted(footprint.parse_footprint(self.path)), [2020, 2021])

    def test_edition_title_read_from_cover_sheet(self):
        ods_fixture.write_footprint_ods(self.path, {2022: (700.0, 400.0)})
        self.assertEqual(footprint.published_title(self.path), ods_fixture.TITLE)

    def test_missing_sheet_fails_loudly(self):
        with zipfile.ZipFile(self.path, "w") as z:
            z.writestr("content.xml", '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>')
        with self.assertRaises(ValueError):
            footprint.parse_footprint(self.path)


if __name__ == "__main__":
    unittest.main()
