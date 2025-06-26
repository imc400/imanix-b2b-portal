const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Supabase no configurado. Perfil de usuario deshabilitado.');
}

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

class DatabaseManager {
  
  // ===== GESTIÓN DE PERFILES =====
  
  async createOrUpdateProfile(userData) {
    if (!supabase) return null;
    
    try {
      const profileData = {
        email: userData.email,
        shopify_customer_id: userData.shopify_customer_id || null,
        // Datos personales
        first_name: userData.first_name || null,
        last_name: userData.last_name || null,
        contact_name: userData.contact_name || null,
        mobile_phone: userData.mobile_phone || null,
        // Datos empresariales
        company_name: userData.company_name || null,
        company_rut: userData.company_rut || null,
        company_giro: userData.company_giro || null,
        company_address: userData.company_address || null,
        region: userData.region || null,
        comuna: userData.comuna || null,
        // Sistema B2B
        discount_percentage: userData.discount_percentage || 0,
        discount_tag: userData.discount_tag || null,
        is_active: userData.is_active !== false,
        // Control de perfil
        profile_completed: userData.profile_completed || false
      };

      // Intentar actualizar primero
      const { data, error } = await supabase
        .from('user_profiles')
        .upsert(profileData, { 
          onConflict: 'email',
          returning: 'representation'
        })
        .select()
        .single();

      if (error) {
        console.error('Error creando/actualizando perfil:', error);
        return null;
      }

      return data;
    } catch (err) {
      console.error('Error en createOrUpdateProfile:', err);
      return null;
    }
  }

  async getProfile(email) {
    if (!supabase) return null;
    
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('email', email)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Error obteniendo perfil:', error);
      }

      return data;
    } catch (err) {
      console.error('Error en getProfile:', err);
      return null;
    }
  }

  async updateProfile(email, updates) {
    if (!supabase) return null;
    
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('email', email)
        .select()
        .single();

      if (error) {
        console.error('Error actualizando perfil:', error);
        return null;
      }

      return data;
    } catch (err) {
      console.error('Error en updateProfile:', err);
      return null;
    }
  }

  async updateProfileData(email, profileData) {
    if (!supabase) return null;
    
    try {
      // Verificar si el perfil está completo
      const isComplete = this.isProfileComplete(profileData);
      
      console.log(`🔄 Actualizando perfil para ${email}:`);
      console.log(`   - Datos recibidos:`, Object.keys(profileData));
      console.log(`   - Es completo: ${isComplete}`);
      
      const updateData = {
        ...profileData,
        profile_completed: isComplete,
        updated_at: new Date().toISOString()
      };
      
      console.log(`   - Guardando profile_completed: ${updateData.profile_completed}`);

      const { data, error } = await supabase
        .from('user_profiles')
        .update(updateData)
        .eq('email', email)
        .select()
        .single();

      if (error) {
        console.error('Error actualizando datos del perfil:', error);
        return null;
      }
      
      console.log(`✅ Perfil actualizado. profile_completed en DB: ${data.profile_completed}`);

      return data;
    } catch (err) {
      console.error('Error en updateProfileData:', err);
      return null;
    }
  }

  isProfileComplete(profile) {
    // Campos requeridos para un perfil completo
    const requiredFields = [
      'first_name', 'last_name', 'mobile_phone', 'company_name', 
      'company_rut', 'company_giro', 'company_address', 'region', 'comuna'
    ];
    
    return requiredFields.every(field => 
      profile[field] && profile[field].toString().trim() !== ''
    );
  }

  async checkProfileCompletion(email) {
    if (!supabase) return false;
    
    try {
      const profile = await this.getProfile(email);
      if (!profile) {
        console.log(`🔍 No se encontró perfil para: ${email}`);
        return false;
      }
      
      const isComplete = this.isProfileComplete(profile);
      console.log(`🔍 Verificando perfil de ${email}:`);
      console.log(`   - profile_completed en DB: ${profile.profile_completed}`);
      console.log(`   - isProfileComplete calculado: ${isComplete}`);
      
      // Verificar campos uno por uno para debugging
      const requiredFields = [
        'first_name', 'last_name', 'mobile_phone', 'company_name', 
        'company_rut', 'company_giro', 'company_address', 'region', 'comuna'
      ];
      
      const missingFields = [];
      requiredFields.forEach(field => {
        if (!profile[field] || profile[field].toString().trim() === '') {
          missingFields.push(field);
        }
      });
      
      if (missingFields.length > 0) {
        console.log(`   - Campos faltantes: ${missingFields.join(', ')}`);
      }
      
      return isComplete;
    } catch (err) {
      console.error('Error verificando completitud del perfil:', err);
      return false;
    }
  }

  // ===== GESTIÓN DE DIRECCIONES =====

  async getUserAddresses(userEmail) {
    if (!supabase) return [];
    
    try {
      const profile = await this.getProfile(userEmail);
      if (!profile) return [];

      const { data, error } = await supabase
        .from('user_addresses')
        .select('*')
        .eq('user_id', profile.id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error obteniendo direcciones:', error);
        return [];
      }

      return data || [];
    } catch (err) {
      console.error('Error en getUserAddresses:', err);
      return [];
    }
  }

  async addAddress(userEmail, addressData) {
    if (!supabase) return null;
    
    try {
      const profile = await this.getProfile(userEmail);
      if (!profile) return null;

      // Si es la primera dirección o es marcada como default, desmarcar otras
      if (addressData.is_default) {
        await supabase
          .from('user_addresses')
          .update({ is_default: false })
          .eq('user_id', profile.id)
          .eq('type', addressData.type);
      }

      const { data, error } = await supabase
        .from('user_addresses')
        .insert({
          user_id: profile.id,
          type: addressData.type,
          is_default: addressData.is_default || false,
          company: addressData.company || null,
          first_name: addressData.first_name,
          last_name: addressData.last_name,
          address1: addressData.address1,
          address2: addressData.address2 || null,
          city: addressData.city,
          state: addressData.state || null,
          postal_code: addressData.postal_code,
          country: addressData.country || 'Chile',
          phone: addressData.phone || null
        })
        .select()
        .single();

      if (error) {
        console.error('Error agregando dirección:', error);
        return null;
      }

      return data;
    } catch (err) {
      console.error('Error en addAddress:', err);
      return null;
    }
  }

  async updateAddress(addressId, updates) {
    if (!supabase) return null;
    
    try {
      const { data, error } = await supabase
        .from('user_addresses')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', addressId)
        .select()
        .single();

      if (error) {
        console.error('Error actualizando dirección:', error);
        return null;
      }

      return data;
    } catch (err) {
      console.error('Error en updateAddress:', err);
      return null;
    }
  }

  async deleteAddress(addressId) {
    if (!supabase) return false;
    
    try {
      const { error } = await supabase
        .from('user_addresses')
        .delete()
        .eq('id', addressId);

      if (error) {
        console.error('Error eliminando dirección:', error);
        return false;
      }

      return true;
    } catch (err) {
      console.error('Error en deleteAddress:', err);
      return false;
    }
  }

  // ===== HISTORIAL DE PEDIDOS =====

  async addOrder(userEmail, orderData) {
    if (!supabase) return null;
    
    try {
      const profile = await this.getProfile(userEmail);
      if (!profile) return null;

      const { data: order, error: orderError } = await supabase
        .from('order_history')
        .insert({
          user_id: profile.id,
          shopify_order_id: orderData.shopify_order_id || null,
          order_number: orderData.order_number,
          status: orderData.status,
          total_amount: orderData.total_amount,
          discount_amount: orderData.discount_amount || 0,
          currency: orderData.currency || 'CLP',
          order_date: orderData.order_date
        })
        .select()
        .single();

      if (orderError) {
        console.error('Error agregando pedido:', orderError);
        return null;
      }

      // Agregar items del pedido
      if (orderData.items && orderData.items.length > 0) {
        const items = orderData.items.map(item => ({
          order_id: order.id,
          shopify_product_id: item.shopify_product_id || null,
          shopify_variant_id: item.shopify_variant_id || null,
          product_title: item.product_title,
          variant_title: item.variant_title || null,
          quantity: item.quantity,
          price: item.price,
          discount_price: item.discount_price || null,
          sku: item.sku || null
        }));

        const { error: itemsError } = await supabase
          .from('order_items')
          .insert(items);

        if (itemsError) {
          console.error('Error agregando items del pedido:', itemsError);
        }
      }

      return order;
    } catch (err) {
      console.error('Error en addOrder:', err);
      return null;
    }
  }

  async getUserOrders(userEmail, limit = 20, offset = 0) {
    if (!supabase) return [];
    
    try {
      const profile = await this.getProfile(userEmail);
      if (!profile) return [];

      const { data, error } = await supabase
        .from('order_history')
        .select(`
          *,
          order_items (
            id,
            shopify_product_id,
            shopify_variant_id,
            product_title,
            variant_title,
            quantity,
            price,
            discount_price,
            sku
          )
        `)
        .eq('user_id', profile.id)
        .order('order_date', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        console.error('Error obteniendo historial de pedidos:', error);
        return [];
      }

      return data || [];
    } catch (err) {
      console.error('Error en getUserOrders:', err);
      return [];
    }
  }

  async getOrderDetails(orderId) {
    if (!supabase) return null;
    
    try {
      const { data, error } = await supabase
        .from('order_history')
        .select(`
          *,
          order_items (
            id,
            shopify_product_id,
            shopify_variant_id,
            product_title,
            variant_title,
            quantity,
            price,
            discount_price,
            sku
          )
        `)
        .eq('id', orderId)
        .single();

      if (error) {
        console.error('Error obteniendo detalles del pedido:', error);
        return null;
      }

      return data;
    } catch (err) {
      console.error('Error en getOrderDetails:', err);
      return null;
    }
  }

  // ===== UTILIDADES =====

  async isConnected() {
    if (!supabase) return false;
    
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id')
        .limit(1);

      return !error;
    } catch (err) {
      return false;
    }
  }

  async getStats(userEmail) {
    if (!supabase) return null;
    
    try {
      const profile = await this.getProfile(userEmail);
      if (!profile) return null;

      // Obtener estadísticas del usuario
      const { data: orders } = await supabase
        .from('order_history')
        .select('total_amount, discount_amount, status')
        .eq('user_id', profile.id);

      const totalOrders = orders?.length || 0;
      const totalSpent = orders?.reduce((sum, order) => sum + parseFloat(order.total_amount), 0) || 0;
      const totalSaved = orders?.reduce((sum, order) => sum + parseFloat(order.discount_amount || 0), 0) || 0;

      return {
        totalOrders,
        totalSpent,
        totalSaved,
        discountPercentage: profile.discount_percentage
      };
    } catch (err) {
      console.error('Error obteniendo estadísticas:', err);
      return null;
    }
  }
}

module.exports = new DatabaseManager(); 