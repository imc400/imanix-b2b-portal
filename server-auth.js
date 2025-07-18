const express = require('express');
const fs = require('fs').promises;
const session = require('express-session');
const axios = require('axios');
const database = require('./database');
const multer = require('multer');
require('dotenv').config();

const app = express();
const port = 3000;

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

app.use(express.json());
app.use(express.static('.'));

// Configuración de multer para upload de comprobantes
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB máximo
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
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email es requerido' 
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

    const { profileData } = req.body;
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

// Endpoint para procesar checkout y crear draft order
app.post('/api/checkout', upload.single('comprobante'), async (req, res) => {
  try {
    console.log('🔴🔴🔴 ENDPOINT RAÍZ EJECUTÁNDOSE - /server-auth.js 🔴🔴🔴');
    console.log('🚀 DEBUG ROOT checkout - Starting checkout process');
    console.log('🔍 DEBUG ROOT checkout - req.body type:', typeof req.body);
    console.log('🔍 DEBUG ROOT checkout - req.body keys:', req.body ? Object.keys(req.body) : 'null/undefined');
    
    // Verificar autenticación
    if (!req.session.customer) {
      console.log('❌ DEBUG ROOT checkout - No authenticated user');
      return res.status(401).json({ 
        success: false, 
        message: 'Usuario no autenticado' 
      });
    }

    // Parse cartItems si viene como string JSON (FormData)
    let cartItems;
    try {
      if (req.body.cartItems) {
        cartItems = typeof req.body.cartItems === 'string' 
          ? JSON.parse(req.body.cartItems) 
          : req.body.cartItems;
        console.log('✅ DEBUG ROOT checkout - CartItems parsed successfully, length:', cartItems?.length);
      } else {
        console.log('❌ DEBUG ROOT checkout - No cartItems in req.body');
        cartItems = null;
      }
    } catch (parseError) {
      console.log('❌ DEBUG ROOT checkout - Error parsing cartItems:', parseError.message);
      return res.status(400).json({ 
        success: false, 
        message: 'Error parsing cart items: ' + parseError.message 
      });
    }
    
    if (!cartItems || cartItems.length === 0) {
      console.log('❌ DEBUG ROOT checkout - Cart is empty, cartItems:', cartItems);
      return res.status(400).json({ 
        success: false, 
        message: 'El carrito está vacío' 
      });
    }

    const customer = req.session.customer;
    const discountPercentage = customer.discount || 0;

    // Crear draft order en Shopify
    const draftOrder = await createDraftOrder(customer, cartItems, discountPercentage);
    
    // Log para seguimiento
    console.log(`🎯 Draft Order #${draftOrder.id} creado para cliente B2B: ${customer.email}`);
    console.log(`💰 Total items: ${cartItems.length}, Descuento aplicado: ${discountPercentage}%`);

    res.json({ 
      success: true, 
      message: `¡Pedido enviado exitosamente! Tu solicitud #D${draftOrder.id} está siendo procesada por nuestro equipo.`,
      draftOrderId: draftOrder.id,
      draftOrderNumber: `D${draftOrder.id}`,
      total: draftOrder.total_price,
      discount: draftOrder.total_discounts,
      status: 'pendiente',
      note: 'Tu pedido está siendo revisado por nuestro equipo. Te contactaremos pronto para confirmar los detalles.',
      nextSteps: [
        'Revisaremos tu pedido y disponibilidad de stock',
        'Te contactaremos para confirmar detalles y método de pago',
        'Procesaremos el pedido una vez confirmado',
        'Coordinaremos la entrega según tus preferencias'
      ]
    });

  } catch (error) {
    console.error('Error en checkout:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error procesando el pedido. Inténtalo nuevamente o contacta a soporte.' 
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
        // Usar la función del database manager que es compatible con el perfil
        const orderData = {
            shopify_order_id: draftOrder.id.toString(),
            order_number: `D${draftOrder.id}`, // Draft order con prefijo D
            status: 'pendiente', // Estado para draft orders
            total_amount: parseFloat(draftOrder.total_price || 0),
            discount_amount: parseFloat(draftOrder.total_discounts || 0),
            currency: draftOrder.currency || 'CLP',
            order_date: new Date().toISOString(),
            items: draftOrder.line_items?.map(item => ({
                shopify_product_id: item.product_id?.toString() || null,
                shopify_variant_id: item.variant_id?.toString() || null,
                product_title: item.title || item.name || 'Producto',
                variant_title: item.variant_title || null,
                quantity: item.quantity || 1,
                price: parseFloat(item.price || 0),
                discount_price: null, // Se calcula en el total
                sku: item.sku || null
            })) || []
        };

        const result = await database.addOrder(customer.email, orderData);
        
        if (result) {
            console.log('📝 Draft Order guardado en historial del usuario:', draftOrder.id);
        } else {
            console.log('⚠️ No se pudo guardar en historial (base de datos no disponible)');
        }
    } catch (error) {
        console.error('Error en saveDraftOrderToDatabase:', error);
    }
}

// Función para crear Draft Order en Shopify
async function createDraftOrder(customer, cartItems, discountPercentage) {
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
    let orderNote = `Pedido B2B desde portal - Cliente: ${customer.email} - Descuento: ${discountPercentage}%`;
    
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
            tags: `b2b-portal,descuento-${discountPercentage}${profileData?.profile_completed ? ',perfil-completo' : ',perfil-incompleto'}`,
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

// Performance Optimizer Script
function getPerformanceOptimizationScript() {
  return `
    <script>
      // Optimizador de rendimiento IMANIX B2B - Garantiza fluidez en todos los navegadores
      (function() {
        // CSS de optimización de rendimiento
        const performanceCSS = \`
          <style>
          /* Optimizaciones de rendimiento cross-browser */
          *,*::before,*::after{-webkit-transform:translate3d(0,0,0);transform:translate3d(0,0,0);-webkit-backface-visibility:hidden;backface-visibility:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
          .nav-button,.checkout-btn,.add-to-cart-btn,.product-card,.cart-navbar-btn,.user-account,.login-button,.submit-button,.btn,.btn-primary,.stat-card,.order-card,.address-card,.dropdown-item,.notification,.quantity-btn,.tab-button,.contact-info,.form-input,.form-select{will-change:transform,opacity,box-shadow;-webkit-transform:translate3d(0,0,0);transform:translate3d(0,0,0);contain:layout style paint;transition:transform .3s cubic-bezier(.25,.46,.45,.94),opacity .3s cubic-bezier(.25,.46,.45,.94),box-shadow .3s cubic-bezier(.25,.46,.45,.94)}
          .nav-button:hover,.checkout-btn:hover,.add-to-cart-btn:hover,.cart-navbar-btn:hover,.login-button:hover,.submit-button:hover,.btn:hover,.btn-primary:hover,.user-account:hover,.contact-info:hover{-webkit-transform:translate3d(0,-2px,0) scale3d(1.02,1.02,1);transform:translate3d(0,-2px,0) scale3d(1.02,1.02,1)}
          .product-card:hover,.stat-card:hover,.order-card:hover{-webkit-transform:translate3d(0,-5px,0) scale3d(1.02,1.02,1);transform:translate3d(0,-5px,0) scale3d(1.02,1.02,1)}
          .product-card:hover .product-image img{-webkit-transform:scale3d(1.05,1.05,1);transform:scale3d(1.05,1.05,1)}
          img,.product-image img,.item-image,.brand-logo img{-webkit-transform:translate3d(0,0,0);transform:translate3d(0,0,0);contain:layout style;transition:transform .3s cubic-bezier(.25,.46,.45,.94)}
          .navbar,.login-container,.cart-header,.cart-items,.cart-summary{-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);contain:layout style paint;-webkit-transform:translate3d(0,0,0);transform:translate3d(0,0,0)}
          html{scroll-behavior:smooth}
          @media (max-width:768px){.product-card:hover,.stat-card:hover{-webkit-transform:translate3d(0,-2px,0);transform:translate3d(0,-2px,0)}}
          @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;transition-duration:0.01ms!important}}
          </style>
        \`;
        
        // Inyectar CSS optimizado
        const styleDiv = document.createElement('div');
        styleDiv.innerHTML = performanceCSS;
        document.head.appendChild(styleDiv.firstElementChild);
        
        // Configurar limpieza automática de will-change
        function setupPerformanceOptimizations() {
          const elements = document.querySelectorAll('.nav-button, .btn, .product-card, .stat-card, .cart-navbar-btn');
          
          elements.forEach(element => {
            element.addEventListener('mouseenter', () => {
              element.style.willChange = 'transform, opacity, box-shadow';
            });
            
            element.addEventListener('mouseleave', () => {
              setTimeout(() => {
                if (!element.matches(':hover')) {
                  element.style.willChange = 'auto';
                }
              }, 300);
            });
          });
          
          // Detectar navegador y aplicar optimizaciones específicas
          const isChrome = /Chrome/.test(navigator.userAgent);
          const isFirefox = /Firefox/.test(navigator.userAgent);
          const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
          
          if (isChrome) {
            document.querySelectorAll('.product-card, .stat-card').forEach(el => {
              el.style.contain = 'layout style paint';
            });
          }
          
          if (isSafari) {
            const safariCSS = document.createElement('style');
            safariCSS.textContent = '.product-card:hover{-webkit-transform:translate3d(0,-5px,0) scale3d(1.02,1.02,1)!important}';
            document.head.appendChild(safariCSS);
          }
        }
        
        // Inicializar cuando el DOM esté listo
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', setupPerformanceOptimizations);
        } else {
          setupPerformanceOptimizations();
        }
        
        console.log('🚀 IMANIX Performance Optimizer cargado - Optimizado para todos los navegadores');
      })();
    </script>
  `;
}

// Función para generar HTML del carrito
function getCartHTML(customer) {
  const customerDiscount = customer.discount;
  
  return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Carrito de Compras - Portal B2B IMANIX Chile</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    ${getPerformanceOptimizationScript()}
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
            min-height: 100vh;
            color: #1e293b;
        }

        .navbar {
            background: linear-gradient(135deg, #FFCE36 0%, #FF7B85 100%);
            padding: 1rem 2rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            position: sticky;
            top: 0;
            z-index: 100;
        }

        .navbar-content {
            max-width: 1400px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 1rem;
            color: #000000;
            text-decoration: none;
            font-weight: 800;
            font-size: 1.5rem;
        }

        .brand-logo {
            height: 50px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .brand-logo img {
            height: 45px;
            width: auto;
            filter: drop-shadow(2px 2px 4px rgba(0,0,0,0.2));
        }

                 .nav-actions {
             display: flex;
             align-items: center;
             gap: 1rem;
         }

         .customer-info {
             display: flex;
             align-items: center;
             gap: 0.5rem;
         }

        .nav-button {
            background: rgba(255, 255, 255, 0.2);
            border: none;
            padding: 0.75rem 1.5rem;
            border-radius: 12px;
            color: #000000;
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

        .cart-container {
            max-width: 1200px;
            margin: 2rem auto;
            padding: 0 2rem;
        }

        .cart-header {
            background: white;
            padding: 2rem;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            margin-bottom: 2rem;
        }

        .cart-title {
            font-size: 2rem;
            font-weight: 800;
            color: #1e293b;
            margin-bottom: 0.5rem;
        }

        .cart-subtitle {
            color: #64748b;
            font-size: 1rem;
        }

        .cart-content {
            display: grid;
            grid-template-columns: 1fr 350px;
            gap: 2rem;
        }

        .cart-items {
            background: white;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            padding: 2rem;
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
            color: #1e293b;
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
            background: #FFCE36;
            border: none;
            width: 32px;
            height: 32px;
            border-radius: 8px;
            font-weight: 700;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
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
            color: #1e293b;
        }

        .item-total-breakdown {
            font-size: 0.875rem;
            color: #64748b;
            margin-top: 0.25rem;
        }

        .remove-btn {
            background: #ef4444;
            color: white;
            border: none;
            padding: 0.5rem;
            border-radius: 8px;
            cursor: pointer;
            margin-top: 0.5rem;
        }

        .cart-summary {
            background: white;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            padding: 2rem;
            height: fit-content;
            position: sticky;
            top: 120px;
        }

        .summary-title {
            font-size: 1.5rem;
            font-weight: 800;
            margin-bottom: 1.5rem;
            color: #1e293b;
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
            color: #1e293b;
        }

        .discount-badge {
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.875rem;
            font-weight: 600;
        }

        .checkout-btn {
            width: 100%;
            background: linear-gradient(135deg, #FFCE36, #FF7B85);
            color: #000000;
            border: none;
            padding: 1rem 2rem;
            border-radius: 12px;
            font-size: 1.1rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-top: 1rem;
        }

        .checkout-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(255, 206, 54, 0.4);
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
            color: #1e293b;
            margin-bottom: 0.5rem;
        }

        .empty-cart-subtitle {
            color: #64748b;
            margin-bottom: 2rem;
        }

        .continue-shopping {
            background: linear-gradient(135deg, #FFCE36, #FF7B85);
            color: #000000;
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
    </style>
</head>
<body>
    <nav class="navbar">
        <div class="navbar-content">
            <a href="/" class="brand">
                <div class="brand-logo">
                    <svg width="140" height="45" viewBox="0 0 140 45" fill="none" xmlns="http://www.w3.org/2000/svg" style="height: 35px; width: auto;">
                        <text x="5" y="25" font-family="Arial, sans-serif" font-size="20" font-weight="900" fill="#2D3748">IMANIX</text>
                        <text x="5" y="37" font-family="Arial, sans-serif" font-size="8" fill="#718096">by BrainToys</text>
                        <circle cx="120" cy="18" r="10" fill="#FFCE36"/>
                        <circle cx="120" cy="18" r="6" fill="#2D3748"/>
                        <circle cx="120" cy="18" r="3" fill="#FFCE36"/>
                    </svg>
                </div>
                <span>IMANIX B2B</span>
            </a>
            
            <div class="nav-actions">
                <div class="customer-info">
                    <span style="color: #000000; font-weight: 600;">
                        ${customer.firstName} ${customer.lastName}
                    </span>
                    <div class="discount-badge">-${customerDiscount}%</div>
                </div>
                <button class="nav-button" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i>
                    Cerrar Sesión
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

        // Función para proceder al checkout
        async function proceedToCheckout() {
            if (cart.length === 0) {
                showNotification('Tu carrito está vacío', 'error');
                return;
            }
            
            // Mostrar confirmación antes de enviar
            const confirmMessage = \`¿Confirmas tu pedido de \${cart.length} productos?\n\nTu solicitud será enviada a nuestro equipo para procesamiento.\`;
            if (!confirm(confirmMessage)) {
                return;
            }

            // Mostrar loading
            const checkoutBtn = document.querySelector('.checkout-btn');
            const originalText = checkoutBtn.innerHTML;
            checkoutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...';
            checkoutBtn.disabled = true;

            try {
                const response = await fetch('/api/checkout', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        cartItems: cart.map(item => ({
                            variantId: item.variantId,
                            quantity: item.quantity,
                            price: item.price,
                            title: item.title
                        }))
                    })
                });

                const data = await response.json();

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
                            \${data.nextSteps.map(step => \`<li>\${step}</li>\`).join('')}
                        </ol>
                    </div>
                    
                    <div style="display: flex; gap: 1rem; justify-content: center;">
                        <button onclick="this.parentElement.parentElement.parentElement.remove()" 
                                style="background: #6366f1; color: white; border: none; padding: 0.8rem 2rem; border-radius: 10px; cursor: pointer; font-weight: 600;">
                            Cerrar
                        </button>
                        <button onclick="window.location.href='/perfil'" 
                                style="background: #10b981; color: white; border: none; padding: 0.8rem 2rem; border-radius: 10px; cursor: pointer; font-weight: 600;">
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
            const notification = document.createElement('div');
            notification.style.cssText = \`
                position: fixed;
                top: 140px;
                right: 20px;
                background: \${type === 'success' ? '#10b981' : '#ef4444'};
                color: white;
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

        // Inicializar al cargar la página
        document.addEventListener('DOMContentLoaded', function() {
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
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Portal B2B - Acceso Cliente - IMANIX Chile</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    ${getPerformanceOptimizationScript()}
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #FFCE36 0%, #FF7B85 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #212529;
            padding: 2rem;
        }

        .login-container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            padding: 3rem;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
            max-width: 480px;
            width: 100%;
            text-align: center;
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
            color: #000000;
            margin: 0 auto 1.5rem;
        }

        .login-title {
            font-size: 2rem;
            font-weight: 800;
            color: #000000;
            margin-bottom: 0.5rem;
        }

        .login-subtitle {
            color: #666;
            font-size: 1rem;
            margin-bottom: 2.5rem;
            font-weight: 500;
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
            color: #000000;
            font-size: 0.875rem;
        }

        .form-input {
            width: 100%;
            padding: 1rem 1rem 1rem 3rem;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            font-size: 1rem;
            transition: all 0.3s ease;
            background: white;
        }

        .form-input:focus {
            border-color: #FFCE36;
            outline: none;
            box-shadow: 0 0 0 3px rgba(255, 206, 54, 0.2);
        }

        .form-icon {
            position: absolute;
            left: 1rem;
            top: 2.25rem;
            color: #666;
            font-size: 1.1rem;
        }

        .login-button {
            background: linear-gradient(135deg, #FFCE36, #FFC107);
            color: #000000;
            border: none;
            padding: 1rem 2rem;
            border-radius: 12px;
            font-size: 1rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            min-height: 56px;
        }

        .login-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(255, 206, 54, 0.4);
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

        .info-section {
            margin-top: 2rem;
            padding-top: 2rem;
            border-top: 1px solid #e5e7eb;
            text-align: left;
        }

        .info-title {
            font-size: 1rem;
            font-weight: 700;
            color: #000000;
            margin-bottom: 0.75rem;
        }

        .info-list {
            list-style: none;
            padding: 0;
        }

        .info-list li {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 0.5rem;
            color: #666;
            font-size: 0.875rem;
        }

        .info-list i {
            color: #FFCE36;
            font-size: 0.75rem;
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
            color: white;
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
            color: white;
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
    </style>
</head>
<body>
    <div class="login-container">
                  <div class="brand-logo">
              <svg width="140" height="45" viewBox="0 0 140 45" fill="none" xmlns="http://www.w3.org/2000/svg" style="height: 40px; width: auto;">
                  <text x="5" y="28" font-family="Arial, sans-serif" font-size="22" font-weight="900" fill="#FFFFFF">IMANIX</text>
                  <text x="5" y="40" font-family="Arial, sans-serif" font-size="9" fill="#E2E8F0">by BrainToys</text>
                  <circle cx="120" cy="20" r="10" fill="#FFCE36"/>
                  <circle cx="120" cy="20" r="6" fill="#2D3748"/>
                  <circle cx="120" cy="20" r="3" fill="#FFCE36"/>
              </svg>
          </div>
        <h1 class="login-title">Portal B2B</h1>
                        <p class="login-subtitle">Acceso exclusivo para clientes IMANIX</p>
        
        <form class="login-form" id="loginForm">
            <div class="form-group">
                <label class="form-label" for="email">Email del cliente</label>
                <div style="position: relative;">
                    <i class="fas fa-envelope form-icon"></i>
                    <input 
                        type="email" 
                        id="email" 
                        name="email" 
                        class="form-input"
                        placeholder="tu-email@empresa.com"
                        required
                        autocomplete="email"
                    >
                </div>
            </div>

            <div class="error-message" id="errorMessage"></div>

            <button type="submit" class="login-button" id="loginButton">
                <span class="loading-spinner" id="loadingSpinner"></span>
                <i class="fas fa-sign-in-alt" id="loginIcon"></i>
                <span id="loginText">Acceder al Portal</span>
            </button>
        </form>

        <div class="info-section">
            <h3 class="info-title">Sistema de Descuentos B2B</h3>
            <ul class="info-list">
                <li><i class="fas fa-circle"></i> Clientes con etiqueta "b2b20" → 20% descuento</li>
                <li><i class="fas fa-circle"></i> Clientes con etiqueta "b2b30" → 30% descuento</li>
                <li><i class="fas fa-circle"></i> Clientes con etiqueta "b2b40" → 40% descuento</li>
                <li><i class="fas fa-circle"></i> Gestión desde admin de Shopify</li>
            </ul>
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

        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email').value.trim();
            const errorDiv = document.getElementById('errorMessage');
            const loginButton = document.getElementById('loginButton');
            const loginIcon = document.getElementById('loginIcon');
            const loginText = document.getElementById('loginText');
            const loadingSpinner = document.getElementById('loadingSpinner');
            
            if (!email) {
                showNotification('Por favor ingresa tu email para acceder al portal', 'warning');
                return;
            }

            // Mostrar estado de carga
            loginButton.disabled = true;
            loginIcon.style.display = 'none';
            loadingSpinner.style.display = 'block';
            loginText.textContent = 'Verificando acceso...';
            errorDiv.style.display = 'none';

            try {
                console.log('🔐 Intentando autenticar:', email);
                
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ email })
                });

                const data = await response.json();
                console.log('📝 Respuesta del servidor:', data);

                if (data.success) {
                    console.log('✅ Autenticación exitosa');
                    loginText.textContent = '¡Acceso autorizado!';
                    showNotification('¡Bienvenido al Portal B2B IMANIX! Acceso autorizado exitosamente.', 'success', 2000);
                    setTimeout(() => {
                        // Verificar si necesita completar perfil
                        if (!data.profileCompleted) {
                            window.location.href = '/complete-profile';
                        } else {
                            window.location.reload();
                        }
                    }, 1500);
                } else {
                    console.log('❌ Error de autenticación:', data.message);
                    showNotification(data.message || 'Error de autenticación. Verifica tus credenciales.', 'error');
                    resetButton();
                }
            } catch (error) {
                console.error('💥 Error de conexión:', error);
                showNotification('Error de conexión con el servidor. Por favor, inténtalo nuevamente.', 'error');
                resetButton();
            }
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
    ${getPerformanceOptimizationScript()}
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #FFCE36 0%, #FF7B85 100%);
            min-height: 100vh;
            color: #212529;
            padding: 2rem;
        }

        .profile-container {
            background: rgba(255, 255, 255, 0.95);
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
            color: #000000;
            margin: 0 auto 1.5rem;
        }

        .profile-title {
            font-size: 2.2rem;
            font-weight: 800;
            color: #000000;
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
            color: #000000;
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
            color: #000000;
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
            color: #000000;
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
            color: #1e293b;
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
            color: #000000;
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
            color: white;
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
            color: white;
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

            .notification-container {
                left: 20px;
                right: 20px;
                max-width: none;
            }
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
            <p class="profile-subtitle">¡Bienvenido ${customer.firstName || ''}! Para continuar al portal B2B, necesitamos algunos datos de tu empresa.</p>
            
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
                               placeholder="Tu nombre" required value="${customer.firstName || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="last_name">Apellido <span class="required">*</span></label>
                        <input type="text" id="last_name" name="last_name" class="form-input" 
                               placeholder="Tu apellido" required value="${customer.lastName || ''}">
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
                           value="${customer.email}" readonly style="background: #f3f4f6; cursor: not-allowed;">
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
            
            // Recopilar datos del formulario
            const formData = new FormData(e.target);
            const profileData = {};
            
            for (let [key, value] of formData.entries()) {
                profileData[key] = value.trim();
            }

            // Validación básica
            const requiredFields = ['first_name', 'last_name', 'mobile_phone', 'company_name', 'company_rut', 'company_giro', 'company_address', 'region', 'comuna'];
            const missingFields = requiredFields.filter(field => !profileData[field]);
            
            if (missingFields.length > 0) {
                showNotification('Por favor, completa todos los campos obligatorios marcados con *', 'warning');
                return;
            }

            // Mostrar estado de carga
            submitButton.disabled = true;
            submitIcon.style.display = 'none';
            loadingSpinner.style.display = 'block';
            submitText.textContent = 'Guardando datos...';

            try {
                const response = await fetch('/api/profile/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ profileData })
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
                rut = rut.replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1.');
                
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
            const image = product.images?.edges?.[0]?.node?.url || '/placeholder.jpg';
            const stock = variant?.inventoryQuantity || 0;

            return `
                <div class="product-card">
                    <div class="product-image">
                        <img src="${image}" alt="${product.title}" loading="lazy">
                        <div class="discount-overlay">${discount}% OFF</div>
                        ${stock > 0 ? `<div class="stock-badge">${stock} disponibles</div>` : '<div class="stock-badge out-of-stock">Sin stock</div>'}
                    </div>
                    <div class="product-info">
                        <h3 class="product-title">${product.title}</h3>
                        <div class="product-pricing">
                            <div class="price-row">
                                <span class="original-price">${formatPrice(originalPrice)}</span>
                                <span class="discounted-price">${formatPrice(discountedPrice)}</span>
                            </div>
                            <div class="savings">Ahorras ${formatPrice(savings)}</div>
                        </div>
                        <div class="product-meta">
                            <span class="sku">SKU: ${variant?.sku || 'N/A'}</span>
                            <span class="stock-count">${stock} unidades</span>
                        </div>
                        <button class="add-to-cart-btn" ${stock === 0 ? 'disabled' : ''} 
                                onclick="addToCart('${product.id}', '${variant?.id}', '${product.title}', ${discountedPrice}, '${image}')">
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
    ${getPerformanceOptimizationScript()}
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #FFCE36 0%, #FF7B85 100%);
            min-height: 100vh;
            color: #212529;
            padding-top: 120px;
        }

        .navbar {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            padding: 1rem 0;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            position: sticky;
            top: 0;
            z-index: 1000;
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
            color: #000000;
        }

        .brand-text h1 {
            color: #000000;
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
            color: #000000;
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
            background: linear-gradient(135deg, #FFCE36, #FF7B85);
            color: #000000;
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
            color: #000000;
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
            color: #000000;
        }

        .cart-navbar-badge {
            position: absolute;
            top: -8px;
            right: -8px;
            background: #FF7B85;
            color: white;
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

        .customer-welcome {
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 1.5rem 2rem;
            margin: 2rem auto;
            max-width: 1400px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .welcome-text h2 {
            color: #000000;
            font-size: 1.5rem;
            font-weight: 700;
            margin-bottom: 0.25rem;
        }

        .welcome-text p {
            color: #666;
            font-size: 0.875rem;
        }

        .discount-badge {
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 0.75rem 1.5rem;
            border-radius: 12px;
            font-weight: 700;
            font-size: 1.1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .logout-btn {
            background: rgba(239, 68, 68, 0.1);
            color: #dc2626;
            border: 1px solid rgba(239, 68, 68, 0.2);
            padding: 0.5rem 1rem;
            border-radius: 8px;
            cursor: pointer;
            font-size: 0.875rem;
            transition: all 0.2s ease;
        }

        .logout-btn:hover {
            background: rgba(239, 68, 68, 0.2);
        }

        .content-section {
            max-width: 1400px;
            margin: 0 auto;
            padding: 0 2rem 2rem;
        }

        .stats-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 1.5rem;
            margin-bottom: 3rem;
        }

        .stat-card {
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 2rem;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            display: flex;
            align-items: center;
            gap: 1.5rem;
            transition: all 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 30px 60px rgba(0, 0, 0, 0.15);
        }

        .stat-icon {
            width: 60px;
            height: 60px;
            border-radius: 15px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
        }

        .stat-icon.products {
            background: linear-gradient(135deg, #3b82f6, #1d4ed8);
            color: white;
        }

        .stat-icon.discount {
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
        }

        .stat-icon.access {
            background: linear-gradient(135deg, #f59e0b, #d97706);
            color: white;
        }

        .stat-content h3 {
            font-size: 2rem;
            font-weight: 800;
            color: #000000;
            margin-bottom: 0.25rem;
        }

        .stat-content p {
            color: #666;
            font-weight: 500;
        }

        .catalog-section {
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 2rem;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }

        .catalog-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            padding-bottom: 1rem;
            border-bottom: 2px solid rgba(0, 0, 0, 0.1);
        }

        .catalog-title {
            font-size: 1.75rem;
            font-weight: 800;
            color: #000000;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .catalog-controls {
            display: flex;
            gap: 1rem;
            align-items: center;
        }

        .search-box {
            padding: 0.75rem 1rem;
            border: 2px solid rgba(0, 0, 0, 0.1);
            border-radius: 12px;
            font-size: 0.875rem;
            width: 250px;
            transition: all 0.3s ease;
        }

        .search-box:focus {
            outline: none;
            border-color: #FFCE36;
            box-shadow: 0 0 0 3px rgba(255, 206, 54, 0.2);
        }

        .products-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-top: 2rem;
        }

        .product-card {
            background: white;
            border-radius: 20px;
            padding: 1.5rem;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
            border: 2px solid transparent;
        }

        .product-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
            border-color: #FFCE36;
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
            position: absolute;
            top: 12px;
            left: 12px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
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
            color: white;
        }

        .product-title {
            font-size: 1.1rem;
            font-weight: 700;
            color: #000000;
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
            display: flex;
            align-items: center;
            gap: 0.75rem;
            margin-bottom: 0.5rem;
        }

        .original-price {
            color: #9ca3af;
            text-decoration: line-through;
            font-size: 0.875rem;
        }

        .discounted-price {
            color: #059669;
            font-size: 1.25rem;
            font-weight: 800;
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
            color: #000000;
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

        @media (max-width: 768px) {
            .customer-welcome {
                flex-direction: column;
                gap: 1rem;
                text-align: center;
            }

            .stats-cards {
                grid-template-columns: 1fr;
            }

            .products-grid {
                grid-template-columns: 1fr;
            }

            .catalog-header {
                flex-direction: column;
                gap: 1rem;
                align-items: flex-start;
            }

            .search-box {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="navbar">
        <div class="navbar-content">
            <div class="navbar-brand">
                <div class="brand-logo">
                    <svg width="140" height="45" viewBox="0 0 140 45" fill="none" xmlns="http://www.w3.org/2000/svg" style="height: 45px; width: auto;">
                        <text x="5" y="30" font-family="Arial, sans-serif" font-size="24" font-weight="900" fill="#2D3748">IMANIX</text>
                        <text x="5" y="42" font-family="Arial, sans-serif" font-size="10" fill="#718096">by BrainToys</text>
                        <circle cx="125" cy="22" r="12" fill="#FFCE36"/>
                        <circle cx="125" cy="22" r="8" fill="#2D3748"/>
                        <circle cx="125" cy="22" r="4" fill="#FFCE36"/>
                    </svg>
                </div>
                <div class="brand-text">
                    <h1>Portal B2B - IMANIX</h1>
                    <p>Distribución Profesional</p>
                </div>
            </div>
            <div class="navbar-actions">
                <div class="user-account" onclick="toggleUserDropdown()">
                    <i class="fas fa-user-circle"></i>
                    <span>${customer.firstName} ${customer.lastName || ''}</span>
                    <i class="fas fa-chevron-down" style="font-size: 0.75rem; margin-left: 0.25rem;"></i>
                    
                    <div class="user-dropdown" id="userDropdown">
                        <div class="dropdown-header">
                            <div class="user-name">${customer.firstName} ${customer.lastName || ''}</div>
                            <div class="user-email">${customer.email}</div>
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
                            <a href="/historial" class="dropdown-item">
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

    <div class="customer-welcome">
        <div class="welcome-text">
            <h2>¡Bienvenido/a, ${customer.firstName}!</h2>
            <p>Accede a nuestro catálogo exclusivo con precios preferenciales • Email: ${customer.email}</p>
        </div>
        <div style="display: flex; align-items: center; gap: 1rem;">
            <div class="discount-badge">
                <i class="fas fa-percentage"></i>
                ${customerDiscount}% OFF
            </div>
            <button class="logout-btn" onclick="logout()">
                <i class="fas fa-sign-out-alt"></i> Cerrar Sesión
            </button>
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
                           id="searchInput">
                </div>
            </div>
            
            <div class="products-grid" id="productsGrid">
                ${renderProducts(products, customerDiscount)}
            </div>
        </div>
    </div>

    <script>
        // Carrito de compras
        let cart = JSON.parse(localStorage.getItem('b2bCart')) || [];

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
        
        // Actualizar contador del carrito
        function updateCartBadge() {
            const badge = document.getElementById('cartNavbarBadge');
            const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
            badge.textContent = totalItems;
        }

        // Agregar producto al carrito
        function addToCart(productId, variantId, title, price, image) {
            const existingItem = cart.find(item => item.productId === productId && item.variantId === variantId);
            
            if (existingItem) {
                existingItem.quantity += 1;
            } else {
                cart.push({
                    productId,
                    variantId,
                    title,
                    price,
                    image,
                    quantity: 1
                });
            }
            
            localStorage.setItem('b2bCart', JSON.stringify(cart));
            updateCartBadge();
            
            // Mostrar confirmación
            showNotification(\`\${title} agregado al carrito\`, 'success');
        }


        // Toggle del dropdown del usuario
        function toggleUserDropdown() {
            const dropdown = document.getElementById('userDropdown');
            dropdown.classList.toggle('show');
        }

        // Cerrar dropdown al hacer clic fuera
        document.addEventListener('click', function(event) {
            const userAccount = document.querySelector('.user-account');
            const dropdown = document.getElementById('userDropdown');
            
            if (!userAccount.contains(event.target)) {
                dropdown.classList.remove('show');
            }
        });

        // Mostrar carrito - redirigir a página dedicada
        function showCart() {
            window.location.href = '/carrito';
        }

        // Mostrar notificación
        function showNotification(message, type) {
            // Crear elemento de notificación
            const notification = document.createElement('div');
            notification.style.cssText = \`
                position: fixed;
                top: 140px;
                right: 20px;
                background: \${type === 'success' ? '#10b981' : '#ef4444'};
                color: white;
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
            
            // Animar entrada
            setTimeout(() => {
                notification.style.transform = 'translateX(0)';
            }, 100);
            
            // Remover después de 3 segundos
            setTimeout(() => {
                notification.style.transform = 'translateX(100%)';
                setTimeout(() => {
                    document.body.removeChild(notification);
                }, 300);
            }, 3000);
        }

        // Cerrar sesión
        async function logout() {
            if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
                try {
                    const response = await fetch('/api/auth/logout', {
                        method: 'POST'
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        // Limpiar carrito local
                        localStorage.removeItem('b2bCart');
                        window.location.reload();
                    } else {
                        alert('Error al cerrar sesión');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error de conexión');
                }
            }
        }

        // Función auxiliar para formatear precios
        function formatPrice(price) {
            return new Intl.NumberFormat('es-CL', {
                style: 'currency',
                currency: 'CLP'
            }).format(price);
        }

        // Inicializar al cargar la página
        document.addEventListener('DOMContentLoaded', function() {
            updateCartBadge();
        });
    </script>
</body>
</html>`;
}

// Función para generar HTML del perfil de usuario con formulario editable
function getProfileHTML(customer, profile, addresses, orders, stats) {
  const customerDiscount = customer.discount || 0;
  
  // Datos de regiones y comunas de Chile
  const regionesComunas = {
    "Región de Arica y Parinacota": ["Arica", "Camarones", "Putre", "General Lagos"],
    "Región de Tarapacá": ["Iquique", "Alto Hospicio", "Pozo Almonte", "Camiña", "Colchane", "Huara", "Pica"],
    "Región de Antofagasta": ["Antofagasta", "Mejillones", "Sierra Gorda", "Taltal", "Calama", "Ollagüe", "San Pedro de Atacama", "Tocopilla", "María Elena"],
    "Región de Atacama": ["Copiapó", "Caldera", "Tierra Amarilla", "Chañaral", "Diego de Almagro", "Vallenar", "Alto del Carmen", "Freirina", "Huasco"],
    "Región de Coquimbo": ["La Serena", "Coquimbo", "Andacollo", "La Higuera", "Paiguano", "Vicuña", "Illapel", "Canela", "Los Vilos", "Salamanca", "Ovalle", "Combarbalá", "Monte Patria", "Punitaqui", "Río Hurtado"],
    "Región de Valparaíso": ["Valparaíso", "Casablanca", "Concón", "Juan Fernández", "Puchuncaví", "Quintero", "Viña del Mar", "Isla de Pascua", "Los Andes", "Calle Larga", "Rinconada", "San Esteban", "La Ligua", "Cabildo", "Papudo", "Petorca", "Zapallar", "Quillota", "La Calera", "Hijuelas", "La Cruz", "Nogales", "San Antonio", "Algarrobo", "Cartagena", "El Quisco", "El Tabo", "Santo Domingo", "San Felipe", "Catemu", "Llaillay", "Panquehue", "Putaendo", "Santa María", "Quilpué", "Limache", "Olmué", "Villa Alemana"],
    "Región Metropolitana": ["Cerrillos", "Cerro Navia", "Conchalí", "El Bosque", "Estación Central", "Huechuraba", "Independencia", "La Cisterna", "La Florida", "La Granja", "La Pintana", "La Reina", "Las Condes", "Lo Barnechea", "Lo Espejo", "Lo Prado", "Macul", "Maipú", "Ñuñoa", "Pedro Aguirre Cerda", "Peñalolén", "Providencia", "Pudahuel", "Quilicura", "Quinta Normal", "Recoleta", "Renca", "Santiago", "San Joaquín", "San Miguel", "San Ramón", "Vitacura", "Puente Alto", "Pirque", "San José de Maipo", "Colina", "Lampa", "Tiltil", "San Bernardo", "Buin", "Calera de Tango", "Paine", "Melipilla", "Alhué", "Curacaví", "María Pinto", "San Pedro", "Talagante", "El Monte", "Isla de Maipo", "Padre Hurtado", "Peñaflor"],
    "Región del Libertador Bernardo O'Higgins": ["Rancagua", "Codegua", "Coinco", "Coltauco", "Doñihue", "Graneros", "Las Cabras", "Machalí", "Malloa", "Mostazal", "Olivar", "Peumo", "Pichidegua", "Quinta de Tilcoco", "Rengo", "Requínoa", "San Vicente", "Pichilemu", "La Estrella", "Litueche", "Marchihue", "Navidad", "Paredones", "San Fernando", "Chépica", "Chimbarongo", "Lolol", "Nancagua", "Palmilla", "Peralillo", "Placilla", "Pumanque", "Santa Cruz"],
    "Región del Maule": ["Talca", "Constitución", "Curepto", "Empedrado", "Maule", "Pelarco", "Pencahue", "Río Claro", "San Clemente", "San Rafael", "Cauquenes", "Chanco", "Pelluhue", "Curicó", "Hualañé", "Licantén", "Molina", "Rauco", "Romeral", "Sagrada Familia", "Teno", "Vichuquén", "Linares", "Colbún", "Longaví", "Parral", "Retiro", "San Javier", "Villa Alegre", "Yerbas Buenas"],
    "Región del Ñuble": ["Chillán", "Bulnes", "Cobquecura", "Coelemu", "Coihueco", "Chillán Viejo", "El Carmen", "Ninhue", "Ñiquén", "Pemuco", "Pinto", "Portezuelo", "Quillón", "Quirihue", "Ránquil", "San Carlos", "San Fabián", "San Ignacio", "San Nicolás", "Treguaco", "Yungay"],
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
    ${getPerformanceOptimizationScript()}
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
            min-height: 100vh;
            color: #1e293b;
        }

        .navbar {
            background: linear-gradient(135deg, #FFCE36 0%, #FF7B85 100%);
            padding: 1rem 2rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            position: sticky;
            top: 0;
            z-index: 100;
        }

        .navbar-content {
            max-width: 1400px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 1rem;
            color: #000000;
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
            color: #000000;
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
            max-width: 1200px;
            margin: 2rem auto;
            padding: 0 2rem;
        }

        .profile-header {
            background: white;
            padding: 2rem;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            margin-bottom: 2rem;
        }

        .profile-title {
            font-size: 2rem;
            font-weight: 800;
            color: #1e293b;
            margin-bottom: 0.5rem;
        }

        .profile-subtitle {
            color: #64748b;
            font-size: 1rem;
        }

        .profile-tabs {
            display: flex;
            background: white;
            border-radius: 20px;
            padding: 0.5rem;
            margin-bottom: 2rem;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            overflow-x: auto;
        }

        .tab-button {
            flex: 1;
            padding: 1rem 1.5rem;
            border: none;
            background: none;
            cursor: pointer;
            border-radius: 12px;
            font-weight: 600;
            transition: all 0.3s ease;
            white-space: nowrap;
            color: #64748b;
        }

        .tab-button.active {
            background: linear-gradient(135deg, #FFCE36, #FF7B85);
            color: #000000;
            box-shadow: 0 5px 15px rgba(255, 206, 54, 0.3);
        }

        .tab-button:hover {
            background: rgba(255, 206, 54, 0.1);
            color: #1e293b;
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

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .stat-card {
            background: white;
            border-radius: 20px;
            padding: 1.5rem;
            text-align: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            transition: transform 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-5px);
        }

        .stat-icon {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1rem;
            font-size: 1.5rem;
            color: white;
        }

        .stat-icon.orders { background: linear-gradient(135deg, #3b82f6, #1d4ed8); }
        .stat-icon.spent { background: linear-gradient(135deg, #f59e0b, #d97706); }
        .stat-icon.saved { background: linear-gradient(135deg, #10b981, #059669); }
        .stat-icon.discount { background: linear-gradient(135deg, #FFCE36, #FF7B85); }

        .content-card {
            background: white;
            border-radius: 20px;
            padding: 2rem;
            margin-bottom: 2rem;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }

        .section-title {
            font-size: 1.5rem;
            font-weight: 700;
            margin-bottom: 1.5rem;
            color: #2d3748;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .form-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
        }

        .form-group {
            margin-bottom: 1.5rem;
        }

        .form-label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            color: #4a5568;
        }

        .form-input {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 2px solid #e2e8f0;
            border-radius: 10px;
            font-size: 1rem;
            transition: all 0.3s ease;
        }

        .form-input:focus {
            outline: none;
            border-color: #FFCE36;
            box-shadow: 0 0 0 3px rgba(255, 206, 54, 0.2);
        }

        .btn {
            padding: 0.75rem 1.5rem;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
        }

        .btn-primary {
            background: linear-gradient(135deg, #FFCE36, #FF7B85);
            color: #000000;
        }

        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(255, 206, 54, 0.4);
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
            color: white;
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
    </style>
</head>
<body>
    <nav class="navbar">
        <div class="navbar-content">
            <a href="/" class="brand">
                <div class="brand-logo">
                    <svg width="140" height="45" viewBox="0 0 140 45" fill="none" xmlns="http://www.w3.org/2000/svg" style="height: 35px; width: auto;">
                        <text x="5" y="25" font-family="Arial, sans-serif" font-size="20" font-weight="900" fill="#2D3748">IMANIX</text>
                        <text x="5" y="37" font-family="Arial, sans-serif" font-size="8" fill="#718096">by BrainToys</text>
                        <circle cx="120" cy="18" r="10" fill="#FFCE36"/>
                        <circle cx="120" cy="18" r="6" fill="#2D3748"/>
                        <circle cx="120" cy="18" r="3" fill="#FFCE36"/>
                    </svg>
                </div>
                <span>IMANIX B2B</span>
            </a>
            
            <div class="nav-actions">
                <div class="customer-info">
                    <span style="color: #000000; font-weight: 600;">
                        ${customer.firstName}
                    </span>
                    <div class="discount-badge" style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.875rem; font-weight: 600;">-${customerDiscount}%</div>
                </div>
                <a href="/" class="nav-button">
                    <i class="fas fa-home"></i>
                    Catálogo
                </a>
                <a href="/carrito" class="nav-button">
                    <i class="fas fa-shopping-cart"></i>
                    Carrito
                </a>
                <button class="nav-button" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i>
                    Cerrar Sesión
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
            <p class="profile-subtitle">Bienvenido/a ${customer.firstName} • ${customer.email} • Descuento B2B: ${customerDiscount}%</p>
        </div>

        ${stats ? `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon orders">
                    <i class="fas fa-shopping-bag"></i>
                </div>
                <h3>${stats.totalOrders}</h3>
                <p>Pedidos Realizados</p>
            </div>
            <div class="stat-card">
                <div class="stat-icon spent">
                    <i class="fas fa-dollar-sign"></i>
                </div>
                <h3>$${new Intl.NumberFormat('es-CL').format(stats.totalSpent || 0)}</h3>
                <p>Total Gastado</p>
            </div>
            <div class="stat-card">
                <div class="stat-icon saved">
                    <i class="fas fa-piggy-bank"></i>
                </div>
                <h3>$${new Intl.NumberFormat('es-CL').format(stats.totalSaved || 0)}</h3>
                <p>Total Ahorrado</p>
            </div>
            <div class="stat-card">
                <div class="stat-icon discount">
                    <i class="fas fa-tags"></i>
                </div>
                <h3>${stats.discountPercentage}%</h3>
                <p>Descuento Activo</p>
            </div>
        </div>
        ` : ''}

        <div class="profile-tabs">
            <button class="tab-button active" onclick="switchTab('profile')">
                <i class="fas fa-user"></i>
                Perfil
            </button>
            <button class="tab-button" onclick="switchTab('addresses')">
                <i class="fas fa-map-marker-alt"></i>
                Direcciones
            </button>
            <button class="tab-button" onclick="switchTab('orders')">
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
                        <h3 style="color: #1e293b; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
                            <i class="fas fa-user"></i>
                            Datos Personales
                        </h3>
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label">Email</label>
                                <input type="email" class="form-input" value="${customer.email}" disabled>
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
                        <h3 style="color: #1e293b; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
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
                            <div class="order-card">
                                <div class="order-header">
                                    <div>
                                        <h4>Pedido #${order.order_number || order.id.substring(0, 8)}</h4>
                                        <p style="color: #718096; margin-top: 0.25rem;">
                                            ${new Date(order.order_date).toLocaleDateString('es-CL')}
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
                                
                                ${order.order_items && order.order_items.length > 0 ? `
                                    <div>
                                        <p style="font-weight: 600; margin-bottom: 0.5rem;">Productos:</p>
                                        ${order.order_items.map(item => `
                                            <p style="color: #718096; margin-left: 1rem;">
                                                • ${item.product_title} ${item.variant_title ? `(${item.variant_title})` : ''} 
                                                x${item.quantity}
                                            </p>
                                        `).join('')}
                                    </div>
                                ` : ''}
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
        function switchTab(tabName) {
            // Ocultar todas las tabs
            const tabs = document.querySelectorAll('.tab-content');
            tabs.forEach(tab => tab.classList.remove('active'));
            
            // Mostrar tab seleccionada
            document.getElementById(tabName + '-tab').classList.add('active');
            
            // Actualizar botones
            const buttons = document.querySelectorAll('.tab-button');
            buttons.forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
        }

        async function updateProfile(event) {
            event.preventDefault();
            
            const formData = new FormData(event.target);
            const profileData = Object.fromEntries(formData);
            
            try {
                const response = await fetch('/api/profile/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ profileData })
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
            const regionSelect = document.querySelector('select[name="region"]');
            const comunaSelect = document.getElementById('comunaSelectProfile');
            const currentComuna = '${profile?.comuna || ''}';
            
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
                const response = await fetch(\`/api/addresses/\${addressId}\`, {
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
            notification.style.cssText = \`
                position: fixed;
                top: 140px;
                right: 20px;
                background: \${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
                color: white;
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

// Middleware para verificar autenticación
function requireAuth(req, res, next) {
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
    const profile = await database.getProfile(customer.email);
    const addresses = await database.getUserAddresses(customer.email);
    const orders = await database.getUserOrders(customer.email, 10);
    const stats = await database.getStats(customer.email);
    
    const html = getProfileHTML(customer, profile, addresses, orders, stats);
    res.send(html);
  } catch (error) {
    console.error('Error cargando perfil:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// API - Obtener perfil
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const customer = req.session.customer;
    const profile = await database.getProfile(customer.email);
    const stats = await database.getStats(customer.email);
    
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
app.put('/api/profile', requireAuth, async (req, res) => {
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
    
    const profile = await database.updateProfile(customer.email, filteredUpdates);
    
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
app.get('/api/addresses', requireAuth, async (req, res) => {
  try {
    const customer = req.session.customer;
    const addresses = await database.getUserAddresses(customer.email);
    
    res.json({ success: true, data: addresses });
  } catch (error) {
    console.error('Error obteniendo direcciones:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Agregar dirección
app.post('/api/addresses', requireAuth, async (req, res) => {
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
    
    const address = await database.addAddress(customer.email, addressData);
    
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
app.put('/api/addresses/:id', requireAuth, async (req, res) => {
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
app.delete('/api/addresses/:id', requireAuth, async (req, res) => {
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
app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const customer = req.session.customer;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const orders = await database.getUserOrders(customer.email, limit, offset);
    
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error('Error obteniendo pedidos:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// API - Obtener detalles de un pedido
app.get('/api/orders/:id', requireAuth, async (req, res) => {
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

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Portal B2B con autenticación corriendo en http://localhost:${port}`);
  console.log(`📡 Esperando webhooks de Shopify...`);
  console.log(`🔐 Sistema de autenticación por etiquetas activo`);
}); 