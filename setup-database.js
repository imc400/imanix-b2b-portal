const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: Variables de entorno de Supabase no configuradas');
  console.log('📝 Necesitas configurar en tu archivo .env:');
  console.log('   SUPABASE_URL=https://tu-proyecto.supabase.co');
  console.log('   SUPABASE_SERVICE_KEY=tu_service_key_aqui');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Esquemas SQL para crear las tablas
const createTablesSQL = `
-- Tabla de perfiles de usuarios B2B
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  shopify_customer_id BIGINT,
  company_name VARCHAR(255),
  contact_name VARCHAR(255),
  phone VARCHAR(50),
  discount_percentage INTEGER DEFAULT 0,
  discount_tag VARCHAR(50),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla de direcciones
CREATE TABLE IF NOT EXISTS user_addresses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  type VARCHAR(20) CHECK (type IN ('shipping', 'billing')) NOT NULL,
  is_default BOOLEAN DEFAULT false,
  company VARCHAR(255),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  address1 VARCHAR(255) NOT NULL,
  address2 VARCHAR(255),
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100),
  postal_code VARCHAR(20) NOT NULL,
  country VARCHAR(100) NOT NULL DEFAULT 'Chile',
  phone VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla de historial de pedidos
CREATE TABLE IF NOT EXISTS order_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  shopify_order_id BIGINT,
  order_number VARCHAR(100),
  status VARCHAR(50) NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'CLP',
  order_date TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla de items de pedidos
CREATE TABLE IF NOT EXISTS order_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES order_history(id) ON DELETE CASCADE,
  shopify_product_id BIGINT,
  shopify_variant_id BIGINT,
  product_title VARCHAR(255) NOT NULL,
  variant_title VARCHAR(255),
  quantity INTEGER NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  discount_price DECIMAL(10,2),
  sku VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para mejor rendimiento
CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id ON user_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_order_history_user_id ON order_history(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- Función para actualizar timestamp automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para actualizar timestamps
DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER update_user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_addresses_updated_at ON user_addresses;
CREATE TRIGGER update_user_addresses_updated_at
    BEFORE UPDATE ON user_addresses
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_order_history_updated_at ON order_history;
CREATE TRIGGER update_order_history_updated_at
    BEFORE UPDATE ON order_history
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
`;

async function setupDatabase() {
  try {
    console.log('🚀 Configurando base de datos...');
    
    // Ejecutar el script SQL
    const { error } = await supabase.rpc('exec_sql', { 
      sql: createTablesSQL 
    });

    if (error) {
      console.error('❌ Error ejecutando SQL:', error);
      console.log('\n📝 Ejecuta este SQL manualmente en Supabase Dashboard:');
      console.log(createTablesSQL);
      return;
    }

    console.log('✅ Base de datos configurada exitosamente!');
    console.log('\n📊 Tablas creadas:');
    console.log('   • user_profiles - Perfiles de usuarios B2B');
    console.log('   • user_addresses - Direcciones de envío y facturación');
    console.log('   • order_history - Historial de pedidos');
    console.log('   • order_items - Productos de cada pedido');
    
    console.log('\n🔧 Configuración recomendada en Supabase Dashboard:');
    console.log('   1. Ir a Authentication > Settings');
    console.log('   2. Deshabilitar "Enable email confirmations"');
    console.log('   3. Ir a Database > RLS y configurar políticas si es necesario');

  } catch (err) {
    console.error('❌ Error de conexión:', err.message);
    console.log('\n📝 Verifica que las variables de entorno estén configuradas correctamente');
  }
}

// Función alternativa para crear tablas directamente
async function createTablesDirectly() {
  try {
    console.log('🚀 Creando tablas directamente...');
    
    // Crear tabla de perfiles
    const { error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .limit(1);

    if (profileError && profileError.code === 'PGRST116') {
      console.log('📝 Crea las siguientes tablas en Supabase Dashboard > SQL Editor:');
      console.log('\n' + createTablesSQL);
      return;
    }

    console.log('✅ Tablas verificadas exitosamente!');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

// Ejecutar setup
if (require.main === module) {
  setupDatabase().then(() => {
    console.log('\n🎯 Siguiente paso: Instalar dependencias');
    console.log('   npm install');
    console.log('\n🔑 Configurar variables de entorno en .env');
    console.log('   Copiar de env.example y rellenar con tus datos de Supabase');
  });
}

module.exports = { setupDatabase, createTablesSQL }; 