const { createClient } = require('@supabase/supabase-js');

// Configuración de Supabase
const supabaseUrl = 'https://vmoonybrzxxawxmazdgr.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZtb29ueWJyenh4YXd4bWF6ZGdyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDg3ODQxOCwiZXhwIjoyMDY2NDU0NDE4fQ.13fxhmT5czsV0rtqbDnMpIcfLWN-IL5-1g1Qy9Prh1s';

async function refreshSupabaseCache() {
    console.log('🔄 Refrescando caché de Supabase...\n');
    
    // Crear nueva instancia con configuración específica para evitar caché
    const supabase = createClient(supabaseUrl, supabaseKey, {
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
    
    try {
        // 1. Verificar estado actual
        console.log('📊 Estado actual del perfil:');
        const { data: currentData, error: currentError } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('email', 'ignacio@intothecom.com')
            .single();
            
        if (currentError) {
            console.log('❌ Error consultando perfil:', currentError);
            return;
        }
        
        console.log('  - Email:', currentData.email);
        console.log('  - Nombre:', currentData.first_name, currentData.last_name);
        console.log('  - Empresa:', currentData.company_name);
        console.log('  - RUT:', currentData.company_rut);
        console.log('  - Dirección:', currentData.company_address);
        console.log('  - Región:', currentData.region);
        console.log('  - Comuna:', currentData.comuna);
        console.log('  - Perfil Completo:', currentData.profile_completed);
        
        // 2. Contar campos completos
        const requiredFields = [
            'first_name', 'last_name', 'mobile_phone', 
            'company_name', 'company_rut', 'company_giro', 
            'company_address', 'region', 'comuna'
        ];
        
        const completedFields = requiredFields.filter(field => 
            currentData[field] && currentData[field].toString().trim() !== ''
        );
        
        console.log('\n📈 Análisis de completitud:');
        console.log(`  - Campos requeridos: ${requiredFields.length}`);
        console.log(`  - Campos completos: ${completedFields.length}`);
        console.log(`  - Porcentaje: ${Math.round((completedFields.length / requiredFields.length) * 100)}%`);
        
        if (completedFields.length === requiredFields.length) {
            console.log('\n✅ EL PERFIL ESTÁ 100% COMPLETO');
            
            // 3. Forzar actualización del flag profile_completed si no está marcado
            if (!currentData.profile_completed) {
                console.log('\n🔧 Actualizando flag profile_completed...');
                const { error: updateError } = await supabase
                    .from('user_profiles')
                    .update({ 
                        profile_completed: true,
                        updated_at: new Date().toISOString()
                    })
                    .eq('email', 'ignacio@intothecom.com');
                    
                if (updateError) {
                    console.log('❌ Error actualizando flag:', updateError);
                } else {
                    console.log('✅ Flag actualizado correctamente');
                }
            }
            
            // 4. Verificación final
            console.log('\n🔍 Verificación final...');
            const { data: finalData } = await supabase
                .from('user_profiles')
                .select('email, profile_completed, updated_at')
                .eq('email', 'ignacio@intothecom.com')
                .single();
                
            console.log('📊 Estado final:');
            console.log('  - Email:', finalData.email);
            console.log('  - Profile Completed:', finalData.profile_completed);
            console.log('  - Última actualización:', finalData.updated_at);
            
            if (finalData.profile_completed) {
                console.log('\n🎉 ¡PERFECTO! Todo está correcto.');
                console.log('🚀 El servidor debería reconocer el perfil completo ahora.');
            } else {
                console.log('\n⚠️ Algo no está funcionando correctamente.');
            }
            
        } else {
            console.log('\n❌ El perfil AÚN está incompleto');
            console.log('📝 Campos faltantes:', 
                requiredFields.filter(field => 
                    !currentData[field] || currentData[field].toString().trim() === ''
                )
            );
        }
        
    } catch (error) {
        console.log('❌ Error en la operación:', error);
    }
}

// Ejecutar
refreshSupabaseCache().then(() => {
    console.log('\n✅ Proceso de refresh completado');
    process.exit(0);
}).catch(error => {
    console.error('❌ Error fatal:', error);
    process.exit(1);
}); 