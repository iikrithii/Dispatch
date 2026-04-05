import warnings
warnings.filterwarnings("ignore")

import asyncio
import sys

import config
from bot.join import join_teams_meeting
from pipeline.output import OutputHandler

async def main():
    """Simple main: just join meeting and scrape captions."""
    
    # Create output handler for writing transcripts
    output = OutputHandler(
        filepath=config.OUTPUT_FILE, 
        webhook_url=config.WEBHOOK_URL
    )
    
    print("[Main] Starting Teams bot with caption scraper...")
    print(f"[Main] Meeting URL: {config.MEETING_URL}")
    print(f"[Main] Bot name: {config.BOT_NAME}")
    print(f"[Main] Output file: {config.OUTPUT_FILE}")
    
    # Join Teams meeting and start scraping captions
    # Caption scraper will extract speaker names + transcripts from Teams UI
    await join_teams_meeting(config.MEETING_URL, config.BOT_NAME, output)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Main] Stopped. Transcript saved to transcript.txt")
        sys.exit(0)