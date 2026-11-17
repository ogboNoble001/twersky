const express = require('express');
const router = express.Router();
const supabase = require('../db/client');
const { isAuthorizedUser } = require('../utils/helpers');
const { orchestrateUserCommand } = require('../services/agentOrchestrator');

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

    const actualSender = sender || from;
    const isDirectMessage = !from.endsWith('@g.us');

    // Rule 3: Drop newsletter channel messages entirely — they are broadcast-only noise
    if (from.endsWith('@newsletter')) {
      return res.status(200).json({ status: 'ignored_newsletter' });
    }

    // Rule 4: For group messages, only save if the group is in our monitored_chats table
    if (from.endsWith('@g.us')) {
      const { data: monitoredGroup } = await supabase
        .from('monitored_chats')
        .select('id')
        .eq('chat_id', from)
        .single();

      if (!monitoredGroup) {
        // Not a monitored group — silently ignore
        return res.status(200).json({ status: 'ignored_unmonitored_group' });
      }
    }

    console.log(`[Webhook] Incoming message from: ${actualSender} in chat: ${from}`);

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
      sender_name: payload._data?.notifyName || null,
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

    return res.status(200).json({ status: 'saved' });
  } catch (err) {
    console.error('[Webhook] Error processing event:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

