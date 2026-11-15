"""Downloads DEFRA's UK carbon footprint "figures and tables" workbook (University of Leeds data)
to data/footprint_source.ods, if gov.uk has a different file from the local copy.

    python3 fetch_footprint_source.py           # download only if changed
    python3 fetch_footprint_source.py --force   # re-download unconditionally
"""
import re
import sys
import urllib.error
from pathlib import Path

from fetch_energy_source import download, fetch, head_content_length

# Like the renewable-by-LA and DUKES pages, this statistics page is updated in place each year
# (its attachments are swapped for the new release), so there's no "find the latest release" step.
PAGE_URL = "https://www.gov.uk/government/statistics/uks-carbon-footprint"
ODS_RE = re.compile(
    r'href="(https://assets\.publishing\.service\.gov\.uk/media/[^"]+/[^"/]*figures_and_tables_dataset[^"/]*\.ods)"',
    re.IGNORECASE,
)
DEST = Path(__file__).resolve().parent / "footprint_source.ods"


def main():
    force = "--force" in sys.argv
    try:
        html = fetch(PAGE_URL)
        matches = list(dict.fromkeys(ODS_RE.findall(html)))
        if not matches:
            sys.exit(f"Could not find the figures-and-tables .ods link on {PAGE_URL} — has gov.uk changed its page structure?")
        url = matches[0]
        print(f"Source workbook: {url}")
        remote_size = head_content_length(url)
    except (urllib.error.URLError, urllib.error.HTTPError) as e:
        sys.exit(f"Could not reach gov.uk to check for updates: {e}")

    local_size = DEST.stat().st_size if DEST.exists() else None
    if not force and local_size is not None and remote_size is not None and local_size == remote_size:
        print(f"Already up to date ({DEST.name}, {local_size:,} bytes) — nothing to do.")
        return

    try:
        downloaded = download(url, DEST)
    except (urllib.error.URLError, urllib.error.HTTPError) as e:
        sys.exit(f"Download failed: {e}")
    print(f"Downloaded {downloaded:,} bytes to {DEST}")
    print("Run `python3 process.py` next to regenerate the app's data files.")


if __name__ == "__main__":
    main()
