const STOP_WORDS = new Set([
  "with", "from", "this", "that", "have", "will", "been", "your",
  "meeting", "call", "sync", "review", "weekly", "update", "prep",
  "follow", "yesterday", "today", "about", "just", "also", "here",
  "some", "what", "when", "then", "only", "over", "very", "into",
  "more", "were", "they", "them", "their", "would", "could", "page",
]);

function normalizeTokens(text = "") {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function matchesLandingPageScenario(tokens = []) {
  const set = new Set(tokens);
  const hasLanding = set.has("landing");
  const hasRefresh = set.has("refresh");
  const hasLaunch = set.has("launch");
  const hasTestimonial = set.has("testimonial") || set.has("testimonials");
  return (hasLanding && hasRefresh) || (hasLanding && hasLaunch) || hasTestimonial;
}

function getLandingPageFixture() {
  return {
    projectLabel: "Landing Page Refresh",
    spaceName: "Landing Page Refresh",
    issues: [
      {
        key: "LPF-101",
        title: "Approve revised landing page headline",
        status: "Done",
        assignee: "Robin Sharma",
        priority: "High",
        dueDate: "2026-03-08",
        updatedAt: "2026-03-21T09:30:00.000Z",
        isBlocked: false,
        labels: ["phase-1", "copy"],
        projectLabel: "Landing Page Refresh",
      },
      {
        key: "LPF-102",
        title: "Swap hero image in Phase 1 draft",
        status: "Done",
        assignee: "Krithi Shailya",
        priority: "Medium",
        dueDate: "2026-03-08",
        updatedAt: "2026-03-21T10:05:00.000Z",
        isBlocked: false,
        labels: ["phase-1", "design"],
        projectLabel: "Landing Page Refresh",
      },
      {
        key: "LPF-103",
        title: "Finalize CTA placement for Monday launch",
        status: "In Progress",
        assignee: "Krithi Shailya",
        priority: "High",
        dueDate: "2026-03-22",
        updatedAt: "2026-03-22T07:20:00.000Z",
        isBlocked: false,
        labels: ["phase-1", "launch"],
        projectLabel: "Landing Page Refresh",
      },
      {
        key: "LPF-104",
        title: "Collect testimonial legal sign-off for customer quotes",
        status: "Blocked",
        assignee: "Shivam Saxena",
        priority: "Highest",
        dueDate: "2026-03-22",
        updatedAt: "2026-03-22T06:10:00.000Z",
        isBlocked: true,
        labels: ["blocked", "legal", "testimonial"],
        projectLabel: "Landing Page Refresh",
      },
      {
        key: "LPF-105",
        title: "Confirm Monday launch scope with Robin and Krithi",
        status: "In Progress",
        assignee: "Akshay Ambekar",
        priority: "Highest",
        dueDate: "2026-03-22",
        updatedAt: "2026-03-22T08:00:00.000Z",
        isBlocked: false,
        labels: ["launch", "scope", "decision-needed"],
        projectLabel: "Landing Page Refresh",
      },
    ],
    openBlockers: [
      "Testimonial legal sign-off is still pending, so the testimonial section remains blocked for Phase 1.",
    ],
    discussionPoints: [
      "Decide whether Phase 1 launches without testimonials while legal approval is still pending.",
      "Akshay needs to confirm the final Monday scope before Krithi can package the handoff.",
      "Confirm whether the current Monday target still holds once scope is locked.",
    ],
  };
}

function getMockIssueBundle({ event, pastMeeting, emails = [] }) {
  const combinedText = [
    event?.subject || "",
    pastMeeting?.subject || "",
    ...emails.slice(0, 10).flatMap((email) => [email.subject || "", email.bodyPreview || ""]),
  ].join(" ");

  const tokens = normalizeTokens(combinedText);

  if (matchesLandingPageScenario(tokens)) {
    return getLandingPageFixture();
  }

  return null;
}

module.exports = {
  getMockIssueBundle,
};
