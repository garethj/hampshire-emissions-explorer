"""Make a release for the public host: pick a version, tag it, and build the site zip.

    python3 release.py

Steps, stopping at the first problem:
  1. Checks the working tree is clean, so the release is exactly what's committed.
  2. Runs the fast test tiers (npm test), as the pre-commit hook does.
  3. Lists the commits since the last release and proposes the next version, which you can accept
     with Enter or change: type a version (v1.4.0), or major / minor / patch.
  4. Creates an annotated git tag for that version, with the commit list as its message.
  5. Builds dist/hampshire-emissions-explorer-<version>.zip via package_site.py, with the version
     stamped into the page footer.
  6. Asks before pushing the tag and creating a GitHub Release with the zip attached (needs the
     gh CLI). Answer no to keep everything local; it prints the commands to finish later.

Versions are vMAJOR.MINOR.PATCH:
  major  a change that breaks how people use or link to the site (e.g. different geography,
         changed ?region= keys)
  minor  new features or a new year of DESNZ data (the default proposal)
  patch  fixes and wording changes only
"""
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple

import package_site

ROOT = Path(__file__).resolve().parent
VERSION_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
FIRST_VERSION = "v1.0.0"


def parse_version(text) -> Optional[Tuple[int, int, int]]:
    m = VERSION_RE.match(text.strip())
    return tuple(int(n) for n in m.groups()) if m else None


def bump(version, part):
    major, minor, patch = parse_version(version)
    if part == "major":
        return f"v{major + 1}.0.0"
    if part == "minor":
        return f"v{major}.{minor + 1}.0"
    return f"v{major}.{minor}.{patch + 1}"


def resolve_choice(answer, proposed, last):
    """Turn the user's answer at the version prompt into a version, or raise ValueError."""
    answer = answer.strip()
    if not answer:
        return proposed
    if answer in ("major", "minor", "patch"):
        if last is None:
            raise ValueError(f"no previous release to bump from; type a version like {FIRST_VERSION}")
        return bump(last, answer)
    if not answer.startswith("v"):
        answer = "v" + answer
    if parse_version(answer) is None:
        raise ValueError(f"{answer!r} isn't vMAJOR.MINOR.PATCH, e.g. {proposed}")
    if last is not None and parse_version(answer) <= parse_version(last):
        raise ValueError(f"{answer} isn't later than the last release, {last}")
    return answer


def run(*args, capture=True):
    result = subprocess.run(args, cwd=ROOT, capture_output=capture, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() if capture else ""
        sys.exit(f"\n`{' '.join(args)}` failed{': ' + detail if detail else ''}")
    return result.stdout.strip() if capture else ""


def last_release():
    tags = run("git", "tag", "--list", "v*", "--merged", "HEAD").splitlines()
    versions = sorted((t for t in tags if parse_version(t)), key=parse_version)
    return versions[-1] if versions else None


def ask(prompt):
    try:
        return input(prompt)
    except (EOFError, KeyboardInterrupt):
        sys.exit("\nCancelled; nothing was tagged.")


def main():
    if run("git", "status", "--porcelain"):
        sys.exit("The working tree has uncommitted changes. Commit or stash them first.")
    branch = run("git", "rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main" and ask(f"You're on '{branch}', not main. Release from here anyway? [y/N] ").lower() != "y":
        sys.exit("Cancelled; nothing was tagged.")

    print("Running tests (npm test)...")
    run("npm", "test", "--silent", capture=False)

    last = last_release()
    log_range = f"{last}..HEAD" if last else "HEAD"
    commits = run("git", "log", "--no-merges", "--format=- %s", log_range)
    if last and not commits:
        sys.exit(f"Nothing has been committed since {last}.")
    proposed = bump(last, "minor") if last else FIRST_VERSION

    print(f"\nLast release: {last or 'none'}. Changes since then:\n{commits}\n")
    while True:
        answer = ask(f"Version [{proposed}] (Enter to accept, or type a version / major / minor / patch): ")
        try:
            version = resolve_choice(answer, proposed, last)
            break
        except ValueError as e:
            print(f"  {e}")
    if run("git", "tag", "--list", version):
        sys.exit(f"Tag {version} already exists.")

    notes = f"Hampshire Emissions Explorer {version}\n\n{commits}\n"
    run("git", "tag", "-a", version, "-m", notes)
    zip_path, _ = package_site.package(version)
    rel_zip = zip_path.relative_to(ROOT)
    print(f"\nTagged {version} and built {rel_zip}")

    push_cmd = ["git", "push", "origin", version] + (["main"] if branch == "main" else [])
    gh_cmd = ["gh", "release", "create", version, str(rel_zip), "--title", version, "--notes-from-tag"]
    if ask(f"\nPush {'main and ' if branch == 'main' else ''}the {version} tag to GitHub and publish a "
           f"GitHub Release with the zip attached? [y/N] ").lower() == "y":
        run(*push_cmd, capture=False)
        run(*gh_cmd, capture=False)
        print(f"\nPublished {package_site.REPO_URL}/releases/tag/{version}")
    else:
        print("\nKept local. To publish later:\n  " + " ".join(push_cmd) + "\n  " + " ".join(gh_cmd)
              + f"\nTo undo the tag instead: git tag -d {version}")


if __name__ == "__main__":
    main()
