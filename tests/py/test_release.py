"""Tests for release.py's version proposal and validation, and how it replaces the public host's
files (the parts that don't touch git or the network)."""
import sys
import tempfile
import unittest
import zipfile
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


class SyncSiteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.checkout = self.tmp / "host"
        (self.checkout / ".git").mkdir(parents=True)
        (self.checkout / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        for name in ("README.md", "CNAME", ".nojekyll"):
            (self.checkout / name).write_text(f"host's own {name}")
        # Left over from a previous release: a file the new one dropped, in a folder it still has.
        (self.checkout / "assets" / "old").mkdir(parents=True)
        (self.checkout / "assets" / "old" / "gone.js").write_text("stale")
        (self.checkout / "index.html").write_text("old page")
        self.zip = self.tmp / "site.zip"
        folder = release.package_site.FOLDER
        with zipfile.ZipFile(self.zip, "w") as z:
            z.writestr(f"{folder}/index.html", "new page")
            z.writestr(f"{folder}/assets/js/app.js", "app")
            z.writestr(f"{folder}/data/mid_hampshire_emissions.js", "data")

    def test_replaces_the_site_and_keeps_the_host_repos_own_files(self):
        release.sync_site(self.zip, self.checkout)
        self.assertEqual((self.checkout / "index.html").read_text(), "new page")
        self.assertEqual((self.checkout / "assets" / "js" / "app.js").read_text(), "app")
        self.assertEqual((self.checkout / "data" / "mid_hampshire_emissions.js").read_text(), "data")
        self.assertFalse((self.checkout / "assets" / "old").exists(), "files a release dropped should go")
        for name in ("README.md", "CNAME", ".nojekyll"):
            self.assertEqual((self.checkout / name).read_text(), f"host's own {name}")
        self.assertTrue((self.checkout / ".git" / "HEAD").exists())

    def test_rejects_a_zip_without_the_expected_folder(self):
        with zipfile.ZipFile(self.zip, "w") as z:
            z.writestr("index.html", "not in the folder")
        with self.assertRaises(ValueError):
            release.sync_site(self.zip, self.checkout)


if __name__ == "__main__":
    unittest.main()
