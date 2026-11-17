const { callLLM } = require('./llm');
const { tools } = require('./agentTools');
const { sendTextMessage, getWhatsAppGroups, getChatMessages } = require('./waha');
const supabase = require('../db/client');

/**
 * Builds the dynamic system prompt customized to the owner's preferred name and style.
 */
function buildSystemPrompt(userName = 'Noble', formattingStyle = 'double_newline', useName = true) {
  const addressingRule = useName
    ? `1. ADDRESSING YOUR OWNER:
   - Your owner's name is ${userName}.
   - Do NOT overuse or repeatedly insert their name into every response. Use it sparingly and naturally (e.g. at the start of a greeting or an important alert), never awkwardly or robotically.
   - If ${userName} tells you to call them by another name, or asks to change their name or formatting style, use the update_user_preference tool immediately.`
    : `1. ADDRESSING YOUR OWNER:
   - The owner has explicitly requested: DO NOT CALL THEM BY ANY NAME.
   - Never insert ${userName} or any name in your responses. Speak directly, politely, and naturally without addressing them by name.
   - If they later say "Call me [name]", call update_user_preference with user_name and use_name: true.`;

  return `You are Twersky, an intelligent, connected academic personal assistant running on WhatsApp for your owner.

COMMUNICATION & PERSONALITY:
${addressingRule}

2. STYLE & PERSONALITY:
   - Standard natural sentence case (proper capitalization and punctuation).
   - Friendly, conversational, smart, attentive, and direct.
   - No emojis, no markdown bullet lists, no asterisks (**bold**), and no external links.
   - Always state who said what, and explicitly call out missing details as "not stated" or "he didn't give the exact time".

3. GROUP NAMES RULE:
   - ALWAYS refer to groups by their real human-readable title (for example, "OFFICIAL COMPUTER ENGINEERING 300LVL", "300LVL COMPUTER ENGINEERING CRUISE GROUP", "CPE assignment").
   - NEVER show raw technical IDs like @g.us.

4. CONTEXT CONTINUITY & CONTEXT SWITCHING (CRITICAL):
   - You are engaged in an active ongoing WhatsApp conversation with your owner.
   - Inspect "recent_conversation_history" to resolve pronouns like "there", "that group", "it", "the official group", or "the last message" based on what was discussed in the preceding turns.
   - If the user quotes or swipes right to reply to a message, see "quoted_message" to immediately ground your context on that exact message.
   - When the user switches to a new subject, course code, or person, transition smoothly to the new context.
   - When the user asks what was said in a group (e.g. "what was the last message there", "the last message from the group"), you MUST invoke query_context with the group_name to retrieve the real announcement!

5. PROACTIVE ACADEMIC FOLLOW-UPS & PREPARATION REMINDERS:
   - When an announcement or course requirement mentions lectures or deadlines starting "next week" or requiring early preparation (for example, GET 307 Python fundamentals):
     a) State the announcement details and what preparation is required.
     b) Schedule a preparatory reminder for the upcoming weekend using set_reminder({ course_code, topic, target_date: 'this weekend' }) so the user is reminded before lectures start.
     c) Explicitly confirm that you have scheduled this weekend reminder.

6. FORMATTING RULE:
   ${formattingStyle === 'double_newline' 
     ? 'You MUST insert an empty blank line gap between EVERY SINGLE SENTENCE (using double newlines \\n\\n).' 
     : 'Use standard natural paragraph breaks as requested.'}

7. REAL ANSWERS OVER INTENTS:
   - When asked a question, you MUST return the actual answer based on the real tool results and context.
   - NEVER return placeholder promises like "I will look into that" or "I will query the context to see". Give the final answer directly.`;
}

/**
 * Executes a two-step agent loop with full conversation memory and context switching:
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

    let userPreferences = { user_name: 'Noble', formatting_style: 'double_newline', use_name: true, target_chat: from };
    if (prefRow && prefRow.name) {
      try {
        userPreferences = { ...userPreferences, ...JSON.parse(prefRow.name) };
      } catch (e) {}
    }

    // Keep target_chat synced to the active WhatsApp conversation thread
    if (from && userPreferences.target_chat !== from) {
      userPreferences.target_chat = from;
      await supabase.from('monitored_chats')
        .update({ name: JSON.stringify(userPreferences) })
        .eq('chat_id', 'user_preferences');
    }

    const userName = userPreferences.user_name || 'Noble';
    const useName = userPreferences.use_name !== false;
    const formattingStyle = userPreferences.formatting_style || 'double_newline';
    const systemPrompt = buildSystemPrompt(userName, formattingStyle, useName);

    // 2. Fetch recent conversation history between the user and Twersky from WAHA
    const rawTurns = await getChatMessages(from, 8);
    const recentHistory = (rawTurns || [])
      .filter(m => m.body && m.body.trim())
      .map(m => `[${m.fromMe ? 'Twersky' : (useName ? userName : 'User')}]: ${m.body.trim()}`)
      .reverse()
      .slice(-6);

    // Quoted message check (if user replied by swiping on WhatsApp)
    const quotedText = payload.replyTo?.body || payload._data?.quotedMsg?.body || null;
    const quotedSender = payload.replyTo?.participant || payload._data?.quotedMsg?.author || null;

    // 3. Gather permanent live database state (single source of truth for reminders, deadlines, groups, timetable)
    const { data: contacts } = await supabase
      .from('contacts')
      .select('display_name, role, phone_number')
      .limit(10);

    const { data: activeDeadlines } = await supabase
      .from('assignments')
      .select('course_code, title, deadline_text, status, description, created_at')
      .neq('status', 'completed')
      .order('created_at', { ascending: false });

    const { data: activeReminders } = await supabase
      .from('reminders')
      .select('id, course_code, topic, next_run_at, interval_minutes, is_stopped, is_done')
      .eq('is_stopped', false)
      .eq('is_done', false)
      .order('next_run_at', { ascending: true });

    const { data: monitoredGroups } = await supabase
      .from('monitored_chats')
      .select('name, chat_id, is_active')
      .eq('is_active', true);

    const { data: timetable } = await supabase
      .from('timetable_entries')
      .select('course_code, day_of_week, start_time, end_time, venue, is_cancelled_this_week')
      .order('day_of_week', { ascending: true });

    // Fetch live WhatsApp groups with real titles from WAHA
    const liveGroups = await getWhatsAppGroups();
    const availableGroups = (liveGroups || []).map(g => ({
      chat_id: g.chat_id,
      name: g.name,
      member_count: g.member_count
    }));

    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentServerTime = {
      iso: now.toISOString(),
      day_of_week: days[now.getDay()],
      formatted: now.toLocaleString('en-US', { timeZone: 'Africa/Lagos' })
    };

    const liveRemindersList = (activeReminders || []).map(r => ({
      id: r.id,
      course: r.course_code || null,
      topic: r.topic,
      scheduled_for: r.next_run_at,
      interval_minutes: r.interval_minutes
    }));

    const liveDeadlinesList = (activeDeadlines || []).map(d => ({
      course: d.course_code,
      title: d.title,
      deadline: d.deadline_text,
      status: d.status
    }));

    const baselineContext = {
      owner_name: userName,
      user_preferences: userPreferences,
      current_server_time: currentServerTime,
      recent_conversation_history: recentHistory,
      quoted_message: quotedText ? { sender: quotedSender, text: quotedText } : null,
      live_system_state: {
        active_reminders_count: liveRemindersList.length,
        active_reminders: liveRemindersList,
        active_deadlines_count: liveDeadlinesList.length,
        active_deadlines: liveDeadlinesList,
        monitored_groups_count: (monitoredGroups || []).length,
        monitored_groups: (monitoredGroups || []).map(g => g.name),
        timetable: (timetable || []).map(t => ({
          course: t.course_code,
          day: t.day_of_week,
          time: `${t.start_time} - ${t.end_time}`,
          venue: t.venue,
          cancelled_this_week: t.is_cancelled_this_week
        }))
      },
      available_whatsapp_groups: availableGroups.length > 0 ? availableGroups : [
        { chat_id: "120363427954073209@g.us", name: "OFFICIAL COMPUTER ENGINEERING 300LVL", member_count: 170 },
        { chat_id: "120363427491645104@g.us", name: "Testing_meez", member_count: 2 },
        { chat_id: "120363421234567890@g.us", name: "300LVL COMPUTER ENGINEERING CRUISE GROUP", member_count: 174 },
        { chat_id: "120363429876543210@g.us", name: "CPE assignment", member_count: 149 }
      ],
      known_contacts: contacts || []
    };

    // Step 1: Decision on tool calling
    const step1Prompt = `System Context:
${JSON.stringify(baselineContext, null, 2)}

User's WhatsApp Message:
"${userText}"

Available tools:
1. save_contact: { phone_number, display_name, role, trusted_for_class_changes } (use when user labels a contact e.g. "that's Wisdom" or "Wisdom is Course Rep". Omit phone_number to automatically resolve to the sender of the last discussed message)
2. delete_contact: { display_name, phone_number } (use when user asks to delete or remove a contact)
3. update_user_preference: { user_name, formatting_style, use_name } (if user says "stop calling my name", "don't call my name", pass use_name: false. If user says "call me [name]", pass user_name: [name], use_name: true)
4. configure_group: { chat_id, name, linked_to_group_name } (select the exact chat_id and name directly from available_whatsapp_groups that matches the user's intent. Do not invent an ID not in the list)
5. track_assignment: { course_code, title, deadline_text, description, source_quote, original_message }
6. set_reminder: { course_code, topic, target_timestamp, interval_minutes, scheduled_time } (calculate target_timestamp as an ISO 8601 string anchored to current_server_time. For example, if current_server_time is Tuesday 2pm and user asks for 'tomorrow morning', calculate Wednesday 08:00 AM ISO. Target dates automatically adapt reminder frequency as deadline nears)
7. stop_reminders: { course_code, topic } (use when user says "stop", pauses reminders without marking assignment completed)
8. mark_assignment_done: { course_code, title } (use when user says "done", "submitted", marks assignment completed and resolves reminders)
9. update_class_status: { course_code, is_cancelled, reason }
10. remove_assignment: { course_code, remove_all }
11. query_context: { person_name, course_code, group_name } (use whenever user asks about what was said, last message in a group, or announcements)

TOOL CALLING RULES:
- PRONOUN & ANAPHORA RESOLUTION: Before calling any tool, you MUST resolve ambiguous pronouns ('it', 'that', 'the assignment', 'he') into their explicit entities ('GET 207 lab report', 'Wisdom') based on recent_conversation_history. Never pass vague pronouns as tool arguments.
- TIME ANCHORING: Use "current_server_time" as your authoritative clock. Calculate exact ISO timestamps for target_timestamp when setting reminders.
- DIRECT GROUP SELECTION: When configuring or watching groups, select the exact chat_id from available_whatsapp_groups that corresponds to the group the user named.
- System Context includes "live_system_state" (active_reminders, active_deadlines, monitored_groups, timetable). This is your live database ground truth.
- If the user simply asks about current reminders, deadlines, monitored groups, or timetable (e.g. "how many reminders", "what deadlines do I have", "what groups are we monitoring"), the data is already right there in live_system_state; tool_calls can be [].
- If the user asks to add, schedule, remove, stop, or modify reminders/assignments/groups, you MUST call the appropriate tool. Never pretend a tool ran without calling it.
- If you are unsure or need message history from a group, call query_context.
- tool_calls must be an empty array [] if no modification tool is needed.

Output strictly JSON:
{
  "thought": "resolve what group or entity the user is referring to from recent conversation history and decide tools",
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
    const toolsWereCalled = executionResults.length > 0;
    const step2Prompt = `System Context:
${JSON.stringify(baselineContext, null, 2)}

Tool Execution Results:
${JSON.stringify(executionResults, null, 2)}

User's Original Message:
"${userText}"

CRITICAL RULES FOR YOUR RESPONSE:
1. "live_system_state" in System Context is the PERMANENT SINGLE SOURCE OF TRUTH for active reminders, deadlines, monitored groups, and timetable. Whenever the user asks how many reminders, what deadlines, what groups, or what classes, refer directly to "live_system_state" with 100% accuracy, regardless of conversation history or previous topics.
2. If live_system_state.active_reminders_count is 0, state clearly that there are currently 0 active reminders. Never invent or recall stopped reminders.
3. If live_system_state.active_deadlines_count is 0, state clearly that there are currently no active deadlines.
4. ${toolsWereCalled ? 'Tools were called — strictly combine the tool execution results with live_system_state. Never fabricate data that does not appear in either.' : 'No tools were called — answer strictly using live_system_state and system context.'}
5. ATTRIBUTION & WHO SAID IT: When summarizing group messages or announcements, ALWAYS mention who sent the message (use their saved contact name/role e.g. "Wisdom", or their WhatsApp display name). Never say "a message stated" without attributing it to the sender.
6. PROACTIVE ACADEMIC ASSISTANT: When you report newly announced assignments, submissions, reports, or deadlines from groups, summarize what was announced and proactively ask the user: "Would you like me to track this and set reminders for you?"
7. ONLY RELEVANT ACADEMIC UPDATES: Focus strictly on assignments, submissions, classes, timetable changes, and academic notices. Never report scholarship or internship broadcast spam.
8. Do NOT prefix your response with "[Twersky]:" or any label. Write naturally as if speaking directly.
9. ${useName ? `You may address the user naturally, but do NOT overuse their name.` : 'Do NOT use any name. Speak directly without addressing by name.'}
10. Formatting rule: ${formattingStyle === 'double_newline' ? 'Insert an empty blank line gap between EVERY SINGLE SENTENCE (using double newlines \\n\\n).' : 'Use clean natural formatting.'}

Output strictly JSON:
{
  "response": "Your full response"
}`;

    console.log('[Orchestrator] Generating Step 2 final response...');
    const step2Result = await callLLM(systemPrompt, step2Prompt);
    let finalReply = step2Result.response || 'Got it.';

    // Strip any "[Twersky]:" or "[twersky]:" prefixes the model may add
    finalReply = finalReply.replace(/\[twersky\]:\s*/gi, '').trim();

    if (formattingStyle === 'double_newline') {
      // Clean up spacing to guarantee double newlines between sentences
      finalReply = finalReply
        .replace(/([.?!])\s+(?=[A-Z])/g, '$1\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    console.log(`[Orchestrator] Dispatching final reply to ${from}: "${finalReply.substring(0, 60)}..."`);
    await sendTextMessage(from, finalReply);
    console.log(`[Orchestrator] Successfully sent reply to ${from}`);

  } catch (err) {
    console.error('[Orchestrator] Agent execution failed:', err);
    try {
      await sendTextMessage(from, 'I ran into a temporary issue while checking that.\n\nPlease ask me again.');
    } catch (sendErr) {
      console.error('[Orchestrator] Failed to send fallback error message:', sendErr.message);
    }
  }
}

module.exports = {
  orchestrateUserCommand
};
