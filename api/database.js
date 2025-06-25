const { createClient } = require('@supabase/supabase-js');

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

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
        return false;
      }

      // Verificar campos requeridos
      const requiredFields = [
        'first_name', 'last_name', 'company_name', 'company_rut',
        'company_giro', 'company_address', 'region', 'comuna', 'mobile_phone'
      ];

      const completedFields = requiredFields.filter(field => 
        data[field] && data[field].toString().trim().length > 0
      );

      console.log(`🔍 Perfil ${email}: ${completedFields.length}/${requiredFields.length} campos completados`);
      
      return completedFields.length === requiredFields.length;
    } catch (error) {
      console.error('Error verificando perfil:', error);
      return false;
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
      const totalSpent = orders?.reduce((sum, order) => sum + (order.total || 0), 0) || 0;
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
  }
};

module.exports = database; 