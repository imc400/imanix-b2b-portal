const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Supabase no configurado. Variables de entorno faltantes.');
}

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const database = {
  // Crear o actualizar perfil de usuario
  async createOrUpdateProfile(profileData) {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .upsert(profileData, { onConflict: 'email' })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error creando/actualizando perfil:', error);
      return null;
    }
  },

  // Verificar si el perfil está completo
  async checkProfileCompletion(email) {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('email', email)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      if (!data) {
        console.log(`❌ No hay perfil para: ${email}`);
        return false;
      }

      // Si el perfil está marcado como completado, verificar que realmente lo esté
      if (data.profile_completed) {
        // Verificar campos requeridos
        const requiredFields = [
          'first_name', 'last_name', 'company_name', 'company_rut',
          'company_giro', 'company_address', 'region', 'comuna', 'mobile_phone'
        ];

        const completedFields = requiredFields.filter(field => 
          data[field] && data[field].toString().trim().length > 0
        );

        const isComplete = completedFields.length === requiredFields.length;
        console.log(`✅ Perfil ${email}: ${completedFields.length}/${requiredFields.length} campos completados - Marcado como completo: ${isComplete}`);
        
        return isComplete;
      }

      console.log(`⏳ Perfil ${email}: no está marcado como completado`);
      return false;
    } catch (error) {
      console.error('Error verificando perfil:', error);
      return false;
    }
  },

  // Actualizar datos del perfil empresarial (función específica para el formulario)
  async updateProfileData(email, profileData) {
    if (!supabase) {
      console.error('❌ Supabase no está inicializado');
      return null;
    }
    
    try {
      // Agregar metadatos de actualización
      const updateData = {
        ...profileData,
        email: email,
        profile_completed: true,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from('user_profiles')
        .upsert(updateData, { onConflict: 'email' })
        .select()
        .single();

      if (error) {
        throw error;
      }

      console.log(`✅ Perfil empresarial actualizado exitosamente para: ${email}`);
      return data;
    } catch (error) {
      console.error('Error actualizando datos del perfil:', error);
      return null;
    }
  },

  // Obtener perfil completo del usuario
  async getProfile(email) {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('email', email)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      return data || {};
    } catch (error) {
      console.error('Error obteniendo perfil:', error);
      return {};
    }
  },

  // Actualizar perfil
  async updateProfile(email, updates) {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .update(updates)
        .eq('email', email)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error actualizando perfil:', error);
      return null;
    }
  },

  // Obtener perfil completo del usuario para la página Mi Cuenta
  async getUserProfile(email) {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('email', email)
        .single();
      
      if (error && error.code !== 'PGRST116') {
        throw error;
      }
      
      return data || {};
    } catch (error) {
      console.error('Error obteniendo perfil de usuario:', error);
      return {};
    }
  },

  // Obtener direcciones del usuario
  async getUserAddresses(email) {
    try {
      const { data, error } = await supabase
        .from('user_addresses')
        .select('*')
        .eq('email', email);
      
      if (error) {
        throw error;
      }
      
      return data || [];
    } catch (error) {
      console.error('Error obteniendo direcciones:', error);
      return [];
    }
  },

  // Obtener estadísticas del usuario para dashboard
  async getUserStats(email) {
    try {
      // Obtener pedidos del usuario
      const { data: orders, error: ordersError } = await supabase
        .from('draft_orders')
        .select('*')
        .eq('customer_email', email);
      
      if (ordersError) {
        throw ordersError;
      }
      
      const totalOrders = orders?.length || 0;
      const totalSpent = orders?.reduce((sum, order) => sum + (order.total_amount || 0), 0) || 0;
      const avgOrderValue = totalOrders > 0 ? Math.round(totalSpent / totalOrders) : 0;
      const recentOrders = orders?.slice(-5) || [];
      
      return {
        totalOrders,
        totalSpent,
        avgOrderValue,
        recentOrders
      };
    } catch (error) {
      console.error('Error obteniendo estadísticas de usuario:', error);
      return {
        totalOrders: 0,
        totalSpent: 0,
        avgOrderValue: 0,
        recentOrders: []
      };
    }
  },

  // Obtener pedidos del usuario con paginación
  async getUserOrders(email, limit = 10, offset = 0) {
    try {
      const { data, error } = await supabase
        .from('draft_orders')
        .select('*')
        .eq('customer_email', email)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      
      if (error) {
        throw error;
      }
      
      return data || [];
    } catch (error) {
      console.error('Error obteniendo pedidos del usuario:', error);
      return [];
    }
  },

  // Contar total de pedidos del usuario
  async getUserOrdersCount(email) {
    try {
      const { count, error } = await supabase
        .from('draft_orders')
        .select('*', { count: 'exact', head: true })
        .eq('customer_email', email);
      
      if (error) {
        throw error;
      }
      
      return count || 0;
    } catch (error) {
      console.error('Error contando pedidos del usuario:', error);
      return 0;
    }
  },

  // Obtener detalles de un pedido específico
  async getOrderDetails(orderId) {
    try {
      const { data, error } = await supabase
        .from('draft_orders')
        .select('*')
        .eq('id', orderId)
        .single();
      
      if (error) {
        throw error;
      }
      
      return data || null;
    } catch (error) {
      console.error('Error obteniendo detalles del pedido:', error);
      return null;
    }
  },

  // Agregar dirección
  async addAddress(email, addressData) {
    try {
      const fullAddressData = {
        ...addressData,
        email: email,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from('user_addresses')
        .insert(fullAddressData)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error agregando dirección:', error);
      return null;
    }
  },

  // Actualizar dirección
  async updateAddress(addressId, updates) {
    try {
      const updateData = {
        ...updates,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from('user_addresses')
        .update(updateData)
        .eq('id', addressId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error actualizando dirección:', error);
      return null;
    }
  },

  // Eliminar dirección
  async deleteAddress(addressId) {
    try {
      const { error } = await supabase
        .from('user_addresses')
        .delete()
        .eq('id', addressId);

      if (error) {
        throw error;
      }

      return true;
    } catch (error) {
      console.error('Error eliminando dirección:', error);
      return false;
    }
  },

  // Guardar draft order
  async saveDraftOrder(draftOrderData) {
    try {
      const { data, error } = await supabase
        .from('draft_orders')
        .insert(draftOrderData)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error guardando draft order:', error);
      return null;
    }
  },

  // Agregar pedido al historial del usuario
  async addOrder(email, orderData) {
    try {
      const fullOrderData = {
        ...orderData,
        customer_email: email,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from('draft_orders')
        .insert(fullOrderData)
        .select()
        .single();

      if (error) {
        throw error;
      }

      console.log(`📦 Pedido guardado en historial para: ${email} - ID: ${data.id}`);
      return data;
    } catch (error) {
      console.error('Error agregando pedido al historial:', error);
      return null;
    }
  },

  // Obtener estadísticas generales (función legacy)
  async getStats(email) {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('stats')
        .eq('email', email)
        .single();
      
      if (error && error.code !== 'PGRST116') {
        throw error;
      }
      
      return data?.stats || {};
    } catch (error) {
      console.error('Error obteniendo estadísticas:', error);
      return {};
    }
  },

  // Obtener estadísticas avanzadas del usuario para dashboard B2B profesional
  async getUserStatsAdvanced(email) {
    try {
      // Obtener todos los pedidos del usuario
      const { data: orders, error: ordersError } = await supabase
        .from('draft_orders')
        .select('*')
        .eq('customer_email', email)
        .order('created_at', { ascending: false });
      
      if (ordersError) {
        throw ordersError;
      }
      
      const totalOrders = orders?.length || 0;
      const totalSpent = orders?.reduce((sum, order) => sum + (order.total_amount || 0), 0) || 0;
      const totalSaved = orders?.reduce((sum, order) => sum + (order.discount_amount || 0), 0) || 0;
      
      // Calcular estadísticas avanzadas
      const avgOrderValue = totalOrders > 0 ? Math.round(totalSpent / totalOrders) : 0;
      const lastOrderDate = orders?.length > 0 ? new Date(orders[0].created_at) : null;
      const firstOrderDate = orders?.length > 0 ? new Date(orders[orders.length - 1].created_at) : null;
      
      // Calcular frecuencia de compra (días promedio entre pedidos)
      let avgDaysBetweenOrders = 0;
      if (orders?.length > 1 && firstOrderDate && lastOrderDate) {
        const daysDiff = Math.abs(lastOrderDate - firstOrderDate) / (1000 * 60 * 60 * 24);
        avgDaysBetweenOrders = Math.round(daysDiff / (totalOrders - 1));
      }
      
      // Tendencias de los últimos 3 meses
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      
      const recentOrders = orders?.filter(order => 
        new Date(order.created_at) >= threeMonthsAgo
      ) || [];
      
      const recentSpent = recentOrders.reduce((sum, order) => sum + (order.total_amount || 0), 0);
      const recentSaved = recentOrders.reduce((sum, order) => sum + (order.discount_amount || 0), 0);
      
      // Estado del cliente basado en actividad
      let customerStatus = 'Nuevo';
      if (totalOrders >= 10) customerStatus = 'VIP';
      else if (totalOrders >= 5) customerStatus = 'Frecuente';
      else if (totalOrders >= 2) customerStatus = 'Regular';
      
      // Mes con más compras
      const monthlyStats = {};
      orders?.forEach(order => {
        const month = new Date(order.created_at).toLocaleString('es-ES', { 
          month: 'long', 
          year: 'numeric' 
        });
        monthlyStats[month] = (monthlyStats[month] || 0) + 1;
      });
      
      const topMonth = Object.keys(monthlyStats).reduce((a, b) => 
        monthlyStats[a] > monthlyStats[b] ? a : b, 
        Object.keys(monthlyStats)[0]
      );
      
      return {
        // Básicas
        totalOrders,
        totalSpent,
        totalSaved,
        avgOrderValue,
        
        // Avanzadas
        customerStatus,
        avgDaysBetweenOrders,
        lastOrderDate: lastOrderDate?.toLocaleDateString('es-ES'),
        firstOrderDate: firstOrderDate?.toLocaleDateString('es-ES'),
        
        // Tendencias recientes (3 meses)
        recentOrders: recentOrders.length,
        recentSpent,
        recentSaved,
        
        // Análisis
        topMonth: topMonth || 'Sin datos',
        savingsPercentage: totalSpent > 0 ? Math.round((totalSaved / (totalSpent + totalSaved)) * 100) : 0,
        
        // Para gráficos
        monthlyData: monthlyStats,
        recentOrdersList: recentOrders.slice(0, 5) // Últimos 5 pedidos
      };
    } catch (error) {
      console.error('Error obteniendo estadísticas avanzadas de usuario:', error);
      return {
        totalOrders: 0,
        totalSpent: 0,
        totalSaved: 0,
        avgOrderValue: 0,
        customerStatus: 'Nuevo',
        avgDaysBetweenOrders: 0,
        lastOrderDate: null,
        firstOrderDate: null,
        recentOrders: 0,
        recentSpent: 0,
        recentSaved: 0,
        topMonth: 'Sin datos',
        savingsPercentage: 0,
        monthlyData: {},
        recentOrdersList: []
      };
    }
  }
};

module.exports = database; 