# 🦜 INTEGRACIÓN PARROTFY - Portal B2B IMANIX

**Fecha:** 28 de Agosto, 2025  
**Versión:** v1.0-parrotfy-integration  
**Estado:** ✅ IMPLEMENTADO Y LISTO PARA PRUEBAS

---

## 📋 RESUMEN EJECUTIVO

### **🎯 Objetivo:**
Reemplazar la consulta de stock desde Shopify por la API de Parrotfy para obtener información de inventario en tiempo real del sistema de gestión empresarial.

### **✨ Funcionalidades Implementadas:**
1. **🔗 Conexión API Parrotfy** - Integración completa con sistema de inventario
2. **💾 Sistema de Cache** - Cache inteligente de 5 minutos para optimizar performance  
3. **🛡️ Fallback Robusto** - Uso de Shopify como respaldo si Parrotfy falla
4. **🔧 Endpoints de Administración** - Herramientas para monitoreo y debug
5. **📊 Mapeo por SKU** - Identificación precisa de productos

---

## 🔧 CONFIGURACIÓN TÉCNICA

### **🌐 Variables de Entorno:**
```env
# Parrotfy API Configuration
PARROTFY_API_URL=https://braintoys-spa.parrotfy.com/api/v1
PARROTFY_API_TOKEN=071068a06d09e1fd0f9c3032139c006e0702b78c8a0f0197
PARROTFY_WAREHOUSE_ID=  # Opcional: filtrar por bodega específica
```

### **📡 Endpoint de Parrotfy:**
- **URL:** `GET /api/v1/inventory_movements/stock`
- **Auth:** `Authorization: Token 071068a06d09e1fd0f9c3032139c006e0702b78c8a0f0197`
- **Filtro:** `?warehouse_id=X` (opcional)

### **📊 Estructura de Respuesta:**
```json
[
  {
    "id": 123,
    "code": "IMA-CC2",           // ← SKU del producto
    "name": "Producto IMANIX",
    "current_stock": 50,         // Stock actual
    "reserved_stock": 5,         // Stock reservado
    "available_stock": 45,       // ← Stock disponible (usado)
    "unitary_cost": 10000,
    "pricing_method": "string",
    "unit": "string",
    "min_stock_alert": 10
  }
]
```

---

## 🏗️ ARQUITECTURA DE LA INTEGRACIÓN

### **🔄 Flujo de Stock:**
```
Portal B2B → SKU → Parrotfy Cache → Stock Disponible
     ↓               ↓
 Shopify API    Parrotfy API
     ↑               ↓
  Fallback      5min Cache
```

### **💾 Sistema de Cache:**
- **TTL:** 5 minutos
- **Estrategia:** Lazy loading + background refresh
- **Fallback:** Cache expirado si API falla
- **Invalidación:** Manual via endpoint admin

### **🎯 Lógica de Obtención de Stock:**

#### **1. Renderizado de Productos (Página Principal):**
```javascript
// Función: renderProducts()
if (sku && sku !== 'N/A') {
    parrotfyStock = getStockFromCache(sku);
    if (cache_valid) {
        stock = parrotfyStock.available_stock;
        source = 'parrotfy-cache';
    } else {
        stock = shopify_inventory_quantity;
        source = 'shopify-fallback';
    }
}
```

#### **2. API Endpoint (/api/product/:id/stock):**
```javascript
// Consulta en tiempo real con fallback
sku = getSkuFromShopify(productId);
try {
    parrotfyStock = await getStockBySku(sku);
    stock = parrotfyStock.available_stock;
} catch (error) {
    stock = shopify_inventory_quantity; // Fallback
}
```

---

## 🔧 FUNCIONES PRINCIPALES

### **📦 Funciones de Stock:**

#### **`fetchParrotfyStock(warehouseId?)`**
- Obtiene stock completo desde API de Parrotfy
- Maneja autenticación con token
- Filtra por bodega si se especifica

#### **`getParrotfyStockWithCache()`**
- Gestiona cache con TTL de 5 minutos
- Fallback a cache expirado si API falla
- Actualización automática cuando expira

#### **`getStockBySku(sku)`**
- Consulta asíncrona por SKU específico
- Usa cache para optimizar performance
- Retorna objeto con stock y metadatos

#### **`getStockFromCache(sku)`**
- Consulta síncrona solo desde cache
- Para uso en renderizado sin bloquear UI
- Retorna inmediatamente aunque cache esté vacío

---

## 🔗 ENDPOINTS DE ADMINISTRACIÓN

### **🔄 Refrescar Cache:**
```bash
GET /admin/parrotfy/refresh-cache
```
**Respuesta:**
```json
{
  "success": true,
  "message": "Cache de stock actualizado exitosamente",
  "timestamp": "2025-08-28T10:30:00.000Z",
  "products_count": 156,
  "cache_ttl_minutes": 5
}
```

### **📊 Estado del Cache:**
```bash
GET /admin/parrotfy/cache-status
```
**Respuesta:**
```json
{
  "success": true,
  "cache": {
    "products_count": 156,
    "last_updated": "2025-08-28T10:25:00.000Z",
    "cache_age_minutes": 5,
    "ttl_minutes": 5,
    "is_expired": false,
    "is_empty": false
  },
  "config": {
    "base_url": "https://braintoys-spa.parrotfy.com/api/v1",
    "warehouse_id": "No especificado",
    "token_configured": true
  }
}
```

### **🧪 Probar Conexión:**
```bash
GET /admin/parrotfy/test-connection
```
**Respuesta:**
```json
{
  "success": true,
  "message": "Conexión con Parrotfy exitosa",
  "timestamp": "2025-08-28T10:30:00.000Z",
  "products_count": 156,
  "sample_products": [
    {
      "code": "IMA-CC2",
      "name": "IMANIX Set 2 Carros",
      "available_stock": 24,
      "current_stock": 29
    }
  ]
}
```

---

## 🔄 PROCESO DE INICIALIZACIÓN

### **🚀 Al Cargar el Portal:**
1. **Usuario accede a `/`**
2. **Background:** Inicia precarga de cache Parrotfy
3. **Shopify:** Obtiene productos con SKUs
4. **Renderizado:** Usa cache si está disponible, sino Shopify
5. **Cache:** Se completa en background para próximas consultas

### **⚡ Consultas de Stock:**
1. **Frontend:** Hace fetch a `/api/product/:id/stock`
2. **Backend:** Obtiene SKU desde Shopify
3. **Parrotfy:** Consulta stock por SKU (con cache)
4. **Fallback:** Usa Shopify si Parrotfy falla
5. **Respuesta:** JSON con stock y metadatos

---

## 🛡️ ESTRATEGIAS DE FALLBACK

### **🔧 Niveles de Fallback:**

#### **1. Cache Expirado:**
```javascript
if (cache_expired && api_fails) {
    return expired_cache; // Mejor que nada
}
```

#### **2. SKU No Válido:**
```javascript
if (!sku || sku === 'N/A') {
    return shopify_inventory_quantity;
}
```

#### **3. Producto No Encontrado:**
```javascript
if (!found_in_parrotfy) {
    return shopify_inventory_quantity;
}
```

#### **4. Error de API:**
```javascript
catch (parrotfy_error) {
    console.log('Fallback to Shopify');
    return shopify_inventory_quantity;
}
```

---

## 📊 MEJORAS DE PERFORMANCE

### **⚡ Optimizaciones Implementadas:**

#### **1. Cache Inteligente:**
- **5 minutos TTL** - Balance entre precisión y performance
- **Background refresh** - No bloquea la UI
- **Persistent cache** - Sobrevive entre requests

#### **2. Renderizado Eficiente:**
- **Función síncrona** para renderizado
- **No bloquea** la carga de la página
- **Fallback inmediato** si no hay cache

#### **3. Consultas Optimizadas:**
- **Batch loading** - Una consulta para todo el inventario
- **SKU-based lookup** - O(1) búsqueda en cache
- **Minimal API calls** - Solo cuando es necesario

---

## 🐛 DEBUGGING Y LOGS

### **📋 Logs de Parrotfy:**
```javascript
// Configuración
🦜 Parrotfy configuration:
🔗 Base URL: https://braintoys-spa.parrotfy.com/api/v1
🔑 Token disponible: true

// Stock individual
🦜 Buscando stock para SKU: IMA-CC2
🦜 Stock encontrado para IMA-CC2: 24 unidades (disponibles: 24, actual: 29)

// Renderizado
🎯 Generando botón para: IMANIX Set 2 Carros con SKU: IMA-CC2 Stock: 24 Fuente: parrotfy-cache

// Cache
🦜 Cache de stock inicializado exitosamente
🦜 Usando stock desde cache
```

### **⚠️ Logs de Error:**
```javascript
❌ Error obteniendo stock de Parrotfy para SKU: IMA-CC2 Network timeout
⚠️ Error consultando Parrotfy, usando fallback a Shopify
🦜 No hay cache de stock disponible para SKU: IMA-CC2
```

---

## 🧪 TESTING

### **✅ Casos de Prueba Implementados:**

#### **1. Conexión Exitosa:**
- ✅ API responde correctamente
- ✅ Cache se inicializa
- ✅ Stock se muestra desde Parrotfy

#### **2. Fallback a Shopify:**
- ✅ API de Parrotfy falla
- ✅ Cache vacío o expirado
- ✅ SKU no válido o no encontrado

#### **3. Cache Management:**
- ✅ Cache expira después de 5 minutos
- ✅ Refresh manual funciona
- ✅ Background loading no bloquea

#### **4. Endpoints Administrativos:**
- ✅ `/admin/parrotfy/test-connection`
- ✅ `/admin/parrotfy/cache-status`
- ✅ `/admin/parrotfy/refresh-cache`

---

## 🚀 PRÓXIMOS PASOS PARA DEPLOY

### **📋 Pre-Deploy Checklist:**

#### **1. Variables de Entorno:**
- [ ] Configurar `PARROTFY_API_URL` en producción
- [ ] Configurar `PARROTFY_API_TOKEN` en producción
- [ ] Verificar `PARROTFY_WAREHOUSE_ID` si es necesario

#### **2. Testing en Producción:**
- [ ] Probar endpoint `/admin/parrotfy/test-connection`
- [ ] Verificar cache con `/admin/parrotfy/cache-status`
- [ ] Validar stock de productos conocidos

#### **3. Monitoreo Inicial:**
- [ ] Logs de Parrotfy API calls
- [ ] Performance del cache
- [ ] Frecuencia de fallbacks a Shopify

---

## 💡 RECOMENDACIONES

### **🔧 Configuración Recomendada:**
1. **Warehouse ID:** Especificar si se usa bodega específica
2. **Monitoring:** Configurar alertas por fallos de API
3. **Cache TTL:** Ajustar según frecuencia de cambios de stock

### **📈 Optimizaciones Futuras:**
1. **Webhook Integration:** Recibir updates de stock en tiempo real
2. **Multiple Warehouses:** Soporte para múltiples bodegas
3. **Stock Reservations:** Integrar con sistema de reservas

### **🛡️ Consideraciones de Seguridad:**
1. **Token Rotation:** Renovar token periódicamente
2. **Rate Limiting:** Monitorear límites de API
3. **Error Logging:** No exponer tokens en logs

---

## 🏆 RESULTADOS ESPERADOS

### **✅ Beneficios de la Integración:**
1. **📊 Stock Real:** Información de inventario actualizada desde ERP
2. **⚡ Performance:** Cache optimizado para carga rápida
3. **🛡️ Confiabilidad:** Fallback robusto a Shopify
4. **🔧 Administración:** Herramientas de debug y monitoreo
5. **🔄 Escalabilidad:** Arquitectura preparada para crecimiento

### **📈 Métricas a Monitorear:**
- **API Success Rate:** >95% de llamadas exitosas
- **Cache Hit Rate:** >80% de consultas desde cache
- **Fallback Rate:** <5% de fallbacks a Shopify
- **Response Time:** <200ms para consultas de stock

---

## 🎉 ESTADO ACTUAL

**✅ INTEGRACIÓN COMPLETA Y LISTA PARA PRODUCCIÓN**

La integración de Parrotfy está completamente implementada con:
- 🔗 **API Integration** funcional
- 💾 **Cache System** optimizado  
- 🛡️ **Robust Fallbacks** implementados
- 🔧 **Admin Tools** disponibles
- 📊 **Complete Logging** configurado

**🚀 Ready para deploy y testing en producción!**

---

*Documentado por: Claude Code Assistant*  
*Fecha: 28 de Agosto 2025*  
*Versión: v1.0-parrotfy-integration*  
*Estado: ✅ IMPLEMENTADO*