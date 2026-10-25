#!/usr/bin/env python3
"""Download and unpack the Argos zh<->en models used by the local engine.

The models are the exact packages LibreTranslate/Argos Translate use — this
script only fetches them without pulling in the full Argos runtime (and its
multi-gigabyte torch dependency).

Usage:
    python tools/fetch_argos_models.py [--force]

Honours the standard proxy environment variables (HTTP_PROXY / HTTPS_PROXY).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

INDEX_URL = "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json"
PAIRS = [("en", "zh"), ("zh", "en")]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(ROOT, "service", "models")
CACHE_DIR = os.path.join(ROOT, ".tmp", "model-downloads")


def log(message: str) -> None:
    print(message, flush=True)


def download(url: str, destination: str, force: bool = False) -> str:
    if os.path.exists(destination) and not force:
        size = os.path.getsize(destination)
        if size > 0:
            log(f"  cached  {os.path.basename(destination)} ({size / 1_048_576:.1f} MB)")
            return destination

    log(f"  fetch   {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "LinguaBridge/0.1"})
    with urllib.request.urlopen(request, timeout=180) as response, open(destination, "wb") as handle:
        total = int(response.headers.get("Content-Length") or 0)
        copied = 0
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            handle.write(chunk)
            copied += len(chunk)
            if total:
                percent = copied * 100 // total
                sys.stdout.write(f"\r  ...     {percent:3d}% ({copied / 1_048_576:.1f}/{total / 1_048_576:.1f} MB)")
                sys.stdout.flush()
    sys.stdout.write("\n")
    return destination


def extract(archive: str, target: str) -> None:
    if os.path.isdir(target):
        shutil.rmtree(target)
    os.makedirs(target, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(target)
    log(f"  unpack  -> {os.path.relpath(target, ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Argos en<->zh models")
    parser.add_argument("--force", action="store_true", help="re-download even when cached")
    args = parser.parse_args()

    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(MODELS_DIR, exist_ok=True)

    with tempfile.NamedTemporaryFile("wb", suffix=".json", delete=False) as temp:
        index_path = temp.name
    try:
        log(f"index   {INDEX_URL}")
        download(INDEX_URL, index_path, force=True)
        with open(index_path, "r", encoding="utf-8") as handle:
            index = json.load(handle)
    finally:
        if os.path.exists(index_path):
            os.remove(index_path)

    log(f"index entries: {len(index)}")

    missing: list[str] = []
    for source, target in PAIRS:
        entries = [item for item in index if item.get("from_code") == source and item.get("to_code") == target]
        if not entries:
            missing.append(f"{source}->{target}")
            log(f"!! no package for {source}->{target}")
            continue

        # Prefer the newest package version.
        entry = max(entries, key=lambda item: str(item.get("package_version", "0")))
        links = entry.get("links") or []
        if not links:
            missing.append(f"{source}->{target}")
            log(f"!! package {source}->{target} has no link")
            continue

        name = f"{source}_{target}"
        archive = os.path.join(CACHE_DIR, f"{name}.argosmodel")
        log(f"package {name} v{entry.get('package_version')} (argos {entry.get('argos_version')})")
        download(links[0], archive, force=args.force)
        extract(archive, os.path.join(MODELS_DIR, name))

    log("")
    log("installed models:")
    for source, target in PAIRS:
        directory = os.path.join(MODELS_DIR, f"{source}_{target}")
        if os.path.isdir(directory):
            files = sorted(os.listdir(directory))
            log(f"  {source}->{target}: {', '.join(files)}")
        else:
            log(f"  {source}->{target}: MISSING")

    if missing:
        log(f"\nERROR: missing model packages: {', '.join(missing)}")
        return 1
    log("\nOK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
