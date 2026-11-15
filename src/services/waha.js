const axios = require('axios');
require('dotenv').config();

const WAHA_API_URL = (process.env.WAHA_API_URL || 'https://twersky-waha.onrender.com').replace(/\/$/, '');
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

/**
 * Send a plain WhatsApp text message via WAHA
 * @param {string} chatId - recipient phone JID (e.g. 23480...@c.us or @lid)
 * @param {string} text - message body
 */
async function sendTextMessage(chatId, text) {
  try {
    const url = `${WAHA_API_URL}/api/sendText`;
    const response = await axios.post(
      url,
      {
        session: WAHA_SESSION,
        chatId: chatId,
        text: text
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {})
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error(`[WAHA] Error sending text to ${chatId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Fetches all WhatsApp groups that the bot currently participates in, with real titles
 */
async function getWhatsAppGroups() {
  try {
    const url = `${WAHA_API_URL}/api/${WAHA_SESSION}/groups`;
    const response = await axios.get(url, {
      headers: {
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {})
      },
      timeout: 10000
    });

    if (!response.data || typeof response.data !== 'object') {
      return [];
    }

    return Object.values(response.data).map(g => ({
      chat_id: g.id,
      name: g.subject || g.name || g.id,
      member_count: g.size || 0
    }));
  } catch (err) {
    console.warn('[WAHA] Failed to fetch groups from WAHA:', err.message);
    return [];
  }
}

module.exports = {
  sendTextMessage,
  getWhatsAppGroups,
  WAHA_API_URL,
  WAHA_SESSION
};
