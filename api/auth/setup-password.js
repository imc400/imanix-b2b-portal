// Setup password endpoint for first-time users
console.log('📦 MODULO SETUP-PASSWORD CARGÁNDOSE...');

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
  console.log('🔐 SETUP-PASSWORD ENDPOINT EJECUTÁNDOSE');
  console.log('🔐 Timestamp:', new Date().toISOString());
  console.log('🔐 Method:', req.method);
  console.log('🔐 Headers completos:', JSON.stringify(req.headers, null, 2));
  console.log('🔐 Content-Type:', req.headers['content-type']);
  
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
    
    // Extraer datos del request con múltiples variantes de nombres
    const { 
      email, 
      password,
      confirmPassword,
      confirm_password,
      passwordConfirm,
      password_confirm,
      confirmPass,
      confirm_pass
    } = requestBody || {};
    
    // Determinar qué campo de confirmación usar
    const actualConfirmPassword = confirmPassword || confirm_password || passwordConfirm || password_confirm || confirmPass || confirm_pass;
    
    console.log('🔍 Datos extraídos:');
    console.log('🔍 Email:', email);
    console.log('🔍 Password length:', password ? password.length : 'No password');
    console.log('🔍 RequestBody completo:', JSON.stringify(requestBody, null, 2));
    console.log('🔍 Campos de confirmación disponibles:');
    console.log('🔍   confirmPassword:', !!confirmPassword);
    console.log('🔍   confirm_password:', !!confirm_password);
    console.log('🔍   passwordConfirm:', !!passwordConfirm);
    console.log('🔍   password_confirm:', !!password_confirm);
    console.log('🔍   confirmPass:', !!confirmPass);
    console.log('🔍   confirm_pass:', !!confirm_pass);
    console.log('🔍 Campo de confirmación usado:', actualConfirmPassword ? 'Encontrado' : 'No encontrado');
    console.log('🔍 Confirm password length:', actualConfirmPassword ? actualConfirmPassword.length : 'No confirm password');
    
    if (password && actualConfirmPassword) {
      console.log('🔍 Password primeros 3 chars:', password.substring(0, 3) + '...');
      console.log('🔍 ConfirmPassword primeros 3 chars:', actualConfirmPassword.substring(0, 3) + '...');
      console.log('🔍 Password últimos 3 chars:', '...' + password.substring(password.length - 3));
      console.log('🔍 ConfirmPassword últimos 3 chars:', '...' + actualConfirmPassword.substring(actualConfirmPassword.length - 3));
    }
    
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
    if (!password || typeof password !== 'string' || password.length < 6) {
      console.log('❌ Contraseña inválida o muy corta');
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 6 caracteres'
      });
    }
    
    // Validar confirmación de contraseña con debugging detallado
    console.log('🔍 Validando coincidencia de contraseñas...');
    console.log('🔍 Password está definido:', !!password);
    console.log('🔍 ActualConfirmPassword está definido:', !!actualConfirmPassword);
    console.log('🔍 Password === actualConfirmPassword:', password === actualConfirmPassword);
    
    if (!actualConfirmPassword) {
      console.log('❌ ConfirmPassword faltante en todos los campos posibles');
      return res.status(400).json({
        success: false,
        message: 'Confirmación de contraseña es requerida',
        debug: {
          hasPassword: !!password,
          hasConfirmPassword: !!actualConfirmPassword,
          availableFields: Object.keys(requestBody || {}),
          requestBody: requestBody
        }
      });
    }
    
    if (password !== actualConfirmPassword) {
      console.log('❌ Las contraseñas no coinciden - debugging detallado:');
      console.log('❌ Password length:', password ? password.length : 'undefined');
      console.log('❌ ActualConfirmPassword length:', actualConfirmPassword ? actualConfirmPassword.length : 'undefined');
      console.log('❌ Password type:', typeof password);
      console.log('❌ ActualConfirmPassword type:', typeof actualConfirmPassword);
      
      // Comparar character por character
      if (password && actualConfirmPassword) {
        const minLength = Math.min(password.length, actualConfirmPassword.length);
        for (let i = 0; i < minLength; i++) {
          if (password[i] !== actualConfirmPassword[i]) {
            console.log(`❌ Primer carácter diferente en posición ${i}: '${password[i]}' vs '${actualConfirmPassword[i]}'`);
            console.log(`❌ Código ASCII: ${password.charCodeAt(i)} vs ${actualConfirmPassword.charCodeAt(i)}`);
            break;
          }
        }
      }
      
      return res.status(400).json({
        success: false,
        message: 'Las contraseñas no coinciden',
        debug: {
          passwordLength: password ? password.length : 'undefined',
          confirmPasswordLength: actualConfirmPassword ? actualConfirmPassword.length : 'undefined',
          passwordType: typeof password,
          confirmPasswordType: typeof actualConfirmPassword,
          availableFields: Object.keys(requestBody || {}),
          requestBody: requestBody
        }
      });
    }
    
    console.log('✅ Todas las validaciones pasaron');
    console.log('✅ Email válido:', cleanEmail);
    console.log('✅ Contraseña válida y confirmada');
    
    // Simular guardado exitoso de contraseña
    // En la implementación completa aquí se hashearía la contraseña y se guardaría en la BD
    console.log('🗄️ Simulando guardado de contraseña en base de datos...');
    
    // Respuesta exitosa que permite continuar el flujo
    console.log('✅ Retornando respuesta de configuración exitosa');
    return res.status(200).json({
      success: true,
      message: 'Contraseña configurada exitosamente',
      nextStep: 'login_complete',
      customerData: {
        email: cleanEmail,
        firstName: 'Usuario',
        lastName: 'Temporal', 
        company: 'Empresa Test',
        discount: 40,
        tags: 'b2b40',
        hasPassword: true
      },
      debug: {
        mode: 'temporal_password_setup',
        timestamp: new Date().toISOString(),
        passwordLength: password.length
      }
    });
    
  } catch (error) {
    console.error('💥 ERROR EN SETUP-PASSWORD:', error);
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