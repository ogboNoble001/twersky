const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');
const { verifyQuoteInMessage } = require('../utils/helpers');
require('dotenv').config();

function getGeminiKeys() {
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return rawKeys.split(',').map(k => k.trim()).filter(Boolean);
}

let keyIndex = 0;

function safeJsonParse(str) {
  if (!str) return {};
  const cleaned = str.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    try {
      const sanitized = cleaned.replace(/[\n\r\t]/g, (match) => {
        if (match === '\n') return '\\n';
        if (match === '\r') return '\\r';
        if (match === '\t') return '\\t';
        return '';
      });
      return JSON.parse(sanitized);
    } catch (e2) {
      const match = cleaned.match(/"response"\s*:\s*"([\s\S]*?)"\s*\}/);
      if (match) return { response: match[1] };
      throw e;
    }
  }
}

function withTimeout(promise, ms, desc) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout of ${ms}ms exceeded for ${desc}`)), ms))
  ]);
}

/**
 * Fallback to Groq when all Gemini keys are exhausted.
 */
async function callGroq(systemPrompt, userPrompt) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error('No GROQ_API_KEY set.');

  const groq = new Groq({ apiKey: groqKey });
  const models = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
  let lastErr = null;

  for (const model of models) {
    try {
      const completion = await withTimeout(
        groq.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt + '\n\nIMPORTANT: Output ONLY valid JSON. No markdown, no explanation.' },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' }
        }),
        25000,
        `Groq model ${model}`
      );

      const text = completion.choices[0]?.message?.content || '';
      console.log(`[LLM] Groq fallback used successfully with model: ${model}`);
      return safeJsonParse(text);
    } catch (err) {
      console.warn(`[LLM] Groq model ${model} failed: ${err.message}. Trying next Groq model...`);
      lastErr = err;
    }
  }

  throw lastErr || new Error('All Groq fallback models failed.');
}

/**
 * Calls Gemini first (with key rotation). Falls back to Groq if all Gemini keys are quota-exhausted.
 */
async function callLLM(systemPrompt, userPrompt) {
  let lastError = null;
  const geminiKeys = getGeminiKeys();
  const attempts = Math.max(geminiKeys.length, 1);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const currentKey = geminiKeys[(keyIndex + attempt) % geminiKeys.length];
    try {
      const ai = new GoogleGenAI({ apiKey: currentKey, apiVersion: 'v1beta' });
      const response = await withTimeout(
        ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `${systemPrompt}\n\nTask:\n${userPrompt}`,
          config: { responseMimeType: 'application/json' }
        }),
        25000,
        `Gemini key #${(keyIndex + attempt) % geminiKeys.length}`
      );

      const responseText = response.text || '';
      keyIndex = (keyIndex + attempt) % geminiKeys.length;
      return safeJsonParse(responseText);
    } catch (err) {
      const is429 = err.message && err.message.includes('429');
      console.warn(`[LLM] Gemini key #${(keyIndex + attempt) % geminiKeys.length} failed${is429 ? ' (quota)' : ''}: rotating...`);
      lastError = err;
    }
  }

  // All Gemini keys exhausted — try Groq
  console.warn('[LLM] All Gemini keys failed. Trying Groq fallback...');
  try {
    return await callGroq(systemPrompt, userPrompt);
  } catch (groqErr) {
    console.error('[LLM] Groq fallback also failed:', groqErr.message);
    throw lastError || groqErr;
  }
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
