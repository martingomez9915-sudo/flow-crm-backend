/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║         FLOW — flujoMejoradoConIA.js                                ║
 * ║         Procesamiento inteligente de input del cliente               ║
 * ║                                                                      ║
 * ║  🎯 OBJETIVOS:                                                       ║
 * ║  1. Detectar automáticamente si es lista o búsqueda                 ║
 * ║  2. Extraer ciudad del mensaje si está incluida                     ║
 * ║  3. Corregir tipeos y variaciones de palabras                       ║
 * ║  4. Priorizar productos más relevantes                              ║
 * ║  5. Responder en <2 segundos                                        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic.default();

// ══════════════════════════════════════════════════════════════════════
// 1️⃣  ANALIZAR INPUT DEL CLIENTE CON IA
// ══════════════════════════════════════════════════════════════════════

/**
 * Analiza lo que el cliente escribió y determina:
 * - ¿Es una lista de compras o búsqueda?
 * - ¿Cuál es la ciudad?
 * - ¿Qué productos busca?
 * - ¿Qué tan confiado es el análisis?
 */
async function analizarInputCliente(texto, ciudadActual = null) {
  try {
    const prompt = `Analiza este mensaje del cliente y extrae información de forma PRECISA.

Mensaje: "${texto}"

Responde SOLO en JSON (sin markdown, sin explicaciones) con esta estructura:
{
  "tipo": "lista" | "busqueda" | "otra",
  "productos": ["producto1", "producto2"],
  "ciudad": "ciudad detectada o null",
  "cantidades": {"producto1": cantidad},
  "confianza": 0-100,
  "necesitaClarificacion": true/false,
  "clarificacion": "pregunta si necesita clarificación"
}

REGLAS IMPORTANTES:
1. Si dice "necesito X, Y, Z" → tipo: "lista"
2. Si pregunta por 1 cosa → tipo: "busqueda"
3. Detecta ciudades: Bogotá, Medellín, Cali, etc
4. Correo tipeos: "ibuprofen" → "ibuprofeno"
5. Extrae cantidades si las hay ("2 ibuprofenos" → {"ibuprofeno": 2})
6. Si no está claro, confianza baja y necesitaClarificacion: true

SOLO RESPONDE CON JSON VÁLIDO.`;

    const message = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const respuesta = message.content[0].type === 'text' ? message.content[0].text : '{}';

    // Limpiar markdown si existe
    const jsonLimpio = respuesta
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const analisis = JSON.parse(jsonLimpio);

    console.log(`✅ [IA] Análisis completado:`, {
      tipo: analisis.tipo,
      productos: analisis.productos.length,
      confianza: analisis.confianza,
    });

    return {
      success: true,
      ...analisis,
      ciudadFinal: analisis.ciudad || ciudadActual || 'cali', // Default Cali
    };
  } catch (error) {
    console.error('❌ Error analizando input:', error.message);
    return {
      success: false,
      error: error.message,
      tipo: 'desconocido',
      productos: [],
      confianza: 0,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 2️⃣  MEJORAR BÚSQUEDA DE PRODUCTOS
// ══════════════════════════════════════════════════════════════════════

/**
 * Usa IA para encontrar productos similares y sugerir los mejores matches
 */
async function mejorarBusquedaConIA(productos, allProductos = []) {
  try {
    // Si tenemos menos de 100 productos locales, usar búsqueda simple
    if (allProductos.length < 100) {
      return productos.map(p => ({
        producto: p,
        matches: busquedaLocal(p, allProductos),
      }));
    }

    // Si no, usar IA para analizar patrones
    const prompt = `Mejora estas búsquedas de productos encontrando los MEJORES matches.

Productos buscados:
${productos.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Para CADA producto:
1. Identifica qué categoría es
2. Sugiere variantes comunes (ej: "ibuprofeno" → 400mg, 600mg)
3. Ordena por probabilidad de que sea lo que busca el cliente

Responde SOLO en JSON:
{
  "resultados": [
    {
      "original": "ibuprofeno",
      "categoria": "medicamentos",
      "variantes": ["ibuprofeno 400mg", "ibuprofeno 600mg"],
      "recomendacion": "ibuprofeno 400mg es más común"
    }
  ]
}`;

    const message = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const respuesta = message.content[0].type === 'text' ? message.content[0].text : '{}';
    const jsonLimpio = respuesta
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    return JSON.parse(jsonLimpio);
  } catch (error) {
    console.error('❌ Error mejorando búsqueda:', error.message);
    return { resultados: [] };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3️⃣  BUSQUEDA LOCAL FALLBACK
// ══════════════════════════════════════════════════════════════════════

function busquedaLocal(termino, productos) {
  const termNorm = termino.toLowerCase();
  return productos
    .filter(p => 
      p.nombre?.toLowerCase().includes(termNorm) ||
      p.descripcion?.toLowerCase().includes(termNorm)
    )
    .slice(0, 5);
}

// ══════════════════════════════════════════════════════════════════════
// 4️⃣  GENERAR RESPUESTA OPTIMIZADA
// ══════════════════════════════════════════════════════════════════════

/**
 * Usa IA para generar una respuesta personalizada y contextual
 */
async function generarRespuestaOptimizada(analisis, resultados, clienteNombre = null) {
  try {
    let contexto = `Cliente${clienteNombre ? ': ' + clienteNombre : ''} - Tipo: ${analisis.tipo}`;

    if (analisis.tipo === 'lista') {
      contexto += `\nBuscando ${analisis.productos.length} productos`;
    }

    const prompt = `Genera una respuesta BREVE y OPTIMIZADA para un cliente en un chat de WhatsApp.

CONTEXTO:
${contexto}
Confianza del análisis: ${analisis.confianza}%
${analisis.necesitaClarificacion ? `⚠️  Aclaración: ${analisis.clarificacion}` : ''}

REGLAS:
1. Máximo 3 líneas
2. Usa emojis (pero moderado)
3. Si confianza < 70%, pedir confirmación
4. Si confianza > 85%, ir directo al resultado
5. Sé amable y rápido

Responde en JSON:
{
  "mensaje": "texto de respuesta",
  "proximoPaso": "listar_resultados" | "pedir_confirmacion" | "pedir_clarificacion"
}`;

    const message = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const respuesta = message.content[0].type === 'text' ? message.content[0].text : '{}';
    const jsonLimpio = respuesta
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    return JSON.parse(jsonLimpio);
  } catch (error) {
    console.error('❌ Error generando respuesta:', error.message);
    return {
      mensaje: 'Analizando tu búsqueda...',
      proximoPaso: 'listar_resultados',
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 5️⃣  FLUJO COMPLETO MEJORADO
// ══════════════════════════════════════════════════════════════════════

async function procesarInputMejorado(texto, ciudadActual, clienteNombre = null, allProductos = []) {
  try {
    console.log(`\n🤖 [FLUJO MEJORADO] Procesando: "${texto}"`);

    // PASO 1: Analizar con IA
    const analisis = await analizarInputCliente(texto, ciudadActual);

    if (!analisis.success) {
      return {
        success: false,
        mensaje: '❌ No pude entender tu mensaje. ¿Puedes intentar de nuevo?',
        necesitaClarificacion: true,
      };
    }

    // PASO 2: Si no confía lo suficiente, pedir clarificación
    if (analisis.necesitaClarificacion && analisis.confianza < 70) {
      return {
        success: true,
        tipo: 'clarificacion',
        mensaje: analisis.clarificacion,
        analisisOriginal: analisis,
      };
    }

    // PASO 3: Mejorar búsqueda
    const busquedaMejorada = await mejorarBusquedaConIA(analisis.productos, allProductos);

    // PASO 4: Generar respuesta optimizada
    const respuestaOptimizada = await generarRespuestaOptimizada(
      analisis,
      busquedaMejorada,
      clienteNombre
    );

    return {
      success: true,
      tipo: analisis.tipo,
      productos: analisis.productos,
      cantidades: analisis.cantidades,
      ciudad: analisis.ciudadFinal,
      confianza: analisis.confianza,
      mensaje: respuestaOptimizada.mensaje,
      proximoPaso: respuestaOptimizada.proximoPaso,
      busquedaMejorada,
      analisisCompleto: analisis,
    };
  } catch (error) {
    console.error('❌ Error en flujo mejorado:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════════════════════════════════

module.exports = {
  analizarInputCliente,
  mejorarBusquedaConIA,
  generarRespuestaOptimizada,
  procesarInputMejorado,
};
