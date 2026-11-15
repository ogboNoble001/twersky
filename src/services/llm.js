const { GoogleGenerativeAI } = require('@google/generative-ai');
const { verifyQuoteInMessage } = require('../utils/helpers');
require('dotenv').config();

const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const GEMINI_KEYS = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;

/**
 * Calls LLM with automatic key rotation and retry on 503/429
 */
async function callLLM(systemPrompt, userPrompt) {
  let lastError = null;
  const attempts = Math.max(GEMINI_KEYS.length, 1);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const currentKey = GEMINI_KEYS[(keyIndex + attempt) % GEMINI_KEYS.length];
    try {
      const genAI = new GoogleGenerativeAI(currentKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nTask:\n${userPrompt}` }] }],
        generationConfig: { responseMimeType: 'application/json' }
      });
      keyIndex = (keyIndex + attempt) % GEMINI_KEYS.length;
      return JSON.parse(result.response.text() || '{}');
    } catch (err) {
      console.warn(`[LLM] Attempt with key ${attempt} failed: ${err.message}. Retrying with next available key...`);
      lastError = err;
    }
  }

  throw lastError || new Error('All Gemini API attempts failed.');
}

/**
 * Extracts assignment details from a message with strict quote verification.
 * Discards any claim that doesn't match a verbatim quote in the original text.
 */
async function extractAssignmentFromMessage(messageText) {
  const systemPrompt = `You are a strict academic assistant.
Your job is to read a message and determine if it announces or updates an assignment, report, submission, or class change.
CRITICAL ACCURACY RULES:
1. ONLY use facts explicitly stated in the message.
2. If any detail (e.g. exact submission time, venue, deadline) is not mentioned, label it strictly as "not stated" or null.
3. You MUST provide the exact verbatim quote ("quote") from the text that proves each detail.
4. Output strictly valid JSON matching:
{
  "is_assignment": boolean,
  "course_code": string or null,
  "title": string or null,
  "deadline_text": string or null,
  "description": string or null,
  "quote": string (verbatim excerpt from message proving this),
  "is_important": boolean
}`;

  const extraction = await callLLM(systemPrompt, messageText);

  if (!extraction.is_assignment) {
    return null;
  }

  // Strict code verification: Verbatim quote check
  if (extraction.quote && !verifyQuoteInMessage(messageText, extraction.quote)) {
    console.warn(`[LLM Check] Quote verification failed! Discarding hallucinated extraction. Quote: "${extraction.quote}"`);
    return null;
  }

  return extraction;
}

module.exports = {
  callLLM,
  extractAssignmentFromMessage
};
