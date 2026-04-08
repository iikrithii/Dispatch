// services/liveSessionService.js
// Watches transcript files, batches captions, calls AI APIs, and streams results.

const fs = require("fs");
const wsManager = require("./wsManager");

function parseTranscriptLine(line) {
  const regex = /^\[(\d{2}:\d{2}:\d{2})\]\s+(.+?):\s+(.+)$/;
  const match = line.match(regex);
  if (!match) return null;

  return {
    timestamp: match[1],
    speaker: match[2],
    text: match[3],
  };
}

function normalizeApiBaseUrl(backendUrl) {
  if (!backendUrl) {
    return "http://localhost:7071/api";
  }

  const trimmed = backendUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

async function callApi(url, transcript, extraData = {}) {
  const payload = {
    transcript,
    ...extraData,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawBody = await response.text();
    let parsedBody = {};

    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      parsedBody = rawBody ? { raw: rawBody } : {};
    }

    if (!response.ok) {
      return {
        error: `API error ${response.status}`,
        status: response.status,
        details: parsedBody,
      };
    }

    return parsedBody;
  } catch (err) {
    return { error: err.message };
  }
}

function extractTranscriptEntries(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseTranscriptLine)
    .filter(Boolean);
}

function watchLiveTranscript(transcriptPath, sessionId, config = {}) {
  const {
    batchSize = 10,
    focusRecoveryBatchSize = 5,
    backendUrl = "http://localhost:7071",
    userName = "Sanjeev",
    liveContext = null,
    onBatch = null,
    onInsight = null,
    onError = null,
  } = config;

  const apiBaseUrl = normalizeApiBaseUrl(backendUrl);

  if (!fs.existsSync(transcriptPath)) {
    fs.writeFileSync(transcriptPath, "", "utf-8");
  }

  let processedTranscriptCount = 0;
  let processedBatchCount = 0;
  let collectedLines = [];
  let recentLines = [];
  let focusRecoveryPendingCount = 0;
  let latestFocusRecovery = null;
  let isProcessing = false;
  let stopped = false;

  const processFocusRecovery = async (windowLines) => {
    if (!windowLines.length) return;

    const transcriptText = windowLines.map((t) => `${t.speaker}: ${t.text}`).join("\n");
    const focusResult = await callApi(`${apiBaseUrl}/focus-recovery`, transcriptText, {
      userName,
      liveContext,
    });

    latestFocusRecovery = {
      ...focusResult,
      transcriptSize: windowLines.length,
      timestamp: new Date().toISOString(),
    };

    wsManager.broadcastInsight(sessionId, "focusRecovery", latestFocusRecovery);

    if (typeof onInsight === "function") {
      onInsight("focusRecovery", latestFocusRecovery);
    }
  };

  const processBatch = async (batch) => {
    const transcriptText = batch.map((t) => `${t.speaker}: ${t.text}`).join("\n");
    processedBatchCount += 1;
    const batchNumber = processedBatchCount;

    wsManager.broadcastStatus(
      sessionId,
      "processing",
      `Processing batch ${batchNumber} with ${batch.length} captions...`,
      { batchNumber }
    );

    try {
      const [driftResult, contextResult, commitmentResult] = await Promise.all([
        callApi(`${apiBaseUrl}/drift-detection`, transcriptText, { liveContext }),
        callApi(`${apiBaseUrl}/context-whisper`, transcriptText, { liveContext }),
        callApi(`${apiBaseUrl}/commitment-check`, transcriptText, { liveContext }),
      ]);

      const resultBatch = {
        sessionId,
        batchNumber,
        transcriptSize: batch.length,
        timestamp: new Date().toISOString(),
        transcripts: batch,
        apis: {
          driftDetection: driftResult,
          focusRecovery: latestFocusRecovery,
          contextWhisper: contextResult,
          commitmentCheck: commitmentResult,
        },
      };

      wsManager.broadcastBatch(sessionId, resultBatch);

      if (typeof onBatch === "function") {
        onBatch(resultBatch);
      }
    } catch (err) {
      wsManager.broadcastStatus(sessionId, "error", `API error: ${err.message}`);
      if (typeof onError === "function") {
        onError(err, batch);
      }
    }
  };

  const processFile = async () => {
    if (stopped || isProcessing) return;
    isProcessing = true;

    try {
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const transcriptEntries = extractTranscriptEntries(content);
      const newEntries = transcriptEntries.slice(processedTranscriptCount);

      if (newEntries.length === 0) {
        return;
      }

      processedTranscriptCount = transcriptEntries.length;
      collectedLines.push(...newEntries);
      recentLines.push(...newEntries);
      focusRecoveryPendingCount += newEntries.length;

      if (recentLines.length > Math.max(batchSize * 3, focusRecoveryBatchSize * 4)) {
        recentLines = recentLines.slice(-Math.max(batchSize * 2, focusRecoveryBatchSize * 2));
      }

      while (focusRecoveryPendingCount >= focusRecoveryBatchSize) {
        const focusWindow = recentLines.slice(-focusRecoveryBatchSize);
        await processFocusRecovery(focusWindow);
        focusRecoveryPendingCount -= focusRecoveryBatchSize;
      }

      while (collectedLines.length >= batchSize) {
        const batch = collectedLines.splice(0, batchSize);
        await processBatch(batch);
      }
    } catch (err) {
      wsManager.broadcastStatus(sessionId, "error", `Transcript read error: ${err.message}`);
      if (typeof onError === "function") {
        onError(err);
      }
    } finally {
      isProcessing = false;
    }
  };

  const watcher = fs.watch(transcriptPath, (eventType) => {
    if (eventType !== "change" && eventType !== "rename") {
      return;
    }
    void processFile();
  });

  wsManager.broadcastStatus(sessionId, "listening", "Listening for transcript batches...");
  void processFile();

  return {
    stop() {
      stopped = true;
      watcher.close();
    },
  };
}

module.exports = {
  watchLiveTranscript,
  parseTranscriptLine,
  callApi,
};
