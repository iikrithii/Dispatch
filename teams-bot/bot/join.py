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

        # Step 4: Turn off mic and camera before join
        print("[Bot] Disabling microphone and camera...")
        await asyncio.sleep(1)
        
        # Try multiple selectors to find and disable microphone
        mic_selectors = [
            "button[aria-label*='Unmute microphone'][aria-pressed='true']",
            "button[aria-label*='Mute microphone'][aria-pressed='false']",
            "button[title*='microphone']",
            "button[data-tid='toggle-video-button'][aria-pressed='true']",
            "[aria-label*='Microphone']",
        ]
        
        for selector in mic_selectors:
            try:
                elements = await page.query_selector_all(selector)
                for el in elements:
                    aria_pressed = await el.get_attribute("aria-pressed")
                    aria_label = await el.get_attribute("aria-label")
                    if aria_pressed == "true" and "microphone" in (aria_label or "").lower():
                        await el.click()
                        print(f"[Bot] ✅ Microphone muted")
                        break
            except Exception:
                continue
        
        await asyncio.sleep(1)

        # Try to turn off camera
        camera_selectors = [
            "button[aria-label*='Turn off camera'][aria-pressed='true']",
            "button[aria-label*='Stop camera'][aria-pressed='true']",
        ]
        
        for selector in camera_selectors:
            try:
                elements = await page.query_selector_all(selector)
                for el in elements:
                    await el.click()
                    print(f"[Bot] ✅ Camera turned off")
                    break
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
        print("[Bot] Attempting to enable live captions...")
        await asyncio.sleep(3)  # Give meeting time to fully load
        
        try:
            caption_enabled = False
            
            # Try direct keyboard shortcut first (Ctrl+Alt+C is common in Teams)
            print("[Bot] Trying Ctrl+Alt+C keyboard shortcut...")
            await page.keyboard.press("Control+Alt+KeyC")
            await asyncio.sleep(2)
            caption_enabled = True
            print("[Bot] ✅ Live captions enabled via keyboard!")
            
        except Exception as e:
            print(f"[Bot] Keyboard shortcut failed: {e}")
            
            try:
                # Fallback: Try clicking the meeting controls area and finding the menu
                print("[Bot] Trying via meeting controls menu...")
                
                # First, try to find and click any "More" or "..." button
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.2)
                await page.keyboard.press("Tab")
                await asyncio.sleep(0.2)
                
                # Try pressing menu key or finding the button via JavaScript
                buttons = await page.query_selector_all("button[role='button']")
                print(f"[Bot] Found {len(buttons)} buttons on page")
                
                for btn in buttons:
                    aria_label = await btn.get_attribute("aria-label")
                    title = await btn.get_attribute("title")
                    
                    # Look for more options button
                    if aria_label and ("more" in aria_label.lower() or "..." in aria_label):
                        await btn.click()
                        print(f"[Bot] Clicked button: {aria_label}")
                        await asyncio.sleep(1)
                        
                        # Now look for captions in the menu
                        menu_items = await page.query_selector_all("[role='menuitem'], [role='option']")
                        for item in menu_items:
                            text = await item.text_content()
                            if text and ("caption" in text.lower() or "transcript" in text.lower() or "language" in text.lower()):
                                await item.click()
                                print(f"[Bot] Clicked menu item: {text}")
                                await asyncio.sleep(1)
                                
                                # Look for the enable button
                                enable_items = await page.query_selector_all("button, [role='menuitem']")
                                for enable_item in enable_items:
                                    enable_text = await enable_item.text_content()
                                    if enable_text and ("turn on" in enable_text.lower() or "enable" in enable_text.lower()):
                                        await enable_item.click()
                                        print(f"[Bot] Clicked: {enable_text}")
                                        await asyncio.sleep(2)
                                        caption_enabled = True
                                        break
                                break
                        break
                
                if caption_enabled:
                    print("[Bot] ✅ Live captions enabled!")
                else:
                    print("[Bot] ⚠️  Could not auto-enable captions")
                    print("[Bot] Please manually enable: '...' → Language and speech → Turn on live captions")
            
            except Exception as e2:
                print(f"[Bot] Menu approach failed: {e2}")
                print("[Bot] ⚠️  Please manually enable captions")
                print("[Bot] Steps: Click '...' → Language and speech → Turn on live captions")

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
            if hasattr(output, "flush"):
                try:
                    output.flush()
                except Exception as err:
                    print(f"[Bot] Failed to flush transcript batch: {err}")
            print("[Bot] Closing browser...")
            try:
                await browser.close()
            except Exception:
                pass