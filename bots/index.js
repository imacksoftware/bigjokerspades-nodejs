// ./bots/index.js
const defaultBot = require('./default');

function getBot(persona) {
  const p = String(persona || 'default').toLowerCase();
  if (p === 'default') return defaultBot;
  // future personas go here
  return defaultBot;
}

module.exports = { getBot };