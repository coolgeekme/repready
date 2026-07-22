"""Generate the 6 App Store screenshots the user requested.

Outputs at 1290x2796 (iPhone 6.7") into /app/app_store_assets/screenshots/user_request/.
Signs up as a fresh user, sets AE + SaaS profile, then walks through each generator.
"""
import asyncio
import time
from pathlib import Path
from playwright.async_api import async_playwright, Page

APP_URL = "http://localhost:3000"
OUT = Path("/app/app_store_assets/screenshots/user_request")
OUT.mkdir(parents=True, exist_ok=True)

VIEWPORT = {"width": 430, "height": 932}
DPR = 3.0


async def wait_ready(page: Page):
    await page.wait_for_function(
        "document.getElementById('root') && document.getElementById('root').innerText.trim().length > 0",
        timeout=60000,
    )
    await page.wait_for_timeout(1200)


async def shoot(page: Page, name: str):
    p = OUT / f"{name}.png"
    await page.screenshot(path=str(p), full_page=False, type="png")
    print(f"  saved: {p.name} ({p.stat().st_size // 1024} KB)")


async def click_text(page: Page, text: str, exact: bool = True, timeout: int = 4000) -> bool:
    try:
        await page.get_by_text(text, exact=exact).first.click(timeout=timeout)
        return True
    except Exception:
        print(f"  ! click_text('{text}') failed")
        return False


async def click_testid(page: Page, tid: str, timeout: int = 4000) -> bool:
    try:
        await page.locator(f'[data-testid="{tid}"]').first.click(timeout=timeout)
        return True
    except Exception:
        return False


async def fill_testid(page: Page, tid: str, value: str, timeout: int = 4000) -> bool:
    try:
        await page.locator(f'[data-testid="{tid}"]').first.fill(value, timeout=timeout)
        return True
    except Exception:
        return False


async def go_tab(page: Page, label: str) -> bool:
    for loc in (page.get_by_role("button", name=label), page.get_by_text(label, exact=True)):
        try:
            await loc.first.click(timeout=3000)
            await page.wait_for_timeout(1000)
            return True
        except Exception:
            continue
    return False


async def go_back_via_header(page: Page) -> bool:
    for _ in range(2):
        try:
            await page.get_by_role("button", name="Back").first.click(timeout=2500)
            await page.wait_for_timeout(1200)
            return True
        except Exception:
            try:
                await page.go_back(timeout=3000)
                await page.wait_for_timeout(1200)
                return True
            except Exception:
                pass
    return False


async def fill_first_textarea(page: Page, value: str) -> bool:
    try:
        tas = page.locator("textarea")
        n = await tas.count()
        if n >= 1:
            await tas.nth(0).fill(value)
            return True
    except Exception:
        pass
    # Fallback: first TextInput
    try:
        await page.locator("input[type='text']").first.fill(value)
        return True
    except Exception:
        return False


async def tap_generate(page: Page) -> bool:
    for label in ("Generate cold email", "Generate objections", "Generate call script",
                  "Generate personalization", "Generate follow-ups", "Generate", "Generate post"):
        try:
            await page.get_by_text(label, exact=False).first.click(timeout=1800)
            return True
        except Exception:
            continue
    return False


async def open_generator_from_home(page: Page, card_label: str):
    await go_tab(page, "Home")
    await page.wait_for_timeout(1500)
    await click_text(page, card_label)
    await page.wait_for_timeout(2200)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport=VIEWPORT, device_scale_factor=DPR, is_mobile=True, has_touch=True,
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        )
        page = await ctx.new_page()
        await page.goto(APP_URL, wait_until="domcontentloaded", timeout=60000)
        await wait_ready(page)

        # Sign up
        await click_testid(page, "signin-signup-link")
        await page.wait_for_timeout(800)
        ts = int(time.time())
        await fill_testid(page, "signup-name-input", "Alex Rivera")
        await fill_testid(page, "signup-email-input", f"showcase+{ts}@salesready.app")
        await fill_testid(page, "signup-password-input", "AppStore2026!")
        await click_testid(page, "signup-submit-button")
        try:
            await page.wait_for_url("**/(tabs)**", timeout=15000)
        except Exception:
            pass
        await wait_ready(page)
        await page.wait_for_timeout(3000)

        # Set profile: AE + SaaS + audience
        await go_tab(page, "Settings")
        await page.wait_for_timeout(1800)
        await click_text(page, "AE"); await page.wait_for_timeout(300)
        await click_text(page, "SaaS"); await page.wait_for_timeout(300)
        try:
            await page.get_by_placeholder("VPs of Engineering at mid-market SaaS").first.fill(
                "Heads of Growth at Series-B B2B SaaS ($20-50M ARR)"
            )
        except Exception:
            pass
        await page.wait_for_timeout(500)

        # === 1. Home / tool selection ===
        await go_tab(page, "Home")
        await page.wait_for_timeout(2500)
        await shoot(page, "01_home_tools")

        # === 2. Cold Email result ===
        await open_generator_from_home(page, "Cold Email")
        await fill_first_textarea(page,
            "Head of Growth at a Series-B B2B SaaS. Struggles with rising CAC and reps chasing "
            "the wrong accounts. We help them cut CAC by ~22% by scoring product-usage + CRM signals."
        )
        await page.wait_for_timeout(400)
        await tap_generate(page)
        await page.wait_for_timeout(38000)
        await page.mouse.wheel(0, 900)
        await page.wait_for_timeout(600)
        await shoot(page, "02_cold_email_result")
        await go_back_via_header(page)

        # === 3. Objection Handling result ===
        await open_generator_from_home(page, "Objection")
        await fill_first_textarea(page, "We already use HubSpot for this — I don't see why we'd need another tool.")
        await page.wait_for_timeout(400)
        await tap_generate(page)
        await page.wait_for_timeout(38000)
        await page.mouse.wheel(0, 900)
        await page.wait_for_timeout(600)
        await shoot(page, "03_objection_result")
        await go_back_via_header(page)

        # === 4. Call preparation screen ===
        await open_generator_from_home(page, "Call Script")
        await fill_first_textarea(page, "Discovery call with the VP of Growth at Northstar Analytics.")
        await page.wait_for_timeout(400)
        # Screen ≠ result — capture BEFORE hitting generate so we show the input form
        await shoot(page, "04_call_prep_screen")
        await go_back_via_header(page)

        # === 5. Company Intel screen ===
        await open_generator_from_home(page, "Company Intel")
        await fill_first_textarea(page, "Northstar Analytics — data platform recently raised Series B, hiring heavily on Growth.")
        await page.wait_for_timeout(400)
        await shoot(page, "05_company_intel_screen")
        await go_back_via_header(page)

        # === 6. Re-Engagement result ===
        await open_generator_from_home(page, "Re-Engage")
        await fill_first_textarea(page,
            "Prospect went dark after a demo 60 days ago. They liked the intent-scoring feature but had "
            "budget frozen till Q3."
        )
        await page.wait_for_timeout(400)
        await tap_generate(page)
        await page.wait_for_timeout(38000)
        await page.mouse.wheel(0, 900)
        await page.wait_for_timeout(600)
        await shoot(page, "06_reengagement_result")

        await browser.close()
    print("Done ->", OUT)


if __name__ == "__main__":
    asyncio.run(main())
