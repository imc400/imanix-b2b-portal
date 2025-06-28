// Vercel entry point - redirects to server-auth
console.log('🎬 API INDEX.JS - Entry point ejecutándose');
console.log('🎬 Timestamp:', new Date().toISOString());

const app = require('./server-auth');
module.exports = app;