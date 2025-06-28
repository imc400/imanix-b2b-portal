const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

class SupabaseSessionStore {
  constructor() {
    if (!supabaseUrl || !supabaseKey) {
      console.warn('⚠️ Supabase not configured. Sessions will fallback to memory.');
      this.supabase = null;
    } else {
      this.supabase = createClient(supabaseUrl, supabaseKey);
      console.log('✅ Supabase session store initialized');
    }
  }

  // Crear tabla de sesiones si no existe
  async ensureSessionsTable() {
    if (!this.supabase) return false;
    
    try {
      // Verificar si la tabla existe
      const { data, error } = await this.supabase
        .from('user_sessions')
        .select('id')
        .limit(1);
        
      if (error && error.code === 'PGRST116') {
        // Tabla no existe, crearla
        console.log('📋 Creating user_sessions table...');
        
        const { error: createError } = await this.supabase.rpc('create_sessions_table', {});
        
        if (createError) {
          console.error('❌ Error creating sessions table:', createError);
          return false;
        }
        
        console.log('✅ Sessions table created successfully');
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error ensuring sessions table:', error);
      return false;
    }
  }

  // Generar ID de sesión único
  generateSessionId() {
    return 'sess_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  // Guardar sesión
  async setSession(sessionId, data, maxAge = 24 * 60 * 60 * 1000) {
    if (!this.supabase) {
      console.log('⚠️ No Supabase - session stored in memory only');
      return true;
    }

    try {
      const expiresAt = new Date(Date.now() + maxAge);
      
      const { error } = await this.supabase
        .from('user_sessions')
        .upsert({
          session_id: sessionId,
          user_email: data.customer?.email || null,
          session_data: JSON.stringify(data),
          expires_at: expiresAt.toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'session_id'
        });

      if (error) {
        console.error('❌ Error saving session:', error);
        return false;
      }

      console.log('✅ Session saved to Supabase:', sessionId);
      return true;
    } catch (error) {
      console.error('❌ Error in setSession:', error);
      return false;
    }
  }

  // Obtener sesión
  async getSession(sessionId) {
    if (!this.supabase) {
      console.log('⚠️ No Supabase - cannot retrieve session');
      return null;
    }

    try {
      const { data, error } = await this.supabase
        .from('user_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (error || !data) {
        console.log('📭 No valid session found for:', sessionId);
        return null;
      }

      console.log('✅ Session retrieved from Supabase:', sessionId);
      return JSON.parse(data.session_data);
    } catch (error) {
      console.error('❌ Error in getSession:', error);
      return null;
    }
  }

  // Eliminar sesión
  async destroySession(sessionId) {
    if (!this.supabase) {
      console.log('⚠️ No Supabase - cannot destroy session');
      return true;
    }

    try {
      const { error } = await this.supabase
        .from('user_sessions')
        .delete()
        .eq('session_id', sessionId);

      if (error) {
        console.error('❌ Error destroying session:', error);
        return false;
      }

      console.log('✅ Session destroyed:', sessionId);
      return true;
    } catch (error) {
      console.error('❌ Error in destroySession:', error);
      return false;
    }
  }

  // Limpiar sesiones expiradas
  async cleanupExpiredSessions() {
    if (!this.supabase) return;

    try {
      const { error } = await this.supabase
        .from('user_sessions')
        .delete()
        .lt('expires_at', new Date().toISOString());

      if (error) {
        console.error('❌ Error cleaning expired sessions:', error);
      } else {
        console.log('✅ Expired sessions cleaned up');
      }
    } catch (error) {
      console.error('❌ Error in cleanupExpiredSessions:', error);
    }
  }

  // Obtener todas las sesiones de un usuario
  async getUserSessions(userEmail) {
    if (!this.supabase) return [];

    try {
      const { data, error } = await this.supabase
        .from('user_sessions')
        .select('session_id, created_at, expires_at')
        .eq('user_email', userEmail)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });

      if (error) {
        console.error('❌ Error getting user sessions:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      console.error('❌ Error in getUserSessions:', error);
      return [];
    }
  }
}

module.exports = SupabaseSessionStore;