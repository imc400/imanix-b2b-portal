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
    
    // Respuesta mínima de éxito para probar que el endpoint funciona
    console.log('✅ Retornando respuesta de prueba exitosa');
    return res.status(200).json({
      success: true,
      status: 'test_mode',
      message: 'Endpoint funcionando - modo prueba',
      debug: {
        timestamp: new Date().toISOString(),
        method: req.method,
        hasBody: !!req.body,
        bodyType: typeof req.body
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