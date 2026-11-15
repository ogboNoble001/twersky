const { callLLM } = require('./llm');
const { tools } = require('./agentTools');
const { sendTextMessage, getWhatsAppGroups } = require('./waha');
const supabase = require('../db/client');

/**
 * Builds the dynamic system prompt customized to the owner's preferred name and style.
 */
function buildSystemPrompt(userName = 'Noble', formattingStyle = 'double_newline') {
  return `You are Twersky, an intelligent, connected academic personal assistant running on WhatsApp for your owner, ${userName}.

COMMUNICATION & PERSONALITY:
1. ADDRESSING YOUR OWNER:
   - Your owner's name is ${userName}. Naturally address them as ${userName} in your replies when appropriate.
   - If ${userName} tells you to call them by another name, or asks to change their name or formatting style, use the update_user_preference tool immediately.

2. STYLE & PERSONALITY:
   - Standard natural sentence case (proper capitalization and punctuation).
   - Friendly, conversational, smart, attentive, and direct.
   - No emojis, no markdown bullet lists, no asterisks (**bold**), and no external links.
   - Always state who said what, and explicitly call out missing details as "not stated" or "he didn't give the exact time".

3. GROUP NAMES RULE:
   - ALWAYS refer to groups by their real human-readable title (for example, "OFFICIAL COMPUTER ENGINEERING 300LVL", "300LVL COMPUTER ENGINEERING CRUISE GROUP", "CPE assignment").
   - NEVER show raw technical IDs like @g.us to ${userName}.

4. FORMATTING RULE:
   ${formattingStyle === 'double_newline' 
     ? 'You MUST insert an empty blank line gap between EVERY SINGLE SENTENCE (using double newlines \\n\\n).' 
     : 'Use standard natural paragraph breaks as requested by ' + userName + '.'}

5. REAL ANSWERS OVER INTENTS:
   - When asked a question (e.g. "which groups do we have", "what deadlines do we have", "what was said"), you MUST return the actual answer based on the real tool results and context.
   - When asked about groups, list any active monitored groups AND the available WhatsApp groups by their real human names.
   - NEVER return placeholder promises like "I will look into that" or "I will query the context to see". Give the final answer directly.`;
}

/**
 * Executes a two-step agent loop:
 * Step 1: LLM decides what tools to call (e.g. query_context, update_user_preference)
 * Step 2: Tools are executed, and LLM generates the final answer based on the real tool results!
 * @param {object} payload - Incoming WAHA message payload
 */
async function orchestrateUserCommand(payload) {
  const { from, body } = payload;
  const userText = (body || '').trim();

  console.log(`[Orchestrator] Invoking agent for: "${userText}"`);

  try {
    // 1. Fetch user preferences (name, formatting style)
    const { data: prefRow } = await supabase
      .from('monitored_chats')
      .select('name')
      .eq('chat_id', 'user_preferences')
      .maybeSingle();

    let userPreferences = { user_name: 'Noble', formatting_style: 'double_newline' };
    if (prefRow && prefRow.name) {
      try {
        userPreferences = { ...userPreferences, ...JSON.parse(prefRow.name) };
      } catch (e) {}
    }

    const userName = userPreferences.user_name || 'Noble';
    const formattingStyle = userPreferences.formatting_style || 'double_newline';
    const systemPrompt = buildSystemPrompt(userName, formattingStyle);

    // 2. Gather baseline context
    const { data: contacts } = await supabase
      .from('contacts')
      .select('display_name, role, phone_number')
      .limit(10);

    const { data: recentAssignments } = await supabase
      .from('assignments')
      .select('course_code, title, deadline_text, status')
      .order('created_at', { ascending: false })
      .limit(5);

    const { data: monitoredGroups } = await supabase
      .from('monitored_chats')
      .select('name, chat_id, is_active')
      .eq('is_active', true);

    // Fetch live WhatsApp groups with real titles from WAHA
    const liveGroups = await getWhatsAppGroups();
    const availableGroups = liveGroups.map(g => ({
      name: g.name,
      member_count: g.member_count
    }));

    const baselineContext = {
      owner_name: userName,
      user_preferences: userPreferences,
      active_monitored_groups: monitoredGroups || [],
      available_whatsapp_groups: availableGroups.length > 0 ? availableGroups : [
        { name: "OFFICIAL COMPUTER ENGINEERING 300LVL", member_count: 170 },
        { name: "300LVL COMPUTER ENGINEERING CRUISE GROUP", member_count: 174 },
        { name: "CPE assignment", member_count: 149 },
        { name: "Scholarship Region D9", member_count: 979 }
      ],
      known_contacts: contacts || [],
      recent_assignments: recentAssignments || []
    };

    // Step 1: Decision on tool calling
    const step1Prompt = `System Context:
${JSON.stringify(baselineContext, null, 2)}

User's WhatsApp Message:
"${userText}"

Available tools:
1. save_contact: { phone_number, display_name, role, trusted_for_class_changes } (omit phone_number if referring to recent message)
2. delete_contact: { display_name, phone_number } (use when user asks to delete or remove a contact)
3. update_user_preference: { user_name, formatting_style } (use when user says "call me [name]", "my name is [name]", or requests a formatting style change)
4. configure_group: { chat_id, name, linked_to_group_name } (binds group by name e.g. "OFFICIAL COMPUTER ENGINEERING 300LVL")
5. track_assignment: { course_code, title, deadline_text, description, source_quote, original_message }
6. set_reminder: { course_code, topic, interval_minutes, scheduled_time, quiet_hours_start, quiet_hours_end }
7. stop_reminders: { course_code } (use when user says "stop", pauses reminders without marking assignment completed)
8. mark_assignment_done: { course_code, title } (use when user says "done", "submitted", marks assignment completed and resolves reminders)
9. update_class_status: { course_code, is_cancelled, reason }
10. remove_assignment: { course_code, remove_all }
11. query_context: { person_name, course_code, group_name }

Output strictly JSON:
{
  "thought": "what tools need to be called to answer or fulfill this request",
  "tool_calls": [
    { "name": "tool_name", "args": { ... } }
  ]
}`;

    const step1Decision = await callLLM(systemPrompt, step1Prompt);
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

Generate the final response directly to ${userName}.
Address ${userName} naturally.
Formatting rule: ${formattingStyle === 'double_newline' ? 'Insert an empty blank line gap between EVERY SINGLE SENTENCE (using double newlines \\n\\n).' : 'Use clean natural formatting.'}
Output strictly JSON:
{
  "response": "Your full response directly to ${userName}"
}`;

    const step2Result = await callLLM(systemPrompt, step2Prompt);
    let finalReply = step2Result.response || `I have noted that, ${userName}.`;

    if (formattingStyle === 'double_newline') {
      // Clean up spacing to guarantee double newlines between sentences
      finalReply = finalReply
        .replace(/([.?!])\s+(?=[A-Z])/g, '$1\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    await sendTextMessage(from, finalReply);

  } catch (err) {
    console.error('[Orchestrator] Agent execution failed:', err);
    await sendTextMessage(from, 'I ran into a temporary issue while checking that.\n\nPlease ask me again.');
  }
}

module.exports = {
  orchestrateUserCommand
};
