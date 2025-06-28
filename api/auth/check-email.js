// Versión mínima para debugging - sin imports complejos
console.log('📦 MODULO CHECK-EMAIL CARGÁNDOSE...');

try {
  require('dotenv').config();
  console.log('✅ Dotenv configurado');
} catch (error) {
  console.error('❌ Error cargando dotenv:', error);
}

// Función para parsear el body manualmente en Vercel
async function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        console.log('📦 Raw body recibido:', body);
        if (body.trim().length === 0) {
          resolve({});
        } else {
          const parsed = JSON.parse(body);
          console.log('✅ Body parseado exitosamente:', parsed);
          resolve(parsed);
        }
      } catch (error) {
        console.error('❌ Error parseando JSON:', error);
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// Vercel serverless function handler
module.exports = async (req, res) => {
  console.log('🎯 CHECK-EMAIL ENDPOINT EJECUTÁNDOSE');
  console.log('🎯 Timestamp:', new Date().toISOString());
  console.log('🎯 Method:', req.method);
  console.log('🎯 Headers completos:', JSON.stringify(req.headers, null, 2));
  console.log('🎯 Content-Type:', req.headers['content-type']);
  console.log('🎯 Content-Length:', req.headers['content-length']);
  
  try {
    console.log('🎯 req.body automático:', req.body);
    console.log('🎯 req.body type:', typeof req.body);
    console.log('🎯 req.body keys:', req.body ? Object.keys(req.body) : 'No keys');
    
    // Only allow POST requests
    if (req.method !== 'POST') {
      console.log('❌ Método no permitido:', req.method);
      return res.status(405).json({
        success: false,
        message: 'Method not allowed. Only POST requests are supported.'
      });
    }
    
    console.log('✅ Método POST confirmado');
    
    // Intentar parsear el body manualmente si req.body está vacío
    let requestBody = req.body;
    if (!requestBody || Object.keys(requestBody).length === 0) {
      console.log('⚠️ req.body está vacío, intentando parsing manual...');
      requestBody = await parseRequestBody(req);
      console.log('📦 Body parseado manualmente:', requestBody);
    }
    
    // Validación básica de email
    const { email } = requestBody || {};
    console.log('🔍 Email extraído:', email);
    console.log('🔍 Tipo de email:', typeof email);
    console.log('🔍 RequestBody usado:', requestBody);
    
    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      console.log('❌ Email inválido o vacío');
      console.log('❌ Debug info: email =', email, ', typeof =', typeof email);
      console.log('❌ Debug requestBody =', requestBody);
      console.log('❌ Debug req.body original =', req.body);
      return res.status(400).json({
        success: false,
        message: 'Email es requerido',
        debug: {
          received: email,
          type: typeof email,
          requestBody: requestBody,
          originalReqBody: req.body,
          headers: req.headers,
          contentType: req.headers['content-type']
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