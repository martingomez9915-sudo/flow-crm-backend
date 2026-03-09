/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   FLOW — compradorHandler.js                                 ║
 * ║   Panel para compradores - Buscar y comprar                ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const db = require('../services/database');
const whatsapp = require('../services/whatsapp');

const sesiones = new Map();
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

const ESTADOS = {
  SELECCIONANDO_CIUDAD: 'SELECCIONANDO_CIUDAD',
  BUSCANDO_PRODUCTO: 'BUSCANDO_PRODUCTO',
};

function getSesion(fromNumber) {
  if (!sesiones.has(fromNumber)) {
    sesiones.set(fromNumber, { estado: ESTADOS.SELECCIONANDO_CIUDAD });
  }
  return sesiones.get(fromNumber);
}

function setSesion(fromNumber, datos) {
  sesiones.set(fromNumber, { ...getSesion(fromNumber), ...datos });
}

function resetSesion(fromNumber) {
  sesiones.set(fromNumber, { estado: ESTADOS.SELECCIONANDO_CIUDAD });
}

const enviar = async (to, msg) => {
  await whatsapp.enviarMensaje(FROM, to, msg);
};

async function handleComprador(fromRaw, body) {
  const fromNumber = fromRaw.replace(/\D/g, '');
  setSesion(fromNumber, { fromRaw });
  const texto = body.trim().toLowerCase();
  const sesion = getSesion(fromNumber);

  console.log(\`🛍️ [COMPRADOR] \${fromNumber} | Estado: \${sesion.estado}\`);

  if (['hola', 'inicio', 'menu', '0'].includes(texto)) {
    resetSesion(fromNumber);
    return mostrarBienvenida(fromNumber, fromRaw);
  }

  switch (sesion.estado) {
    case ESTADOS.SELECCIONANDO_CIUDAD:
      return manejarCiudad(texto, fromNumber, fromRaw);
    
    case ESTADOS.BUSCANDO_PRODUCTO:
      return manejarBusqueda(texto, fromNumber, fromRaw);
    
    default:
      resetSesion(fromNumber);
      return mostrarBienvenida(fromNumber, fromRaw);
  }
}

async function mostrarBienvenida(fromNumber, fromRaw) {
  const mensaje =
    \`🛍️ *BIENVENIDO A FLOW COMPRADOR*\n\n\` +
    \`Encuentra los mejores productos en mayorista\n\n\` +
    \`Para empezar, selecciona tu ciudad:\n\n\` +
    \`1️⃣ Bogotá\n\` +
    \`2️⃣ Medellín\n\` +
    \`3️⃣ Cali\n\n\` +
    \`📌 Presiona el número de tu ciudad.\`;

  setSesion(fromNumber, { estado: ESTADOS.SELECCIONANDO_CIUDAD });
  await enviar(fromRaw, mensaje);
}

async function manejarCiudad(texto, fromNumber, fromRaw) {
  if (!['1', '2', '3'].includes(texto)) {
    return mostrarBienvenida(fromNumber, fromRaw);
  }

  const ciudades = { '1': 'Bogotá', '2': 'Medellín', '3': 'Cali' };
  const ciudad = ciudades[texto];

  setSesion(fromNumber, { 
    estado: ESTADOS.BUSCANDO_PRODUCTO,
    ciudad,
  });

  const mensaje =
    \`✅ \${ciudad} seleccionada.\n\n\` +
    \`🔍 *¿Qué producto buscas?*\n\n\` +
    \`Escribe el nombre del producto\n\` +
    \`(Ej: Crema, Serum, Moda, etc)\n\n\` +
    \`O presiona:\n\` +
    \`0️⃣ Ver todas las categorías\n\` +
    \`menu — Volver al inicio\`;

  await enviar(fromRaw, mensaje);
}

async function manejarBusqueda(texto, fromNumber, fromRaw) {
  const sesion = getSesion(fromNumber);

  if (texto === '0') {
    const mensaje =
      \`📋 *CATEGORÍAS DISPONIBLES*\n\n\` +
      \`1️⃣ Beauty & Belleza\n\` +
      \`2️⃣ Moda & Ropa\n\` +
      \`3️⃣ Calzado\n\` +
      \`4️⃣ Hogar\n\` +
      \`5️⃣ Otros\n\n\` +
      \`0️⃣ Volver\`;
    
    return await enviar(fromRaw, mensaje);
  }

  if (texto.length < 2) {
    return await enviar(fromRaw, 
      \`⚠️ Por favor, escribe al menos 2 caracteres.\n\` +
      \`Ejemplo: "crema", "pantalón", "zapato"\`
    );
  }

  const resultados = await db.buscarProductoGlobal(texto);
  
  if (resultados.length === 0) {
    return await enviar(fromRaw,
      \`❌ No encontramos "\${texto}" en \${sesion.ciudad}\n\n\` +
      \`Intenta con otro término o escribe *menu*\`
    );
  }

  let mensaje = \`🔍 *RESULTADOS PARA: "\${texto.toUpperCase()}"*\n\`;
  mensaje += \`_en \${sesion.ciudad}_\n\`;
  mensaje += \`_\${resultados.length} opción(es) disponible(s)_\n\n\`;

  resultados.slice(0, 3).forEach((p, i) => {
    mensaje += \`\${i + 1}️⃣ *\${p.nombre}*\n\`;
    mensaje += \`   🏪 \${p.tienda || 'Tienda'}\n\`;
    mensaje += \`   💰 \$\${(p.precio || 0).toLocaleString('es-CO')}\n\`;
    mensaje += \`   📦 Stock: \${p.stock || 0} und.\n\n\`;
  });

  mensaje += \`Escribe *menu* para volver\`;
  await enviar(fromRaw, mensaje);
}

module.exports = { handleComprador };
