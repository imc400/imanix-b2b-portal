const express = require('express');
const fs = require('fs').promises;
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const database = require('./database');
const SupabaseSessionStore = require('./session-store');
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

// Inicializar Session Store de Supabase
const sessionStore = new SupabaseSessionStore();

// Inicializar tabla de sesiones al arrancar
sessionStore.ensureSessionsTable().then(success => {
  if (success) {
    console.log('✅ Sessions table ready');
  } else {
    console.log('⚠️ Sessions table initialization failed, using memory fallback');
  }
});

// Middleware personalizado de sesiones serverless-compatible
app.use(async (req, res, next) => {
  try {
    // Obtener sessionId de las cookies
    const sessionId = req.headers.cookie?.split(';')
      .find(c => c.trim().startsWith('imanix.b2b.session='))
      ?.split('=')[1] || null;

    console.log('🔍 Session middleware - SessionId from cookie:', sessionId);

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
        console.log('🔄 Session regenerated:', newSessionId);
      },
      destroy: async function() {
        if (this.sessionId) {
          await sessionStore.destroySession(this.sessionId);
          res.clearCookie('imanix.b2b.session');
          console.log('🗑️ Session destroyed:', this.sessionId);
        }
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
          console.log('🆔 SessionId created on save:', newSessionId);
        }
        
        const sessionData = { ...this };
        delete sessionData.sessionId;
        delete sessionData.regenerate;
        delete sessionData.destroy;
        delete sessionData.save;
        await sessionStore.setSession(this.sessionId, sessionData);
        console.log('💾 Session saved:', this.sessionId);
      }
    };

    // Cargar datos de sesión existente si hay sessionId
    if (sessionId) {
      const sessionData = await sessionStore.getSession(sessionId);
      if (sessionData) {
        // Fusionar datos de sesión existentes
        Object.assign(req.session, sessionData);
        req.session.sessionId = sessionId; // Asegurar que sessionId se mantenga
        console.log('✅ Session loaded for:', sessionData.customer?.email || 'anonymous');
      } else {
        console.log('📭 No valid session found, creating new session');
        // Crear nueva sesión si no existe o expiró
        await req.session.regenerate();
      }
    } else {
      console.log('🆕 No sessionId found, creating new session immediately');
      // Crear sessionId inmediatamente
      await req.session.regenerate();
    }

    // Intercept res.end to auto-save session changes
    const originalEnd = res.end;
    res.end = function(...args) {
      // Guardar sesión automáticamente antes de enviar respuesta si hay cambios
      if (req.session.customer || req.session.authenticated) {
        req.session.save().catch(console.error);
      }
      originalEnd.apply(this, args);
    };

    next();
  } catch (error) {
    console.error('❌ Session middleware error:', error);
    next();
  }
});

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
  const customerName = `${customer?.firstName || 'Usuario' || ''} ${customer?.lastName || ''}`.trim() || 'N/A';
  const companyName = customer?.company || 'N/A';
  const discountPercentage = customer?.discount || 0;
  
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
              <strong style="color: #555;">Email:</strong> ${customer?.email || 'no-email@example.com'}<br>
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
    const customerName = `${customer?.firstName || 'Usuario' || ''} ${customer?.lastName || ''}`.trim() || customer?.email || 'no-email@example.com';
    
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
  
  // Buscar etiquetas IMA PRIMERO (prioridad para flujo imab2b40)
  const imaTag = tagArray.find(tag => tag.startsWith('ima') && tag.match(/ima.*\d+/));
  if (imaTag) {
    // Extraer número de descuento de etiquetas como "imab2b40" (tomar el número al final)
    const match = imaTag.match(/\d+$/);
    if (match) {
      const discount = parseInt(match[0]);
      console.log(`✅ Usando flujo IMA: ${imaTag} → ${discount}% descuento`);
      return isNaN(discount) ? null : discount;
    }
  }
  
  // Buscar etiquetas B2B como fallback
  const b2bTag = tagArray.find(tag => tag.startsWith('b2b') && tag.match(/b2b\d+/));
  if (b2bTag) {
    const discount = parseInt(b2bTag.replace('b2b', ''));
    console.log(`⚠️ Usando flujo B2B legacy: ${b2bTag} → ${discount}% descuento`);
    return isNaN(discount) ? null : discount;
  }
  
  return null;
}

// Función para crear o actualizar perfil automáticamente al autenticarse
async function createOrUpdateUserProfile(customer) {
  if (!database) return null;
  
  try {
    // Datos del cliente desde Shopify
    const profileData = {
      email: customer?.email || 'no-email@example.com',
      shopify_customer_id: customer?.id || null,
      company_name: customer?.company || customer?.defaultAddress?.company || null,
      contact_name: `${customer?.firstName || 'Usuario' || ''} ${customer?.lastName || ''}`.trim() || null,
      mobile_phone: customer?.phone || customer?.defaultAddress?.phone || null,
      discount_percentage: customer?.discount || 0,
      discount_tag: customer?.tags?.find(tag => tag.startsWith('b2b')) || null,
      is_active: true
    };

    console.log('🔄 Creando/actualizando perfil para:', customer?.email || 'no-email@example.com');
    const profile = await database.createOrUpdateProfile(profileData);
    
    if (profile) {
      console.log('✅ Perfil creado/actualizado exitosamente');
      
      // Si el cliente tiene dirección por defecto, crear/actualizar en Supabase
      if (customer?.defaultAddress) {
        const address = customer?.defaultAddress;
        const addressData = {
          type: 'shipping',
          is_default: true,
          company: address.company || null,
          first_name: address.firstName || customer?.firstName || 'Usuario',
          last_name: address.lastName || customer?.lastName,
          address1: address.address1,
          address2: address.address2 || null,
          city: address.city,
          state: address.province || null,
          postal_code: address.zip,
          country: address.country || 'Chile',
          phone: address.phone || customer?.phone || null
        };
        
        console.log('🏠 Sincronizando dirección por defecto');
        await database.addAddress(customer?.email || 'no-email@example.com', addressData);
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
            email: customer?.email || 'no-email@example.com',
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
      id: customer?.id,
      email: customer?.email || 'no-email@example.com',
      firstName: customer.first_name,
      lastName: customer.last_name,
      discount: discount,
      tags: customer.tags
    };

    // Crear o actualizar perfil en base de datos
    if (database) {
      const discountTag = customer.tags?.split(',').find(tag => tag.trim().toLowerCase().startsWith('b2b')) || null;
      await database.createOrUpdateProfile({
        email: customer?.email || 'no-email@example.com',
        shopify_customer_id: customer?.id,
        company_name: customer.default_address?.company || null,
        contact_name: `${customer.first_name} ${customer.last_name}`,
        mobile_phone: customer?.phone || customer.default_address?.phone || null,
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
        email: customer?.email || 'no-email@example.com',
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
      id: customer?.id,
      email: customer?.email || 'no-email@example.com',
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
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
      email: customer?.email || 'no-email@example.com',
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
      profile = await database.getProfile(customer?.email || 'no-email@example.com');
    }

    // Si no hay perfil, crear uno básico
    if (!profile) {
      profile = {
        email: customer?.email || 'no-email@example.com',
        contact_name: `${customer?.firstName || 'Usuario'} ${customer?.lastName}`,
        first_name: customer?.firstName || 'Usuario' || '',
        last_name: customer?.lastName || '',
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
    const email = req.session.customer?.email || 'no-email@example.com';

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
    const discountPercentage = customer?.discount || 0;

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
    console.log(`🎯 Draft Order #${draftOrder.id} creado para cliente B2B: ${customer?.email || 'no-email@example.com'}`);
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
        customerEmail: customer?.email || 'no-email@example.com'
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
        console.log('📧 Email del cliente:', customer?.email || 'no-email@example.com');
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
        const result = await database.addOrder(customer?.email || 'no-email@example.com', orderData);
        
        if (result) {
            console.log('✅ Draft Order guardado exitosamente en historial del usuario:', draftOrder.id);
            console.log('💰 Datos guardados:', {
                email: customer?.email || 'no-email@example.com',
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
        profileData = await database.getProfile(customer?.email || 'no-email@example.com');
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
    let orderNote = `Pedido B2B desde portal - Cliente: ${customer?.email || 'no-email@example.com'} - Descuento: ${discountPercentage}%
    
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
                        public_id: `comprobante-${Date.now()}-${customer?.email || 'no-email@example.com'.replace('@', '-at-')}`
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
                email: customer?.email || 'no-email@example.com',
                first_name: profileData?.first_name || customer?.firstName || 'Usuario' || customer.name?.split(' ')[0] || '',
                last_name: profileData?.last_name || customer?.lastName || customer.name?.split(' ').slice(1).join(' ') || ''
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
    console.log('🏠 ACCEDIENDO A RUTA RAÍZ /');
    console.log('👤 Sesión raíz:', req.session?.customer?.email || 'No autenticado');
    
    // DEBUGGING COMPLETO DE LA SESIÓN EN RUTA RAÍZ
    console.log('🔍 DEBUG RAÍZ - Session completa:', JSON.stringify(req.session, null, 2));
    console.log('🔍 DEBUG RAÍZ - req.session.customer:', req.session.customer);
    console.log('🔍 DEBUG RAÍZ - req.session.sessionId:', req.session.sessionId);
    
    // Verificar si el usuario está autenticado
    if (!req.session.customer) {
      console.log('❌ Usuario no autenticado en raíz, mostrando login');
      return res.send(getLoginHTML());
    }

    // Verificar si el perfil está completo
    if (database) {
      const profileCompleted = await database.checkProfileCompletion(req.session.customer?.email || 'no-email@example.com');
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
    
    // DEBUGGING COMPLETO DE LA SESIÓN
    console.log('🔍 DEBUG PORTAL - Session completa:', JSON.stringify(req.session, null, 2));
    console.log('🔍 DEBUG PORTAL - req.session.customer:', req.session.customer);
    console.log('🔍 DEBUG PORTAL - req.session.authenticated:', req.session.authenticated);
    console.log('🔍 DEBUG PORTAL - req.session.sessionId:', req.session.sessionId);
    
    // COMENTAR TEMPORALMENTE EL REDIRECT PARA DEBUG
    // Verificar si el usuario está autenticado
    if (!req.session.customer) {
      console.log('❌ Usuario no autenticado, redirigiendo a login');
      // COMENTADO PARA DEBUG: return res.redirect('/');
      console.log('🚨 REDIRECT COMENTADO PARA DEBUG - continuando...');
    }

    console.log('✅ Usuario autenticado:', req.session.customer?.email || 'No customer data');

    // Verificar si el perfil está completo
    if (database && req.session.customer?.email) {
      const profileCompleted = await database.checkProfileCompletion(req.session.customer?.email || 'no-email@example.com');
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
    console.log('🛒 ACCEDIENDO A RUTA /carrito');
    console.log('👤 Sesión carrito:', req.session?.customer?.email || 'No autenticado');
    
    // DEBUGGING COMPLETO DE LA SESIÓN EN CARRITO
    console.log('🔍 DEBUG CARRITO - Session completa:', JSON.stringify(req.session, null, 2));
    console.log('🔍 DEBUG CARRITO - req.session.customer:', req.session.customer);
    console.log('🔍 DEBUG CARRITO - req.session.sessionId:', req.session.sessionId);
    
    // Verificar si el usuario está autenticado
    if (!req.session.customer) {
      console.log('❌ Usuario no autenticado en carrito, redirigiendo a login');
      // COMENTADO PARA DEBUG: return res.redirect('/');
      console.log('🚨 CARRITO REDIRECT COMENTADO PARA DEBUG - continuando...');
    }

    console.log('🎨 Generando HTML del carrito...');
    console.log('🔍 DEBUG CARRITO - Customer being passed to getCartHTML:', JSON.stringify(req.session.customer, null, 2));
    console.log('🔍 DEBUG CARRITO - Customer tags specifically:', req.session.customer?.tags || 'NO_TAGS_FOUND');
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
      profile = await database.getProfile(customer?.email || 'no-email@example.com');
      addresses = await database.getUserAddresses(customer?.email || 'no-email@example.com');
      orders = await database.getUserOrders(customer?.email || 'no-email@example.com', 10);
      stats = await database.getStats(customer?.email || 'no-email@example.com');
    }

    // Si no hay perfil, crear uno básico
    if (!profile) {
      profile = {
        email: customer?.email || 'no-email@example.com',
        contact_name: `${customer?.firstName || 'Usuario'} ${customer?.lastName}`,
        first_name: customer?.firstName || 'Usuario' || '',
        last_name: customer?.lastName || '',
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
        }

        .cart-item {
            display: grid;
            grid-template-columns: 100px 1fr auto auto;
            gap: 1rem;
            align-items: center;
            padding: 1.5rem 0;
            border-bottom: 1px solid #e2e8f0;
        }

        .cart-item:last-child {
            border-bottom: none;
        }

        .item-image {
            width: 80px;
            height: 80px;
            border-radius: 12px;
            object-fit: cover;
            background: #f1f5f9;
        }

        .item-details h3 {
            font-size: 1.1rem;
            font-weight: 700;
            color: #1A202C;
            margin-bottom: 0.5rem;
        }

        .item-price-info {
            font-size: 0.875rem;
            color: #64748b;
        }

        .price-breakdown {
            margin-top: 0.25rem;
        }

        .quantity-controls {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            background: #f8fafc;
            padding: 0.5rem;
            border-radius: 12px;
        }

        .quantity-btn {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            border: none;
            width: 36px;
            height: 36px;
            border-radius: 12px;
            color: #1A202C;
            font-weight: 700;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .quantity-btn:hover {
            transform: translateY(-2px) scale(1.05);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
        }

        .quantity-display {
            min-width: 40px;
            text-align: center;
            font-weight: 700;
        }

        .item-total {
            text-align: right;
            min-width: 120px;
        }

        .item-total-price {
            font-size: 1.1rem;
            font-weight: 700;
            color: #1A202C;
        }

        .item-total-breakdown {
            font-size: 0.875rem;
            color: #64748b;
            margin-top: 0.25rem;
        }

        .remove-btn {
            background: #ef4444;
            color: #1A202C;
            border: none;
            padding: 0.5rem;
            border-radius: 8px;
            cursor: pointer;
            margin-top: 0.5rem;
        }

        .cart-summary {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 32px;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            padding: 3rem;
            height: fit-content;
            position: sticky;
            top: 130px;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .cart-summary::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #11998e 0%, #38ef7d 100%);
        }

        .summary-title {
            font-size: 2rem;
            font-weight: 900;
            margin-bottom: 2rem;
            color: #1A202C;
            letter-spacing: -0.025em;
        }

        .summary-line {
            display: flex;
            justify-content: space-between;
            margin-bottom: 1rem;
            padding-bottom: 1rem;
        }

        .summary-line.total {
            border-top: 2px solid #e2e8f0;
            padding-top: 1rem;
            font-weight: 700;
            font-size: 1.1rem;
        }

        .summary-label {
            color: #64748b;
        }

        .summary-value {
            font-weight: 600;
            color: #1A202C;
        }

        .discount-badge {
            background: linear-gradient(135deg, #10b981, #059669);
            color: #1A202C;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.875rem;
            font-weight: 600;
        }

        .checkout-btn {
            width: 100%;
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            color: #1A202C;
            border: none;
            padding: 1.25rem 2.5rem;
            border-radius: 20px;
            font-size: 1.2rem;
            font-weight: 800;
            cursor: pointer;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            margin-top: 2rem;
            position: relative;
            overflow: hidden;
            letter-spacing: 0.01em;
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
        }

        .checkout-btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(135deg, #764ba2 0%, #667eea 100%);
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .checkout-btn:hover::before {
            opacity: 1;
        }

        .checkout-btn:hover {
            transform: translateY(-4px) scale(1.02);
            box-shadow: 0 16px 40px rgba(102, 126, 234, 0.6);
        }

        .empty-cart {
            text-align: center;
            padding: 4rem 2rem;
            background: white;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }

        .empty-cart-icon {
            font-size: 4rem;
            color: #cbd5e1;
            margin-bottom: 1rem;
        }

        .empty-cart-title {
            font-size: 1.5rem;
            font-weight: 700;
            color: #1A202C;
            margin-bottom: 0.5rem;
        }

        .empty-cart-subtitle {
            color: #64748b;
            margin-bottom: 2rem;
        }

        .continue-shopping {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            color: #1A202C;
            text-decoration: none;
            padding: 1rem 2rem;
            border-radius: 12px;
            font-weight: 700;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
        }

        @media (max-width: 768px) {
            .cart-content {
                grid-template-columns: 1fr;
            }
            
            .cart-item {
                grid-template-columns: 80px 1fr;
                gap: 1rem;
            }
            
            .quantity-controls {
                margin-top: 1rem;
                justify-self: start;
            }
            
            .item-total {
                margin-top: 0.5rem;
                text-align: left;
            }
        }
        /* ANIMACIONES DE ENTRADA SUTILES */
        .stat-card, .product-card, .cart-item {
            animation: fadeInUp 0.6s ease-out !important;
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* LOADING STATES ELEGANTES */
        .loading-spinner {
            border: 2px solid var(--gray-200) !important;
            border-top: 2px solid var(--imanix-yellow) !important;
        }
        
        /* PRECIO DESTACADO */
        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: white !important;
            font-weight: 800 !important;
            font-size: 1.25rem !important;
        }
        
        /* NAVBAR LOGO MEJORADO */
        .brand-logo {
            transition: all 0.3s ease !important;
        }
        .brand-logo:hover {
            transform: scale(1.05) !important;
            box-shadow: 0 4px 12px rgba(255, 206, 54, 0.3) !important;
        }
        
        /* CART SUMMARY ELEGANTE */
        .cart-summary {
            border-top: 3px solid var(--imanix-yellow) !important;
        }
        
        /* QUANTITY CONTROLS REFINADOS */
        .quantity-controls {
            background: var(--gray-50) !important;
            border: 1px solid var(--gray-200) !important;
        }
        
        /* NOTIFICACIONES PROFESIONALES */
        .notification {
            border-radius: 8px !important;
            backdrop-filter: blur(10px) !important;
        }
        
        /* ACCESIBILIDAD MEJORADA */
        .btn:focus, .form-input:focus, .form-select:focus {
            outline: 2px solid var(--imanix-yellow) !important;
            outline-offset: 2px !important;
        }
        /* CORRECCIONES DE CONTRASTE ESPECÍFICAS */
        .discounted-price, .item-total-price.discounted {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            display: inline-block !important;
        }
        
        .savings, .price-breakdown.highlight {
            color: #10B981 !important;
            font-weight: 600 !important;
        }
        
        .discount-badge, .cart-navbar-badge {
            color: white !important;
            font-weight: 700 !important;
        }
        
        /* Asegurar contraste en todos los elementos verdes */
        .success-text, .discount-text, .savings-amount {
            color: white !important;
            background: #10B981 !important;
            padding: 0.125rem 0.25rem !important;
            border-radius: 3px !important;
        }
        /* PRECIOS MEJORADOS CON CONTRASTE PERFECTO */
        .discounted-price-block {
            background: #10B981 !important;
            color: white !important;
            padding: 0.75rem 1rem !important;
            border-radius: 8px !important;
            margin-bottom: 0.5rem !important;
        }
        
        .discounted-price {
            color: white !important;
            font-size: 1.5rem !important;
            font-weight: 800 !important;
            display: block !important;
            margin-bottom: 0.25rem !important;
        }
        
        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.9) !important;
            font-size: 0.875rem !important;
        }
        
        .savings {
            color: #10B981 !important;
            font-weight: 600 !important;
            font-size: 0.875rem !important;
        }
        
        /* NOTIFICACIONES CON CONTRASTE PERFECTO */
        .notification {
            color: white !important;
        }
        
        .notification-message {
            color: white !important;
        }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }
        
        .cart-navbar-badge {
            background: #EF4444 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }






    </style>
</head>
<body>
    <nav class="navbar">
        <div class="navbar-content">
            <a href="/" class="navbar-brand" style="text-decoration: none;">
                <img src="/images/Logo%202160x1200%20(1).png" alt="IMANIX Portal B2B" style="height: 70px; width: auto;" />            <div class="navbar-actions">
                <div class="user-account" onclick="toggleUserDropdown()">
                    <i class="fas fa-user-circle"></i>
                    <span>${customer?.firstName || 'Usuario'} ${customer?.lastName || ''}</span>
                    <i class="fas fa-chevron-down" style="font-size: 0.75rem; margin-left: 0.25rem;"></i>
                    
                    <div class="user-dropdown" id="userDropdown">
                        <div class="dropdown-header">
                            <div class="user-name">${customer?.firstName || 'Usuario'} ${customer?.lastName || ''}</div>
                            <div class="user-email">${customer?.email || 'no-email@example.com'}</div>
                        </div>
                        
                        <div class="dropdown-menu">
                            <a href="/perfil" class="dropdown-item">
                                <i class="fas fa-user-edit"></i>
                                Mi Perfil
                            </a>
                            <a href="/carrito" class="dropdown-item">
                                <i class="fas fa-shopping-cart"></i>
                                Mi Carrito
                            </a>
                            <a href="/perfil" class="dropdown-item">
                                <i class="fas fa-history"></i>
                                Historial de Pedidos
                            </a>
                            <div class="dropdown-divider"></div>
                            <button onclick="logout()" class="dropdown-item">
                                <i class="fas fa-sign-out-alt"></i>
                                Cerrar Sesión
                            </button>
                        </div>
                    </div>
                </div>
                <button class="cart-navbar-btn" onclick="showCart()">
                    <i class="fas fa-shopping-cart"></i>
                    <span class="cart-navbar-badge" id="cartNavbarBadge">0</span>
                </button>
            </div>
        </div>
    </nav>

    <div class="cart-container">
        <div class="cart-header">
            <h1 class="cart-title">
                <i class="fas fa-shopping-cart"></i>
                Tu Carrito de Compras
            </h1>
            <p class="cart-subtitle">Revisa y modifica tus productos antes de proceder</p>
        </div>

        <div id="cartContent">
            <!-- El contenido se carga dinámicamente -->
        </div>
    </div>

    <script>
        // Variables globales
        let cart = JSON.parse(localStorage.getItem('b2bCart')) || [];
        const customerDiscount = ${customerDiscount};
        const customerTags = '${customer?.tags || ''}';
        
        // DEBUG: Log customer tags para diagnóstico
        console.log('🔍 DEBUG Cart - Customer object:', ${JSON.stringify(customer || {})});
        console.log('🔍 DEBUG Cart - Customer tags:', '${customer?.tags || 'NO_TAGS'}');
        
        // Función para verificar si el usuario tiene etiquetas "ima"
        function hasImaTagFrontend() {
            if (!customerTags) return false;
            const tagArray = customerTags.split(',').map(tag => tag.trim().toLowerCase());
            return tagArray.some(tag => tag.startsWith('ima'));
        }

        // Limpiar y migrar productos del carrito (productos añadidos antes de la actualización)
        let cartChanged = false;

        cart = cart.map(item => {
            // Si el item no tiene variantId pero tiene productId, intentamos solucionarlo
            if (!item.variantId && item.productId) {
                console.log('🔧 Migrando producto sin variantId:', item.title);
                item.variantId = item.productId; // Usar productId como fallback
                cartChanged = true;
            }
            return item;
        }).filter(item => {
            // Eliminar items que no tienen ni variantId ni productId
            if (!item.variantId && !item.productId) {
                console.log('🗑️ Eliminando producto inválido:', item);
                cartChanged = true;
                return false;
            }
            return true;
        });

        if (cartChanged) {
            localStorage.setItem('b2bCart', JSON.stringify(cart));
            console.log('🧹 Carrito limpiado y migrado');
        }

        // Función para formatear precios
        function formatPrice(price) {
            return new Intl.NumberFormat('es-CL', {
                style: 'currency',
                currency: 'CLP'
            }).format(price);
        }

        // Función para calcular precio neto (sin IVA)
        function calculateNetPrice(grossPrice) {
            return Math.round(grossPrice / 1.19);
        }

        // Función para calcular IVA
        function calculateIVA(netPrice) {
            return Math.round(netPrice * 0.19);
        }

        // Función para renderizar el carrito
        function renderCart() {
            const cartContent = document.getElementById('cartContent');
            
            if (cart.length === 0) {
                cartContent.innerHTML = \`
                    <div class="empty-cart">
                        <div class="empty-cart-icon">
                            <i class="fas fa-shopping-cart"></i>
                        </div>
                        <h2 class="empty-cart-title">Tu carrito está vacío</h2>
                        <p class="empty-cart-subtitle">Agrega productos desde nuestro catálogo B2B</p>
                        <a href="/" class="continue-shopping">
                            <i class="fas fa-arrow-left"></i>
                            Continuar Comprando
                        </a>
                    </div>
                \`;
                return;
            }

            let subtotalBruto = 0;
            
            const itemsHTML = cart.map(item => {
                const itemTotalBruto = item.price * item.quantity;
                const itemTotalNeto = calculateNetPrice(itemTotalBruto);
                const itemTotalIVA = calculateIVA(itemTotalNeto);
                
                subtotalBruto += itemTotalBruto;
                
                const unitPriceNeto = calculateNetPrice(item.price);
                const unitPriceIVA = calculateIVA(unitPriceNeto);
                
                return \`
                    <div class="cart-item" data-product-id="\${item.productId}" data-variant-id="\${item.variantId}">
                        <img src="\${item.image}" alt="\${item.title}" class="item-image" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgdmlld0JveD0iMCAwIDEwMCAxMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxMDAiIGhlaWdodD0iMTAwIiBmaWxsPSIjRjFGNUY5Ii8+CjxwYXRoIGQ9Ik0zNSA0MEg2NVY2MEgzNVY0MFoiIGZpbGw9IiNCREMzQzciLz4KPC9zdmc+'" />
                        
                        <div class="item-details">
                            <h3>\${item.title}</h3>
                            <div class="item-price-info">
                                Precio unitario: \${formatPrice(item.price)}
                                <div class="price-breakdown">
                                    Neto: \${formatPrice(unitPriceNeto)} + IVA: \${formatPrice(unitPriceIVA)}
                                </div>
                            </div>
                        </div>
                        
                        <div class="quantity-controls">
                            <button class="quantity-btn" onclick="updateQuantity('\${item.productId}', '\${item.variantId}', -1)">-</button>
                            <span class="quantity-display">\${item.quantity}</span>
                            <button class="quantity-btn" onclick="updateQuantity('\${item.productId}', '\${item.variantId}', 1)">+</button>
                            <button class="remove-btn" onclick="removeFromCart('\${item.productId}', '\${item.variantId}')">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                        
                        <div class="item-total">
                            <div class="item-total-price">\${formatPrice(itemTotalBruto)}</div>
                            <div class="item-total-breakdown">
                                Neto: \${formatPrice(itemTotalNeto)}<br>
                                IVA: \${formatPrice(itemTotalIVA)}
                            </div>
                        </div>
                    </div>
                \`;
            }).join('');

            // Calcular totales
            const subtotalNeto = calculateNetPrice(subtotalBruto);
            const subtotalIVA = calculateIVA(subtotalNeto);
            const descuentoMonto = Math.round(subtotalBruto * (customerDiscount / 100));
            const totalConDescuento = subtotalBruto - descuentoMonto;
            const totalNetoConDescuento = calculateNetPrice(totalConDescuento);
            const totalIVAConDescuento = calculateIVA(totalNetoConDescuento);

            cartContent.innerHTML = \`
                <div class="cart-content">
                    <div class="cart-items">
                        \${itemsHTML}
                    </div>
                    
                    <div class="cart-summary">
                        <h3 class="summary-title">Resumen del Pedido</h3>
                        
                        <div class="summary-line">
                            <span class="summary-label">Subtotal (Bruto):</span>
                            <span class="summary-value">\${formatPrice(subtotalBruto)}</span>
                        </div>
                        
                        <div class="summary-line">
                            <span class="summary-label">• Neto:</span>
                            <span class="summary-value">\${formatPrice(subtotalNeto)}</span>
                        </div>
                        
                        <div class="summary-line">
                            <span class="summary-label">• IVA (19%):</span>
                            <span class="summary-value">\${formatPrice(subtotalIVA)}</span>
                        </div>
                        
                        <div class="summary-line">
                            <span class="summary-label">Descuento B2B (-\${customerDiscount}%):</span>
                            <span class="summary-value" style="color: #10b981;">-\${formatPrice(descuentoMonto)}</span>
                        </div>
                        
                        <div class="summary-line total">
                            <span class="summary-label">Total a Pagar:</span>
                            <span class="summary-value">\${formatPrice(totalConDescuento)}</span>
                        </div>
                        
                        <div class="summary-line" style="font-size: 0.875rem; margin-top: -0.5rem;">
                            <span class="summary-label">• Neto final:</span>
                            <span class="summary-value">\${formatPrice(totalNetoConDescuento)}</span>
                        </div>
                        
                        <div class="summary-line" style="font-size: 0.875rem; margin-top: -0.5rem; margin-bottom: 0;">
                            <span class="summary-label">• IVA final:</span>
                            <span class="summary-value">\${formatPrice(totalIVAConDescuento)}</span>
                        </div>
                        
                        <button class="checkout-btn" onclick="proceedToCheckout()">
                            <i class="fas fa-credit-card"></i>
                            Realizar Pedido
                        </button>
                        
                        <a href="/" class="nav-button" style="width: 100%; justify-content: center; margin-top: 1rem; text-decoration: none;">
                            <i class="fas fa-arrow-left"></i>
                            Continuar Comprando
                        </a>
                        
                        <button class="nav-button" onclick="clearCart()" style="width: 100%; justify-content: center; margin-top: 0.5rem; background: #ef4444; border: none; cursor: pointer;">
                            <i class="fas fa-trash"></i>
                            Limpiar Carrito
                        </button>
                    </div>
                </div>
            \`;
        }

        // Función para actualizar cantidad
        function updateQuantity(productId, variantId, change) {
            const item = cart.find(item => item.productId === productId && item.variantId === variantId);
            if (item) {
                item.quantity += change;
                if (item.quantity <= 0) {
                    removeFromCart(productId, variantId);
                } else {
                    localStorage.setItem('b2bCart', JSON.stringify(cart));
                    renderCart();
                    showNotification('Cantidad actualizada', 'success');
                }
            }
        }

        // Función para eliminar del carrito
        function removeFromCart(productId, variantId) {
            cart = cart.filter(item => !(item.productId === productId && item.variantId === variantId));
            localStorage.setItem('b2bCart', JSON.stringify(cart));
            renderCart();
            showNotification('Producto eliminado del carrito', 'success');
        }

        // Función para limpiar completamente el carrito
        function clearCart() {
            if (confirm('¿Estás seguro de que quieres limpiar todo el carrito?')) {
                cart = [];
                localStorage.setItem('b2bCart', JSON.stringify(cart));
                renderCart();
                showNotification('Carrito limpiado completamente', 'success');
            }
        }

        // Función para checkout directo de usuarios IMA
        async function processDirectCheckout() {
            try {
                console.log('🔍 DEBUG: Processing direct checkout for IMA user');
                showNotification('Procesando pedido...', 'success');
                
                const formData = new FormData();
                formData.append('cartItems', JSON.stringify(cart.map(item => ({
                    variantId: item.variantId,
                    quantity: item.quantity,
                    price: item.price,
                    title: item.title
                }))));
                formData.append('paymentMethod', 'ima_agreement'); // Método especial para usuarios IMA
                
                const response = await fetch('/api/checkout', {
                    method: 'POST',
                    body: formData
                });

                const data = await response.json();
                console.log('🔍 DEBUG: Direct checkout response:', data);

                if (data.success) {
                    // Éxito - limpiar carrito y mostrar mensaje personalizado
                    localStorage.removeItem('b2bCart');
                    cart = [];
                    
                    // Mostrar modal de éxito con mensaje personalizado para usuarios IMA
                    showOrderSuccessModal(data);
                    
                    // Redirigir después de mostrar el mensaje
                    setTimeout(() => {
                        window.location.href = '/perfil';
                    }, 10000);
                } else {
                    showNotification(data.message || 'Error procesando el pedido', 'error');
                }
            } catch (error) {
                console.error('Error en checkout directo:', error);
                showNotification('Error de conexión. Inténtalo nuevamente.', 'error');
            }
        }

        // Función para proceder al checkout
        function proceedToCheckout() {
            console.log('🔍 DEBUG: proceedToCheckout called, cart length:', cart.length);
            if (cart.length === 0) {
                showNotification('Tu carrito está vacío', 'error');
                return;
            }
            
            // Verificar si el usuario tiene etiquetas IMA
            const isImaUser = hasImaTagFrontend();
            console.log('🔍 DEBUG: Is IMA user:', isImaUser, 'Tags:', customerTags);
            
            if (isImaUser) {
                // Checkout directo para usuarios IMA
                console.log('🔍 DEBUG: Processing direct checkout for IMA user');
                processDirectCheckout();
            } else {
                // Modal de métodos de pago para usuarios regulares
                console.log('🔍 DEBUG: Showing payment method modal for regular user');
                showPaymentMethodModal();
            }
        }

        function showPaymentMethodModal() {
            const modal = document.createElement('div');
            modal.style.cssText = \`
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
            \`;

            modal.innerHTML = \`
                <div style="background: white; border-radius: 15px; padding: 2rem; max-width: 600px; width: 90%; max-height: 90vh; overflow-y: auto;">
                    <h2 style="color: #333; margin-bottom: 1.5rem; text-align: center;">
                        <i class="fas fa-credit-card"></i> Método de Pago
                    </h2>
                    
                    <div style="margin-bottom: 2rem;">
                        <div style="border: 2px solid #FFCE36; border-radius: 10px; padding: 1.5rem; margin-bottom: 1rem; cursor: pointer;" onclick="selectPaymentMethod('transferencia', this)">
                            <label style="cursor: pointer; display: flex; align-items: center;">
                                <input type="radio" name="paymentMethod" value="transferencia" style="margin-right: 1rem; transform: scale(1.2);">
                                <div>
                                    <h3 style="margin: 0; color: #333;"><i class="fas fa-university"></i> Transferencia Bancaria</h3>
                                    <p style="margin: 0.5rem 0 0 0; color: #666; font-size: 0.9rem;">Transfiere y sube tu comprobante para procesar el pedido</p>
                                </div>
                            </label>
                        </div>
                        
                        <div style="border: 2px solid #ddd; border-radius: 10px; padding: 1.5rem; cursor: pointer;" onclick="selectPaymentMethod('contacto', this)">
                            <label style="cursor: pointer; display: flex; align-items: center;">
                                <input type="radio" name="paymentMethod" value="contacto" style="margin-right: 1rem; transform: scale(1.2);">
                                <div>
                                    <h3 style="margin: 0; color: #333;"><i class="fas fa-phone"></i> Contacto para Pago</h3>
                                    <p style="margin: 0.5rem 0 0 0; color: #666; font-size: 0.9rem;">Nuestro equipo te contactará para coordinar el pago</p>
                                </div>
                            </label>
                        </div>
                    </div>

                    <div id="bankDetails" style="display: none; background: #f8f9fa; border-radius: 10px; padding: 1.5rem; margin-bottom: 2rem;">
                        <h4 style="color: #333; margin-bottom: 1rem;"><i class="fas fa-info-circle"></i> Datos Bancarios</h4>
                        <div style="background: white; padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
                            <p style="margin: 0.25rem 0;"><strong>Banco:</strong> Banco de Crédito e Inversiones (BCI)</p>
                            <p style="margin: 0.25rem 0;"><strong>Cuenta Corriente:</strong> 76938301</p>
                            <p style="margin: 0.25rem 0;"><strong>RUT:</strong> 76.411.264-4</p>
                            <p style="margin: 0.25rem 0;"><strong>Titular:</strong> BRAIN TOYS SpA</p>
                            <p style="margin: 0.25rem 0;"><strong>Email:</strong> administracion@braintoys.cl</p>
                        </div>
                        
                        <div style="margin-top: 1.5rem;">
                            <label style="display: block; margin-bottom: 0.5rem; font-weight: bold; color: #333;">
                                <i class="fas fa-upload"></i> Subir Comprobante de Transferencia
                            </label>
                            <input type="file" id="comprobante" accept="image/*,.pdf" 
                                   style="width: 100%; padding: 0.75rem; border: 2px dashed #FFCE36; border-radius: 8px; background: #fff;">
                            <p style="margin: 0.5rem 0 0 0; color: #666; font-size: 0.85rem;">
                                Acepta imágenes (JPG, PNG) o PDF. Máximo 5MB.
                            </p>
                        </div>
                    </div>

                    <div style="display: flex; gap: 1rem; justify-content: center;">
                        <button onclick="this.parentElement.parentElement.parentElement.remove()" 
                                style="background: #6c757d; color: white; border: none; padding: 0.8rem 2rem; border-radius: 10px; cursor: pointer; font-weight: 600;">
                            Cancelar
                        </button>
                        <button onclick="processCheckout()" 
                                style="background: #FFCE36; color: #333; border: none; padding: 0.8rem 2rem; border-radius: 10px; cursor: pointer; font-weight: 600;">
                            <i class="fas fa-shopping-cart"></i> Procesar Pedido
                        </button>
                    </div>
                </div>
            \`;

            document.body.appendChild(modal);
            
            // Activar transferencia por defecto
            setTimeout(() => {
                const transferOption = document.querySelector('div[onclick*="transferencia"]');
                if (transferOption) {
                    selectPaymentMethod('transferencia', transferOption);
                }
            }, 100);
        }

        function selectPaymentMethod(method, element) {
            // Desmarcar todos los métodos
            document.querySelectorAll('div[onclick*="selectPaymentMethod"]').forEach(div => {
                div.style.borderColor = '#ddd';
                div.querySelector('input[type="radio"]').checked = false;
            });

            // Marcar el método seleccionado
            element.style.borderColor = '#FFCE36';
            element.querySelector('input[type="radio"]').checked = true;

            // Mostrar/ocultar detalles bancarios
            const bankDetails = document.getElementById('bankDetails');
            if (method === 'transferencia') {
                bankDetails.style.display = 'block';
            } else {
                bankDetails.style.display = 'none';
            }
        }

        async function processCheckout() {
            const selectedMethod = document.querySelector('input[name="paymentMethod"]:checked');
            if (!selectedMethod) {
                showNotification('Selecciona un método de pago', 'error');
                return;
            }

            const paymentMethod = selectedMethod.value;
            const comprobanteFile = document.getElementById('comprobante')?.files[0];

            // Validar que si es transferencia, se haya subido comprobante
            if (paymentMethod === 'transferencia' && !comprobanteFile) {
                showNotification('Debes subir el comprobante de transferencia', 'error');
                return;
            }

            // Cerrar modal
            document.querySelector('div[style*="position: fixed"]').remove();

            // Mostrar loading
            const checkoutBtn = document.querySelector('.checkout-btn');
            const originalText = checkoutBtn.innerHTML;
            checkoutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...';
            checkoutBtn.disabled = true;

            try {
                const formData = new FormData();
                formData.append('cartItems', JSON.stringify(cart.map(item => ({
                    variantId: item.variantId,
                    quantity: item.quantity,
                    price: item.price,
                    title: item.title
                }))));
                formData.append('paymentMethod', paymentMethod);
                
                if (comprobanteFile) {
                    formData.append('comprobante', comprobanteFile);
                }

                console.log('🔍 DEBUG: Sending checkout request, paymentMethod:', paymentMethod);
                console.log('🔍 DEBUG: Cart items:', cart.length);
                
                const response = await fetch('/api/checkout', {
                    method: 'POST',
                    body: formData
                });

                console.log('🔍 DEBUG: Checkout response received, status:', response.status);
                const data = await response.json();
                console.log('🔍 DEBUG: Checkout data:', data);

                if (data.success) {
                    // Éxito - limpiar carrito y mostrar mensaje detallado
                    localStorage.removeItem('b2bCart');
                    cart = [];
                    
                    // Crear modal de éxito con información del pedido
                    showOrderSuccessModal(data);
                    
                    // Redirigir después de mostrar el mensaje
                    setTimeout(() => {
                        window.location.href = '/perfil';
                    }, 8000);
                } else {
                    showNotification(data.message || 'Error procesando el pedido', 'error');
                }
            } catch (error) {
                console.error('Error en checkout:', error);
                showNotification('Error de conexión. Inténtalo nuevamente.', 'error');
            } finally {
                // Restaurar botón
                checkoutBtn.innerHTML = originalText;
                checkoutBtn.disabled = false;
            }
        }

        // Función para mostrar modal de pedido exitoso
        function showOrderSuccessModal(data) {
            const modal = document.createElement('div');
            modal.style.cssText = \`
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                padding: 2rem;
            \`;
            
            modal.innerHTML = \`
                <div style="
                    background: white;
                    border-radius: 20px;
                    padding: 2.5rem;
                    max-width: 600px;
                    width: 100%;
                    text-align: center;
                    box-shadow: 0 25px 50px rgba(0,0,0,0.3);
                    animation: slideIn 0.3s ease;
                ">
                    <div style="color: #10b981; font-size: 4rem; margin-bottom: 1rem;">
                        <i class="fas fa-check-circle"></i>
                    </div>
                    
                    <h2 style="color: #1f2937; margin-bottom: 1rem; font-size: 1.8rem;">
                        ¡Pedido Enviado Exitosamente!
                    </h2>
                    
                    <div style="background: #f3f4f6; border-radius: 12px; padding: 1.5rem; margin: 1.5rem 0; text-align: left;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                            <span><strong>Número de Pedido:</strong></span>
                            <span style="color: #6366f1; font-weight: bold;">\${data.draftOrderNumber}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                            <span><strong>Total:</strong></span>
                            <span style="color: #059669; font-weight: bold;">\${formatPrice(data.total)}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                            <span><strong>Descuento:</strong></span>
                            <span style="color: #dc2626; font-weight: bold;">\${formatPrice(data.discount)}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span><strong>Estado:</strong></span>
                            <span style="color: #f59e0b; font-weight: bold; text-transform: capitalize;">\${data.status}</span>
                        </div>
                    </div>
                    
                    <p style="color: #6b7280; margin-bottom: 1.5rem; line-height: 1.6;">
                        \${data.note}
                    </p>
                    
                    <div style="text-align: left; margin-bottom: 2rem;">
                        <h4 style="color: #374151; margin-bottom: 1rem;">Próximos Pasos:</h4>
                        <ol style="color: #6b7280; line-height: 1.8; padding-left: 1.5rem;">
                            \${data.nextSteps ? data.nextSteps.map(function(step) { return '<li>' + step + '</li>'; }).join('') : ''}
                        </ol>
                    </div>
                    
                    <div style="display: flex; gap: 1rem; justify-content: center;">
                        <button onclick="this.parentElement.parentElement.parentElement.remove()" 
                                style="background: #6366f1; color: #1A202C; border: none; padding: 0.8rem 2rem; border-radius: 10px; cursor: pointer; font-weight: 600;">
                            Cerrar
                        </button>
                        <button onclick="window.location.href='/perfil'" 
                                style="background: #10b981; color: #1A202C; border: none; padding: 0.8rem 2rem; border-radius: 10px; cursor: pointer; font-weight: 600;">
                            Ver Mis Pedidos
                        </button>
                    </div>
                    
                    <p style="color: #9ca3af; font-size: 0.875rem; margin-top: 1.5rem;">
                        Serás redirigido automáticamente en <span id="countdown">8</span> segundos
                    </p>
                </div>
                
                <style>
                    @keyframes slideIn {
                        from { opacity: 0; transform: scale(0.9) translateY(-20px); }
                        to { opacity: 1; transform: scale(1) translateY(0); }
                    }
                </style>
            \`;
            
            document.body.appendChild(modal);
            
            // Countdown
            let seconds = 8;
            const countdownEl = modal.querySelector('#countdown');
            const interval = setInterval(() => {
                seconds--;
                if (countdownEl) countdownEl.textContent = seconds;
                if (seconds <= 0) {
                    clearInterval(interval);
                }
            }, 1000);
            
            // Cerrar al hacer click fuera del modal
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.remove();
                    clearInterval(interval);
                }
            });
        }

        // Función para mostrar notificaciones
        function showNotification(message, type) {
            console.log('DEBUG: Notification position updated to 140px');
            const notification = document.createElement('div');
            notification.style.cssText = \`
                position: fixed;
                top: 140px;
                right: 20px;
                background: \${type === 'success' ? '#10b981' : '#ef4444'};
                color: #1A202C;
                padding: 1rem 1.5rem;
                border-radius: 12px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                z-index: 10000;
                font-weight: 600;
                transform: translateX(100%);
                transition: transform 0.3s ease;
            \`;
            notification.textContent = message;
            
            document.body.appendChild(notification);
            
            setTimeout(() => {
                notification.style.transform = 'translateX(0)';
            }, 100);
            
            setTimeout(() => {
                notification.style.transform = 'translateX(100%)';
                setTimeout(() => {
                    document.body.removeChild(notification);
                }, 300);
            }, 3000);
        }

        // Función para cerrar sesión
        async function logout() {
            if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
                try {
                    const response = await fetch('/api/auth/logout', {
                        method: 'POST'
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        localStorage.removeItem('b2bCart');
                        window.location.href = '/';
                    } else {
                        alert('Error al cerrar sesión');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error de conexión');
                }
            }
        }

        // Funciones para el navbar unificado
        function toggleUserDropdown() {
            const dropdown = document.getElementById('userDropdown');
            dropdown.classList.toggle('show');
        }

        // Cerrar dropdown al hacer clic fuera
        document.addEventListener('click', function(event) {
            const userAccount = document.querySelector('.user-account');
            const dropdown = document.getElementById('userDropdown');
            
            if (userAccount && dropdown && !userAccount.contains(event.target)) {
                dropdown.classList.remove('show');
            }
        });

        // Mostrar carrito - redirigir a página dedicada
        function showCart() {
            window.location.href = '/carrito';
        }


        // Actualizar contador del carrito
        function updateCartBadge() {
            const badge = document.getElementById('cartNavbarBadge');
            if (badge) {
                const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
                badge.textContent = totalItems;
            }
        }

        // Inicializar al cargar la página
        document.addEventListener('DOMContentLoaded', function() {
            updateCartBadge();
            renderCart();
        });
    </script>
</body>
</html>`;
}

// Función para generar HTML de login
function getLoginHTML() {
  return `
<!DOCTYPE html>
<html lang="es" class="login-page">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preload" as="image" href="/fondo-login.png">
                    <title>Portal B2B - Acceso Cliente - IMANIX Chile</title>
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
    
        /* PÁGINA DE LOGIN - FONDO ESPECÍFICO */
        html.login-page {
            background: url('/fondo-login.png') center center/cover no-repeat fixed !important;
            background-color: #F8FAFC !important;
        }
        
        html.login-page body {
            background: transparent !important;
        }

        </style>

    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: transparent;
            position: relative;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #212529;
            padding: 2rem;
        }

        body::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(2px);
            z-index: 1;
        }

        .login-container {
            position: relative;
            z-index: 2;
            background: rgba(255, 255, 255, 0.98);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.4);
            border-radius: 32px;
            padding: 3.5rem;
            box-shadow: 
                0 32px 64px rgba(0, 0, 0, 0.15), 
                0 16px 32px rgba(0, 0, 0, 0.1),
                0 0 0 1px rgba(255, 255, 255, 0.2),
                inset 0 1px 0 rgba(255, 255, 255, 0.8);
            max-width: 520px;
            width: 100%;
            text-align: center;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .login-container:hover {
            transform: translateY(-4px);
            box-shadow: 
                0 40px 80px rgba(0, 0, 0, 0.2), 
                0 20px 40px rgba(0, 0, 0, 0.12),
                0 0 0 1px rgba(255, 255, 255, 0.25),
                inset 0 1px 0 rgba(255, 255, 255, 0.9);
        }

        .brand-logo {
            display: flex;
            justify-content: center;
            margin: 0 auto 2.5rem;
        }

        .brand-logo img {
            filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.15));
            transition: transform 0.3s ease;
        }

        .brand-logo img:hover {
            transform: scale(1.05);
        }

        .login-title {
            font-size: 2.5rem;
            font-weight: 800;
            background: linear-gradient(135deg, #1a1a1a, #4a4a4a);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 0.75rem;
            letter-spacing: -0.02em;
        }

        .login-subtitle {
            color: #64748b;
            font-size: 1.1rem;
            margin-bottom: 3rem;
            font-weight: 500;
            letter-spacing: 0.01em;
        }

        .login-form {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
        }

        .form-group {
            position: relative;
            text-align: left;
        }

        .form-label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            color: #1A202C;
            font-size: 0.875rem;
        }

        .form-input {
            width: 100%;
            padding: 1.25rem 1.25rem 1.25rem 3.25rem;
            border: 2px solid #e2e8f0;
            border-radius: 16px;
            font-size: 1rem;
            transition: all 0.3s ease;
            background: white;
            font-weight: 500;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.02);
        }

        .form-input:focus {
            border-color: #FFCE36;
            outline: none;
            box-shadow: 
                0 0 0 4px rgba(255, 206, 54, 0.15),
                0 4px 12px rgba(0, 0, 0, 0.1);
            transform: translateY(-1px);
        }

        .form-input:hover {
            border-color: #cbd5e1;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.05);
        }

        .form-icon {
            position: absolute;
            left: 1.25rem;
            top: 50%;
            transform: translateY(-50%);
            color: #64748b;
            font-size: 1.1rem;
            pointer-events: none;
            will-change: color, transform;
            transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
        }

        .form-input:focus ~ .form-icon {
            color: #FFCE36;
            transform: translateY(-50%) scale3d(1.1, 1.1, 1);
        }

        .form-input:hover ~ .form-icon {
            color: #FFCE36;
            transform: translateY(-50%) scale3d(1.05, 1.05, 1);
        }

        .login-button {
            background: linear-gradient(135deg, #FFCE36, #FFC107);
            color: #1a1a1a;
            border: none;
            padding: 1.25rem 2.5rem;
            border-radius: 16px;
            font-size: 1.1rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            min-height: 64px;
            letter-spacing: 0.01em;
            box-shadow: 
                0 4px 8px rgba(255, 206, 54, 0.3),
                0 1px 3px rgba(0, 0, 0, 0.1);
        }

        .login-button:hover {
            transform: translateY(-3px);
            box-shadow: 
                0 12px 32px rgba(255, 206, 54, 0.4),
                0 4px 12px rgba(0, 0, 0, 0.15);
            background: linear-gradient(135deg, #FFD700, #FFCE36);
        }

        .login-button:active {
            transform: translateY(-1px);
        }

        .login-button:disabled {
            opacity: 0.7;
            cursor: not-allowed;
            transform: none;
        }

        .error-message {
            background: #fef2f2;
            color: #dc2626;
            padding: 0.75rem 1rem;
            border-radius: 8px;
            border: 1px solid #fecaca;
            font-size: 0.875rem;
            text-align: left;
            display: none;
        }

        .loading-spinner {
            display: none;
            width: 20px;
            height: 20px;
            border: 2px solid transparent;
            border-top: 2px solid #000000;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .password-requirements {
            color: #666;
            font-size: 0.8rem;
            margin-top: 0.5rem;
            line-height: 1.4;
        }

        .back-button {
            width: 100%;
            padding: 0.75rem 1.5rem;
            margin-top: 1rem;
            background: transparent;
            border: 2px solid #ddd;
            border-radius: 12px;
            color: #666;
            font-size: 0.9rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }

        .back-button:hover {
            border-color: #FFCE36;
            color: #333;
            background: rgba(255, 206, 54, 0.1);
        }

        .info-section {
            margin-top: 2.5rem;
            padding-top: 2.5rem;
            border-top: 1px solid rgba(0, 0, 0, 0.08);
            text-align: center;
        }

        .distributor-info {
            background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
            padding: 2rem;
            border-radius: 20px;
            border: 1px solid rgba(0, 0, 0, 0.05);
        }

        .info-title {
            font-size: 1.2rem;
            font-weight: 700;
            color: #1A202C;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
        }

        .info-title i {
            color: #FFCE36;
            font-size: 1.3rem;
        }

        .distributor-description {
            color: #64748b;
            font-size: 0.95rem;
            line-height: 1.6;
            margin-bottom: 1.5rem;
            font-weight: 500;
        }

        .contact-info {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            padding: 1rem 1.5rem;
            background: white;
            border-radius: 12px;
            border: 1px solid rgba(0, 0, 0, 0.05);
            will-change: transform, box-shadow;
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .contact-info:hover {
            transform: translate3d(0, -3px, 0) scale3d(1.02, 1.02, 1);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
        }

        .contact-info i {
            color: #FFCE36;
            font-size: 1.1rem;
            will-change: transform;
            transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .contact-info:hover i {
            transform: scale3d(1.1, 1.1, 1) rotate(5deg);
        }

        .contact-link {
            color: #1A202C;
            text-decoration: none;
            font-weight: 600;
            font-size: 0.95rem;
            will-change: color;
            transition: color 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
        }

        .contact-link:hover {
            color: #FFCE36;
        }

        @media (max-width: 480px) {
            .login-container {
                padding: 2rem;
                margin: 1rem;
            }

            .login-title {
                font-size: 1.75rem;
            }
        }

        /* Sistema de Notificaciones IMANIX */
        .notification-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            max-width: 400px;
        }

        .notification {
            margin-bottom: 10px;
            padding: 16px 20px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            opacity: 0;
            transform: translateX(100%);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            color: #1A202C;
            font-weight: 500;
        }

        .notification.show {
            opacity: 1;
            transform: translateX(0);
        }

        .notification-content {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .notification-icon {
            font-size: 20px;
            flex-shrink: 0;
        }

        .notification-message {
            flex: 1;
            font-size: 14px;
            line-height: 1.4;
        }

        .notification-close {
            background: none;
            border: none;
            color: #1A202C;
            cursor: pointer;
            font-size: 16px;
            padding: 4px;
            border-radius: 4px;
            opacity: 0.7;
            transition: opacity 0.2s;
            flex-shrink: 0;
        }

        .notification-close:hover {
            opacity: 1;
        }

        @media (max-width: 480px) {
            .notification-container {
                left: 20px;
                right: 20px;
                max-width: none;
            }
            
            .notification {
                margin-bottom: 8px;
                padding: 14px 16px;
                font-size: 13px;
            }
        }
        /* ANIMACIONES DE ENTRADA SUTILES */
        .stat-card, .product-card, .cart-item {
            animation: fadeInUp 0.6s ease-out !important;
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* LOADING STATES ELEGANTES */
        .loading-spinner {
            border: 2px solid var(--gray-200) !important;
            border-top: 2px solid var(--imanix-yellow) !important;
        }
        
        /* PRECIO DESTACADO */
        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: white !important;
            font-weight: 800 !important;
            font-size: 1.25rem !important;
        }
        
        /* NAVBAR LOGO MEJORADO */
        .brand-logo {
            transition: all 0.3s ease !important;
        }
        .brand-logo:hover {
            transform: scale(1.05) !important;
            box-shadow: 0 4px 12px rgba(255, 206, 54, 0.3) !important;
        }
        
        /* CART SUMMARY ELEGANTE */
        .cart-summary {
            border-top: 3px solid var(--imanix-yellow) !important;
        }
        
        /* QUANTITY CONTROLS REFINADOS */
        .quantity-controls {
            background: var(--gray-50) !important;
            border: 1px solid var(--gray-200) !important;
        }
        
        /* NOTIFICACIONES PROFESIONALES */
        .notification {
            border-radius: 8px !important;
            backdrop-filter: blur(10px) !important;
        }
        
        /* ACCESIBILIDAD MEJORADA */
        .btn:focus, .form-input:focus, .form-select:focus {
            outline: 2px solid var(--imanix-yellow) !important;
            outline-offset: 2px !important;
        }
        /* CORRECCIONES DE CONTRASTE ESPECÍFICAS */
        .discounted-price, .item-total-price.discounted {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            display: inline-block !important;
        }
        
        .savings, .price-breakdown.highlight {
            color: #10B981 !important;
            font-weight: 600 !important;
        }
        
        .discount-badge, .cart-navbar-badge {
            color: white !important;
            font-weight: 700 !important;
        }
        
        /* Asegurar contraste en todos los elementos verdes */
        .success-text, .discount-text, .savings-amount {
            color: white !important;
            background: #10B981 !important;
            padding: 0.125rem 0.25rem !important;
            border-radius: 3px !important;
        }
        /* PRECIOS MEJORADOS CON CONTRASTE PERFECTO */
        .discounted-price-block {
            background: #10B981 !important;
            color: white !important;
            padding: 0.75rem 1rem !important;
            border-radius: 8px !important;
            margin-bottom: 0.5rem !important;
        }
        
        .discounted-price {
            color: white !important;
            font-size: 1.5rem !important;
            font-weight: 800 !important;
            display: block !important;
            margin-bottom: 0.25rem !important;
        }
        
        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.9) !important;
            font-size: 0.875rem !important;
        }
        
        .savings {
            color: #10B981 !important;
            font-weight: 600 !important;
            font-size: 0.875rem !important;
        }
        
        /* NOTIFICACIONES CON CONTRASTE PERFECTO */
        .notification {
            color: white !important;
        }
        
        .notification-message {
            color: white !important;
        }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }
        
        .cart-navbar-badge {
            background: #EF4444 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }






    </style>
</head>
<body>
    <div class="login-container">
                  <div class="brand-logo">
              <img src="/images/Logo%202160x1200%20(1).png" alt="IMANIX Portal B2B" style="height: 70px; width: auto;" />
          </div>
        <h1 class="login-title">Portal B2B</h1>
                        <p class="login-subtitle">Acceso exclusivo para clientes IMANIX</p>
        
        <form class="login-form" id="loginForm">
            <!-- Paso 1: Solo Email -->
            <div class="form-group">
                <label class="form-label" for="email">Email del distribuidor</label>
                <div style="position: relative;">
                    <input 
                        type="email" 
                        id="email" 
                        name="email" 
                        class="form-input"
                        placeholder="tu-email@empresa.com"
                        required
                        autocomplete="email"
                    >
                    <i class="fas fa-envelope form-icon"></i>
                </div>
            </div>

            <!-- Paso 2: Contraseña (oculto inicialmente) -->
            <div class="form-group" id="passwordGroup" style="display: none;">
                <label class="form-label" for="password">Contraseña del portal B2B</label>
                <div style="position: relative;">
                    <input 
                        type="password" 
                        id="password" 
                        name="password" 
                        class="form-input"
                        placeholder="Tu contraseña del portal"
                        autocomplete="current-password"
                    >
                    <i class="fas fa-lock form-icon"></i>
                </div>
            </div>

            <div class="error-message" id="errorMessage"></div>
            <div class="success-message" id="successMessage" style="display: none; background: #e8f5e8; color: #155724; padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem;"></div>

            <button type="submit" class="login-button" id="loginButton">
                <span class="loading-spinner" id="loadingSpinner"></span>
                <i class="fas fa-arrow-right" id="loginIcon"></i>
                <span id="loginText">Continuar</span>
            </button>
            
            <button type="button" class="login-button" id="backButton" style="display: none; background: transparent; border: 2px solid #FFCE36; color: #333; margin-top: 10px;">
                <i class="fas fa-arrow-left"></i>
                <span>Volver</span>
            </button>
        </form>

        <!-- Formulario para configurar contraseña (primera vez) -->
        <form class="login-form" id="passwordSetupForm" style="display: none;">
            <h2 class="form-title">
                <i class="fas fa-key"></i>
                Configura tu Contraseña
            </h2>
            <p class="form-subtitle">Primera vez en el portal B2B. Crea una contraseña segura para acceder.</p>

            <div class="form-group">
                <label class="form-label" for="newPassword">Nueva Contraseña</label>
                <div style="position: relative;">
                    <input 
                        type="password" 
                        id="newPassword" 
                        name="newPassword" 
                        class="form-input"
                        placeholder="Mínimo 8 caracteres, letra y número"
                        required
                        autocomplete="new-password"
                    >
                    <i class="fas fa-lock form-icon"></i>
                </div>
                <small class="password-requirements">
                    • Mínimo 8 caracteres<br>
                    • Al menos una letra y un número
                </small>
            </div>

            <div class="form-group">
                <label class="form-label" for="confirmPassword">Confirmar Contraseña</label>
                <div style="position: relative;">
                    <input 
                        type="password" 
                        id="confirmPassword" 
                        name="confirmPassword" 
                        class="form-input"
                        placeholder="Repite tu contraseña"
                        required
                        autocomplete="new-password"
                    >
                    <i class="fas fa-lock form-icon"></i>
                </div>
            </div>

            <div class="error-message" id="setupErrorMessage"></div>

            <button type="submit" class="login-button" id="setupButton">
                <span class="loading-spinner" id="setupLoadingSpinner"></span>
                <i class="fas fa-key" id="setupIcon"></i>
                <span id="setupText">Crear Contraseña</span>
            </button>

            <button type="button" class="back-button" id="backToLogin">
                <i class="fas fa-arrow-left"></i>
                Volver al Login
            </button>
        </form>

        <div class="info-section">
            <div class="distributor-info">
                <h3 class="info-title">
                    <i class="fas fa-handshake"></i>
                    Portal de Distribuidores Oficiales
                </h3>
                <p class="distributor-description">
                    Acceso exclusivo para distribuidores autorizados de IMANIX. 
                    Si deseas convertirte en distribuidor oficial, contáctanos.
                </p>
                <div class="contact-info">
                    <i class="fas fa-envelope"></i>
                    <a href="mailto:administracion@imanix.com" class="contact-link">
                        administracion@imanix.com
                    </a>
                </div>
            </div>
        </div>
    </div>

    <!-- Sistema de Notificaciones IMANIX -->
    <div id="notificationContainer" class="notification-container"></div>

    <script>
        // Sistema de Notificaciones con Branding IMANIX
        function showNotification(message, type = 'info', duration = 5000) {
            const container = document.getElementById('notificationContainer');
            if (!container) return;
            
            const notification = document.createElement('div');
            
            const typeConfig = {
                success: {
                    icon: 'fas fa-check-circle',
                    bgColor: '#10B981',
                    borderColor: '#059669'
                },
                error: {
                    icon: 'fas fa-exclamation-triangle',
                    bgColor: '#EF4444',
                    borderColor: '#DC2626'
                },
                warning: {
                    icon: 'fas fa-exclamation-triangle',
                    bgColor: '#F59E0B',
                    borderColor: '#D97706'
                },
                info: {
                    icon: 'fas fa-info-circle',
                    bgColor: '#3B82F6',
                    borderColor: '#2563EB'
                }
            };
            
            const config = typeConfig[type] || typeConfig.info;
            
            notification.className = 'notification notification-' + type;
            notification.innerHTML = \`
                <div class="notification-content">
                    <div class="notification-icon">
                        <i class="\${config.icon}"></i>
                    </div>
                    <div class="notification-message">\${message}</div>
                    <button class="notification-close" onclick="closeNotification(this)">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            \`;
            
            // Estilos dinámicos
            notification.style.cssText = \`
                background: linear-gradient(135deg, \${config.bgColor}, \${config.borderColor});
                border-left: 4px solid \${config.borderColor};
            \`;
            
            container.appendChild(notification);
            
            // Animación de entrada
            setTimeout(() => notification.classList.add('show'), 100);
            
            // Auto-cerrar después del tiempo especificado
            if (duration > 0) {
                setTimeout(() => {
                    closeNotification(notification.querySelector('.notification-close'));
                }, duration);
            }
        }
        
        function closeNotification(closeBtn) {
            const notification = closeBtn.closest('.notification');
            if (notification) {
                notification.classList.remove('show');
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 300);
            }
        }

        let currentStep = 'email'; // 'email' o 'password'
        let currentUserData = null;

        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const emailInput = document.getElementById('email');
            const email = emailInput ? emailInput.value.trim() : '';
            const errorDiv = document.getElementById('errorMessage');
            const successDiv = document.getElementById('successMessage');
            const loginButton = document.getElementById('loginButton');
            const loginIcon = document.getElementById('loginIcon');
            const loginText = document.getElementById('loginText');
            const loadingSpinner = document.getElementById('loadingSpinner');
            
            console.log('🔍 Debug - Email capturado:', email);
            console.log('🔍 Debug - Input element:', emailInput);
            
            if (!email || email.length === 0) {
                console.log('❌ Email vacío o inválido');
                showError('Por favor ingresa tu email para acceder al portal');
                return;
            }
            
            // Validación básica de email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                console.log('❌ Email con formato inválido');
                showError('Por favor ingresa un email válido');
                return;
            }

            // Mostrar estado de carga
            loginButton.disabled = true;
            loginIcon.style.display = 'none';
            loadingSpinner.style.display = 'block';
            errorDiv.style.display = 'none';
            successDiv.style.display = 'none';

            if (currentStep === 'email') {
                // Paso 1: Verificar email
                loginText.textContent = 'Verificando email...';
                
                try {
                    console.log('🔍 Verificando email:', email);
                    
                    const response = await fetch('/api/auth/check-email', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ email })
                    });

                    const data = await response.json();
                    console.log('📝 Estado del email:', data);

                    if (data.success) {
                        if (data.status === 'existing_user') {
                            // Usuario existente con contraseña
                            showPasswordStep('Ingresa tu contraseña para acceder');
                            currentUserData = data.customerData;
                        } else if (data.status === 'first_time') {
                            // Usuario sin contraseña (primera vez)
                            resetButton();
                            showPasswordSetupForm(data.customerData);
                        } else if (data.status === 'not_found') {
                            // Usuario no encontrado - redirigir a registro
                            successDiv.textContent = '📝 Usuario nuevo. Redirigiendo al formulario de registro...';
                            successDiv.style.display = 'block';
                            setTimeout(() => {
                                window.location.href = '/complete-profile?email=' + encodeURIComponent(email);
                            }, 2000);
                        } else if (data.status === 'no_b2b_access') {
                            // Sin acceso B2B
                            showError('Tu cuenta no tiene acceso al portal B2B. Contacta a tu representante IMANIX.');
                        }
                    } else {
                        showError(data.message || 'Error verificando email');
                    }
                } catch (error) {
                    console.error('💥 Error verificando email:', error);
                    showError('Error de conexión. Inténtalo nuevamente.');
                } finally {
                    if (currentStep === 'email') {
                        resetButton();
                    }
                }
            } else if (currentStep === 'password') {
                // Paso 2: Autenticar con contraseña
                const password = document.getElementById('password').value;
                
                if (!password) {
                    showError('Por favor ingresa tu contraseña');
                    resetButton();
                    return;
                }
                
                loginText.textContent = 'Iniciando sesión...';
                
                try {
                    console.log('🔐 Intentando autenticar:', email);
                    
                    const response = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ email, password })
                    });

                    const data = await response.json();
                    console.log('📝 Respuesta del servidor:', data);

                    if (data.success) {
                        // Login exitoso
                        console.log('✅ Autenticación exitosa');
                        console.log('🔍 Datos de respuesta completos:', data);
                        loginText.textContent = '¡Acceso autorizado!';
                        showNotification('¡Bienvenido al Portal B2B IMANIX! Acceso autorizado exitosamente.', 'success', 2000);
                        
                        // Optimización para sesiones Supabase - redirect directo sin reload
                        console.log('✅ Login exitoso, redirigiendo al portal...');
                        setTimeout(() => {
                            // Redirect directo al portal - las sesiones Supabase persisten
                            window.location.href = '/portal';
                        }, 1500);
                    } else {
                        console.log('❌ Error de autenticación:', data.message);
                        showError(data.message || 'Contraseña incorrecta');
                        resetButton();
                    }
                } catch (error) {
                    console.error('💥 Error de conexión:', error);
                    showError('Error de conexión. Inténtalo nuevamente.');
                    resetButton();
                }
            }
        });

        // Función para mostrar el paso de contraseña
        function showPasswordStep(message) {
            currentStep = 'password';
            
            // Mostrar grupo de contraseña
            document.getElementById('passwordGroup').style.display = 'block';
            document.getElementById('password').required = true;
            
            // Cambiar botón
            document.getElementById('loginIcon').className = 'fas fa-sign-in-alt';
            document.getElementById('loginText').textContent = 'Iniciar Sesión';
            
            // Mostrar botón volver
            document.getElementById('backButton').style.display = 'block';
            
            // Mostrar mensaje
            const successDiv = document.getElementById('successMessage');
            successDiv.textContent = '✅ ' + message;
            successDiv.style.display = 'block';
            
            // Focus en contraseña
            document.getElementById('password').focus();
            
            resetButton();
        }

        // Botón volver
        document.getElementById('backButton').addEventListener('click', function() {
            currentStep = 'email';
            currentUserData = null;
            
            // Ocultar grupo de contraseña
            document.getElementById('passwordGroup').style.display = 'none';
            document.getElementById('password').required = false;
            document.getElementById('password').value = '';
            
            // Ocultar botón volver
            document.getElementById('backButton').style.display = 'none';
            
            // Cambiar botón
            document.getElementById('loginIcon').className = 'fas fa-arrow-right';
            document.getElementById('loginText').textContent = 'Continuar';
            
            // Ocultar mensajes
            document.getElementById('successMessage').style.display = 'none';
            document.getElementById('errorMessage').style.display = 'none';
            
            // Focus en email
            document.getElementById('email').focus();
        });

        function showError(message) {
            const errorDiv = document.getElementById('errorMessage');
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
        }

        function resetButton() {
            const loginButton = document.getElementById('loginButton');
            const loginIcon = document.getElementById('loginIcon');
            const loginText = document.getElementById('loginText');
            const loadingSpinner = document.getElementById('loadingSpinner');
            
            loginButton.disabled = false;
            loginIcon.style.display = 'inline';
            loadingSpinner.style.display = 'none';
            loginText.textContent = 'Acceder al Portal';
        }

        let currentCustomerData = null;
        
        // Función para mostrar formulario de configuración de contraseña
        function showPasswordSetupForm(customerData) {
            currentCustomerData = customerData;
            
            // Ocultar formulario de login
            document.getElementById('loginForm').style.display = 'none';
            
            // Mostrar formulario de setup
            document.getElementById('passwordSetupForm').style.display = 'block';
            
            // Limpiar campos
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
            
            console.log('📝 Formulario de configuración de contraseña mostrado');
        }
        
        // Función para validar contraseña
        function validatePassword(password) {
            if (password.length < 8) {
                return 'La contraseña debe tener al menos 8 caracteres';
            }
            
            if (!/[a-zA-Z]/.test(password)) {
                return 'La contraseña debe contener al menos una letra';
            }
            
            if (!/[0-9]/.test(password)) {
                return 'La contraseña debe contener al menos un número';
            }
            
            return null;
        }
        
        // Event listener para formulario de setup de contraseña
        document.getElementById('passwordSetupForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            const setupBtn = document.getElementById('setupButton');
            const setupLoading = document.getElementById('setupLoadingSpinner');
            const setupError = document.getElementById('setupErrorMessage');
            const setupText = document.getElementById('setupText');
            const setupIcon = document.getElementById('setupIcon');
            
            // Reset states
            setupError.style.display = 'none';
            setupBtn.disabled = true;
            setupIcon.style.display = 'none';
            setupLoading.style.display = 'inline-block';
            setupText.textContent = 'Creando contraseña...';
            
            try {
                // Validar contraseña
                const passwordError = validatePassword(newPassword);
                if (passwordError) {
                    throw new Error(passwordError);
                }
                
                // Verificar que las contraseñas coincidan
                if (newPassword !== confirmPassword) {
                    throw new Error('Las contraseñas no coinciden');
                }
                
                if (!currentCustomerData || !currentCustomerData.email) {
                    throw new Error('Datos de cliente no disponibles');
                }
                
                const response = await fetch('/api/auth/setup-password', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ 
                        email: currentCustomerData.email, 
                        password: newPassword,
                        confirmPassword: confirmPassword
                    })
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.message || 'Error configurando contraseña');
                }
                
                if (data.success) {
                    setupText.textContent = '¡Contraseña creada!';
                    showNotification('¡Contraseña creada exitosamente! Redirigiendo...', 'success', 2000);
                    setTimeout(() => {
                        window.location.href = data.redirect || '/portal';
                    }, 1500);
                } else {
                    throw new Error('Error configurando contraseña');
                }
                
            } catch (error) {
                console.error('Error:', error);
                setupError.textContent = error.message;
                setupError.style.display = 'block';
                setupBtn.disabled = false;
                setupIcon.style.display = 'inline';
                setupLoading.style.display = 'none';
                setupText.textContent = 'Crear Contraseña';
            }
        });
        
        // Event listener para botón "Volver al Login"
        document.getElementById('backToLogin').addEventListener('click', function() {
            // Mostrar formulario de login
            document.getElementById('loginForm').style.display = 'block';
            
            // Ocultar formulario de setup
            document.getElementById('passwordSetupForm').style.display = 'none';
            
            // Limpiar campos del login
            document.getElementById('email').value = '';
            document.getElementById('password').value = '';
            
            // Limpiar estados
            document.getElementById('errorMessage').style.display = 'none';
            document.getElementById('setupErrorMessage').style.display = 'none';
            
            currentCustomerData = null;
            
            console.log('↩️ Regresando al formulario de login');
        });
        
        // No need for client-side auth detection - using proper session-based authentication
        
        // Function to generate full portal HTML in JavaScript
        function generateFullPortalHTML(customerData) {
            return \`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Portal B2B - IMANIX Chile</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Inter', sans-serif; 
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            min-height: 100vh;
        }
        .header {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid rgba(255, 206, 54, 0.3);
            padding: 1rem 0;
        }
        .header-content {
            max-width: 1200px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 2rem;
        }
        .logo {
            font-size: 1.8rem;
            font-weight: 800;
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .user-info {
            display: flex;
            align-items: center;
            gap: 1rem;
            color: #374151;
            font-weight: 600;
        }
        .main-content {
            max-width: 1200px;
            margin: 2rem auto;
            padding: 0 2rem;
        }
        .welcome-card {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 3rem;
            text-align: center;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            border: 1px solid rgba(255, 255, 255, 0.3);
            margin-bottom: 2rem;
        }
        .welcome-title {
            font-size: 2.5rem;
            font-weight: 800;
            color: #1f2937;
            margin-bottom: 1rem;
        }
        .welcome-subtitle {
            font-size: 1.2rem;
            color: #64748b;
            margin-bottom: 2rem;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 2rem;
            margin-top: 2rem;
        }
        .stat-card {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 16px;
            padding: 2rem;
            text-align: center;
            border: 1px solid rgba(255, 255, 255, 0.3);
            transition: transform 0.3s ease;
        }
        .stat-card:hover {
            transform: translateY(-5px);
        }
        .stat-icon {
            font-size: 3rem;
            color: #FFCE36;
            margin-bottom: 1rem;
        }
        .stat-title {
            font-size: 1.1rem;
            font-weight: 600;
            color: #374151;
            margin-bottom: 0.5rem;
        }
        .stat-value {
            font-size: 1.5rem;
            font-weight: 800;
            color: #1f2937;
        }
        .cta-button {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            color: #1f2937;
            border: none;
            padding: 1rem 2rem;
            border-radius: 12px;
            font-size: 1.1rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
        }
        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(247, 181, 0, 0.3);
        }
    </style>
</head>
<body>
    <header class="header">
        <div class="header-content">
            <div class="logo">🎯 IMANIX</div>
            <div class="user-info">
                <i class="fas fa-user"></i>
                <span>\${customerData.firstName} \${customerData.lastName}</span>
                <span>|</span>
                <span>\${customerData.email}</span>
            </div>
        </div>
    </header>
    
    <main class="main-content">
        <div class="welcome-card">
            <h1 class="welcome-title">¡Bienvenido, \${customerData.firstName}!</h1>
            <p class="welcome-subtitle">Portal B2B Exclusivo - IMANIX Chile</p>
            <p style="color: #64748b; margin-bottom: 2rem;">
                Has ingresado exitosamente al portal B2B de IMANIX Chile. 
                Aquí podrás realizar pedidos con precios especiales y gestionar tu cuenta empresarial.
            </p>
            <button class="cta-button" onclick="location.reload()">
                <i class="fas fa-shopping-cart"></i>
                Ver Catálogo de Productos
            </button>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon">
                    <i class="fas fa-box"></i>
                </div>
                <div class="stat-title">Productos Disponibles</div>
                <div class="stat-value">150+</div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon">
                    <i class="fas fa-percentage"></i>
                </div>
                <div class="stat-title">Descuento B2B</div>
                <div class="stat-value">Hasta 40%</div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon">
                    <i class="fas fa-truck"></i>
                </div>
                <div class="stat-title">Envío Gratuito</div>
                <div class="stat-value">Pedidos +$50.000</div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon">
                    <i class="fas fa-headset"></i>
                </div>
                <div class="stat-title">Soporte Dedicado</div>
                <div class="stat-value">24/7</div>
            </div>
        </div>
    </main>
</body>
</html>
            \`;
        }
    </script>
</body>
</html>`;
}

// Función para generar HTML del formulario de completar perfil
// Datos de regiones y comunas de Chile
const regionesComunas = {
  "Región de Arica y Parinacota": ["Arica", "Camarones", "Putre", "General Lagos"],
  "Región de Tarapacá": ["Iquique", "Alto Hospicio", "Pozo Almonte", "Camiña", "Colchane", "Huara", "Pica"],
  "Región de Antofagasta": ["Antofagasta", "Mejillones", "Sierra Gorda", "Taltal", "Calama", "Ollagüe", "San Pedro de Atacama", "Tocopilla", "María Elena"],
  "Región de Atacama": ["Copiapó", "Caldera", "Tierra Amarilla", "Chañaral", "Diego de Almagro", "Vallenar", "Alto del Carmen", "Freirina", "Huasco"],
  "Región de Coquimbo": ["La Serena", "Coquimbo", "Andacollo", "La Higuera", "Paiguano", "Vicuña", "Illapel", "Canela", "Los Vilos", "Salamanca", "Ovalle", "Combarbalá", "Monte Patria", "Punitaqui", "Río Hurtado"],
  "Región de Valparaíso": ["Valparaíso", "Casablanca", "Concón", "Juan Fernández", "Puchuncaví", "Quintero", "Viña del Mar", "Isla de Pascua", "Los Andes", "Calle Larga", "Rinconada", "San Esteban", "La Ligua", "Cabildo", "Papudo", "Petorca", "Zapallar", "Quillota", "Calera", "Hijuelas", "La Cruz", "Nogales", "San Antonio", "Algarrobo", "Cartagena", "El Quisco", "El Tabo", "Santo Domingo", "San Felipe", "Catemu", "Llaillay", "Panquehue", "Putaendo", "Santa María", "Quilpué", "Limache", "Olmué", "Villa Alemana"],
  "Región Metropolitana": ["Cerrillos", "Cerro Navia", "Conchalí", "El Bosque", "Estación Central", "Huechuraba", "Independencia", "La Cisterna", "La Florida", "La Granja", "La Pintana", "La Reina", "Las Condes", "Lo Barnechea", "Lo Espejo", "Lo Prado", "Macul", "Maipú", "Ñuñoa", "Pedro Aguirre Cerda", "Peñalolén", "Providencia", "Pudahuel", "Quilicura", "Quinta Normal", "Recoleta", "Renca", "Santiago", "San Joaquín", "San Miguel", "San Ramón", "Vitacura", "Puente Alto", "Pirque", "San José de Maipo", "Colina", "Lampa", "Tiltil", "San Bernardo", "Buin", "Calera de Tango", "Paine", "Melipilla", "Alhué", "Curacaví", "María Pinto", "San Pedro", "Talagante", "El Monte", "Isla de Maipo", "Padre Hurtado", "Peñaflor"],
  "Región del Libertador General Bernardo O'Higgins": ["Rancagua", "Codegua", "Coinco", "Coltauco", "Doñihue", "Graneros", "Las Cabras", "Machalí", "Malloa", "Mostazal", "Olivar", "Peumo", "Pichidegua", "Quinta de Tilcoco", "Rengo", "Requínoa", "San Vicente", "Pichilemu", "La Estrella", "Litueche", "Marchihue", "Navidad", "Paredones", "San Fernando", "Chépica", "Chimbarongo", "Lolol", "Nancagua", "Palmilla", "Peralillo", "Placilla", "Pumanque", "Santa Cruz"],
  "Región del Maule": ["Talca", "Constitución", "Curepto", "Empedrado", "Maule", "Pelarco", "Pencahue", "Río Claro", "San Clemente", "San Rafael", "Cauquenes", "Chanco", "Pelluhue", "Curicó", "Hualañé", "Licantén", "Molina", "Rauco", "Romeral", "Sagrada Familia", "Teno", "Vichuquén", "Linares", "Colbún", "Longaví", "Parral", "Retiro", "San Javier", "Villa Alegre", "Yerbas Buenas"],
  "Región de Ñuble": ["Chillán", "Bulnes", "Cobquecura", "Coelemu", "Coihueco", "Chillán Viejo", "El Carmen", "Ninhue", "Ñiquén", "Pemuco", "Pinto", "Portezuelo", "Quillón", "Quirihue", "Ránquil", "San Carlos", "San Fabián", "San Ignacio", "San Nicolás", "Treguaco", "Yungay"],
  "Región del Biobío": ["Concepción", "Coronel", "Chiguayante", "Florida", "Hualqui", "Lota", "Penco", "San Pedro de la Paz", "Santa Juana", "Talcahuano", "Tomé", "Hualpén", "Lebu", "Arauco", "Cañete", "Contulmo", "Curanilahue", "Los Álamos", "Tirúa", "Los Ángeles", "Antuco", "Cabrero", "Laja", "Mulchén", "Nacimiento", "Negrete", "Quilaco", "Quilleco", "San Rosendo", "Santa Bárbara", "Tucapel", "Yumbel", "Alto Biobío"],
  "Región de La Araucanía": ["Temuco", "Carahue", "Cunco", "Curarrehue", "Freire", "Galvarino", "Gorbea", "Lautaro", "Loncoche", "Melipeuco", "Nueva Imperial", "Padre Las Casas", "Perquenco", "Pitrufquén", "Pucón", "Saavedra", "Teodoro Schmidt", "Toltén", "Vilcún", "Villarrica", "Cholchol", "Angol", "Collipulli", "Curacautín", "Ercilla", "Lonquimay", "Los Sauces", "Lumaco", "Purén", "Renaico", "Traiguén", "Victoria"],
  "Región de Los Ríos": ["Valdivia", "Corral", "Lanco", "Los Lagos", "Máfil", "Mariquina", "Paillaco", "Panguipulli", "La Unión", "Futrono", "Lago Ranco", "Río Bueno"],
  "Región de Los Lagos": ["Puerto Montt", "Calbuco", "Cochamó", "Fresia", "Frutillar", "Los Muermos", "Llanquihue", "Maullín", "Puerto Varas", "Castro", "Ancud", "Chonchi", "Curaco de Vélez", "Dalcahue", "Puqueldón", "Queilén", "Quellón", "Quemchi", "Quinchao", "Osorno", "Puerto Octay", "Purranque", "Puyehue", "Río Negro", "San Juan de la Costa", "San Pablo", "Chaitén", "Futaleufú", "Hualaihué", "Palena"],
  "Región de Aysén": ["Coyhaique", "Lago Verde", "Aysén", "Cisnes", "Guaitecas", "Cochrane", "O'Higgins", "Tortel", "Chile Chico", "Río Ibáñez"],
  "Región de Magallanes y Antártica Chilena": ["Punta Arenas", "Laguna Blanca", "Río Verde", "San Gregorio", "Cabo de Hornos", "Antártica", "Porvenir", "Primavera", "Timaukel", "Natales", "Torres del Paine"]
};

function getCompleteProfileHTML(customer) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Completa tu Perfil Empresarial - Portal B2B IMANIX</title>
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
    </style>

    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #F8F9FA;
            min-height: 100vh;
            color: #1A202C;
            padding: 2rem;
        }

        .profile-container {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            padding: 3rem;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
            max-width: 800px;
            width: 100%;
            margin: 0 auto;
        }

        .profile-header {
            text-align: center;
            margin-bottom: 3rem;
        }

        .brand-logo {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #FFCE36, #FFC107);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 2rem;
            color: #1A202C;
            margin: 0 auto 1.5rem;
        }

        .profile-title {
            font-size: 2.2rem;
            font-weight: 800;
            color: #1A202C;
            margin-bottom: 0.5rem;
        }

        .profile-subtitle {
            color: #666;
            font-size: 1.1rem;
            margin-bottom: 1rem;
            font-weight: 500;
        }

        .profile-description {
            background: linear-gradient(135deg, #f8fafc, #e2e8f0);
            padding: 1.5rem;
            border-radius: 16px;
            border-left: 4px solid #FFCE36;
            margin-bottom: 2rem;
        }

        .profile-description h3 {
            color: #1A202C;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }

        .profile-description p {
            color: #555;
            line-height: 1.6;
            margin-bottom: 0.5rem;
        }

        .profile-form {
            display: grid;
            gap: 2rem;
        }

        .form-section {
            background: #f8fafc;
            padding: 2rem;
            border-radius: 16px;
            border: 2px solid #e2e8f0;
        }

        .section-title {
            font-size: 1.3rem;
            font-weight: 700;
            color: #1A202C;
            margin-bottom: 1.5rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1.5rem;
            margin-bottom: 1.5rem;
        }

        .form-group {
            position: relative;
        }

        .form-group.full-width {
            grid-column: 1 / -1;
        }

        .form-label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            color: #1A202C;
            font-size: 0.875rem;
        }

        .form-label .required {
            color: #EF4444;
            margin-left: 0.25rem;
        }

        .form-input, .form-select {
            width: 100%;
            padding: 1rem;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            font-size: 1rem;
            transition: all 0.3s ease;
            background: white;
            color: #1A202C;
        }

        .form-input:focus, .form-select:focus {
            border-color: #FFCE36;
            outline: none;
            box-shadow: 0 0 0 3px rgba(255, 206, 54, 0.2);
        }

        .submit-section {
            text-align: center;
            margin-top: 2rem;
        }

        .submit-button {
            background: linear-gradient(135deg, #FFCE36, #FFC107);
            color: #1A202C;
            border: none;
            padding: 1.25rem 3rem;
            border-radius: 12px;
            font-size: 1.1rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            min-height: 60px;
        }

        .submit-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(255, 206, 54, 0.4);
        }

        .submit-button:disabled {
            opacity: 0.7;
            cursor: not-allowed;
            transform: none;
        }

        .loading-spinner {
            display: none;
            width: 20px;
            height: 20px;
            border: 2px solid transparent;
            border-top: 2px solid #000000;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* Sistema de Notificaciones IMANIX */
        .notification-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            max-width: 400px;
        }

        .notification {
            margin-bottom: 10px;
            padding: 16px 20px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            opacity: 0;
            transform: translateX(100%);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            color: #1A202C;
            font-weight: 500;
        }

        .notification.show {
            opacity: 1;
            transform: translateX(0);
        }

        .notification-content {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .notification-icon {
            font-size: 20px;
            flex-shrink: 0;
        }

        .notification-message {
            flex: 1;
            font-size: 14px;
            line-height: 1.4;
        }

        .notification-close {
            background: none;
            border: none;
            color: #1A202C;
            cursor: pointer;
            font-size: 16px;
            padding: 4px;
            border-radius: 4px;
            opacity: 0.7;
            transition: opacity 0.2s;
            flex-shrink: 0;
        }

        .notification-close:hover {
            opacity: 1;
        }

        @media (max-width: 768px) {
            .profile-container {
                padding: 2rem;
                margin: 1rem;
            }

            .form-row {
                grid-template-columns: 1fr;
                gap: 1rem;
            }

            notification-container {
                left: 20px;
                right: 20px;
                max-width: none;
            }
        }
        /* ANIMACIONES DE ENTRADA SUTILES */
        .stat-card, .product-card, .cart-item {
            animation: fadeInUp 0.6s ease-out !important;
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* LOADING STATES ELEGANTES */
        .loading-spinner {
            border: 2px solid var(--gray-200) !important;
            border-top: 2px solid var(--imanix-yellow) !important;
        }
        
        /* PRECIO DESTACADO */
        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: white !important;
            font-weight: 800 !important;
            font-size: 1.25rem !important;
        }
        
        /* NAVBAR LOGO MEJORADO */
        .brand-logo {
            transition: all 0.3s ease !important;
        }
        .brand-logo:hover {
            transform: scale(1.05) !important;
            box-shadow: 0 4px 12px rgba(255, 206, 54, 0.3) !important;
        }
        
        /* CART SUMMARY ELEGANTE */
        .cart-summary {
            border-top: 3px solid var(--imanix-yellow) !important;
        }
        
        /* QUANTITY CONTROLS REFINADOS */
        .quantity-controls {
            background: var(--gray-50) !important;
            border: 1px solid var(--gray-200) !important;
        }
        
        /* NOTIFICACIONES PROFESIONALES */
        .notification {
            border-radius: 8px !important;
            backdrop-filter: blur(10px) !important;
        }
        
        /* ACCESIBILIDAD MEJORADA */
        .btn:focus, .form-input:focus, .form-select:focus {
            outline: 2px solid var(--imanix-yellow) !important;
            outline-offset: 2px !important;
        }
        /* CORRECCIONES DE CONTRASTE ESPECÍFICAS */
        .discounted-price, .item-total-price.discounted {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            display: inline-block !important;
        }
        
        .savings, .price-breakdown.highlight {
            color: #10B981 !important;
            font-weight: 600 !important;
        }
        
        .discount-badge, .cart-navbar-badge {
            color: white !important;
            font-weight: 700 !important;
        }
        
        /* Asegurar contraste en todos los elementos verdes */
        .success-text, .discount-text, .savings-amount {
            color: white !important;
            background: #10B981 !important;
            padding: 0.125rem 0.25rem !important;
            border-radius: 3px !important;
        }
        /* PRECIOS MEJORADOS CON CONTRASTE PERFECTO */
        .discounted-price-block {
            background: #10B981 !important;
            color: white !important;
            padding: 0.75rem 1rem !important;
            border-radius: 8px !important;
            margin-bottom: 0.5rem !important;
        }
        
        .discounted-price {
            color: white !important;
            font-size: 1.5rem !important;
            font-weight: 800 !important;
            display: block !important;
            margin-bottom: 0.25rem !important;
        }
        
        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.9) !important;
            font-size: 0.875rem !important;
        }
        
        .savings {
            color: #10B981 !important;
            font-weight: 600 !important;
            font-size: 0.875rem !important;
        }
        
        /* NOTIFICACIONES CON CONTRASTE PERFECTO */
        .notification {
            color: white !important;
        }
        
        .notification-message {
            color: white !important;
        }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }
        
        .cart-navbar-badge {
            background: #EF4444 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }






    </style>
</head>
<body>
    <div class="profile-container">
        <div class="profile-header">
            <div class="brand-logo">
                <svg width="140" height="45" viewBox="0 0 140 45" fill="none" xmlns="http://www.w3.org/2000/svg" style="height: 40px; width: auto;">
                    <text x="5" y="28" font-family="Arial, sans-serif" font-size="22" font-weight="900" fill="#FFFFFF">IMANIX</text>
                    <text x="5" y="40" font-family="Arial, sans-serif" font-size="9" fill="#E2E8F0">by BrainToys</text>
                    <circle cx="120" cy="20" r="10" fill="#FFCE36"/>
                    <circle cx="120" cy="20" r="6" fill="#2D3748"/>
                    <circle cx="120" cy="20" r="3" fill="#FFCE36"/>
                </svg>
            </div>
            <h1 class="profile-title">Completa tu Perfil Empresarial</h1>
            <p class="profile-subtitle">¡Bienvenido ${customer?.firstName || 'Usuario' || ''}! Para continuar al portal B2B, necesitamos algunos datos de tu empresa.</p>
            
            <div class="profile-description">
                <h3><i class="fas fa-info-circle"></i> ¿Por qué necesitamos esta información?</h3>
                <p>• <strong>Facturación precisa:</strong> Los datos aparecerán en todas tus órdenes de compra</p>
                <p>• <strong>Proceso más rápido:</strong> No tendrás que completar estos datos en cada pedido</p>
                <p>• <strong>Comunicación directa:</strong> Te contactaremos para confirmar pedidos y coordinar entregas</p>
            </div>
        </div>

        <form class="profile-form" id="profileForm">
            <!-- Datos Personales -->
            <div class="form-section">
                <h2 class="section-title">
                    <i class="fas fa-user"></i>
                    Datos Personales
                </h2>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="first_name">Nombre <span class="required">*</span></label>
                        <input type="text" id="first_name" name="first_name" class="form-input" 
                               placeholder="Tu nombre" required value="${customer?.firstName || 'Usuario' || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="last_name">Apellido <span class="required">*</span></label>
                        <input type="text" id="last_name" name="last_name" class="form-input" 
                               placeholder="Tu apellido" required value="${customer?.lastName || ''}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="mobile_phone">Celular <span class="required">*</span></label>
                        <input type="tel" id="mobile_phone" name="mobile_phone" class="form-input" 
                               placeholder="+56 9 1234 5678" required>
                    </div>
                    <div class="form-group">
                        <!-- Espacio para mantener el layout en dos columnas -->
                    </div>
                </div>
                <div class="form-group full-width">
                    <label class="form-label" for="email">Email</label>
                    <input type="email" id="email" name="email" class="form-input" 
                           value="${customer?.email || 'no-email@example.com'}" readonly style="background: #f3f4f6; cursor: not-allowed;">
                </div>
            </div>

            <!-- Datos Empresariales -->
            <div class="form-section">
                <h2 class="section-title">
                    <i class="fas fa-building"></i>
                    Datos Empresariales
                </h2>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="company_name">Razón Social <span class="required">*</span></label>
                        <input type="text" id="company_name" name="company_name" class="form-input" 
                               placeholder="Empresa SPA" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="company_rut">RUT Empresa <span class="required">*</span></label>
                        <input type="text" id="company_rut" name="company_rut" class="form-input" 
                               placeholder="12.345.678-9" required>
                    </div>
                </div>
                <div class="form-group full-width">
                    <label class="form-label" for="company_giro">Giro Empresarial <span class="required">*</span></label>
                    <input type="text" id="company_giro" name="company_giro" class="form-input" 
                           placeholder="Venta al por menor de juguetes" required>
                </div>
                <div class="form-group full-width">
                    <label class="form-label" for="company_address">Dirección <span class="required">*</span></label>
                    <input type="text" id="company_address" name="company_address" class="form-input" 
                           placeholder="Av. Ejemplo 1234" required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="region">Región <span class="required">*</span></label>
                        <select id="region" name="region" class="form-select" required onchange="updateComunas()">
                            <option value="">Selecciona tu región</option>
                            ${Object.keys(regionesComunas).map(region => 
                                `<option value="${region}">${region}</option>`
                            ).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="comuna">Comuna <span class="required">*</span></label>
                        <select id="comuna" name="comuna" class="form-select" required disabled>
                            <option value="">Primero selecciona una región</option>
                        </select>
                    </div>
                </div>
            </div>

            <div class="submit-section">
                <button type="submit" class="submit-button" id="submitButton">
                    <span class="loading-spinner" id="loadingSpinner"></span>
                    <i class="fas fa-save" id="submitIcon"></i>
                    <span id="submitText">Guardar y Continuar al Portal</span>
                </button>
            </div>
        </form>
    </div>

    <!-- Sistema de Notificaciones IMANIX -->
    <div id="notificationContainer" class="notification-container"></div>

    <script>
        // Sistema de Notificaciones con Branding IMANIX
        function showNotification(message, type = 'info', duration = 5000) {
            const container = document.getElementById('notificationContainer');
            if (!container) return;
            
            const notification = document.createElement('div');
            
            const typeConfig = {
                success: {
                    icon: 'fas fa-check-circle',
                    bgColor: '#10B981',
                    borderColor: '#059669'
                },
                error: {
                    icon: 'fas fa-exclamation-triangle',
                    bgColor: '#EF4444',
                    borderColor: '#DC2626'
                },
                warning: {
                    icon: 'fas fa-exclamation-triangle',
                    bgColor: '#F59E0B',
                    borderColor: '#D97706'
                },
                info: {
                    icon: 'fas fa-info-circle',
                    bgColor: '#3B82F6',
                    borderColor: '#2563EB'
                }
            };
            
            const config = typeConfig[type] || typeConfig.info;
            
            notification.className = 'notification notification-' + type;
            notification.innerHTML = \`
                <div class="notification-content">
                    <div class="notification-icon">
                        <i class="\${config.icon}"></i>
                    </div>
                    <div class="notification-message">\${message}</div>
                    <button class="notification-close" onclick="closeNotification(this)">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            \`;
            
            // Estilos dinámicos
            notification.style.cssText = \`
                background: linear-gradient(135deg, \${config.bgColor}, \${config.borderColor});
                border-left: 4px solid \${config.borderColor};
            \`;
            
            container.appendChild(notification);
            
            // Animación de entrada
            setTimeout(() => notification.classList.add('show'), 100);
            
            // Auto-cerrar después del tiempo especificado
            if (duration > 0) {
                setTimeout(() => {
                    closeNotification(notification.querySelector('.notification-close'));
                }, duration);
            }
        }
        
        function closeNotification(closeBtn) {
            const notification = closeBtn.closest('.notification');
            if (notification) {
                notification.classList.remove('show');
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 300);
            }
        }

        // Manejo del formulario
        document.getElementById('profileForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitButton = document.getElementById('submitButton');
            const submitIcon = document.getElementById('submitIcon');
            const submitText = document.getElementById('submitText');
            const loadingSpinner = document.getElementById('loadingSpinner');
            
            // Mostrar estado de carga
            submitButton.disabled = true;
            submitIcon.style.display = 'none';
            loadingSpinner.style.display = 'inline-block';
            submitText.textContent = 'Guardando...';
            
            // Recopilar datos del formulario
            const formData = new FormData(e.target);
            const profileData = Object.fromEntries(formData.entries());

            try {
                const response = await fetch('/api/profile/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(profileData)
                });

                const data = await response.json();

                if (data.success) {
                    showNotification('¡Perfil guardado exitosamente! Redirigiendo al portal...', 'success', 2000);
                    submitText.textContent = '¡Datos guardados!';
                    
                    setTimeout(() => {
                        window.location.href = '/';
                    }, 2000);
                } else {
                    showNotification(data.message || 'Error al guardar el perfil. Inténtalo nuevamente.', 'error');
                    resetButton();
                }
            } catch (error) {
                console.error('Error enviando formulario:', error);
                showNotification('Error de conexión. Por favor, inténtalo nuevamente.', 'error');
                resetButton();
            }
        });

        function resetButton() {
            const submitButton = document.getElementById('submitButton');
            const submitIcon = document.getElementById('submitIcon');
            const submitText = document.getElementById('submitText');
            const loadingSpinner = document.getElementById('loadingSpinner');
            
            submitButton.disabled = false;
            submitIcon.style.display = 'inline';
            loadingSpinner.style.display = 'none';
            submitText.textContent = 'Guardar y Continuar al Portal';
        }

        // Datos de regiones y comunas de Chile
        const regionesComunas = ${JSON.stringify(regionesComunas, null, 8)};
        
        // Función para actualizar comunas según región seleccionada
        function updateComunas() {
            const regionSelect = document.getElementById('region');
            const comunaSelect = document.getElementById('comuna');
            const selectedRegion = regionSelect.value;
            
            // Limpiar opciones actuales
            comunaSelect.innerHTML = '<option value="">Selecciona una comuna</option>';
            
            if (selectedRegion && regionesComunas[selectedRegion]) {
                // Habilitar el select de comunas
                comunaSelect.disabled = false;
                
                // Agregar las comunas de la región seleccionada
                regionesComunas[selectedRegion].forEach(comuna => {
                    const option = document.createElement('option');
                    option.value = comuna;
                    option.textContent = comuna;
                    comunaSelect.appendChild(option);
                });
            } else {
                // Deshabilitar el select de comunas
                comunaSelect.disabled = true;
                comunaSelect.innerHTML = '<option value="">Primero selecciona una región</option>';
            }
        }

        // Formateo automático del RUT
        document.getElementById('company_rut').addEventListener('input', function(e) {
            let value = e.target.value.replace(/[^0-9kK]/g, '');
            
            if (value.length > 1) {
                let rut = value.slice(0, -1);
                let dv = value.slice(-1);
                
                // Formatear con puntos
                rut = rut.replace(/(\\d)(?=(\\d{3})+(?!\\d))/g, '$1.');
                
                e.target.value = rut + '-' + dv;
            }
        });

        // Formateo automático del teléfono
        function formatPhone(input) {
            input.addEventListener('input', function(e) {
                let value = e.target.value.replace(/[^0-9+]/g, '');
                
                if (value.startsWith('56')) {
                    value = '+' + value;
                } else if (value.startsWith('9') && value.length === 9) {
                    value = '+56 ' + value;
                }
                
                e.target.value = value;
            });
        }

        formatPhone(document.getElementById('mobile_phone'));
    </script>
</body>
</html>`;
}

// Función para generar HTML del portal
function getPortalHTML(products, customer) {
    const customerDiscount = customer?.discount || 0;
    
    // Función helper para renderizar los productos
    function renderProducts(products, discount) {
        if (!products || products.length === 0) {
            return `
                <div class="no-products">
                    <i class="fas fa-box-open"></i>
                    <h3>No hay productos disponibles</h3>
                    <p>Los productos B2B aparecerán aquí próximamente</p>
                </div>
            `;
        }

        return products.map(product => {
            const variant = product.variants?.edges?.[0]?.node;
            const originalPrice = variant?.price ? parseInt(variant.price) : 0;
            const discountedPrice = applyB2BDiscount(originalPrice, discount);
            const savings = originalPrice - discountedPrice;
            
            // Calcular neto e IVA para precio con descuento
            const discountedPriceNeto = calculateNetPrice(discountedPrice);
            const discountedPriceIVA = calculateIVA(discountedPriceNeto);
            
            // Calcular neto e IVA para precio original
            const originalPriceNeto = calculateNetPrice(originalPrice);
            const originalPriceIVA = calculateIVA(originalPriceNeto);
            
            const image = product.images?.edges?.[0]?.node?.url || '/placeholder.jpg';
            const stock = variant?.inventoryQuantity || 0;

            // Extraer metacampos
            const metafields = {};
            if (product.metafields?.edges) {
                product.metafields.edges.forEach(edge => {
                    const metafield = edge.node;
                    metafields[`${metafield.namespace}.${metafield.key}`] = metafield.value;
                });
            }

            return `
                <div class="product-card" 
                     data-tags="${product.tags || ''}" 
                     data-price="${discountedPrice}" 
                     data-stock="${stock}"
                     data-metafields='${JSON.stringify(metafields).replace(/'/g, "&#39;")}'>
                    <div class="product-image">
                        <img src="${image}" alt="${product.title}" loading="lazy">
                        <div class="discount-overlay">${discount}% OFF</div>
                        ${stock > 0 ? `<div class="stock-badge">${stock} disponibles</div>` : '<div class="stock-badge out-of-stock">Sin stock</div>'}
                    </div>
                    <div class="product-info">
                        <h3 class="product-title">${product.title}</h3>
                        <div class="product-pricing">
                            <div class="price-row">
                                <div class="discounted-price-block">
                                    <span class="discounted-price">${formatPrice(discountedPrice)}</span>
                                    <div class="price-breakdown highlight">Neto: ${formatPrice(discountedPriceNeto)} + IVA: ${formatPrice(discountedPriceIVA)}</div>
                                </div>
                            </div>
                            <div class="savings">Precio original: ${formatPrice(originalPrice)} • Ahorras ${formatPrice(savings)}</div>
                        </div>
                        <div class="product-meta">
                            <span class="sku">SKU: ${variant?.sku || 'N/A'}</span>
                            <span class="stock-count">${stock} unidades</span>
                        </div>
                        <button class="add-to-cart-btn" ${stock === 0 ? 'disabled' : ''} 
                                onclick="addToCart('${product.id}', '${variant?.id}', '${product.title.replace(/'/g, '&#39;').replace(/"/g, '&quot;')}', ${discountedPrice}, '${image}')">
                            <i class="fas fa-cart-plus"></i>
                            ${stock > 0 ? 'Agregar al Carrito' : 'Sin Stock'}
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Portal B2B Profesional - IMANIX Chile</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">

    <!-- 🚀 CRITICAL: GLOBAL FUNCTIONS LOADED FIRST -->
    <script>
        // Variables globales
        var cart = JSON.parse(localStorage.getItem('b2bCart')) || [];
        
        // FUNCIÓN GLOBAL CRÍTICA: applyFilters debe estar disponible desde el inicio
        // FUNCIÓN CRÍTICA: applyFilters debe estar disponible desde el inicio
        window.applyFilters = function() {
            console.log('🔍 applyFilters llamada (función global inicial)');
            // Esta función será reemplazada por la implementación completa más abajo
            // Función básica que al menos no genera error
            var searchTerm = document.getElementById('searchInput') ? document.getElementById('searchInput').value.toLowerCase() : '';
            var productCards = document.querySelectorAll('.product-card');
            
            productCards.forEach(function(card) {
                var shouldShow = true;
                
                // Filtro básico por búsqueda
                if (searchTerm) {
                    var titleEl = card.querySelector('.product-title');
                    var title = titleEl ? titleEl.textContent.toLowerCase() : '';
                    var skuElement = card.querySelector('.sku');
                    var sku = skuElement ? skuElement.textContent.toLowerCase() : '';
                    if (!title.includes(searchTerm) && !sku.includes(searchTerm)) {
                        shouldShow = false;
                    }
                }
                
                card.style.display = shouldShow ? 'block' : 'none';
            });
        };
        
        // DEFINIR TODAS LAS FUNCIONES GLOBALMENTE ANTES QUE CUALQUIER HTML
        window.toggleUserDropdown = function() {
            console.log('✅ toggleUserDropdown ejecutada');
            var dropdown = document.getElementById('userDropdown');
            if (dropdown) {
                dropdown.classList.toggle('show');
            }
        };
        
        window.toggleFilters = function() {
            console.log('✅ toggleFilters ejecutada');
            var panel = document.getElementById('filtersPanel');
            if (panel) {
                panel.classList.toggle('show');
                
                // Si se está mostrando el panel, inicializar filtros
                if (panel.classList.contains('show')) {
                    setTimeout(function() {
                        if (typeof window.initializeFilters === 'function') {
                            window.initializeFilters();
                        }
                    }, 100);
                }
            }
        };
        
        window.showCart = function() {
            console.log('✅ showCart ejecutada');
            window.location.href = '/carrito';
        };
        
        window.updateCartBadge = function() {
            var badge = document.getElementById('cartNavbarBadge');
            var totalItems = cart.reduce(function(sum, item) { return sum + item.quantity; }, 0);
            if (badge) {
                badge.textContent = totalItems;
            }
        };
        
        window.showNotification = function(message, type) {
            // Crear elemento de notificación
            var notification = document.createElement('div');
            var bgColor = type === 'success' ? '#10b981' : '#ef4444';
            notification.style.cssText = 
                'position: fixed;' +
                'top: 20px;' +
                'right: 20px;' +
                'background: ' + bgColor + ';' +
                'color: white;' +
                'padding: 1rem 1.5rem;' +
                'border-radius: 12px;' +
                'box-shadow: 0 10px 30px rgba(0,0,0,0.2);' +
                'z-index: 10000;' +
                'font-weight: 600;' +
                'transform: translateX(100%);' +
                'transition: transform 0.3s ease;';
            notification.textContent = message;
            
            document.body.appendChild(notification);
            
            // Animar entrada
            setTimeout(function() {
                notification.style.transform = 'translateX(0)';
            }, 100);
            
            // Remover después de 3 segundos
            setTimeout(function() {
                notification.style.transform = 'translateX(100%)';
                setTimeout(function() {
                    if (document.body.contains(notification)) {
                        document.body.removeChild(notification);
                    }
                }, 300);
            }, 3000);
        };
        
        window.addToCart = function(productId, variantId, title, price, image) {
            console.log('✅ addToCart ejecutada:', title);
            try {
                var existingItem = cart.find(function(item) { 
                    return item.productId === productId || item.title === title; 
                });
                
                if (existingItem) {
                    existingItem.quantity += 1;
                } else {
                    cart.push({
                        productId: productId || 'product_' + Date.now(),
                        variantId: variantId || 'variant_' + Date.now(),
                        title: title,
                        price: price,
                        image: image,
                        quantity: 1
                    });
                }
                
                localStorage.setItem('b2bCart', JSON.stringify(cart));
                
                // Actualizar badge y mostrar notificación
                window.updateCartBadge();
                window.showNotification(title + ' agregado al carrito', 'success');
                
            } catch (error) {
                console.error('❌ Error adding to cart:', error);
                window.showNotification('Error agregando producto', 'error');
            }
        };
        
        window.logout = function() {
            console.log('✅ logout ejecutada');
            if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
                fetch('/api/auth/logout', { method: 'POST' })
                    .then(function(response) { return response.json(); })
                    .then(function(data) {
                        localStorage.removeItem('b2bCart');
                        window.location.reload();
                    })
                    .catch(function(error) {
                        console.error('Error:', error);
                        window.location.reload();
                    });
            }
        };
        
        window.clearAllFilters = function() {
            console.log('✅ clearAllFilters ejecutada');
            try {
                var checkboxes = document.querySelectorAll('.filter-checkbox input[type="checkbox"]');
                checkboxes.forEach(function(cb) { cb.checked = false; });
                
                var productCards = document.querySelectorAll('.product-card');
                productCards.forEach(function(card) {
                    card.style.display = 'block';
                });
            } catch (error) {
                console.error('❌ Error clearing filters:', error);
            }
        };
        
        // ESTA FUNCIÓN SE MANTIENE PARA COMPATIBILIDAD PERO SE USA LA PRINCIPAL DEL BODY
        window.applyFiltersHead = function() {
            console.log('🔍 Aplicando filtros con METACAMPOS (HEAD)...');
            
            // Variables globales para filtros
            var activeFilters = {
                collections: [],
                categories: [],
                ages: [],
                availability: [],
                priceRange: { min: null, max: null }
            };
            
            // Recopilar filtros activos
            activeFilters.collections = Array.from(document.querySelectorAll('#collectionFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.categories = Array.from(document.querySelectorAll('#categoryFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.ages = Array.from(document.querySelectorAll('#ageFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.availability = Array.from(document.querySelectorAll('.filter-options input:checked')).map(function(cb) { return cb.value; });
            
            var minPriceEl = document.getElementById('minPrice');
            var maxPriceEl = document.getElementById('maxPrice');
            var minPrice = minPriceEl ? minPriceEl.value : '';
            var maxPrice = maxPriceEl ? maxPriceEl.value : '';
            activeFilters.priceRange.min = minPrice ? parseInt(minPrice) : null;
            activeFilters.priceRange.max = maxPrice ? parseInt(maxPrice) : null;
            
            console.log('🎯 Filtros activos:', activeFilters);
            
            // Aplicar filtros a productos
            var productCards = document.querySelectorAll('.product-card');
            var visibleCount = 0;
            
            productCards.forEach(function(card) {
                var shouldShow = true;
                
                // Obtener metacampos del producto
                var productMetafields = {};
                var metafieldsAttr = card.getAttribute('data-metafields');
                if (metafieldsAttr) {
                    try {
                        // Limpieza más robusta del JSON
                        var cleanedJson = metafieldsAttr
                            .replace(/&#39;/g, "'")
                            .replace(/\\r?\\n|\\r/g, " ")
                            .replace(/\\t/g, " ")
                            .replace(/\\s+/g, " ")
                            .replace(/,\\s*}/g, "}")
                            .replace(/,\\s*]/g, "]")
                            .trim();
                        productMetafields = JSON.parse(cleanedJson);
                    } catch (error) {
                        console.warn('Error parseando metacampos en filtro:', error);
                        productMetafields = {}; // Fallback seguro
                    }
                }
                
                // Extraer valores de metacampos para filtrado
                var metaValues = Object.values(productMetafields);
                
                // Filtro por texto de búsqueda
                var searchInputEl = document.getElementById('searchInput');
                var searchTerm = searchInputEl ? searchInputEl.value.toLowerCase() : '';
                if (searchTerm) {
                    var titleEl = card.querySelector('.product-title');
                    var title = titleEl ? titleEl.textContent.toLowerCase() : '';
                    var skuElement = card.querySelector('.sku');
                    var sku = skuElement ? skuElement.textContent.toLowerCase() : '';
                    if (!title.includes(searchTerm) && !sku.includes(searchTerm)) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por Sub-Categorías (antes colecciones)
                if (activeFilters.collections.length > 0 && shouldShow) {
                    var hasSubCategoria = activeFilters.collections.some(function(subCategoria) {
                        return metaValues.includes(subCategoria);
                    });
                    if (!hasSubCategoria) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por Marcas (antes categorías)
                if (activeFilters.categories.length > 0 && shouldShow) {
                    var hasMarca = activeFilters.categories.some(function(marca) {
                        return metaValues.includes(marca);
                    });
                    if (!hasMarca) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por Edades (mejorado para múltiples líneas)
                if (activeFilters.ages.length > 0 && shouldShow) {
                    var hasEdad = activeFilters.ages.some(function(edad) {
                        // Buscar coincidencia exacta o parcial
                        return metaValues.some(function(metaValue) {
                            if (!metaValue) return false;
                            // Limpiar IDs de Shopify
                            if (typeof metaValue === 'string' && metaValue.startsWith('gid://shopify/')) return false;
                            
                            // Convertir a string si no lo es
                            var valueStr = String(metaValue);
                            
                            // Si contiene saltos de línea, separar y buscar en cada línea
                            if (valueStr.includes('\n') || valueStr.includes('\r')) {
                                var lines = valueStr.split(/[\\n\\r]+/);
                                return lines.some(function(line) {
                                    var cleanLine = line.trim();
                                    return cleanLine === edad || cleanLine.toLowerCase().includes(edad.toLowerCase());
                                });
                            }
                            
                            // Coincidencia exacta o contiene
                            return valueStr === edad || valueStr.toLowerCase().includes(edad.toLowerCase());
                        });
                    });
                    if (!hasEdad) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por disponibilidad
                if (activeFilters.availability.length > 0 && shouldShow) {
                    var stock = parseInt(card.getAttribute('data-stock')) || 0;
                    var inStock = stock > 0;
                    
                    if (activeFilters.availability.includes('in-stock') && !inStock) {
                        shouldShow = false;
                    }
                    if (activeFilters.availability.includes('out-of-stock') && inStock) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por precio
                if ((activeFilters.priceRange.min || activeFilters.priceRange.max) && shouldShow) {
                    var price = parseInt(card.getAttribute('data-price')) || 0;
                    
                    if (activeFilters.priceRange.min && price < activeFilters.priceRange.min) {
                        shouldShow = false;
                    }
                    if (activeFilters.priceRange.max && price > activeFilters.priceRange.max) {
                        shouldShow = false;
                    }
                }
                
                // Mostrar/ocultar producto
                card.style.display = shouldShow ? 'block' : 'none';
                if (shouldShow) visibleCount++;
            });
            
            console.log('📊 Productos filtrados:', visibleCount + '/' + productCards.length);
            
            // Mostrar mensaje si no hay productos
            var productsGrid = document.getElementById('productsGrid');
            var noProductsMsg = productsGrid ? productsGrid.querySelector('.no-products-filtered') : null;
            
            if (visibleCount === 0) {
                if (!noProductsMsg) {
                    noProductsMsg = document.createElement('div');
                    noProductsMsg.className = 'no-products-filtered';
                    noProductsMsg.innerHTML = 
                        '<div style="text-align: center; padding: 3rem; color: #666;">' +
                            '<i class="fas fa-search" style="font-size: 3rem; margin-bottom: 1rem; color: #d1d5db;"></i>' +
                            '<h3>No se encontraron productos</h3>' +
                            '<p>Intenta ajustar los filtros para ver más resultados</p>' +
                        '</div>';
                    productsGrid.appendChild(noProductsMsg);
                }
                noProductsMsg.style.display = 'block';
            } else {
                if (noProductsMsg) {
                    noProductsMsg.style.display = 'none';
                }
            }
        };
        
        window.removeFilter = function(type, value) {
            console.log('✅ removeFilter ejecutada:', type, value);
        };
        
        // Función para limpiar y extraer valor legible de IDs de Shopify
        function cleanShopifyValue(value, key) {
            if (!value) return null;
            
            console.log('🔍 cleanShopifyValue - Input:', value, 'Key:', key);
            
            // Si es un ID de Shopify, intentar extraer información útil
            if (typeof value === 'string' && value.startsWith('gid://shopify/')) {
                console.log('🔧 Procesando ID de Shopify:', value, 'para key:', key);
                
                // Para edades, podríamos mapear IDs conocidos a valores legibles
                var ageMapping = {
                    '122522435859': '3-5 años',
                    '98466890003': '5-9 años',
                    '35341876855059': '9+ años',
                    '39573422145811': 'Experto'
                };
                
                // Extraer el ID numérico del final
                var idMatch = value.match(/\\\\/(\\\d+)$/);
                if (idMatch && ageMapping[idMatch[1]]) {
                    console.log('✅ ID mapeado:', idMatch[1], '->', ageMapping[idMatch[1]]);
                    return ageMapping[idMatch[1]];
                }
                
                // Si no tenemos mapeo, usar el ID como valor temporal
                return 'ID-' + (idMatch ? idMatch[1] : 'unknown');
            }
            
            // Si es un array (múltiples valores), convertir a string separado por saltos de línea
            if (Array.isArray(value)) {
                console.log('📋 Array detectado:', value);
                return value.join('\n');
            }
            
            // Si es un objeto, intentar extraer información útil
            if (typeof value === 'object' && value !== null) {
                console.log('🔧 Objeto detectado:', value);
                // Buscar propiedades comunes como 'value', 'text', 'name'
                if (value.value) return value.value;
                if (value.text) return value.text;
                if (value.name) return value.name;
                // Si no, convertir a JSON string
                return JSON.stringify(value);
            }
            
            console.log('✅ Valor limpio:', value);
            return value;
        }
        
        // Función principal para inicializar los filtros con METACAMPOS de Shopify
        function initializeFilters() {
            console.log('🔍 Inicializando filtros con metacampos de Shopify...');
            
            var products = Array.from(document.querySelectorAll('.product-card'));
            var subCategorias = new Set();
            var marcas = new Set();
            var edades = new Set();
            var cantidadPiezas = new Set();
            var allMetafields = {};
            
            console.log('📦 Productos encontrados:', products.length);
            
            // Extraer todos los metacampos de los productos
            products.forEach(function(card) {
                var metafieldsAttr = card.getAttribute('data-metafields');
                console.log('🏷️ Metacampos del producto:', metafieldsAttr);
                
                if (metafieldsAttr) {
                    try {
                        // Limpieza más robusta del JSON
                        var cleanedJson = metafieldsAttr
                            .replace(/&#39;/g, "'")
                            .replace(/\\r?\\n|\\r/g, " ")
                            .replace(/\\t/g, " ")
                            .replace(/\\s+/g, " ")
                            .replace(/,\\s*}/g, "}")
                            .replace(/,\\s*]/g, "]")
                            .trim();
                        var metafields = JSON.parse(cleanedJson);
                        
                        // Organizar metacampos por tipo
                        Object.keys(metafields).forEach(function(key) {
                            var value = metafields[key];
                            if (value) {
                                // Limpiar el valor usando la función especializada
                                var cleanValue = cleanShopifyValue(value, key);
                                if (!cleanValue) return; // Saltar valores nulos
                                
                                // Agregar a la colección general
                                if (!allMetafields[key]) {
                                    allMetafields[key] = new Set();
                                }
                                allMetafields[key].add(cleanValue);
                                
                                // Clasificar por tipo de metacampo
                                var keyLower = key.toLowerCase();
                                
                                if (keyLower.includes('subcategor') || keyLower.includes('sub-categor') || keyLower.includes('categoria')) {
                                    subCategorias.add(cleanValue);
                                }
                                else if (keyLower.includes('marca') || keyLower.includes('brand')) {
                                    marcas.add(cleanValue);
                                }
                                else if (keyLower.includes('edad') || keyLower.includes('age') || keyLower.includes('años') || 
                                         key === 'filtros.productos.edades' || key.includes('edades')) {
                                    console.log('🎯 Edad encontrada (RAW):', key, '=', value);
                                    console.log('🎯 Edad limpia:', key, '=', cleanValue);
                                    console.log('🎯 Tipo de valor:', typeof cleanValue);
                                    
                                    // Si es múltiples líneas, separar por saltos de línea
                                    if (cleanValue && typeof cleanValue === 'string') {
                                        var edadValues = cleanValue.split(/[\\n\\r]+/).filter(function(v) { 
                                            return v.trim().length > 0; 
                                        });
                                        
                                        console.log('🎯 Edades separadas:', edadValues);
                                        
                                        edadValues.forEach(function(edad) {
                                            var edadTrimmed = edad.trim();
                                            if (edadTrimmed) {
                                                edades.add(edadTrimmed);
                                                console.log('✅ Edad agregada:', edadTrimmed);
                                            }
                                        });
                                    } else {
                                        edades.add(cleanValue);
                                    }
                                }
                                else if (keyLower.includes('pieza') || keyLower.includes('piece') || keyLower.includes('cantidad')) {
                                    cantidadPiezas.add(cleanValue);
                                }
                                else {
                                    // Agregar a categorías por defecto si no encaja en ninguna
                                    console.log('📋 Metacampo no clasificado:', key, '=', cleanValue);
                                }
                            }
                        });
                    } catch (error) {
                        console.error('Error parseando metacampos:', error);
                    }
                }
            });
            
            console.log('📊 Metacampos extraídos:', {
                subCategorias: subCategorias.size,
                marcas: marcas.size,
                edades: edades.size,
                cantidadPiezas: cantidadPiezas.size,
                allMetafields: Object.keys(allMetafields)
            });
            
            // Convertir a arrays y ordenar
            var subCategoriasArray = Array.from(subCategorias).sort();
            var marcasArray = Array.from(marcas).sort();
            var edadesArray = Array.from(edades).sort();
            
            // Llenar filtros de Sub-Categorías (antes Colecciones)
            var collectionFilters = document.getElementById('collectionFilters');
            if (collectionFilters) {
                if (subCategoriasArray.length > 0) {
                    collectionFilters.innerHTML = subCategoriasArray.map(function(subCategoria) {
                        return '<label class="filter-checkbox">' +
                            '<input type="checkbox" value="' + subCategoria + '" onchange="applyFilters()">' +
                            '<span class="checkmark"></span>' +
                            subCategoria +
                        '</label>';
                    }).join('');
                } else {
                    collectionFilters.innerHTML = '<p style="color: #666; font-style: italic;">No hay sub-categorías disponibles</p>';
                }
            }
            
            // Llenar filtros de Marcas (antes Categorías)
            var categoryFilters = document.getElementById('categoryFilters');
            if (categoryFilters) {
                if (marcasArray.length > 0) {
                    categoryFilters.innerHTML = marcasArray.map(function(marca) {
                        return '<label class="filter-checkbox">' +
                            '<input type="checkbox" value="' + marca + '" onchange="applyFilters()">' +
                            '<span class="checkmark"></span>' +
                            marca +
                        '</label>';
                    }).join('');
                } else {
                    categoryFilters.innerHTML = '<p style="color: #666; font-style: italic;">No hay marcas disponibles</p>';
                }
            }
            
            // Llenar filtros de Edades
            var ageFilters = document.getElementById('ageFilters');
            if (ageFilters) {
                if (edadesArray.length > 0) {
                    ageFilters.innerHTML = edadesArray.map(function(edad) {
                        return '<label class="filter-checkbox">' +
                            '<input type="checkbox" value="' + edad + '" onchange="applyFilters()">' +
                            '<span class="checkmark"></span>' +
                            edad +
                        '</label>';
                    }).join('');
                } else {
                    ageFilters.innerHTML = '<p style="color: #666; font-style: italic;">No hay filtros de edad disponibles</p>';
                }
            }
            
            console.log('✅ Filtros poblados exitosamente');
        }
        
        // Asignar función initializeFilters al scope global
        window.initializeFilters = initializeFilters;
        
        // Inicializar cuando se carga la página
        document.addEventListener('DOMContentLoaded', function() {
            console.log('📦 Inicializando carrito...');
            window.updateCartBadge();
        });
        
        console.log('🚀 TODAS LAS FUNCIONES GLOBALES CARGADAS EXITOSAMENTE');
    </script>

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

        .content-section {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem 2rem;
        }

        .stats-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 2rem;
            margin-bottom: 4rem;
        }

        .stat-card {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 24px;
            padding: 2.5rem;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
            gap: 2rem;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #FFCE36, #000000, #3b82f6);
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-8px) scale(1.02);
            box-shadow: 
                0 32px 64px -12px rgba(0, 0, 0, 0.15), 
                0 20px 25px -5px rgba(0, 0, 0, 0.1),
                0 0 0 1px rgba(255, 206, 54, 0.1);
        }

        .stat-card:hover::before {
            opacity: 1;
        }

        .stat-icon {
            width: 72px;
            height: 72px;
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.75rem;
            position: relative;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .stat-icon::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: inherit;
            filter: brightness(1.1);
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .stat-card:hover .stat-icon::before {
            opacity: 1;
        }

        .stat-icon.products {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            color: #1A202C;
            box-shadow: 0 8px 32px rgba(102, 126, 234, 0.4);
        }

        .stat-icon.discount {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            color: #1A202C;
            box-shadow: 0 8px 32px rgba(17, 153, 142, 0.4);
        }

        .stat-icon.access {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: #1A202C;
            box-shadow: 0 8px 32px rgba(240, 147, 251, 0.4);
        }

        .stat-content h3 {
            font-size: 2.5rem;
            font-weight: 900;
            color: #1A202C;
            margin-bottom: 0.5rem;
            letter-spacing: -0.025em;
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .stat-content p {
            color: #64748b;
            font-weight: 600;
            font-size: 0.95rem;
            letter-spacing: 0.01em;
        }

        .catalog-section {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 32px;
            padding: 3rem;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            position: relative;
            overflow: hidden;
        }

        .catalog-section::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 33%, #11998e 66%, #f093fb 100%);
        }

        .catalog-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 3rem;
            padding-bottom: 1.5rem;
            border-bottom: 2px solid rgba(148, 163, 184, 0.1);
            position: relative;
        }

        .catalog-title {
            font-size: 2.25rem;
            font-weight: 900;
            color: #1A202C;
            display: flex;
            align-items: center;
            gap: 1rem;
            letter-spacing: -0.025em;
        }

        .catalog-title i {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .catalog-controls {
            display: flex;
            gap: 1rem;
            align-items: center;
        }

        .search-box {
            padding: 1rem 1.5rem;
            border: 2px solid rgba(148, 163, 184, 0.2);
            border-radius: 16px;
            font-size: 0.95rem;
            width: 320px;
            background: rgba(255, 255, 255, 0.8);
            backdrop-filter: blur(10px);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-weight: 500;
            color: #1A202C;
        }

        .search-box::placeholder {
            color: #94a3b8;
            font-weight: 500;
        }

        .search-box:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 
                0 0 0 4px rgba(102, 126, 234, 0.1),
                0 4px 12px rgba(102, 126, 234, 0.15);
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            transform: translateY(-1px);
        }

        .products-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
            gap: 2rem;
            margin-top: 3rem;
        }

        .product-card {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 24px;
            padding: 2rem;
            box-shadow: 
                0 10px 15px -3px rgba(0, 0, 0, 0.1), 
                0 4px 6px -2px rgba(0, 0, 0, 0.05),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }

        .product-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #11998e 0%, #38ef7d 100%);
            transform: translateX(-100%);
            transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .product-card:hover {
            transform: translateY(-12px) scale(1.02);
            box-shadow: 
                0 25px 50px -12px rgba(0, 0, 0, 0.15), 
                0 0 0 1px rgba(17, 153, 142, 0.1);
        }

        .product-card:hover::before {
            transform: translateX(0);
        }

        .product-image {
            position: relative;
            width: 100%;
            height: 200px;
            border-radius: 15px;
            overflow: hidden;
            margin-bottom: 1rem;
        }

        .product-image img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            transition: transform 0.3s ease;
        }

        .product-card:hover .product-image img {
            transform: scale(1.05);
        }

        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            position: absolute;
            top: 12px;
            left: 12px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: #1A202C;
            padding: 0.5rem 0.75rem;
            border-radius: 8px;
            font-size: 0.75rem;
            font-weight: 700;
        }

        .stock-badge {
            position: absolute;
            top: 12px;
            right: 12px;
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(10px);
            color: #059669;
            padding: 0.25rem 0.5rem;
            border-radius: 6px;
            font-size: 0.7rem;
            font-weight: 600;
        }

        .stock-badge.out-of-stock {
            background: rgba(239, 68, 68, 0.9);
            color: #1A202C;
        }

        .product-title {
            font-size: 1.1rem;
            font-weight: 700;
            color: #1A202C;
            margin-bottom: 1rem;
            line-height: 1.3;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .product-pricing {
            margin-bottom: 1rem;
        }

        .price-row {
            margin-bottom: 0.5rem;
        }

        .discounted-price-block {
            padding: 1rem;
            border-radius: 12px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: #1A202C;
            border: 1px solid #059669;
            text-align: center;
        }

        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: #1A202C;
            font-size: 1.5rem;
            font-weight: 800;
            display: block;
            margin-bottom: 0.5rem;
        }

        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.95);
            font-weight: 600;
            font-size: 0.85rem;
            line-height: 1.3;
        }

        .savings {
            color: #059669;
            font-size: 0.8rem;
            font-weight: 600;
        }

        .product-meta {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
            font-size: 0.8rem;
            color: #666;
        }

        .add-to-cart-btn {
            width: 100%;
            padding: 0.875rem 1rem;
            background: linear-gradient(135deg, #FFCE36, #FFC107);
            border: none;
            border-radius: 12px;
            color: #1A202C;
            font-weight: 700;
            font-size: 0.875rem;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }

        .add-to-cart-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(255, 206, 54, 0.4);
        }

        .add-to-cart-btn:disabled {
            background: #e5e7eb;
            color: #9ca3af;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }

        .no-products {
            text-align: center;
            padding: 4rem 2rem;
            color: #666;
        }

        .no-products i {
            font-size: 4rem;
            margin-bottom: 1rem;
            color: #d1d5db;
        }

        .no-products h3 {
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
            color: #374151;
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(40px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateX(-20px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }

        /* Añadir animación a las tarjetas individuales */
        .stat-card:nth-child(1) { animation-delay: 0.1s; }
        .stat-card:nth-child(2) { animation-delay: 0.2s; }
        .stat-card:nth-child(3) { animation-delay: 0.3s; }

        .stat-card {
            animation: fadeInUp 0.6s cubic-bezier(0.4, 0, 0.2, 1) both;
        }

        .catalog-section {
            animation: fadeInUp 0.8s cubic-bezier(0.4, 0, 0.2, 1) 0.4s both;
        }

        @media (max-width: 768px) {
            .stats-cards {
                grid-template-columns: 1fr;
                gap: 1.5rem;
            }

            .products-grid {
                grid-template-columns: 1fr;
                gap: 1.5rem;
            }

            .catalog-header {
                flex-direction: column;
                gap: 1.5rem;
                align-items: flex-start;
            }

            .search-box {
                width: 100%;
            }

            .stat-card {
                padding: 2rem;
                gap: 1.5rem;
            }

            .stat-icon {
                width: 64px;
                height: 64px;
            }

            .stat-content h3 {
                font-size: 2rem;
            }

            .catalog-section {
                padding: 2rem;
                border-radius: 24px;
            }

            .catalog-title {
                font-size: 1.875rem;
            }
        }
        /* ANIMACIONES DE ENTRADA SUTILES */
        .stat-card, .product-card, .cart-item {
            animation: fadeInUp 0.6s ease-out !important;
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* LOADING STATES ELEGANTES */
        .loading-spinner {
            border: 2px solid var(--gray-200) !important;
            border-top: 2px solid var(--imanix-yellow) !important;
        }
        
        /* PRECIO DESTACADO */
        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: white !important;
            font-weight: 800 !important;
            font-size: 1.25rem !important;
        }
        
        /* NAVBAR LOGO MEJORADO */
        .brand-logo {
            transition: all 0.3s ease !important;
        }
        .brand-logo:hover {
            transform: scale(1.05) !important;
            box-shadow: 0 4px 12px rgba(255, 206, 54, 0.3) !important;
        }
        
        /* CART SUMMARY ELEGANTE */
        .cart-summary {
            border-top: 3px solid var(--imanix-yellow) !important;
        }
        
        /* QUANTITY CONTROLS REFINADOS */
        .quantity-controls {
            background: var(--gray-50) !important;
            border: 1px solid var(--gray-200) !important;
        }
        
        /* NOTIFICACIONES PROFESIONALES */
        .notification {
            border-radius: 8px !important;
            backdrop-filter: blur(10px) !important;
        }
        
        /* ACCESIBILIDAD MEJORADA */
        .btn:focus, .form-input:focus, .form-select:focus {
            outline: 2px solid var(--imanix-yellow) !important;
            outline-offset: 2px !important;
        }
        /* CORRECCIONES DE CONTRASTE ESPECÍFICAS */
        .discounted-price, .item-total-price.discounted {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            display: inline-block !important;
        }
        
        .savings, .price-breakdown.highlight {
            color: #10B981 !important;
            font-weight: 600 !important;
        }
        
        .discount-badge, .cart-navbar-badge {
            color: white !important;
            font-weight: 700 !important;
        }
        
        /* Asegurar contraste en todos los elementos verdes */
        .success-text, .discount-text, .savings-amount {
            color: white !important;
            background: #10B981 !important;
            padding: 0.125rem 0.25rem !important;
            border-radius: 3px !important;
        }
        /* PRECIOS MEJORADOS CON CONTRASTE PERFECTO */
        .discounted-price-block {
            background: #10B981 !important;
            color: white !important;
            padding: 0.75rem 1rem !important;
            border-radius: 8px !important;
            margin-bottom: 0.5rem !important;
        }
        
        .discounted-price {
            color: white !important;
            font-size: 1.5rem !important;
            font-weight: 800 !important;
            display: block !important;
            margin-bottom: 0.25rem !important;
        }
        
        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.9) !important;
            font-size: 0.875rem !important;
        }
        
        .savings {
            color: #10B981 !important;
            font-weight: 600 !important;
            font-size: 0.875rem !important;
        }
        
        /* NOTIFICACIONES CON CONTRASTE PERFECTO */
        .notification {
            color: white !important;
        }
        
        .notification-message {
            color: white !important;
        }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }
        
        .cart-navbar-badge {
            background: #EF4444 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }

        /* SISTEMA DE FILTROS PROFESIONAL */
        .catalog-controls {
            display: flex;
            gap: 1rem;
            align-items: center;
            flex-wrap: wrap;
        }

        .filter-toggle-btn {
            background: linear-gradient(135deg, var(--imanix-yellow) 0%, var(--imanix-yellow-dark) 100%) !important;
            color: var(--gray-800) !important;
            border: 1px solid var(--imanix-yellow-dark) !important;
            padding: 0.75rem 1.5rem;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .filter-toggle-btn:hover {
            background: linear-gradient(135deg, var(--imanix-yellow-dark) 0%, #D4A500 100%) !important;
            transform: translateY(-1px);
            box-shadow: var(--shadow-md) !important;
        }

        .filters-panel {
            background: #FFFFFF !important;
            border: 1px solid var(--gray-200) !important;
            border-radius: 12px;
            margin-bottom: 2rem;
            box-shadow: var(--shadow-md) !important;
            overflow: hidden;
            max-height: 0;
            opacity: 0;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .filters-panel.show {
            max-height: 800px;
            opacity: 1;
            margin-bottom: 2rem;
        }

        .filters-header {
            background: linear-gradient(135deg, var(--imanix-yellow-light) 0%, var(--imanix-yellow) 100%) !important;
            padding: 1.5rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--gray-200);
        }

        .filters-header h3 {
            color: var(--gray-800) !important;
            font-weight: 700;
            margin: 0;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .clear-filters-btn {
            background: transparent;
            border: 1px solid var(--gray-300);
            color: var(--gray-600);
            padding: 0.5rem 1rem;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.875rem;
        }

        .clear-filters-btn:hover {
            background: #EF4444;
            color: white;
            border-color: #EF4444;
        }

        .filters-content {
            padding: 1.5rem;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 2rem;
        }

        .filter-group {
            border: 1px solid var(--gray-200);
            border-radius: 8px;
            padding: 1.25rem;
            background: var(--gray-50);
        }

        .filter-title {
            color: var(--gray-800) !important;
            font-weight: 600;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .filter-options {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            max-height: 200px;
            overflow-y: auto;
        }

        .filter-checkbox {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            cursor: pointer;
            padding: 0.5rem;
            border-radius: 6px;
            transition: all 0.2s ease;
            font-size: 0.875rem;
        }

        .filter-checkbox:hover {
            background: rgba(255, 206, 54, 0.1);
        }

        .filter-checkbox input[type="checkbox"] {
            display: none;
        }

        .checkmark {
            width: 18px;
            height: 18px;
            border: 2px solid var(--gray-300);
            border-radius: 4px;
            position: relative;
            transition: all 0.2s ease;
        }

        .filter-checkbox input[type="checkbox"]:checked + .checkmark {
            background: var(--imanix-yellow);
            border-color: var(--imanix-yellow-dark);
        }

        .filter-checkbox input[type="checkbox"]:checked + .checkmark::after {
            content: '✓';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: var(--gray-800);
            font-weight: 700;
            font-size: 12px;
        }

        .price-range-filter {
            margin-top: 0.5rem;
        }

        .price-inputs {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .price-inputs input {
            flex: 1;
            padding: 0.75rem;
            border: 1px solid var(--gray-200);
            border-radius: 6px;
            font-size: 0.875rem;
        }

        .price-inputs span {
            color: var(--gray-600);
            font-weight: 500;
        }

        .active-filters {
            background: #FFFFFF !important;
            border: 1px solid var(--gray-200) !important;
            border-radius: 8px;
            padding: 1rem;
            margin-bottom: 1.5rem;
            box-shadow: var(--shadow-sm) !important;
        }

        .active-filters-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.75rem;
            font-weight: 600;
            color: var(--gray-800);
        }

        .clear-all-btn {
            background: #EF4444;
            color: white;
            border: none;
            padding: 0.25rem 0.75rem;
            border-radius: 4px;
            font-size: 0.75rem;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .clear-all-btn:hover {
            background: #DC2626;
        }

        .active-filters-list {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
        }

        .active-filter-tag {
            background: var(--imanix-yellow);
            color: var(--gray-800);
            padding: 0.375rem 0.75rem;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            transition: all 0.2s ease;
        }

        .active-filter-tag .remove-filter {
            background: rgba(0, 0, 0, 0.2);
            color: var(--gray-800);
            border: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            transition: all 0.2s ease;
        }

        .active-filter-tag .remove-filter:hover {
            background: rgba(0, 0, 0, 0.4);
        }

        /* RESPONSIVE PARA FILTROS */
        @media (max-width: 768px) {
            .catalog-controls {
                flex-direction: column;
                align-items: stretch;
            }

            .filter-toggle-btn {
                justify-content: center;
            }

            .filters-content {
                grid-template-columns: 1fr;
                gap: 1.5rem;
            }

            .filters-header {
                flex-direction: column;
                gap: 1rem;
                align-items: stretch;
            }

            .active-filters-header {
                flex-direction: column;
                gap: 0.5rem;
                align-items: stretch;
            }
        }

    </style>
</head>
<body>
    <div class="navbar">
        <div class="navbar-content">
            <a href="/" class="navbar-brand" style="text-decoration: none;">
                <img src="/images/Logo%202160x1200%20(1).png" alt="IMANIX Portal B2B" style="height: 70px; width: auto;" />                </svg>            </a>
            <div class="navbar-actions">
                <div class="user-account" onclick="toggleUserDropdown()">
                    <i class="fas fa-user-circle"></i>
                    <span>${customer?.firstName || 'Usuario'} ${customer?.lastName || ''}</span>
                    <i class="fas fa-chevron-down" style="font-size: 0.75rem; margin-left: 0.25rem;"></i>
                    
                    <div class="user-dropdown" id="userDropdown">
                        <div class="dropdown-header">
                            <div class="user-name">${customer?.firstName || 'Usuario'} ${customer?.lastName || ''}</div>
                            <div class="user-email">${customer?.email || 'no-email@example.com'}</div>
                        </div>
                        
                        <div class="dropdown-menu">
                            <a href="/perfil" class="dropdown-item">
                                <i class="fas fa-user-edit"></i>
                                Mi Perfil
                            </a>
                            <a href="/carrito" class="dropdown-item">
                                <i class="fas fa-shopping-cart"></i>
                                Mi Carrito
                            </a>
                            <a href="/perfil" class="dropdown-item">
                                <i class="fas fa-history"></i>
                                Historial de Pedidos
                            </a>
                            <div class="dropdown-divider"></div>
                            <button onclick="logout()" class="dropdown-item">
                                <i class="fas fa-sign-out-alt"></i>
                                Cerrar Sesión
                            </button>
                        </div>
                    </div>
                </div>
                <button class="cart-navbar-btn" onclick="showCart()">
                    <i class="fas fa-shopping-cart"></i>
                    <span class="cart-navbar-badge" id="cartNavbarBadge">0</span>
                </button>
            </div>
        </div>
    </div>

    <div class="content-section">
        <div class="stats-cards">
            <div class="stat-card">
                <div class="stat-icon products">
                    <i class="fas fa-boxes"></i>
                </div>
                <div class="stat-content">
                    <h3>${products.length}</h3>
                    <p>Productos Disponibles</p>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon discount">
                    <i class="fas fa-tags"></i>
                </div>
                <div class="stat-content">
                    <h3>${customerDiscount}%</h3>
                    <p>Tu Descuento B2B</p>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon access">
                    <i class="fas fa-key"></i>
                </div>
                <div class="stat-content">
                    <h3>Autorizado</h3>
                    <p>Acceso Profesional</p>
                </div>
            </div>
        </div>

        <div class="catalog-section">
            <div class="catalog-header">
                <h2 class="catalog-title">
                    <i class="fas fa-store"></i>
                    Catálogo B2B
                </h2>
                <div class="catalog-controls">
                    <input type="text" class="search-box" placeholder="Buscar productos..." 
                           id="searchInput" onkeyup="filterProducts()">
                    <button class="filter-toggle-btn" onclick="toggleFilters()">
                        <i class="fas fa-filter"></i>
                        Filtros
                    </button>
                </div>
            </div>

            <!-- Panel de Filtros -->
            <div class="filters-panel" id="filtersPanel">
                <div class="filters-header">
                    <h3><i class="fas fa-sliders-h"></i> Filtrar Productos</h3>
                    <button class="clear-filters-btn" onclick="clearAllFilters()">
                        <i class="fas fa-times"></i>
                        Limpiar Todo
                    </button>
                </div>
                
                <div class="filters-content">
                    <!-- Filtros por Colecciones -->
                    <div class="filter-group">
                        <h4 class="filter-title">
                            <i class="fas fa-layer-group"></i>
                            Colecciones
                        </h4>
                        <div class="filter-options" id="collectionFilters">
                            <!-- Se llenará dinámicamente -->
                        </div>
                    </div>

                    <!-- Filtros por Categorías -->
                    <div class="filter-group">
                        <h4 class="filter-title">
                            <i class="fas fa-tags"></i>
                            Categorías
                        </h4>
                        <div class="filter-options" id="categoryFilters">
                            <!-- Se llenará dinámicamente -->
                        </div>
                    </div>

                    <!-- Filtros por Edad -->
                    <div class="filter-group">
                        <h4 class="filter-title">
                            <i class="fas fa-child"></i>
                            Edad Recomendada
                        </h4>
                        <div class="filter-options" id="ageFilters">
                            <!-- Se llenará dinámicamente -->
                        </div>
                    </div>

                    <!-- Filtros por Disponibilidad -->
                    <div class="filter-group">
                        <h4 class="filter-title">
                            <i class="fas fa-boxes"></i>
                            Disponibilidad
                        </h4>
                        <div class="filter-options">
                            <label class="filter-checkbox">
                                <input type="checkbox" value="in-stock" onchange="applyFilters()">
                                <span class="checkmark"></span>
                                En Stock
                            </label>
                            <label class="filter-checkbox">
                                <input type="checkbox" value="out-of-stock" onchange="applyFilters()">
                                <span class="checkmark"></span>
                                Sin Stock
                            </label>
                        </div>
                    </div>

                    <!-- Filtros por Precio -->
                    <div class="filter-group">
                        <h4 class="filter-title">
                            <i class="fas fa-dollar-sign"></i>
                            Rango de Precio
                        </h4>
                        <div class="price-range-filter">
                            <div class="price-inputs">
                                <input type="number" id="minPrice" placeholder="Mín" onchange="applyFilters()">
                                <span>-</span>
                                <input type="number" id="maxPrice" placeholder="Máx" onchange="applyFilters()">
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Filtros Activos -->
            <div class="active-filters" id="activeFilters" style="display: none;">
                <div class="active-filters-header">
                    <span>Filtros activos:</span>
                    <button class="clear-all-btn" onclick="clearAllFilters()">Limpiar todo</button>
                </div>
                <div class="active-filters-list" id="activeFiltersList">
                    <!-- Se llenará dinámicamente -->
                </div>
            </div>

            <div class="products-grid" id="productsGrid">
                ${renderProducts(products, customerDiscount)}
            </div>
        </div>
    </div>

    <script>
        // Variables globales
        var cart = JSON.parse(localStorage.getItem('b2bCart')) || [];

        // Limpiar y migrar productos del carrito (productos añadidos antes de la actualización)
        var cartChanged = false;

        cart = cart.map(function(item) {
            // Si el item no tiene variantId pero tiene productId, intentamos solucionarlo
            if (!item.variantId && item.productId) {
                console.log('🔧 Migrando producto sin variantId:', item.title);
                item.variantId = item.productId; // Usar productId como fallback
                cartChanged = true;
            }
            return item;
        }).filter(function(item) {
            // Eliminar items que no tienen ni variantId ni productId
            if (!item.variantId && !item.productId) {
                console.log('🗑️ Eliminando producto inválido:', item);
                cartChanged = true;
                return false;
            }
            return true;
        });

        if (cartChanged) {
            localStorage.setItem('b2bCart', JSON.stringify(cart));
            console.log('🧹 Carrito limpiado y migrado');
        }
        
        // addToCart ya está definida globalmente arriba - eliminando duplicado
        
        // FUNCIONES DUPLICADAS ELIMINADAS - SOLO USAR LAS DEL HEAD
        
        // FUNCIÓN APPLYFILTERS DUPLICADA - SE ELIMINA PARA USAR LA DEL FINAL DEL BODY
        window.applyFiltersBody = function() {
            // Recopilar filtros activos
            activeFilters.collections = Array.from(document.querySelectorAll('#collectionFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.categories = Array.from(document.querySelectorAll('#categoryFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.ages = Array.from(document.querySelectorAll('#ageFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.availability = Array.from(document.querySelectorAll('.filter-options input:checked')).map(function(cb) { return cb.value; });
            
            var minPriceEl = document.getElementById('minPrice');
            var maxPriceEl = document.getElementById('maxPrice');
            var minPrice = minPriceEl ? minPriceEl.value : '';
            var maxPrice = maxPriceEl ? maxPriceEl.value : '';
            activeFilters.priceRange.min = minPrice ? parseInt(minPrice) : null;
            activeFilters.priceRange.max = maxPrice ? parseInt(maxPrice) : null;
            
            // Aplicar filtros a productos
            var productCards = document.querySelectorAll('.product-card');
            var visibleCount = 0;
            
            productCards.forEach(function(card) {
                var shouldShow = true;
                
                // Filtro por texto de búsqueda
                var searchInputEl = document.getElementById('searchInput');
                var searchTerm = searchInputEl ? searchInputEl.value.toLowerCase() : '';
                if (searchTerm) {
                    var titleEl = card.querySelector('.product-title');
                    var title = titleEl ? titleEl.textContent.toLowerCase() : '';
                    var skuElement = card.querySelector('.sku');
                    var sku = skuElement ? skuElement.textContent.toLowerCase() : '';
                    if (!title.includes(searchTerm) && !sku.includes(searchTerm)) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por disponibilidad
                if (activeFilters.availability.length > 0) {
                    var stockBadge = card.querySelector('.stock-badge');
                    var inStock = stockBadge ? !stockBadge.classList.contains('out-of-stock') : true;
                    
                    if (activeFilters.availability.includes('in-stock') && !inStock) {
                        shouldShow = false;
                    }
                    if (activeFilters.availability.includes('out-of-stock') && inStock) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por precio
                if (activeFilters.priceRange.min || activeFilters.priceRange.max) {
                    var priceElement = card.querySelector('.discounted-price');
                    if (priceElement) {
                        var priceText = priceElement.textContent;
                        var price = parseInt(priceText.replace(/[^0-9]/g, ''));
                        
                        if (activeFilters.priceRange.min && price < activeFilters.priceRange.min) {
                            shouldShow = false;
                        }
                        if (activeFilters.priceRange.max && price > activeFilters.priceRange.max) {
                            shouldShow = false;
                        }
                    }
                }
                
                // Mostrar/ocultar producto
                card.style.display = shouldShow ? 'block' : 'none';
                if (shouldShow) visibleCount++;
            });
            
            // Actualizar filtros activos
            updateActiveFilters();
            
            // Mostrar mensaje si no hay productos
            var productsGrid = document.getElementById('productsGrid');
            var noProductsMsg = productsGrid ? productsGrid.querySelector('.no-products-filtered') : null;
            
            if (visibleCount === 0) {
                if (!noProductsMsg) {
                    noProductsMsg = document.createElement('div');
                    noProductsMsg.className = 'no-products-filtered';
                    noProductsMsg.innerHTML = 
                        '<div style="text-align: center; padding: 3rem; color: #666;">' +
                            '<i class="fas fa-search" style="font-size: 3rem; margin-bottom: 1rem; color: #d1d5db;"></i>' +
                            '<h3>No se encontraron productos</h3>' +
                            '<p>Intenta ajustar los filtros para ver más resultados</p>' +
                        '</div>';
                    productsGrid.appendChild(noProductsMsg);
                }
                noProductsMsg.style.display = 'block';
            } else {
                if (noProductsMsg) {
                    noProductsMsg.style.display = 'none';
                }
            }
        };
        
        // FUNCIONES DE CARRITO DUPLICADAS ELIMINADAS - USAR LAS DEL HEAD

        // Filtrar productos - integrado con el sistema principal de filtros
        function filterProducts() {
            // Simplemente llamar a applyFilters ya que maneja tanto búsqueda como filtros
            if (typeof applyFilters === 'function') {
                applyFilters();
            }
        }

        // MÁS FUNCIONES DUPLICADAS ELIMINADAS - USAR SOLO LAS DEL HEAD

        // Función auxiliar para formatear precios
        function formatPrice(price) {
            return new Intl.NumberFormat('es-CL', {
                style: 'currency',
                currency: 'CLP'
            }).format(price);
        }

        // Variables globales para filtros
        var allProducts = []; // Almacenar todos los productos para filtrado
        var activeFilters = {
            collections: [],
            categories: [],
            ages: [],
            availability: [],
            priceRange: { min: null, max: null }
        };

        // Función para extraer etiquetas de productos y organizarlas
        function extractProductTags(products) {
            var collections = new Set();
            var categories = new Set();
            var ages = new Set();
            
            products.forEach(function(product) {
                if (product.tags) {
                    var tags = product.tags.split(',').map(function(tag) { return tag.trim().toLowerCase(); });
                    
                    tags.forEach(function(tag) {
                        // Filtrar colecciones (etiquetas que parecen nombres de colecciones)
                        if (tag.includes('home') || tag.includes('tobogán') || tag.includes('imanix') || 
                            tag.includes('envío') || tag.includes('playday') || tag.includes('magnético') ||
                            tag.includes('armables') || tag.includes('juegos') || tag.includes('cyberday') ||
                            tag.includes('regalos') || tag.includes('best') || tag.includes('newest')) {
                            collections.add(tag);
                        }
                        
                        // Filtrar edades (etiquetas que contienen años)
                        if (tag.includes('años') || tag.includes('año') || tag.includes('adelante') ||
                            tag.includes('3-5') || tag.includes('5-9') || tag.includes('9-en')) {
                            ages.add(tag);
                        }
                        
                        // Otras categorías
                        if (tag.includes('stock') || tag.includes('recomendados') || tag.includes('over-') ||
                            tag.includes('no-dropship') || tag.includes('clasicos') || tag.includes('experto') ||
                            tag.includes('especiales') || tag.includes('complementos') || tag.includes('b2b') ||
                            tag.includes('agrandatucoleccion') || tag.includes('piezas')) {
                            categories.add(tag);
                        }
                    });
                }
            });
            
            return {
                collections: Array.from(collections).sort(),
                categories: Array.from(categories).sort(),
                ages: Array.from(ages).sort()
            };
        }

        // Función para mostrar/ocultar panel de filtros (ELIMINADA - usando window.toggleFilters global)

        // Función para inicializar los filtros con las etiquetas REALES de los productos
        function initializeFiltersLegacy() {
            console.log('🔍 Inicializando filtros con etiquetas reales de Shopify (legacy)...');
            
            var products = Array.from(document.querySelectorAll('.product-card'));
            var allTags = new Set();
            var collections = new Set();
            var categories = new Set();
            var ages = new Set();
            
            // Extraer todas las etiquetas reales de los productos
            products.forEach(function(card) {
                var tagsAttr = card.getAttribute('data-tags');
                if (tagsAttr) {
                    var tags = tagsAttr.split(',').map(function(tag) { return tag.trim(); });
                    tags.forEach(function(tag) {
                        if (tag) {
                            allTags.add(tag);
                            
                            // Clasificar etiquetas automáticamente
                            var tagLower = tag.toLowerCase();
                            
                            // Colecciones (nombres de colecciones, marcas, etc.)
                            if (tagLower.includes('home') || tagLower.includes('tobogán') || tagLower.includes('imanix') || 
                                tagLower.includes('envío') || tagLower.includes('playday') || tagLower.includes('magnético') ||
                                tagLower.includes('armables') || tagLower.includes('juegos') || tagLower.includes('cyberday') ||
                                tagLower.includes('regalos') || tagLower.includes('best') || tagLower.includes('newest') ||
                                tagLower.includes('productos') || tagLower.includes('destacados') || tagLower.includes('orderly') ||
                                tagLower.includes('historia') || tagLower.includes('mundo') || tagLower.includes('express') ||
                                tagLower.includes('plástico') || tagLower.includes('imán')) {
                                collections.add(tag);
                            }
                            // Edades (etiquetas que contienen años o referencias de edad)
                            else if (tagLower.includes('años') || tagLower.includes('año') || tagLower.includes('adelante') ||
                                tagLower.includes('3-5') || tagLower.includes('5-9') || tagLower.includes('9-en') ||
                                tagLower.includes('experto') || tagLower.includes('expert')) {
                                ages.add(tag);
                            }
                            // Categorías (todo lo demás: stock, precios, tipos, etc.)
                            else {
                                categories.add(tag);
                            }
                        }
                    });
                }
            });
            
            console.log('📊 Etiquetas extraídas:', {
                total: allTags.size,
                collections: collections.size,
                categories: categories.size,
                ages: ages.size
            });
            
            // Convertir a arrays y ordenar
            var collectionsArray = Array.from(collections).sort();
            var categoriesArray = Array.from(categories).sort();
            var agesArray = Array.from(ages).sort();
            
            // Llenar filtros de colecciones
            var collectionFilters = document.getElementById('collectionFilters');
            if (collectionFilters) {
                collectionFilters.innerHTML = collectionsArray.map(function(collection) {
                    return '<label class="filter-checkbox">' +
                        '<input type="checkbox" value="' + collection + '" onchange="applyFilters()">' +
                        '<span class="checkmark"></span>' +
                        collection +
                    '</label>';
                }).join('');
            }
            
            // Llenar filtros de categorías
            var categoryFilters = document.getElementById('categoryFilters');
            if (categoryFilters) {
                categoryFilters.innerHTML = categoriesArray.map(function(category) {
                    return '<label class="filter-checkbox">' +
                        '<input type="checkbox" value="' + category + '" onchange="applyFilters()">' +
                        '<span class="checkmark"></span>' +
                        category +
                    '</label>';
                }).join('');
            }
            
            // Llenar filtros de edad
            var ageFilters = document.getElementById('ageFilters');
            if (ageFilters) {
                ageFilters.innerHTML = agesArray.map(function(age) {
                    return '<label class="filter-checkbox">' +
                        '<input type="checkbox" value="' + age + '" onchange="applyFilters()">' +
                        '<span class="checkmark"></span>' +
                        age +
                    '</label>';
                }).join('');
            }
            
            console.log('✅ Filtros poblados exitosamente');
        }

        // Variable global para filtros activos
        var activeFilters = {
            collections: [],
            categories: [],
            ages: [],
            availability: [],
            priceRange: { min: null, max: null }
        };

        // Función mejorada para aplicar filtros basados en metafields de Shopify
        function applyFilters() {
            console.log('🔍 Aplicando filtros mejorados...');
            
            // Mapeo de IDs de Shopify a valores legibles para edades
            var ageMapping = {
                'gid://shopify/Metaobject/122522435859': '3-5 años',
                'gid://shopify/Metaobject/98466890003': '5-9 años',
                'gid://shopify/Metaobject/35341876855059': '9+ años',
                'gid://shopify/Metaobject/39573422145811': 'Experto'
            };
            
            // Recopilar filtros activos
            activeFilters.collections = Array.from(document.querySelectorAll('#collectionFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.categories = Array.from(document.querySelectorAll('#categoryFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.ages = Array.from(document.querySelectorAll('#ageFilters input:checked')).map(function(cb) { return cb.value; });
            activeFilters.availability = Array.from(document.querySelectorAll('.filter-options input:checked')).map(function(cb) { return cb.value; });
            
            var minPriceEl = document.getElementById('minPrice');
            var maxPriceEl = document.getElementById('maxPrice');
            var minPrice = minPriceEl ? minPriceEl.value : '';
            var maxPrice = maxPriceEl ? maxPriceEl.value : '';
            activeFilters.priceRange.min = minPrice ? parseInt(minPrice) : null;
            activeFilters.priceRange.max = maxPrice ? parseInt(maxPrice) : null;
            
            console.log('🎯 Filtros activos:', activeFilters);
            
            // Aplicar filtros a productos
            var productCards = document.querySelectorAll('.product-card');
            var visibleCount = 0;
            
            productCards.forEach(function(card) {
                var shouldShow = true;
                
                // Obtener datos del producto
                var price = parseFloat(card.dataset.price || 0);
                var stock = parseInt(card.dataset.stock || 0);
                var metafieldsStr = card.dataset.metafields || '{}';
                var metafields = {};
                
                try {
                    // Limpieza más robusta del JSON
                    var cleanedJson = metafieldsStr
                        .replace(/&#39;/g, "'")
                        .replace(/\\r?\\n|\\r/g, " ")
                        .replace(/\\t/g, " ")
                        .replace(/\\s+/g, " ")
                        .replace(/,\\s*}/g, "}")
                        .replace(/,\\s*]/g, "]")
                        .trim();
                    metafields = JSON.parse(cleanedJson);
                } catch (e) {
                    console.warn('Error parsing metafields:', e);
                    metafields = {}; // Fallback seguro
                }
                
                // Convertir metacampos para comparación
                var convertedMetafields = {};
                Object.keys(metafields).forEach(function(key) {
                    var value = metafields[key];
                    if (value && typeof value === 'string') {
                        // Convertir IDs de Shopify a valores legibles
                        if (value.startsWith('gid://shopify/')) {
                            var convertedValue = ageMapping[value];
                            if (convertedValue) {
                                convertedMetafields[key] = convertedValue;
                            } else {
                                convertedMetafields[key] = value; // Mantener original si no hay conversión
                            }
                        } else {
                            convertedMetafields[key] = value;
                        }
                    }
                });
                
                // Obtener todos los valores convertidos para filtrado
                var metaValues = Object.values(convertedMetafields);
                
                // Filtro por texto de búsqueda
                var searchInputEl = document.getElementById('searchInput');
                var searchTerm = searchInputEl ? searchInputEl.value.toLowerCase() : '';
                if (searchTerm) {
                    var titleEl = card.querySelector('.product-title');
                    var title = titleEl ? titleEl.textContent.toLowerCase() : '';
                    var skuElement = card.querySelector('.sku');
                    var sku = skuElement ? skuElement.textContent.toLowerCase() : '';
                    if (!title.includes(searchTerm) && !sku.includes(searchTerm)) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por Colecciones (Sub-categorías)
                if (activeFilters.collections.length > 0 && shouldShow) {
                    var hasCollection = activeFilters.collections.some(function(collection) {
                        return metaValues.includes(collection);
                    });
                    if (!hasCollection) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por Categorías (Marcas)
                if (activeFilters.categories.length > 0 && shouldShow) {
                    var hasCategory = activeFilters.categories.some(function(category) {
                        return metaValues.includes(category);
                    });
                    if (!hasCategory) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por Edades (con conversión de IDs)
                if (activeFilters.ages.length > 0 && shouldShow) {
                    var hasAge = activeFilters.ages.some(function(age) {
                        return metaValues.includes(age);
                    });
                    if (!hasAge) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por Disponibilidad
                if (activeFilters.availability.length > 0 && shouldShow) {
                    var isInStock = stock > 0;
                    if (activeFilters.availability.includes('in-stock') && !isInStock) {
                        shouldShow = false;
                    }
                    if (activeFilters.availability.includes('out-of-stock') && isInStock) {
                        shouldShow = false;
                    }
                }
                
                // Filtro por Precio
                if ((activeFilters.priceRange.min || activeFilters.priceRange.max) && shouldShow) {
                    if (activeFilters.priceRange.min && price < activeFilters.priceRange.min) {
                        shouldShow = false;
                    }
                    if (activeFilters.priceRange.max && price > activeFilters.priceRange.max) {
                        shouldShow = false;
                    }
                }
                
                // Mostrar/ocultar producto
                card.style.display = shouldShow ? 'block' : 'none';
                if (shouldShow) visibleCount++;
            });
            
            console.log('📊 Productos filtrados:', visibleCount + '/' + productCards.length);
            
            // Mostrar mensaje si no hay productos
            var productsGrid = document.getElementById('productsGrid');
            var noProductsMsg = productsGrid ? productsGrid.querySelector('.no-products-filtered') : null;
            
            if (visibleCount === 0) {
                if (!noProductsMsg) {
                    noProductsMsg = document.createElement('div');
                    noProductsMsg.className = 'no-products-filtered';
                    noProductsMsg.innerHTML = 
                        '<div style="text-align: center; padding: 3rem; color: #666;">' +
                            '<i class="fas fa-search" style="font-size: 3rem; margin-bottom: 1rem; color: #d1d5db;"></i>' +
                            '<h3>No se encontraron productos</h3>' +
                            '<p>Intenta ajustar los filtros para ver más resultados</p>' +
                        '</div>';
                    productsGrid.appendChild(noProductsMsg);
                }
                noProductsMsg.style.display = 'block';
            } else {
                if (noProductsMsg) {
                    noProductsMsg.style.display = 'none';
                }
            }
            
            // Actualizar indicadores visuales de filtros activos
            updateFilterGroupIndicators(activeFilters);
        }
        
        // CRÍTICO: Asignar función applyFilters al scope global INMEDIATAMENTE después de definirla
        window.applyFilters = applyFilters;
        
        // Función para actualizar indicadores visuales de filtros activos
        function updateFilterGroupIndicators(activeFilters) {
            // Actualizar grupo de colecciones
            var collectionGroup = document.querySelector('#collectionFilters').closest('.filter-group');
            if (collectionGroup) {
                if (activeFilters.collections.length > 0) {
                    collectionGroup.classList.add('has-active-filters');
                    collectionGroup.querySelector('.filter-title').classList.add('has-active');
                } else {
                    collectionGroup.classList.remove('has-active-filters');
                    collectionGroup.querySelector('.filter-title').classList.remove('has-active');
                }
            }
            
            // Actualizar grupo de categorías
            var categoryGroup = document.querySelector('#categoryFilters').closest('.filter-group');
            if (categoryGroup) {
                if (activeFilters.categories.length > 0) {
                    categoryGroup.classList.add('has-active-filters');
                    categoryGroup.querySelector('.filter-title').classList.add('has-active');
                } else {
                    categoryGroup.classList.remove('has-active-filters');
                    categoryGroup.querySelector('.filter-title').classList.remove('has-active');
                }
            }
            
            // Actualizar grupo de edades
            var ageGroup = document.querySelector('#ageFilters').closest('.filter-group');
            if (ageGroup) {
                if (activeFilters.ages.length > 0) {
                    ageGroup.classList.add('has-active-filters');
                    ageGroup.querySelector('.filter-title').classList.add('has-active');
                } else {
                    ageGroup.classList.remove('has-active-filters');
                    ageGroup.querySelector('.filter-title').classList.remove('has-active');
                }
            }
        }

        // Función para actualizar filtros activos
        function updateActiveFilters() {
            var activeFiltersDiv = document.getElementById('activeFilters');
            var activeFiltersList = document.getElementById('activeFiltersList');
            
            if (!activeFiltersDiv || !activeFiltersList) return;
            
            var allActiveFilters = []
                .concat(activeFilters.collections.map(function(f) { return { type: 'collection', value: f, label: f }; }))
                .concat(activeFilters.categories.map(function(f) { return { type: 'category', value: f, label: f }; }))
                .concat(activeFilters.ages.map(function(f) { return { type: 'age', value: f, label: f }; }))
                .concat(activeFilters.availability.map(function(f) { return { type: 'availability', value: f, label: f === 'in-stock' ? 'En Stock' : 'Sin Stock' }; }));
            
            if (activeFilters.priceRange.min || activeFilters.priceRange.max) {
                var minText = activeFilters.priceRange.min ? formatPrice(activeFilters.priceRange.min) : 'Min';
                var maxText = activeFilters.priceRange.max ? formatPrice(activeFilters.priceRange.max) : 'Max';
                allActiveFilters.push({ type: 'price', value: 'price', label: minText + ' - ' + maxText });
            }
            
            if (allActiveFilters.length > 0) {
                activeFiltersDiv.style.display = 'block';
                activeFiltersList.innerHTML = allActiveFilters.map(function(filter) {
                    return '<div class="active-filter-tag">' +
                        filter.label +
                        '<button class="remove-filter" onclick="removeFilter(&quot;' + filter.type + '&quot;, &quot;' + filter.value + '&quot;)">×</button>' +
                    '</div>';
                }).join('');
            } else {
                activeFiltersDiv.style.display = 'none';
            }
        }

        // Función para remover un filtro específico
        function removeFilter(type, value) {
            switch (type) {
                case 'collection':
                    activeFilters.collections = activeFilters.collections.filter(function(f) { return f !== value; });
                    document.querySelector('#collectionFilters input[value="' + value + '"]').checked = false;
                    break;
                case 'category':
                    activeFilters.categories = activeFilters.categories.filter(function(f) { return f !== value; });
                    document.querySelector('#categoryFilters input[value="' + value + '"]').checked = false;
                    break;
                case 'age':
                    activeFilters.ages = activeFilters.ages.filter(function(f) { return f !== value; });
                    document.querySelector('#ageFilters input[value="' + value + '"]').checked = false;
                    break;
                case 'availability':
                    activeFilters.availability = activeFilters.availability.filter(function(f) { return f !== value; });
                    document.querySelector('.filter-options input[value="' + value + '"]').checked = false;
                    break;
                case 'price':
                    activeFilters.priceRange.min = null;
                    activeFilters.priceRange.max = null;
                    document.getElementById('minPrice').value = '';
                    document.getElementById('maxPrice').value = '';
                    break;
            }
            applyFilters();
        }

        // Función para limpiar todos los filtros
        function clearAllFilters() {
            // Limpiar checkboxes
            document.querySelectorAll('.filter-checkbox input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
            
            // Limpiar campos de precio
            var minPriceEl = document.getElementById('minPrice');
            var maxPriceEl = document.getElementById('maxPrice');
            var searchInputEl = document.getElementById('searchInput');
            
            if (minPriceEl) minPriceEl.value = '';
            if (maxPriceEl) maxPriceEl.value = '';
            if (searchInputEl) searchInputEl.value = '';
            
            // Resetear filtros activos
            activeFilters.collections = [];
            activeFilters.categories = [];
            activeFilters.ages = [];
            activeFilters.availability = [];
            activeFilters.priceRange = { min: null, max: null };
            
            // Mostrar todos los productos
            document.querySelectorAll('.product-card').forEach(function(card) {
                card.style.display = 'block';
            });
            
            // Ocultar filtros activos
            var activeFiltersEl = document.getElementById('activeFilters');
            if (activeFiltersEl) activeFiltersEl.style.display = 'none';
            
            // Ocultar mensaje de no productos
            var noProductsMsg = document.querySelector('.no-products-filtered');
            if (noProductsMsg) {
                noProductsMsg.style.display = 'none';
            }
        }

        // Función para integrar búsqueda con filtros (si están disponibles)
        function integratedFilter() {
            if (typeof applyFilters === 'function') {
                applyFilters();
            } else {
                filterProducts();
            }
        }

        // DEFINIR TODAS LAS FUNCIONES GLOBALMENTE PRIMERO
        window.toggleUserDropdown = function() {
            var dropdown = document.getElementById('userDropdown');
            if (dropdown) {
                dropdown.classList.toggle('show');
            }
        };
        
        // toggleFilters eliminada - usando la definición anterior window.toggleFilters
        
        // showCart y addToCart ya están definidas globalmente arriba - eliminando duplicados
        
        // Función para remover filtros activos
        window.removeFilter = function(type, value) {
            console.log('🗑️ Removiendo filtro:', type, value);
            try {
                // Encontrar y desmarcar el checkbox correspondiente
                var checkboxes = document.querySelectorAll('input[type="checkbox"][value="' + value + '"]');
                checkboxes.forEach(function(checkbox) {
                    checkbox.checked = false;
                });
                
                // Limpiar rango de precios si es necesario
                if (type === 'priceRange') {
                    var minPriceEl = document.getElementById('minPrice');
                    var maxPriceEl = document.getElementById('maxPrice');
                    if (minPriceEl) minPriceEl.value = '';
                    if (maxPriceEl) maxPriceEl.value = '';
                }
                
                // Reaplicar filtros
                if (typeof window.applyFilters === 'function') {
                    window.applyFilters();
                }
            } catch (error) {
                console.error('Error removing filter:', error);
            }
        };
        
        window.logout = function() {
            if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
                fetch('/api/auth/logout', { method: 'POST' })
                    .then(function(response) { return response.json(); })
                    .then(function(data) {
                        if (data.success) {
                            localStorage.removeItem('b2bCart');
                            window.location.reload();
                        }
                    })
                    .catch(function(error) {
                        console.error('Error:', error);
                        window.location.reload();
                    });
            }
        };
        
        window.clearAllFilters = function() {
            try {
                // Limpiar checkboxes
                var checkboxes = document.querySelectorAll('.filter-checkbox input[type="checkbox"]');
                checkboxes.forEach(function(cb) { cb.checked = false; });
                
                // Limpiar campos
                var minPrice = document.getElementById('minPrice');
                var maxPrice = document.getElementById('maxPrice');
                var searchInput = document.getElementById('searchInput');
                
                if (minPrice) minPrice.value = '';
                if (maxPrice) maxPrice.value = '';
                if (searchInput) searchInput.value = '';
                
                // Mostrar todos los productos
                var productCards = document.querySelectorAll('.product-card');
                productCards.forEach(function(card) {
                    card.style.display = 'block';
                });
                
                // Ocultar filtros activos
                var activeFilters = document.getElementById('activeFilters');
                if (activeFilters) activeFilters.style.display = 'none';
            } catch (error) {
                console.error('Error clearing filters:', error);
            }
        };
        
        // La función applyFilters ya está asignada globalmente arriba
        
        window.removeFilter = function(type, value) {
            try {
                // Lógica básica para remover filtros
                var input = document.querySelector('input[value="' + value + '"]');
                if (input) {
                    input.checked = false;
                }
                if (typeof window.applyFilters === 'function') {
                    window.applyFilters();
                }
            } catch (error) {
                console.error('Error removing filter:', error);
            }
        };

        // Inicializar al cargar la página
        document.addEventListener('DOMContentLoaded', function() {
            updateCartBadge();
        });
    </script>
    
    <!-- 🚀 FUNCIONES GLOBALES CRÍTICAS - CARGADAS AL FINAL PARA EVITAR ERRORES -->
    <script>
        // FUNCIONES GLOBALES DEFINIDAS DESPUÉS DE QUE EL DOM ESTÉ LISTO
        function toggleUserDropdown() {
            console.log('✅ toggleUserDropdown ejecutada');
            var dropdown = document.getElementById('userDropdown');
            if (dropdown) {
                dropdown.classList.toggle('show');
            }
        }
        
        // toggleFilters eliminada - usando definición global window.toggleFilters
        
        // Función de respaldo para inicializar filtros manualmente
        function initializeFiltersManual() {
            console.log('🔍 Inicializando filtros manualmente...');
            
            var products = Array.from(document.querySelectorAll('.product-card'));
            var subCategorias = new Set();
            var marcas = new Set();
            var edades = new Set();
            
            console.log('📦 Productos encontrados:', products.length);
            
            // Extraer todos los metacampos de los productos
            products.forEach(function(card) {
                var metafieldsAttr = card.getAttribute('data-metafields');
                console.log('🏷️ Metacampos del producto:', metafieldsAttr);
                
                if (metafieldsAttr) {
                    try {
                        // Limpiar JSON malformado de forma más robusta
                        var cleanedData = metafieldsAttr
                            .replace(/&#39;/g, "'")
                            .replace(/\\r?\\n|\\r/g, " ")
                            .replace(/\\t/g, " ")
                            .replace(/\\s+/g, " ")
                            .trim();
                            
                        // Intentar parsear JSON limpio
                        var metafields = JSON.parse(cleanedData);
                        
                        // Organizar metacampos por tipo
                        Object.keys(metafields).forEach(function(key) {
                            var value = metafields[key];
                            if (value) {
                                var keyLower = key.toLowerCase();
                                
                                if (keyLower.includes('subcategor') || keyLower.includes('categoria')) {
                                    subCategorias.add(value);
                                }
                                else if (keyLower.includes('marca') || keyLower.includes('brand')) {
                                    marcas.add(value);
                                }
                                else if (keyLower.includes('edad') || keyLower.includes('age') || keyLower.includes('años')) {
                                    // Mapeo de IDs de Shopify a valores legibles para edades
                                    var ageMapping = {
                                        'gid://shopify/Metaobject/122522435859': '3-5 años',
                                        'gid://shopify/Metaobject/98466890003': '5-9 años',
                                        'gid://shopify/Metaobject/35341876855059': '9+ años',
                                        'gid://shopify/Metaobject/39573422145811': 'Experto'
                                    };
                                    
                                    if (typeof value === 'string' && value.startsWith('gid://shopify/')) {
                                        var mappedValue = ageMapping[value];
                                        if (mappedValue) {
                                            edades.add(mappedValue);
                                        }
                                    } else if (typeof value === 'string') {
                                        edades.add(value);
                                    }
                                }
                            }
                        });
                    } catch (error) {
                        console.error('Error parseando metacampos:', error);
                    }
                }
            });
            
            console.log('📊 Metacampos extraídos:', {
                subCategorias: subCategorias.size,
                marcas: marcas.size,
                edades: edades.size
            });
            
            // Llenar filtros de Sub-Categorías
            var collectionFilters = document.getElementById('collectionFilters');
            if (collectionFilters) {
                var subCategoriasArray = Array.from(subCategorias).sort();
                if (subCategoriasArray.length > 0) {
                    collectionFilters.innerHTML = subCategoriasArray.map(function(subCategoria) {
                        return '<label class="filter-checkbox">' +
                            '<input type="checkbox" value="' + subCategoria + '" onchange="applyFilters()">' +
                            '<span class="checkmark"></span>' +
                            subCategoria +
                        '</label>';
                    }).join('');
                } else {
                    collectionFilters.innerHTML = '<p style="color: #666; font-style: italic;">No hay sub-categorías disponibles</p>';
                }
            }
            
            // Llenar filtros de Marcas
            var categoryFilters = document.getElementById('categoryFilters');
            if (categoryFilters) {
                var marcasArray = Array.from(marcas).sort();
                if (marcasArray.length > 0) {
                    categoryFilters.innerHTML = marcasArray.map(function(marca) {
                        return '<label class="filter-checkbox">' +
                            '<input type="checkbox" value="' + marca + '" onchange="applyFilters()">' +
                            '<span class="checkmark"></span>' +
                            marca +
                        '</label>';
                    }).join('');
                } else {
                    categoryFilters.innerHTML = '<p style="color: #666; font-style: italic;">No hay marcas disponibles</p>';
                }
            }
            
            // Llenar filtros de Edades
            var ageFilters = document.getElementById('ageFilters');
            if (ageFilters) {
                var edadesArray = Array.from(edades).sort();
                if (edadesArray.length > 0) {
                    ageFilters.innerHTML = edadesArray.map(function(edad) {
                        return '<label class="filter-checkbox">' +
                            '<input type="checkbox" value="' + edad + '" onchange="applyFilters()">' +
                            '<span class="checkmark"></span>' +
                            edad +
                        '</label>';
                    }).join('');
                } else {
                    ageFilters.innerHTML = '<p style="color: #666; font-style: italic;">No hay filtros de edad disponibles</p>';
                }
            }
            
            console.log('✅ Filtros poblados manualmente');
            
            // CRÍTICO: applyFilters ya está definida globalmente arriba, no necesitamos backup aquí
        }
        
        function addToCart(productId, variantId, title, price, image) {
            console.log('✅ addToCart ejecutada:', title);
            try {
                var cart = JSON.parse(localStorage.getItem('b2bCart')) || [];
                var existingItem = cart.find(function(item) { 
                    return item.productId === productId || item.title === title; 
                });
                
                if (existingItem) {
                    existingItem.quantity += 1;
                } else {
                    cart.push({
                        productId: productId || 'product_' + Date.now(),
                        variantId: variantId || 'variant_' + Date.now(),
                        title: title,
                        price: price,
                        image: image,
                        quantity: 1
                    });
                }
                
                localStorage.setItem('b2bCart', JSON.stringify(cart));
                
                // Actualizar badge y mostrar notificación
                updateCartBadge();
                showNotification(title + ' agregado al carrito', 'success');
                
            } catch (error) {
                console.error('❌ Error adding to cart:', error);
                showNotification('Error agregando producto', 'error');
            }
        }
        
        function updateCartBadge() {
            try {
                var cart = JSON.parse(localStorage.getItem('b2bCart')) || [];
                var totalItems = cart.reduce(function(sum, item) { return sum + item.quantity; }, 0);
                var badge = document.getElementById('cartNavbarBadge');
                if (badge) {
                    badge.textContent = totalItems;
                    badge.style.display = totalItems > 0 ? 'inline' : 'none';
                }
            } catch (error) {
                console.error('❌ Error updating cart badge:', error);
            }
        }
        
        function showNotification(message, type) {
            try {
                // Crear elemento de notificación
                var notification = document.createElement('div');
                var bgColor = type === 'success' ? '#10b981' : '#ef4444';
                notification.style.cssText = 
                    'position: fixed;' +
                    'top: 20px;' +
                    'right: 20px;' +
                    'background: ' + bgColor + ';' +
                    'color: white;' +
                    'padding: 1rem 1.5rem;' +
                    'border-radius: 12px;' +
                    'box-shadow: 0 10px 30px rgba(0,0,0,0.2);' +
                    'z-index: 10000;' +
                    'font-weight: 600;' +
                    'transform: translateX(100%);' +
                    'transition: transform 0.3s ease;';
                notification.textContent = message;
                
                document.body.appendChild(notification);
                
                // Animar entrada
                setTimeout(function() {
                    notification.style.transform = 'translateX(0)';
                }, 100);
                
                // Remover después de 3 segundos
                setTimeout(function() {
                    notification.style.transform = 'translateX(100%)';
                    setTimeout(function() {
                        if (document.body.contains(notification)) {
                            document.body.removeChild(notification);
                        }
                    }, 300);
                }, 3000);
                
            } catch (error) {
                console.error('❌ Error showing notification:', error);
            }
        }
        
        function showCart() {
            console.log('✅ showCart ejecutada');
            window.location.href = '/carrito';
        }
        
        function logout() {
            console.log('✅ logout ejecutada');
            if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
                fetch('/api/auth/logout', { method: 'POST' })
                    .then(function(response) { return response.json(); })
                    .then(function(data) {
                        localStorage.removeItem('b2bCart');
                        window.location.reload();
                    })
                    .catch(function(error) {
                        console.error('Error:', error);
                        window.location.reload();
                    });
            }
        }
        
        // Las funciones ya están asignadas globalmente arriba - eliminando asignaciones duplicadas
        // window.toggleUserDropdown, window.addToCart, window.showCart, etc. ya están definidas
        
        // Inicializar cuando el DOM esté completamente cargado
        document.addEventListener('DOMContentLoaded', function() {
            console.log('🚀 DOM cargado, inicializando funciones...');
            updateCartBadge();
        });
        
        // Asegurar que toggleFilters esté disponible globalmente
        if (typeof window.toggleFilters !== 'function') {
            window.toggleFilters = function() {
                console.log('✅ toggleFilters backup ejecutada');
                var panel = document.getElementById('filtersPanel');
                if (panel) {
                    panel.classList.toggle('show');
                }
            };
        }
        
        console.log('✅ Funciones globales cargadas correctamente');
    </script>
</body>
</html>`;
}

// Función para generar HTML del perfil de usuario con formulario editable
function getProfileHTML(customer, profile, addresses, orders, stats) {
  const customerDiscount = customer?.discount || 0;
  
  // Datos de regiones y comunas de Chile
  const regionesComunas = {
    "Región de Arica y Parinacota": ["Arica", "Camarones", "Putre", "General Lagos"],
    "Región de Tarapacá": ["Iquique", "Alto Hospicio", "Pozo Almonte", "Camiña", "Colchane", "Huara", "Pica"],
    "Región de Antofagasta": ["Antofagasta", "Mejillones", "Sierra Gorda", "Taltal", "Calama", "Ollagüe", "San Pedro de Atacama", "Tocopilla", "María Elena"],
    "Región de Atacama": ["Copiapó", "Caldera", "Tierra Amarilla", "Chañaral", "Diego de Almagro", "Vallenar", "Alto del Carmen", "Freirina", "Huasco"],
    "Región de Coquimbo": ["La Serena", "Coquimbo", "Andacollo", "La Higuera", "Paiguano", "Vicuña", "Illapel", "Canela", "Los Vilos", "Salamanca", "Ovalle", "Combarbalá", "Monte Patria", "Punitaqui", "Río Hurtado"],
    "Región de Valparaíso": ["Valparaíso", "Casablanca", "Concón", "Juan Fernández", "Puchuncaví", "Quintero", "Viña del Mar", "Isla de Pascua", "Los Andes", "Calle Larga", "Rinconada", "San Esteban", "La Ligua", "Cabildo", "Papudo", "Petorca", "Zapallar", "Quillota", "La Calera", "Hijuelas", "La Cruz", "Nogales", "San Antonio", "Algarrobo", "Cartagena", "El Quisco", "El Tabo", "Santo Domingo", "San Felipe", "Catemu", "Llaillay", "Panquehue", "Putaendo", "Santa María", "Quilpué", "Limache", "Olmué", "Villa Alemana"],
    "Región Metropolitana": ["Cerrillos", "Cerro Navia", "Conchalí", "El Bosque", "Estación Central", "Huechuraba", "Independencia", "La Cisterna", "La Florida", "La Granja", "La Pintana", "La Reina", "Las Condes", "Lo Barnechea", "Lo Espejo", "Lo Prado", "Macul", "Maipú", "Ñuñoa", "Pedro Aguirre Cerda", "Peñalolén", "Providencia", "Pudahuel", "Quilicura", "Quinta Normal", "Recoleta", "Renca", "Santiago", "San Joaquín", "San Miguel", "San Ramón", "Vitacura", "Puente Alto", "Pirque", "San José de Maipo", "Colina", "Lampa", "Tiltil", "San Bernardo", "Buin", "Calera de Tango", "Paine", "Melipilla", "Alhué", "Curacaví", "María Pinto", "San Pedro", "Talagante", "El Monte", "Isla de Maipo", "Padre Hurtado", "Peñaflor"],
    "Región del Libertador General Bernardo O'Higgins": ["Rancagua", "Codegua", "Coinco", "Coltauco", "Doñihue", "Graneros", "Las Cabras", "Machalí", "Malloa", "Mostazal", "Olivar", "Peumo", "Pichidegua", "Quinta de Tilcoco", "Rengo", "Requínoa", "San Vicente", "Pichilemu", "La Estrella", "Litueche", "Marchihue", "Navidad", "Paredones", "San Fernando", "Chépica", "Chimbarongo", "Lolol", "Nancagua", "Palmilla", "Peralillo", "Placilla", "Pumanque", "Santa Cruz"],
    "Región del Maule": ["Talca", "Constitución", "Curepto", "Empedrado", "Maule", "Pelarco", "Pencahue", "Río Claro", "San Clemente", "San Rafael", "Cauquenes", "Chanco", "Pelluhue", "Curicó", "Hualañé", "Licantén", "Molina", "Rauco", "Romeral", "Sagrada Familia", "Teno", "Vichuquén", "Linares", "Colbún", "Longaví", "Parral", "Retiro", "San Javier", "Villa Alegre", "Yerbas Buenas"],
    "Región de Ñuble": ["Chillán", "Bulnes", "Cobquecura", "Coelemu", "Coihueco", "Chillán Viejo", "El Carmen", "Ninhue", "Ñiquén", "Pemuco", "Pinto", "Portezuelo", "Quillón", "Quirihue", "Ránquil", "San Carlos", "San Fabián", "San Ignacio", "San Nicolás", "Treguaco", "Yungay"],
    "Región del Biobío": ["Concepción", "Coronel", "Chiguayante", "Florida", "Hualqui", "Lota", "Penco", "San Pedro de la Paz", "Santa Juana", "Talcahuano", "Tomé", "Hualpén", "Lebu", "Arauco", "Cañete", "Contulmo", "Curanilahue", "Los Álamos", "Tirúa", "Los Ángeles", "Antuco", "Cabrero", "Laja", "Mulchén", "Nacimiento", "Negrete", "Quilaco", "Quilleco", "San Rosendo", "Santa Bárbara", "Tucapel", "Yumbel", "Alto Biobío"],
    "Región de La Araucanía": ["Temuco", "Carahue", "Cunco", "Curarrehue", "Freire", "Galvarino", "Gorbea", "Lautaro", "Loncoche", "Melipeuco", "Nueva Imperial", "Padre Las Casas", "Perquenco", "Pitrufquén", "Pucón", "Saavedra", "Teodoro Schmidt", "Toltén", "Vilcún", "Villarrica", "Cholchol", "Angol", "Collipulli", "Curacautín", "Ercilla", "Lonquimay", "Los Sauces", "Lumaco", "Purén", "Renaico", "Traiguén", "Victoria"],
    "Región de Los Ríos": ["Valdivia", "Corral", "Lanco", "Los Lagos", "Máfil", "Mariquina", "Paillaco", "Panguipulli", "La Unión", "Futrono", "Lago Ranco", "Río Bueno"],
    "Región de Los Lagos": ["Puerto Montt", "Calbuco", "Cochamó", "Fresia", "Frutillar", "Los Muermos", "Llanquihue", "Maullín", "Puerto Varas", "Castro", "Ancud", "Chonchi", "Curaco de Vélez", "Dalcahue", "Puqueldón", "Queilén", "Quellón", "Quemchi", "Quinchao", "Osorno", "Puerto Octay", "Purranque", "Puyehue", "Río Negro", "San Juan de la Costa", "San Pablo", "Chaitén", "Futaleufú", "Hualaihué", "Palena"],
    "Región de Aysén": ["Coyhaique", "Lago Verde", "Aysén", "Cisnes", "Guaitecas", "Cochrane", "O'Higgins", "Tortel", "Chile Chico", "Río Ibáñez"],
    "Región de Magallanes": ["Punta Arenas", "Laguna Blanca", "Río Verde", "San Gregorio", "Cabo de Hornos", "Antártica", "Porvenir", "Primavera", "Timaukel", "Natales", "Torres del Paine"]
  };
  
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mi Perfil Empresarial - Portal B2B IMANIX Chile</title>
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

        .brand {
            display: flex;
            align-items: center;
            gap: 1rem;
            color: #1A202C;
            text-decoration: none;
            font-weight: 800;
            font-size: 1.5rem;
        }

        .nav-actions {
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .nav-button {
            background: rgba(255, 255, 255, 0.2);
            border: none;
            padding: 0.75rem 1.5rem;
            border-radius: 12px;
            color: #1A202C;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .nav-button:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-1px);
        }

        .profile-container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 0 2rem 4rem;
            animation: fadeInUp 0.8s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .profile-header {
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

        .profile-header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 33%, #11998e 66%, #f093fb 100%);
        }

        .profile-title {
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

        .profile-subtitle {
            color: #64748b;
            font-size: 1.1rem;
            font-weight: 500;
            letter-spacing: 0.01em;
        }

        .profile-tabs {
            display: flex;
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 24px;
            padding: 0.75rem;
            margin-bottom: 3rem;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            overflow-x: auto;
            gap: 0.5rem;
        }

        .tab-button {
            flex: 1;
            padding: 1.25rem 2rem;
            border: none;
            background: none;
            cursor: pointer;
            border-radius: 16px;
            font-weight: 600;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            white-space: nowrap;
            color: #64748b;
            font-size: 0.95rem;
            position: relative;
            overflow: hidden;
        }

        .tab-button::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            opacity: 0;
            transition: opacity 0.3s ease;
            border-radius: 16px;
        }

        .tab-button.active {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            color: #1A202C;
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
        }

        .tab-button:hover:not(.active) {
            background: rgba(102, 126, 234, 0.1);
            color: #667eea;
            transform: translateY(-1px);
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
            animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
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

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 2rem;
            margin-bottom: 4rem;
        }

        .stat-card {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 24px;
            padding: 2.5rem;
            text-align: center;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #FFCE36, #000000, #3b82f6);
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-8px) scale(1.02);
            box-shadow: 
                0 32px 64px -12px rgba(0, 0, 0, 0.15), 
                0 20px 25px -5px rgba(0, 0, 0, 0.1),
                0 0 0 1px rgba(255, 206, 54, 0.1);
        }

        .stat-card:hover::before {
            opacity: 1;
        }

        .stat-icon {
            width: 72px;
            height: 72px;
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1.5rem;
            font-size: 1.75rem;
            color: #1A202C;
            position: relative;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .stat-icon::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: inherit;
            filter: brightness(1.1);
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .stat-card:hover .stat-icon::before {
            opacity: 1;
        }

        .stat-icon.orders { 
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            box-shadow: 0 8px 32px rgba(102, 126, 234, 0.4);
        }
        .stat-icon.spent { 
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            box-shadow: 0 8px 32px rgba(240, 147, 251, 0.4);
        }
        .stat-icon.saved { 
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            box-shadow: 0 8px 32px rgba(17, 153, 142, 0.4);
        }
        .stat-icon.discount { 
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            box-shadow: 0 8px 32px rgba(255, 206, 54, 0.4);
        }

        .content-card {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            
            -webkit-
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 32px;
            padding: 3rem;
            margin-bottom: 3rem;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(255, 255, 255, 0.05);
            position: relative;
            overflow: hidden;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .content-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #11998e 0%, #38ef7d 100%);
        }

        .content-card:hover {
            transform: translateY(-4px);
            box-shadow: 
                0 25px 50px -12px rgba(0, 0, 0, 0.15), 
                0 0 0 1px rgba(17, 153, 142, 0.1);
        }

        .section-title {
            font-size: 2rem;
            font-weight: 900;
            margin-bottom: 2rem;
            color: #1A202C;
            display: flex;
            align-items: center;
            gap: 1rem;
            letter-spacing: -0.025em;
        }

        .section-title i {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .form-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
        }

        .form-group {
            margin-bottom: 2rem;
        }

        .form-label {
            display: block;
            margin-bottom: 0.75rem;
            font-weight: 600;
            color: #374151;
            font-size: 0.95rem;
            letter-spacing: 0.01em;
        }

        .form-input {
            width: 100%;
            padding: 1rem 1.5rem;
            border: 2px solid rgba(148, 163, 184, 0.2);
            border-radius: 16px;
            font-size: 1rem;
            background: rgba(255, 255, 255, 0.8);
            backdrop-filter: blur(10px);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-weight: 500;
            color: #1A202C;
        }

        .form-input::placeholder {
            color: #94a3b8;
            font-weight: 500;
        }

        .form-input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 
                0 0 0 4px rgba(102, 126, 234, 0.1),
                0 4px 12px rgba(102, 126, 234, 0.15);
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            transform: translateY(-1px);
        }

        .btn {
            padding: 1rem 2rem;
            border: none;
            border-radius: 16px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 0.75rem;
            font-size: 0.95rem;
            letter-spacing: 0.01em;
            position: relative;
            overflow: hidden;
        }

        .btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: inherit;
            filter: brightness(1.1);
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .btn:hover::before {
            opacity: 1;
        }

        .btn-primary {
            background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
            color: #1A202C;
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
        }

        .btn-primary:hover {
            transform: translateY(-3px) scale(1.02);
            box-shadow: 0 12px 40px rgba(102, 126, 234, 0.5);
        }

        .btn-secondary {
            background: #f7fafc;
            color: #4a5568;
            border: 2px solid #e2e8f0;
        }

        .btn-danger {
            background: #fed7d7;
            color: #e53e3e;
            border: 2px solid #feb2b2;
        }

        .address-card {
            border: 2px solid #e2e8f0;
            border-radius: 10px;
            padding: 1.5rem;
            margin-bottom: 1rem;
            transition: all 0.3s ease;
        }

        .address-card:hover {
            border-color: #FFCE36;
            box-shadow: 0 5px 15px rgba(255, 206, 54, 0.2);
        }

        .address-card.default {
            border-color: #48bb78;
            background: #f0fff4;
        }

        .address-type {
            background: linear-gradient(135deg, #3b82f6, #1d4ed8);
            color: #1A202C;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.875rem;
            font-weight: 600;
            display: inline-block;
            margin-bottom: 1rem;
        }

        .address-type.billing {
            background: linear-gradient(135deg, #f59e0b, #d97706);
        }

        .order-card {
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            padding: 1.5rem;
            margin-bottom: 1rem;
            transition: all 0.3s ease;
        }

        .order-card:hover {
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }

        .order-card.clickeable {
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .order-card.clickeable:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.15);
            border-color: #FFCE36;
        }

        .click-hint {
            margin-top: 1rem;
            padding: 0.75rem;
            background: linear-gradient(135deg, #FFCE36, #FFC107);
            color: #000;
            text-align: center;
            border-radius: 8px;
            font-size: 0.875rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }

        .order-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }

        .order-status {
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.875rem;
            font-weight: 600;
        }

        .status-completed { background: #c6f6d5; color: #22543d; }
        .status-pending { background: #feebc8; color: #9c4221; }
        .status-cancelled { background: #fed7d7; color: #742a2a; }

        .empty-state {
            text-align: center;
            padding: 3rem;
            color: #718096;
        }

        .empty-state i {
            font-size: 3rem;
            margin-bottom: 1rem;
            opacity: 0.5;
        }

        /* Estilos del navbar dropdown */
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

        @media (max-width: 768px) {
            .profile-container {
                padding: 0 1rem;
            }

            .navbar {
                padding: 1rem;
            }

            .stats-grid {
                grid-template-columns: 1fr;
            }

            .form-grid {
                grid-template-columns: 1fr;
            }

            .order-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 0.5rem;
            }
        }
        /* ANIMACIONES DE ENTRADA SUTILES */
        .stat-card, .product-card, .cart-item {
            animation: fadeInUp 0.6s ease-out !important;
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* LOADING STATES ELEGANTES */
        .loading-spinner {
            border: 2px solid var(--gray-200) !important;
            border-top: 2px solid var(--imanix-yellow) !important;
        }
        
        /* PRECIO DESTACADO */
        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: white !important;
            font-weight: 800 !important;
            font-size: 1.25rem !important;
        }
        
        /* NAVBAR LOGO MEJORADO */
        .brand-logo {
            transition: all 0.3s ease !important;
        }
        .brand-logo:hover {
            transform: scale(1.05) !important;
            box-shadow: 0 4px 12px rgba(255, 206, 54, 0.3) !important;
        }
        
        /* CART SUMMARY ELEGANTE */
        .cart-summary {
            border-top: 3px solid var(--imanix-yellow) !important;
        }
        
        /* QUANTITY CONTROLS REFINADOS */
        .quantity-controls {
            background: var(--gray-50) !important;
            border: 1px solid var(--gray-200) !important;
        }
        
        /* NOTIFICACIONES PROFESIONALES */
        .notification {
            border-radius: 8px !important;
            backdrop-filter: blur(10px) !important;
        }
        
        /* ACCESIBILIDAD MEJORADA */
        .btn:focus, .form-input:focus, .form-select:focus {
            outline: 2px solid var(--imanix-yellow) !important;
            outline-offset: 2px !important;
        }
        /* CORRECCIONES DE CONTRASTE ESPECÍFICAS */
        .discounted-price, .item-total-price.discounted {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            display: inline-block !important;
        }
        
        .savings, .price-breakdown.highlight {
            color: #10B981 !important;
            font-weight: 600 !important;
        }
        
        .discount-badge, .cart-navbar-badge {
            color: white !important;
            font-weight: 700 !important;
        }
        
        /* Asegurar contraste en todos los elementos verdes */
        .success-text, .discount-text, .savings-amount {
            color: white !important;
            background: #10B981 !important;
            padding: 0.125rem 0.25rem !important;
            border-radius: 3px !important;
        }
        /* PRECIOS MEJORADOS CON CONTRASTE PERFECTO */
        .discounted-price-block {
            background: #10B981 !important;
            color: white !important;
            padding: 0.75rem 1rem !important;
            border-radius: 8px !important;
            margin-bottom: 0.5rem !important;
        }
        
        .discounted-price {
            color: white !important;
            font-size: 1.5rem !important;
            font-weight: 800 !important;
            display: block !important;
            margin-bottom: 0.25rem !important;
        }
        
        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.9) !important;
            font-size: 0.875rem !important;
        }
        
        .savings {
            color: #10B981 !important;
            font-weight: 600 !important;
            font-size: 0.875rem !important;
        }
        
        /* NOTIFICACIONES CON CONTRASTE PERFECTO */
        .notification {
            color: white !important;
        }
        
        .notification-message {
            color: white !important;
        }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }
        
        .cart-navbar-badge {
            background: #EF4444 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }






    </style>
</head>
<body>
    <nav class="navbar">
        <div class="navbar-content">
            <a href="/" class="navbar-brand" style="text-decoration: none;">
                <img src="/images/Logo%202160x1200%20(1).png" alt="IMANIX Portal B2B" style="height: 70px; width: auto;" />
            </a>
            <div class="navbar-actions">
                <div class="user-account" onclick="toggleUserDropdown()">
                    <i class="fas fa-user-circle"></i>
                    <span>${customer?.firstName || 'Usuario'} ${customer?.lastName || ''}</span>
                    <i class="fas fa-chevron-down" style="font-size: 0.75rem; margin-left: 0.25rem;"></i>
                    
                    <div class="user-dropdown" id="userDropdown">
                        <div class="dropdown-header">
                            <div class="user-name">${customer?.firstName || 'Usuario'} ${customer?.lastName || ''}</div>
                            <div class="user-email">${customer?.email || 'no-email@example.com'}</div>
                        </div>
                        
                        <div class="dropdown-menu">
                            <a href="/perfil" class="dropdown-item">
                                <i class="fas fa-user-edit"></i>
                                Mi Perfil
                            </a>
                            <a href="/carrito" class="dropdown-item">
                                <i class="fas fa-shopping-cart"></i>
                                Mi Carrito
                            </a>
                            <a href="/perfil" class="dropdown-item">
                                <i class="fas fa-history"></i>
                                Historial de Pedidos
                            </a>
                            <div class="dropdown-divider"></div>
                            <button onclick="logout()" class="dropdown-item">
                                <i class="fas fa-sign-out-alt"></i>
                                Cerrar Sesión
                            </button>
                        </div>
                    </div>
                </div>
                <button class="cart-navbar-btn" onclick="showCart()">
                    <i class="fas fa-shopping-cart"></i>
                    <span class="cart-navbar-badge" id="cartNavbarBadge">0</span>
                </button>
            </div>
        </div>
    </nav>

    <div class="profile-container">
        <div class="profile-header">
            <h1 class="profile-title">
                <i class="fas fa-user-circle"></i>
                Mi Perfil B2B
            </h1>
            <p class="profile-subtitle">Bienvenido/a ${customer?.firstName || 'Usuario'} • ${customer?.email || 'no-email@example.com'} • Descuento B2B: ${customerDiscount}%</p>
        </div>

        ${stats ? `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon orders">
                    <i class="fas fa-shopping-bag"></i>
                </div>
                <h3>${stats?.totalOrders || 0}</h3>
                <p>Pedidos Realizados</p>
            </div>
            <div class="stat-card">
                <div class="stat-icon spent">
                    <i class="fas fa-dollar-sign"></i>
                </div>
                <h3>$${new Intl.NumberFormat('es-CL').format(stats?.totalSpent || 0)}</h3>
                <p>Total Gastado</p>
            </div>
            <div class="stat-card">
                <div class="stat-icon saved">
                    <i class="fas fa-piggy-bank"></i>
                </div>
                <h3>$${new Intl.NumberFormat('es-CL').format(stats?.totalSaved || 0)}</h3>
                <p>Total Ahorrado</p>
            </div>
            <div class="stat-card">
                <div class="stat-icon discount">
                    <i class="fas fa-tags"></i>
                </div>
                <h3>${stats?.discountPercentage || customerDiscount}%</h3>
                <p>Descuento Activo</p>
            </div>
        </div>
        ` : ''}

        <div class="profile-tabs">
            <button class="tab-button active" onclick="switchTab('profile', this)">
                <i class="fas fa-user"></i>
                Perfil
            </button>
            <button class="tab-button" onclick="switchTab('addresses', this)">
                <i class="fas fa-map-marker-alt"></i>
                Direcciones
            </button>
            <button class="tab-button" onclick="switchTab('orders', this)">
                <i class="fas fa-history"></i>
                Historial
            </button>
        </div>

        <!-- Tab Perfil -->
        <div id="profile-tab" class="tab-content active">
            <div class="content-card">
                <h2 class="section-title">
                    <i class="fas fa-user-edit"></i>
                    Información Personal
                </h2>
                
                <form id="profileForm" onsubmit="updateProfile(event)">
                    <!-- Datos Personales -->
                    <div style="margin-bottom: 2rem;">
                        <h3 style="color: #1A202C; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
                            <i class="fas fa-user"></i>
                            Datos Personales
                        </h3>
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label">Email</label>
                                <input type="email" class="form-input" value="${customer?.email || 'no-email@example.com'}" disabled>
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label">Nombre</label>
                                <input type="text" name="first_name" class="form-input" 
                                       value="${profile?.first_name || ''}" placeholder="Tu nombre">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label">Apellido</label>
                                <input type="text" name="last_name" class="form-input" 
                                       value="${profile?.last_name || ''}" placeholder="Tu apellido">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label">Celular</label>
                                <input type="tel" name="mobile_phone" class="form-input" 
                                       value="${profile?.mobile_phone || ''}" placeholder="+56 9 1234 5678">
                            </div>
                        </div>
                    </div>

                    <!-- Datos Empresariales -->
                    <div style="margin-bottom: 2rem;">
                        <h3 style="color: #1A202C; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
                            <i class="fas fa-building"></i>
                            Datos Empresariales
                        </h3>
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label">Razón Social</label>
                                <input type="text" name="company_name" class="form-input" 
                                       value="${profile?.company_name || ''}" placeholder="Nombre de tu empresa">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label">RUT Empresa</label>
                                <input type="text" name="company_rut" class="form-input" 
                                       value="${profile?.company_rut || ''}" placeholder="12.345.678-9">
                            </div>
                            
                            <div class="form-group" style="grid-column: 1 / -1;">
                                <label class="form-label">Giro Empresarial</label>
                                <input type="text" name="company_giro" class="form-input" 
                                       value="${profile?.company_giro || ''}" placeholder="Venta al por menor de juguetes">
                            </div>
                            
                            <div class="form-group" style="grid-column: 1 / -1;">
                                <label class="form-label">Dirección</label>
                                <input type="text" name="company_address" class="form-input" 
                                       value="${profile?.company_address || ''}" placeholder="Av. Ejemplo 1234">
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label">Región</label>
                                <select name="region" class="form-input" onchange="updateComunasInProfile()">
                                    <option value="">Selecciona tu región</option>
                                    <option value="Región de Arica y Parinacota" ${profile?.region === 'Región de Arica y Parinacota' ? 'selected' : ''}>Región de Arica y Parinacota</option>
                                    <option value="Región de Tarapacá" ${profile?.region === 'Región de Tarapacá' ? 'selected' : ''}>Región de Tarapacá</option>
                                    <option value="Región de Antofagasta" ${profile?.region === 'Región de Antofagasta' ? 'selected' : ''}>Región de Antofagasta</option>
                                    <option value="Región de Atacama" ${profile?.region === 'Región de Atacama' ? 'selected' : ''}>Región de Atacama</option>
                                    <option value="Región de Coquimbo" ${profile?.region === 'Región de Coquimbo' ? 'selected' : ''}>Región de Coquimbo</option>
                                    <option value="Región de Valparaíso" ${profile?.region === 'Región de Valparaíso' ? 'selected' : ''}>Región de Valparaíso</option>
                                    <option value="Región Metropolitana" ${profile?.region === 'Región Metropolitana' ? 'selected' : ''}>Región Metropolitana</option>
                                    <option value="Región del Libertador General Bernardo O'Higgins" ${profile?.region === "Región del Libertador General Bernardo O'Higgins" ? 'selected' : ''}>Región del Libertador General Bernardo O'Higgins</option>
                                    <option value="Región del Maule" ${profile?.region === 'Región del Maule' ? 'selected' : ''}>Región del Maule</option>
                                    <option value="Región de Ñuble" ${profile?.region === 'Región de Ñuble' ? 'selected' : ''}>Región de Ñuble</option>
                                    <option value="Región del Biobío" ${profile?.region === 'Región del Biobío' ? 'selected' : ''}>Región del Biobío</option>
                                    <option value="Región de La Araucanía" ${profile?.region === 'Región de La Araucanía' ? 'selected' : ''}>Región de La Araucanía</option>
                                    <option value="Región de Los Ríos" ${profile?.region === 'Región de Los Ríos' ? 'selected' : ''}>Región de Los Ríos</option>
                                    <option value="Región de Los Lagos" ${profile?.region === 'Región de Los Lagos' ? 'selected' : ''}>Región de Los Lagos</option>
                                    <option value="Región Aysén del General Carlos Ibáñez del Campo" ${profile?.region === 'Región Aysén del General Carlos Ibáñez del Campo' ? 'selected' : ''}>Región Aysén del General Carlos Ibáñez del Campo</option>
                                    <option value="Región de Magallanes y de la Antártica Chilena" ${profile?.region === 'Región de Magallanes y de la Antártica Chilena' ? 'selected' : ''}>Región de Magallanes y de la Antártica Chilena</option>
                                </select>
                            </div>
                            
                            <div class="form-group">
                                <label class="form-label">Comuna</label>
                                <select name="comuna" id="comunaSelectProfile" class="form-input">
                                    <option value="">Selecciona tu comuna</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    
                    <button type="submit" class="btn btn-primary">
                        <i class="fas fa-save"></i>
                        Guardar Cambios
                    </button>
                </form>
            </div>
        </div>

        <!-- Tab Direcciones -->
        <div id="addresses-tab" class="tab-content">
            <div class="content-card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
                    <h2 class="section-title" style="margin-bottom: 0;">
                        <i class="fas fa-map-marker-alt"></i>
                        Mis Direcciones
                    </h2>
                    <button class="btn btn-primary" onclick="showAddAddressModal()">
                        <i class="fas fa-plus"></i>
                        Agregar Dirección
                    </button>
                </div>
                
                <div id="addressesList">
                    ${addresses && addresses.length > 0 ? 
                        addresses.map(addr => `
                            <div class="address-card ${addr.is_default ? 'default' : ''}">
                                <div class="address-type ${addr.type}">
                                    ${addr.type === 'shipping' ? 'Envío' : 'Facturación'}
                                    ${addr.is_default ? ' (Por Defecto)' : ''}
                                </div>
                                <p><strong>${addr.first_name} ${addr.last_name}</strong></p>
                                ${addr.company ? `<p>${addr.company}</p>` : ''}
                                <p>${addr.address1}</p>
                                ${addr.address2 ? `<p>${addr.address2}</p>` : ''}
                                <p>${addr.city}, ${addr.state || ''} ${addr.postal_code}</p>
                                <p>${addr.country}</p>
                                ${addr.phone ? `<p><i class="fas fa-phone"></i> ${addr.phone}</p>` : ''}
                                
                                <div style="margin-top: 1rem;">
                                    <button class="btn btn-secondary" onclick="editAddress('${addr.id}')">
                                        <i class="fas fa-edit"></i>
                                        Editar
                                    </button>
                                    <button class="btn btn-danger" onclick="deleteAddress('${addr.id}')">
                                        <i class="fas fa-trash"></i>
                                        Eliminar
                                    </button>
                                </div>
                            </div>
                        `).join('') :
                        `<div class="empty-state">
                            <i class="fas fa-map-marker-alt"></i>
                            <h3>No tienes direcciones guardadas</h3>
                            <p>Agrega tu primera dirección para facilitar tus pedidos</p>
                        </div>`
                    }
                </div>
            </div>
        </div>

        <!-- Tab Historial -->
        <div id="orders-tab" class="tab-content">
            <div class="content-card">
                <h2 class="section-title">
                    <i class="fas fa-history"></i>
                    Historial de Pedidos
                </h2>
                
                <div id="ordersList">
                    ${orders && orders.length > 0 ? 
                        orders.map(order => `
                            <div class="order-card clickeable" onclick="showOrderDetails('${order.id}', '${order.order_number || order.id.substring(0, 8)}', '${order.total_amount}', '${order.discount_amount || 0}', '${order.status}', '${new Date(order.created_at || order.order_date).toLocaleDateString('es-CL')}', '${order.shopify_order_id}')">
                                <div class="order-header">
                                    <div>
                                        <h4>Pedido #${order.order_number || order.id.substring(0, 8)}</h4>
                                        <p style="color: #718096; margin-top: 0.25rem;">
                                            ${new Date(order.created_at || order.order_date).toLocaleDateString('es-CL')}
                                        </p>
                                    </div>
                                    <div class="order-status status-${order.status.toLowerCase()}">
                                        ${order.status}
                                    </div>
                                </div>
                                
                                <div style="margin-bottom: 1rem;">
                                    <strong>Total: ${formatPrice(order.total_amount)}</strong>
                                    ${order.discount_amount > 0 ? 
                                        `<span style="color: #48bb78; margin-left: 1rem;">
                                            Ahorrado: ${formatPrice(order.discount_amount)}
                                        </span>` : ''
                                    }
                                </div>
                                
                                <div class="click-hint">
                                    <i class="fas fa-eye"></i>
                                    Click para ver detalles completos
                                </div>
                            </div>
                        `).join('') :
                        `<div class="empty-state">
                            <i class="fas fa-shopping-bag"></i>
                            <h3>No tienes pedidos aún</h3>
                            <p>Cuando realices tu primer pedido aparecerá aquí</p>
                            <a href="/" class="btn btn-primary" style="margin-top: 1rem;">
                                <i class="fas fa-shopping-cart"></i>
                                Explorar Catálogo
                            </a>
                        </div>`
                    }
                </div>
            </div>
        </div>
    </div>

    <script>
        // Funciones del navbar - AGREGADAS
        function toggleUserDropdown() {
            const dropdown = document.getElementById('userDropdown');
            dropdown.classList.toggle('show');
        }

        // Cerrar dropdown al hacer clic fuera
        document.addEventListener('click', function(event) {
            const userAccount = document.querySelector('.user-account');
            const dropdown = document.getElementById('userDropdown');
            
            if (userAccount && dropdown && !userAccount.contains(event.target)) {
                dropdown.classList.remove('show');
            }
        });

        // Mostrar carrito - redirigir a página dedicada
        function showCart() {
            window.location.href = '/carrito';
        }

        // Carrito de compras
        let cart = JSON.parse(localStorage.getItem('b2bCart')) || [];

        // Actualizar contador del carrito
        function updateCartBadge() {
            const badge = document.getElementById('cartNavbarBadge');
            if (badge) {
                const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
                badge.textContent = totalItems;
            }
        }

        // Función de logout
        async function logout() {
            if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
                try {
                    const response = await fetch('/api/auth/logout', { method: 'POST' });
                    const data = await response.json();
                    
                    if (data.success) {
                        localStorage.removeItem('b2bCart');
                        window.location.href = '/';
                    } else {
                        alert('Error al cerrar sesión');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error de conexión');
                }
            }
        }

        // Función switchTab - ÚNICA DEFINICIÓN
        function switchTab(tabName, buttonElement) {
            console.log('switchTab ejecutado:', tabName);
            
            try {
                // Ocultar todas las tabs
                document.querySelectorAll('.tab-content').forEach(tab => {
                    tab.classList.remove('active');
                });
                
                // Mostrar tab seleccionada
                const targetTab = document.getElementById(tabName + '-tab');
                if (targetTab) {
                    targetTab.classList.add('active');
                }
                
                // Actualizar botones
                document.querySelectorAll('.tab-button').forEach(btn => {
                    btn.classList.remove('active');
                });
                
                if (buttonElement) {
                    buttonElement.classList.add('active');
                }
            } catch (error) {
                console.error('Error en switchTab:', error);
            }
        }
        
        // Hacer disponible globalmente
        window.switchTab = switchTab;

        async function updateProfile(event) {
            event.preventDefault();
            
            const formData = new FormData(event.target);
            const profileData = Object.fromEntries(formData.entries());
            
            try {
                const response = await fetch('/api/profile/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(profileData)
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showNotification('Perfil actualizado exitosamente', 'success');
                } else {
                    showNotification(result.message || 'Error actualizando perfil', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showNotification('Error de conexión', 'error');
            }
        }

        // Datos de regiones y comunas para el perfil
        const regionesComunasProfile = {
            "Región de Arica y Parinacota": ["Arica", "Camarones", "Putre", "General Lagos"],
            "Región de Tarapacá": ["Iquique", "Alto Hospicio", "Pozo Almonte", "Camiña", "Colchane", "Huara", "Pica"],
            "Región de Antofagasta": ["Antofagasta", "Mejillones", "Sierra Gorda", "Taltal", "Calama", "Ollagüe", "San Pedro de Atacama", "Tocopilla", "María Elena"],
            "Región de Atacama": ["Copiapó", "Caldera", "Tierra Amarilla", "Chañaral", "Diego de Almagro", "Vallenar", "Alto del Carmen", "Freirina", "Huasco"],
            "Región de Coquimbo": ["La Serena", "Coquimbo", "Andacollo", "La Higuera", "Paiguano", "Vicuña", "Illapel", "Canela", "Los Vilos", "Salamanca", "Ovalle", "Combarbalá", "Monte Patria", "Punitaqui", "Río Hurtado"],
            "Región de Valparaíso": ["Valparaíso", "Casablanca", "Concón", "Juan Fernández", "Puchuncaví", "Quintero", "Viña del Mar", "Isla de Pascua", "Los Andes", "Calle Larga", "Rinconada", "San Esteban", "La Ligua", "Cabildo", "Papudo", "Petorca", "Zapallar", "Quillota", "Calera", "Hijuelas", "La Cruz", "Nogales", "San Antonio", "Algarrobo", "Cartagena", "El Quisco", "El Tabo", "Santo Domingo", "San Felipe", "Catemu", "Llaillay", "Panquehue", "Putaendo", "Santa María", "Quilpué", "Limache", "Olmué", "Villa Alemana"],
            "Región Metropolitana": ["Cerrillos", "Cerro Navia", "Conchalí", "El Bosque", "Estación Central", "Huechuraba", "Independencia", "La Cisterna", "La Florida", "La Granja", "La Pintana", "La Reina", "Las Condes", "Lo Barnechea", "Lo Espejo", "Lo Prado", "Macul", "Maipú", "Ñuñoa", "Pedro Aguirre Cerda", "Peñalolén", "Providencia", "Pudahuel", "Quilicura", "Quinta Normal", "Recoleta", "Renca", "Santiago", "San Joaquín", "San Miguel", "San Ramón", "Vitacura", "Puente Alto", "Pirque", "San José de Maipo", "Colina", "Lampa", "Tiltil", "San Bernardo", "Buin", "Calera de Tango", "Paine", "Melipilla", "Alhué", "Curacaví", "María Pinto", "San Pedro", "Talagante", "El Monte", "Isla de Maipo", "Padre Hurtado", "Peñaflor"],
            "Región del Libertador General Bernardo O'Higgins": ["Rancagua", "Codegua", "Coinco", "Coltauco", "Doñihue", "Graneros", "Las Cabras", "Machalí", "Malloa", "Mostazal", "Olivar", "Peumo", "Pichidegua", "Quinta de Tilcoco", "Rengo", "Requínoa", "San Vicente", "Pichilemu", "La Estrella", "Litueche", "Marchihue", "Navidad", "Paredones", "San Fernando", "Chépica", "Chimbarongo", "Lolol", "Nancagua", "Palmilla", "Peralillo", "Placilla", "Pumanque", "Santa Cruz"],
            "Región del Maule": ["Talca", "Constitución", "Curepto", "Empedrado", "Maule", "Pelarco", "Pencahue", "Río Claro", "San Clemente", "San Rafael", "Cauquenes", "Chanco", "Pelluhue", "Curicó", "Hualañé", "Licantén", "Molina", "Rauco", "Romeral", "Sagrada Familia", "Teno", "Vichuquén", "Linares", "Colbún", "Longaví", "Parral", "Retiro", "San Javier", "Villa Alegre", "Yerbas Buenas"],
            "Región de Ñuble": ["Chillán", "Bulnes", "Cobquecura", "Coelemu", "Coihueco", "Chillán Viejo", "El Carmen", "Ninhue", "Ñiquén", "Pemuco", "Pinto", "Portezuelo", "Quillón", "Quirihue", "Ránquil", "San Carlos", "San Fabián", "San Ignacio", "San Nicolás", "Treguaco", "Yungay"],
            "Región del Biobío": ["Concepción", "Coronel", "Chiguayante", "Florida", "Hualqui", "Lota", "Penco", "San Pedro de la Paz", "Santa Juana", "Talcahuano", "Tomé", "Hualpén", "Lebu", "Arauco", "Cañete", "Contulmo", "Curanilahue", "Los Álamos", "Tirúa", "Los Ángeles", "Antuco", "Cabrero", "Laja", "Mulchén", "Nacimiento", "Negrete", "Quilaco", "Quilleco", "San Rosendo", "Santa Bárbara", "Tucapel", "Yumbel", "Alto Biobío"],
            "Región de La Araucanía": ["Temuco", "Carahue", "Cunco", "Curarrehue", "Freire", "Galvarino", "Gorbea", "Lautaro", "Loncoche", "Melipeuco", "Nueva Imperial", "Padre Las Casas", "Perquenco", "Pitrufquén", "Pucón", "Saavedra", "Teodoro Schmidt", "Toltén", "Vilcún", "Villarrica", "Cholchol", "Angol", "Collipulli", "Curacautín", "Ercilla", "Lonquimay", "Los Sauces", "Lumaco", "Purén", "Renaico", "Traiguén", "Victoria"],
            "Región de Los Ríos": ["Valdivia", "Corral", "Lanco", "Los Lagos", "Máfil", "Mariquina", "Paillaco", "Panguipulli", "La Unión", "Futrono", "Lago Ranco", "Río Bueno"],
            "Región de Los Lagos": ["Puerto Montt", "Calbuco", "Cochamó", "Fresia", "Frutillar", "Los Muermos", "Llanquihue", "Maullín", "Puerto Varas", "Castro", "Ancud", "Chonchi", "Curaco de Vélez", "Dalcahue", "Puqueldón", "Queilén", "Quellón", "Quemchi", "Quinchao", "Osorno", "Puerto Octay", "Purranque", "Puyehue", "Río Negro", "San Juan de la Costa", "San Pablo", "Chaitén", "Futaleufú", "Hualaihué", "Palena"],
            "Región Aysén del General Carlos Ibáñez del Campo": ["Coyhaique", "Lago Verde", "Aysén", "Cisnes", "Guaitecas", "Cochrane", "O'Higgins", "Tortel", "Chile Chico", "Río Ibáñez"],
            "Región de Magallanes y de la Antártica Chilena": ["Punta Arenas", "Laguna Blanca", "Río Verde", "San Gregorio", "Cabo de Hornos", "Antártica", "Porvenir", "Primavera", "Timaukel", "Natales", "Torres del Paine"]
        };

        function updateComunasInProfile() {
            const regionSelect = document.querySelector('select[name="region"]');
            const comunaSelect = document.getElementById('comunaSelectProfile');
            
            if (!regionSelect || !comunaSelect) return;
            
            const selectedRegion = regionSelect.value;
            
            // Limpiar comunas actuales
            comunaSelect.innerHTML = '<option value="">Selecciona tu comuna</option>';
            
            if (selectedRegion && regionesComunasProfile[selectedRegion]) {
                comunaSelect.disabled = false;
                
                regionesComunasProfile[selectedRegion].forEach(comuna => {
                    const option = document.createElement('option');
                    option.value = comuna;
                    option.textContent = comuna;
                    comunaSelect.appendChild(option);
                });
            } else {
                comunaSelect.disabled = true;
            }
        }

        // Inicializar comunas al cargar la página si hay región seleccionada
        document.addEventListener('DOMContentLoaded', function() {
            console.log('Página cargada - iniciando');
            console.log('Total de pedidos:', ${orders?.length || 0});
            
            // Inicializar carrito
            updateCartBadge();
            
            const regionSelect = document.querySelector('select[name="region"]');
            const comunaSelect = document.getElementById('comunaSelectProfile');
            const currentComuna = '${profile?.comuna || ''}';
            
            // Verificar tabs
            const profileTab = document.getElementById('profile-tab');
            const addressesTab = document.getElementById('addresses-tab'); 
            const ordersTab = document.getElementById('orders-tab');
            console.log('Tabs encontradas:');
            console.log('profile-tab:', profileTab ? 'SÍ' : 'NO');
            console.log('addresses-tab:', addressesTab ? 'SÍ' : 'NO'); 
            console.log('orders-tab:', ordersTab ? 'SÍ' : 'NO');
            
            // Verificar que switchTab esté disponible
            console.log('switchTab disponible:', typeof switchTab);
            console.log('window.switchTab disponible:', typeof window.switchTab);
            
            if (regionSelect && regionSelect.value) {
                updateComunasInProfile();
                
                // Seleccionar la comuna actual si existe
                if (currentComuna && comunaSelect) {
                    setTimeout(() => {
                        comunaSelect.value = currentComuna;
                    }, 100);
                }
            }
        });

        function showAddAddressModal() {
            // Implementar modal para agregar dirección
            const type = prompt('Tipo de dirección (shipping/billing):');
            if (!type || !['shipping', 'billing'].includes(type)) return;
            
            const firstName = prompt('Nombre:');
            if (!firstName) return;
            
            const lastName = prompt('Apellido:');
            if (!lastName) return;
            
            const address1 = prompt('Dirección:');
            if (!address1) return;
            
            const city = prompt('Ciudad:');
            if (!city) return;
            
            const postalCode = prompt('Código Postal:');
            if (!postalCode) return;
            
            addAddress({
                type,
                first_name: firstName,
                last_name: lastName,
                address1,
                city,
                postal_code: postalCode,
                country: 'Chile'
            });
        }

        async function addAddress(addressData) {
            try {
                const response = await fetch('/api/addresses', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(addressData)
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showNotification('Dirección agregada exitosamente', 'success');
                    setTimeout(() => window.location.reload(), 1000);
                } else {
                    showNotification(result.message || 'Error agregando dirección', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showNotification('Error de conexión', 'error');
            }
        }

        async function deleteAddress(addressId) {
            if (!confirm('¿Estás seguro de que quieres eliminar esta dirección?')) return;
            
            try {
                const response = await fetch('/api/addresses/' + addressId, {
                    method: 'DELETE'
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showNotification('Dirección eliminada exitosamente', 'success');
                    setTimeout(() => window.location.reload(), 1000);
                } else {
                    showNotification(result.message || 'Error eliminando dirección', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showNotification('Error de conexión', 'error');
            }
        }

        function editAddress(addressId) {
            // Implementar edición de dirección
            showNotification('Función de edición en desarrollo', 'info');
        }

        function showNotification(message, type) {
            const notification = document.createElement('div');
            const bgColor = type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6';
            notification.style.position = 'fixed';
            notification.style.top = '20px';
            notification.style.right = '20px';
            notification.style.background = bgColor;
            notification.style.color = 'white';
            notification.style.padding = '1rem 1.5rem';
            notification.style.borderRadius = '12px';
            notification.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
            notification.style.zIndex = '10000';
            notification.style.fontWeight = '600';
            notification.style.transform = 'translateX(100%)';
            notification.style.transition = 'transform 0.3s ease';
            notification.textContent = message;
            
            document.body.appendChild(notification);
            
            setTimeout(() => notification.style.transform = 'translateX(0)', 100);
            
            setTimeout(() => {
                notification.style.transform = 'translateX(100%)';
                setTimeout(() => document.body.removeChild(notification), 300);
            }, 3000);
        }

        function formatPrice(price) {
            return new Intl.NumberFormat('es-CL', {
                style: 'currency',
                currency: 'CLP'
            }).format(price);
        }

        function showOrderDetails(orderId, orderNumber, totalAmount, discountAmount, status, date, shopifyOrderId) {
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;backdrop-filter:blur(5px);';
            
            const statusBg = status === 'pendiente' ? '#feebc8' : '#c6f6d5';
            const statusColor = status === 'pendiente' ? '#9c4221' : '#22543d';
            const discountHtml = parseFloat(discountAmount) > 0 ? 
                '<div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #e5e7eb;"><strong>Descuento Aplicado:</strong><br><span style="color:#10b981;font-weight:600;">- ' + formatPrice(parseFloat(discountAmount)) + '</span></div>' : '';
            
            // Crear el contenido del modal con event listeners en lugar de onclick inline
            const modalContent = document.createElement('div');
            modalContent.style.cssText = 'background:white;padding:2rem;border-radius:16px;box-shadow:0 20px 40px rgba(0,0,0,0.2);max-width:500px;width:90%;';
            
            modalContent.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;"><h2 style="margin:0;color:#1f2937;font-weight:700;">Detalles del Pedido</h2><button id="closeModal" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#6b7280;">×</button></div><div style="background:#f8f9fa;padding:1.5rem;border-radius:12px;margin-bottom:1.5rem;"><div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;"><div><strong>Número de Pedido:</strong><br><span style="color:#6366f1;font-weight:600;">#' + orderNumber + '</span></div><div><strong>Estado:</strong><br><span style="padding:0.25rem 0.75rem;border-radius:20px;font-size:0.875rem;font-weight:600;background:' + statusBg + ';color:' + statusColor + ';">' + status + '</span></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;"><div><strong>Fecha:</strong><br><span>' + date + '</span></div><div><strong>Total:</strong><br><span style="color:#059669;font-weight:700;font-size:1.1rem;">' + formatPrice(parseFloat(totalAmount)) + '</span></div></div>' + discountHtml + '</div><div style="background:#fff3cd;padding:1rem;border-radius:8px;border-left:4px solid #ffc107;margin-bottom:1.5rem;"><div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;"><i class="fas fa-info-circle" style="color:#856404;"></i><strong style="color:#856404;">Estado del Pedido</strong></div><p style="margin:0;color:#856404;font-size:0.9rem;">Tu pedido está siendo revisado por nuestro equipo. Te contactaremos pronto para confirmar los detalles de envío y pago.</p></div><div style="display:flex;gap:1rem;"><button id="closeModalBtn" style="flex:1;padding:0.75rem;background:#6b7280;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;">Cerrar</button></div>';
            
            modal.appendChild(modalContent);
            document.body.appendChild(modal);
            
            // Agregar event listeners después de agregar al DOM
            document.getElementById('closeModal').addEventListener('click', () => modal.remove());
            document.getElementById('closeModalBtn').addEventListener('click', () => modal.remove());
            
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.remove();
                }
            });
        }

        async function logout() {
            if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
                try {
                    const response = await fetch('/api/auth/logout', { method: 'POST' });
                    const data = await response.json();
                    
                    if (data.success) {
                        localStorage.removeItem('b2bCart');
                        window.location.href = '/';
                    } else {
                        alert('Error al cerrar sesión');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error de conexión');
                }
            }
        }
    </script>
</body>
</html>`;
}

// ========== RUTAS DEL PERFIL DE USUARIO ==========

// Middleware para verificar autenticación (para páginas HTML)
function requireAuth(req, res, next) {
  if (!req.session.customer) {
    return res.redirect('/');
  }
  next();
}

// Middleware para verificar autenticación (para APIs)
function requireAuthAPI(req, res, next) {
  if (!req.session.customer) {
    return res.status(401).json({ 
      success: false, 
      message: 'Acceso no autorizado' 
    });
  }
  next();
}

// Página del perfil de usuario
app.get('/perfil', requireAuth, async (req, res) => {
  try {
    const customer = req.session.customer;
    const profile = await database.getProfile(customer?.email || 'no-email@example.com');
    const addresses = await database.getUserAddresses(customer?.email || 'no-email@example.com');
    const orders = await database.getUserOrders(customer?.email || 'no-email@example.com', 10);
    const stats = await database.getStats(customer?.email || 'no-email@example.com');
    
    const html = getProfileHTML(customer, profile, addresses, orders, stats);
    res.send(html);
  } catch (error) {
    console.error('Error cargando perfil:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// API - Obtener perfil
app.get('/api/profile', requireAuthAPI, async (req, res) => {
  try {
    const customer = req.session.customer;
    const profile = await database.getProfile(customer?.email || 'no-email@example.com');
    const stats = await database.getStats(customer?.email || 'no-email@example.com');
    
    res.json({
      success: true,
      data: {
        profile,
        stats,
        customer
      }
    });
  } catch (error) {
    console.error('Error obteniendo perfil:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Actualizar perfil
app.put('/api/profile', requireAuthAPI, async (req, res) => {
  try {
    const customer = req.session.customer;
    const updates = req.body;
    
    // Campos permitidos para actualizar
    const allowedFields = ['company_name', 'contact_name', 'phone'];
    const filteredUpdates = {};
    
    allowedFields.forEach(field => {
      if (updates[field] !== undefined) {
        filteredUpdates[field] = updates[field];
      }
    });
    
    const profile = await database.updateProfile(customer?.email || 'no-email@example.com', filteredUpdates);
    
    if (profile) {
      res.json({ success: true, data: profile });
    } else {
      res.status(400).json({ success: false, message: 'Error actualizando perfil' });
    }
  } catch (error) {
    console.error('Error actualizando perfil:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Obtener direcciones
app.get('/api/addresses', requireAuthAPI, async (req, res) => {
  try {
    const customer = req.session.customer;
    const addresses = await database.getUserAddresses(customer?.email || 'no-email@example.com');
    
    res.json({ success: true, data: addresses });
  } catch (error) {
    console.error('Error obteniendo direcciones:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Agregar dirección
app.post('/api/addresses', requireAuthAPI, async (req, res) => {
  try {
    const customer = req.session.customer;
    const addressData = req.body;
    
    // Validar campos requeridos
    const required = ['type', 'first_name', 'last_name', 'address1', 'city', 'postal_code'];
    const missing = required.filter(field => !addressData[field]);
    
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Campos requeridos: ${missing.join(', ')}`
      });
    }
    
    if (!['shipping', 'billing'].includes(addressData.type)) {
      return res.status(400).json({
        success: false,
        message: 'Tipo de dirección debe ser "shipping" o "billing"'
      });
    }
    
    const address = await database.addAddress(customer?.email || 'no-email@example.com', addressData);
    
    if (address) {
      res.json({ success: true, data: address });
    } else {
      res.status(400).json({ success: false, message: 'Error agregando dirección' });
    }
  } catch (error) {
    console.error('Error agregando dirección:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Actualizar dirección
app.put('/api/addresses/:id', requireAuthAPI, async (req, res) => {
  try {
    const addressId = req.params.id;
    const updates = req.body;
    
    const address = await database.updateAddress(addressId, updates);
    
    if (address) {
      res.json({ success: true, data: address });
    } else {
      res.status(400).json({ success: false, message: 'Error actualizando dirección' });
    }
  } catch (error) {
    console.error('Error actualizando dirección:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Eliminar dirección
app.delete('/api/addresses/:id', requireAuthAPI, async (req, res) => {
  try {
    const addressId = req.params.id;
    const success = await database.deleteAddress(addressId);
    
    if (success) {
      res.json({ success: true, message: 'Dirección eliminada' });
    } else {
      res.status(400).json({ success: false, message: 'Error eliminando dirección' });
    }
  } catch (error) {
    console.error('Error eliminando dirección:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Obtener historial de pedidos
app.get('/api/orders', requireAuthAPI, async (req, res) => {
  try {
    const customer = req.session.customer;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const orders = await database.getUserOrders(customer?.email || 'no-email@example.com', limit, offset);
    
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error('Error obteniendo pedidos:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Obtener detalles de un pedido
app.get('/api/orders/:id', requireAuthAPI, async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = await database.getOrderDetails(orderId);
    
    if (order) {
      res.json({ success: true, data: order });
    } else {
      res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    }
  } catch (error) {
    console.error('Error obteniendo detalles del pedido:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// Webhooks de Shopify con validación de seguridad
app.post('/webhooks/products/update', express.raw({ type: 'application/json' }), (req, res) => {
  console.log('🔄 Webhook recibido de Shopify');
  
  try {
    // Validar webhook secret (opcional para desarrollo)
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const webhookSecret = process.env.WEBHOOK_SECRET;
    
    if (webhookSecret && hmacHeader) {
      const crypto = require('crypto');
      const body = req.body;
      const hash = crypto.createHmac('sha256', webhookSecret).update(body, 'utf8').digest('base64');
      
      if (hash !== hmacHeader) {
        console.log('❌ Webhook no autorizado - HMAC inválido');
        return res.status(401).send('Unauthorized');
      }
      console.log('🔐 Webhook verificado correctamente');
    } else if (webhookSecret) {
      console.log('⚠️ No se recibió HMAC header para validación');
    } else {
      console.log('⚠️ WEBHOOK_SECRET no configurado - saltando validación');
    }
    
    // Convertir Buffer a string y luego parsear
    const bodyString = req.body.toString();
    const product = JSON.parse(bodyString);
    const tags = product.tags || '';
    
    console.log(`📦 Producto: ${product.title}`);
    console.log(`🏷️ Etiquetas: ${tags}`);
    
    if (tags.toLowerCase().includes('b2b')) {
      console.log('✅ Producto TIENE etiqueta "b2b" - debería estar en el portal');
    } else {
      console.log('❌ Producto NO tiene etiqueta "b2b" - no debería estar en el portal');
    }
    
    console.log('💡 Para ver cambios: ejecuta "node sync.js" y refresca localhost:3000');
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error procesando webhook:', error);
    res.status(500).send('Error');
  }
});

// Página Mi Cuenta
app.get('/cuenta', requireAuth, async (req, res) => {
  try {
    const customer = {
      ...req.session.customer,
      discountPercentage: req.session.customer?.discount
    };
    const profile = await database.getUserProfile(customer?.email || 'no-email@example.com');
    const addresses = await database.getUserAddresses(customer?.email || 'no-email@example.com');
    const stats = await database.getUserStats(customer?.email || 'no-email@example.com');
    
    res.send(getAccountHTML(customer, profile, addresses, stats));
  } catch (error) {
    console.error('Error obteniendo datos de cuenta:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Página Historial de Pedidos
app.get('/pedidos', requireAuth, async (req, res) => {
  try {
    const customer = {
      ...req.session.customer,
      discountPercentage: req.session.customer?.discount
    };
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    
    const orders = await database.getUserOrders(customer?.email || 'no-email@example.com', limit, offset);
    const totalOrders = await database.getUserOrdersCount(customer?.email || 'no-email@example.com');
    const totalPages = Math.ceil(totalOrders / limit);
    
    res.send(getOrdersHTML(customer, orders, page, totalPages));
  } catch (error) {
    console.error('Error obteniendo historial de pedidos:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Página Detalles de Pedido
app.get('/pedidos/:id', requireAuth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const customer = {
      ...req.session.customer,
      discountPercentage: req.session.customer?.discount
    };
    
    const order = await database.getOrderDetails(orderId);
    
    if (!order || order.customer_email !== customer?.email || 'no-email@example.com') {
      return res.status(404).send('Pedido no encontrado');
    }
    
    res.send(getOrderDetailHTML(customer, order));
  } catch (error) {
    console.error('Error obteniendo detalles del pedido:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// ========== FUNCIONES HTML PARA NUEVAS PÁGINAS ==========

// Función para generar HTML de Mi Cuenta
function getAccountHTML(customer, profile, addresses, stats) {
  const hasProfile = profile && Object.keys(profile).length > 0;
  const totalOrders = stats?.totalOrders || 0;
  const totalSpent = stats?.totalSpent || 0;
  const avgOrderValue = stats?.avgOrderValue || 0;
  
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Mi Cuenta - Portal B2B IMANIX</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                line-height: 1.6; 
                color: #333; 
                background: linear-gradient(135deg, #FFCE36 0%, #000000 100%);
                min-height: 100vh;
            }
            .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
            .header {
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                padding: 1rem 2rem;
                margin-bottom: 2rem;
                border-radius: 15px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .logo { font-size: 1.8rem; font-weight: bold; color: #2c3e50; text-decoration: none; }
            .user-info { display: flex; align-items: center; gap: 15px; }
            .discount-badge { 
                background: linear-gradient(45deg, #ff6b6b, #ff8e53);
                color: #1A202C; padding: 8px 16px; border-radius: 20px;
                font-weight: bold; font-size: 0.9rem;
            }
            .logout-btn {
                background: #e74c3c; color: #1A202C; padding: 8px 16px;
                border: none; border-radius: 8px; cursor: pointer;
                text-decoration: none; font-size: 0.9rem;
            }
            .logout-btn:hover { background: #c0392b; }
            .nav-menu {
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                padding: 1rem; margin-bottom: 2rem; border-radius: 15px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
            }
            .nav-menu ul { list-style: none; display: flex; gap: 2rem; justify-content: center; flex-wrap: wrap; }
            .nav-menu a {
                color: #2c3e50; text-decoration: none; padding: 10px 20px;
                border-radius: 8px; transition: all 0.3s ease; font-weight: 500;
            }
            .nav-menu a:hover, .nav-menu a.active {
                background: linear-gradient(45deg, #FFCE36, #000000);
                color: #1A202C; transform: translateY(-2px);
            }
            .account-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 2rem; margin-bottom: 2rem;
            }
            .card {
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                padding: 2rem; border-radius: 15px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
            }
            .card h2 {
                color: #2c3e50; margin-bottom: 1rem;
                display: flex; align-items: center; gap: 10px;
            }
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 1rem; margin-top: 1rem;
            }
            .stat-item {
                text-align: center; padding: 1rem;
                background: linear-gradient(45deg, #FFCE36, #000000);
                color: #1A202C; border-radius: 10px;
            }
            .stat-value { font-size: 2rem; font-weight: bold; display: block; }
            .stat-label { font-size: 0.9rem; opacity: 0.9; }
            .profile-item {
                display: flex; justify-content: space-between;
                padding: 10px 0; border-bottom: 1px solid #eee;
            }
            .profile-item:last-child { border-bottom: none; }
            .profile-label { font-weight: 500; color: #666; }
            .profile-value { color: #2c3e50; font-weight: 500; }
            .btn {
                background: linear-gradient(45deg, #FFCE36, #000000);
                color: #1A202C; padding: 12px 24px; border: none;
                border-radius: 8px; cursor: pointer; text-decoration: none;
                font-weight: 500; transition: all 0.3s ease;
                display: inline-block; margin-top: 1rem;
            }
            .btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            }
        /* ANIMACIONES DE ENTRADA SUTILES */
        .stat-card, .product-card, .cart-item {
            animation: fadeInUp 0.6s ease-out !important;
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* LOADING STATES ELEGANTES */
        .loading-spinner {
            border: 2px solid var(--gray-200) !important;
            border-top: 2px solid var(--imanix-yellow) !important;
        }
        
        /* PRECIO DESTACADO */
        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: white !important;
            font-weight: 800 !important;
            font-size: 1.25rem !important;
        }
        
        /* NAVBAR LOGO MEJORADO */
        .brand-logo {
            transition: all 0.3s ease !important;
        }
        .brand-logo:hover {
            transform: scale(1.05) !important;
            box-shadow: 0 4px 12px rgba(255, 206, 54, 0.3) !important;
        }
        
        /* CART SUMMARY ELEGANTE */
        .cart-summary {
            border-top: 3px solid var(--imanix-yellow) !important;
        }
        
        /* QUANTITY CONTROLS REFINADOS */
        .quantity-controls {
            background: var(--gray-50) !important;
            border: 1px solid var(--gray-200) !important;
        }
        
        /* NOTIFICACIONES PROFESIONALES */
        .notification {
            border-radius: 8px !important;
            backdrop-filter: blur(10px) !important;
        }
        
        /* ACCESIBILIDAD MEJORADA */
        .btn:focus, .form-input:focus, .form-select:focus {
            outline: 2px solid var(--imanix-yellow) !important;
            outline-offset: 2px !important;
        }
        /* CORRECCIONES DE CONTRASTE ESPECÍFICAS */
        .discounted-price, .item-total-price.discounted {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            display: inline-block !important;
        }
        
        .savings, .price-breakdown.highlight {
            color: #10B981 !important;
            font-weight: 600 !important;
        }
        
        .discount-badge, .cart-navbar-badge {
            color: white !important;
            font-weight: 700 !important;
        }
        
        /* Asegurar contraste en todos los elementos verdes */
        .success-text, .discount-text, .savings-amount {
            color: white !important;
            background: #10B981 !important;
            padding: 0.125rem 0.25rem !important;
            border-radius: 3px !important;
        }
        /* PRECIOS MEJORADOS CON CONTRASTE PERFECTO */
        .discounted-price-block {
            background: #10B981 !important;
            color: white !important;
            padding: 0.75rem 1rem !important;
            border-radius: 8px !important;
            margin-bottom: 0.5rem !important;
        }
        
        .discounted-price {
            color: white !important;
            font-size: 1.5rem !important;
            font-weight: 800 !important;
            display: block !important;
            margin-bottom: 0.25rem !important;
        }
        
        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.9) !important;
            font-size: 0.875rem !important;
        }
        
        .savings {
            color: #10B981 !important;
            font-weight: 600 !important;
            font-size: 0.875rem !important;
        }
        
        /* NOTIFICACIONES CON CONTRASTE PERFECTO */
        .notification {
            color: white !important;
        }
        
        .notification-message {
            color: white !important;
        }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }
        
        .cart-navbar-badge {
            background: #EF4444 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }






        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <a href="/" class="logo">🧲 IMANIX B2B</a>
                <div class="user-info">
                    <span class="discount-badge">${customer?.discountPercentage}% Descuento B2B</span>
                    <span>👤 ${customer?.email || 'no-email@example.com'}</span>
                    <a href="/api/auth/logout" class="logout-btn">Cerrar Sesión</a>
                </div>
            </div>
            <div class="nav-menu">
                <ul>
                    <li><a href="/">🏠 Inicio</a></li>
                    <li><a href="/cuenta" class="active">👤 Mi Cuenta</a></li>
                    <li><a href="/pedidos">📦 Mis Pedidos</a></li>
                    <li><a href="/perfil">⚙️ Perfil Empresarial</a></li>
                    <li><a href="/carrito">🛒 Carrito</a></li>
                </ul>
            </div>
            <div class="account-grid">
                <div class="card">
                    <h2>📊 Resumen de Cuenta</h2>
                    <div class="stats-grid">
                        <div class="stat-item">
                            <span class="stat-value">${totalOrders}</span>
                            <span class="stat-label">Pedidos</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">$${totalSpent.toLocaleString()}</span>
                            <span class="stat-label">Total Gastado</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">${avgOrderValue}</span>
                            <span class="stat-label">Promedio</span>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <h2>👤 Información Personal</h2>
                    ${hasProfile ? `
                        <div class="profile-item">
                            <span class="profile-label">Nombre:</span>
                            <span class="profile-value">${profile.first_name || 'No especificado'} ${profile.last_name || ''}</span>
                        </div>
                        <div class="profile-item">
                            <span class="profile-label">Email:</span>
                            <span class="profile-value">${customer?.email || 'no-email@example.com'}</span>
                        </div>
                        <div class="profile-item">
                            <span class="profile-label">Teléfono:</span>
                            <span class="profile-value">${profile.mobile_phone || 'No especificado'}</span>
                        </div>
                        <div class="profile-item">
                            <span class="profile-label">Empresa:</span>
                            <span class="profile-value">${profile.company_name || 'No especificado'}</span>
                        </div>
                        <div class="profile-item">
                            <span class="profile-label">RUT:</span>
                            <span class="profile-value">${profile.company_rut || 'No especificado'}</span>
                        </div>
                    ` : `
                        <p>No hay información de perfil disponible.</p>
                    `}
                    <a href="/perfil" class="btn">✏️ Editar Perfil</a>
                </div>
                <div class="card">
                    <h2>📦 Pedidos Recientes</h2>
                    <p>Consulta tu historial completo en la sección de pedidos.</p>
                    <a href="/pedidos" class="btn">📦 Ver Todos los Pedidos</a>
                </div>
            </div>
        </div>
    </body>
    </html>
  `;
}

// Función para generar HTML del Historial de Pedidos
function getOrdersHTML(customer, orders, currentPage, totalPages) {
  const ordersHTML = orders && orders.length > 0 ? 
    orders.map(order => `
        <div class="order-card">
            <div class="order-header">
                <div class="order-info">
                    <h3>Pedido #${order.id}</h3>
                    <div class="order-date">${new Date(order.created_at).toLocaleDateString('es-ES')}</div>
                </div>
                <div class="order-status">Pendiente</div>
            </div>
            <div class="order-details">
                <div class="detail-item">
                    <span class="detail-label">Total:</span>
                    <span class="detail-value">$${order.total.toLocaleString()}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Items:</span>
                    <span class="detail-value">${order.item_count || 1}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Descuento:</span>
                    <span class="detail-value">${customer?.discountPercentage}%</span>
                </div>
            </div>
            <div class="order-actions">
                <a href="/pedidos/${order.id}" class="btn">👁️ Ver Detalles</a>
            </div>
        </div>
    `).join('') : `
        <div class="empty-state">
            <h3>📦 No tienes pedidos aún</h3>
            <p>¡Explora nuestro catálogo y haz tu primer pedido!</p>
            <a href="/" class="btn">🛒 Ir al Catálogo</a>
        </div>
    `;

  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Mis Pedidos - Portal B2B IMANIX</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                line-height: 1.6; color: #333; 
                background: linear-gradient(135deg, #FFCE36 0%, #000000 100%);
                min-height: 100vh;
            }
            .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
            .header {
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                padding: 1rem 2rem; margin-bottom: 2rem; border-radius: 15px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
                display: flex; justify-content: space-between; align-items: center;
            }
            .logo { font-size: 1.8rem; font-weight: bold; color: #2c3e50; text-decoration: none; }
            .user-info { display: flex; align-items: center; gap: 15px; }
            .discount-badge { 
                background: linear-gradient(45deg, #ff6b6b, #ff8e53);
                color: #1A202C; padding: 8px 16px; border-radius: 20px;
                font-weight: bold; font-size: 0.9rem;
            }
            .logout-btn {
                background: #e74c3c; color: #1A202C; padding: 8px 16px;
                border: none; border-radius: 8px; text-decoration: none; font-size: 0.9rem;
            }
            .logout-btn:hover { background: #c0392b; }
            .nav-menu {
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                padding: 1rem; margin-bottom: 2rem; border-radius: 15px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
            }
            .nav-menu ul { list-style: none; display: flex; gap: 2rem; justify-content: center; flex-wrap: wrap; }
            .nav-menu a {
                color: #2c3e50; text-decoration: none; padding: 10px 20px;
                border-radius: 8px; transition: all 0.3s ease; font-weight: 500;
            }
            .nav-menu a:hover, .nav-menu a.active {
                background: linear-gradient(45deg, #FFCE36, #000000);
                color: #1A202C; transform: translateY(-2px);
            }
            .orders-container {
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                padding: 2rem; border-radius: 15px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
            }
            .orders-header {
                display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 2px solid #eee;
            }
            .orders-title { color: #2c3e50; font-size: 1.8rem; margin: 0; }
            .order-card {
                background: #f8f9fa; padding: 1.5rem; margin-bottom: 1rem;
                border-radius: 10px; border-left: 4px solid #FFCE36;
                transition: all 0.3s ease;
            }
            .order-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            }
            .order-header {
                display: flex; justify-content: space-between;
                align-items: flex-start; margin-bottom: 1rem;
            }
            .order-info h3 { color: #2c3e50; margin: 0 0 5px 0; }
            .order-date { color: #666; font-size: 0.9rem; }
            .order-status {
                padding: 6px 12px; border-radius: 20px; color: #1A202C;
                font-size: 0.8rem; font-weight: bold; background: #f39c12;
            }
            .order-details {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 1rem; margin-bottom: 1rem;
            }
            .detail-item { display: flex; justify-content: space-between; }
            .detail-label { color: #666; font-weight: 500; }
            .detail-value { color: #2c3e50; font-weight: bold; }
            .order-actions { display: flex; gap: 10px; justify-content: flex-end; }
            .btn {
                background: linear-gradient(45deg, #FFCE36, #000000);
                color: #1A202C; padding: 8px 16px; border: none;
                border-radius: 6px; cursor: pointer; text-decoration: none;
                font-size: 0.9rem; font-weight: 500; transition: all 0.3s ease;
            }
            .btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 3px 10px rgba(102, 126, 234, 0.4);
            }
            .empty-state { text-align: center; padding: 3rem; color: #666; }
            .empty-state h3 { margin-bottom: 1rem; color: #2c3e50; }
        /* ANIMACIONES DE ENTRADA SUTILES */
        .stat-card, .product-card, .cart-item {
            animation: fadeInUp 0.6s ease-out !important;
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* LOADING STATES ELEGANTES */
        .loading-spinner {
            border: 2px solid var(--gray-200) !important;
            border-top: 2px solid var(--imanix-yellow) !important;
        }
        
        /* PRECIO DESTACADO */
        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: white !important;
            font-weight: 800 !important;
            font-size: 1.25rem !important;
        }
        
        /* NAVBAR LOGO MEJORADO */
        .brand-logo {
            transition: all 0.3s ease !important;
        }
        .brand-logo:hover {
            transform: scale(1.05) !important;
            box-shadow: 0 4px 12px rgba(255, 206, 54, 0.3) !important;
        }
        
        /* CART SUMMARY ELEGANTE */
        .cart-summary {
            border-top: 3px solid var(--imanix-yellow) !important;
        }
        
        /* QUANTITY CONTROLS REFINADOS */
        .quantity-controls {
            background: var(--gray-50) !important;
            border: 1px solid var(--gray-200) !important;
        }
        
        /* NOTIFICACIONES PROFESIONALES */
        .notification {
            border-radius: 8px !important;
            backdrop-filter: blur(10px) !important;
        }
        
        /* ACCESIBILIDAD MEJORADA */
        .btn:focus, .form-input:focus, .form-select:focus {
            outline: 2px solid var(--imanix-yellow) !important;
            outline-offset: 2px !important;
        }
        /* CORRECCIONES DE CONTRASTE ESPECÍFICAS */
        .discounted-price, .item-total-price.discounted {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            display: inline-block !important;
        }
        
        .savings, .price-breakdown.highlight {
            color: #10B981 !important;
            font-weight: 600 !important;
        }
        
        .discount-badge, .cart-navbar-badge {
            color: white !important;
            font-weight: 700 !important;
        }
        
        /* Asegurar contraste en todos los elementos verdes */
        .success-text, .discount-text, .savings-amount {
            color: white !important;
            background: #10B981 !important;
            padding: 0.125rem 0.25rem !important;
            border-radius: 3px !important;
        }
        /* PRECIOS MEJORADOS CON CONTRASTE PERFECTO */
        .discounted-price-block {
            background: #10B981 !important;
            color: white !important;
            padding: 0.75rem 1rem !important;
            border-radius: 8px !important;
            margin-bottom: 0.5rem !important;
        }
        
        .discounted-price {
            color: white !important;
            font-size: 1.5rem !important;
            font-weight: 800 !important;
            display: block !important;
            margin-bottom: 0.25rem !important;
        }
        
        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.9) !important;
            font-size: 0.875rem !important;
        }
        
        .savings {
            color: #10B981 !important;
            font-weight: 600 !important;
            font-size: 0.875rem !important;
        }
        
        /* NOTIFICACIONES CON CONTRASTE PERFECTO */
        .notification {
            color: white !important;
        }
        
        .notification-message {
            color: white !important;
        }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }
        
        .cart-navbar-badge {
            background: #EF4444 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }






        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <a href="/" class="logo">🧲 IMANIX B2B</a>
                <div class="user-info">
                    <span class="discount-badge">${customer?.discountPercentage}% Descuento B2B</span>
                    <span>👤 ${customer?.email || 'no-email@example.com'}</span>
                    <a href="/api/auth/logout" class="logout-btn">Cerrar Sesión</a>
                </div>
            </div>
            <div class="nav-menu">
                <ul>
                    <li><a href="/">🏠 Inicio</a></li>
                    <li><a href="/cuenta">👤 Mi Cuenta</a></li>
                    <li><a href="/pedidos" class="active">📦 Mis Pedidos</a></li>
                    <li><a href="/perfil">⚙️ Perfil Empresarial</a></li>
                    <li><a href="/carrito">🛒 Carrito</a></li>
                </ul>
            </div>
            <div class="orders-container">
                <div class="orders-header">
                    <h1 class="orders-title">📦 Mis Pedidos</h1>
                    <a href="/" class="btn">🛒 Seguir Comprando</a>
                </div>
                ${ordersHTML}
            </div>
        </div>
    </body>
    </html>
  `;
}

// Función para generar HTML de Detalle de Pedido
function getOrderDetailHTML(customer, order) {
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pedido #${order.id} - Portal B2B IMANIX</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                line-height: 1.6; color: #333; 
                background: linear-gradient(135deg, #FFCE36 0%, #000000 100%);
                min-height: 100vh;
            }
            .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
            .header {
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                padding: 1rem 2rem; margin-bottom: 2rem; border-radius: 15px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
                display: flex; justify-content: space-between; align-items: center;
            }
            .logo { font-size: 1.8rem; font-weight: bold; color: #2c3e50; text-decoration: none; }
            .back-btn {
                background: #6c757d; color: #1A202C; padding: 8px 16px;
                border: none; border-radius: 8px; text-decoration: none; font-size: 0.9rem;
            }
            .back-btn:hover { background: #5a6268; }
            .order-detail {
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                padding: 2rem; border-radius: 15px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
            }
            .order-header {
                display: flex; justify-content: space-between; align-items: flex-start;
                margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 2px solid #eee;
            }
            .order-title { color: #2c3e50; font-size: 1.8rem; margin: 0; }
            .order-status {
                padding: 10px 20px; border-radius: 25px; color: #1A202C;
                font-weight: bold; background: #f39c12;
            }
            .info-card {
                background: #f8f9fa; padding: 1.5rem; border-radius: 10px;
                border-left: 4px solid #FFCE36; margin-bottom: 1rem;
            }
            .info-card h3 { color: #2c3e50; margin-bottom: 1rem; }
            .info-item {
                display: flex; justify-content: space-between;
                padding: 8px 0; border-bottom: 1px solid #dee2e6;
            }
            .info-item:last-child { border-bottom: none; }
            .info-label { color: #666; font-weight: 500; }
            .info-value { color: #2c3e50; font-weight: 600; }
        /* ANIMACIONES DE ENTRADA SUTILES */
        .stat-card, .product-card, .cart-item {
            animation: fadeInUp 0.6s ease-out !important;
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        /* LOADING STATES ELEGANTES */
        .loading-spinner {
            border: 2px solid var(--gray-200) !important;
            border-top: 2px solid var(--imanix-yellow) !important;
        }
        
        /* PRECIO DESTACADO */
        .discounted-price {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            color: white !important;
            font-weight: 800 !important;
            font-size: 1.25rem !important;
        }
        
        /* NAVBAR LOGO MEJORADO */
        .brand-logo {
            transition: all 0.3s ease !important;
        }
        .brand-logo:hover {
            transform: scale(1.05) !important;
            box-shadow: 0 4px 12px rgba(255, 206, 54, 0.3) !important;
        }
        
        /* CART SUMMARY ELEGANTE */
        .cart-summary {
            border-top: 3px solid var(--imanix-yellow) !important;
        }
        
        /* QUANTITY CONTROLS REFINADOS */
        .quantity-controls {
            background: var(--gray-50) !important;
            border: 1px solid var(--gray-200) !important;
        }
        
        /* NOTIFICACIONES PROFESIONALES */
        .notification {
            border-radius: 8px !important;
            backdrop-filter: blur(10px) !important;
        }
        
        /* ACCESIBILIDAD MEJORADA */
        .btn:focus, .form-input:focus, .form-select:focus {
            outline: 2px solid var(--imanix-yellow) !important;
            outline-offset: 2px !important;
        }
        /* CORRECCIONES DE CONTRASTE ESPECÍFICAS */
        .discounted-price, .item-total-price.discounted {
            background: #10B981 !important;
            color: white !important;
            padding: 0.25rem 0.5rem !important;
            border-radius: 4px !important;
            display: inline-block !important;
        }
        
        .savings, .price-breakdown.highlight {
            color: #10B981 !important;
            font-weight: 600 !important;
        }
        
        .discount-badge, .cart-navbar-badge {
            color: white !important;
            font-weight: 700 !important;
        }
        
        /* Asegurar contraste en todos los elementos verdes */
        .success-text, .discount-text, .savings-amount {
            color: white !important;
            background: #10B981 !important;
            padding: 0.125rem 0.25rem !important;
            border-radius: 3px !important;
        }
        /* PRECIOS MEJORADOS CON CONTRASTE PERFECTO */
        .discounted-price-block {
            background: #10B981 !important;
            color: white !important;
            padding: 0.75rem 1rem !important;
            border-radius: 8px !important;
            margin-bottom: 0.5rem !important;
        }
        
        .discounted-price {
            color: white !important;
            font-size: 1.5rem !important;
            font-weight: 800 !important;
            display: block !important;
            margin-bottom: 0.25rem !important;
        }
        
        .price-breakdown.highlight {
            color: rgba(255, 255, 255, 0.9) !important;
            font-size: 0.875rem !important;
        }
        
        .savings {
            color: #10B981 !important;
            font-weight: 600 !important;
            font-size: 0.875rem !important;
        }
        
        /* NOTIFICACIONES CON CONTRASTE PERFECTO */
        .notification {
            color: white !important;
        }
        
        .notification-message {
            color: white !important;
        }
        
        /* BADGES MEJORADOS */
        .discount-overlay {
            background: #10B981 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }
        
        .cart-navbar-badge {
            background: #EF4444 !important;
            color: white !important;
            font-weight: 700 !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1) !important;
        }






        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <a href="/" class="logo">🧲 IMANIX B2B</a>
                <a href="/pedidos" class="back-btn">← Volver a Pedidos</a>
            </div>
            <div class="order-detail">
                <div class="order-header">
                    <div>
                        <h1 class="order-title">Pedido #${order.id}</h1>
                        <p style="color: #666; margin-top: 5px;">
                            Realizado el ${new Date(order.created_at).toLocaleDateString('es-ES')}
                        </p>
                    </div>
                    <div class="order-status">Pendiente</div>
                </div>
                <div class="info-card">
                    <h3>📋 Información del Pedido</h3>
                    <div class="info-item">
                        <span class="info-label">ID del Pedido:</span>
                        <span class="info-value">#${order.id}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Total:</span>
                        <span class="info-value">$${order.total.toLocaleString()}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Descuento B2B:</span>
                        <span class="info-value">${customer?.discountPercentage}%</span>
                    </div>
                </div>
            </div>
        </div>
    </body>
    </html>
  `;
}

// Generate Portal HTML for authenticated users
function getBasicPortalHTML(customer) {
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Portal B2B - IMANIX Chile</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #FFCE36 0%, #F7B500 100%);
                min-height: 100vh;
                color: #1A202C;
            }
            
            .portal-header {
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(10px);
                border-bottom: 1px solid rgba(255, 255, 255, 0.2);
                padding: 1rem 2rem;
                display: flex;
                justify-content: space-between;
                align-items: center;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            
            .logo {
                font-size: 1.8rem;
                font-weight: 900;
                color: #1A202C;
                text-decoration: none;
            }
            
            .user-info {
                display: flex;
                align-items: center;
                gap: 1rem;
            }
            
            .user-name {
                font-weight: 600;
                color: #1A202C;
            }
            
            .logout-btn {
                background: #1A202C;
                color: #FFCE36;
                border: none;
                padding: 0.5rem 1rem;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 600;
                transition: all 0.3s ease;
            }
            
            .logout-btn:hover {
                background: #2D3748;
                transform: translateY(-2px);
            }
            
            .portal-container {
                max-width: 1200px;
                margin: 2rem auto;
                padding: 0 2rem;
            }
            
            .welcome-card {
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 2rem;
                margin-bottom: 2rem;
                box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
            }
            
            .welcome-title {
                font-size: 2rem;
                font-weight: 900;
                color: #1A202C;
                margin-bottom: 0.5rem;
            }
            
            .welcome-subtitle {
                color: #64748b;
                font-size: 1.1rem;
                margin-bottom: 1.5rem;
            }
            
            .user-details {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 1rem;
                margin-top: 1.5rem;
            }
            
            .detail-item {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                padding: 0.75rem;
                background: rgba(255, 206, 54, 0.1);
                border-radius: 10px;
                border: 1px solid rgba(255, 206, 54, 0.2);
            }
            
            .detail-icon {
                color: #F7B500;
                font-size: 1.2rem;
            }
            
            .detail-label {
                font-weight: 600;
                color: #1A202C;
            }
            
            .detail-value {
                color: #64748b;
                margin-left: auto;
            }
            
            .actions-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 1.5rem;
                margin-top: 2rem;
            }
            
            .action-card {
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(10px);
                border-radius: 16px;
                padding: 2rem;
                text-align: center;
                box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                transition: all 0.3s ease;
                cursor: pointer;
            }
            
            .action-card:hover {
                transform: translateY(-5px);
                box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.15);
            }
            
            .action-icon {
                font-size: 3rem;
                color: #FFCE36;
                margin-bottom: 1rem;
            }
            
            .action-title {
                font-size: 1.3rem;
                font-weight: 700;
                color: #1A202C;
                margin-bottom: 0.5rem;
            }
            
            .action-description {
                color: #64748b;
                line-height: 1.5;
            }
            
            .status-badge {
                display: inline-block;
                background: #10B981;
                color: white;
                padding: 0.25rem 0.75rem;
                border-radius: 20px;
                font-size: 0.85rem;
                font-weight: 600;
                margin-left: 0.5rem;
            }
        </style>
    </head>
    <body>
        <div class="portal-header">
            <a href="/" class="logo">
                <i class="fas fa-cube"></i> IMANIX
            </a>
            <div class="user-info">
                <span class="user-name">
                    <i class="fas fa-user"></i> 
                    ${customer?.firstName || 'Usuario' || 'Usuario'} ${customer?.lastName || ''}
                </span>
                <button class="logout-btn" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i> Cerrar Sesión
                </button>
            </div>
        </div>
        
        <div class="portal-container">
            <div class="welcome-card">
                <h1 class="welcome-title">
                    ¡Bienvenido al Portal B2B! 
                    <span class="status-badge">
                        <i class="fas fa-check"></i> Autenticado
                    </span>
                </h1>
                <p class="welcome-subtitle">
                    Accede a precios especiales, realiza pedidos y gestiona tu cuenta empresarial.
                </p>
                
                <div class="user-details">
                    <div class="detail-item">
                        <i class="fas fa-envelope detail-icon"></i>
                        <span class="detail-label">Email:</span>
                        <span class="detail-value">${customer?.email || 'no-email@example.com' || 'No disponible'}</span>
                    </div>
                    <div class="detail-item">
                        <i class="fas fa-building detail-icon"></i>
                        <span class="detail-label">Empresa:</span>
                        <span class="detail-value">${customer?.company || 'No especificada'}</span>
                    </div>
                    <div class="detail-item">
                        <i class="fas fa-percent detail-icon"></i>
                        <span class="detail-label">Descuento B2B:</span>
                        <span class="detail-value">${customer?.discount || 0}%</span>
                    </div>
                    <div class="detail-item">
                        <i class="fas fa-tags detail-icon"></i>
                        <span class="detail-label">Categoría:</span>
                        <span class="detail-value">${customer.tags || 'B2B'}</span>
                    </div>
                </div>
            </div>
            
            <div class="actions-grid">
                <div class="action-card" onclick="window.location.href='/'">
                    <i class="fas fa-shopping-cart action-icon"></i>
                    <h3 class="action-title">Catálogo de Productos</h3>
                    <p class="action-description">
                        Explora nuestro catálogo completo con precios especiales B2B
                    </p>
                </div>
                
                <div class="action-card" onclick="showComingSoon()">
                    <i class="fas fa-history action-icon"></i>
                    <h3 class="action-title">Historial de Pedidos</h3>
                    <p class="action-description">
                        Revisa tus pedidos anteriores y realiza seguimiento
                    </p>
                </div>
                
                <div class="action-card" onclick="showComingSoon()">
                    <i class="fas fa-user-cog action-icon"></i>
                    <h3 class="action-title">Mi Perfil</h3>
                    <p class="action-description">
                        Actualiza tu información personal y empresarial
                    </p>
                </div>
                
                <div class="action-card" onclick="showComingSoon()">
                    <i class="fas fa-headset action-icon"></i>
                    <h3 class="action-title">Soporte</h3>
                    <p class="action-description">
                        Contacta con nuestro equipo de atención al cliente
                    </p>
                </div>
            </div>
        </div>
        
        <script>
            function logout() {
                if (confirm('¿Estás seguro que deseas cerrar sesión?')) {
                    fetch('/api/auth/logout', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    })
                    .then(response => response.json())
                    .then(data => {
                        if (data.success) {
                            window.location.href = '/';
                        } else {
                            alert('Error cerrando sesión');
                        }
                    })
                    .catch(error => {
                        console.error('Error:', error);
                        // Force redirect anyway
                        window.location.href = '/';
                    });
                }
            }
            
            function showComingSoon() {
                alert('Esta funcionalidad estará disponible próximamente.');
            }
            
            // Success notification
            setTimeout(() => {
                const notification = document.createElement('div');
                notification.style.cssText = \`
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: #10B981;
                    color: white;
                    padding: 1rem 1.5rem;
                    border-radius: 10px;
                    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
                    z-index: 1000;
                    font-weight: 600;
                    animation: slideIn 0.3s ease;
                \`;
                notification.innerHTML = '<i class="fas fa-check"></i> ¡Bienvenido al Portal B2B!';
                document.body.appendChild(notification);
                
                setTimeout(() => {
                    notification.remove();
                }, 3000);
            }, 500);
        </script>
        
        <style>
            @keyframes slideIn {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        </style>
    </body>
    </html>
  `;
}


// Export handler for Vercel serverless
module.exports = app;

// Also export functions for other modules
module.exports.findCustomerByEmail = findCustomerByEmail;
module.exports.extractB2BDiscount = extractB2BDiscount;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
