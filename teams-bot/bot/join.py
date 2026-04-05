import asyncio
from playwright.async_api import async_playwright
from bot.caption_scraper import CaptionScraper

async def join_teams_meeting(url: str, bot_name: str, output=None):
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=[
                "--use-fake-ui-for-media-stream",
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--autoplay-policy=no-user-gesture-required",
            ]
        )

        context = await browser.new_context(
            permissions=["microphone", "camera"],
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        )

        page = await context.new_page()
        await page.add_init_script("window.open = () => null;")

        print("[Bot] Navigating to meeting URL...")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(4)

        # Step 1: Dismiss popup
        for btn_text in ["Cancel", "Stay here", "Continue on this browser", "Join on the web"]:
            try:
                await page.click(f"text={btn_text}", timeout=3000)
                print(f"[Bot] Dismissed popup: '{btn_text}'")
                await asyncio.sleep(1)
                break
            except Exception:
                continue

        await asyncio.sleep(2)

        # Step 2: Click join button
        for btn_text in ["Join now", "Join meeting", "Join", "Continue"]:
            try:
                await page.click(f"text={btn_text}", timeout=4000)
                print(f"[Bot] Clicked: '{btn_text}'")
                break
            except Exception:
                continue

        await asyncio.sleep(3)

        # Step 3: Enter name if prompted
        for selector in [
            "input[placeholder*='name']",
            "input[placeholder*='Name']",
            "input[placeholder*='Your name']",
            "input[type='text']",
        ]:
            try:
                el = page.locator(selector).first
                await el.wait_for(state="visible", timeout=3000)
                await el.fill(bot_name)
                print(f"[Bot] Entered name: {bot_name}")
                await asyncio.sleep(1)
                break
            except Exception:
                continue

        # Step 4: Turn off mic and camera
        for label in ["Mute microphone", "Mute", "Turn off camera", "Camera"]:
            try:
                btn = page.locator(f"[aria-label*='{label}']").first
                state = await btn.get_attribute("aria-pressed", timeout=2000)
                if state == "true":
                    await btn.click()
                    print(f"[Bot] Turned off: {label}")
            except Exception:
                continue

        await asyncio.sleep(1)

        # Step 5: Final join
        for join_text in ["Join now", "Join meeting", "Join", "Enter"]:
            try:
                await page.click(f"text={join_text}", timeout=4000)
                print(f"[Bot] Final join: '{join_text}'")
                break
            except Exception:
                continue

        print("[Bot] [OK] Inside meeting - listening. Press Ctrl+C to stop.")

        # Step 6: Enable live captions automatically
        try:
            print("[Bot] Attempting to enable live captions...")
            
            # Wait for menu to be available
            await asyncio.sleep(2)
            
            # Click "More options" (three dots)
            more_buttons = [
                "[aria-label*='More']",
                "[aria-label*='More options']",
                "[role='button'][aria-label*='more']",
                "button[title*='More']",
            ]
            
            caption_enabled = False
            for btn_sel in more_buttons:
                try:
                    await page.click(btn_sel, timeout=2000)
                    print("[Bot] Clicked More options")
                    await asyncio.sleep(1)
                    break
                except Exception:
                    continue
            
            # Click "Language and speech"
            try:
                await page.click("text=Language and speech", timeout=2000)
                print("[Bot] Found Language and speech")
                await asyncio.sleep(1)
            except Exception:
                pass
            
            # Click "Turn on live captions"
            try:
                await page.click("text=Turn on live captions", timeout=2000)
                print("[Bot] ✅ Live captions enabled!")
                caption_enabled = True
                await asyncio.sleep(2)
            except Exception:
                print("[Bot] ⚠️  Could not auto-enable captions")
                print("[Bot] Please manually enable: '...' → Language and speech → Turn on live captions")
        
        except Exception as e:
            print(f"[Bot] Error enabling captions: {e}")

        # Step 7: Start scraping captions
        print("[Bot] Starting caption scraper...")
        scraper = CaptionScraper(page, output)
        scraper_task = asyncio.create_task(scraper.start())

        # Step 8: Keep alive — NEVER exit unless page crashes or Ctrl+C
        try:
            while True:
                await asyncio.sleep(10)
                # Check if page is still alive
                try:
                    await page.title()  # will throw if page crashed
                except Exception:
                    print("[Bot] Page crashed — exiting")
                    break
        except asyncio.CancelledError:
            pass
        except KeyboardInterrupt:
            pass
        finally:
            print("[Bot] Stopping caption scraper...")
            scraper.stop()
            print("[Bot] Closing browser...")
            try:
                await browser.close()
            except Exception:
                pass