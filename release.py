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
  6. Asks before pushing the tag, creating a GitHub Release with the zip attached (needs the gh
     CLI), and publishing the site to the public host: the zip's contents replace everything in
     the garethj/hampshire-emissions-explorer-release repo, whose GitHub Pages site serves it.
     Answer no to keep everything local; it prints the commands to finish later.

To publish an existing release to the host again, e.g. to roll back to it:

    python3 release.py --publish v1.0.1

Versions are vMAJOR.MINOR.PATCH:
  major  a change that breaks how people use or link to the site (e.g. different geography,
         changed ?region= keys)
  minor  new features or a new year of DESNZ data (the default proposal)
  patch  fixes and wording changes only
"""
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Optional, Tuple

import package_site

ROOT = Path(__file__).resolve().parent
VERSION_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
FIRST_VERSION = "v1.0.0"

# The public host: a repo holding only the current release's site files, served by GitHub Pages.
HOST_REPO = "git@github.com:garethj/hampshire-emissions-explorer-release.git"
# Files in the host repo that belong to it rather than to a release, so publishing keeps them:
# CNAME holds the Pages custom domain, .nojekyll stops Pages running the site through Jekyll.
HOST_OWN_FILES = {".git", "README.md", "CNAME", ".nojekyll"}


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


def sync_site(zip_path, checkout):
    """Make `checkout` (a clone of the host repo) hold exactly the site in `zip_path`, keeping
    HOST_OWN_FILES. Files are taken from inside the zip's single top-level folder."""
    checkout = Path(checkout)
    for entry in checkout.iterdir():
        if entry.name in HOST_OWN_FILES:
            continue
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    prefix = package_site.FOLDER + "/"
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if not name.startswith(prefix) or name.endswith("/"):
                raise ValueError(f"unexpected entry in {zip_path}: {name}")
            target = checkout / name[len(prefix):]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(name))


def publish_to_host(zip_path, version):
    """Replace the host repo's site with this release, commit it as the version, and push."""
    with tempfile.TemporaryDirectory() as tmp:
        checkout = Path(tmp) / "host"
        run("git", "clone", "--quiet", "--depth", "1", HOST_REPO, str(checkout))
        sync_site(zip_path, checkout)
        git = ["git", "-C", str(checkout)]
        run(*git, "add", "--all")
        if not run(*git, "status", "--porcelain"):
            print(f"The public host already serves {version}; nothing to publish.")
            return
        run(*git, "commit", "--quiet", "-m", f"Publish {version}")
        run(*git, "push", "--quiet", "origin", "HEAD", capture=False)
    print(f"Published {version} to the public host; GitHub Pages takes a minute or two to update.")


def republish(version):
    """Publish an existing tagged release to the host, e.g. the first time or to roll back."""
    if parse_version(version) is None or not run("git", "tag", "--list", version):
        sys.exit(f"No release tag {version!r}. Releases so far: "
                 f"{', '.join(run('git', 'tag', '--list', 'v*').split()) or 'none'}")
    zip_path, _ = package_site.package(version)
    if ask(f"Publish {version} to the public host, replacing what it serves now? [y/N] ").lower() != "y":
        sys.exit("Cancelled; nothing was published.")
    publish_to_host(zip_path, version)


def ask(prompt):
    try:
        return input(prompt)
    except (EOFError, KeyboardInterrupt):
        sys.exit("\nCancelled; nothing was tagged.")


def main():
    if sys.argv[1:2] == ["--publish"] and len(sys.argv) == 3:
        return republish(sys.argv[2])
    if len(sys.argv) > 1:
        sys.exit("Usage: python3 release.py  |  python3 release.py --publish <existing tag>")
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

    # The first release's "changes" would be the whole project history, so say what it is instead.
    changes = commits if last else "First public release."
    notes = f"Hampshire Emissions Explorer {version}\n\n{changes}\n"
    run("git", "tag", "-a", version, "-m", notes)
    zip_path, _ = package_site.package(version)
    rel_zip = zip_path.relative_to(ROOT)
    print(f"\nTagged {version} and built {rel_zip}")

    push_cmd = ["git", "push", "origin", version] + (["main"] if branch == "main" else [])
    gh_cmd = ["gh", "release", "create", version, str(rel_zip), "--title", version, "--notes-from-tag"]
    if ask(f"\nPush {'main and ' if branch == 'main' else ''}the {version} tag to GitHub, publish a "
           f"GitHub Release with the zip attached, and publish the site to the public host? [y/N] ").lower() == "y":
        run(*push_cmd, capture=False)
        run(*gh_cmd, capture=False)
        print(f"\nPublished {package_site.REPO_URL}/releases/tag/{version}")
        publish_to_host(zip_path, version)
    else:
        print("\nKept local. To publish later:\n  " + " ".join(push_cmd) + "\n  " + " ".join(gh_cmd)
              + f"\n  python3 release.py --publish {version}"
              + f"\nTo undo the tag instead: git tag -d {version}")


if __name__ == "__main__":
    main()
