const express = require('express');
const fs = require('fs').promises;
const session = require('express-session');
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
  const b2bTag = tagArray.find(tag => tag.startsWith('b2b') && tag.match(/b2b\d+/));
  
  if (b2bTag) {
    const discount = parseInt(b2bTag.replace('b2b', ''));
    return isNaN(discount) ? null : discount;
  }
  
  return null;
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

    console.log(`✅ Cliente B2B autenticado: ${email} - Descuento: ${discount}%`);

    res.json({ 
      success: true, 
      message: 'Autenticación exitosa',
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

// Ruta principal
app.get('/', async (req, res) => {
  try {
    // Verificar si el usuario está autenticado
    if (!req.session.customer) {
      // Mostrar pantalla de login
      return res.send(getLoginHTML());
    }

    const data = await fs.readFile('b2b-products.json', 'utf8');
    const products = JSON.parse(data);
    
    res.send(getPortalHTML(products, req.session.customer));
    
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Función para generar HTML de login
function getLoginHTML() {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Portal B2B - Acceso Cliente - BrainToys Chile</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
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
    </style>
</head>
<body>
    <div class="login-container">
        <div class="brand-logo">IM</div>
        <h1 class="login-title">Portal B2B</h1>
        <p class="login-subtitle">Acceso exclusivo para clientes BrainToys</p>
        
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

    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email').value.trim();
            const errorDiv = document.getElementById('errorMessage');
            const loginButton = document.getElementById('loginButton');
            const loginIcon = document.getElementById('loginIcon');
            const loginText = document.getElementById('loginText');
            const loadingSpinner = document.getElementById('loadingSpinner');
            
            if (!email) {
                showError('Por favor ingresa tu email');
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
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                } else {
                    console.log('❌ Error de autenticación:', data.message);
                    showError(data.message || 'Error de autenticación');
                    resetButton();
                }
            } catch (error) {
                console.error('💥 Error de conexión:', error);
                showError('Error de conexión. Inténtalo nuevamente.');
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
                                onclick="addToCart('${product.id}', '${product.title}', ${discountedPrice}, '${image}')">
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
    <title>Portal B2B Profesional - BrainToys Chile</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
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
                <div class="brand-logo">IM</div>
                <div class="brand-text">
                    <h1>Portal B2B - BrainToys</h1>
                    <p>Distribución Profesional</p>
                </div>
            </div>
            <div class="navbar-actions">
                <div class="user-account" onclick="showUserMenu()">
                    <i class="fas fa-user-circle"></i>
                    <span>${customer.firstName} ${customer.lastName}</span>
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
                    Catálogo B2B Exclusivo
                </h2>
                <div class="catalog-controls">
                    <input type="text" class="search-box" placeholder="Buscar productos..." 
                           id="searchInput" onkeyup="filterProducts()">
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
        
        // Actualizar contador del carrito
        function updateCartBadge() {
            const badge = document.getElementById('cartNavbarBadge');
            const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
            badge.textContent = totalItems;
        }

        // Agregar producto al carrito
        function addToCart(productId, title, price, image) {
            const existingItem = cart.find(item => item.productId === productId);
            
            if (existingItem) {
                existingItem.quantity += 1;
            } else {
                cart.push({
                    productId,
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

        // Filtrar productos
        function filterProducts() {
            const searchTerm = document.getElementById('searchInput').value.toLowerCase();
            const productCards = document.querySelectorAll('.product-card');
            
            productCards.forEach(card => {
                const title = card.querySelector('.product-title').textContent.toLowerCase();
                const sku = card.querySelector('.sku').textContent.toLowerCase();
                
                if (title.includes(searchTerm) || sku.includes(searchTerm)) {
                    card.style.display = 'block';
                } else {
                    card.style.display = 'none';
                }
            });
        }

        // Mostrar información del usuario
        function showUserMenu() {
            const customerInfo = "Información del Cliente:\\n" +
                "• Nombre: ${customer.firstName} ${customer.lastName}\\n" +
                "• Email: ${customer.email}\\n" +
                "• Descuento B2B: ${customerDiscount}%\\n" +
                "• Etiquetas: ${customer.tags}";
            alert(customerInfo);
        }

        // Mostrar carrito
        function showCart() {
            if (cart.length === 0) {
                alert('Tu carrito está vacío');
                return;
            }
            
            let cartHTML = 'Carrito de Compras:\\n\\n';
            let total = 0;
            
            cart.forEach(item => {
                const subtotal = item.price * item.quantity;
                total += subtotal;
                cartHTML += \`\${item.title}\\n\`;
                cartHTML += \`Cantidad: \${item.quantity} x \${formatPrice(item.price)} = \${formatPrice(subtotal)}\\n\\n\`;
            });
            
            cartHTML += \`Total: \${formatPrice(total)}\`;
            alert(cartHTML);
        }

        // Mostrar notificación
        function showNotification(message, type) {
            // Crear elemento de notificación
            const notification = document.createElement('div');
            notification.style.cssText = \`
                position: fixed;
                top: 20px;
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

// Webhooks de Shopify (mantenemos los existentes del server original)
app.post('/webhooks/products/update', express.raw({ type: 'application/json' }), (req, res) => {
  console.log('🔄 Webhook recibido de Shopify');
  
  try {
    const product = JSON.parse(req.body);
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