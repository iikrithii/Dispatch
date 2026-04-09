// src/components/DailyTodos.jsx
import React, { useEffect, useRef, useState } from "react";
import { getDailyTodos, getPreMeetingBrief, runVoiceCommand } from "../services/api";
import { format } from "date-fns";

const TYPE_ICONS = {
  meeting: "📅",
  task: "✅",
  email: "📧",
  deadline: "⏰",
};

const URGENCY_CLASS = {
  high: "badge-high",
  medium: "badge-medium",
  low: "badge-low",
};

function getPreferredVoice() {
  if (!("speechSynthesis" in window)) return null;

  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;

  const libbyVoice = voices.find((voice) =>
    `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase().includes("libby")
  );
  if (libbyVoice) {
    return libbyVoice;
  }

  const scoredVoices = voices
    .filter((voice) => /^en(-|$)/i.test(voice.lang || ""))
    .map((voice) => {
      const name = `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase();
      let score = 0;

      if (name.includes("natural")) score += 60;
      if (name.includes("microsoft")) score += 30;
      if (name.includes("google")) score += 25;
      if (name.includes("aria")) score += 20;
      if (name.includes("jenny")) score += 18;
      if (name.includes("guy")) score += 16;
      if (name.includes("davis")) score += 16;
      if (name.includes("libby")) score += 14;
      if (name.includes("sara")) score += 14;
      if (name.includes("zira")) score += 12;
      if (voice.localService) score += 8;
      if (/en-us/i.test(voice.lang || "")) score += 6;
      if (/en-gb/i.test(voice.lang || "")) score += 4;

      return { voice, score };
    })
    .sort((a, b) => b.score - a.score);

  return scoredVoices[0]?.voice || voices[0] || null;
}

function normalizeForSpeech(text = "") {
  return String(text || "")
    .replace(/&/g, " and ")
    .replace(/\//g, " ")
    .replace(/_/g, " ")
    .replace(/[-]+/g, " ")
    .replace(/[•|]+/g, " ")
    .replace(/[()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTimeForSpeech(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return normalizeForSpeech(value);
  return format(parsed, "h:mm a");
}

function formatVoiceIntentLabel(intent) {
  if (!intent || intent === "unknown") return "Ready";

  const labels = {
    meetings_today: "Today's meetings",
    next_meeting: "Next meeting",
    day_summary: "Day summary",
    tasks: "Open tasks",
    create_task: "Task created",
  };

  return labels[intent] || intent.replace(/_/g, " ");
}

export default function DailyTodos() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState(null);
  const [uiError, setUiError] = useState(null);
  const [isVoiceModeOn, setIsVoiceModeOn] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [spokenText, setSpokenText] = useState([]);
  const [voiceCommandSupported, setVoiceCommandSupported] = useState(false);
  const [isVoiceCommandListening, setIsVoiceCommandListening] = useState(false);
  const [isVoiceCommandLoading, setIsVoiceCommandLoading] = useState(false);
  const [voiceCommandTranscript, setVoiceCommandTranscript] = useState("");
  const [voiceCommandResponse, setVoiceCommandResponse] = useState(null);
  const [voicePreCallBrief, setVoicePreCallBrief] = useState(null);
  const recognitionRef = useRef(null);
  const shouldResumeVoiceCommandRef = useRef(false);
  const spokenLinesRef = useRef(null);

  useEffect(() => {
    getDailyTodos()
      .then(setData)
      .catch((e) => setPageError(e.message))
      .finally(() => setLoading(false));

    setVoiceCommandSupported(
      !!(window.SpeechRecognition || window.webkitSpeechRecognition)
    );

    return () => {
      recognitionRef.current?.abort?.();
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    if (isVoiceModeOn && spokenLinesRef.current) {
      spokenLinesRef.current.scrollTop = 0;
    }
  }, [isVoiceModeOn, spokenText]);

  useEffect(() => {
    const meetings = data?.rawData?.meetings || [];
    if (!meetings.length) {
      setVoicePreCallBrief(null);
      return;
    }

    const upcomingMeeting =
      meetings
        .filter((meeting) => meeting?.id)
        .sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0))
        .find((meeting) => {
          if (!meeting?.start) return false;
          return new Date(meeting.start).getTime() >= Date.now();
        }) || meetings.find((meeting) => meeting?.id);

    if (!upcomingMeeting?.id) {
      setVoicePreCallBrief(null);
      return;
    }

    let isCancelled = false;

    getPreMeetingBrief(upcomingMeeting.id)
      .then((result) => {
        if (isCancelled) return;
        setVoicePreCallBrief({
          meeting: {
            id: upcomingMeeting.id,
            subject: upcomingMeeting.subject,
            start: upcomingMeeting.start,
          },
          brief: result?.brief || null,
        });
      })
      .catch(() => {
        if (!isCancelled) {
          setVoicePreCallBrief(null);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [data]);

  function speakBack(text, options = {}) {
    const { showOverlay = false, onEnd = null, onError = null } = options;
    if (!text || !("speechSynthesis" in window)) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(normalizeForSpeech(text));
    const preferredVoice = getPreferredVoice();
    if (preferredVoice) {
      utterance.voice = preferredVoice;
      utterance.lang = preferredVoice.lang || "en-US";
    }
    utterance.rate = 0.96;
    utterance.pitch = 0.98;
    utterance.onstart = () => {
      if (showOverlay) {
        setIsVoiceModeOn(true);
      }
      setIsSpeaking(true);
      setIsPaused(false);
    };
    utterance.onpause = () => {
      setIsSpeaking(false);
      setIsPaused(true);
    };
    utterance.onresume = () => {
      setIsSpeaking(true);
      setIsPaused(false);
    };
    utterance.onend = () => {
      setIsSpeaking(false);
      setIsPaused(false);
      if (typeof onEnd === "function") {
        onEnd();
      }
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      setIsPaused(false);
      if (typeof onError === "function") {
        onError();
      }
    };

    window.speechSynthesis.speak(utterance);
  }

  function stopVoiceMode() {
    setIsVoiceModeOn(false);
    setIsSpeaking(false);
    setIsPaused(false);
    shouldResumeVoiceCommandRef.current = false;
    recognitionRef.current?.stop?.();
    setIsVoiceCommandListening(false);
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  function togglePauseVoiceMode() {
    if (!("speechSynthesis" in window)) return;

    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      setIsSpeaking(false);
      setIsPaused(true);
      return;
    }

    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setIsSpeaking(true);
      setIsPaused(false);
      return;
    }

    if (!window.speechSynthesis.speaking && spokenText.length > 0) {
      speakBack(spokenText.join(" "), { showOverlay: true });
    }
  }

  function buildDailyBriefSpeech(priorities = {}, rawData = {}) {
    const greeting = normalizeForSpeech(priorities?.greeting || "Here is your daily plan.");
    const topPriorities = priorities?.topPriorities || [];
    const meetings = rawData?.meetings || [];
    const pendingApprovalCount = rawData?.pendingApprovalCount || 0;
    const dueReminderCount = rawData?.dueReminders?.length || 0;

    const priorityLines = topPriorities.length > 0
      ? topPriorities
          .slice(0, 3)
          .map((item, index) => {
            const title = normalizeForSpeech(item.title || `priority ${index + 1}`);
            const context = normalizeForSpeech(item.context || "");
            const time = item.time ? ` at ${normalizeForSpeech(item.time)}` : "";
            return context
              ? `Priority ${index + 1}: ${title}${time}. ${context}.`
              : `Priority ${index + 1}: ${title}${time}.`;
          })
      : ["You do not have any urgent priorities right now."];

    const meetingLines = meetings.length > 0
      ? meetings
          .slice(0, 4)
          .map((meeting, index) => {
            const subject = normalizeForSpeech(meeting.subject || "Untitled meeting");
            const time = meeting.start ? ` at ${formatTimeForSpeech(meeting.start)}` : "";
            const attendeeText = meeting.attendeeCount ? ` with ${meeting.attendeeCount} attendees` : "";
            return `Meeting ${index + 1}: ${subject}${time}${attendeeText}.`;
          })
      : ["You have no meetings scheduled for today."];

    const approvalsLine = pendingApprovalCount > 0
      ? `Pending approvals: You have ${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"} to review.`
      : "Pending approvals: You have no pending approvals right now.";

    const remindersLine = dueReminderCount > 0
      ? `Due reminders: You have ${dueReminderCount} due reminder${dueReminderCount === 1 ? "" : "s"} today.`
      : "Due reminders: You have no due reminders right now.";

    return [
      greeting,
      approvalsLine,
      remindersLine,
      ...priorityLines,
      ...meetingLines,
    ];
  }

  function toggleVoiceMode(priorities = {}, rawData = {}) {
    if (!("speechSynthesis" in window)) {
      setUiError("Speech synthesis is not supported in this browser.");
      return;
    }

    if (isVoiceModeOn) {
      stopVoiceMode();
      return;
    }

    setUiError(null);
    const briefLines = buildDailyBriefSpeech(priorities, rawData);
    setSpokenText(briefLines);
    setIsVoiceModeOn(true);
    speakBack(briefLines.join(" "), { showOverlay: true });
  }

  async function handleVoiceCommandTranscript(transcript) {
    setVoiceCommandTranscript(transcript);
    setIsVoiceCommandLoading(true);
    setUiError(null);

    try {
      const result = await runVoiceCommand({
        transcript,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
        dailyContext: {
          priorities: data?.priorities || {},
          rawData: data?.rawData || {},
        },
        preCallBrief: voicePreCallBrief?.brief || null,
        preCallMeeting: voicePreCallBrief?.meeting || null,
      });
      setVoiceCommandResponse(result);
      if (result?.answer) {
        speakBack(result.answer, {
          onEnd: () => {
            if (shouldResumeVoiceCommandRef.current) {
              startVoiceCommandListening();
            }
          },
          onError: () => {
            if (shouldResumeVoiceCommandRef.current) {
              startVoiceCommandListening();
            }
          },
        });
      } else if (shouldResumeVoiceCommandRef.current) {
        startVoiceCommandListening();
      }
    } catch (commandError) {
      setUiError(commandError.message || "Voice command failed.");
      if (shouldResumeVoiceCommandRef.current) {
        startVoiceCommandListening();
      }
    } finally {
      setIsVoiceCommandLoading(false);
    }
  }

  function startVoiceCommandListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setUiError("Voice recognition is not supported in this browser.");
      return;
    }

    shouldResumeVoiceCommandRef.current = true;
    recognitionRef.current?.abort?.();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
    setIsPaused(false);

    const recognition = new SR();
    recognition.lang = "en-IN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setUiError(null);
      setIsVoiceCommandListening(true);
    };

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      setIsVoiceCommandListening(false);
      if (transcript) {
        handleVoiceCommandTranscript(transcript);
      }
    };

    recognition.onerror = (event) => {
      setIsVoiceCommandListening(false);
      if (event?.error !== "aborted") {
        setUiError("I could not capture that voice command. Please try again.");
      }
    };

    recognition.onend = () => {
      setIsVoiceCommandListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopVoiceCommandListening() {
    shouldResumeVoiceCommandRef.current = false;
    recognitionRef.current?.stop?.();
    setIsVoiceCommandListening(false);
  }

  if (loading)
    return (
      <div className="loading-state">
        <div className="spinner" />
        <div className="loading-text">Building your day…</div>
      </div>
    );

  if (pageError)
    return (
      <div className="error-state">
        ⚠️ {pageError}
      </div>
    );

  const { priorities, rawData, meta } = data || {};

  return (
    <div className="daily-view-page">
      <div className="page-header daily-view-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div className="page-title">
            {format(new Date(), "EEEE, MMMM d")}
          </div>
          <div className="page-subtitle">
            {priorities?.greeting || "Here's your day at a glance."}
          </div>
        </div>
        <div className="daily-view-actions" style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexShrink: 0, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => toggleVoiceMode(priorities, rawData)}
          >
            {isVoiceModeOn ? "Stop Voice Brief" : "Play Voice Brief"}
          </button>
        </div>
      </div>

      {uiError && (
        <div className="page-inline" style={{ marginBottom: 16 }}>
          <div className="error-state">⚠️ {uiError}</div>
        </div>
      )}

      {/* Stats row */}
      <div className="page-inline daily-stats-row" style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Meetings", value: meta?.meetingCount || 0, icon: "📅" },
          { label: "Tasks", value: meta?.taskCount || 0, icon: "✅" },
          { label: "Pending approvals", value: rawData?.pendingApprovalCount || 0, icon: "⏳" },
          { label: "Due reminders", value: rawData?.dueReminders?.length || 0, icon: "🔔" },
        ].map((stat) => (
          <div key={stat.label} className="card daily-stat-card" style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 24 }}>{stat.icon}</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{stat.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{stat.label}</div>
          </div>
        ))}
      </div>

      <div className="content-grid">
        {/* Top Priorities */}
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="card-header">
            <div className="card-title">Today's Priorities</div>
            <span className="badge badge-accent">AI-ranked</span>
          </div>

          {(priorities?.topPriorities || []).length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🎉</div>
              <div className="empty-text">Nothing urgent. You're ahead of the game.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(priorities?.topPriorities || []).map((item, i) => (
                <div
                  className="daily-priority-card"
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: "12px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: i === 0 ? "var(--accent-light)" : "transparent",
                  }}
                >
                  <div
                    className="daily-priority-rank"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: i === 0 ? "var(--accent)" : "var(--border)",
                      color: i === 0 ? "white" : "var(--text-secondary)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </div>
                  <div className="daily-priority-body" style={{ flex: 1, minWidth: 0 }}>
                    <div className="daily-priority-topline" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, minWidth: 0 }}>
                      <span>{TYPE_ICONS[item.type] || "•"}</span>
                      <span className="daily-priority-title" style={{ fontSize: 14, fontWeight: 600 }}>{item.title}</span>
                      {item.time && (
                        <span className="daily-priority-time" style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          {item.time}
                        </span>
                      )}
                    </div>
                    <div className="daily-priority-context" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                      {item.context}
                    </div>
                  </div>
                  <div
                    className="daily-priority-action"
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--accent)",
                      textTransform: "uppercase",
                      background: "var(--accent-light)",
                      padding: "3px 8px",
                      borderRadius: 20,
                      flexShrink: 0,
                    }}
                  >
                    {item.action}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Today's Meetings */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">Today's Meetings</div>
          </div>
          {(rawData?.meetings || []).length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🏖️</div>
              <div className="empty-text">No meetings today.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(rawData?.meetings || []).map((m) => (
                <div key={m.id} className="meeting-item">
                  <div className="meeting-time-block">
                    <div className="meeting-time">
                      {m.start
                        ? format(new Date(m.start), "HH:mm")
                        : "TBD"}
                    </div>
                  </div>
                  <div className="meeting-info">
                    <div className="meeting-title">{m.subject}</div>
                    <div className="meeting-meta">
                      {m.attendeeCount} attendees
                      {m.joinUrl && (
                        <a
                          href={m.joinUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ marginLeft: 8, color: "var(--accent)", fontSize: 11 }}
                        >
                          Join →
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* End of Day Goals */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">End-of-Day Goals</div>
            <span style={{ fontSize: 18 }}>🎯</span>
          </div>
          {(priorities?.endOfDayGoals || []).length === 0 ? (
            <div className="empty-state">
              <div className="empty-text">No goals generated yet.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(priorities?.endOfDayGoals || []).map((goal, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "var(--bg)",
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: "var(--green)", fontWeight: 700 }}>{i + 1}.</span>
                  <span>{goal}</span>
                </div>
              ))}
            </div>
          )}

          {/* Overdue items if any */}
          {(priorities?.overdueItems || []).length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="brief-section-title" style={{ color: "var(--red)" }}>
                ⚠️ Overdue
              </div>
              {priorities.overdueItems.map((item, i) => (
                <div key={i} style={{ fontSize: 13, padding: "4px 0", color: "var(--red)" }}>
                  • {item}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {isVoiceModeOn && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            background: "rgba(8, 12, 24, 0.38)",
            backdropFilter: "blur(18px) saturate(140%)",
            WebkitBackdropFilter: "blur(18px) saturate(140%)",
            overflow: "hidden",
          }}
        >
          <div
            className="dispatch-voice-shell"
            style={{
              position: "relative",
              width: "min(900px, 94vw)",
              maxHeight: "min(820px, calc(100vh - 40px))",
              borderRadius: 36,
              padding: 1,
              background: "rgba(255,255,255,0.12)",
              boxShadow: "0 26px 80px rgba(0,0,0,0.35)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: -24,
                borderRadius: 48,
                background:
                  "radial-gradient(circle at 10% 20%, rgba(102,217,255,0.26), transparent 22%), radial-gradient(circle at 85% 12%, rgba(255,95,144,0.2), transparent 18%), radial-gradient(circle at 50% 100%, rgba(111,124,255,0.22), transparent 24%)",
                filter: "blur(20px)",
                opacity: 0.9,
                pointerEvents: "none",
              }}
            />

            <div
              className="dispatch-voice-card"
              style={{
                position: "relative",
                borderRadius: 33,
                padding: 28,
                maxHeight: "min(818px, calc(100vh - 42px))",
                background: "linear-gradient(180deg, rgba(13, 18, 33, 0.82), rgba(9, 13, 24, 0.78))",
                border: "1px solid rgba(255,255,255,0.16)",
                backdropFilter: "blur(24px) saturate(130%)",
                WebkitBackdropFilter: "blur(24px) saturate(130%)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div className="dispatch-voice-layout" style={{ position: "relative", display: "flex", alignItems: "center", gap: 28, minHeight: 0, height: "100%" }}>
                <div
                  className="dispatch-voice-left"
                  style={{
                    position: "relative",
                    flex: "0 0 250px",
                    minHeight: 320,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <div
                    className="dispatch-voice-glow"
                    style={{
                      position: "absolute",
                      width: 318,
                      height: 318,
                      borderRadius: 999,
                      background:
                        "radial-gradient(circle at 20% 20%, rgba(89,195,255,0.2), transparent 30%), radial-gradient(circle at 80% 24%, rgba(255,93,143,0.18), transparent 28%), radial-gradient(circle at 50% 88%, rgba(103,240,210,0.16), transparent 30%), radial-gradient(circle, rgba(111,124,255,0.18), rgba(111,124,255,0.02) 58%, transparent 72%)",
                      filter: "blur(18px)",
                      pointerEvents: "none",
                      opacity: 0.92,
                    }}
                  />
                  <div
                    className="dispatch-voice-visual"
                    style={{
                      position: "relative",
                      width: 236,
                      height: 236,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div
                      className="dispatch-voice-ring"
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: "50%",
                        background:
                          "conic-gradient(from 0deg, #59c3ff, #6f7cff, #9b6bff, #ff5d8f, #ffb86b, #67f0d2, #59c3ff)",
                        animation: "dispatchVoiceSpin 8s linear infinite",
                        WebkitMask:
                          "radial-gradient(farthest-side, transparent calc(100% - 18px), #000 calc(100% - 17px))",
                        mask:
                          "radial-gradient(farthest-side, transparent calc(100% - 18px), #000 calc(100% - 17px))",
                        boxShadow:
                          "0 0 18px rgba(89,195,255,0.18), 0 0 44px rgba(155,107,255,0.14)",
                      }}
                    />
                    <div
                      className="dispatch-voice-ring-outline"
                      style={{
                        position: "absolute",
                        inset: 6,
                        borderRadius: "50%",
                        border: "1px solid rgba(255,255,255,0.08)",
                        opacity: 0.45,
                        pointerEvents: "none",
                      }}
                    />
                    <div
                      className="dispatch-voice-core"
                      style={{
                        position: "absolute",
                        inset: 19,
                        borderRadius: "50%",
                        background:
                          "radial-gradient(circle at 50% 24%, rgba(31,41,68,0.92), rgba(10,15,28,0.98) 68%)",
                        boxShadow:
                          "inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 36px rgba(111,124,255,0.12), 0 10px 24px rgba(0,0,0,0.26)",
                      }}
                    />
                    <div
                      className="dispatch-voice-pulse"
                      style={{
                        position: "absolute",
                        inset: 54,
                        borderRadius: "50%",
                        background:
                          "radial-gradient(circle, rgba(111,124,255,0.22), rgba(111,124,255,0.04) 58%, transparent 72%)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        animation: "dispatchVoicePulse 2.8s ease-in-out infinite",
                      }}
                    >
                      <div
                        className="dispatch-voice-mic"
                        style={{
                          width: 104,
                          height: 104,
                          borderRadius: "50%",
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.04))",
                          border: "1px solid rgba(255,255,255,0.14)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          boxShadow:
                            "0 18px 34px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1), inset 0 -12px 24px rgba(0,0,0,0.12)",
                          backdropFilter: "blur(10px)",
                          WebkitBackdropFilter: "blur(10px)",
                        }}
                      >
                        <span className="dispatch-voice-mic-icon" style={{ fontSize: 40, filter: "drop-shadow(0 6px 14px rgba(91,94,244,0.26))" }}>🎤</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  className="dispatch-voice-right"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    minHeight: 0,
                  }}
                >
                  <div className="dispatch-voice-mode-label" style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.72)" }}>
                    Dispatch Voice Mode
                  </div>
                  <div className="dispatch-voice-title" style={{ fontSize: 30, fontWeight: 700, marginTop: 10, color: "#ffffff", lineHeight: 1.1 }}>
                    Reading your daily brief
                  </div>
                  <div className="dispatch-voice-subtitle" style={{ fontSize: 14, lineHeight: 1.6, marginTop: 8, color: "rgba(226,232,240,0.84)", maxWidth: 420 }}>
                    Dispatch is reading today's priorities and meetings using your selected voice.
                  </div>

                  <div className="dispatch-voice-command-row" style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={isVoiceCommandListening ? stopVoiceCommandListening : startVoiceCommandListening}
                      disabled={isVoiceCommandLoading || !voiceCommandSupported}
                      style={{
                        background: isVoiceCommandListening
                          ? "rgba(91, 94, 244, 0.2)"
                          : "rgba(255,255,255,0.1)",
                        color: "#ffffff",
                        border: "1px solid rgba(255,255,255,0.18)",
                        padding: "10px 18px",
                      }}
                    >
                      {isVoiceCommandLoading
                        ? "Thinking..."
                        : isVoiceCommandListening
                          ? "Stop Listening"
                          : "Ask Dispatch"}
                    </button>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: isVoiceCommandListening ? "rgba(111,124,255,1)" : "rgba(186,196,255,0.8)" }}>
                      {isVoiceCommandLoading
                        ? "Processing"
                        : isVoiceCommandListening
                          ? "Listening"
                          : formatVoiceIntentLabel(voiceCommandResponse?.intent)}
                    </div>
                  </div>

                  <div
                    className="dispatch-voice-lines"
                    ref={spokenLinesRef}
                    style={{
                      marginTop: 24,
                      width: "100%",
                      padding: "14px 16px",
                      borderRadius: 18,
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      minHeight: 120,
                      maxHeight: "28vh",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                      overflowY: "auto",
                      overflowX: "hidden",
                      scrollbarWidth: "none",
                      msOverflowStyle: "none",
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(186,196,255,0.88)" }}>
                      Now speaking
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 16,
                        lineHeight: 1.6,
                        color: "#ffffff",
                        whiteSpace: "normal",
                        wordBreak: "break-word",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {spokenText.length > 0 ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {spokenText.map((line, index) => (
                            <div key={`spoken-line-${index}`} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                              <span style={{ color: "rgba(186,196,255,0.88)", flexShrink: 0 }}>•</span>
                              <span>{line}</span>
                            </div>
                          ))}
                        </div>
                      ) : "Preparing your daily brief..."}
                    </div>
                  </div>

                  <div
                    className="dispatch-voice-response"
                    style={{
                      marginTop: 14,
                      width: "100%",
                      padding: "14px 16px",
                      borderRadius: 18,
                      background: "rgba(111,124,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                    }}
                  >
                    {voiceCommandTranscript && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(186,196,255,0.88)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                          Heard
                        </div>
                        <div style={{ marginTop: 6, fontSize: 14, color: "#ffffff", lineHeight: 1.5 }}>
                          {voiceCommandTranscript}
                        </div>
                      </div>
                    )}

                    <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(186,196,255,0.88)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      Ask Dispatch
                    </div>
                    <div style={{ marginTop: 6, fontSize: 14, color: "#ffffff", lineHeight: 1.6 }}>
                      {isVoiceCommandListening
                        ? "Listening for your command..."
                        : isVoiceCommandLoading
                          ? "Checking Microsoft Graph and preparing an answer..."
                          : voiceCommandResponse?.answer || "Ask about your meetings, open tasks, or say add task followed by the task title."}
                    </div>
                  </div>

                  <div className="dispatch-voice-actions" style={{ marginTop: 22, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={stopVoiceMode}
                      className="btn"
                      style={{
                        background: "rgba(255,255,255,0.08)",
                        color: "#ffffff",
                        border: "1px solid rgba(255,255,255,0.18)",
                        padding: "10px 18px",
                      }}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={togglePauseVoiceMode}
                      className="btn"
                      style={{
                        background: "rgba(255,255,255,0.14)",
                        color: "#ffffff",
                        border: "1px solid rgba(255,255,255,0.22)",
                        padding: "10px 18px",
                      }}
                    >
                      {isPaused ? "Play" : isSpeaking ? "Pause" : "Play"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .dispatch-voice-shell::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 1px;
          background:
            linear-gradient(90deg, rgba(255,255,255,0.14), rgba(255,255,255,0.06));
          -webkit-mask:
            linear-gradient(#fff 0 0) content-box,
            linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
        }

        .dispatch-voice-lines::-webkit-scrollbar {
          width: 0;
          height: 0;
        }

        @keyframes dispatchVoiceSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes dispatchVoicePulse {
          0%, 100% { transform: scale(1); box-shadow: inset 0 0 30px rgba(115,130,255,0.16); }
          50% { transform: scale(1.04); box-shadow: inset 0 0 48px rgba(115,130,255,0.28), 0 0 28px rgba(89,195,255,0.14); }
        }

        @media (max-width: 640px) {
          .dispatch-voice-card {
            padding: 20px !important;
          }
        }

        @media (max-width: 900px) {
          .dispatch-voice-layout {
            flex-direction: column !important;
            align-items: center !important;
            text-align: center;
            gap: 16px !important;
          }

          .dispatch-voice-left {
            flex: none !important;
            min-height: 280px !important;
            width: 100%;
            overflow: hidden;
          }

          .dispatch-voice-right {
            width: 100%;
          }
        }

        @media (max-width: 768px) {
          .daily-view-header {
            flex-direction: column !important;
            align-items: stretch !important;
          }

          .daily-view-actions {
            width: 100%;
            justify-content: stretch !important;
          }

          .daily-view-actions .btn {
            width: 100%;
            justify-content: center;
          }

          .daily-stats-row {
            flex-wrap: wrap;
          }

          .daily-stat-card {
            flex: 1 1 calc(50% - 6px) !important;
            min-width: 0;
          }
        }

        @media (max-width: 540px) {
          .daily-stat-card {
            flex-basis: 100% !important;
          }

          .dispatch-voice-shell {
            width: min(94vw, 350px) !important;
            max-height: calc(100vh - 10px) !important;
          }

          .dispatch-voice-card {
            padding: 12px !important;
            border-radius: 22px !important;
            max-height: calc(100vh - 12px) !important;
            overflow-y: auto !important;
          }

          .dispatch-voice-layout {
            gap: 10px !important;
          }

          .dispatch-voice-left {
            min-height: 182px !important;
            align-items: center !important;
            padding-top: 0;
          }

          .dispatch-voice-right {
            justify-content: flex-start !important;
          }

          .dispatch-voice-glow {
            width: 176px !important;
            height: 176px !important;
            filter: blur(12px) !important;
          }

          .dispatch-voice-visual {
            width: 140px !important;
            height: 140px !important;
          }

          .dispatch-voice-ring-outline {
            inset: 4px !important;
          }

          .dispatch-voice-core {
            inset: 11px !important;
          }

          .dispatch-voice-pulse {
            inset: 28px !important;
          }

          .dispatch-voice-mic {
            width: 62px !important;
            height: 62px !important;
          }

          .dispatch-voice-mic-icon {
            font-size: 26px !important;
          }

          .dispatch-voice-mode-label {
            font-size: 10px !important;
            letter-spacing: 0.1em !important;
            margin-top: 0 !important;
          }

          .dispatch-voice-title {
            font-size: 15px !important;
            margin-top: 4px !important;
            line-height: 1.15 !important;
          }

          .dispatch-voice-subtitle {
            font-size: 11px !important;
            margin-top: 4px !important;
            max-width: 100% !important;
            line-height: 1.4 !important;
          }

          .dispatch-voice-command-row {
            margin-top: 12px !important;
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 8px !important;
          }

          .dispatch-voice-command-row,
          .dispatch-voice-actions {
            width: 100%;
            justify-content: center;
          }

          .dispatch-voice-command-row .btn,
          .dispatch-voice-actions .btn {
            width: 100%;
            justify-content: center;
          }

          .dispatch-voice-lines {
            margin-top: 12px !important;
            min-height: 72px !important;
            max-height: 14vh !important;
            padding: 10px 12px !important;
          }

          .dispatch-voice-response {
            margin-top: 10px !important;
            padding: 10px 12px !important;
            max-height: 18vh !important;
            overflow-y: auto !important;
          }

          .dispatch-voice-actions {
            margin-top: 12px !important;
            flex-direction: column !important;
            gap: 8px !important;
          }
        }

        @media (max-width: 640px) {
          .daily-priority-card {
            flex-wrap: wrap;
            gap: 10px !important;
          }

          .daily-priority-body {
            flex: 1 1 calc(100% - 40px) !important;
            min-width: 0 !important;
          }

          .daily-priority-topline {
            flex-wrap: wrap;
            align-items: flex-start !important;
          }

          .daily-priority-title {
            min-width: 0;
            overflow-wrap: anywhere;
          }

          .daily-priority-time {
            width: 100%;
            margin-left: 26px;
            margin-top: -2px;
          }

          .daily-priority-context {
            overflow-wrap: anywhere;
          }

          .daily-priority-action {
            width: calc(100% - 40px);
            margin-left: 40px;
            text-align: center;
            white-space: normal;
            line-height: 1.35;
          }
        }
      `}</style>
    </div>
  );
}
