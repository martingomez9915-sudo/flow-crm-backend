/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   FLOW — vendedorHandler.js                                  ║
 * ║   Panel de control para dueños de tienda                    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const db = require('../services/database');
const whatsapp = require('../services/whatsapp');

const sesiones = new Map();
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

const ESTADOS = {
  MENU_PRINCIPAL: 'MENU_PRINCIPAL',
  VER_VENTAS: 'VER_VENTAS',
  VER_GANANCIAS: 'VER_GANANCIAS',
};

function getSesion(fromNumber) {
  if (!sesiones.has(fromNumber)) {
    sesiones.set(fromNumber, { estado: ESTADOS.MENU_PRINCIPAL });
  }
  return sesiones.get(fromNumber);
}

function setSesion(fromNumber, datos) {
  sesiones.set(fromNumber, { ...getSesion(fromNumber), ...datos });
}

function resetSesion(fromNumber) {
  sesiones.set(fromNumber, { estado: ESTADOS.MENU_PRINCIPAL });
}

const enviar = async (to, msg) => {
  await whatsapp.enviarMensaje(FROM, to, msg);
};

async function handleVendedor(fromRaw, body) {
  const fromNumber = fromRaw.replace(/\D/g, '');
  setSesion(fromNumber, { fromRaw });
  const texto = body.trim().toLowerCase();
  const sesion = getSesion(fromNumber);

  console.log(\`🏪 [VENDEDOR] \${fromNumber} | Estado: \${sesion.estado}\`);

  if (['hola', 'inicio', 'menu', '0'].includes(texto)) {
    resetSesion(fromNumber);
    return mostrarMenuPrincipal(fromNumber, fromRaw);
  }

  switch (sesion.estado) {
    case ESTADOS.MENU_PRINCIPAL:
      return manejarMenuPrincipal(texto, fromNumber, fromRaw);
    
    case ESTADOS.VER_VENTAS:
      return manejarVerVentas(texto, fromNumber, fromRaw);
    
    case ESTADOS.VER_GANANCIAS:
      return manejarVerGanancias(texto, fromNumber, fromRaw);
    
    default:
      resetSesion(fromNumber);
      return mostrarMenuPrincipal(fromNumber, fromRaw);
  }
}

async function mostrarMenuPrincipal(fromNumber, fromRaw) {
  try {
    const tienda = await db.obtenerNegocioCompleto(fromNumber);
    
    const mensaje = 
      \`👋 ¡Hola, *\${tienda.nombre}*!\n\n\` +
      \`Tu vendedor IA está activo 24/7\n\n\` +
      \`¿Qué quieres hacer?\n\n\` +
      \`1️⃣ 📊 Ver mis ventas de hoy\n\` +
      \`2️⃣ 💰 Ver mis ganancias\n\` +
      \`3️⃣ 🛍️ Editar mi catálogo\n\` +
      \`4️⃣ 👥 Ver mis clientes\n\` +
      \`5️⃣ ⚙️ Configuración\n\n\` +
      \`📌 Presiona el número de tu opción.\`;

    setSesion(fromNumber, { estado: ESTADOS.MENU_PRINCIPAL });
    await enviar(fromRaw, mensaje);

  } catch (error) {
    console.error('❌ Error:', error.message);
    await enviar(fromRaw, '❌ Error. Intenta de nuevo escribiendo *menu*');
  }
}

async function manejarMenuPrincipal(texto, fromNumber, fromRaw) {
  switch (texto) {
    case '1':
      setSesion(fromNumber, { estado: ESTADOS.VER_VENTAS });
      return mostrarVentasDelDia(fromNumber, fromRaw);
    
    case '2':
      setSesion(fromNumber, { estado: ESTADOS.VER_GANANCIAS });
      return mostrarGanancias(fromNumber, fromRaw);
    
    default:
      return mostrarMenuPrincipal(fromNumber, fromRaw);
  }
}

async function mostrarVentasDelDia(fromNumber, fromRaw) {
  try {
    const mensaje = 
      \`📊 *VENTAS HOY*\n\n\` +
      \`Aún no hay ventas.\n\n\` +
      \`Tu vendedor IA está esperando clientes...\n\` +
      \`Pronto empezarán a llegar.\n\n\` +
      \`0️⃣ Volver\`;

    await enviar(fromRaw, mensaje);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

async function manejarVerVentas(texto, fromNumber, fromRaw) {
  if (texto === '0') {
    return mostrarMenuPrincipal(fromNumber, fromRaw);
  }
  return mostrarVentasDelDia(fromNumber, fromRaw);
}

async function mostrarGanancias(fromNumber, fromRaw) {
  try {
    const mensaje = 
      \`💰 *TUS GANANCIAS*\n\n\` +
      \`📅 Este mes:\n\` +
      \`   Total: Pendiente\n\` +
      \`   Tu ganancia: Pendiente\n\n\` +
      \`💳 Próximo pago: Viernes a las 18:00\n\` +
      \`📱 Método: Transferencia bancaria\n\n\` +
      \`0️⃣ Volver\`;

    await enviar(fromRaw, mensaje);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

async function manejarVerGanancias(texto, fromNumber, fromRaw) {
  if (texto === '0') {
    return mostrarMenuPrincipal(fromNumber, fromRaw);
  }
  return mostrarGanancias(fromNumber, fromRaw);
}

module.exports = { handleVendedor };
