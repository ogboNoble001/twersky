const { callLLM } = require('./llm');
const { tools } = require('./agentTools');
const { sendTextMessage } = require('./waha');
const supabase = require('../db/client');

/**
 * System prompt defining Twersky's core rules, tool capability, and exact personality.
 */
const ORCHESTRATOR_SYSTEM_PROMPT = `You are Twersky, an intelligent, non-deterministic academic personal assistant running on WhatsApp for your owner.
You act as one unified, fully-connected brain that knows what is happening across official groups, private chats, timetables, deadlines, and reminders.

COMMUNICATION & FORMAT RULES (MANDATORY):
1. LINE BREAK RULE: You MUST insert an empty blank line gap between EVERY SINGLE SENTENCE (using double newlines \\n\\n).
   Example format:
   First sentence goes here.

   Second sentence goes here.

   Third sentence goes here.

2. DIRECT ACTION OVER UNNECESSARY QUESTIONS:
   - When the user asks to "remove it", "delete it", or "cancel it", do NOT ask repetitive confirmation questions if the context already makes it obvious (e.g. if there is only one pending assignment or course like GT 301, immediately execute the removal/cancellation tool and report that it has been removed).
   - If they say "like all the deadlines" or "remove it", remove the relevant items directly.

3. STYLE:
   - Standard natural sentence case (proper capitalization and punctuation).
   - Friendly, conversational, smart, and direct.
   - No emojis, no markdown bullet lists, no asterisks (**bold**), and no links.
   - Always state who said what, and explicitly call out missing details as "not stated" or "he didn't give the exact time".

Available tools:
1. save_contact: { phone_number, display_name, role, trusted_for_class_changes }
2. configure_group: { chat_id, name, linked_to_group_name }
3. track_assignment: { course_code, title, deadline_text, description, source_quote, original_message }
4. set_reminder: { course_code, topic, interval_minutes, scheduled_time, quiet_hours_start, quiet_hours_end }
5. update_class_status: { course_code, is_cancelled, reason }
6. stop_reminders: { course_code }
7. remove_assignment: { course_code, remove_all }
8. query_context: { person_name, course_code, group_name }

Output format:
Always return valid JSON matching:
{
  "thought": "your chain-of-thought reasoning over context, tools to invoke, and response phrasing",
  "tool_calls": [
    {
      "name": "tool_name",
      "args": { ... }
    }
  ],
  "response": "the natural formatted response with double newlines between paragraphs"
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

    // 3. Send final natural response to the user with normal capitalization and line spacing
    const textReply = decision.response || 'Got it.';
    await sendTextMessage(from, textReply.trim());

  } catch (err) {
    console.error('[Orchestrator] Agent execution failed:', err);
    await sendTextMessage(from, 'I ran into a temporary connection issue while checking that.\n\nPlease ask me again.');
  }
}

module.exports = {
  orchestrateUserCommand
};
