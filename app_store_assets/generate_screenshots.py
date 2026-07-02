"""Generate App Store screenshots for SalesReady - v3 (simplified & robust).

Removes company-creation step that was causing navigation loss (it navigates
into a subroute where the tab bar disappears). Sticks to the flows that work:
sign-up → home → settings profile → settings legal → home → cold email → result → library.
"""
import asyncio
import time
from pathlib import Path
from playwright.async_api import async_playwright, Page

APP_URL = "http://localhost:3000"
OUT = Path("/app/app_store_assets/screenshots")
OUT.mkdir(parents=True, exist_ok=True)

VIEWPORT = {"width": 430, "height": 932}
DPR = 3.0


async def wait_ready(page: Page):
    await page.wait_for_function(
        "document.getElementById('root') && document.getElementById('root').innerText.trim().length > 0",
        timeout=60000,
    )
    await page.wait_for_timeout(1500)


async def shoot(page: Page, name: str):
    path = OUT / f"{name}.png"
    await page.screenshot(path=str(path), full_page=False, type="png")
    print(f"  saved: {path.name}")


async def click_text(page: Page, text: str, timeout: int = 5000, exact: bool = True) -> bool:
    try:
        await page.get_by_text(text, exact=exact).first.click(timeout=timeout)
        return True
    except Exception as e:
        print(f"  ! click_text('{text}') failed: {type(e).__name__}")
        return False


async def click_testid(page: Page, tid: str, timeout: int = 5000) -> bool:
    try:
        await page.locator(f'[data-testid="{tid}"]').first.click(timeout=timeout)
        return True
    except Exception:
        return False


async def fill_testid(page: Page, tid: str, value: str, timeout: int = 5000) -> bool:
    try:
        await page.locator(f'[data-testid="{tid}"]').first.fill(value, timeout=timeout)
        return True
    except Exception:
        return False


async def go_tab(page: Page, tab_label: str) -> bool:
    for locator in (
        page.get_by_role("button", name=tab_label),
        page.get_by_text(tab_label, exact=True),
    ):
        try:
            await locator.first.click(timeout=3000)
            await page.wait_for_timeout(1200)
            return True
        except Exception:
            continue
    print(f"  ! tab '{tab_label}' not clickable")
    return False


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport=VIEWPORT,
            device_scale_factor=DPR,
            is_mobile=True,
            has_touch=True,
            user_agent=(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
            ),
        )
        page = await ctx.new_page()
        await page.goto(APP_URL, wait_until="domcontentloaded", timeout=60000)
        await wait_ready(page)

        # ============ 1. Sign in screen ============
        await shoot(page, "01_sign_in")

        # ============ Sign up as fresh user ============
        await click_testid(page, "signin-signup-link")
        await page.wait_for_timeout(800)
        ts = int(time.time())
        email = f"showcase+{ts}@salesready.app"
        await fill_testid(page, "signup-name-input", "Alex Rivera")
        await fill_testid(page, "signup-email-input", email)
        await fill_testid(page, "signup-password-input", "AppStore2026!")
        await page.wait_for_timeout(300)
        await click_testid(page, "signup-submit-button")

        try:
            await page.wait_for_url("**/(tabs)**", timeout=15000)
        except Exception:
            pass
        await wait_ready(page)
        await page.wait_for_timeout(3500)

        # ============ 2. Home / Generators (fresh user, no role set) ============
        # This IS a nice App Store shot because it prominently features the "Today's Focus" card.
        await shoot(page, "02_home_generators")

        # ============ Go to Settings, pick role + industry + audience ============
        await go_tab(page, "Settings")
        await page.wait_for_timeout(2500)

        await click_text(page, "AE")
        await page.wait_for_timeout(400)
        await click_text(page, "SaaS")
        await page.wait_for_timeout(400)
        try:
            await page.get_by_placeholder("VPs of Engineering at mid-market SaaS").first.fill(
                "Heads of Growth at Series-B B2B SaaS ($20-50M ARR)"
            )
        except Exception:
            pass
        # Fill brand voice textarea
        try:
            tas = page.locator("textarea")
            n = await tas.count()
            if n >= 1:
                await tas.nth(0).fill(
                    "Direct, evidence-backed, no fluff. Reference measurable outcomes. Sign off with first name only."
                )
        except Exception:
            pass
        await page.wait_for_timeout(700)

        # ============ 3. Settings — profile view (top of screen) ============
        await page.mouse.wheel(0, -5000)
        await page.wait_for_timeout(500)
        await shoot(page, "03_settings_profile")

        # ============ 4. Settings — Legal & Support (scroll to bottom) ============
        await page.mouse.wheel(0, 3000)
        await page.wait_for_timeout(500)
        await page.mouse.wheel(0, 1500)
        await page.wait_for_timeout(700)
        await shoot(page, "04_settings_legal_support")

        # Reset scroll
        await page.mouse.wheel(0, -8000)
        await page.wait_for_timeout(400)

        # ============ Back to Home ============
        await go_tab(page, "Home")
        await page.wait_for_timeout(2500)

        # ============ Tap Cold Email generator ============
        await click_text(page, "Cold Email")
        await page.wait_for_timeout(2500)
        # ============ 5. Generator input ============
        await shoot(page, "05_generator_input")

        # Fill in the Your Pitch textarea (most impactful placeholder)
        try:
            await page.get_by_placeholder("We help teams cut onboarding time by 40%", exact=False).first.fill(
                "Northstar unifies product usage + CRM signals into a single revenue-intent score. "
                "Series-B SaaS Growth teams use it to cut CAC by ~22% and prioritize the accounts most likely to close."
            )
        except Exception:
            pass
        await page.wait_for_timeout(400)

        # Tap Generate
        for label in ("Generate", "Generate cold email"):
            if await click_text(page, label, exact=False, timeout=2500):
                break

        # Wait for AI (Claude 3.5 sonnet ~15-40s for 3 variations)
        await page.wait_for_timeout(45000)

        # Scroll down to reveal the result body
        await page.mouse.wheel(0, 1400)
        await page.wait_for_timeout(700)
        # ============ 6. Generator result ============
        await shoot(page, "06_generator_result")

        # ============ Go back to (tabs) then Library ============
        # Header back button in generator screen
        try:
            await page.get_by_role("button", name="Back").first.click(timeout=3000)
            await page.wait_for_timeout(1800)
        except Exception:
            try:
                await page.go_back(timeout=5000)
                await page.wait_for_timeout(1800)
            except Exception:
                pass
        await go_tab(page, "Library")
        await page.wait_for_timeout(3500)
        # ============ 7. Library history ============
        await shoot(page, "07_library_history")

        await browser.close()
    print("Done. Screenshots at:", OUT)


if __name__ == "__main__":
    asyncio.run(main())
