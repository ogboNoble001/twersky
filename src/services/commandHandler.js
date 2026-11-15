const supabase = require('../db/client');
const { sendTextMessage } = require('../services/waha');

/**
 * Handles incoming direct commands from the user's main number
 * @param {object} payload - WAHA message payload
 */
async function handleUserCommand(payload) {
  const { from, body } = payload;
  const text = (body || '').trim().toLowerCase();

  console.log(`[User Command] Received from ${from}: "${text}"`);

  // Basic command dispatcher according to specification
  if (text === 'stop') {
    // Stop all active reminder loops
    await supabase
      .from('reminders')
      .update({ is_stopped: true })
      .eq('is_stopped', false);

    await sendTextMessage(from, 'okay, stopped. rest well.');
    return;
  }

  // Handle "has wisdom said anything important today?"
  if (text.includes('wisdom') && (text.includes('important') || text.includes('said'))) {
    // Query important messages from contacts labeled Wisdom/Course Rep
    const { data: wisdomContact } = await supabase
      .from('contacts')
      .select('phone_number')
      .ilike('display_name', '%wisdom%')
      .maybeSingle();

    if (wisdomContact) {
      // Find today's assignments or raw messages
      const { data: assignments } = await supabase
        .from('assignments')
        .select('title, deadline_text, source_quote')
        .eq('source_sender_id', wisdomContact.phone_number)
        .order('created_at', { ascending: false })
        .limit(5);

      if (assignments && assignments.length > 0) {
        const summary = assignments.map(a => `${a.title}: ${a.deadline_text || 'details'} ("${a.source_quote || ''}")`).join('\n');
        await sendTextMessage(from, `yes, just ${summary}. nothing else.`);
        return;
      }
    }

    await sendTextMessage(from, 'nothing. he hasn\'t mentioned anything important.');
    return;
  }

  // Fallback acknowledging receipt
  await sendTextMessage(from, 'message received. tracking your commands and groups.');
}

module.exports = {
  handleUserCommand
};
