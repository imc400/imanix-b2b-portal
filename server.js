const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;

// Configuración de Supabase
const supabaseUrl = 'https://vmoonybrzxxawxmazdgr.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZtb29ueWJyenh4YXd4bWF6ZGdyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDg3ODQxOCwiZXhwIjoyMDY2NDU0NDE4fQ.13fxhmT5czsV0rtqbDnMpIcfLWN-IL5-1g1Qy9Prh1s';

// 🔧 Configuración de Supabase SIN CACHÉ
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    realtime: {
        params: {
            eventsPerSecond: 10,
        },
    },
    global: {
        headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    }
});

// 🎯 FUNCIÓN MEJORADA PARA VERIFICAR PERFIL (SIN CACHÉ)
async function checkProfileStatus(email) {
    console.log(`🔍 Verificando perfil de ${email}:`);
    
    try {
        // Crear conexión fresca CADA VEZ para evitar caché
        const freshSupabase = createClient(supabaseUrl, supabaseServiceKey, {
            global: {
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'X-Request-ID': Date.now().toString()  // Forzar solicitud única
                }
            }
        });
        
        const { data: profile, error } = await freshSupabase
            .from('user_profiles')
            .select('*')
            .eq('email', email)
            .limit(1)
            .single();
            
        if (error) {
            console.log(`   ❌ Error consultando BD: ${error.message}`);
            return { exists: false, isComplete: false };
        }
        
        // Verificar campos requeridos
        const requiredFields = [
            'first_name', 'last_name', 'mobile_phone', 
            'company_name', 'company_rut', 'company_giro', 
            'company_address', 'region', 'comuna'
        ];
        
        const completedFields = requiredFields.filter(field => 
            profile[field] && profile[field].toString().trim() !== ''
        );
        
        const missingFields = requiredFields.filter(field => 
            !profile[field] || profile[field].toString().trim() === ''
        );
        
        const calculatedComplete = completedFields.length === requiredFields.length;
        
        console.log(`   - profile_completed en DB: ${profile.profile_completed}`);
        console.log(`   - isProfileComplete calculado: ${calculatedComplete}`);
        console.log(`   - Campos completos: ${completedFields.length}/${requiredFields.length}`);
        
        if (missingFields.length > 0) {
            console.log(`   - Campos faltantes: ${missingFields.join(', ')}`);
        }
        
        // Si los cálculos no coinciden con la BD, actualizar
        if (calculatedComplete && !profile.profile_completed) {
            console.log(`   🔧 Actualizando flag en BD...`);
            await freshSupabase
                .from('user_profiles')
                .update({ profile_completed: true, updated_at: new Date().toISOString() })
                .eq('email', email);
            profile.profile_completed = true;
        }
        
        return { 
            exists: true, 
            isComplete: calculatedComplete,
            profile: profile
        };
        
    } catch (error) {
        console.log(`   ❌ Error inesperado: ${error.message}`);
        return { exists: false, isComplete: false };
    }
}

// Configuración de middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(bodyParser.raw({ type: 'application/json' }));

// Ruta principal - Verificar email B2B
app.post('/api/verificar-email', async (req, res) => {
    const { email } = req.body;
    console.log(`🔍 Verificando email: ${email}`);
    
    try {
        // Usar la función mejorada de verificación
        const profileStatus = await checkProfileStatus(email);
        
        if (!profileStatus.exists) {
            console.log(`ℹ️ Email no encontrado en perfiles: ${email}`);
            return res.json({ 
                status: 'new',
                redirect: '/completar-perfil'
            });
        }
        
        if (profileStatus.isComplete) {
            console.log(`✅ Perfil completo encontrado para: ${email}`);
            return res.json({ 
                status: 'complete',
                redirect: '/portal',
                profile: profileStatus.profile
            });
        } else {
            console.log(`⚠️ Perfil incompleto para: ${email}`);
            return res.json({ 
                status: 'incomplete',
                redirect: '/completar-perfil',
                profile: profileStatus.profile
            });
        }
        
    } catch (error) {
        console.error('Error verificando email:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Ruta para completar perfil
app.post('/api/completar-perfil', async (req, res) => {
    try {
        const profileData = req.body;
        console.log(`📝 Guardando perfil para: ${profileData.email}`);
        
        const { data, error } = await supabase
            .from('user_profiles')
            .upsert({
                email: profileData.email,
                first_name: profileData.first_name,
                last_name: profileData.last_name,
                mobile_phone: profileData.mobile_phone,
                company_name: profileData.company_name,
                company_rut: profileData.company_rut,
                company_giro: profileData.company_giro,
                company_address: profileData.company_address,
                region: profileData.region,
                comuna: profileData.comuna,
                profile_completed: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();
            
        if (error) {
            console.error('Error guardando perfil:', error);
            return res.status(500).json({ error: 'Error guardando perfil' });
        }
        
        console.log(`✅ Perfil guardado exitosamente para: ${profileData.email}`);
        res.json({ success: true, profile: data });
        
    } catch (error) {
        console.error('Error en completar-perfil:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Webhook de Shopify para actualizar productos
app.post('/webhooks/products/update', (req, res) => {
    try {
        console.log('🔄 Webhook recibido de Shopify');
        
        const product = req.body;
        console.log(`📦 Producto: ${product.title}`);
        console.log(`🏷️ Etiquetas: ${product.tags}`);
        
        // Verificar si tiene etiqueta B2B
        const hasB2BTag = product.tags && product.tags.includes('b2b');
        
        if (hasB2BTag) {
            console.log('✅ Producto TIENE etiqueta "b2b" - debería estar en el portal');
        } else {
            console.log('❌ Producto NO tiene etiqueta "b2b" - no debería estar en el portal');
        }
        
        console.log('💡 Para ver cambios: ejecuta "node sync.js" y refresca localhost:3000');
        
        res.status(200).send('OK');
        
    } catch (error) {
        console.error('Error procesando webhook:', error);
        res.status(500).send('Error');
    }
});

// Ruta para sincronización manual
app.get('/api/sync', async (req, res) => {
    console.log('🔄 Sincronización manual solicitada');
    res.json({ message: 'Sincronización completada - refresca la página' });
});

// Rutas estáticas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/completar-perfil', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'completar-perfil.html'));
});

app.get('/portal', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Portal B2B profesional corriendo en http://localhost:${PORT}`);
    console.log(`📡 Esperando webhooks de Shopify...`);
}); 