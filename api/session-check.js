// Session check endpoint for verifying authentication
const session = require('express-session');

// Configurar sesión para serverless (mismo que login.js)
const sessionMiddleware = session({
  secret: 'b2b-portal-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 // 24 horas
  }
});

// Vercel serverless function handler
module.exports = async (req, res) => {
  console.log('🔍 SESSION-CHECK ENDPOINT EJECUTÁNDOSE');
  console.log('🔍 Method:', req.method);
  console.log('🔍 Headers:', JSON.stringify(req.headers, null, 2));
  
  try {
    // Apply session middleware
    await new Promise((resolve, reject) => {
      sessionMiddleware(req, res, (err) => {
        if (err) {
          console.error('❌ Error configurando sesión en session-check:', err);
          reject(err);
        } else {
          console.log('✅ Sesión configurada correctamente en session-check');
          resolve();
        }
      });
    });
    
    // Verificar si existe sesión de usuario
    console.log('🔍 req.session:', req.session);
    console.log('🔍 req.session.customer:', req.session?.customer);
    
    if (req.session && req.session.customer && req.session.customer.isAuthenticated) {
      console.log('✅ Sesión válida encontrada');
      console.log('👤 Usuario autenticado:', req.session.customer.email);
      
      return res.status(200).json({
        success: true,
        authenticated: true,
        message: 'Sesión válida',
        customer: {
          email: req.session.customer.email,
          firstName: req.session.customer.firstName,
          lastName: req.session.customer.lastName,
          company: req.session.customer.company
        }
      });
    } else {
      console.log('❌ No hay sesión válida');
      console.log('🔍 Session exists:', !!req.session);
      console.log('🔍 Customer exists:', !!req.session?.customer);
      console.log('🔍 Is authenticated:', req.session?.customer?.isAuthenticated);
      
      return res.status(401).json({
        success: false,
        authenticated: false,
        message: 'No hay sesión válida'
      });
    }
    
  } catch (error) {
    console.error('💥 ERROR EN SESSION-CHECK:', error);
    
    return res.status(500).json({
      success: false,
      authenticated: false,
      message: 'Error verificando sesión: ' + error.message
    });
  }
};