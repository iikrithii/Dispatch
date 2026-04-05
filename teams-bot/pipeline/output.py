from datetime import datetime

class OutputHandler:
    def __init__(self, filepath: str = "transcript.txt", webhook_url: str = None):
        self.filepath = filepath
        self.webhook_url = webhook_url
        with open(self.filepath, "w", encoding="utf-8") as f:
            f.write(f"=== Transcript started: {datetime.now()} ===\n\n")
        print(f"[Output] Saving transcript to: {self.filepath}")

    def write(self, speaker: str, text: str):
        timestamp = datetime.now().strftime("%H:%M:%S")
        line = f"[{timestamp}] {speaker}: {text}\n"

        # Write and flush immediately so file updates in real-time
        with open(self.filepath, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()

        if self.webhook_url:
            try:
                import requests
                requests.post(self.webhook_url, json={"text": line}, timeout=5)
            except Exception as e:
                print(f"[Output] Webhook failed: {e}")