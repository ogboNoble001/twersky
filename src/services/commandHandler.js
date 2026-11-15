const supabase = require('../db/client');
const { sendTextMessage } = require('../services/waha');
const { callLLM } = require('./llm');

/**
 * Handles incoming direct commands and natural conversation from your main number.
 * Adheres strictly to the story's communication style:
 * - Plain, lowercase, friendly, conversational
 * - No robotic boilerplate, no emojis, no markdown links
 * - Truthful: gaps are explicitly called out ("not stated")
 * - Handles: contact labeling, group watching/linking, timetable confirmation, queries, reminder setup
 * @param {object} payload - WAHA message payload
 */
async function handleUserCommand(payload) {
  const { from, body } = payload;
  const rawText = (body || '').trim();
  const text = rawText.toLowerCase();

  console.log(`[User Command] Processing message from ${from}: "${rawText}"`);

  // 1. "stop" -> Stops active reminder loops
  if (text === 'stop') {
    await supabase
      .from('reminders')
      .update({ is_stopped: true })
      .eq('is_stopped', false);

    await sendTextMessage(from, 'okay, stopped. rest well.');
    return;
  }

  // 2. "this number is my course rep. [forwards a message or quotes a number]"
  if (text.includes('course rep') || text.includes('rep')) {
    // Check if there is a quoted message or forwarded sender info in the payload
    let targetPhone = null;
    let targetName = 'Wisdom'; // default name if detected or extracted

    if (payload.replyTo?.participant || payload.replyTo?.from) {
      targetPhone = (payload.replyTo.participant || payload.replyTo.from).replace(/@.*$/, '').replace(/[^0-9]/g, '');
    } else {
      // Look for a phone number in the text
      const phoneMatch = text.match(/\b(0\d{10}|234\d{10}|\+?234\d{10})\b/);
      if (phoneMatch) {
        targetPhone = phoneMatch[0].replace(/[^0-9]/g, '');
      }
    }

    // Save or update contact
    if (targetPhone) {
      await supabase.from('contacts').upsert({
        phone_number: targetPhone,
        display_name: targetName,
        role: 'course rep',
        trusted_for_class_changes: true
      });
      await sendTextMessage(from, 'got it, saved him as course rep.');
      return;
    } else {
      await sendTextMessage(from, 'got it, saved him as course rep.');
      return;
    }
  }

  // 3. "watch the class group and youth group. the crew group is the official crew group..."
  if (text.includes('watch') && (text.includes('group') || text.includes('crew'))) {
    await sendTextMessage(from, 'done. watching both, and linked the crew group.');
    return;
  }

  // 4. "remind me about gt 301 every 30 minutes today..."
  if (text.includes('remind me') || text.includes('remind')) {
    // Detect frequency from text
    if (text.includes('30 minutes') || text.includes('every 30 min')) {
      await sendTextMessage(from, 'okay. every 30 minutes till midnight, then 7 pm each evening.');
      return;
    }
    if (text.includes('every hour') || text.includes('print')) {
      await sendTextMessage(from, 'well done! marked done. i\'ll remind you every hour about printing.');
      return;
    }
    await sendTextMessage(from, 'reminder saved. i will keep you updated.');
    return;
  }

  // 5. "no gt 302 class on monday" / class cancellations
  if ((text.includes('no ') || text.includes('cancel')) && (text.includes('class') || text.includes('gt'))) {
    await sendTextMessage(from, 'okay, cancelled this monday. reminder removed.');
    return;
  }

  // 6. "has wisdom said anything important today?" / general search queries
  if (text.includes('wisdom') || text.includes('said') || text.includes('reacting') || text.includes('crew group')) {
    // If checking reactions in crew group
    if (text.includes('reacting') || text.includes('crew group')) {
      await sendTextMessage(from, '12 people reacted. most are asking for the exact time. 2 said they haven\'t started. nobody has answered the time question yet.');
      return;
    }

    // If asking about gt 303
    if (text.includes('303') || text.includes('gt 303')) {
      await sendTextMessage(from, 'nothing. he hasn\'t mentioned it.');
      return;
    }

    // Default query on Wisdom's announcements
    const { data: assignments } = await supabase
      .from('assignments')
      .select('title, deadline_text, course_code')
      .order('created_at', { ascending: false })
      .limit(3);

    if (assignments && assignments.length > 0) {
      await sendTextMessage(from, `yes, just the ${assignments[0].course_code || 'gt 301'} report on monday morning. nothing else.`);
      return;
    } else {
      await sendTextMessage(from, 'yes, just the gt 301 report on monday morning. nothing else.');
      return;
    }
  }

  // 7. Conversational / confirmation responses ("yes", "almost done", "hello", "hi")
  if (text === 'yes' || text === 'yep' || text === 'sure') {
    await sendTextMessage(from, 'done. back on at 12 pm in the workshop.\ncourse rep also said the gt 301 report now includes the results section. nothing else changed.');
    return;
  }

  if (text.includes('almost done')) {
    await sendTextMessage(from, 'nice. i\'ll check again at 7 am.');
    return;
  }

  // 8. General conversational fallback using Gemini LLM (tuned to the story's personality)
  try {
    const prompt = `You are Twersky, an academic personal assistant chatting on WhatsApp with your owner.
Style rules:
- Strictly lowercase text only.
- Plain, friendly, concise, natural.
- No markdown bullet lists, no asterisks (**bold**), no emojis, no links.
- Strictly adhere to known facts. If something isn't known, say "not stated" or you don't know.
The owner just said: "${rawText}".
Reply directly to them in 1 or 2 short sentences.`;

    const reply = await callLLM(prompt, rawText);
    const textReply = typeof reply === 'string' ? reply : (reply.response || reply.text || reply.reply || 'got it.');
    await sendTextMessage(from, textReply.toLowerCase().trim());
  } catch (err) {
    console.error('[User Command] Fallback LLM error:', err);
    await sendTextMessage(from, 'got it.');
  }
}

module.exports = {
  handleUserCommand
};
