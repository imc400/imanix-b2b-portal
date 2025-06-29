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
const SupabaseSessionStore = require('../session-store');

// Configurar Supabase directamente
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('🔍 SUPABASE_URL configurado:', !!supabaseUrl);
console.log('🔍 SUPABASE_SERVICE_KEY configurado:', !!supabaseKey);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Inicializar Session Store de Supabase
const sessionStore = new SupabaseSessionStore();

// Inicializar tabla de sesiones al arrancar
sessionStore.ensureSessionsTable().then(success => {
  if (success) {
    console.log('✅ Sessions table ready in login module');
  } else {
    console.log('⚠️ Sessions table initialization failed in login module');
  }
});

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

// Vercel serverless function handler with session support
module.exports = async (req, res) => {
  console.log('🔐 LOGIN ENDPOINT EJECUTÁNDOSE');
  console.log('🔐 Timestamp:', new Date().toISOString());
  console.log('🔐 Method:', req.method);
  console.log('🔐 Headers completos:', JSON.stringify(req.headers, null, 2));
  
  // Configurar sesión personalizada compatible con SupabaseSessionStore
  try {
    // Obtener sessionId de las cookies
    const sessionId = req.headers.cookie?.split(';')
      .find(c => c.trim().startsWith('imanix.b2b.session='))
      ?.split('=')[1] || null;

    console.log('🔍 Session middleware LOGIN - SessionId from cookie:', sessionId);

    // Inicializar objeto session en req
    req.session = {
      sessionId: sessionId,
      regenerate: async function() {
        const newSessionId = sessionStore.generateSessionId();
        this.sessionId = newSessionId;
        res.cookie('imanix.b2b.session', newSessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          maxAge: 24 * 60 * 60 * 1000, // 24 horas
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
        });
        console.log('🔄 Session regenerated in login:', newSessionId);
      },
      save: async function() {
        if (!this.sessionId) {
          // Crear sessionId si no existe
          const newSessionId = sessionStore.generateSessionId();
          this.sessionId = newSessionId;
          res.cookie('imanix.b2b.session', newSessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000, // 24 horas
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
          });
          console.log('🆔 SessionId created in login:', newSessionId);
        }
        
        const sessionData = { ...this };
        delete sessionData.sessionId;
        delete sessionData.regenerate;
        delete sessionData.save;
        await sessionStore.setSession(this.sessionId, sessionData);
        console.log('💾 Session saved in login:', this.sessionId);
      }
    };

    // Cargar datos de sesión existente si hay sessionId
    if (sessionId) {
      const sessionData = await sessionStore.getSession(sessionId);
      if (sessionData) {
        // Fusionar datos de sesión existentes
        Object.assign(req.session, sessionData);
        req.session.sessionId = sessionId; // Asegurar que sessionId se mantenga
        console.log('✅ Session loaded in login for:', sessionData.customer?.email || 'anonymous');
      } else {
        console.log('📭 No valid session found in login, creating new session');
        // Crear nueva sesión si no existe o expiró
        await req.session.regenerate();
      }
    } else {
      console.log('🆕 No sessionId found in login, creating new session immediately');
      // Crear sessionId inmediatamente
      await req.session.regenerate();
    }

    console.log('✅ Sesión configurada correctamente');
  } catch (sessionError) {
    console.error('❌ Error configurando sesión:', sessionError);
    // Continue with limited functionality
  }
  
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
      
      console.log('✅ Contraseña correcta, cargando datos de Shopify...');
      
      // Buscar cliente en Shopify para obtener tags y descuentos
      let shopifyCustomer = null;
      try {
        const shopifyResponse = await fetch(`https://braintoys-chile.myshopify.com/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(cleanEmail)}`, {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        
        if (shopifyResponse.ok) {
          const shopifyData = await shopifyResponse.json();
          shopifyCustomer = shopifyData.customers && shopifyData.customers.length > 0 ? shopifyData.customers[0] : null;
          console.log('🛍️ Cliente encontrado en Shopify:', !!shopifyCustomer);
          if (shopifyCustomer) {
            console.log('🏷️ Tags de Shopify:', shopifyCustomer.tags);
          }
        }
      } catch (shopifyError) {
        console.error('⚠️ Error cargando datos de Shopify:', shopifyError.message);
      }
      
      // Establecer sesión real para el portal con datos de Shopify
      req.session.customer = {
        email: cleanEmail,
        firstName: userProfile.first_name || shopifyCustomer?.first_name || 'Usuario',
        lastName: userProfile.last_name || shopifyCustomer?.last_name || 'B2B',
        company: userProfile.company_name || shopifyCustomer?.default_address?.company || 'Empresa',
        tags: shopifyCustomer?.tags || '',
        discount: 0, // Se calculará desde tags
        isAuthenticated: true
      };
      
      console.log('✅ Sesión establecida con datos de Shopify:', req.session.customer);
      
      // GUARDAR SESIÓN EN SUPABASE
      await req.session.save();
      console.log('💾 Sesión guardada exitosamente en Supabase');
      
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
        shouldRedirect: true,
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