const express = require('express');
const router = express.Router();
const supabase = require('../db/client');
const { isAuthorizedUser, normalizePhone } = require('../utils/helpers');
const { orchestrateUserCommand } = require('../services/agentOrchestrator');
const { extractAssignmentFromMessage } = require('../services/llm');
const { sendTextMessage } = require('../services/waha');
const { tools } = require('../services/agentTools');

// In-memory cache to prevent duplicate webhook delivery within 10 seconds
const processedMessageIds = new Set();

// WAHA Webhook Receiver
router.post('/whatsapp', async (req, res) => {
  try {
    const { event, payload } = req.body;

    if (!event || !payload) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Only process incoming messages
    if (event !== 'message') {
      return res.status(200).json({ status: 'ignored_event' });
    }

    const {
      id: messageId,
      from,             // JID of chat (can be group e.g. 123@g.us or user 234...@c.us or @lid)
      fromMe,           // Boolean: was this sent by the bot's line itself?
      sender,           // In groups, the participant's JID
      participant,      // WAHA field for group participant
      body,
      hasMedia,
      media,
      timestamp
    } = payload;

    // Rule 1: Ignore the bot's own outgoing messages
    if (fromMe) {
      return res.status(200).json({ status: 'ignored_self_message' });
    }

    // Rule 2: Strict Deduplication Guard
    if (messageId) {
      if (processedMessageIds.has(messageId)) {
        console.log(`[Webhook] Duplicate event for message ${messageId} ignored.`);
        return res.status(200).json({ status: 'ignored_duplicate' });
      }
      processedMessageIds.add(messageId);
      // Auto-expire from cache after 15 seconds
      setTimeout(() => processedMessageIds.delete(messageId), 15000);
    }

    const actualSender = sender || participant || payload._data?.key?.participant || from;
    const altSender = payload._data?.key?.participantAlt || payload._data?.key?.remoteJidAlt || null;
    const senderDisplayName = payload._data?.pushName || payload._data?.notifyName || null;
    const isDirectMessage = !from.endsWith('@g.us');

    // Rule 3: Drop newsletter channel messages entirely — they are broadcast-only noise
    if (from.endsWith('@newsletter')) {
      return res.status(200).json({ status: 'ignored_newsletter' });
    }

    // Rule 4: For group messages, only save if the group is in our monitored_chats table and active
    if (from.endsWith('@g.us')) {
      const { data: monitoredGroup, error: groupErr } = await supabase
        .from('monitored_chats')
        .select('chat_id, is_active')
        .eq('chat_id', from)
        .eq('is_active', true)
        .maybeSingle();

      if (groupErr) {
        console.error('[Webhook] Error querying monitored_chats:', groupErr.message);
      }

      if (!monitoredGroup) {
        // Not a monitored group — silently ignore
        return res.status(200).json({ status: 'ignored_unmonitored_group' });
      }
    }

    console.log(`[Webhook] Incoming message from: ${actualSender} (${senderDisplayName || 'unknown'}) in chat: ${from}`);

    // Check if message is a direct command from the main user
    const authorizedUser = process.env.USER_PHONE_NUMBER;
    if (isDirectMessage && isAuthorizedUser(payload, authorizedUser)) {
      // Hand off to the LLM Agent Orchestrator
      await orchestrateUserCommand(payload);
      return res.status(200).json({ status: 'orchestrated' });
    }

    // Group Message: Save verbatim in raw_messages
    const { error: insertError } = await supabase.from('raw_messages').upsert({
      id: messageId,
      chat_id: from,
      sender_id: actualSender,
      sender_name: senderDisplayName,
      body: body || '',
      has_media: Boolean(hasMedia),
      media_url: media?.url || null,
      media_mimetype: media?.mimetype || null,
      timestamp: timestamp || Math.floor(Date.now() / 1000)
    });

    if (insertError) {
      console.error('[Webhook] Failed to save raw message:', insertError.message);
    } else {
      console.log(`[Webhook] Saved raw message ${messageId} from ${actualSender}`);
    }

    // ─── PROACTIVE ALERT PIPELINE ────────────────────────────────────────────
    // Runs async after returning 200 — does not block webhook response.
    if (body && body.trim()) {
      setImmediate(() => runProactiveAlertPipeline({
        messageId,
        chatId: from,
        actualSender,
        altSender,
        senderName: senderDisplayName,
        body: body.trim()
      }));
    }
    // ─────────────────────────────────────────────────────────────────────────

    return res.status(200).json({ status: 'saved' });
  } catch (err) {
    console.error('[Webhook] Error processing event:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

/**
 * Proactive Alert Pipeline
 * Triggered after every group message is saved.
 * Runs fully async — never blocks the webhook response.
 *
 * Steps:
 * 1. Run AI gate check: is this message academically important?
 * 2. If not → stay silent.
 * 3. If yes → resolve sender name, fetch group title, DM the user.
 */
async function runProactiveAlertPipeline({ messageId, chatId, actualSender, altSender, senderName, body }) {
  try {
    console.log(`[ProactiveAlert] Analyzing message ${messageId} from ${chatId}...`);

    // Step 1: AI gate check
    const extraction = await extractAssignmentFromMessage(body);

    if (!extraction || !extraction.is_important) {
      console.log(`[ProactiveAlert] Message ${messageId} is not important — staying silent.`);
      return;
    }

    console.log(`[ProactiveAlert] IMPORTANT message detected! course=${extraction.course_code}, deadline=${extraction.deadline_text}`);

    // Step 2: Resolve sender display name
    // Try contacts table first (by normalised phone number from actualSender or altSender)
    const phoneCandidates = [
      actualSender ? actualSender.replace(/@.*$/, '').replace(/\D/g, '') : '',
      altSender ? altSender.replace(/@.*$/, '').replace(/\D/g, '') : ''
    ].filter(Boolean);

    const { data: contactRows } = await supabase
      .from('contacts')
      .select('display_name, role, phone_number')
      .limit(20);

    let resolvedSender = senderName || phoneCandidates[0] || 'Someone';
    if (contactRows && contactRows.length > 0) {
      const match = contactRows.find(c => {
        const cp = (c.phone_number || '').replace(/\D/g, '');
        return cp && phoneCandidates.includes(cp);
      });
      if (match) {
        resolvedSender = match.role
          ? `${match.display_name} (${match.role})`
          : match.display_name;
      }
    }

    // Step 3: Resolve group human-readable title
    const { data: groupRow } = await supabase
      .from('monitored_chats')
      .select('name')
      .eq('chat_id', chatId)
      .single();

    // group name is stored in the 'name' column — but for monitored groups it may be a JSON blob
    // for user_preferences row it is JSON; for group rows it is plain text title
    let groupTitle = chatId; // fallback
    if (groupRow && groupRow.name) {
      try {
        // If it parses as JSON it's the user_preferences row — shouldn't happen here but guard anyway
        JSON.parse(groupRow.name);
      } catch {
        // Plain text — this is the group title
        groupTitle = groupRow.name;
      }
    }

    // Step 4: Fetch user's target_chat and auto_track preferences
    const { data: prefRow } = await supabase
      .from('monitored_chats')
      .select('name')
      .eq('chat_id', 'user_preferences')
      .maybeSingle();

    let userPrefs = {};
    if (prefRow && prefRow.name) {
      try { userPrefs = JSON.parse(prefRow.name); } catch(e) {}
    }

    const targetChat = userPrefs.target_chat || null;
    if (!targetChat) {
      console.warn('[ProactiveAlert] No target_chat in user_preferences — cannot DM user. Skipping.');
      return;
    }

    // Official group auto-tracks by default; others require confirmation
    const autoTrackGroups = Array.isArray(userPrefs.auto_track_groups)
      ? userPrefs.auto_track_groups
      : ['120363427954073209@g.us'];
    const isAutoTrack = autoTrackGroups.includes(chatId);

    const verbatimQuote = extraction.quote || body;
    const deadlineNote = extraction.deadline_text
      ? `\n\nDeadline: ${extraction.deadline_text}`
      : '';

    let alertText = '';

    if (isAutoTrack) {
      // 1. Auto-track: record assignment AND schedule reminders immediately
      console.log(`[ProactiveAlert] Auto-tracking active for group ${chatId}. Scheduling reminders automatically.`);
      await tools.track_assignment({
        course_code: extraction.course_code,
        title: extraction.title || `${extraction.course_code || 'Course'} Deadline`,
        deadline_text: extraction.deadline_text,
        description: extraction.description,
        source_quote: extraction.quote
      });

      await tools.set_reminder({
        course_code: extraction.course_code,
        topic: extraction.title || `${extraction.course_code || 'Course'} submission`,
        target_date: extraction.deadline_text
      });

      alertText =
        `${resolvedSender} just posted in ${groupTitle}:\n\n` +
        `"${verbatimQuote}"` +
        `${deadlineNote}\n\n` +
        `I have automatically tracked this deadline and scheduled reminders for you.\n\n` +
        `Reply "stop" to cancel, or let me know if you would like to adjust the time.`;
    } else {
      // 2. Manual confirmation: save assignment as pending so persistent nudge can remind user if forgotten
      await tools.track_assignment({
        course_code: extraction.course_code,
        title: extraction.title || `${extraction.course_code || 'Course'} Deadline`,
        deadline_text: extraction.deadline_text,
        description: extraction.description,
        source_quote: extraction.quote
      });

      alertText =
        `${resolvedSender} just posted in ${groupTitle}:\n\n` +
        `"${verbatimQuote}"` +
        `${deadlineNote}\n\n` +
        `Would you like me to track this and set reminders for you?`;
    }

    // Step 5: Send DM
    console.log(`[ProactiveAlert] Sending alert to ${targetChat}...`);
    await sendTextMessage(targetChat, alertText);
    console.log(`[ProactiveAlert] Alert sent successfully for message ${messageId}.`);

  } catch (err) {
    // Never crash the server over a background alert failure
    console.error('[ProactiveAlert] Pipeline error:', err.message);
  }
}

