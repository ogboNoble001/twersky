const express = require('express');
const router = express.Router();
const supabase = require('../db/client');
const { isAuthorizedUser } = require('../utils/helpers');
const { handleUserCommand } = require('../services/commandHandler');

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

    // Destructure message fields from WAHA payload
    const {
      id: messageId,
      from,             // JID of chat (can be group e.g. 123@g.us or user 234...@c.us)
      fromMe,           // Boolean: was this sent by the bot's line itself?
      sender,           // In groups, the participant's JID
      body,
      hasMedia,
      media,
      timestamp
    } = payload;

    // Rule: Ignore the bot's own outgoing messages
    if (fromMe) {
      return res.status(200).json({ status: 'ignored_self_message' });
    }

    const actualSender = sender || from;
    const isDirectMessage = !from.endsWith('@g.us');

    console.log(`[Webhook] Incoming message from: ${actualSender} in chat: ${from}`);

    // Check if message is a direct command from the main user
    const authorizedUser = process.env.USER_PHONE_NUMBER;
    if (isDirectMessage && isAuthorizedUser(payload, authorizedUser)) {
      // Process direct user command
      await handleUserCommand(payload);
      return res.status(200).json({ status: 'command_processed' });
    }

    // Group Message / Monitored message: Save word-for-word in raw_messages
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
