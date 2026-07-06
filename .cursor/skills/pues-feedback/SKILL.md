---
name: pues-feedback
description: Proactively identify missing, outdated, or weak Pues skills and report concrete suggestions to the human. Use when working in Pues or Pues consumer repos and noticing repeated guidance, manual workflows, or skill/code drift.
---
# Pues Feedback

## Purpose
Track opportunities to improve the Pues skill set and surface them early.
Standing instruction from the human: where you see a skill needs improving, or
a new skill needs adding, tell the human.

## When To Trigger
Trigger when at least one of these is true:
- The same guidance is repeated across tasks/chats.
- A workflow has 3+ repeated manual steps that should be standardized.
- A current skill references behavior that no longer matches Pues code.
- A recurring bug class is not covered by a skill checklist.
- A new Pues part/pattern appears without skill support.

## What To Tell The Human
Send a short "Pues skill feedback" block with:
- Type: `new-skill` or `improve-skill`
- Candidate: skill name
- Why: one sentence
- Evidence: concrete paths/functions
- Proposed scope: 3-5 bullets

## Constraints
- Be specific and evidence-based; avoid vague suggestions.
- Prefer improving an existing skill over creating duplicates.
- Keep feedback concise (5-10 lines unless asked for detail).
- Do not create or edit skills automatically unless the user asks.

## Feedback Template
Use this exact format:

```markdown
Pues skill feedback:
- Type: <new-skill|improve-skill>
- Candidate: `<skill-name>`
- Why: <one sentence>
- Evidence: `<path-or-symbol>`, `<path-or-symbol>`
- Proposed scope:
  - <item>
  - <item>
  - <item>
```

## Example
```markdown
Pues skill feedback:
- Type: improve-skill
- Candidate: `pues-objects-resource-setup`
- Why: Parent-scoped SSE bridge patterns are being repeated manually.
- Evidence: `pues/base/objects/broadcast.ts`, `<consumer>/src/api/server.ts`
- Proposed scope:
  - Add a "bridging non-pues mutations" checklist.
  - Add a minimal `broadcastRow` + `broadcastDelete` snippet.
  - Add a "when not needed" note to avoid over-broadcasting.
```
