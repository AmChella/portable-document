#!/usr/bin/env python3
import json
import hashlib
import os
from typing import Dict, List, Optional, Set

from lxml import etree

ROOT = os.path.dirname(os.path.dirname(__file__))
XML_FILE = os.path.join(ROOT, "xml", "document.xml")
PAGE_MAP_CANDIDATES = [
    os.path.join(ROOT, "build", "master.page_map.json"),
    os.path.join(ROOT, "tex", "master.page_map.json"),
]
HASH_DB = os.path.join(ROOT, "build", "page_hashes.json")


def resolve_page_map() -> Optional[str]:
    for candidate in PAGE_MAP_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return None


def hash_content(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extract_elements(xml_file: str) -> Dict[str, str]:
    tree = etree.parse(xml_file)
    elems: Dict[str, str] = {}
    for el in tree.xpath('//*[@id]'):
        eid = el.get("id")
        if not eid:
            continue
        elems[eid] = etree.tostring(el, encoding="unicode")
    return elems


def load_hash_db() -> Dict[str, str]:
    if not os.path.exists(HASH_DB):
        return {}
    with open(HASH_DB) as fh:
        return json.load(fh)


def save_hash_db(db: Dict[str, str]) -> None:
    with open(HASH_DB, "w") as fh:
        json.dump(db, fh, indent=2)


def detect_changes() -> List[str]:
    elems = extract_elements(XML_FILE)
    prev = load_hash_db()
    new_db: Dict[str, str] = {}
    changed: List[str] = []
    for eid, content in elems.items():
        digest = hash_content(content)
        new_db[eid] = digest
        if prev.get(eid) != digest:
            changed.append(eid)
    save_hash_db(new_db)
    return changed


def pages_for_changes(changed: List[str]) -> List[int]:
    page_map_path = resolve_page_map()
    if not page_map_path:
        return []
    with open(page_map_path) as fh:
        page_map = json.load(fh)
    dirty_pages: Set[int] = set()
    for page, eids in page_map.items():
        for eid in eids:
            if eid in changed:
                dirty_pages.add(int(page))
    return sorted(dirty_pages)


def main() -> None:
    changed = detect_changes()
    if not changed:
        print("No changes detected.")
        return

    print("Changed elements:", changed)
    dirty_pages = pages_for_changes(changed)
    if dirty_pages:
        print("Dirty pages:", dirty_pages)
    else:
        print("No page map yet; run the full LaTeX compile first.")


if __name__ == "__main__":
    main()
