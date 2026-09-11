"""Keeps the in-app "i" dialogs honest about the LGR boundary change.

The parish names and population-share percentages quoted in the dialogs are prose duplicates of
la_config.MOVING_PARISHES / DISTRICT_POPULATION_2021, which is what the data pipeline actually
computes with. Two dialogs quote them: "Choosing a region" (names only, as orientation) and
"Full methodology & sources" (names plus the exact fractions). Nothing mechanical ties either
back to the config, so a corrected Census figure or a post-judicial-review boundary change would
update every chart on the site while leaving the dialogs confidently stating the old numbers —
the worst kind of stale, since the dialogs are exactly where someone goes to check the figures.

These tests read app.js as text on purpose. The alternative — deleting the prose duplicate and
linking to one canonical copy — was considered and rejected: "which parishes move" is a concrete
answer to a question a local reader actually has, and both copies already sit behind the method
disclosure, so neither is costing a general reader anything.
"""
import os
import re
import sys
import unittest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.dirname(TESTS_DIR)
REPO_ROOT = os.path.dirname(DATA_DIR)
sys.path.insert(0, DATA_DIR)

import la_config as lc  # noqa: E402

APP_JS = os.path.join(REPO_ROOT, "assets", "js", "app.js")
DISTRICTS = sorted(lc.MOVING_PARISHES, key=len, reverse=True)
DISTRICT_RE = "|".join(re.escape(d) for d in DISTRICTS)


def method_row(label):
    """The definition text of a [label, "..."] row in INFO_CONTENT, with JS escapes undone."""
    with open(APP_JS, encoding="utf-8") as fh:
        source = fh.read()
    match = re.search(r'\["%s",\s*"((?:[^"\\]|\\.)*)"\]' % re.escape(label), source)
    assert match, "no INFO_CONTENT row labelled %r in app.js" % label
    return match.group(1).replace('\\"', '"').replace("\\\\", "\\")


def all_parishes():
    return {p for parishes in lc.MOVING_PARISHES.values() for p in parishes}


class TestParishNames(unittest.TestCase):
    def test_region_dialog_attributes_every_parish_to_the_right_district(self):
        # "… gains Clanfield, Horndean and Rowlands Castle from East Hampshire, and Newlands from
        # Winchester." Splitting on "from <district>" gives each district the clause naming its
        # own parishes, so this catches a parish listed under the wrong district as well as a
        # missing one.
        text = method_row("Parishes that move")
        parts = re.split(r" from (%s)" % DISTRICT_RE, text)
        clauses = {parts[i]: parts[i - 1] for i in range(1, len(parts), 2)}
        self.assertEqual(set(clauses), set(lc.MOVING_PARISHES),
                         "the region dialog doesn't name every split district")
        for district, parishes in lc.MOVING_PARISHES.items():
            for parish in parishes:
                self.assertIn(parish, clauses[district],
                              "%r isn't listed as moving from %s in the region dialog" % (parish, district))

    def test_methodology_boundary_rows_name_exactly_the_moving_parishes(self):
        # These rows carry the parish names in parentheses, so they parse exactly — which makes
        # this the one place a *stale extra* name (a parish since dropped from the decision) can
        # be caught, not just a missing one.
        named = set()
        for label in ("South East Hampshire boundary", "South West Hampshire boundary"):
            for group in re.findall(r"\(([^)]*)\)", method_row(label)):
                if "refinery" in group or "power station" in group:
                    continue  # the Fawley/Marchwood aside, not a parish list
                named.update(part.strip() for part in group.split(","))
        self.assertEqual(named, all_parishes(),
                         "the methodology boundary rows and MOVING_PARISHES disagree")

    def test_both_dialogs_name_the_same_parishes(self):
        region_text = method_row("Parishes that move")
        for parish in all_parishes():
            self.assertIn(parish, region_text,
                          "%r is in the methodology rows but missing from the region dialog" % parish)


class TestQuotedPercentages(unittest.TestCase):
    def test_mid_hampshire_retained_shares_match_the_computed_fractions(self):
        # "… East Hampshire to 82.0%, Winchester to 97.7%, New Forest to 61.0%, Test Valley to
        # 88.8%" — the numbers every Mid-Hampshire figure on the site is actually scaled by.
        quoted = dict(re.findall(r"(%s) to (\d+\.\d)%%" % DISTRICT_RE, method_row("Mid-Hampshire boundary")))
        self.assertEqual(set(quoted), set(lc.MID_HAMPSHIRE_RETAINED_FRACTION),
                         "the Mid-Hampshire boundary row doesn't quote a share for every split district")
        for district, share in quoted.items():
            self.assertAlmostEqual(
                float(share), lc.MID_HAMPSHIRE_RETAINED_FRACTION[district] * 100, places=1,
                msg="Mid-Hampshire boundary row says %s keeps %s%%, config computes %.1f%%"
                    % (district, share, lc.MID_HAMPSHIRE_RETAINED_FRACTION[district] * 100))

    def test_receiving_unitary_shares_match_the_computed_moved_fractions(self):
        quoted = {}
        for label in ("South East Hampshire boundary", "South West Hampshire boundary"):
            quoted.update(dict((d, s) for s, d in
                               re.findall(r"(\d+\.\d)%% of (%s)" % DISTRICT_RE, method_row(label))))
        self.assertEqual(set(quoted), set(lc.MOVED_FRACTION),
                         "the boundary rows don't quote a moved share for every split district")
        for district, share in quoted.items():
            self.assertAlmostEqual(
                float(share), lc.MOVED_FRACTION[district] * 100, places=1,
                msg="boundary row says %s%% of %s moves, config computes %.1f%%"
                    % (share, district, lc.MOVED_FRACTION[district] * 100))

    def test_quoted_retained_and_moved_shares_are_complements(self):
        # A consistency check on the prose itself: a reader who adds 82.0% and 18.0% should get
        # 100%, independent of whether either matches the config.
        retained = dict(re.findall(r"(%s) to (\d+\.\d)%%" % DISTRICT_RE, method_row("Mid-Hampshire boundary")))
        moved = {}
        for label in ("South East Hampshire boundary", "South West Hampshire boundary"):
            moved.update(dict((d, s) for s, d in
                              re.findall(r"(\d+\.\d)%% of (%s)" % DISTRICT_RE, method_row(label))))
        for district in retained:
            self.assertAlmostEqual(
                float(retained[district]) + float(moved[district]), 100.0, places=1,
                msg="%s: dialogs say %s%% stays and %s%% moves" % (district, retained[district], moved[district]))


if __name__ == "__main__":
    unittest.main()
