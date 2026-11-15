const axios = require('axios');
require('dotenv').config();

const WAHA_API_URL = (process.env.WAHA_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

/**
 * Send a plain WhatsApp text message via WAHA
 * @param {string} chatId - recipient phone JID (e.g. 23480...@c.us)
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

module.exports = {
  sendTextMessage,
  WAHA_API_URL,
  WAHA_SESSION
};
