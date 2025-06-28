# IMANIX B2B Portal - Contexto Completo de la Aplicación 📋

## 🏗️ ARQUITECTURA GENERAL

### **Plataforma**: Vercel Serverless Functions + Express.js
### **Base de Datos**: Supabase (PostgreSQL)
### **Integración Principal**: Shopify Admin API
### **Autenticación**: Sistema personalizado con Shopify + contraseñas locales

---

## 📁 ESTRUCTURA DE ARCHIVOS

```
imanix-b2b/
├── api/
│   ├── index.js                 # Entry point para Vercel
│   ├── server-auth.js          # Aplicación principal (12,000+ líneas)
│   ├── database.js             # Funciones de Supabase
│   └── session-store.js        # Sistema de sesiones personalizado
├── vercel.json                 # Configuración de deployment
├── package.json               # Dependencies
└── .env                       # Variables de entorno
```

---

## 🔐 SISTEMA DE AUTENTICACIÓN

### **Flujo de Login:**
1. **Email verification** → Busca cliente en Shopify
2. **Password setup** → Primera vez crea contraseña local
3. **Session creation** → Sistema híbrido Supabase + Memory
4. **Portal access** → Redirect directo (sin reload)

### **Estados de Usuario:**
- `authenticated: true/false` - Estado de login
- `profile_completed: true/false` - Perfil empresarial completo
- `customer: {}` - Datos de Shopify + datos locales

### **Rutas Protegidas:**
- `/` - Landing/Login principal
- `/portal` - Portal B2B (requiere auth + profile)
- `/complete-profile` - Formulario empresarial
- `/carrito` - Carrito de compras
- `/mi-cuenta` - Gestión de perfil

---

## 🗄️ BASE DE DATOS SUPABASE

### **Tablas Principales:**

#### `user_profiles`
```sql
- email (PRIMARY KEY)
- first_name, last_name
- company_name, company_rut, company_giro
- company_address, region, comuna
- mobile_phone, phone
- profile_completed (boolean)
- created_at, updated_at
```

#### `user_sessions` (Sistema de sesiones)
```sql
- id (BIGSERIAL PRIMARY KEY)
- session_id (TEXT UNIQUE)
- user_email (TEXT)
- session_data (JSONB)
- expires_at (TIMESTAMP)
- created_at, updated_at
```

#### `user_addresses`
```sql
- id (SERIAL PRIMARY KEY)
- customer_email
- address_line_1, address_line_2
- city, region, postal_code
- is_default (boolean)
- created_at, updated_at
```

#### `draft_orders` (Historial de pedidos)
```sql
- id (SERIAL PRIMARY KEY)
- customer_email
- shopify_order_id, order_number
- total_amount, discount_amount
- status, payment_method
- order_data (JSONB)
- created_at, updated_at
```

---

## 🛍️ INTEGRACIÓN SHOPIFY

### **Configuración:**
- `SHOPIFY_STORE_DOMAIN`: braintoys-chile.myshopify.com
- `SHOPIFY_ADMIN_API_TOKEN`: Token de acceso admin
- **API Version**: 2024-01

### **Funciones Principales:**

#### `findCustomerByEmail(email)`
- Busca cliente en Shopify por email
- Retorna datos completos del cliente

#### `getCustomerTags(customerId)`
- Obtiene tags del cliente (ej: "B2B", "VIP")
- Determina descuentos aplicables

#### `getShopifyProducts()`
- Obtiene catálogo completo de productos
- Incluye precios, inventario, imágenes

#### `createDraftOrder(orderData)`
- Crea borrador de pedido en Shopify
- Aplica descuentos B2B automáticamente

#### `sendOrderNotificationEmail(orderData)`
- Envía notificación por email del pedido
- Incluye detalles completos del pedido

---

## 🔧 SISTEMA DE SESIONES

### **Arquitectura Híbrida:**
- **Memory Store**: Sesiones en memoria (fallback)
- **Supabase Store**: Persistencia en BD (principal)
- **Auto-fallback**: Si Supabase falla, usa memoria

### **Métodos Principales:**

#### `setSession(sessionId, data, maxAge)`
- Guarda sesión en memoria + Supabase
- Expira en 24 horas por defecto

#### `getSession(sessionId)`
- Busca en memoria primero (rápido)
- Fallback a Supabase si no encuentra

#### `destroySession(sessionId)`
- Elimina de memoria + Supabase
- Limpia cookie del browser

### **Middleware Personalizado:**
```javascript
// Intercepts all requests
req.session = {
  sessionId, regenerate(), destroy(), save(),
  customer: {}, authenticated: boolean
}
```

---

## 📧 SISTEMA DE EMAILS

### **Configuración:**
- **Service**: Gmail SMTP
- **Variables**: `EMAIL_USER`, `EMAIL_PASS`

### **Tipos de Email:**
1. **Order Notifications** - Confirmación de pedidos
2. **Welcome Emails** - Nuevos usuarios B2B
3. **Password Setup** - Links de configuración

---

## 🛒 CARRITO Y PEDIDOS

### **Flujo de Compra:**
1. **Agregar productos** → Session storage
2. **Review carrito** → Calcular descuentos B2B
3. **Checkout** → Crear draft order en Shopify
4. **Confirmación** → Email + guardar en historial

### **Descuentos B2B:**
- Basados en tags de Shopify
- Aplicados automáticamente en draft orders
- Mostrados en interfaz de usuario

---

## 🎨 INTERFAZ DE USUARIO

### **Tecnologías:**
- **Frontend**: HTML5 + Vanilla JavaScript
- **Styling**: CSS3 + Bootstrap-like classes
- **Icons**: Font Awesome
- **Notifications**: Sistema custom de notificaciones

### **Páginas Principales:**

#### Landing/Login (`/`)
- Formulario de login con email/password
- Auto-redirect basado en estado de autenticación

#### Portal B2B (`/portal`)
- Dashboard con estadísticas
- Catálogo de productos con precios B2B
- Carrito de compras integrado

#### Complete Profile (`/complete-profile`)
- Formulario empresarial obligatorio
- Validación completa de datos

#### Mi Cuenta (`/mi-cuenta`)
- Gestión de perfil personal
- Historial de pedidos
- Direcciones de envío

---

## 🔍 DEBUGGING Y LOGS

### **Niveles de Log:**
- `🚀` - Request/Response debugging
- `✅` - Success operations  
- `❌` - Errors
- `⚠️` - Warnings
- `📋` - Info/Status

### **Areas de Debugging:**
1. **Session Management** - Logs de creación/recuperación
2. **Shopify API** - Requests y responses
3. **Database Operations** - Queries y errores
4. **Authentication Flow** - Login steps

---

## 🔧 VARIABLES DE ENTORNO

### **Obligatorias:**
```bash
# Shopify
SHOPIFY_STORE_DOMAIN=braintoys-chile.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxx

# Supabase
SUPABASE_URL=https://vmoonybrzxxawxmazdgr.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIs...

# Email
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password

# Sessions
SESSION_SECRET=b2b-portal-secret-key-production-2024
```

### **Opcionales:**
```bash
# Cloudinary (para uploads)
CLOUDINARY_CLOUD_NAME=imanix-b2b
CLOUDINARY_API_KEY=xxxxx
CLOUDINARY_API_SECRET=xxxxx

# Environment
NODE_ENV=production
```

---

## 🚨 TROUBLESHOOTING COMÚN

### **Problem: Session Loop (User can't stay logged in)**
**Cause**: Session middleware not working or table missing
**Fix**: 
1. Check Supabase `user_sessions` table exists
2. Verify environment variables
3. Check session middleware logs

### **Problem: Shopify API errors**
**Cause**: Invalid token or rate limiting
**Fix**:
1. Verify `SHOPIFY_ADMIN_API_TOKEN`
2. Check API version compatibility
3. Implement rate limiting

### **Problem: Email notifications not sending**
**Cause**: Gmail credentials or app passwords
**Fix**:
1. Use app-specific passwords for Gmail
2. Enable 2FA on Gmail account
3. Check `EMAIL_USER` and `EMAIL_PASS`

### **Problem: Database connection errors**
**Cause**: Supabase credentials or network
**Fix**:
1. Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
2. Check Supabase project status
3. Fallback to memory sessions

---

## 🚀 DEPLOYMENT

### **Vercel Configuration:**
```json
{
  "version": 2,
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/index.js" },
    { "source": "/(.*)", "destination": "/api/index.js" }
  ],
  "functions": {
    "api/index.js": { "maxDuration": 30 }
  }
}
```

### **Deploy Commands:**
```bash
git add .
git commit -m "feat: your changes"
git push origin main
# Vercel auto-deploys from GitHub
```

---

## 📊 PERFORMANCE CONSIDERATIONS

### **Session Performance:**
- Memory-first lookup (fastest)
- Supabase fallback (persistent)
- Auto-cleanup of expired sessions

### **Shopify API Optimization:**
- Batch requests when possible
- Cache product data
- Rate limiting compliance

### **Database Optimization:**
- Indexes on session_id, user_email
- Automatic cleanup of expired data
- Connection pooling via Supabase

---

## 🔮 NEXT STEPS / ROADMAP

### **Short Term:**
- [ ] Create Supabase `user_sessions` table manually
- [ ] Test session persistence thoroughly
- [ ] Optimize product catalog loading

### **Medium Term:**
- [ ] Implement Redis for sessions (if needed)
- [ ] Add order status tracking
- [ ] Enhanced B2B pricing tiers

### **Long Term:**
- [ ] Mobile app integration
- [ ] Advanced analytics dashboard
- [ ] Multi-language support

---

**📅 Last Updated**: 2024-12-28  
**📝 Document Version**: 1.0  
**👤 Maintained By**: Claude Code Assistant

---

*Este documento debe ser actualizado cada vez que se hagan cambios significativos a la arquitectura o funcionalidad de la aplicación.*