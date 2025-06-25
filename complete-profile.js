const { createClient } = require('@supabase/supabase-js');

// Configuración de Supabase
const supabaseUrl = 'https://vmoonybrzxxawxmazdgr.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZtb29ueWJyenh4YXd4bWF6ZGdyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDg3ODQxOCwiZXhwIjoyMDY2NDU0NDE4fQ.13fxhmT5czsV0rtqbDnMpIcfLWN-IL5-1g1Qy9Prh1s';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function completeProfile() {
  console.log('📝 Completando perfil de ignacio@intothecom.com...');
  
  try {
    // Datos completos para el perfil
    const completeProfileData = {
      email: 'ignacio@intothecom.com',
      first_name: 'Ignacio',
      last_name: 'Blanco',
      mobile_phone: '9 5016 0966',
      company_name: 'ClickLab SpA',
      company_rut: '77485839-3',
      company_giro: 'Agencia de Marketing y Publicidad',
      company_address: 'Luis Pasteur 6229, depto 44',
      region: 'Región Metropolitana',
      comuna: 'Vitacura',
      profile_completed: true,
      updated_at: new Date().toISOString()
    };
    
    console.log('\n📋 Datos a guardar:', {
      name: `${completeProfileData.first_name} ${completeProfileData.last_name}`,
      mobile: completeProfileData.mobile_phone,
      company: completeProfileData.company_name,
      rut: completeProfileData.company_rut,
      giro: completeProfileData.company_giro,
      address: completeProfileData.company_address,
      region: completeProfileData.region,
      comuna: completeProfileData.comuna,
      completed: completeProfileData.profile_completed
    });
    
    // Actualizar el perfil
    const { data: updatedProfile, error: updateError } = await supabase
      .from('user_profiles')
      .update(completeProfileData)
      .eq('email', 'ignacio@intothecom.com')
      .select()
      .single();
    
    if (updateError) {
      console.error('❌ Error actualizando perfil:', updateError);
      return;
    }
    
    console.log('\n✅ Perfil actualizado exitosamente');
    
    // Verificar que se guardó correctamente
    console.log('\n🔍 Verificando...');
    const { data: verifyProfile, error: verifyError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('email', 'ignacio@intothecom.com')
      .single();
    
    if (verifyError) {
      console.error('❌ Error verificando:', verifyError);
      return;
    }
    
    // Verificar completitud
    const requiredFields = [
      'first_name', 'last_name', 'mobile_phone', 'company_name', 
      'company_rut', 'company_giro', 'company_address', 'region', 'comuna'
    ];
    
    const missingFields = requiredFields.filter(field => 
      !verifyProfile[field] || verifyProfile[field].trim() === ''
    );
    
    console.log('📊 Resultado final:', {
      email: verifyProfile.email,
      campos_completos: `${requiredFields.length - missingFields.length}/${requiredFields.length}`,
      profile_completed: verifyProfile.profile_completed,
      updated_at: verifyProfile.updated_at
    });
    
    if (missingFields.length === 0) {
      console.log('\n🎉 ¡PERFECTO! El perfil está 100% completo.');
      console.log('🚀 Ahora cuando ingreses tu email, te debería reconocer directamente.');
    } else {
      console.log('\n❌ Campos aún faltantes:', missingFields.join(', '));
    }
    
  } catch (error) {
    console.error('💥 Error general:', error);
  }
}

completeProfile(); 