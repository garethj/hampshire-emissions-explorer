"""Checks package_site.py's allowlist ships everything the page loads, and nothing else.

The public host gets only the packaged zip, so a file index.html references but the allowlist
misses would break the public site while the GitHub Pages copy (which serves the whole repo)
kept working — exactly the kind of failure nobody would notice until after a release.
"""
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import package_site  # noqa: E402

# Tracked files as staged, so the pre-commit hook checks the commit about to be made.
TRACKED = subprocess.run(["git", "ls-files"], cwd=ROOT, check=True, capture_output=True,
                         text=True).stdout.splitlines()
PACKAGED = {p for p in TRACKED if package_site.is_site_file(p)}


def local_refs(text, pattern):
    refs = {m.split("?")[0].split("#")[0] for m in re.findall(pattern, text)}
    return {r for r in refs if r and not re.match(r"^(https?:|data:|mailto:|//)", r)}


class PackageSiteTest(unittest.TestCase):
    def test_every_file_index_html_loads_is_packaged(self):
        html = (ROOT / "index.html").read_text()
        refs = local_refs(html, r'(?:src|href)="([^"]+)"')
        self.assertTrue(refs, "expected index.html to reference local files")
        self.assertEqual(refs - PACKAGED, set())

    def test_every_file_the_stylesheet_loads_is_packaged(self):
        css_path = "assets/css/style.css"
        refs = local_refs((ROOT / css_path).read_text(), r'url\(["\']?([^"\')]+)')
        resolved = {str((Path(css_path).parent / r)).replace("assets/css/../", "assets/") for r in refs}
        self.assertEqual(resolved - PACKAGED, set())

    def test_nothing_but_the_site_is_packaged(self):
        for path in PACKAGED:
            self.assertFalse(path.endswith((".py", ".json", ".csv", ".xlsx", ".md")), path)
            self.assertFalse(path.startswith(("tests/", "data/tests/", ".")), path)


if __name__ == "__main__":
    unittest.main()
