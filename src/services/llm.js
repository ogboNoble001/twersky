const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { verifyQuoteInMessage } = require('../utils/helpers');
require('dotenv').config();

let groq = null;
if (process.env.GROQ_API_KEY) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
}

let gemini = null;
if (process.env.GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
}

/**
 * Calls LLM (Groq preferred, fallback to Gemini) with a system instruction and user prompt
 */
async function callLLM(systemPrompt, userPrompt) {
  if (groq) {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    return JSON.parse(chatCompletion.choices[0]?.message?.content || '{}');
  } else if (gemini) {
    const result = await gemini.generateContent({
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nTask:\n${userPrompt}` }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });
    return JSON.parse(result.response.text() || '{}');
  } else {
    throw new Error('Neither GROQ_API_KEY nor GEMINI_API_KEY is configured.');
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
