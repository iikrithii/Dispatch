import json
import urllib.error
import urllib.request
from datetime import datetime

class OutputHandler:
    def __init__(self, filepath: str = "transcript.txt", webhook_url: str = None, backend_url: str = None, batch_size: int = 10, focus_recovery_batch_size: int = 5, user_name: str = "Sanjeev"):
        self.filepath = filepath
        self.webhook_url = webhook_url
        self.backend_url = backend_url.rstrip("/") if backend_url else None
        self.batch_size = batch_size
        self.focus_recovery_batch_size = focus_recovery_batch_size
        self.user_name = user_name
        self.batch_buffer = []
        self.focus_recovery_buffer = []
        self.focus_recovery_counter = 0

        with open(self.filepath, "w", encoding="utf-8") as f:
            f.write(f"=== Transcript started: {datetime.now()} ===\n\n")
        print(f"[Output] Saving transcript to: {self.filepath}")
        if self.backend_url:
            print(f"[Output] Backend integration enabled: {self.backend_url}")
            print(f"[Output] Main batch size: {self.batch_size}, Focus recovery batch size: {self.focus_recovery_batch_size}")

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

        if self.backend_url:
            self.batch_buffer.append(line.strip())
            self.focus_recovery_buffer.append(line.strip())
            self.focus_recovery_counter += 1
            
            if len(self.batch_buffer) >= self.batch_size:
                batch_transcript = "\n".join(self.batch_buffer)
                self.batch_buffer = []
                self._send_batch(batch_transcript, include_focus_recovery=False)
            
            if self.focus_recovery_counter >= self.focus_recovery_batch_size:
                focus_transcript = "\n".join(self.focus_recovery_buffer)
                self.focus_recovery_buffer = []
                self.focus_recovery_counter = 0
                self._send_focus_recovery(focus_transcript)

    def flush(self):
        if self.backend_url:
            if self.batch_buffer:
                batch_transcript = "\n".join(self.batch_buffer)
                self.batch_buffer = []
                self._send_batch(batch_transcript, include_focus_recovery=False)
            if self.focus_recovery_buffer:
                focus_transcript = "\n".join(self.focus_recovery_buffer)
                self.focus_recovery_buffer = []
                self.focus_recovery_counter = 0
                self._send_focus_recovery(focus_transcript)

    def _send_batch(self, transcript: str, include_focus_recovery: bool = True):
        endpoints = [
            ("context-whisper", {"transcript": transcript}),
            ("drift-detection", {"transcript": transcript}),
            ("commitment-check", {"transcript": transcript}),
        ]
        
        if include_focus_recovery:
            endpoints.append(("focus-recovery", {"transcript": transcript, "userName": self.user_name}))

        for route, payload in endpoints:
            url = f"{self.backend_url}/api/{route}"
            data = json.dumps(payload).encode("utf-8")
            request = urllib.request.Request(
                url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    status = response.getcode()
                    body = response.read().decode("utf-8")
                    if status == 200:
                        print(f"[Output] Sent batch to {route} successfully.")
                    else:
                        print(f"[Output] Backend {route} returned {status}: {body}")
            except urllib.error.HTTPError as err:
                message = err.read().decode("utf-8") if err.fp else err.reason
                print(f"[Output] HTTP error posting to {route}: {err.code} - {message}")
            except Exception as err:
                print(f"[Output] Failed to post batch to {route}: {err}")

    def _send_focus_recovery(self, transcript: str):
        route = "focus-recovery"
        payload = {"transcript": transcript, "userName": self.user_name}
        url = f"{self.backend_url}/api/{route}"
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status = response.getcode()
                body = response.read().decode("utf-8")
                if status == 200:
                    print(f"[Output] Sent focus recovery batch successfully.")
                else:
                    print(f"[Output] Backend focus-recovery returned {status}: {body}")
        except urllib.error.HTTPError as err:
            message = err.read().decode("utf-8") if err.fp else err.reason
            print(f"[Output] HTTP error posting to focus-recovery: {err.code} - {message}")
        except Exception as err:
            print(f"[Output] Failed to post batch to focus-recovery: {err}")