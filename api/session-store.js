const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

class SupabaseSessionStore {
  constructor() {
    // Memory fallback for sessions
    this.memoryStore = new Map();
    
    if (!supabaseUrl || !supabaseKey) {
      console.warn('⚠️ Supabase not configured. Using memory-only sessions.');
      this.supabase = null;
    } else {
      this.supabase = createClient(supabaseUrl, supabaseKey);
      console.log('✅ Supabase session store initialized with memory fallback');
    }
  }

  // Check if sessions table exists
  async ensureSessionsTable() {
    if (!this.supabase) return false;
    
    try {
      // Test table access
      const { data, error } = await this.supabase
        .from('user_sessions')
        .select('id')
        .limit(1);
        
      if (error && error.code === 'PGRST116') {
        console.log('📋 Sessions table does not exist - create it manually in Supabase');
        return false;
      }
      
      if (error) {
        console.error('❌ Error accessing sessions table:', error);
        return false;
      }
      
      console.log('✅ Sessions table is accessible');
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
    const expiresAt = new Date(Date.now() + maxAge);
    
    // Always save to memory first
    this.memoryStore.set(sessionId, {
      data: JSON.stringify(data),
      expiresAt: expiresAt,
      userEmail: data.customer?.email || null
    });
    console.log('✅ Session saved to memory:', sessionId);

    // Try to save to Supabase if available
    if (this.supabase) {
      try {
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
          console.error('❌ Error saving session to Supabase (using memory):', error);
        } else {
          console.log('✅ Session also saved to Supabase:', sessionId);
        }
      } catch (error) {
        console.error('❌ Supabase error (using memory fallback):', error);
      }
    }

    return true;
  }

  // Obtener sesión
  async getSession(sessionId) {
    // Check memory first
    const memorySession = this.memoryStore.get(sessionId);
    if (memorySession) {
      if (memorySession.expiresAt > new Date()) {
        console.log('✅ Session retrieved from memory:', sessionId);
        return JSON.parse(memorySession.data);
      } else {
        // Remove expired session from memory
        this.memoryStore.delete(sessionId);
        console.log('🗑️ Expired session removed from memory:', sessionId);
      }
    }

    // Try Supabase if available
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('user_sessions')
          .select('*')
          .eq('session_id', sessionId)
          .gt('expires_at', new Date().toISOString())
          .single();

        if (error || !data) {
          console.log('📭 No valid session found in Supabase for:', sessionId);
          return null;
        }

        console.log('✅ Session retrieved from Supabase:', sessionId);
        // Store in memory for faster next access
        this.memoryStore.set(sessionId, {
          data: data.session_data,
          expiresAt: new Date(data.expires_at),
          userEmail: data.user_email
        });
        return JSON.parse(data.session_data);
      } catch (error) {
        console.error('❌ Error getting session from Supabase:', error);
      }
    }

    console.log('📭 No session found anywhere for:', sessionId);
    return null;
  }

  // Eliminar sesión
  async destroySession(sessionId) {
    // Remove from memory
    this.memoryStore.delete(sessionId);
    console.log('✅ Session destroyed from memory:', sessionId);

    // Remove from Supabase if available
    if (this.supabase) {
      try {
        const { error } = await this.supabase
          .from('user_sessions')
          .delete()
          .eq('session_id', sessionId);

        if (error) {
          console.error('❌ Error destroying session in Supabase:', error);
        } else {
          console.log('✅ Session also destroyed in Supabase:', sessionId);
        }
      } catch (error) {
        console.error('❌ Error in destroySession Supabase:', error);
      }
    }

    return true;
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