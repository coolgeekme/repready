"""Smoke/regression test — all six /generate/[type] routes must load without JS
runtime errors and without hitting the global ErrorBoundary.

Rationale: 1.0.9 build 110 shipped with `ReferenceError: loadAccounts is not
defined` in `frontend/app/generate/[type].tsx` that immediately dumped every
generator tile to the "Something went wrong" screen. Root cause was a stale
call to a removed helper left behind after the email-integration merge.

This script is the machine-readable canary for that regression. Run it any
time `frontend/app/generate/[type].tsx` is touched:

    cd /app/frontend/tests && /opt/plugins-venv/bin/python smoke_generate_routes.py

Exits with code 0 on pass, 1 on failure (any route logs a page error OR shows
the ErrorBoundary sentinel text).

Requires: playwright chromium installed (available at
`/opt/plugins-venv/bin/python`) and the expo dev server running on
http://localhost:3000.
"""
from __future__ import annotations

import asyncio
import json
import sys
from playwright.async_api import async_playwright

BASE_URL = "http://localhost:3000"
ROUTES = [
    "cold-email",
    "objection",
    "call-script",
    "company-intel",
    "re-engagement",
    "linkedin-post",
]
# Any of these substrings appearing in a `pageerror` event will fail the smoke
# test. Extend as new failure modes are discovered.
FATAL_MARKERS = (
    "ReferenceError",
    "is not defined",
    "is not a function",
    "Cannot read property",
    "Cannot read properties",
    "undefined is not an object",
)


async def check_route(page, route: str) -> dict:
    errors: list[str] = []

    def _on_pageerror(err):
        errors.append(str(err))

    page.on("pageerror", _on_pageerror)
    try:
        await page.goto(f"{BASE_URL}/generate/{route}", wait_until="domcontentloaded")
        await page.wait_for_selector("#root", timeout=20000)
        # Give the bundle 3.5s to hydrate — long enough for useFocusEffect /
        # useEffect callbacks to fire and throw if they're going to.
        await page.wait_for_timeout(3500)
        crashed = await page.locator("text=Something went wrong").count() > 0
        fatal = [e for e in errors if any(m in e for m in FATAL_MARKERS)]
        ok = (not crashed) and (len(fatal) == 0)
        return {
            "route": route,
            "ok": ok,
            "crashed_error_boundary": crashed,
            "fatal_errors": fatal,
            "all_errors": errors,
        }
    finally:
        page.remove_listener("pageerror", _on_pageerror)


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={"width": 390, "height": 844})
        page = await context.new_page()
        results = []
        for r in ROUTES:
            results.append(await check_route(page, r))
        await browser.close()

    print(json.dumps({"results": results}, indent=2))
    failed = [r for r in results if not r["ok"]]
    if failed:
        print(f"\nFAIL — {len(failed)}/{len(results)} generator routes crashed:",
              ", ".join(r["route"] for r in failed))
        return 1
    print(f"\nPASS — all {len(results)} generator routes render cleanly.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
