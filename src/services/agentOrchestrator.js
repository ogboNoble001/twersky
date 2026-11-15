const { callLLM } = require('./llm');
const { tools } = require('./agentTools');
const { sendTextMessage } = require('./waha');
const supabase = require('../db/client');

/**
 * System prompt defining Twersky's core rules, tool capability, and exact personality.
 */
const ORCHESTRATOR_SYSTEM_PROMPT = `You are Twersky, an intelligent, connected academic personal assistant running on WhatsApp for your owner.

COMMUNICATION & FORMAT RULES (MANDATORY):
1. LINE BREAK RULE: You MUST insert an empty blank line gap between EVERY SINGLE SENTENCE (using double newlines \\n\\n).
   Example format:
   First sentence goes here.

   Second sentence goes here.

   Third sentence goes here.

2. STYLE & PERSONALITY:
   - Standard natural sentence case (proper capitalization and punctuation).
   - Friendly, conversational, smart, and direct.
   - No emojis, no markdown bullet lists, no asterisks (**bold**), and no links.
   - Always state who said what, and explicitly call out missing details as "not stated" or "he didn't give the exact time".

3. REAL ANSWERS OVER INTENTS:
   - When asked a question (e.g. "which groups do we have", "what deadlines do we have"), you MUST return the actual answer based on the context and tool results.
   - NEVER return placeholder promises like "I will look into that" or "I will query the context to see". Give the final answer directly.`;

/**
 * Executes a two-step agent loop:
 * Step 1: LLM decides what tools to call (e.g. query_context)
 * Step 2: Tools are executed, and LLM generates the final answer based on the real tool results!
 * @param {object} payload - Incoming WAHA message payload
 */
async function orchestrateUserCommand(payload) {
  const { from, body } = payload;
  const userText = (body || '').trim();

  console.log(`[Orchestrator] Invoking agent for: "${userText}"`);

  try {
    // 1. Gather baseline context
    const { data: contacts } = await supabase.from('contacts').select('display_name, role, phone_number').limit(5);
    const { data: recentAssignments } = await supabase.from('assignments').select('course_code, title, deadline_text, status').order('created_at', { ascending: false }).limit(5);
    const { data: monitoredGroups } = await supabase.from('monitored_chats').select('name, chat_id, is_active');

    const baselineContext = {
      monitored_groups: monitoredGroups || [],
      known_contacts: contacts || [],
      recent_assignments: recentAssignments || []
    };

    // Step 1: Decision on tool calling
    const step1Prompt = `System Context:
${JSON.stringify(baselineContext, null, 2)}

User's WhatsApp Message:
"${userText}"

Available tools:
1. save_contact: { phone_number, display_name, role, trusted_for_class_changes } (omit phone_number if user says "save that number as [name]" referring to recent message)
2. delete_contact: { display_name, phone_number } (use when user asks to delete or remove a contact)
3. configure_group: { chat_id, name, linked_to_group_name }
4. track_assignment: { course_code, title, deadline_text, description, source_quote, original_message }
5. set_reminder: { course_code, topic, interval_minutes, scheduled_time, quiet_hours_start, quiet_hours_end }
6. update_class_status: { course_code, is_cancelled, reason }
7. stop_reminders: { course_code }
8. remove_assignment: { course_code, remove_all }
9. query_context: { person_name, course_code, group_name }

Output strictly JSON:
{
  "thought": "what tools need to be called to answer or fulfill this request",
  "tool_calls": [
    { "name": "tool_name", "args": { ... } }
  ]
}`;

    const step1Decision = await callLLM(ORCHESTRATOR_SYSTEM_PROMPT, step1Prompt);
    console.log('[Orchestrator] Step 1 Decision:', step1Decision.thought);

    // Execute tool calls and capture results
    const executionResults = [];
    if (Array.isArray(step1Decision.tool_calls) && step1Decision.tool_calls.length > 0) {
      for (const call of step1Decision.tool_calls) {
        const toolFn = tools[call.name];
        if (toolFn) {
          try {
            const result = await toolFn(call.args);
            executionResults.push({ tool: call.name, args: call.args, result });
          } catch (e) {
            executionResults.push({ tool: call.name, error: e.message });
          }
        }
      }
    }

    // Step 2: Generate the final direct response using the tool execution results
    const step2Prompt = `System Context:
${JSON.stringify(baselineContext, null, 2)}

Tool Execution Results:
${JSON.stringify(executionResults, null, 2)}

User's Original Message:
"${userText}"

Generate the final response directly to the user.
Remember the formatting rule: You MUST insert an empty blank line gap between EVERY SINGLE SENTENCE (using double newlines \\n\\n).
Output strictly JSON:
{
  "response": "Your full response to the user with a blank line between each sentence"
}`;

    const step2Result = await callLLM(ORCHESTRATOR_SYSTEM_PROMPT, step2Prompt);
    let finalReply = step2Result.response || 'I have noted that.';

    // Clean up spacing to guarantee double newlines between sentences if needed
    finalReply = finalReply
      .replace(/([.?!])\s+(?=[A-Z])/g, '$1\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    await sendTextMessage(from, finalReply);

  } catch (err) {
    console.error('[Orchestrator] Agent execution failed:', err);
    await sendTextMessage(from, 'I ran into a temporary issue while checking that.\n\nPlease ask me again.');
  }
}

module.exports = {
  orchestrateUserCommand
};
