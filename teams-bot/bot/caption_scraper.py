import asyncio
from pipeline.output import OutputHandler

class CaptionScraper:
    """Scrape real-time captions from Teams meeting UI."""
    
    def __init__(self, page, output: OutputHandler):
        self.page = page
        self.output = output
        self.processed_captions = set()  # Track to avoid duplicates
        self.running = False

    async def start(self):
        """Start monitoring Teams captions."""
        self.running = True
        print("[Captions] 🎙️ Watching Teams live captions...")
        print("[Captions] (Make sure 'Live captions' are enabled in the meeting)")

        while self.running:
            try:
                await self._scrape_captions()
            except Exception as e:
                pass
            await asyncio.sleep(0.3)  # Check every 300ms

    async def _scrape_captions(self):
        """Extract speaker name and caption text from Teams captions."""
        try:
            # Find all caption containers - each one contains speaker and text
            caption_boxes = await self.page.locator("[class*='ChatMessageCompact']").all()
            
            if not caption_boxes:
                return
            
            # Process captions (newest ones last in DOM so reversed)
            for box in reversed(caption_boxes[-40:]):  # Check last 40
                try:
                    # Extract speaker name from data-tid="author"
                    author_locator = box.locator("[data-tid='author']")
                    author_count = await author_locator.count()
                    
                    if author_count == 0:
                        continue
                        
                    speaker_name = await author_locator.first.inner_text()
                    speaker_name = speaker_name.strip() if speaker_name else None
                    
                    # Extract caption text from data-tid="closed-caption-text"
                    text_locator = box.locator("[data-tid='closed-caption-text']")
                    text_count = await text_locator.count()
                    
                    if text_count == 0:
                        continue
                        
                    caption_text = await text_locator.first.inner_text()
                    caption_text = caption_text.strip() if caption_text else None
                    
                    # Only process if we have both speaker and caption
                    if speaker_name and caption_text:
                        # Create unique ID to prevent duplicates
                        caption_id = f"{speaker_name}||{caption_text}"
                        
                        # Only process if we haven't seen this caption before
                        if caption_id not in self.processed_captions:
                            self.processed_captions.add(caption_id)
                            print(f"[Transcript] {speaker_name}: {caption_text}")
                            self.output.write(speaker_name, caption_text)
                
                except Exception as e:
                    # Skip this caption on error
                    pass
        except Exception as e:
            pass

    def stop(self):
        """Stop monitoring captions."""
        self.running = False
        print("[Captions] Stopped.")
