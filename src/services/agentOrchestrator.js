const { callLLM } = require('./llm');
const { tools } = require('./agentTools');
const { sendTextMessage } = require('./waha');
const supabase = require('../db/client');

/**
 * System prompt defining Twersky's core rules, tool capability, and exact personality.
 */
const ORCHESTRATOR_SYSTEM_PROMPT = `You are Twersky, an academic personal assistant running on a private WhatsApp line for your owner.
Your primary role is tracking courses, assignments, group announcements, timetables, and reminders.

PERSONALITY & COMMUNICATION STYLE:
- Always write in plain, natural, friendly, lowercase text.
- Never use emojis, never use markdown links, never use bold asterisks, never output bulleted markdown lists.
- Be concise (1 to 3 short sentences).
- Start reporting messages with who said it (e.g. "wisdom just said...", "course rep said...").
- Call out missing details explicitly as "not stated" or "he didn't give the exact time".
- Differentiate between what was explicitly said vs what is only a hint from the timetable.
- Never guess a time, venue, or course code.
- If the owner cancels or moves a class, do not overwrite their change silently. Ask first when a conflict appears.

TOOL ORCHESTRATION INSTRUCTIONS:
You have access to backend actions via structured tool calling.
When the user gives a command, forwards information, or asks a question, decide whether to call one or more tools or reply directly.

Available tools:
1. save_contact: { phone_number, display_name, role, trusted_for_class_changes }
2. configure_group: { chat_id, name, linked_to_group_name }
3. track_assignment: { course_code, title, deadline_text, description, source_quote, original_message }
4. set_reminder: { course_code, topic, interval_minutes, scheduled_time, quiet_hours_start, quiet_hours_end }
5. update_class_status: { course_code, is_cancelled, reason }
6. stop_reminders: { course_code }
7. query_context: { person_name, course_code, group_name }

Output format:
Always return valid JSON matching:
{
  "thought": "brief 1-sentence reasoning on what the user wants and which tools to use",
  "tool_calls": [
    {
      "name": "tool_name",
      "args": { ... }
    }
  ],
  "response": "the exact plain lowercase text to send to the user"
}`;

/**
 * Executes the LLM orchestration loop for an incoming user message
 * @param {object} payload - Incoming WAHA message payload
 */
async function orchestrateUserCommand(payload) {
  const { from, body } = payload;
  const userText = (body || '').trim();

  console.log(`[Orchestrator] Invoking agent for: "${userText}"`);

  try {
    // 1. Gather immediate recent context from database to pass to the model
    const { data: contacts } = await supabase.from('contacts').select('display_name, role, phone_number').limit(5);
    const { data: recentAssignments } = await supabase.from('assignments').select('course_code, title, deadline_text, status').order('created_at', { ascending: false }).limit(5);
    const { data: activeReminders } = await supabase.from('reminders').select('course_code, topic, interval_minutes, is_stopped').eq('is_stopped', false).limit(5);

    const contextSummary = {
      known_contacts: contacts || [],
      recent_assignments: recentAssignments || [],
      active_reminders: activeReminders || []
    };

    const prompt = `Current Context:
${JSON.stringify(contextSummary, null, 2)}

User's Incoming WhatsApp Message:
"${userText}"

Decide the appropriate tool calls (if any) and your plain lowercase response.`;

    const decision = await callLLM(ORCHESTRATOR_SYSTEM_PROMPT, prompt);

    console.log('[Orchestrator] Decision:', decision.thought);

    // 2. Execute any selected tool calls
    if (Array.isArray(decision.tool_calls) && decision.tool_calls.length > 0) {
      for (const call of decision.tool_calls) {
        const toolFn = tools[call.name];
        if (toolFn) {
          console.log(`[Orchestrator] Executing tool: ${call.name} with args:`, call.args);
          try {
            const toolResult = await toolFn(call.args);
            console.log(`[Orchestrator] Tool ${call.name} result:`, toolResult);
          } catch (toolErr) {
            console.error(`[Orchestrator] Tool execution error for ${call.name}:`, toolErr.message);
          }
        }
      }
    }

    // 3. Send final natural response to the user
    const textReply = decision.response || 'got it.';
    await sendTextMessage(from, textReply.toLowerCase().trim());

  } catch (err) {
    console.error('[Orchestrator] Agent execution failed:', err);
    await sendTextMessage(from, 'got it, looking into that now.');
  }
}

module.exports = {
  orchestrateUserCommand
};
