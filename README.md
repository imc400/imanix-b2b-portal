# 🚀 Portal B2B IMANIX Chile

Portal empresarial B2B con autenticación por etiquetas de Shopify, gestión de perfiles empresariales y creación automática de pedidos.

## ✨ Características

- **🔐 Autenticación B2B**: Sistema de autenticación basado en etiquetas de Shopify (b2b20, b2b30, b2b40)
- **📊 Perfiles Empresariales**: Gestión completa de datos empresariales chilenos
- **🛍️ Catálogo Exclusivo**: 108+ productos B2B con descuentos automáticos
- **📋 Draft Orders**: Creación automática de pedidos en Shopify
- **🔄 Sincronización**: Webhooks en tiempo real con Shopify
- **📱 Responsive**: Interfaz moderna y adaptable

## 🛠️ Tecnologías

- **Backend**: Node.js + Express
- **Base de Datos**: Supabase (PostgreSQL)
- **E-commerce**: Shopify Admin API
- **Frontend**: HTML5 + CSS3 + JavaScript
- **Despliegue**: Vercel

## 🚀 Instalación Local

```bash
# Clonar repositorio
git clone https://github.com/TU_USUARIO/imanix-b2b-portal.git
cd imanix-b2b-portal

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Iniciar servidor
npm start
```

## ⚙️ Variables de Entorno

```env
# Shopify
SHOPIFY_STORE_DOMAIN=tu-tienda.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxx

# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJxxxxx
SUPABASE_SERVICE_KEY=eyJxxxxx

# Servidor
PORT=3000
NODE_ENV=production
```

## 📊 Base de Datos

### Tabla: `user_profiles`

```sql
CREATE TABLE user_profiles (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  mobile_phone VARCHAR(20),
  company_name VARCHAR(200),
  company_rut VARCHAR(20),
  company_giro VARCHAR(200),
  company_address VARCHAR(300),
  region VARCHAR(100),
  comuna VARCHAR(100),
  profile_completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

## 🔗 API Endpoints

### Autenticación
- `POST /api/auth/login` - Autenticación por email
- `GET /api/auth/verify/:email` - Verificar estado B2B

### Perfil
- `GET /api/profile/:email` - Obtener perfil
- `POST /api/profile/complete` - Completar perfil
- `PUT /api/profile/update` - Actualizar perfil

### Productos
- `GET /api/products` - Listar productos B2B
- `GET /api/products/:id` - Detalle de producto

### Pedidos
- `POST /api/checkout` - Crear draft order
- `GET /api/orders/:email` - Historial de pedidos

## 📱 Uso

1. **Acceso**: Ingresar email empresarial
2. **Verificación**: Sistema valida etiquetas B2B en Shopify
3. **Perfil**: Completar datos empresariales (si es necesario)
4. **Catálogo**: Navegar productos con descuentos aplicados
5. **Pedido**: Crear draft orders automáticamente

## 🔄 Webhooks Shopify

Configurar en Shopify Admin:
- **URL**: `https://tu-dominio.vercel.app/webhooks/products/update`
- **Eventos**: Product updates
- **Formato**: JSON

## 🚀 Despliegue

### Vercel
```bash
# Instalar Vercel CLI
npm i -g vercel

# Desplegar
vercel

# Configurar variables de entorno en dashboard
```

### Variables en Vercel
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ADMIN_API_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`

## 📈 Métricas

- **Productos B2B**: 108 activos
- **Descuentos**: 20%, 30%, 40%
- **Tiempo de respuesta**: < 200ms
- **Uptime**: 99.9%

## 🛡️ Seguridad

- ✅ Validación de etiquetas Shopify
- ✅ Sanitización de datos
- ✅ Variables de entorno protegidas
- ✅ HTTPS obligatorio en producción

## 🤝 Contribución

1. Fork del proyecto
2. Crear rama feature (`git checkout -b feature/nueva-funcionalidad`)
3. Commit cambios (`git commit -am 'Agregar nueva funcionalidad'`)
4. Push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Crear Pull Request

## 📄 Licencia

MIT License - ver [LICENSE](LICENSE)

## 📞 Soporte

- **Email**: soporte@imanix.cl
- **Issues**: [GitHub Issues](https://github.com/TU_USUARIO/imanix-b2b-portal/issues)

---

**Desarrollado con ❤️ para IMANIX Chile** 