const { GoogleGenAI } = require('@google/genai');
const { verifyQuoteInMessage } = require('../utils/helpers');
require('dotenv').config();

function getGeminiKeys() {
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return rawKeys.split(',').map(k => k.trim()).filter(Boolean);
}

let keyIndex = 0;

/**
 * Calls Gemini using the modern @google/genai SDK with automatic key rotation and resilience.
 */
async function callLLM(systemPrompt, userPrompt) {
  let lastError = null;
  const geminiKeys = getGeminiKeys();
  const attempts = Math.max(geminiKeys.length, 1);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const currentKey = geminiKeys[(keyIndex + attempt) % geminiKeys.length];
    try {
      const ai = new GoogleGenAI({ apiKey: currentKey, apiVersion: 'v1beta' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `${systemPrompt}\n\nTask:\n${userPrompt}`,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const responseText = response.text || '';
      keyIndex = (keyIndex + attempt) % geminiKeys.length;
      return JSON.parse(responseText.trim() || '{}');
    } catch (err) {
      console.warn(`[LLM] Attempt with key #${(keyIndex + attempt) % geminiKeys.length} failed: ${err.message}. Rotating key...`);
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

  // Strict verification: Verbatim quote check against original message
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
