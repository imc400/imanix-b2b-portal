// Login endpoint for existing users
console.log('📦 MODULO LOGIN CARGÁNDOSE...');

try {
  require('dotenv').config();
  console.log('✅ Dotenv configurado');
} catch (error) {
  console.error('❌ Error cargando dotenv:', error);
}

// Importar dependencias
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

// Configurar Supabase directamente
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('🔍 SUPABASE_URL configurado:', !!supabaseUrl);
console.log('🔍 SUPABASE_SERVICE_KEY configurado:', !!supabaseKey);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Función para verificar contraseña
async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
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
  console.log('🔐 LOGIN ENDPOINT EJECUTÁNDOSE');
  console.log('🔐 Timestamp:', new Date().toISOString());
  console.log('🔐 Method:', req.method);
  console.log('🔐 Headers completos:', JSON.stringify(req.headers, null, 2));
  
  try {
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
    
    // Extraer datos del request
    const { email, password } = requestBody || {};
    console.log('🔍 Datos extraídos:');
    console.log('🔍 Email:', email);
    console.log('🔍 Password length:', password ? password.length : 'No password');
    
    // Validar email
    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      console.log('❌ Email inválido o vacío');
      return res.status(400).json({
        success: false,
        message: 'Email es requerido',
        debug: {
          received: email,
          type: typeof email,
          requestBody: requestBody
        }
      });
    }
    
    const cleanEmail = email.trim();
    
    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      console.log('❌ Email con formato inválido:', cleanEmail);
      return res.status(400).json({
        success: false,
        message: 'Formato de email inválido'
      });
    }
    
    // Validar contraseña
    if (!password || typeof password !== 'string' || password.length === 0) {
      console.log('❌ Contraseña inválida o vacía');
      return res.status(400).json({
        success: false,
        message: 'Contraseña es requerida'
      });
    }
    
    console.log('✅ Datos de entrada validados');
    
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
    
    // Consultar usuario en la base de datos
    console.log('🔍 Consultando usuario en base de datos...');
    try {
      const { data: userProfile, error: fetchError } = await supabase
        .from('user_profiles')
        .select('email, password_hash, first_name, last_name, company_name')
        .eq('email', cleanEmail)
        .single();
      
      if (fetchError) {
        console.error('❌ Error consultando base de datos:', fetchError);
        if (fetchError.code === 'PGRST116') {
          // Usuario no encontrado
          return res.status(401).json({
            success: false,
            message: 'Credenciales inválidas',
            debug: {
              reason: 'user_not_found'
            }
          });
        }
        throw fetchError;
      }
      
      if (!userProfile || !userProfile.password_hash) {
        console.log('❌ Usuario sin contraseña configurada');
        return res.status(401).json({
          success: false,
          message: 'Usuario no tiene contraseña configurada',
          debug: {
            reason: 'no_password_set'
          }
        });
      }
      
      console.log('👤 Usuario encontrado, verificando contraseña...');
      
      // Verificar contraseña con bcrypt
      const passwordMatch = await verifyPassword(password, userProfile.password_hash);
      
      if (!passwordMatch) {
        console.log('❌ Contraseña incorrecta');
        return res.status(401).json({
          success: false,
          message: 'Credenciales inválidas',
          debug: {
            reason: 'password_mismatch'
          }
        });
      }
      
      console.log('✅ Contraseña correcta, estableciendo sesión...');
      
      // Establecer sesión (simulada para serverless)
      // En una implementación completa, aquí crearías un JWT o session token
      
      // Respuesta exitosa de login
      console.log('✅ Login exitoso, retornando respuesta');
      return res.status(200).json({
        success: true,
        message: 'Login exitoso',
        nextStep: 'portal_access',
        profileCompleted: true, // User has successfully logged in, assume profile is complete
        customerData: {
          email: cleanEmail,
          firstName: userProfile.first_name || 'Usuario',
          lastName: userProfile.last_name || 'B2B',
          company: userProfile.company_name || 'Empresa'
        },
        redirect: '/portal',
        debug: {
          loginTime: new Date().toISOString(),
          mode: 'real_authentication'
        }
      });
      
    } catch (dbError) {
      console.error('❌ Error en base de datos durante login:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Error interno del servidor: ' + dbError.message,
        debug: {
          error: dbError.message,
          code: dbError.code
        }
      });
    }
    
  } catch (error) {
    console.error('💥 ERROR EN LOGIN ENDPOINT:', error);
    console.error('💥 Error stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor: ' + error.message,
      debug: {
        error: error.message,
        stack: error.stack
      }
    });
  }
};