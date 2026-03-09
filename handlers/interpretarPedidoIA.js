const https = require('https');

async function interpretarPedidoIA(mensaje, productos) {
  const catalogo = productos.map((p, i) =>
    `${i + 1}. ${p.nombre} — $${(p.precio || p.precio_venta || 0).toLocaleString('es-CO')} — Stock: ${p.stock || 0}`
  ).join('\n');

  const prompt = `Eres el asistente de compras de Flow.AI.

Un cliente escribió: "${mensaje}"

Catálogo:
${catalogo}

Identifica qué productos quiere y en qué cantidad.
- Si escribe números como "1,3" o "2x3" → úsalos directamente
- Si describe con palabras → busca la mejor coincidencia
- Si pide cantidad (ej: "dos", "2") → úsala. Si no, cantidad = 1
- Solo productos con stock > 0

Responde ÚNICAMENTE con JSON válido:
{"items":[{"indice":1,"cantidad":2}],"mensaje":"frase corta de confirmación"}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const text = response.content?.[0]?.text || '{}';
          const clean = text.replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(clean);
          resolve(parsed.items || []);
        } catch (e) {
          console.warn('⚠️ IA parse error:', e.message);
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.write(body);
    req.end();
  });
}

module.exports = { interpretarPedidoIA };
