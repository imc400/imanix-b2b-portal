require('dotenv').config();

// Importar funciones desde server-auth
const { findCustomerByEmail, extractB2BDiscount } = require('../server-auth');
const database = require('../database');

// Vercel serverless function handler
module.exports = async (req, res) => {
  console.log('🎯 CHECK-EMAIL ENDPOINT EJECUTÁNDOSE');
  console.log('🎯 Timestamp:', new Date().toISOString());
  console.log('🎯 Method:', req.method);
  console.log('🎯 Headers:', JSON.stringify(req.headers, null, 2));
  console.log('🎯 Body:', JSON.stringify(req.body, null, 2));
  
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed. Only POST requests are supported.'
    });
  }
  
  try {
    const { email } = req.body;
    
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
    
    console.log(`🔍 Verificando estado de email: ${cleanEmail}`);
    
    // Buscar cliente en Shopify
    const customer = await findCustomerByEmail(cleanEmail);
    if (!customer) {
      return res.json({
        success: true,
        status: 'not_found',
        message: 'Usuario no encontrado',
        nextStep: 'register',
        email: cleanEmail
      });
    }
    
    // Verificar acceso B2B
    const discount = extractB2BDiscount(customer.tags);
    if (discount === null) {
      return res.json({
        success: true,
        status: 'no_access',
        message: 'Sin acceso B2B',
        nextStep: 'contact_admin',
        email: cleanEmail
      });
    }
    
    // Verificar si tiene contraseña en nuestra base de datos
    let hasPassword = false;
    try {
      const { data: userProfile } = await database.supabase
        .from('user_profiles')
        .select('password_hash')
        .eq('email', cleanEmail)
        .single();
      
      hasPassword = userProfile && userProfile.password_hash;
    } catch (error) {
      console.log('Usuario no encontrado en base de datos, primera vez');
      hasPassword = false;
    }
    
    const customerData = {
      id: customer.id,
      email: customer.email,
      firstName: customer.first_name,
      lastName: customer.last_name,
      company: customer.company,
      discount: discount,
      tags: customer.tags
    };
    
    if (hasPassword) {
      // Usuario existente con contraseña
      return res.json({
        success: true,
        status: 'existing_user',
        message: 'Usuario encontrado',
        nextStep: 'password',
        customerData: customerData
      });
    } else {
      // Usuario existente sin contraseña (primera vez)
      return res.json({
        success: true,
        status: 'first_time',
        message: 'Primera vez en el portal',
        nextStep: 'create_password',
        customerData: customerData
      });
    }
    
  } catch (error) {
    console.error('💥 ERROR EN CHECK-EMAIL:', error);
    console.error('💥 Error stack:', error.stack);
    
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor: ' + error.message,
      debug: {
        error: error.message,
        stack: error.stack
      }
    });
  }
};