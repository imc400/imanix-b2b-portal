# 🚀 Portal B2B Imanix - BrainToys Chile

Portal B2B profesional para BrainToys Chile con autenticación por etiquetas de Shopify, catálogo exclusivo y sistema completo de perfiles de usuario.

## ✨ Características

### 🔐 Autenticación Inteligente
- Login por email con validación automática en Shopify
- Sistema de descuentos basado en etiquetas B2B (b2b20, b2b30, b2b40)
- Sesiones seguras y persistentes

### 🛍️ Catálogo B2B Exclusivo  
- Productos sincronizados automáticamente desde Shopify
- Precios con descuentos B2B aplicados automáticamente
- Carrito de compras con persistencia local
- Búsqueda en tiempo real

### 👤 Perfil de Usuario Completo
- **Información Personal**: Edición de datos de empresa y contacto
- **Direcciones**: Gestión de direcciones de envío y facturación
- **Historial de Pedidos**: Visualización completa de compras anteriores
- **Estadísticas**: Resumen de gastos, ahorros y descuentos

### 📊 Dashboard Profesional
- Estadísticas de productos disponibles
- Información de descuentos activos
- Interfaz moderna y responsive

### 🔄 Sincronización Automática
- Webhooks de Shopify para actualizaciones en tiempo real
- Base de datos para persistencia de perfiles

## 🗄️ Base de Datos

El sistema utiliza **Supabase** (PostgreSQL) para almacenar:

- **user_profiles**: Perfiles de usuarios B2B
- **user_addresses**: Direcciones de envío y facturación  
- **order_history**: Historial de pedidos
- **order_items**: Productos de cada pedido

## 🚀 Instalación

### 1. Clonar el repositorio
```bash
git clone <tu-repositorio>
cd imanix-b2b
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar Supabase

#### Crear proyecto en Supabase:
1. Ve a [supabase.com](https://supabase.com) y crea una cuenta
2. Crear nuevo proyecto
3. Copia la URL y las claves API

#### Configurar base de datos:
```bash
# Configurar variables de entorno primero (paso 4)
# Luego ejecutar:
npm run setup-db
```

### 4. Configurar variables de entorno

Copia `env.example` a `.env` y completa:

```env
# Shopify API
SHOPIFY_STORE_DOMAIN=tu-tienda.myshopify.com
SHOPIFY_ACCESS_TOKEN=tu_token_aqui

# Webhook Secret
WEBHOOK_SECRET=tu_webhook_secret

# Session Secret
SESSION_SECRET=tu_session_secret_muy_seguro

# Supabase Database
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_ANON_KEY=tu_anon_key_aqui
SUPABASE_SERVICE_KEY=tu_service_key_aqui
```

#### Obtener las claves de Supabase:
1. En tu proyecto de Supabase, ve a `Settings > API`
2. Copia:
   - **URL**: Para `SUPABASE_URL`
   - **anon/public**: Para `SUPABASE_ANON_KEY`  
   - **service_role**: Para `SUPABASE_SERVICE_KEY`

### 5. Configurar Shopify

#### Token de API:
1. Shopify Admin → Apps → Develop apps
2. Crear app privada con permisos:
   - `read_customers`
   - `read_products`

#### Webhooks (opcional):
1. Settings → Notifications → Webhooks
2. Agregar webhook: `https://tu-dominio.com/webhooks/products/update`
3. Evento: `Product update`

### 6. Inicializar base de datos
```bash
npm run setup-db
```

### 7. Sincronizar productos
```bash
npm run sync
```

### 8. Ejecutar el servidor
```bash
# Desarrollo
npm run dev

# Producción  
npm start
```

## 📁 Estructura del Proyecto

```
imanix-b2b/
├── server-auth.js          # Servidor principal con autenticación
├── database.js             # Gestión de base de datos (Supabase)
├── setup-database.js       # Script de configuración de DB
├── sync.js                 # Sincronización de productos
├── package.json            # Dependencias y scripts
├── env.example             # Plantilla de variables de entorno
├── .gitignore             # Archivos ignorados por Git
└── README.md              # Este archivo
```

## 🌐 Deployment en Vercel

### 1. Conectar repositorio
```bash
# Instalar Vercel CLI
npm i -g vercel

# Deploy
vercel
```

### 2. Configurar variables de entorno
En dashboard de Vercel → Settings → Environment Variables, agregar todas las variables del `.env`.

### 3. Configurar dominio personalizado (opcional)
En dashboard de Vercel → Settings → Domains.

## 🔧 API Endpoints

### Autenticación
- `POST /api/auth/login` - Login con email
- `GET /api/auth/me` - Información del usuario actual
- `POST /api/auth/logout` - Cerrar sesión

### Perfil de Usuario
- `GET /api/profile` - Obtener perfil y estadísticas
- `PUT /api/profile` - Actualizar perfil

### Direcciones
- `GET /api/addresses` - Listar direcciones
- `POST /api/addresses` - Agregar dirección
- `PUT /api/addresses/:id` - Actualizar dirección
- `DELETE /api/addresses/:id` - Eliminar dirección

### Pedidos
- `GET /api/orders` - Historial de pedidos
- `GET /api/orders/:id` - Detalles de un pedido

### Páginas Web
- `/` - Portal principal (requiere autenticación)
- `/perfil` - Perfil de usuario
- `/carrito` - Carrito de compras

## 🛠️ Desarrollo

### Scripts disponibles:
```bash
npm start          # Ejecutar servidor
npm run dev        # Modo desarrollo  
npm run sync       # Sincronizar productos de Shopify
npm run setup-db   # Configurar base de datos
```

### Estructura de datos:

#### Cliente B2B (Shopify):
```javascript
{
  email: "cliente@empresa.com",
  tags: "b2b30, premium, cliente-activo"  // b2b30 = 30% descuento
}
```

#### Perfil de Usuario (Supabase):
```javascript
{
  id: "uuid",
  email: "cliente@empresa.com", 
  company_name: "Empresa SpA",
  contact_name: "Juan Pérez",
  phone: "+56912345678",
  discount_percentage: 30,
  discount_tag: "b2b30"
}
```

## 🔐 Seguridad

- Autenticación basada en sesiones
- Validación de acceso B2B por etiquetas de Shopify
- Sanitización de inputs
- Políticas de seguridad de Supabase (RLS)

## 📈 Monitoreo

El sistema incluye logs detallados:
- Autenticaciones exitosas/fallidas
- Webhooks de Shopify recibidos
- Errores de base de datos
- Operaciones de perfil de usuario

## 🤝 Contribuir

1. Fork el proyecto
2. Crear rama feature (`git checkout -b feature/nueva-funcionalidad`)
3. Commit cambios (`git commit -am 'Agregar nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Crear Pull Request

## 📄 Licencia

MIT License - ver archivo LICENSE para detalles.

## 🆘 Soporte

¿Problemas? Revisa estos puntos:

1. **Error de conexión a Supabase**: Verificar variables de entorno
2. **Productos no aparecen**: Ejecutar `npm run sync`
3. **Login falla**: Verificar que el cliente tenga etiqueta B2B en Shopify
4. **Webhooks no funcionan**: Verificar URL y secret del webhook

---

**Desarrollado con ❤️ para BrainToys Chile** 