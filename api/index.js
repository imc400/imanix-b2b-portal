// Vercel entry point - redirects to server-auth
console.log('🎬 API INDEX.JS - Entry point ejecutándose');
console.log('🎬 Timestamp:', new Date().toISOString());

module.exports = require('./server-auth');