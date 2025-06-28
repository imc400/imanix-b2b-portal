// Check-email endpoint con verificación real de base de datos
console.log('📦 MODULO CHECK-EMAIL CARGÁNDOSE...');

try {
  require('dotenv').config();
  console.log('✅ Dotenv configurado');
} catch (error) {
  console.error('❌ Error cargando dotenv:', error);
}

// Importar Supabase para verificación real
const { createClient } = require('@supabase/supabase-js');

// Configurar Supabase directamente
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('🔍 SUPABASE_URL configurado:', !!supabaseUrl);
console.log('🔍 SUPABASE_SERVICE_KEY configurado:', !!supabaseKey);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

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
    
    // Verificar que Supabase esté configurado
    if (!supabase) {
      console.error('❌ Supabase no está configurado');
      return res.status(500).json({
        success: false,
        message: 'Base de datos no disponible',
        debug: {
          supabaseConfigured: false,
          hasUrl: !!supabaseUrl,
          hasKey: !!supabaseKey
        }
      });
    }
    
    // Consultar la base de datos para verificar si el usuario ya tiene contraseña
    console.log('🔍 Consultando base de datos para verificar usuario...');
    try {
      const { data: userProfile, error: fetchError } = await supabase
        .from('user_profiles')
        .select('email, password_hash, first_name, last_name, company_name')
        .eq('email', cleanEmail)
        .single();
      
      if (fetchError && fetchError.code !== 'PGRST116') {
        // Error diferente a "no encontrado"
        console.error('❌ Error consultando base de datos:', fetchError);
        throw fetchError;
      }
      
      if (!userProfile) {
        // Usuario no encontrado en nuestra base de datos
        console.log('👤 Usuario no encontrado en base de datos');
        return res.json({
          success: true,
          status: 'not_found',
          message: 'Usuario no encontrado en base de datos',
          nextStep: 'register',
          email: cleanEmail,
          debug: {
            userInDatabase: false,
            timestamp: new Date().toISOString()
          }
        });
      }
      
      console.log('👤 Usuario encontrado en base de datos');
      console.log('🔍 Tiene password_hash:', !!userProfile.password_hash);
      
      // Verificar si tiene contraseña
      const hasPassword = userProfile.password_hash && userProfile.password_hash.trim().length > 0;
      
      if (hasPassword) {
        // Usuario existente con contraseña - debe hacer login
        console.log('✅ Usuario existente con contraseña, requiere login');
        return res.json({
          success: true,
          status: 'existing_user',
          message: 'Usuario encontrado con contraseña',
          nextStep: 'password',
          email: cleanEmail,
          customerData: {
            email: cleanEmail,
            firstName: userProfile.first_name || 'Usuario',
            lastName: userProfile.last_name || 'B2B',
            company: userProfile.company_name || 'Empresa',
            hasPassword: true
          },
          debug: {
            userInDatabase: true,
            hasPassword: true,
            mode: 'real_database_check',
            timestamp: new Date().toISOString()
          }
        });
      } else {
        // Usuario existe pero no tiene contraseña - primera vez
        console.log('✅ Usuario existe pero sin contraseña, primera vez');
        return res.json({
          success: true,
          status: 'first_time',
          message: 'Primera vez en el portal',
          nextStep: 'create_password',
          email: cleanEmail,
          customerData: {
            email: cleanEmail,
            firstName: userProfile.first_name || 'Usuario',
            lastName: userProfile.last_name || 'B2B',
            company: userProfile.company_name || 'Empresa',
            hasPassword: false
          },
          debug: {
            userInDatabase: true,
            hasPassword: false,
            mode: 'real_database_check',
            timestamp: new Date().toISOString()
          }
        });
      }
      
    } catch (dbError) {
      console.error('❌ Error en consulta de base de datos:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Error consultando base de datos: ' + dbError.message,
        debug: {
          error: dbError.message,
          code: dbError.code
        }
      });
    }
    
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