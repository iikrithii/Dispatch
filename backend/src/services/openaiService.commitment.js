// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS FUNCTION to your existing openaiService.js
// Then add checkCommitmentsWithAI to module.exports
// ─────────────────────────────────────────────────────────────────────────────

async function checkCommitmentsWithAI({ transcript, context }) {
  const systemPrompt = `You are Dispatch's Commitment Intelligence engine.

Your job is to analyse a snippet from a live meeting transcript and:
1. Extract every commitment, deadline, or deliverable being proposed or agreed to.
2. Evaluate feasibility based on the calendar load and pending tasks provided.
3. Suggest a realistic alternative when feasibility is risky or unrealistic.
4. List specific calendar conflicts causing the problem.

Feasibility scale:
- "clear"       -> Plenty of time, no conflicts
- "tight"       -> Achievable but little buffer
- "risky"       -> Conflicts exist, likely to slip
- "unrealistic" -> Not achievable given current load

Rules:
- If no owner is mentioned, assume "You".
- Always fill the suggestion field.
- Return strict JSON only. No markdown, no explanation outside JSON.

Output format:
{
  "commitments": [
    {
      "raw": "exact phrase from transcript",
      "owner": "You | Person Name",
      "deadline": "YYYY-MM-DD or null",
      "deadlineLabel": "e.g. Tuesday EOD",
      "feasibility": "clear | tight | risky | unrealistic",
      "reason": "1-2 sentences referencing actual calendar load",
      "suggestion": "Concrete counter-proposal or confirmation",
      "conflicts": [
        { "title": "Meeting title", "time": "Day HH:MM-HH:MM" }
      ]
    }
  ]
}`;

  const userPrompt = `Today's date: ${new Date().toISOString().slice(0, 10)}

## Meeting Context and Calendar Load
${context}

## Transcript Snippet to Analyse
${transcript}

Extract all commitments. Evaluate feasibility. Return strict JSON only.`;

  const client = getOpenAIClient();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";

  const response = await client.chat.completions.create({
    model: deployment,
    temperature: 0.2,
    max_tokens: 1500,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = response.choices?.[0]?.message?.content || "{}";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("AI returned invalid JSON: " + cleaned.slice(0, 200));
  }

  if (!parsed.commitments || !Array.isArray(parsed.commitments)) {
    parsed = { commitments: [] };
  }

  return parsed;
}

module.exports = { checkCommitmentsWithAI };