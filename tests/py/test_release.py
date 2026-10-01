"""Tests for release.py's version proposal and validation (the parts that don't touch git)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import release  # noqa: E402


class BumpTest(unittest.TestCase):
    def test_bump_resets_lower_parts(self):
        self.assertEqual(release.bump("v1.4.2", "major"), "v2.0.0")
        self.assertEqual(release.bump("v1.4.2", "minor"), "v1.5.0")
        self.assertEqual(release.bump("v1.4.2", "patch"), "v1.4.3")

    def test_versions_compare_numerically_not_as_text(self):
        self.assertGreater(release.parse_version("v1.10.0"), release.parse_version("v1.9.0"))


class ResolveChoiceTest(unittest.TestCase):
    def test_enter_accepts_the_proposal(self):
        self.assertEqual(release.resolve_choice("", "v1.5.0", "v1.4.2"), "v1.5.0")

    def test_keywords_bump_from_the_last_release(self):
        self.assertEqual(release.resolve_choice("patch", "v1.5.0", "v1.4.2"), "v1.4.3")

    def test_typed_version_is_accepted_with_or_without_the_v(self):
        self.assertEqual(release.resolve_choice("2.0.0", "v1.5.0", "v1.4.2"), "v2.0.0")
        self.assertEqual(release.resolve_choice("v2.0.0", "v1.5.0", "v1.4.2"), "v2.0.0")

    def test_rejects_malformed_or_non_increasing_versions(self):
        for answer in ("1.5", "v1.5.0-beta", "banana", "v1.4.2", "v1.3.9"):
            with self.assertRaises(ValueError, msg=answer):
                release.resolve_choice(answer, "v1.5.0", "v1.4.2")

    def test_keyword_needs_a_previous_release(self):
        with self.assertRaises(ValueError):
            release.resolve_choice("minor", release.FIRST_VERSION, None)


if __name__ == "__main__":
    unittest.main()
