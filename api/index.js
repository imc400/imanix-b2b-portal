const express = require('express');
const fs = require('fs').promises;
const session = require('express-session');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const database = require('../database');
require('dotenv').config();

// Configuración de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'imanix-b2b',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuración de Nodemailer para Gmail
let transporter = null;

try {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
    console.log('✅ Configuración de email inicializada correctamente');
  } else {
    console.log('⚠️ Variables de email no configuradas, emails deshabilitados');
  }
} catch (error) {
  console.error('❌ Error configurando email:', error);
  transporter = null;
}

const app = express();
// Port is handled by Vercel automatically

// Configuración de sesiones
app.use(session({
  secret: 'b2b-portal-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // En producción cambiar a true con HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 horas
  }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware de debugging global para capturar todas las requests a auth
app.use('/api/auth/*', (req, res, next) => {
  console.log('🚀 DEBUGGING MIDDLEWARE - Interceptando request a:', req.path);
  console.log('🚀 Method:', req.method);
  console.log('🚀 Headers completos:', JSON.stringify(req.headers, null, 2));
  console.log('🚀 Content-Type:', req.get('Content-Type'));
  console.log('🚀 Request body antes de parsing:', JSON.stringify(req.body, null, 2));
  console.log('🚀 Body type:', typeof req.body);
  console.log('🚀 Body keys:', req.body ? Object.keys(req.body) : 'No body');
  console.log('🚀 Raw body available:', !!req.rawBody);
  next();
});

// Configuración de multer para upload de comprobantes (memory storage para Vercel)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máximo
  fileFilter: function (req, file, cb) {
    // Aceptar solo imágenes y PDFs
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen (JPG, PNG, etc.) o PDF'));
    }
  }
});

// Configuración de Shopify API
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'braintoys-chile.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

// Función para buscar cliente en Shopify por email
async function findCustomerByEmail(email) {
  try {
    const response = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(email)}`, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status}`);
    }

    const data = await response.json();
    return data.customers && data.customers.length > 0 ? data.customers[0] : null;
  } catch (error) {
    console.error('Error buscando cliente:', error);
    return null;
  }
}

// Función para generar template HTML del email
function generateOrderEmailHTML(customer, cartItems, orderData) {
  const customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'N/A';
  const companyName = customer.company || 'N/A';
  const discountPercentage = customer.discount || 0;
  
  // Calcular totales con desglose de IVA
  const subtotalConIva = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const subtotalNeto = subtotalConIva / 1.19;
  const ivaTotal = subtotalConIva - subtotalNeto;
  const discountAmount = subtotalConIva * (discountPercentage / 100);
  const total = subtotalConIva - discountAmount;
  
  const formatPrice = (price) => new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP'
  }).format(price);
  
  const productRows = cartItems.map(item => {
    const precioConIva = item.price;
    const precioNeto = precioConIva / 1.19;
    const iva = precioConIva - precioNeto;
    const totalLinea = precioConIva * item.quantity;
    
    return `
    <tr style="border-bottom: 1px solid #eee;">
      <td style="padding: 15px; border-right: 1px solid #eee;">
        <div style="font-weight: 600; color: #333; margin-bottom: 5px;">${item.title}</div>
        <div style="font-size: 12px; color: #666;">ID: ${item.variantId}</div>
      </td>
      <td style="padding: 15px; text-align: center; border-right: 1px solid #eee;">${item.quantity}</td>
      <td style="padding: 15px; text-align: right; border-right: 1px solid #eee;">${formatPrice(precioNeto)}</td>
      <td style="padding: 15px; text-align: right; border-right: 1px solid #eee; color: #666;">${formatPrice(iva)}</td>
      <td style="padding: 15px; text-align: right; border-right: 1px solid #eee; font-weight: 600;">${formatPrice(precioConIva)}</td>
      <td style="padding: 15px; text-align: right; font-weight: 600;">${formatPrice(totalLinea)}</td>
    </tr>
    `;
  }).join('');
  
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Nuevo Pedido B2B - IMANIX</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
      <div style="max-width: 800px; margin: 0 auto; background-color: white; box-shadow: 0 0 20px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #FFCE36 0%, #E6B800 100%); color: #333; padding: 30px; text-align: center;">
          <h1 style="margin: 0; font-size: 28px; font-weight: 700;">🎯 NUEVO PEDIDO B2B</h1>
          <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Portal IMANIX Chile - Usuario IMA</p>
        </div>
        
        <!-- Información del cliente -->
        <div style="padding: 30px; background-color: #f8f9fa; border-bottom: 3px solid #FFCE36;">
          <h2 style="margin: 0 0 20px 0; color: #333; font-size: 20px;">👤 Información del Cliente</h2>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
            <div>
              <strong style="color: #555;">Nombre:</strong> ${customerName}<br>
              <strong style="color: #555;">Email:</strong> ${customer.email}<br>
              <strong style="color: #555;">Empresa:</strong> ${companyName}
            </div>
            <div>
              <strong style="color: #555;">Descuento B2B:</strong> ${discountPercentage}%<br>
              <strong style="color: #555;">Tipo:</strong> <span style="background: #28a745; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px;">Usuario IMA</span><br>
              <strong style="color: #555;">Pedido #:</strong> ${orderData.draftOrderNumber}
            </div>
          </div>
        </div>
        
        <!-- Productos -->
        <div style="padding: 30px;">
          <h2 style="margin: 0 0 20px 0; color: #333; font-size: 20px;">🛒 Productos Solicitados</h2>
          <table style="width: 100%; border-collapse: collapse; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden;">
            <thead>
              <tr style="background: #FFCE36; color: #333;">
                <th style="padding: 15px; text-align: left; font-weight: 600;">Producto</th>
                <th style="padding: 15px; text-align: center; font-weight: 600;">Cant.</th>
                <th style="padding: 15px; text-align: right; font-weight: 600;">Precio Neto</th>
                <th style="padding: 15px; text-align: right; font-weight: 600;">IVA (19%)</th>
                <th style="padding: 15px; text-align: right; font-weight: 600;">Precio c/IVA</th>
                <th style="padding: 15px; text-align: right; font-weight: 600;">Total Línea</th>
              </tr>
            </thead>
            <tbody>
              ${productRows}
            </tbody>
          </table>
        </div>
        
        <!-- Totales -->
        <div style="padding: 30px; background: #f8f9fa;">
          <div style="max-width: 350px; margin-left: auto;">
            <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #ddd;">
              <span style="color: #666;">Subtotal Neto:</span>
              <span style="font-weight: 600;">${formatPrice(subtotalNeto)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #ddd;">
              <span style="color: #666;">IVA (19%):</span>
              <span style="font-weight: 600;">${formatPrice(ivaTotal)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #ddd;">
              <span style="color: #666;">Subtotal con IVA:</span>
              <span style="font-weight: 600;">${formatPrice(subtotalConIva)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #ddd; color: #28a745;">
              <span>Descuento B2B (${discountPercentage}%):</span>
              <span style="font-weight: 600;">-${formatPrice(discountAmount)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 15px 0; font-size: 18px; font-weight: 700; color: #333; border-top: 2px solid #FFCE36;">
              <span>TOTAL FINAL:</span>
              <span>${formatPrice(total)}</span>
            </div>
          </div>
        </div>
        
        <!-- Método de pago -->
        <div style="padding: 30px; background: #e8f5e8; border-left: 5px solid #28a745;">
          <h3 style="margin: 0 0 10px 0; color: #155724;">💳 Método de Pago</h3>
          <p style="margin: 0; font-size: 16px; color: #155724;">
            <strong>Acuerdo Comercial IMA</strong> - Los pagos se rigen según el convenio establecido con el cliente.
          </p>
        </div>
        
        <!-- Footer -->
        <div style="background: #333; color: white; padding: 20px; text-align: center;">
          <p style="margin: 0; font-size: 14px;">
            Este pedido fue generado automáticamente desde el Portal B2B de IMANIX Chile<br>
            <span style="opacity: 0.7;">Fecha: ${new Date().toLocaleString('es-CL')}</span>
          </p>
        </div>
        
      </div>
    </body>
    </html>
  `;
}

// Función para enviar email de notificación del pedido
async function sendOrderEmail(customer, cartItems, orderData) {
  try {
    // Verificar si el transporter está configurado
    if (!transporter) {
      console.log('⚠️ Email no configurado, saltando envío');
      return { success: false, error: 'Email transporter not configured' };
    }
    
    const emailHtml = generateOrderEmailHTML(customer, cartItems, orderData);
    const customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customer.email;
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_TO || 'administracion@imanix.com',
      subject: `🎯 Nuevo Pedido B2B IMA - ${customerName} - #${orderData.draftOrderNumber}`,
      html: emailHtml
    };
    
    console.log('📧 Enviando email de notificación del pedido...');
    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Email enviado exitosamente:', result.messageId);
    
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('❌ Error enviando email:', error);
    return { success: false, error: error.message };
  }
}

// Funciones para manejo de contraseñas
async function hashPassword(password) {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

function validatePassword(password) {
  // Mínimo 8 caracteres, al menos una letra y un número
  if (password.length < 8) {
    return { valid: false, message: 'La contraseña debe tener al menos 8 caracteres' };
  }
  if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(password)) {
    return { valid: false, message: 'La contraseña debe contener al menos una letra y un número' };
  }
  return { valid: true };
}

// Función para extraer descuento de etiquetas B2B
function extractB2BDiscount(tags) {
  if (!tags) return null;
  
  const tagArray = tags.split(',').map(tag => tag.trim().toLowerCase());
  
  // Buscar etiquetas B2B (mantener funcionalidad existente)
  const b2bTag = tagArray.find(tag => tag.startsWith('b2b') && tag.match(/b2b\d+/));
  if (b2bTag) {
    const discount = parseInt(b2bTag.replace('b2b', ''));
    return isNaN(discount) ? null : discount;
  }
  
  // Buscar etiquetas IMA (nueva funcionalidad)
  const imaTag = tagArray.find(tag => tag.startsWith('ima') && tag.match(/ima.*\d+/));
  if (imaTag) {
    // Extraer número de descuento de etiquetas como "imab2b40" (tomar el número al final)
    const match = imaTag.match(/\d+$/);
    if (match) {
      const discount = parseInt(match[0]);
      return isNaN(discount) ? null : discount;
    }
  }
  
  return null;
}

// Función para crear o actualizar perfil automáticamente al autenticarse
async function createOrUpdateUserProfile(customer) {
  if (!database) return null;
  
  try {
    // Datos del cliente desde Shopify
    const profileData = {
      email: customer.email,
      shopify_customer_id: customer.id || null,
      company_name: customer.company || customer.defaultAddress?.company || null,
      contact_name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || null,
      mobile_phone: customer.phone || customer.defaultAddress?.phone || null,
      discount_percentage: customer.discount || 0,
      discount_tag: customer.tags.find(tag => tag.startsWith('b2b')) || null,
      is_active: true
    };

    console.log('🔄 Creando/actualizando perfil para:', customer.email);
    const profile = await database.createOrUpdateProfile(profileData);
    
    if (profile) {
      console.log('✅ Perfil creado/actualizado exitosamente');
      
      // Si el cliente tiene dirección por defecto, crear/actualizar en Supabase
      if (customer.defaultAddress) {
        const address = customer.defaultAddress;
        const addressData = {
          type: 'shipping',
          is_default: true,
          company: address.company || null,
          first_name: address.firstName || customer.firstName,
          last_name: address.lastName || customer.lastName,
          address1: address.address1,
          address2: address.address2 || null,
          city: address.city,
          state: address.province || null,
          postal_code: address.zip,
          country: address.country || 'Chile',
          phone: address.phone || customer.phone || null
        };
        
        console.log('🏠 Sincronizando dirección por defecto');
        await database.addAddress(customer.email, addressData);
      }
    }
    
    return profile;
  } catch (error) {
    console.error('❌ Error creando/actualizando perfil:', error);
    return null;
  }
}

// Endpoint para autenticación de clientes B2B
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email es requerido'
      });
    }
    
    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Contraseña es requerida'
      });
    }

    console.log(`🔍 Buscando cliente B2B: ${email}`);

    const customer = await findCustomerByEmail(email);
    
    if (!customer) {
      console.log(`❌ Cliente no encontrado: ${email}`);
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado en nuestro sistema'
      });
    }

    const discount = extractB2BDiscount(customer.tags);
    
    if (discount === null) {
      console.log(`❌ Cliente sin acceso B2B: ${email} - Etiquetas: ${customer.tags}`);
      return res.status(403).json({
        success: false,
        message: 'Este cliente no tiene acceso al portal B2B'
      });
    }

    // Verificar contraseña del portal B2B
    if (database) {
      const profile = await database.getProfile(email);
      
      if (!profile || !profile.password_hash) {
        // Primera vez - necesita configurar contraseña
        return res.json({
          success: true,
          requiresPasswordSetup: true,
          message: 'Primera vez en el portal. Necesitas configurar tu contraseña.',
          customerData: {
            email: customer.email,
            firstName: customer.first_name,
            lastName: customer.last_name,
            discount: discount,
            tags: customer.tags
          }
        });
      }
      
      // Verificar contraseña
      const isValidPassword = await verifyPassword(password, profile.password_hash);
      if (!isValidPassword) {
        console.log(`❌ Contraseña incorrecta para: ${email}`);
        return res.status(401).json({
          success: false,
          message: 'Contraseña incorrecta'
        });
      }
    }

    // Guardar datos del cliente en sesión
    req.session.customer = {
      id: customer.id,
      email: customer.email,
      firstName: customer.first_name,
      lastName: customer.last_name,
      discount: discount,
      tags: customer.tags
    };

    // Crear o actualizar perfil en base de datos
    if (database) {
      const discountTag = customer.tags?.split(',').find(tag => tag.trim().toLowerCase().startsWith('b2b')) || null;
      await database.createOrUpdateProfile({
        email: customer.email,
        shopify_customer_id: customer.id,
        company_name: customer.default_address?.company || null,
        contact_name: `${customer.first_name} ${customer.last_name}`,
        mobile_phone: customer.phone || customer.default_address?.phone || null,
        discount_percentage: discount,
        discount_tag: discountTag?.trim(),
        is_active: true
      });
    }

    console.log(`✅ Cliente B2B autenticado: ${email} - Descuento: ${discount}%`);

    // Verificar si el perfil está completo
    let profileCompleted = false;
    if (database) {
      profileCompleted = await database.checkProfileCompletion(email);
    }

    res.json({
      success: true,
      message: 'Autenticación exitosa',
      profileCompleted: profileCompleted,
      customer: {
        firstName: customer.first_name,
        lastName: customer.last_name,
        email: customer.email,
        discount: discount
      }
    });

  } catch (error) {
    console.error('Error en autenticación:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Endpoint para configurar contraseña por primera vez
app.post('/api/auth/setup-password', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email y contraseña son requeridos'
      });
    }
    
    // Validar contraseña
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message
      });
    }
    
    // Verificar que el cliente existe y tiene acceso B2B
    const customer = await findCustomerByEmail(email);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado'
      });
    }
    
    const discount = extractB2BDiscount(customer.tags);
    if (discount === null) {
      return res.status(403).json({
        success: false,
        message: 'Sin acceso al portal B2B'
      });
    }
    
    // Hashear contraseña y actualizar perfil
    const hashedPassword = await hashPassword(password);
    
    if (database) {
      await database.updateProfile(email, { password_hash: hashedPassword });
    }
    
    // Crear sesión
    req.session.customer = {
      id: customer.id,
      email: customer.email,
      firstName: customer.first_name,
      lastName: customer.last_name,
      discount: discount,
      tags: customer.tags
    };
    
    console.log(`✅ Contraseña configurada para: ${email}`);
    
    res.json({
      success: true,
      message: 'Contraseña configurada exitosamente',
      redirect: '/portal'
    });
    
  } catch (error) {
    console.error('Error configurando contraseña:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Endpoint para obtener información del cliente actual
app.get('/api/auth/me', (req, res) => {
  if (!req.session.customer) {
    return res.status(401).json({
      success: false,
      message: 'No hay sesión activa'
    });
  }

  res.json({
    success: true,
    customer: req.session.customer
  });
});

// Endpoint para cerrar sesión
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Error al cerrar sesión'
      });
    }
    res.json({
      success: true,
      message: 'Sesión cerrada exitosamente'
    });
  });
});

// Endpoint para verificar email y determinar siguiente paso
app.post('/api/auth/check-email', async (req, res) => {
  console.log('🎯 ENDPOINT EJECUTÁNDOSE - /api/auth/check-email hit!');
  console.log('🎯 Timestamp:', new Date().toISOString());
  
  try {
    console.log('🔍 Backend - Headers:', req.headers);
    console.log('🔍 Backend - Request body completo:', JSON.stringify(req.body, null, 2));
    console.log('🔍 Backend - Content-Type:', req.get('Content-Type'));
    console.log('🔍 Backend - Body is empty?', Object.keys(req.body || {}).length === 0);
    
    const { email } = req.body;
    
    console.log('🔍 Backend - Email extraído:', email);
    console.log('🔍 Backend - Tipo de email:', typeof email);
    
    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      console.log('❌ Backend - Email inválido o vacío');
      console.log('❌ Backend - Condiciones: !email =', !email, ', typeof =', typeof email, ', trim length =', email ? email.trim().length : 'N/A');
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
    console.log('🔍 Backend - Email limpio:', cleanEmail);
    
    // Validación básica de formato de email
    const emailRegex = /^[^
@]+@[^
@]+\.[^
@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      console.log('❌ Backend - Email con formato inválido:', cleanEmail);
      console.log('❌ Backend - Regex test result:', emailRegex.test(cleanEmail));
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
        status: 'no_b2b_access',
        message: 'Sin acceso al portal B2B',
        nextStep: 'no_access'
      });
    }
    
    // Verificar si tiene contraseña configurada
    let hasPassword = false;
    if (database) {
      try {
        const profile = await database.getProfile(cleanEmail);
        hasPassword = profile && profile.password_hash;
      } catch (error) {
        console.log('No se pudo verificar contraseña en BD:', error.message);
      }
    }
    
    const customerData = {
      email: customer.email,
      firstName: customer.first_name,
      lastName: customer.last_name,
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
    console.error('💥 ERROR EN CATCH - check-email endpoint:', error);
    console.error('💥 Error stack:', error.stack);
    console.error('💥 Error message:', error.message);
    console.error('💥 Request data cuando error:', {
      body: req.body,
      headers: req.headers,
      method: req.method,
      path: req.path
    });
    
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor: ' + error.message,
      debug: {
        error: error.message,
        stack: error.stack
      }
    });
  }
});

// Endpoint para obtener datos actuales del perfil
app.get('/api/profile/current', requireAuth, async (req, res) => {
  try {
    const customer = req.session.customer;
    let profile = null;

    if (database) {
      profile = await database.getProfile(customer.email);
    }

    // Si no hay perfil, crear uno básico
    if (!profile) {
      profile = {
        email: customer.email,
        contact_name: `${customer.firstName} ${customer.lastName}`,
        first_name: customer.firstName || '',
        last_name: customer.lastName || '',
        mobile_phone: '',
        company_name: '',
        company_rut: '',
        company_giro: '',
        company_address: '',
        region: '',
        comuna: ''
      };
    }

    res.json({
      success: true,
      profile: profile
    });

  } catch (error) {
    console.error('Error obteniendo perfil:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Endpoint para actualizar datos del perfil empresarial
app.post('/api/profile/update', async (req, res) => {
  try {
    // Verificar autenticación
    if (!req.session.customer) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    const profileData = req.body; // <-- FIX: Leer datos directamente de req.body
    const email = req.session.customer.email;

    if (!profileData) {
      return res.status(400).json({
        success: false,
        message: 'Datos del perfil requeridos'
      });
    }

    // Validar campos requeridos
    const requiredFields = {
      first_name: 'Nombre',
      last_name: 'Apellido',
      mobile_phone: 'Celular',
      company_name: 'Razón Social',
      company_rut: 'RUT Empresa',
      company_giro: 'Giro',
      company_address: 'Dirección',
      region: 'Región',
      comuna: 'Comuna'
    };

    const missingFields = [];
    for (const [field, label] of Object.entries(requiredFields)) {
      if (!profileData[field] || profileData[field].toString().trim() === '') {
        missingFields.push(label);
      }
    }

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Los siguientes campos son obligatorios: ${missingFields.join(', ')}`
      });
    }

    // Actualizar perfil en base de datos
    if (database) {
      try {
        const updatedProfile = await database.updateProfileData(email, profileData);
        
        if (updatedProfile) {
          console.log(`✅ Perfil empresarial actualizado para: ${email}`);
          
          res.json({
            success: true,
            message: '¡Datos empresariales guardados exitosamente!',
            profileCompleted: updatedProfile.profile_completed
          });
        } else {
          res.status(500).json({
            success: false,
            message: 'Error actualizando el perfil. Inténtalo nuevamente.'
          });
        }
      } catch (dbError) {
        console.error('Error en database.updateProfileData:', dbError);
        res.status(500).json({
          success: false,
          message: 'Error de base de datos. Inténtalo nuevamente.'
        });
      }
    } else {
      res.status(500).json({
        success: false,
        message: 'Base de datos no disponible'
      });
    }

  } catch (error) {
    console.error('Error actualizando perfil:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Función helper para verificar si el usuario tiene etiquetas "ima"
function hasImaTag(customer) {
  console.log('🔍 DEBUG hasImaTag - customer.tags:', customer.tags);
  if (!customer.tags) return false;
  const tagArray = customer.tags.split(',').map(tag => tag.trim().toLowerCase());
  console.log('🔍 DEBUG hasImaTag - tagArray:', tagArray);
  const hasIma = tagArray.some(tag => tag.startsWith('ima'));
  console.log('🔍 DEBUG hasImaTag - result:', hasIma);
  return hasIma;
}

// Endpoint para procesar checkout y crear draft order
app.post('/api/checkout', upload.single('comprobante'), async (req, res) => {
  try {
    // Verificar autenticación
    if (!req.session.customer) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    const { paymentMethod } = req.body;
    const comprobante = req.file;
    
    // Parse cartItems si viene como string JSON (FormData)
    let cartItems;
    try {
      cartItems = typeof req.body.cartItems === 'string' 
        ? JSON.parse(req.body.cartItems) 
        : req.body.cartItems;
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Error parsing cart items'
      });
    }
    
    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'El carrito está vacío'
      });
    }

    const customer = req.session.customer;
    const discountPercentage = customer.discount || 0;

    // Validar que si es transferencia, se haya subido comprobante
    if (paymentMethod === 'transferencia' && !comprobante) {
      return res.status(400).json({
        success: false,
        message: 'Debe subir el comprobante de transferencia'
      });
    }

    // Crear draft order en Shopify
    const draftOrder = await createDraftOrder(customer, cartItems, discountPercentage, paymentMethod, comprobante);
    
    // Log para seguimiento
    console.log(`🎯 Draft Order #${draftOrder.id} creado para cliente B2B: ${customer.email}`);
    console.log(`💰 Total items: ${cartItems.length}, Descuento aplicado: ${discountPercentage}%`);

    // Verificar si el cliente tiene etiquetas "ima" para personalizar el mensaje
    const isImaCustomer = hasImaTag(customer);
    console.log('🔍 DEBUG checkout - isImaCustomer:', isImaCustomer);
    
    // Mensajes personalizados según el tipo de cliente
    const note = isImaCustomer 
      ? 'Pedido realizado. Los pagos son según el acuerdo comercial que tengan.'
      : 'Tu pedido está siendo revisado por nuestro equipo. Te contactaremos pronto para confirmar los detalles.';
    console.log('🔍 DEBUG checkout - note selected:', note);
    
    const nextSteps = isImaCustomer 
      ? [
          'Tu pedido ha sido procesado según tu acuerdo comercial',
          'Los términos de pago se rigen por tu convenio IMANIX',
          'Revisaremos disponibilidad de stock y confirmaremos entrega',
          'Coordinaremos la entrega según tus preferencias'
        ]
      : [
          'Revisaremos tu pedido y disponibilidad de stock',
          'Te contactaremos para confirmar detalles y método de pago',
          'Procesaremos el pedido una vez confirmado',
          'Coordinaremos la entrega según tus preferencias'
        ];

    // Enviar email de notificación para usuarios IMA
    if (isImaCustomer) {
      console.log('📧 Enviando email de notificación para usuario IMA...');
      try {
        const emailResult = await sendOrderEmail(customer, cartItems, {
          draftOrderId: draftOrder.id,
          draftOrderNumber: draftOrder.name || `D${draftOrder.id}`,
          total: draftOrder.total_price,
          discount: draftOrder.total_discounts
        });
        
        if (emailResult.success) {
          console.log('✅ Email de notificación enviado exitosamente');
        } else {
          console.log('⚠️ No se pudo enviar el email de notificación:', emailResult.error);
        }
      } catch (emailError) {
        console.error('❌ Error enviando email de notificación:', emailError);
      }
    }

    const orderNumber = draftOrder.name || `D${draftOrder.id}`;
    
    res.json({
      success: true,
      message: `¡Pedido enviado exitosamente! Tu solicitud #${orderNumber} está siendo procesada por nuestro equipo.`,
      draftOrderId: draftOrder.id,
      draftOrderNumber: orderNumber,
      total: draftOrder.total_price,
      discount: draftOrder.total_discounts,
      status: 'pendiente',
      note: note,
      nextSteps: nextSteps,
      debug: {
        customerTags: customer.tags,
        isImaCustomer: isImaCustomer,
        noteSelected: note,
        customerEmail: customer.email
      }
    });

  } catch (error) {
    console.error('❌ Error en checkout:', error);
    console.error('🔍 Stack trace:', error.stack);
    console.error('📊 Request body:', req.body);
    console.error('📎 File:', req.file);
    res.status(500).json({
      success: false,
      message: 'Error procesando el pedido: ' + error.message,
      error: error.message
    });
  }
});

// Funciones de formato
function formatPrice(price) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP'
  }).format(price);
}

function calculateNetPrice(grossPrice) {
  return Math.round(grossPrice / 1.19);
}

function calculateIVA(netPrice) {
  return Math.round(netPrice * 0.19);
}

function calculateDiscount(price, compareAtPrice) {
  if (!compareAtPrice || compareAtPrice <= price) return null;
  return Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
}

// Función para calcular precio con descuento B2B
function applyB2BDiscount(price, discount) {
  if (!discount || discount === 0) return price;
  return Math.round(price * (1 - discount / 100));
}

// Función para guardar draft order en Supabase
async function saveDraftOrderToDatabase(draftOrder, customer) {
    try {
        console.log('🔄 Iniciando guardado de pedido en base de datos...');
        console.log('📧 Email del cliente:', customer.email);
        console.log('🆔 Draft Order ID:', draftOrder.id);
        console.log('💵 Total Price:', draftOrder.total_price);
        console.log('💸 Total Discounts:', draftOrder.total_discounts);
        
        // Verificar si database está disponible
        if (!database) {
            console.error('❌ Database object no está disponible');
            return;
        }

        // Verificar si la función addOrder existe
        if (typeof database.addOrder !== 'function') {
            console.error('❌ database.addOrder no es una función. Funciones disponibles:', Object.keys(database));
            return;
        }

        // Usar la función del database manager que es compatible con el perfil
        const orderData = {
            shopify_order_id: draftOrder.id.toString(),
            order_number: `D${draftOrder.id}`, // Draft order con prefijo D
            status: 'pendiente', // Estado para draft orders
            total_amount: parseFloat(draftOrder.total_price || 0),
            discount_amount: parseFloat(draftOrder.total_discounts || 0),
            currency: draftOrder.currency || 'CLP',
            order_date: new Date().toISOString()
            // Nota: Los items se guardan en Shopify, para estadísticas solo necesitamos los totales
        };

        console.log('📋 Datos del pedido preparados:', {
            shopify_order_id: orderData.shopify_order_id,
            order_number: orderData.order_number,
            total_amount: orderData.total_amount,
            discount_amount: orderData.discount_amount,
            status: orderData.status
        });

        console.log('🚀 Llamando a database.addOrder...');
        const result = await database.addOrder(customer.email, orderData);
        
        if (result) {
            console.log('✅ Draft Order guardado exitosamente en historial del usuario:', draftOrder.id);
            console.log('💰 Datos guardados:', {
                email: customer.email,
                total_amount: orderData.total_amount,
                discount_amount: orderData.discount_amount,
                status: orderData.status,
                result_id: result.id
            });
        } else {
            console.log('⚠️ No se pudo guardar en historial - resultado null/undefined');
            console.error('🔍 Datos que se intentaron guardar:', orderData);
        }
    } catch (error) {
        console.error('❌ Error en saveDraftOrderToDatabase:', error);
        console.error('🔍 Stack trace:', error.stack);
    }
}

// Función para crear Draft Order en Shopify
async function createDraftOrder(customer, cartItems, discountPercentage, paymentMethod = 'contacto', comprobante = null) {
    // Obtener datos del perfil empresarial desde la base de datos
    let profileData = null;
    if (database) {
        profileData = await database.getProfile(customer.email);
    }

    // Extraer el ID numérico de la variant (desde GraphQL ID)
    const lineItems = cartItems.map(item => {
        // Si no tiene variantId, usar productId como fallback (productos del carrito viejo)
        let variantId = item.variantId || item.productId;
        
        if (!variantId) {
            throw new Error(`Item sin variantId ni productId: ${JSON.stringify(item)}`);
        }

        // El variantId puede venir como "gid://shopify/ProductVariant/123456" o ya como número
        let numericId = variantId;
        
        if (typeof variantId === 'string' && variantId.includes('gid://')) {
            numericId = variantId.split('/').pop();
        }
        
        return {
            variant_id: parseInt(numericId),
            quantity: item.quantity,
            price: item.price.toString()
        };
    });

    // Construir nota con información empresarial completa
    let orderNote = `Pedido B2B desde portal - Cliente: ${customer.email} - Descuento: ${discountPercentage}%
    
MÉTODO DE PAGO: ${paymentMethod === 'transferencia' ? 'Transferencia Bancaria' : 'Contacto para Coordinación'}`;
    
    // Subir comprobante a Cloudinary si existe
    let comprobanteUrl = null;
    if (paymentMethod === 'transferencia' && comprobante) {
        try {
            // Subir archivo a Cloudinary
            const uploadResult = await new Promise((resolve, reject) => {
                cloudinary.uploader.upload_stream(
                    {
                        resource_type: 'auto',
                        folder: 'imanix-comprobantes',
                        public_id: `comprobante-${Date.now()}-${customer.email.replace('@', '-at-')}`
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                ).end(comprobante.buffer);
            });
            
            comprobanteUrl = uploadResult.secure_url;
            
            orderNote += `
COMPROBANTE DE PAGO: [Link para descargar](${comprobanteUrl})`;
        } catch (uploadError) {
            console.error('Error subiendo archivo a Cloudinary:', uploadError);
            orderNote += `
COMPROBANTE DE PAGO: ${comprobante.originalname} - ⚠️ Error al subir archivo`;
        }
    }
    
    if (profileData && profileData.profile_completed) {
        orderNote += `

DATOS EMPRESARIALES:
• Razón Social: ${profileData.company_name || 'N/A'}
• RUT: ${profileData.company_rut || 'N/A'}
• Giro: ${profileData.company_giro || 'N/A'}
• Dirección: ${profileData.company_address || 'N/A'}
• Comuna: ${profileData.comuna || 'N/A'}

CONTACTO:
• Nombre: ${profileData.first_name || ''} ${profileData.last_name || ''}
• Teléfono: ${profileData.phone || 'N/A'}
• Celular: ${profileData.mobile_phone || 'N/A'}`;
    } else {
        orderNote += `

⚠️ PERFIL EMPRESARIAL INCOMPLETO - Verificar datos con el cliente`;
    }

    const draftOrder = {
        draft_order: {
            line_items: lineItems,
            customer: {
                id: customer.shopifyId || null,
                email: customer.email,
                first_name: profileData?.first_name || customer.firstName || customer.name?.split(' ')[0] || '',
                last_name: profileData?.last_name || customer.lastName || customer.name?.split(' ').slice(1).join(' ') || ''
            },
            applied_discount: {
                description: `Descuento B2B ${discountPercentage}%`,
                value_type: "percentage",
                value: discountPercentage.toString(),
                amount: null
            },
            note: orderNote,
            tags: `b2b-portal,descuento-${discountPercentage},pago-${paymentMethod}${profileData?.profile_completed ? ',perfil-completo' : ',perfil-incompleto'}${comprobante ? ',comprobante-subido' : ''}`,
            invoice_sent_at: null,
            invoice_url: null,
            status: "open",
            // Incluir dirección si está disponible en el perfil
            ...(profileData?.company_address && {
                billing_address: {
                    first_name: profileData.first_name || '',
                    last_name: profileData.last_name || '',
                    company: profileData.company_name || '',
                    address1: profileData.company_address || '',
                    city: profileData.comuna || '',
                    province: 'Región Metropolitana',
                    country: 'Chile',
                    phone: profileData.phone || profileData.mobile_phone || ''
                }
            })
        }
    };

    try {
        const response = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2023-10/draft_orders.json`, {
            method: 'POST',
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(draftOrder)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Error creando draft order:', response.status, errorText);
            throw new Error(`Error ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        console.log('✅ Draft Order creado exitosamente:', result.draft_order.id);
        
        // Guardar el pedido en Supabase para el historial del usuario
        await saveDraftOrderToDatabase(result.draft_order, customer);
        
        return result.draft_order;
    } catch (error) {
        console.error('Error creando draft order:', error);
        throw error;
    }
}

// Función para obtener productos B2B - PRIORIZA ARCHIVO LOCAL
async function fetchB2BProductsFromShopify() {
  // PRIMERO: Intentar cargar desde archivo local
  try {
    console.log('📦 Cargando productos B2B desde archivo local...');
    const data = await fs.readFile('b2b-products.json', 'utf8');
    const products = JSON.parse(data);
    console.log(`✅ ${products.length} productos B2B cargados desde archivo local`);
    return products;
  } catch (fileError) {
    console.log('⚠️ No se pudo cargar archivo local, intentando Shopify API...');
  }

  // FALLBACK: Shopify API si no hay archivo local
  if (!SHOPIFY_ACCESS_TOKEN) {
    console.log('❌ No hay token de Shopify configurado');
    return [];
  }

  const graphqlUrl = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2024-04/graphql.json`;
  
  const getProductsQuery = `
    query getProductsByTag($cursor: String) {
      products(first: 50, after: $cursor, query: "tag:b2b") {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            tags
            totalInventory
            metafields(first: 20) {
              edges {
                node {
                  namespace
                  key
                  value
                  type
                }
              }
            }
            images(first: 5) {
              edges {
                node {
                  id
                  url
                  altText
                  width
                  height
                }
              }
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                  image {
                    url
                    altText
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  try {
    while (hasNextPage) {
      const response = await axios.post(
        graphqlUrl,
        {
          query: getProductsQuery,
          variables: { cursor: cursor },
        },
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
        }
      );
      
      const productsData = response.data.data.products;
      const productsOnPage = productsData.edges.map(edge => edge.node);
      allProducts = allProducts.concat(productsOnPage);

      hasNextPage = productsData.pageInfo.hasNextPage;
      cursor = productsData.pageInfo.endCursor;
    }

    console.log(`✅ ${allProducts.length} productos B2B obtenidos desde Shopify`);
    return allProducts;
  } catch (error) {
    console.error('Error obteniendo productos desde Shopify:', error);
    return [];
  }
}

// Ruta principal
app.get('/', async (req, res) => {
  try {
    // Verificar si el usuario está autenticado
    if (!req.session.customer) {
      // Mostrar pantalla de login
      return res.send(getLoginHTML());
    }

    // Verificar si el perfil está completo
    if (database) {
      const profileCompleted = await database.checkProfileCompletion(req.session.customer.email);
      if (!profileCompleted) {
        // Redirigir a completar perfil
        return res.redirect('/complete-profile');
      }
    }

    // Obtener productos desde Shopify directamente
    const products = await fetchB2BProductsFromShopify();
    
    res.send(getPortalHTML(products, req.session.customer));
    
  } catch (error) {
    console.error('Error en ruta principal:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Ruta específica para el portal B2B
app.get('/portal', async (req, res) => {
  try {
    console.log('🏠 ACCEDIENDO A RUTA /portal');
    console.log('👤 Sesión actual:', req.session?.customer?.email || 'No autenticado');
    
    // Verificar si el usuario está autenticado
    if (!req.session.customer) {
      console.log('❌ Usuario no autenticado, redirigiendo a login');
      // Redirigir al login en lugar de mostrar directamente
      return res.redirect('/');
    }

    console.log('✅ Usuario autenticado:', req.session.customer.email);

    // Verificar si el perfil está completo
    if (database) {
      const profileCompleted = await database.checkProfileCompletion(req.session.customer.email);
      console.log('🔍 Perfil completo:', profileCompleted);
      
      if (!profileCompleted) {
        console.log('⚠️ Perfil incompleto, redirigiendo a complete-profile');
        return res.redirect('/complete-profile');
      }
    }

    console.log('✅ Perfil completo, cargando productos...');
    
    // Obtener productos desde Shopify directamente
    const products = await fetchB2BProductsFromShopify();
    console.log('📦 Productos cargados:', products?.length || 0);
    
    // Generar y enviar HTML del portal
    const portalHTML = getPortalHTML(products, req.session.customer);
    console.log('🎨 Portal HTML generado exitosamente');
    
    res.send(portalHTML);
    
  } catch (error) {
    console.error('💥 Error en ruta /portal:', error);
    res.status(500).send(`Error cargando portal: ${error.message}`);
  }
});

// Ruta para completar perfil empresarial
app.get('/complete-profile', (req, res) => {
  try {
    // Verificar autenticación
    if (!req.session.customer) {
      return res.redirect('/');
    }

    res.send(getCompleteProfileHTML(req.session.customer));
  } catch (error) {
    console.error('Error en ruta complete-profile:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Ruta del carrito
app.get('/carrito', (req, res) => {
  try {
    // Verificar si el usuario está autenticado
    if (!req.session.customer) {
      return res.redirect('/');
    }

    res.send(getCartHTML(req.session.customer));
    
  } catch (error) {
    console.error('Error en ruta del carrito:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Ruta para página de perfil del usuario (requiere autenticación)
app.get('/perfil', requireAuth, async (req, res) => {
  try {
    const customer = req.session.customer;
    let profile = null;
    let addresses = [];
    let orders = [];
    let stats = null;

    if (database) {
      profile = await database.getProfile(customer.email);
      addresses = await database.getUserAddresses(customer.email);
      orders = await database.getUserOrders(customer.email, 10);
      stats = await database.getStats(customer.email);
    }

    // Si no hay perfil, crear uno básico
    if (!profile) {
      profile = {
        email: customer.email,
        contact_name: `${customer.firstName} ${customer.lastName}`,
        first_name: customer.firstName || '',
        last_name: customer.lastName || '',
        mobile_phone: '',
        company_name: '',
        company_rut: '',
        company_giro: '',
        company_address: '',
        region: '',
        comuna: ''
      };
    }

    res.send(getProfileHTML(customer, profile, addresses, orders, stats));
  } catch (error) {
    console.error('Error cargando perfil:', error);
    res.status(500).send('<h1>Error cargando perfil</h1>');
  }
});

// Función para generar HTML del carrito
function getCartHTML(customer) {
  const customerDiscount = customer?.discount || 0;
  
  return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Carrito de Compras - Portal B2B IMANIX Chile</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">

    <!-- 🎨 IMANIX Professional Design System -->
    <style>
        :root {
            --imanix-yellow: #FFCE36;
            --imanix-yellow-dark: #E6B800;
            --imanix-yellow-light: #FFF8E1;
            --gray-50: #F9FAFB;
            --gray-100: #F3F4F6;
            --gray-200: #E5E7EB;
            --gray-600: #4B5563;
            --gray-800: #1F2937;
            --gray-900: #111827;
            --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
            --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }
        
        /* FONDOS PROFESIONALES */
        body { background: var(--gray-50) !important; color: var(--gray-800) !important; }
        
        /* NAVBAR EMPRESARIAL */
        .navbar { 
            background: #FFFFFF !important; 
            border-bottom: 3px solid var(--imanix-yellow) !important;
            box-shadow: var(--shadow-md) !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }
        
        /* CARDS PROFESIONALES */
        .cart-header, .cart-items, .cart-summary, .login-container, .profile-container,
        .content-card, .stat-card, .product-card, .catalog-section, .customer-welcome,
        .profile-header, .profile-tabs {
            background: #FFFFFF !important;
            border: 1px solid var(--gray-200) !important;
            box-shadow: var(--shadow-md) !important;
        }
        
        /* STATS MEJORADAS */
        .stat-card { 
            border-left: 4px solid var(--imanix-yellow) !important;
            transition: all 0.3s ease !important;
        }
        .stat-card:hover { 
            box-shadow: var(--shadow-lg) !important;
            transform: translateY(-2px) !important;
        }
        
        /* BOTONES PROFESIONALES */
        .login-button, .submit-button, .checkout-btn, .add-to-cart-btn, 
        .cart-navbar-btn, .btn-primary, .quantity-btn {
            background: linear-gradient(135deg, var(--imanix-yellow) 0%, var(--imanix-yellow-dark) 100%) !important;
            color: var(--gray-800) !important;
            border: 1px solid var(--imanix-yellow-dark) !important;
            box-shadow: var(--shadow-sm) !important;
            font-weight: 600 !important;
        }
        
        .login-button:hover, .submit-button:hover, .checkout-btn:hover, 
        .add-to-cart-btn:hover, .cart-navbar-btn:hover, .btn-primary:hover, .quantity-btn:hover {
            background: linear-gradient(135deg, var(--imanix-yellow-dark) 0%, #D4A500 100%) !important;
            box-shadow: var(--shadow-md) !important;
            transform: translateY(-1px) !important;
        }
        
        /* PRODUCTS GRID MEJORADO */
        .product-card { border: 1px solid var(--gray-200) !important; transition: all 0.3s ease !important; }
        .product-card:hover {
            border-color: var(--imanix-yellow) !important;
            box-shadow: var(--shadow-lg) !important;
            transform: translateY(-3px) !important;
        }
        
        /* ELEMENTOS SEMÁNTICOS */
        .discount-badge { background: #10B981 !important; color: white !important; }
        .cart-navbar-badge { background: #EF4444 !important; color: white !important; }
        
        /* FORMULARIOS MEJORADOS */
        .form-input, .form-select, .search-box {
            border: 1px solid var(--gray-200) !important;
            background: #FFFFFF !important;
            transition: all 0.2s ease !important;
        }
        .form-input:focus, .form-select:focus, .search-box:focus {
            border-color: var(--imanix-yellow) !important;
            box-shadow: 0 0 0 3px rgba(255, 206, 54, 0.1) !important;
        }
        
        /* DROPDOWN ELEGANTE */
        .dropdown-header {
            background: linear-gradient(135deg, var(--imanix-yellow-light) 0%, var(--imanix-yellow) 100%) !important;
            color: var(--gray-800) !important;
        }
        
        /* TIPOGRAFÍA PROFESIONAL */
        .cart-title, .catalog-title, .profile-title { color: var(--gray-900) !important; }
        .cart-subtitle, .profile-subtitle { color: var(--gray-600) !important; }
        
        /* WELCOME SECTION ESPECIAL */
        .customer-welcome {
            background: linear-gradient(135deg, #FFFFFF 0%, var(--gray-50) 100%) !important;
            border-left: 4px solid var(--imanix-yellow) !important;
        }
        
        /* CATALOG SECTION MEJORADA */
        .catalog-section { border-radius: 12px !important; }
        
        /* RESPONSIVE PROFESIONAL */
        @media (max-width: 768px) {
            .navbar { background: #FFFFFF !important; border-bottom: 3px solid var(--imanix-yellow) !important; }
            .stat-card, .product-card { margin-bottom: 1rem !important; }
        }
    
        /* MICRO-INTERACCIONES PROFESIONALES */
        .product-card { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important; }
        .product-card:hover .product-image img { transform: scale(1.02) !important; }
        
        .stat-card { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important; }
        .stat-card:hover .stat-icon { transform: scale(1.1) !important; }
        
        .nav-button, .user-account { transition: all 0.2s ease !important; }
        .nav-button:hover, .user-account:hover { background: var(--gray-100) !important; }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important; 
            background: #10B981 !important; 
            box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3) !important;
        }
        
        /* SEARCH BOX ELEGANTE */
        .search-box { 
            border-radius: 8px !important;
            padding: 0.75rem 1rem !important;
            font-size: 0.875rem !important;
        }
        
        /* TABS MEJORADAS */
        .tab-button.active {
            background: var(--imanix-yellow) !important;
            color: var(--gray-800) !important;
            border-bottom: 3px solid var(--imanix-yellow-dark) !important;
            box-shadow: var(--shadow-sm) !important;
        }

        </style>

    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #F8FAFC;
            min-height: 100vh;
            color: #1A202C;
            line-height: 1.6;
            font-smooth: always;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            padding-top: 120px;
        }

        .navbar {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border-bottom: 1px solid rgba(255, 255, 255, 0.18);
            padding: 1.25rem 0;
            box-shadow: 0 8px 32px rgba(31, 38, 135, 0.12), 0 2px 8px rgba(31, 38, 135, 0.08);
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 1000;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .navbar-content {
            max-width: 1400px;
            margin: 0 auto;
            padding: 0 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .navbar-brand {
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .brand-logo {
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, #FFCE36, #FFC107);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 1.2rem;
            color: #1A202C;
        }

        .brand-text h1 {
            color: #1A202C;
            font-size: 1.5rem;
            font-weight: 800;
            margin: 0;
            line-height: 1.2;
        }

        .brand-text p {
            color: #666;
            font-size: 0.75rem;
            margin: 0;
            font-weight: 500;
        }

        .navbar-actions {
            display: flex;
            align-items: center;
            gap: 1.5rem;
        }

        .user-account {
            position: relative;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.75rem 1rem;
            background: rgba(0, 0, 0, 0.05);
            border-radius: 10px;
            text-decoration: none;
            color: #1A202C;
            font-weight: 600;
            font-size: 0.875rem;
            transition: all 0.3s ease;
            cursor: pointer;
        }

        .user-account:hover {
            background: rgba(0, 0, 0, 0.1);
            transform: translateY(-2px);
        }

        .user-dropdown {
            position: absolute;
            top: 100%;
            right: 0;
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
            border: 1px solid rgba(0, 0, 0, 0.1);
            min-width: 220px;
            z-index: 1000;
            display: none;
            overflow: hidden;
            margin-top: 0.5rem;
        }

        .user-dropdown.show {
            display: block;
            animation: dropdownFadeIn 0.3s ease;
        }

        @keyframes dropdownFadeIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .dropdown-header {
            padding: 1rem;
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            color: #1A202C;
        }

        .dropdown-header .user-name {
            font-weight: 700;
            font-size: 0.9rem;
            margin-bottom: 0.25rem;
        }

        .dropdown-header .user-email {
            font-size: 0.75rem;
            opacity: 0.8;
        }

        .dropdown-menu {
            padding: 0.5rem 0;
        }

        .dropdown-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.75rem 1rem;
            color: #374151;
            text-decoration: none;
            transition: all 0.2s ease;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
            cursor: pointer;
            font-size: 0.875rem;
        }

        .dropdown-item:hover {
            background: rgba(255, 206, 54, 0.1);
            color: #1A202C;
        }

        .dropdown-item i {
            width: 16px;
            text-align: center;
        }

        .dropdown-divider {
            height: 1px;
            background: rgba(0, 0, 0, 0.1);
            margin: 0.5rem 0;
        }

        .cart-navbar-btn {
            position: relative;
            background: linear-gradient(135deg, #FFCE36, #FFC107);
            border: none;
            padding: 0.75rem;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 50px;
            height: 50px;
        }

        .cart-navbar-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(255, 206, 54, 0.4);
        }

        .cart-navbar-btn i {
            font-size: 1.2rem;
            color: #1A202C;
        }

        .cart-navbar-badge {
            position: absolute;
            top: -8px;
            right: -8px;
            background: #000000;
            color: #1A202C;
            border-radius: 50%;
            min-width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.75rem;
            font-weight: 700;
            border: 2px solid white;
        }

        .cart-container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 0 2rem 4rem;
            animation: fadeInUp 0.8s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .cart-header {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.18);
            padding: 3rem;
            border-radius: 32px;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            margin-bottom: 3rem;
            position: relative;
            overflow: hidden;
        }

        .cart-header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 33%, #f093fb 66%, #f5576c 100%);
        }

        .cart-title {
            font-size: 2.5rem;
            font-weight: 900;
            color: #1A202C;
            margin-bottom: 0.75rem;
            letter-spacing: -0.025em;
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .cart-subtitle {
            color: #64748b;
            font-size: 1.1rem;
            font-weight: 500;
            letter-spacing: 0.01em;
        }

        @keyframes fadeInUp {
            from { 
                opacity: 0; 
                transform: translateY(30px); 
            }
            to { 
                opacity: 1; 
                transform: translateY(0); 
            }
        }

        .cart-content {
            display: grid;
            grid-template-columns: 1fr 400px;
            gap: 3rem;
        }

        .cart-items {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 32px;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            padding: 3rem;
            position: relative;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .cart-items::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #f093fb 0%, #f5576c 100%);
