"""Package the site as a zip for copying to the public host.

Builds dist/hampshire-emissions-explorer-<version>.zip containing only what the browser loads —
index.html, assets/, and the two data/*.js files — not the Python pipeline, tests, raw source data
or docs. The zip unpacks to a single hampshire-emissions-explorer/ folder that can be uploaded as
is, at a domain root or in a sub-folder (every path in the site is relative).

Files come from a git commit, not the working tree, so a release is exactly what was committed:
uncommitted edits are never included. <version> is `git describe --tags --always` for that commit,
e.g. v1.0, or v1.0-3-gabc1234 for three commits after the v1.0 tag.

    python3 package_site.py             # package HEAD
    python3 package_site.py v1.0        # package a tag, branch or commit
"""
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
FOLDER = "hampshire-emissions-explorer"

# An allowlist rather than a list of exclusions, so a new script, test or source file can never
# reach the public site by accident. Anything the page loads must be covered here —
# tests/py/test_package_site.py checks that against index.html.
SITE_FILES = {"index.html", "data/mid_hampshire_emissions.js", "data/mid_hampshire_energy.js"}
SITE_DIRS = ("assets/",)


def is_site_file(path):
    return path in SITE_FILES or path.startswith(SITE_DIRS)


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True).stdout


def main():
    ref = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
    try:
        tracked = git("ls-tree", "-r", "--name-only", ref).decode().splitlines()
        version = git("describe", "--tags", "--always", ref).decode().strip()
    except subprocess.CalledProcessError as e:
        sys.exit(f"git couldn't read {ref!r}: {e.stderr.decode().strip()}")

    files = sorted(p for p in tracked if is_site_file(p))
    missing = SITE_FILES - set(files)
    if missing:
        sys.exit(f"{ref} is missing site files: {', '.join(sorted(missing))}")

    DIST.mkdir(exist_ok=True)
    out = DIST / f"{FOLDER}-{version}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path in files:
            z.writestr(f"{FOLDER}/{path}", git("show", f"{ref}:{path}"))

    print(f"Packaged {len(files)} files from {ref} ({version}) into {out.relative_to(ROOT)}")
    if ref == "HEAD" and git("status", "--porcelain"):
        print("Note: uncommitted changes in the working tree are not included.")


if __name__ == "__main__":
    main()
