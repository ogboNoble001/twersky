/**
 * Normalizes a phone number/JID to digits only for comparison
 * @param {string} jidOrNumber
 */
function normalizePhone(jidOrNumber) {
  if (!jidOrNumber) return '';
  return jidOrNumber.replace(/@.*$/, '').replace(/[^0-9]/g, '');
}

/**
 * Checks if the incoming message is from the authorized user
 * @param {string} senderJid
 * @param {string} authorizedUserConfig
 */
function isAuthorizedUser(senderJid, authorizedUserConfig) {
  const normSender = normalizePhone(senderJid);
  const normAuth = normalizePhone(authorizedUserConfig);
  return Boolean(normSender && normAuth && normSender === normAuth);
}

/**
 * Verifies if an extracted quote actually exists verbatim inside the source message.
 * Strict rule: If it does not exist verbatim, throw it away.
 * @param {string} originalMessage
 * @param {string} quote
 */
function verifyQuoteInMessage(originalMessage, quote) {
  if (!originalMessage || !quote) return false;
  const cleanOriginal = originalMessage.toLowerCase().replace(/\s+/g, ' ').trim();
  const cleanQuote = quote.toLowerCase().replace(/\s+/g, ' ').trim();
  return cleanOriginal.includes(cleanQuote);
}

module.exports = {
  normalizePhone,
  isAuthorizedUser,
  verifyQuoteInMessage
};
