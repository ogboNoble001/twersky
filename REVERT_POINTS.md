# Twersky Revert Points

A log of stable checkpoints. Use `git checkout <commit>` or `git revert` to roll back to any point.

---

## Revert Point 00 — Robust "done"/"stop" Resolution & Live System State
**Date:** 2026-11-17 09:21 WAT  
**Git commit:** `425e555`  
**Branch:** `main`

### State at this point:
- `mark_assignment_done` and `stop_reminders` updated to handle null course_code, filtering out 'General' placeholders.
- If user simply says "done" or "stop", it resolves all currently active/due reminders.
- `live_system_state` injected on every turn as single source of truth for active reminders, deadlines, monitored groups, and timetable.
- Tested: rogue 20-minute reminder deactivated, 0 active reminders remaining.
- Internal 8-minute keep-alive ping running to keep Render awake.
- GitHub push configured to HTTP/1.1 with PAT.

### To revert:
```bash
git checkout 425e555
```

---

## Revert Point 0 — Stable Groq Response Quality (No Prefix, No Hallucinations)
**Date:** 2026-11-16 01:21 WAT  
**Git commit:** `6226554`  
**Branch:** `main`

### State at this point:
- `[Twersky]:` prefix completely removed via regex + prompt rule.
- No name-calling honored (`use_name: false`).
- Groq model `openai/gpt-oss-120b` live as fallback.
- Strictly grounded in tool results.
- Verified live: 2 monitored groups and 0 reminders accurately reported on WhatsApp.

### To revert:
```bash
git checkout 6226554
```

---

## Revert Point 1 — Before Groq Response Quality Fix
**Date:** 2026-11-16 01:14 WAT  
**Git commit:** `de45b8d`  
**Branch:** `main`

### State at this point:
- Groq fallback is wired up and working (`openai/gpt-oss-120b`)
- BUT Groq model introduces 3 bugs:
  1. Prefixes responses with `[Twersky]:` by copying conversation history format
  2. Hallucinating tool results (invents reminders, invents group monitoring confirmations) without actually calling tools
  3. Reminder state inconsistent — said "no reminders" at 00:59, then "one reminder" at 01:04 (hallucinated)
- `use_name: false` is correctly saved in DB
- Natural language date parser is live (in X days / weeks / months / hours / tomorrow / weekend)
- Auto-cancel old reminders on new `set_reminder` is live
- `update_class_status` tool is restored
- `target_chat` sync uses `UPDATE` not `upsert` (no more preference wipeout)

### Key file states:
| File | Key detail |
|---|---|
| `src/services/llm.js` | Gemini → Groq fallback with `openai/gpt-oss-120b` |
| `src/services/agentOrchestrator.js` | 2-step tool loop, `update` not `upsert` for preferences |
| `src/services/agentTools.js` | Full natural language date parser, `update_class_status` restored |
| `src/services/reminderScheduler.js` | 24/7 no quiet hours, routes to `target_chat` |
| `src/routes/webhook.js` | Saves group messages, routes DMs to orchestrator |

### To revert to this exact point:
```bash
git checkout de45b8d
```

---

## Revert Point 2 — Before Groq Integration (Gemini-only, pre-quota-exhaustion)
**Date:** 2026-11-16 00:00 WAT  
**Git commit:** `ba20546`  

### State at this point:
- Gemini only, no Groq fallback
- `use_name` wipeout bug fixed (UPDATE vs upsert)
- Natural language date parser for weeks and months live
- System is clean but crashes when all Gemini free-tier keys hit daily limit

### To revert:
```bash
git checkout ba20546
```

---

## Revert Point 3 — Earliest stable working state (name preference + reminder routing)
**Date:** 2026-11-15 23:00 WAT  
**Git commit:** `f44d968`

### State at this point:
- `use_name` preference implemented
- Reminders route to `target_chat` (LID thread)
- Quiet hours completely removed
- 24/7 direct delivery working

### To revert:
```bash
git checkout f44d968
```

---

*Add new revert points above this line, newest first.*
