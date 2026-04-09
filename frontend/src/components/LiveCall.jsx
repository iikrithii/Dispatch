import React, { useEffect, useRef, useState } from "react";
import { getEvents, getPreMeetingBrief } from "../services/api";
import { getAccessToken, getCurrentUser } from "../services/auth";

const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:7071/api";

function buildWebSocketUrl(sessionId) {
  const explicitUrl = process.env.REACT_APP_LIVE_WS_URL;

  if (explicitUrl) {
    const wsUrl = new URL(explicitUrl);
    wsUrl.searchParams.set("sessionId", sessionId);
    return wsUrl.toString();
  }

  const apiUrl = new URL(API_BASE);
  const wsProtocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  const wsPort = process.env.REACT_APP_LIVE_WS_PORT || "7072";
  const wsUrl = new URL(`${wsProtocol}//${apiUrl.hostname}:${wsPort}/live-session`);
  wsUrl.searchParams.set("sessionId", sessionId);
  return wsUrl.toString();
}

function toTextList(items = []) {
  return (items || [])
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") return item;
      return item.text || item.item || item.title || null;
    })
    .filter(Boolean);
}

function getLatestBatch(batches = []) {
  if (!Array.isArray(batches) || batches.length === 0) return null;
  return batches[batches.length - 1];
}

function formatTimestamp(value) {
  if (!value) return "Waiting for updates";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function LiveCall() {
  const [currentMeeting, setCurrentMeeting] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [latestBatch, setLatestBatch] = useState(null);
  const [latestInsights, setLatestInsights] = useState({});
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [statusMessage, setStatusMessage] = useState("Waiting to start a live session.");
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const isRunningRef = useRef(false);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    const storedSessionId = localStorage.getItem("activeLiveSession");
    if (!storedSessionId) return;

    setSessionId(storedSessionId);
    setIsRunning(true);
    setStatusMessage("Reconnecting to your live session...");
    void loadSessionSnapshot(storedSessionId);
    connectWebSocket(storedSessionId);

    return () => {
      cleanupRealtimeConnection();
    };
  }, []);

  useEffect(() => {
    void loadCurrentMeeting();
    const interval = setInterval(() => {
      void loadCurrentMeeting();
    }, 30000);

    return () => clearInterval(interval);
  }, [isRunning]);

  function cleanupRealtimeConnection() {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }

  async function loadCurrentMeeting() {
    try {
      const result = await getEvents();
      const events = result.events || [];
      const now = new Date();

      const ongoing = events.find((event) => {
        const startTime = new Date(event.start?.dateTime || event.start);
        const endTime = new Date(event.end?.dateTime || event.end);
        return startTime <= now && now < endTime && event.joinUrl;
      });

      if (ongoing) {
        setCurrentMeeting(ongoing);
        setError(null);
        return;
      }

      setCurrentMeeting(null);
      if (!isRunningRef.current) {
        setError("No current meeting to join");
      }
    } catch (err) {
      setError("Failed to load meeting: " + err.message);
    }
  }

  async function loadSessionSnapshot(targetSessionId, providedToken = null) {
    try {
      const token = providedToken || (await getAccessToken());
      const response = await fetch(`${API_BASE}/live-session/${targetSessionId}/batches`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        if (response.status === 404) {
          setError("Live session no longer exists.");
          setIsRunning(false);
          setSessionId(null);
          setLatestBatch(null);
          setLatestInsights({});
          localStorage.removeItem("activeLiveSession");
          cleanupRealtimeConnection();
        }
        return;
      }

      const data = await response.json();
      const latest = getLatestBatch(data.batches || []);
      if (data.liveContext?.brief) {
        setBrief(data.liveContext.brief);
      }
      if (data.latestInsights) {
        setLatestInsights(data.latestInsights);
      }
      if (latest) {
        setLatestBatch(latest);
      }
    } catch (err) {
      console.error("Failed to load live session snapshot:", err.message);
    }
  }

  function connectWebSocket(targetSessionId) {
    cleanupRealtimeConnection();

    const socket = new WebSocket(buildWebSocketUrl(targetSessionId));
    wsRef.current = socket;

    socket.onopen = () => {
      setStatusMessage("Connected. Waiting for transcript insights...");
      setError(null);
      void loadSessionSnapshot(targetSessionId);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === "batch" && message.data) {
          setLatestBatch(message.data);
          setLatestInsights((prev) => ({
            ...prev,
            ...(message.data.apis || {}),
          }));
          setStatusMessage(`Live insights updated at ${formatTimestamp(message.data.timestamp)}.`);
          return;
        }

        if (message.type === "insight" && message.insightType) {
          setLatestInsights((prev) => ({
            ...prev,
            [message.insightType]: message.data,
          }));
          if (message.insightType === "focusRecovery") {
            setStatusMessage(`Focus recovery updated at ${formatTimestamp(message.data?.timestamp || message.timestamp)}.`);
          }
          return;
        }

        if (message.type === "status") {
          setStatusMessage(message.message || "Live session update received.");
          if (message.status === "error") {
            setError(message.message || "Live session error");
          }
        }
      } catch (err) {
        console.error("Invalid WebSocket payload:", err.message);
      }
    };

    socket.onerror = () => {
      setStatusMessage("WebSocket error. Attempting to recover...");
    };

    socket.onclose = () => {
      wsRef.current = null;

      if (!isRunningRef.current || localStorage.getItem("activeLiveSession") !== targetSessionId) {
        return;
      }

      setStatusMessage("Connection lost. Reconnecting...");
      reconnectTimerRef.current = setTimeout(() => {
        connectWebSocket(targetSessionId);
      }, 2000);
    };
  }

  async function startLiveSession() {
    if (!currentMeeting?.joinUrl) {
      setError("No join URL available for this meeting");
      return;
    }

    setLoading(true);
    setError(null);
    setLatestBatch(null);
    setStatusMessage("Preparing live meeting context...");

    try {
      const [token, fetchedBrief] = await Promise.all([
        getAccessToken(),
        currentMeeting?.id ? getPreMeetingBrief(currentMeeting.id).catch(() => null) : Promise.resolve(null),
      ]);

      setBrief(fetchedBrief?.brief || null);

      const response = await fetch(`${API_BASE}/start-live-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          meetingUrl: currentMeeting.joinUrl,
          meetingContext: currentMeeting,
          brief: fetchedBrief?.brief || null,
          user: getCurrentUser(),
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to start session: ${response.statusText}`);
      }

      const data = await response.json();
      const newSessionId = data.sessionId;

      setSessionId(newSessionId);
      setIsRunning(true);
      setStatusMessage("Live session started. Connecting to real-time insights...");
      localStorage.setItem("activeLiveSession", newSessionId);

      await loadSessionSnapshot(newSessionId, token);
      connectWebSocket(newSessionId);
      window.open(currentMeeting.joinUrl, "_blank");
    } catch (err) {
      setError("Error starting session: " + err.message);
      setStatusMessage("Unable to start live session.");
    } finally {
      setLoading(false);
    }
  }

  async function stopSession() {
    if (!sessionId) return;

    try {
      const token = await getAccessToken();
      await fetch(`${API_BASE}/live-session/${sessionId}/end`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      console.error("Error stopping session:", err.message);
    }

    cleanupRealtimeConnection();
    setIsRunning(false);
    setSessionId(null);
    setLatestBatch(null);
    setLatestInsights({});
    setStatusMessage("Live session stopped.");
    localStorage.removeItem("activeLiveSession");
  }

  const transcriptLines = latestBatch?.transcripts || [];

  return (
    <div className="live-call-page" style={{ display: "flex", flexDirection: "column", height: "100%", gap: 16, padding: "var(--page-gutter)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Live Call</h2>
        <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--text-tertiary)" }}>
          Join your current meeting and get real-time AI insights
        </p>
      </div>

      {!isRunning && (
        <div style={{ padding: 12, borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
          {currentMeeting ? (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-secondary)" }}>
                Current Meeting
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: "var(--text-primary)" }}>
                {currentMeeting.subject}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
                Started at {new Date(currentMeeting.start).toLocaleTimeString()}
              </div>

              {error && (
                <div style={{ marginBottom: 12, padding: 8, background: "#fee", borderRadius: 4, fontSize: 12, color: "#c33" }}>
                  {error}
                </div>
              )}

              <button
                onClick={startLiveSession}
                disabled={loading}
                style={{
                  width: "100%",
                  padding: "10px 16px",
                  borderRadius: 6,
                  background: loading ? "var(--text-tertiary)" : "var(--accent)",
                  color: "white",
                  border: "none",
                  fontWeight: 600,
                  cursor: loading ? "default" : "pointer",
                  fontSize: 13,
                  opacity: loading ? 0.6 : 1,
                }}
              >
                {loading ? "Joining..." : "Join Meeting"}
              </button>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "20px 0", color: "var(--text-tertiary)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>No Current Meeting</div>
              <div style={{ fontSize: 11 }}>Check back when your next meeting starts</div>
            </div>
          )}
        </div>
      )}

      {isRunning && (
        <div style={{ padding: 14, borderRadius: 12, background: "#fff3f1", border: "1px solid #ffd1cb" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#f33", animation: "pulse 1s infinite" }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: "#c33" }}>Recording Active</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{currentMeeting?.subject || brief?.meetingTitle || sessionId}</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>{statusMessage}</div>
            </div>
            <button
              onClick={stopSession}
              style={{
                minWidth: 180,
                padding: "10px 14px",
                borderRadius: 8,
                background: "#f33",
                color: "white",
                border: "none",
                fontWeight: 600,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Stop Recording
            </button>
          </div>
          {error && (
            <div style={{ marginTop: 10, padding: 8, background: "#fff2f2", borderRadius: 6, fontSize: 11, color: "#c33" }}>
              {error}
            </div>
          )}
        </div>
      )}

      {isRunning && (
        <div className="live-call-grid" style={{ display: "grid", gridTemplateColumns: "1.25fr 1fr", gap: 16, flex: 1, minHeight: 0, overflow: "hidden" }}>
          <div className="live-call-primary" style={{ display: "grid", gridTemplateRows: "minmax(0, 1.35fr) minmax(0, 0.85fr)", gap: 16, minHeight: 0, overflow: "hidden" }}>
            <SectionCard
              title="Live Transcript"
              subtitle={latestBatch ? `Updated ${formatTimestamp(latestBatch.timestamp)}` : "Waiting for the first processed transcript window"}
              minHeight={220}
            >
              {transcriptLines.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {transcriptLines.map((line, index) => (
                    <div key={`${line.timestamp}-${index}`} style={{ padding: 10, borderRadius: 8, background: "#f7f8fb", border: "1px solid #e7e9f2" }}>
                      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4 }}>
                        {line.timestamp} • {line.speaker}
                      </div>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.5 }}>{line.text}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyPanel text="Transcripts will appear here once the first 10-caption window is processed." />
              )}
            </SectionCard>

            <SectionCard
              title="Meeting Context"
              subtitle="Live session context coming from your Graph-backed meeting brief"
              minHeight={180}
            >
              {brief ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {brief.currentStatus && <ContextLine label="Current status" value={brief.currentStatus} />}
                  {brief.keyContext && <ContextLine label="Key context" value={brief.keyContext} />}
                  {toTextList(brief.agenda || brief.agendaForToday || []).length > 0 && (
                    <ListBlock title="Agenda" items={toTextList(brief.agenda || brief.agendaForToday || [])} />
                  )}
                </div>
              ) : (
                <EmptyPanel text="The live session is running without a pre-call brief, so only transcript-driven insights will appear." />
              )}
            </SectionCard>
          </div>

          <div className="live-call-insights" style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16, overflowY: "auto", minHeight: 0, paddingRight: 4 }}>
            <DriftPanel data={latestInsights?.driftDetection || latestBatch?.apis?.driftDetection} />
            <FocusRecoveryPanel data={latestInsights?.focusRecovery || latestBatch?.apis?.focusRecovery} />
            <ContextWhisperPanel data={latestInsights?.contextWhisper || latestBatch?.apis?.contextWhisper} />
            <CommitmentPanel data={latestInsights?.commitmentCheck || latestBatch?.apis?.commitmentCheck} />
          </div>
        </div>
      )}

      {!isRunning && (
        <SectionCard title="Live Analysis" subtitle="Start a meeting to stream the 4 insight sections">
          <EmptyPanel text="Drift Detection, Focus Recovery, Context Whisper, and Commitment Check will appear here in a formatted UI." />
        </SectionCard>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      `}</style>
    </div>
  );
}

function SectionCard({ title, subtitle, children, minHeight = 0 }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 16,
        minHeight,
        minWidth: 0,
        overflow: "hidden",
        boxShadow: "0 10px 30px rgba(11, 18, 35, 0.04)",
      }}
    >
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>{subtitle}</div>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 4 }}>
        {children}
      </div>
    </div>
  );
}

function InsightCard({ title, tone = "neutral", children }) {
  const tones = {
    neutral: { bg: "#ffffff", border: "#e6e8ef", accent: "#334155" },
    alert: { bg: "#fff6f3", border: "#ffd8cb", accent: "#c2410c" },
    success: { bg: "#f4fbf6", border: "#cbe8d3", accent: "#166534" },
    focus: { bg: "#f5f8ff", border: "#cfdbff", accent: "#1d4ed8" },
  };

  const theme = tones[tone] || tones.neutral;

  return (
    <div style={{ background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 14, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: theme.accent, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Badge({ text, bg, color }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 8px",
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {text}
    </span>
  );
}

function EmptyPanel({ text }) {
  return <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.6 }}>{text}</div>;
}

function ContextLine({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function ListBlock({ title, items = [] }) {
  if (!items.length) return null;

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
        {items.map((item, index) => (
          <div key={`${title}-${index}`} style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.5 }}>
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function DriftPanel({ data }) {
  if (!data) {
    return (
      <InsightCard title="Drift Detection" tone="focus">
        <EmptyPanel text="Waiting for enough transcript context to evaluate agenda drift." />
      </InsightCard>
    );
  }

  if (data.error) {
    return (
      <InsightCard title="Drift Detection" tone="alert">
        <EmptyPanel text={data.error} />
      </InsightCard>
    );
  }

  const driftTone = data.driftDetected ? "alert" : "success";

  return (
    <InsightCard title="Drift Detection" tone={driftTone}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <Badge text={data.driftDetected ? "Drift Detected" : "On Agenda"} bg={data.driftDetected ? "#ffe1d6" : "#daf2df"} color={data.driftDetected ? "#c2410c" : "#166534"} />
        <Badge text={`Score ${data.driftScore ?? 0}`} bg="#eef2ff" color="#3730a3" />
        <Badge text={`Time ${data.timeRisk || "on_track"}`} bg="#f3f4f6" color="#374151" />
      </div>
      <ContextLine label="Current topic" value={data.currentTopic || "Not enough signal yet"} />
      <ContextLine label="Expected topic" value={data.expectedTopic || "No agenda mapped"} />
      {data.driftReason && <ContextLine label="Why" value={data.driftReason} />}
      {data.nudge && <ContextLine label="Suggested nudge" value={data.nudge} />}
      <ListBlock
        title="Agenda progress"
        items={(data.agendaProgress || []).map((item) => `${item.item} - ${item.status.replace("_", " ")}`)}
      />
    </InsightCard>
  );
}

function FocusRecoveryPanel({ data }) {
  if (!data) {
    return (
      <InsightCard title="Focus Recovery" tone="focus">
        <EmptyPanel text="Waiting for the first focus recovery summary." />
      </InsightCard>
    );
  }

  if (data.error) {
    return (
      <InsightCard title="Focus Recovery" tone="alert">
        <EmptyPanel text={data.error} />
      </InsightCard>
    );
  }

  return (
    <InsightCard title="Focus Recovery" tone="neutral">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <Badge text={data.directedAtUser ? "Action Needed" : "Catch-Up Ready"} bg={data.directedAtUser ? "#ffe1d6" : "#ddeafe"} color={data.directedAtUser ? "#c2410c" : "#1d4ed8"} />
      </div>
      <ContextLine label="Catch-up summary" value={data.catchUpSummary || "Nothing significant yet."} />
      <ContextLine label="Current topic" value={data.currentTopic || "Not available"} />
      {data.whatWasAsked && <ContextLine label="What was asked" value={data.whatWasAsked} />}
      {data.suggestedResponse && <ContextLine label="Suggested response" value={data.suggestedResponse} />}
      <ListBlock title="Missed decisions" items={data.missedDecisions || []} />
      <ListBlock
        title="Missed action items"
        items={(data.missedActionItems || []).map((item) => `${item.owner}: ${item.task}`)}
      />
    </InsightCard>
  );
}

function ContextWhisperPanel({ data }) {
  if (!data) {
    return (
      <InsightCard title="Context Whisper" tone="focus">
        <EmptyPanel text="Waiting for enough context to surface relevant background." />
      </InsightCard>
    );
  }

  if (data.error) {
    return (
      <InsightCard title="Context Whisper" tone="alert">
        <EmptyPanel text={data.error} />
      </InsightCard>
    );
  }

  return (
    <InsightCard title="Context Whisper" tone={data.hasContradiction ? "alert" : "neutral"}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <Badge text={data.topic || "Context"} bg="#eef2ff" color="#3730a3" />
        {data.hasContradiction && <Badge text="Contradiction flagged" bg="#ffe1d6" color="#c2410c" />}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {(data.whispers || []).length > 0 ? (
          data.whispers.map((whisper, index) => (
            <div key={`whisper-${index}`} style={{ padding: 10, borderRadius: 10, background: "#f7f8fb", border: "1px solid #e7e9f2" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" }}>
                {whisper.type}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-primary)", marginTop: 6, lineHeight: 1.5 }}>{whisper.content}</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
                {whisper.source} {whisper.relevanceReason ? `• ${whisper.relevanceReason}` : ""}
              </div>
            </div>
          ))
        ) : (
          <EmptyPanel text="No strong prior context has been surfaced yet." />
        )}
      </div>
      <ListBlock
        title="Contradictions"
        items={(data.contradictions || []).map((item) => `${item.currentStatement} | Earlier: ${item.previousAgreement}`)}
      />
    </InsightCard>
  );
}

function CommitmentPanel({ data }) {
  if (!data) {
    return (
      <InsightCard title="Commitment Check" tone="focus">
        <EmptyPanel text="Commitment analysis will appear once owners, dates, or deliverables are mentioned." />
      </InsightCard>
    );
  }

  if (data.error) {
    return (
      <InsightCard title="Commitment Check" tone="alert">
        <EmptyPanel text={data.error} />
      </InsightCard>
    );
  }

  const commitments = data.commitments || [];

  return (
    <InsightCard title="Commitment Check" tone="neutral">
      {commitments.length === 0 ? (
        <EmptyPanel text="No explicit commitments detected in the latest transcript window." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {commitments.map((commitment, index) => (
            <div key={`commitment-${index}`} style={{ padding: 12, borderRadius: 10, background: "#f8fafc", border: "1px solid #e5e7eb" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{commitment.owner}</div>
                <Badge
                  text={commitment.feasibility || "unknown"}
                  bg={feasibilityStyles(commitment.feasibility).bg}
                  color={feasibilityStyles(commitment.feasibility).color}
                />
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                "{commitment.raw}"
              </div>
              <div style={{ fontSize: 12, color: "var(--text-primary)", marginTop: 8 }}>
                Deadline: {commitment.deadlineLabel || commitment.deadline || "Not specified"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.5 }}>{commitment.reason}</div>
              <div style={{ fontSize: 12, color: "var(--text-primary)", marginTop: 8, lineHeight: 1.5 }}>
                Suggestion: {commitment.suggestion}
              </div>
              <ListBlock
                title="Conflicts"
                items={(commitment.conflicts || []).map((conflict) => `${conflict.title} - ${conflict.time}`)}
              />
            </div>
          ))}
        </div>
      )}
    </InsightCard>
  );
}

function feasibilityStyles(level) {
  switch (level) {
    case "clear":
      return { bg: "#daf2df", color: "#166534" };
    case "tight":
      return { bg: "#fff0c7", color: "#92400e" };
    case "risky":
      return { bg: "#ffe1d6", color: "#c2410c" };
    case "unrealistic":
      return { bg: "#fee2e2", color: "#b91c1c" };
    default:
      return { bg: "#e5e7eb", color: "#374151" };
  }
}

export default LiveCall;
