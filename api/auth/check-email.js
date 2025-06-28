// Versión mínima para debugging - sin imports complejos
console.log('📦 MODULO CHECK-EMAIL CARGÁNDOSE...');

try {
  require('dotenv').config();
  console.log('✅ Dotenv configurado');
} catch (error) {
  console.error('❌ Error cargando dotenv:', error);
}

// Vercel serverless function handler - versión mínima
module.exports = async (req, res) => {
  console.log('🎯 CHECK-EMAIL ENDPOINT EJECUTÁNDOSE - VERSIÓN MÍNIMA');
  console.log('🎯 Timestamp:', new Date().toISOString());
  console.log('🎯 Method:', req.method);
  
  try {
    console.log('🎯 Headers disponibles:', !!req.headers);
    console.log('🎯 Body disponible:', !!req.body);
    console.log('🎯 Body type:', typeof req.body);
    
    // Only allow POST requests
    if (req.method !== 'POST') {
      console.log('❌ Método no permitido:', req.method);
      return res.status(405).json({
        success: false,
        message: 'Method not allowed. Only POST requests are supported.'
      });
    }
    
    console.log('✅ Método POST confirmado');
    
    // Validación básica de email
    const { email } = req.body || {};
    console.log('🔍 Email extraído:', email);
    console.log('🔍 Tipo de email:', typeof email);
    
    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      console.log('❌ Email inválido o vacío');
      return res.status(400).json({
        success: false,
        message: 'Email es requerido',
        debug: {
          received: email,
          type: typeof email,
          body: req.body
        }
      });
    }
    
    const cleanEmail = email.trim();
    console.log('🔍 Email limpio:', cleanEmail);
    
    // Validación básica de formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      console.log('❌ Email con formato inválido:', cleanEmail);
      return res.status(400).json({
        success: false,
        message: 'Formato de email inválido',
        debug: {
          email: cleanEmail,
          regexTest: emailRegex.test(cleanEmail)
        }
      });
    }
    
    console.log('✅ Email válido:', cleanEmail);
    
    // Respuesta temporal que simula usuario existente sin contraseña (primera vez)
    // Esto permitirá que el frontend proceda al siguiente paso del flujo
    console.log('✅ Retornando respuesta temporal de primera vez');
    return res.status(200).json({
      success: true,
      status: 'first_time',
      message: 'Primera vez en el portal',
      nextStep: 'create_password',
      email: cleanEmail,
      customerData: {
        email: cleanEmail,
        firstName: 'Usuario',
        lastName: 'Temporal',
        company: 'Empresa Test',
        discount: 40,
        tags: 'b2b40'
      },
      debug: {
        mode: 'temporal_testing',
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('💥 ERROR EN ENDPOINT MÍNIMO:', error);
    console.error('💥 Error stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      message: 'Error en endpoint mínimo: ' + error.message,
      debug: {
        error: error.message,
        stack: error.stack
      }
    });
  }
};