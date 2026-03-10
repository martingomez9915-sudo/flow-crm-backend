/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           FLOW — clienteHandler.js (FLUJO CLIENTE FINAL)     ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
const { generarCatalogoPDF } = require('./generarCatalogoPDF');
const db = require('../services/database');
const whatsapp = require('../services/whatsapp');
const { notificarPedido } = require('../services/emailService');
const { google } = require('googleapis');

// ── Google Sheets config ──
const SHEET_ID = '1-jWv_hbs7hTFRZHIXqRH2GECm3ErLiSKuI5Kw-QDZ8w';
const SHEET_NAME = 'Ventas';

async function registrarEnSheets(datos) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: './google-credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Verificar si la hoja tiene encabezados; si no, agregarlos
    const check = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:K1`,
    });

    if (!check.data.values || check.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[
            'Código', 'Fecha', 'Estado', 'Cliente', 'Teléfono Cliente',
            'Tienda', 'Teléfono Tienda', 'Producto', 'Cantidad',
            'Precio Unit.', 'Total', 'Pago'
          ]],
        },
      });
    }

    // Agregar fila del pedido
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:L`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          datos.codigo,
          datos.fecha,
          datos.estado,
          datos.clienteNombre,
          `+${datos.clienteNumero}`,
          datos.tiendaNombre,
          `+${datos.tiendaPhone}`,
          datos.producto,
          datos.cantidad,
          `$${datos.precioUnitario.toLocaleString('es-CO')}`,
          `$${datos.total.toLocaleString('es-CO')}`,
          'De Contado',
        ]],
      },
    });

    console.log(`✅ Pedido ${datos.codigo} registrado en Google Sheets`);
  } catch (err) {
    console.warn(`⚠️ Error registrando en Sheets: ${err.message}`);
  }
}

const sesiones = new Map();
const adminEnModoCliente = new Map();

const ESTADOS = {
  INICIO: 'INICIO',
  ESPERANDO_CIUDAD: 'ESPERANDO_CIUDAD',
  ESPERANDO_PRODUCTO_CIUDAD: 'ESPERANDO_PRODUCTO_CIUDAD',
  ELIGIENDO_CATEGORIA: 'ELIGIENDO_CATEGORIA',
  ELIGIENDO_TIENDA: 'ELIGIENDO_TIENDA',
  VIENDO_PRODUCTOS: 'VIENDO_PRODUCTOS',
  ESPERANDO_NOMBRE: 'ESPERANDO_NOMBRE',
  ESPERANDO_CANTIDAD: 'ESPERANDO_CANTIDAD',
  CONFIRMANDO_PEDIDO: 'CONFIRMANDO_PEDIDO',
  CONFIRMANDO_CARRITO: 'CONFIRMANDO_CARRITO',
  SEGUIMIENTO: 'SEGUIMIENTO',
  BUSCANDO_PRODUCTO: 'BUSCANDO_PRODUCTO',
  ELIGIENDO_RESULTADO: 'ELIGIENDO_RESULTADO',
};

function generarCodigoSeguimiento() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let codigo = 'FLOW-';
  for (let i = 0; i < 6; i++) {
    codigo += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return codigo;
}

function getSesion(fromNumber) {
  if (!sesiones.has(fromNumber)) {
    sesiones.set(fromNumber, { estado: ESTADOS.INICIO });
  }
  return sesiones.get(fromNumber);
}

function setSesion(fromNumber, datos) {
  sesiones.set(fromNumber, { ...getSesion(fromNumber), ...datos });
}

function resetSesion(fromNumber) {
  sesiones.set(fromNumber, { estado: ESTADOS.INICIO });
}

function setSesionAdmin(fromNumber, activo) {
  adminEnModoCliente.set(fromNumber, activo);
}

function esModoCliente(fromNumber) {
  return adminEnModoCliente.get(fromNumber) === true;
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

function contarProveedores(resultados) {
  return new Set(resultados.map(r => r.tienda)).size;
}

// ── Helper: compara ciudad por número (1/2/3) O por nombre ("Bogotá"/"Medellín"/"Cali") ──
const MAPA_CIUDADES = { 1: 'bogotá', 2: 'medellín', 3: 'cali', bogota: 1, medellin: 2, cali: 3 };
function esTiendaDeCiudad(tienda, ciudad, ciudadNumero) {
  const ciNum = String(ciudadNumero);
  const ciNom = (ciudad || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tCiudad = String(tienda.ciudad || '');
  // Coincidencia por número directo
  if (tCiudad === ciNum) return true;
  // Coincidencia por nombre (normalizado)
  const tNorm = tCiudad.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return tNorm === ciNom;
}

function getCategoriaEmoji(categoria) {
  const map = {
    'vaping': '💨', 'pods': '💨', 'vape': '💨', 'cigarrillos electrónicos': '💨',
    'pañaleras': '👶', 'pañalera': '👶', 'nutrición infantil': '👶', 'bebés': '👶', 'bebes': '👶',
    'mascotas barf': '🐾', 'barf': '🐾', 'dieta barf': '🐾', 'snacks mascotas': '🐾', 'mascotas': '🐾',
    'beauty': '💅', 'belleza': '💄', 'cejas': '💄', 'pestañas': '💄', 'uñas': '💅', 'estética': '💅', 'estetica': '💅',
    'ferretería': '🏗️', 'ferreteria': '🏗️', 'pinturas': '🏗️', 'eléctricos': '🏗️', 'electricos': '🏗️',
    'droguería': '💊', 'drogueria': '💊', 'farmacia': '💊', 'salud': '💊', 'medicamentos': '💊', 'suplementos': '💊',
    'minimarket': '🏪', 'mini market': '🏪', 'tienda': '🏪', 'mercado': '🏪', 'canasta': '🏪',
    'tecnología': '💻', 'tecnologia': '💻',
    'bienestar': '🌿',
    'ropa': '👕', 'moda': '👗',
    'comida': '🍔', 'alimentos': '🥗', 'café': '☕', 'cafe': '☕', 'restaurantes': '🍽️',
    'deporte': '⚽', 'deportes': '🏃',
    'hogar': '🏠', 'decoración': '🎨',
    'libros': '📚', 'educación': '🎓',
    'joyería': '💍', 'joyeria': '💎',
    'servicios': '🔧',
  };
  return map[categoria?.toLowerCase()] || '🏪';
}

// ══════════════════════════════════════════════════════════════
//  MANEJADOR PRINCIPAL
// ══════════════════════════════════════════════════════════════
async function manejarCiudad(texto, fromNumber, fromRaw, enviar) {
  // Placeholder function
}

async function handleCliente(fromRaw, body) {
  const fromNumber = fromRaw.replace(/\D/g, '');
  setSesion(fromNumber, { fromRaw });
  const texto = body.trim().toLowerCase();
  const sesion = getSesion(fromNumber);
  const FROM_TWILIO = process.env.TWILIO_WHATSAPP_NUMBER;

  const enviar = async (msg) => {
    await whatsapp.enviarMensaje(FROM_TWILIO, fromRaw, msg);
  };

  console.log(`🛍️ [CLIENTE] ${fromNumber} | Estado: ${sesion.estado} | Msg: "${body}"`);

  // ✅ Así debe quedar
  if (['hola', 'inicio', 'menu'].includes(texto) ||
    (texto === '0' && sesion.estado === ESTADOS.INICIO)) {
    resetSesion(fromNumber);
    return await mostrarBienvenida(fromNumber, fromRaw, enviar);
  }

  // Ver carrito en cualquier momento
  if (texto === 'carrito') {
    const c = getSesion(fromNumber).carrito || [];
    if (c.length === 0) return await enviar(`🛒 Tu carrito está vacío.\n\nEscribe *menu* para explorar productos.`);
    const { msg, totalGeneral } = resumenCarrito(c);
    return await enviar(msg + `\n¿Qué deseas hacer?\n\n🛍️ *1* — Seguir comprando\n✅ *2* — Terminar y pagar\n❌ *3* — Cancelar todo`);
  }

  if (texto === 'buscar' || texto === 'search') {
    setSesion(fromNumber, { estado: ESTADOS.BUSCANDO_PRODUCTO });
    return await pedirTerminoBusqueda(fromNumber, enviar);
  }

  if (texto.startsWith('flow-') || texto === 'seguimiento' || texto === 'pedido') {
    if (texto === 'seguimiento' || texto === 'pedido') {
      setSesion(fromNumber, { estado: ESTADOS.SEGUIMIENTO });
      return await enviar(
        `🔍 *CONSULTA DE PEDIDO*\n\n` +
        `Por favor ingresa tu código de seguimiento.\n` +
        `Ejemplo: *FLOW-A3X9K2*\n\n` +
        `0️⃣ Volver al menú`
      );
    }
    return await consultarSeguimiento(texto.toUpperCase(), fromNumber, enviar);
  }

  // ── Detección directa de tienda por nombre ──────────────────────
  // Si el cliente escribe el nombre de una tienda (ej: "naked"),
  // va directo al catálogo sin importar en qué estado esté
  if (texto.length >= 3) {
    try {
      const todasLasTiendas = await db.listarTodasLasTiendas();
      const normalizar = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const tiendaDirecta = todasLasTiendas.find(t => normalizar(t.nombre).includes(normalizar(texto)));
      if (tiendaDirecta) return await mostrarCatalogoTiendaDirecta(tiendaDirecta, fromNumber, fromRaw, enviar);
    } catch (e) { console.warn('⚠️ No se pudo verificar tienda directa:', e.message); }
  }

  switch (sesion.estado) {
    case ESTADOS.INICIO:
    case ESTADOS.ESPERANDO_CIUDAD:
      return await manejarCiudad(texto, fromNumber, fromRaw, enviar);
    case ESTADOS.ESPERANDO_PRODUCTO_CIUDAD:
      return await manejarProductoDespuesCiudad(texto, fromNumber, enviar);
    case ESTADOS.ELIGIENDO_CATEGORIA:
      return await manejarCategoria(texto, fromNumber, fromRaw, enviar);
    case ESTADOS.ELIGIENDO_TIENDA:
      return await manejarTienda(texto, fromNumber, enviar);
    case ESTADOS.VIENDO_PRODUCTOS:
      return await manejarProducto(texto, fromNumber, enviar);
    case ESTADOS.ESPERANDO_NOMBRE:
      return await manejarNombre(body.trim(), fromNumber, enviar);
    case ESTADOS.ESPERANDO_CANTIDAD:
      return await manejarCantidad(texto, fromNumber, enviar);
    case ESTADOS.CONFIRMANDO_PEDIDO:
      return await manejarConfirmacion(texto, fromNumber, enviar);
    case ESTADOS.CONFIRMANDO_CARRITO:
      return await manejarConfirmacionCarrito(texto, fromNumber, enviar);
    case ESTADOS.SEGUIMIENTO:
      return await consultarSeguimiento(texto.toUpperCase(), fromNumber, enviar);
    case ESTADOS.BUSCANDO_PRODUCTO:
      return await manejarBusqueda(body.trim(), fromNumber, enviar);
    case ESTADOS.ELIGIENDO_RESULTADO:
      return await manejarEleccionResultado(texto, fromNumber, enviar);
    default:
      resetSesion(fromNumber);
      return await mostrarBienvenida(fromNumber, fromRaw, enviar);
  }
}

// ══════════════════════════════════════════════════════════════
//  BIENVENIDA Y MENÚ
// ══════════════════════════════════════════════════════════════
async function mostrarBienvenida(fromNumber, fromRaw, enviar) {
  setSesion(fromNumber, { estado: ESTADOS.ESPERANDO_CIUDAD });
  const baseURL = process.env.RAILWAY_URL || 'https://flow-ai-production-4dc2.up.railway.app';
  await whatsapp.enviarMensaje(process.env.TWILIO_WHATSAPP_NUMBER, fromRaw, ' ', `${baseURL}/bienvenida-flow-ai.png`);
  await new Promise(r => setTimeout(r, 500));
  await enviar(
    `👋 ¡Bienvenido a *Flow Marketplace*!\n\n` +
    `Para empezar, selecciona tu ciudad:\n\n` +
    `1️⃣ Bogotá\n2️⃣ Medellín\n3️⃣ Cali\n\n` +
    `📌 Presiona el número de tu ciudad.`
  );
}

async function manejarCiudad(texto, fromNumber, fromRaw, enviar) {
  const ciudades = ['Bogotá', 'Medellín', 'Cali'];
  const idx = parseInt(texto) - 1;
  if (isNaN(idx) || idx < 0 || idx >= ciudades.length) {
    return await enviar(
      `⚠️ Opción no válida.\nPor favor selecciona tu ciudad:\n\n1️⃣ Bogotá\n2️⃣ Medellín\n3️⃣ Cali\n\n📌 Presiona el número de tu ciudad.`
    );
  }

  const ciudadElegida = ciudades[idx];
  const ciudadNumero = idx + 1;
  setSesion(fromNumber, { ciudad: ciudadElegida, ciudadNumero, estado: ESTADOS.ESPERANDO_PRODUCTO_CIUDAD });

  // 🔄 NUEVO FLUJO: Pedir producto ANTES de mostrar categorías
  await enviar(
    `✅ *${ciudadElegida}* seleccionada.\n\n` +
    `🔍 Ahora, ¿qué producto buscas?\n\n` +
    `Escribe el nombre del producto (ej: _Ibuprofeno_, _Pañal Huggies_, _Pod Vuse_)\n\n` +
    `O presiona:\n` +
    `📋 *0* — Ver todas las categorías\n` +
    `🏠 *menu* — Volver al inicio`
  );
}

async function manejarProductoDespuesCiudad(texto, fromNumber, enviar) {
  // Opción 0: Ver todas las categorías
  if (texto === '0') {
    return await mostrarMenu(fromNumber, null, enviar);
  }

  if (texto.length < 2) {
    return await enviar(`⚠️ Por favor escribe al menos 2 caracteres.\n\nEjemplo: _Ibuprofeno_`);
  }

  // Buscar el producto en la ciudad seleccionada
  await enviar(`⏳ Buscando *"${texto}"* en ${getSesion(fromNumber).ciudad}...`);

  try {
    const todasLasTiendas = await db.listarTodasLasTiendas();
    const { ciudad, ciudadNumero } = getSesion(fromNumber);

    // Filtrar tiendas por ciudad (por número O por nombre)
    const phoneIdsCiudad = new Set(
      todasLasTiendas.filter(t => esTiendaDeCiudad(t, ciudad, ciudadNumero)).map(t => t.phoneId)
    );

    // Buscar el producto globalmente
    const resultados = await db.buscarProductoGlobal(texto);

    // Filtrar resultados solo a la ciudad seleccionada
    // Si phoneIdsCiudad está vacío (ciudad sin tiendas registradas), mostrar todos los resultados
    const disponibles = resultados.filter(p =>
      (p.stock || 0) > 0 &&
      (!phoneIdsCiudad.size || phoneIdsCiudad.has(p.phoneId) || phoneIdsCiudad.has(p.tiendaId))
    );

    if (!disponibles || disponibles.length === 0) {
      return await enviar(
        `😔 *No encontramos "${texto}"* en ${ciudad}\n\n` +
        `Ningún proveedor tiene ese producto disponible en esta ciudad.\n\n` +
        `💡 *Opciones:*\n` +
        `• Intenta con otro término de búsqueda\n` +
        `• Presiona *0* para ver todas las categorías\n` +
        `• Escribe *menu* para ir al inicio`
      );
    }

    // Mostrar resultados encontrados
    setSesion(fromNumber, {
      estado: ESTADOS.ELIGIENDO_RESULTADO,
      resultadosBusqueda: disponibles,
      terminoBusqueda: texto
    });

    // Guardar resultados en sesión para el pedido
    setSesion(fromNumber, {
      estado: ESTADOS.ELIGIENDO_RESULTADO,
      resultadosBusqueda: disponibles,
      terminoBusqueda: texto
    });

    // Generar y enviar PDF del catálogo
    try {
      const { generarCatalogoPDF } = require('./generarCatalogoPDF');
      const tiendaCtx = { nombre: disponibles[0]?.tienda || 'Flow Marketplace', phoneId: 'global' };
      const nombrePDF = await generarCatalogoPDF(tiendaCtx, disponibles);
      const urlPDF = `${process.env.RAILWAY_URL || 'https://flow-ai-production-4dc2.up.railway.app'}/catalogos/${nombrePDF}`;
      await whatsapp.enviarMensaje(process.env.TWILIO_WHATSAPP_NUMBER, getSesion(fromNumber).fromRaw, ' ', urlPDF);
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.warn('⚠️ No se pudo generar PDF:', e.message);
    }

    await enviar(
      `📄 *Aquí está el catálogo con los resultados de "${texto}"* ↑\n\n` +
      `📌 *¿Cómo pedir?*\n` +
      `Escribe los números de los productos que quieres:\n\n` +
      `_Ej: *1,3* → uno de cada uno_\n` +
      `_Ej: *1x2,3x1* → producto x cantidad_\n\n` +
      `📋 *0* — Ver todas las categorías\n` +
      `🏠 *menu* — Volver al inicio`
    );

  } catch (error) {
    console.error('❌ Error buscando producto:', error.message);
    await enviar(`❌ Error al buscar. Por favor intenta de nuevo.\n\n📋 *0* — Ver categorías\n🏠 *menu* — Volver`);
  }
}

async function mostrarMenu(fromNumber, fromRaw, enviar) {
  const sesion = getSesion(fromNumber);
  const todasLasTiendas = await db.listarTodasLasTiendas();

  console.log(`🔍 [DEBUG] Ciudad elegida: "${sesion.ciudad}" | ciudadNumero: ${sesion.ciudadNumero}`);
  console.log(`🔍 [DEBUG] Total tiendas en BD: ${todasLasTiendas.length}`);
  todasLasTiendas.forEach(t => {
    console.log(`   → Tienda: "${t.nombre}" | ciudad: "${t.ciudad}" (tipo: ${typeof t.ciudad}) | industria: "${t.industria}"`);
  });

  const tiendas = todasLasTiendas.filter(t => esTiendaDeCiudad(t, sesion.ciudad, sesion.ciudadNumero));
  const categorias = [...new Set(tiendas.map(t => t.industria).filter(Boolean))];

  console.log(`🔍 [DEBUG] Tiendas filtradas para ciudad ${sesion.ciudadNumero}: ${tiendas.length}`);
  console.log(`🔍 [DEBUG] Categorías encontradas: ${JSON.stringify(categorias)}`);

  let msg = `📋 *CATEGORÍAS EN ${sesion.ciudad.toUpperCase()}*\n\n`;
  msg += `Elige una categoría o:\n\n`;
  categorias.forEach((cat, i) => {
    const count = tiendas.filter(t => t.industria === cat).length;
    msg += `${i + 1}️⃣ ${getCategoriaEmoji(cat)} ${cat} _(${count} tienda${count !== 1 ? 's' : ''})_\n`;
  });
  msg += `\n📦 *${categorias.length + 1}*  Ver todas las tiendas\n`;
  msg += `🔍 *${categorias.length + 2}*  Buscar un producto\n`;
  msg += `📋 *${categorias.length + 3}*  Consultar mi pedido\n\n`;
  msg += `📌 Presiona el número o escribe *buscar*.`;
  setSesion(fromNumber, { estado: ESTADOS.ELIGIENDO_CATEGORIA, categorias, tiendas });
  await enviar(msg);
}

// ══════════════════════════════════════════════════════════════
//  CATEGORÍA
// ══════════════════════════════════════════════════════════════
async function manejarCategoria(texto, fromNumber, fromRaw, enviar) {
  const sesion = getSesion(fromNumber);
  const { categorias = [], tiendas = [] } = sesion;

  if (!categorias.length) {
    resetSesion(fromNumber);
    return await mostrarBienvenida(fromNumber, fromRaw, enviar);
  }

  const totalCats = categorias.length;
  const numTexto = parseInt(texto);

  if (numTexto === totalCats + 1) return await mostrarTiendas(tiendas, null, fromNumber, enviar);
  if (numTexto === totalCats + 2) {
    setSesion(fromNumber, { estado: ESTADOS.BUSCANDO_PRODUCTO });
    return await pedirTerminoBusqueda(fromNumber, enviar);
  }
  if (numTexto === totalCats + 3) {
    setSesion(fromNumber, { estado: ESTADOS.SEGUIMIENTO });
    return await enviar(`🔍 *CONSULTA DE PEDIDO*\n\nIngresa tu código de seguimiento.\nEjemplo: *FLOW-A3X9K2*\n\n0️⃣ Volver al menú`);
  }

  const idx = numTexto - 1;
  if (isNaN(idx) || idx < 0 || idx >= categorias.length) {
    return await enviar(`⚠️ Opción no válida.\nPresiona un número del *1* al *${totalCats + 3}*.\n\nO escribe *buscar* para encontrar un producto.\n\nEscribe *menu* para volver.`);
  }

  const categoriaElegida = categorias[idx];
  const tiendasFiltradas = tiendas.filter(t => t.industria === categoriaElegida);
  setSesion(fromNumber, { categoriaSeleccionada: categoriaElegida });
  return await mostrarTiendas(tiendasFiltradas, categoriaElegida, fromNumber, enviar);
}

async function mostrarTiendas(tiendasFiltradas, categoria, fromNumber, enviar) {
  if (!tiendasFiltradas || tiendasFiltradas.length === 0) {
    return await enviar(`😔 No hay tiendas disponibles en esta categoría.\n\nEscribe *menu* para volver.`);
  }

  let msg = categoria
    ? `${getCategoriaEmoji(categoria)} *TIENDAS — ${categoria.toUpperCase()}*\n\n`
    : `🏪 *TODAS LAS TIENDAS*\n\n`;

  tiendasFiltradas.forEach((t, i) => { msg += `${i + 1}️⃣ *${t.nombre}*\n`; });
  msg += `0️⃣ Volver al menú\n\n`;
  msg += `📌 Presiona el número de la tienda para ver sus productos.\n`;
  msg += `🔎 O escribe el nombre de la tienda para buscarla.`;

  setSesion(fromNumber, { estado: ESTADOS.ELIGIENDO_TIENDA, tiendasFiltradas });
  if (msg.length > 1500) msg = msg.substring(0, 1500) + `\n\n_... y más tiendas disponibles._`;
  await enviar(msg);
}

// ══════════════════════════════════════════════════════════════
//  TIENDA
// ══════════════════════════════════════════════════════════════
async function manejarTienda(texto, fromNumber, enviar) {
  const sesion = getSesion(fromNumber);
  const { tiendasFiltradas = [] } = sesion;
  const idx = parseInt(texto) - 1;

  if (isNaN(idx) || idx < 0 || idx >= tiendasFiltradas.length) {
    const termino = texto.toLowerCase();
    const encontradas = tiendasFiltradas.filter(t => t.nombre.toLowerCase().includes(termino));

    if (encontradas.length === 0) {
      return await enviar(`😔 No encontramos ninguna tienda con "*${texto}*".\n\nPresiona un número del *1* al *${tiendasFiltradas.length}* o escribe otro nombre.\n\n0️⃣ Volver al menú`);
    }
    if (encontradas.length === 1) return await mostrarProductosDeTienda(encontradas[0], fromNumber, enviar);

    let msg = `🔎 Tiendas que coinciden con "*${texto}*":\n\n`;
    encontradas.forEach((t, i) => { msg += `${i + 1}️⃣ *${t.nombre}*\n`; });
    msg += `\n0️⃣ Volver al menú`;
    setSesion(fromNumber, { tiendasFiltradas: encontradas });
    return await enviar(msg);
  }

  return await mostrarProductosDeTienda(tiendasFiltradas[idx], fromNumber, enviar);
}

async function mostrarCatalogoTiendaDirecta(tiendaElegida, fromNumber, fromRaw, enviar) {
  setSesion(fromNumber, { tiendaSeleccionada: tiendaElegida, fromRaw });
  // ── Catálogo Naked ──
  if (tiendaElegida.nombre && tiendaElegida.nombre.toLowerCase().includes('naked')) {
    const urlNaked = `${process.env.RAILWAY_URL || 'https://flow-ai-production-4dc2.up.railway.app'}/catalogo_naked_flow_v2.pdf`;
    await whatsapp.enviarMensaje(process.env.TWILIO_WHATSAPP_NUMBER, fromRaw, ' ', urlNaked);
    await new Promise(r => setTimeout(r, 500));
  }

  const productos = await db.obtenerInventarioTienda(tiendaElegida.phoneId);
  if (!productos || productos.length === 0)
    return await enviar(`😔 *${tiendaElegida.nombre}* no tiene productos disponibles.\n\n0️⃣ Volver al menú`);

  const productosDisponibles = productos.filter(p => (p.stock || 0) > 0);
  if (productosDisponibles.length === 0)
    return await enviar(`😔 *${tiendaElegida.nombre}* está sin stock por ahora.\n\n0️⃣ Volver al menú`);

  setSesion(fromNumber, { estado: ESTADOS.VIENDO_PRODUCTOS, productosDisponibles });

  const NGROK = process.env.RAILWAY_URL || 'https://flow-ai-production-4dc2.up.railway.app';

  try {
    const nombrePDF = await generarCatalogoPDF(tiendaElegida, productosDisponibles);
    const urlPDF = `${NGROK}/catalogos/${nombrePDF}`;
    await whatsapp.enviarMensaje(process.env.TWILIO_WHATSAPP_NUMBER, fromRaw, ' ', urlPDF);
    await new Promise(r => setTimeout(r, 600));
  } catch (e) {
    console.warn('⚠️ No se pudo generar PDF:', e.message);
  }

  await enviar(
    `🛍️ *${tiendaElegida.nombre}*\n\n` +
    `📄 Te envié el catálogo completo arriba ↑\n\n` +
    `*¿Qué deseas pedir?*\n` +
    `Escribe los números separados por coma:\n\n` +
    `_Ej: *1,3* → uno de cada uno_\n` +
    `_Ej: *1x2,3x1* → producto x cantidad_\n\n` +
    `0️⃣ Volver al menú`
  );
}

async function mostrarProductosDeTienda(tiendaElegida, fromNumber, enviar) {
  setSesion(fromNumber, { tiendaSeleccionada: tiendaElegida });
  // ── Catálogo Naked ──
  if (tiendaElegida.nombre && tiendaElegida.nombre.toLowerCase().includes('naked')) {
    const urlNaked = `${process.env.RAILWAY_URL || 'https://flow-ai-production-4dc2.up.railway.app'}/catalogo_naked_flow_v2.pdf`;
    await whatsapp.enviarMensaje(process.env.TWILIO_WHATSAPP_NUMBER, getSesion(fromNumber).fromRaw, ' ', urlNaked);
    await new Promise(r => setTimeout(r, 500));
  }

  const productos = await db.obtenerInventarioTienda(tiendaElegida.phoneId);
  if (!productos || productos.length === 0)
    return await enviar(`😔 *${tiendaElegida.nombre}* no tiene productos disponibles.\n\n0️⃣ Volver al menú`);

  const productosDisponibles = productos.filter(p => (p.stock || 0) > 0);
  if (productosDisponibles.length === 0)
    return await enviar(`😔 *${tiendaElegida.nombre}* está sin stock por ahora.\n\n0️⃣ Volver al menú`);

  setSesion(fromNumber, { estado: ESTADOS.VIENDO_PRODUCTOS, productosDisponibles });

  const { fromRaw: raw } = getSesion(fromNumber);
  const NGROK = process.env.RAILWAY_URL || 'https://flow-ai-production-4dc2.up.railway.app';

  try {
    const nombrePDF = await generarCatalogoPDF(tiendaElegida, productosDisponibles);
    const urlPDF = `${NGROK}/catalogos/${nombrePDF}`;
    await whatsapp.enviarMensaje(process.env.TWILIO_WHATSAPP_NUMBER, raw, ' ', urlPDF);
    await new Promise(r => setTimeout(r, 600));
  } catch (e) {
    console.warn('⚠️ No se pudo generar PDF:', e.message);
  }

  await enviar(
    `🛍️ *${tiendaElegida.nombre}*\n\n` +
    `📄 Te envié el catálogo completo arriba ↑\n\n` +
    '🌐 Visita: https://naked.com.co' +
    `*¿Qué deseas pedir?*\n` +
    `Escribe los números separados por coma:\n\n` +
    `_Ej: *1,3* → uno de cada uno_\n` +
    `_Ej: *1x2,3x1* → producto x cantidad_\n\n` +
    `0️⃣ Volver al menú`
  );
}

// ══════════════════════════════════════════════════════════════
//  PRODUCTO → NOMBRE → CANTIDAD → CONFIRMACIÓN
// ══════════════════════════════════════════════════════════════
async function manejarProducto(texto, fromNumber, enviar) {
  if (texto === '0') {
    resetSesion(fromNumber);
    return await enviar(`Escribe *menu* para volver al inicio.`);
  }

  const sesion = getSesion(fromNumber);
  const { productosDisponibles = [] } = sesion;

  // Parsear "1,3" o "1x2,3x1"
  const selecciones = texto.split(',').map(s => s.trim()).filter(Boolean);
  const itemsCarrito = [];
  const errores = [];

  for (const sel of selecciones) {
    let numStr, cantStr;
    if (sel.includes('x')) {
      [numStr, cantStr] = sel.split('x');
    } else {
      numStr = sel;
      cantStr = '1';
    }

    const idx = parseInt(numStr) - 1;
    const cantidad = parseInt(cantStr) || 1;

    if (isNaN(idx) || idx < 0 || idx >= productosDisponibles.length) {
      errores.push(`❌ Número *${numStr}* no existe en el catálogo.`);
      continue;
    }

    const p = productosDisponibles[idx];
    if (cantidad > p.stock) {
      errores.push(`⚠️ *${p.nombre}*: solo hay ${p.stock} unidades.`);
      continue;
    }

    itemsCarrito.push({
      tiendaNombre: sesion.tiendaSeleccionada.nombre,
      tiendaPhone: sesion.tiendaSeleccionada.phoneId.replace(/\D/g, ''),
      tiendaEmail: sesion.tiendaSeleccionada.email || null,
      tiendaId: sesion.tiendaSeleccionada.phoneId,
      producto: p.nombre,
      precio: p.precio || 0,
      cantidad,
    });
  }

  if (errores.length > 0 && itemsCarrito.length === 0)
    return await enviar(errores.join('\n') + `\n\nRevisa el catálogo y vuelve a intentarlo.`);

  const carritoActual = sesion.carrito || [];
  const carritoNuevo = [...carritoActual, ...itemsCarrito];

  // Si no tiene nombre → pedirlo primero
  if (!sesion.nombreCliente) {
    setSesion(fromNumber, { carrito: carritoNuevo, estado: ESTADOS.ESPERANDO_NOMBRE });
    return await enviar(`👤 ¿Cuál es tu nombre completo?\n_(Solo te lo pedimos una vez)_`);
  }

  setSesion(fromNumber, { carrito: carritoNuevo, estado: ESTADOS.CONFIRMANDO_CARRITO });
  const { msg: resumen } = resumenCarrito(carritoNuevo);

  let msgFinal = errores.length > 0 ? errores.join('\n') + '\n\n' : '';
  msgFinal += `👤 *${sesion.nombreCliente}*\n\n` + resumen;
  msgFinal += `\n✅ *1* — Confirmar y pagar\n🛍️ *2* — Agregar más productos\n❌ *3* — Cancelar`;
  return await enviar(msgFinal);
}
async function manejarNombre(nombre, fromNumber, enviar) {
  if (nombre.length < 3) return await enviar(`⚠️ Por favor ingresa tu nombre completo.`);

  setSesion(fromNumber, { nombreCliente: nombre, clienteNumero: fromNumber });
  const sesion = getSesion(fromNumber);

  // Si viene de búsqueda con producto seleccionado, pedir cantidad primero
  if (sesion.productoSeleccionado) {
    setSesion(fromNumber, { estado: ESTADOS.ESPERANDO_CANTIDAD });
    return await enviar(
      `✅ Hola *${nombre}*!\n\n` +
      `¿Cuántas unidades de *${sesion.productoSeleccionado.nombre}* deseas?\n` +
      `📦 Disponibles: ${sesion.productoSeleccionado.stock}\n\n_(Escribe solo el número)_`
    );
  }

  setSesion(fromNumber, { estado: ESTADOS.CONFIRMANDO_CARRITO });
  const { msg: resumen } = resumenCarrito(sesion.carrito || []);

  return await enviar(
    `👋 Hola *${nombre}*!\n\n` + resumen +
    `\n✅ *1* — Confirmar y pagar\n🛍️ *2* — Agregar más productos\n❌ *3* — Cancelar`
  );
}
// ── Helper: mostrar resumen del carrito actual ──
function resumenCarrito(carrito) {
  let totalGeneral = 0;
  let msg = `🛒 *TU CARRITO ACTUAL:*\n\n`;
  carrito.forEach((item, i) => {
    const sub = item.cantidad * item.precio;
    totalGeneral += sub;
    msg += `${i + 1}. *${item.producto}*\n`;
    msg += `   🏪 ${item.tiendaNombre}\n`;
    msg += `   🔢 x${item.cantidad} — $${sub.toLocaleString('es-CO')}\n\n`;
  });
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💵 *TOTAL: $${totalGeneral.toLocaleString('es-CO')}*\n`;
  return { msg, totalGeneral };
}

async function manejarCantidad(texto, fromNumber, enviar) {
  const sesion = getSesion(fromNumber);
  const cantidad = parseInt(texto);
  const producto = sesion.productoSeleccionado;

  if (isNaN(cantidad) || cantidad <= 0) return await enviar(`⚠️ Ingresa una cantidad válida.`);
  if (cantidad > producto.stock) return await enviar(`⚠️ Solo hay *${producto.stock}* unidades disponibles.`);

  const carrito = sesion.carrito || [];
  carrito.push({
    tiendaNombre: sesion.tiendaSeleccionada.nombre,
    tiendaPhone: sesion.tiendaSeleccionada.phoneId.replace(/\D/g, ''),
    tiendaEmail: sesion.tiendaSeleccionada.email || null,
    tiendaId: sesion.tiendaSeleccionada.phoneId,
    producto: producto.nombre,
    precio: producto.precio || 0,
    cantidad,
  });

  setSesion(fromNumber, { carrito, estado: ESTADOS.CONFIRMANDO_CARRITO });

  const { msg: resumen, totalGeneral } = resumenCarrito(carrito);
  return await enviar(
    resumen +
    `\n✅ *1* — Confirmar y pagar\n` +
    `🛍️ *2* — Agregar otro producto\n` +
    `❌ *3* — Cancelar`
  );
}

async function manejarConfirmacion(texto, fromNumber, enviar) {
  const sesion = getSesion(fromNumber);

  if (texto === '3') {
    resetSesion(fromNumber);
    return await enviar(`❌ Carrito cancelado.\n\nEscribe *menu* para volver al inicio.`);
  }

  if (texto === '1') {
    // Volver al menú principal manteniendo carrito, nombre y ciudad
    const { carrito, nombreCliente, ciudad, ciudadNumero } = sesion;
    const todasLasTiendas = await db.listarTodasLasTiendas();
    // ✅ FIX: filtrar por número de ciudad (1=Bogotá, 2=Medellín, 3=Cali)
    const tiendasCiudad = todasLasTiendas.filter(t => String(t.ciudad) === String(ciudadNumero));
    const categorias = [...new Set(tiendasCiudad.map(t => t.industria).filter(Boolean))];
    setSesion(fromNumber, {
      estado: ESTADOS.ELIGIENDO_CATEGORIA,
      carrito,
      nombreCliente,
      ciudad,
      ciudadNumero,
      categorias,
      tiendas: tiendasCiudad,
    });

    let msg = `🌊 *¿Qué más deseas agregar?* (${ciudad})\n\n`;
    msg += `🔍 Escribe *buscar* para buscar un producto específico\n\n`;
    msg += `🏷️ *O elige una categoría:*\n\n`;
    categorias.forEach((cat, i) => { msg += `${i + 1}️⃣ ${getCategoriaEmoji(cat)} ${cat}\n`; });
    msg += `\n📦 *${categorias.length + 1}*  Ver todas las tiendas\n`;
    msg += `🔍 *${categorias.length + 2}*  Buscar un producto\n\n`;
    msg += `🛒 *Ver carrito:* escribe *carrito*`;
    return await enviar(msg);
  }

  if (texto === '2') {
    // Volver a elegir categoría manteniendo carrito
    const { carrito, nombreCliente, ciudad, ciudadNumero } = sesion;
    const todasLasTiendas = await db.listarTodasLasTiendas();
    const tiendasCiudad = todasLasTiendas.filter(t => String(t.ciudad) === String(ciudadNumero));
    const categorias = [...new Set(tiendasCiudad.map(t => t.industria).filter(Boolean))];
    setSesion(fromNumber, { estado: ESTADOS.ELIGIENDO_CATEGORIA, carrito, nombreCliente, ciudad, ciudadNumero, categorias, tiendas: tiendasCiudad });

    let msg = `🛍️ *¿Qué más deseas agregar?*\n\n`;
    categorias.forEach((cat, i) => {
      const count = tiendasCiudad.filter(t => t.industria === cat).length;
      msg += `${i + 1}️⃣ ${getCategoriaEmoji(cat)} ${cat} _(${count} tienda${count !== 1 ? 's' : ''})_\n`;
    });
    msg += `\n🛒 Escribe *carrito* para ver tu pedido actual.`;
    return await enviar(msg);
  }

  return await enviar(`⚠️ Presiona *1* para confirmar, *2* para agregar más o *3* para cancelar.`);
}

async function manejarConfirmacionCarrito(texto, fromNumber, enviar) {
  const crypto = require('crypto');

  if (texto === '3') {
    resetSesion(fromNumber);
    return await enviar(`❌ Pedido cancelado.\n\nEscribe *menu* para volver al inicio.`);
  }
  if (texto === '2') {
    const { carrito, nombreCliente, ciudad, ciudadNumero } = getSesion(fromNumber);
    const todasLasTiendas = await db.listarTodasLasTiendas();
    const tiendasCiudad = todasLasTiendas.filter(t => String(t.ciudad) === String(ciudadNumero));
    const categorias = [...new Set(tiendasCiudad.map(t => t.industria).filter(Boolean))];
    setSesion(fromNumber, { estado: ESTADOS.ELIGIENDO_CATEGORIA, carrito, nombreCliente, ciudad, ciudadNumero, categorias, tiendas: tiendasCiudad });
    let msg = `🛍️ *¿Qué más deseas agregar?*\n\n`;
    categorias.forEach((cat, i) => { msg += `${i + 1}️⃣ ${getCategoriaEmoji(cat)} ${cat}\n`; });
    msg += `\n🛒 Escribe *carrito* para ver tu pedido actual.`;
    return await enviar(msg);
  }
  if (texto !== '1') return await enviar(`⚠️ Presiona *1* para confirmar, *2* para agregar más o *3* para cancelar.`);

  await enviar(`⏳ Procesando tu pedido, un momento...`);

  const sesion = getSesion(fromNumber);
  const { nombreCliente, carrito } = sesion;
  const ahora = new Date().toISOString();
  const fechaFormateada = new Date().toLocaleDateString('es-CO', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const { getFirestore } = require('firebase-admin/firestore');
  const firestore = getFirestore();

  // Agrupar items por tienda para generar un pedido por tienda
  const porTienda = {};
  for (const item of carrito) {
    if (!porTienda[item.tiendaId]) porTienda[item.tiendaId] = { ...item, items: [] };
    porTienda[item.tiendaId].items.push(item);
  }

  const codigos = [];
  let totalGeneral = 0;
  let huboError = false;

  for (const [tiendaId, grupo] of Object.entries(porTienda)) {
    const subtotalTienda = grupo.items.reduce((acc, i) => acc + i.cantidad * i.precio, 0);
    totalGeneral += subtotalTienda;
    const codigo = generarCodigoSeguimiento();
    codigos.push({ codigo, tiendaNombre: grupo.tiendaNombre, items: grupo.items, subtotal: subtotalTienda, tiendaPhone: grupo.tiendaPhone });

    try {
      // Guardar en Firestore (un pedido por tienda)
      await firestore.collection('pedidos').doc(codigo).set({
        codigo, clienteNumero: fromNumber, clienteNombre: nombreCliente,
        tiendaId, tiendaNombre: grupo.tiendaNombre,
        items: grupo.items.map(i => ({ producto: i.producto, cantidad: i.cantidad, precioUnitario: i.precio, subtotal: i.cantidad * i.precio })),
        producto: grupo.items.map(i => `${i.producto} x${i.cantidad}`).join(', '),
        cantidad: grupo.items.reduce((a, i) => a + i.cantidad, 0),
        precioUnitario: 0, total: subtotalTienda,
        estado: 'PENDIENTE', creadoEn: ahora, tipoPago: 'De Contado',
      });

      // ✅ Registrar en transacciones de la tienda (para el CRM dashboard)
      await firestore
        .collection('negocios').doc(tiendaId)
        .collection('transacciones').doc(codigo)
        .set({
          id: codigo,
          tipo: 'VENTA',
          cliente: nombreCliente,
          nombre_cliente: nombreCliente,
          producto: grupo.items.map(i => `${i.producto} x${i.cantidad}`).join(', '),
          total: subtotalTienda,
          estado: 'PENDIENTE',
          fecha: ahora,
          pagado: false,
          clienteNumero: fromNumber,
        });

      // Registrar en Sheets (una fila por item)
      for (const item of grupo.items) {
        await registrarEnSheets({
          codigo, fecha: fechaFormateada, estado: 'PENDIENTE',
          clienteNombre: nombreCliente, clienteNumero: fromNumber,
          tiendaNombre: grupo.tiendaNombre, tiendaPhone: grupo.tiendaPhone,
          producto: item.producto, cantidad: item.cantidad,
          precioUnitario: item.precio, total: item.cantidad * item.precio,
        });
      }

      // Notificar tienda por WhatsApp
      try {
        const listaItems = grupo.items.map(i => `• ${i.producto} x${i.cantidad} — $${(i.cantidad * i.precio).toLocaleString('es-CO')}`).join('\n');
        await whatsapp.enviarMensaje(process.env.TWILIO_WHATSAPP_NUMBER, `whatsapp:+${grupo.tiendaPhone}`,
          `🔔 *NUEVO PEDIDO RECIBIDO*\n\n📌 Código: *${codigo}*\n👤 Cliente: *${nombreCliente}* (+${fromNumber})\n\n` +
          `🛍️ *Productos:*\n${listaItems}\n\n` +
          `💵 Subtotal: *$${subtotalTienda.toLocaleString('es-CO')}*\n💳 Pago: De Contado\n\n` +
          `⚡ Contáctalo: https://wa.me/${fromNumber}`
        );
      } catch (e) { console.warn(`⚠️ No se pudo notificar a la tienda ${grupo.tiendaNombre}: ${e.message}`); }

      // Notificar por email
      try {
        await notificarPedido({
          emailTienda: grupo.tiendaEmail, tiendaNombre: grupo.tiendaNombre,
          codigo, clienteNombre: nombreCliente, clienteNumero: fromNumber,
          producto: grupo.items.map(i => `${i.producto} x${i.cantidad}`).join(', '),
          cantidad: grupo.items.reduce((a, i) => a + i.cantidad, 0),
          total: subtotalTienda,
        });
      } catch (e) { console.warn(`⚠️ Email a tienda ${grupo.tiendaNombre} falló: ${e.message}`); }

    } catch (err) {
      console.error(`❌ Error guardando pedido tienda ${grupo.tiendaNombre}:`, err.message);
      huboError = true;
    }
  }

  if (huboError) return await enviar(`❌ Hubo un error al procesar tu pedido. Intenta de nuevo.\n\nEscribe *menu* para volver.`);

  // ── Construir mensaje de confirmación con todos los códigos ──
  let msgFinal = `🎉 *¡PEDIDO(S) CONFIRMADO(S)!*\n\nHola *${nombreCliente}*, tus pedidos fueron registrados exitosamente.\n\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const { codigo, tiendaNombre, items, subtotal, tiendaPhone } of codigos) {
    msgFinal += `\n🔑 *${codigo}*\n`;
    msgFinal += `🏪 ${tiendaNombre}\n`;
    items.forEach(i => { msgFinal += `  • ${i.producto} x${i.cantidad}\n`; });
    msgFinal += `💵 $${subtotal.toLocaleString('es-CO')}\n`;
    msgFinal += `📞 https://wa.me/${tiendaPhone}\n`;
  }
  msgFinal += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  msgFinal += `💵 *TOTAL GENERAL: $${totalGeneral.toLocaleString('es-CO')}*\n\n`;

  // ── Generar link de pago Wompi ──
  const referencia = codigos.map(c => c.codigo).join('-');
  const totalCentavos = totalGeneral * 100;
  const llavePrivada = process.env.WOMPI_PRIVATE_KEY || 'prv_test_XfLYzp05x0HBCTK9WPo3vEkHtui5EFzc';
  const llavePublica = process.env.WOMPI_PUBLIC_KEY || 'pub_test_ReAo2SaZsCbmT478EoLLlIrWcUS0YW5U';
  const cadena = `${referencia}${totalCentavos}COP${llavePrivada}`;
  const firma = crypto.createHash('sha256').update(cadena).digest('hex');
  const linkPago = `https://checkout.wompi.co/p/?public-key=${llavePublica}&currency=COP&amount-in-cents=${totalCentavos}&reference=${referencia}&signature:integrity=${firma}`;

  msgFinal += `💳 *PAGA AQUÍ:*\n${linkPago}\n\n`;
  msgFinal += `📌 *Guarda tus códigos* para rastrear cada pedido.\n`;
  msgFinal += `Escribe *seguimiento* + tu código para consultar el estado.\n\n`;
  msgFinal += `¡Gracias por comprar en Flow Marketplace! 🌊`;

  // ── Enviar en el chat actual ──
  await enviar(msgFinal);

  // ── Enviar confirmación directa al número del cliente (si es diferente al fromRaw) ──
  try {
    const clienteWA = `whatsapp:+${fromNumber}`;
    const { fromRaw } = getSesion(fromNumber);

    // Solo enviar mensaje adicional si tiene sentido (siempre útil como confirmación guardable)
    let msgConfirmacion = `✅ *CONFIRMACIÓN DE COMPRA — FLOW MARKETPLACE*\n\n`;
    msgConfirmacion += `Hola *${nombreCliente}* 👋\n`;
    msgConfirmacion += `Aquí tienes el resumen de tu compra del *${new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' })}*:\n\n`;
    for (const { codigo, tiendaNombre, items, subtotal } of codigos) {
      msgConfirmacion += `🔑 *Código:* ${codigo}\n`;
      msgConfirmacion += `🏪 *Tienda:* ${tiendaNombre}\n`;
      items.forEach(i => { msgConfirmacion += `   • ${i.producto} x${i.cantidad} — $${(i.cantidad * i.precio).toLocaleString('es-CO')}\n`; });
      msgConfirmacion += `💵 Subtotal: $${subtotal.toLocaleString('es-CO')}\n\n`;
    }
    msgConfirmacion += `💵 *TOTAL: $${totalGeneral.toLocaleString('es-CO')}*\n\n`;
    msgConfirmacion += `📲 Escribe *seguimiento* en cualquier momento para rastrear tu pedido.\n`;
    msgConfirmacion += `_Flow Marketplace — Conectando negocios y clientes_ 🌊`;

    await whatsapp.enviarMensaje(process.env.TWILIO_WHATSAPP_NUMBER, clienteWA, msgConfirmacion);
    console.log(`✅ Confirmación enviada al cliente +${fromNumber}`);
  } catch (e) {
    console.warn(`⚠️ No se pudo enviar confirmación al cliente: ${e.message}`);
  }

  resetSesion(fromNumber);
}

// ══════════════════════════════════════════════════════════════
//  BÚSQUEDA
// ══════════════════════════════════════════════════════════════
async function pedirTerminoBusqueda(fromNumber, enviar) {
  setSesion(fromNumber, { estado: ESTADOS.BUSCANDO_PRODUCTO });
  await enviar(
    `🔍 *BUSCADOR DE PRODUCTOS*\n\n¿Qué producto necesitas?\n\n` +
    `Escribe el nombre del producto y te mostraré\n*todas las alternativas disponibles* con precio\ny proveedor para que elijas la mejor opción.\n\n` +
    `_Ejemplos:_\n• _Ibuprofeno_\n• _Pañal Huggies talla 3_\n• _Pod Vuse menta_\n• _Pegante de cerámica_\n• _Pollo BARF_\n\n0️⃣ Volver al menú`
  );
}

async function manejarBusqueda(terminoBusqueda, fromNumber, enviar) {
  if (terminoBusqueda === '0') {
    resetSesion(fromNumber);
    return await enviar(`Escribe *menu* para volver al inicio.`);
  }
  if (terminoBusqueda.length < 2) return await enviar(`⚠️ Por favor escribe al menos 2 caracteres.\n\nEjemplo: _Ibuprofeno_`);

  await enviar(`⏳ Buscando *"${terminoBusqueda}"* en todos los proveedores...`);

  try {
    const todasLasTiendas = await db.listarTodasLasTiendas();
    // ✅ FIX: Solo buscar en tiendas de la ciudad del usuario
    const { ciudad, ciudadNumero } = getSesion(fromNumber);
    const phoneIdsCiudad = new Set(
      todasLasTiendas.filter(t => esTiendaDeCiudad(t, ciudad, ciudadNumero)).map(t => t.phoneId)
    );

    const resultados = await db.buscarProductoGlobal(terminoBusqueda);
    // Filtrar resultados a tiendas de la ciudad seleccionada (si hay ciudad activa)
    const disponibles = resultados.filter(p =>
      (p.stock || 0) > 0 &&
      (!ciudad || !phoneIdsCiudad.size || phoneIdsCiudad.has(p.phoneId) || phoneIdsCiudad.has(p.tiendaId))
    );

    if (!disponibles || disponibles.length === 0) {
      return await enviar(
        `😔 *No encontramos "${terminoBusqueda}"*\n\nNingún proveedor tiene ese producto disponible.\n\n` +
        `💡 *Sugerencias:*\n• Intenta con el nombre genérico (ej: _Ibuprofeno_ en vez de _Advil_)\n• Verifica la ortografía\n\n` +
        `🔍 Escribe otro término para buscar\n0️⃣ Volver al menú`
      );
    }

    setSesion(fromNumber, { estado: ESTADOS.ELIGIENDO_RESULTADO, resultadosBusqueda: disponibles, terminoBusqueda });

    let msg = `🔍 *RESULTADOS PARA: "${terminoBusqueda.toUpperCase()}"*\n`;
    msg += `_${disponibles.length} opción(es) disponible(s) en ${contarProveedores(disponibles)} proveedor(es)_\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    disponibles.forEach((p, i) => {
      msg += `${i + 1}️⃣ *${p.nombre}*\n`;
      msg += `   🏪 *${p.tienda}*\n`;
      msg += `   💰 $${(p.precio || p.precio_venta || 0).toLocaleString('es-CO')}\n`;
      msg += `   📦 Stock: ${p.stock} und.\n`;
      if (p.descripcion) msg += `   📝 ${p.descripcion}\n`;
      msg += `\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━━━\n📌 Presiona el número para hacer tu pedido.\n\n🔍 Escribe otro término para buscar de nuevo\n0️⃣ Volver al menú`;
    await enviar(msg);

  } catch (error) {
    console.error('❌ Error en búsqueda:', error.message);
    await enviar(`❌ Error al buscar. Por favor intenta de nuevo.\n\n0️⃣ Volver al menú`);
  }
}

async function manejarEleccionResultado(texto, fromNumber, enviar) {
  const sesion = getSesion(fromNumber);
  const { resultadosBusqueda = [] } = sesion;

  const idx = parseInt(texto) - 1;
  if (isNaN(idx) || idx < 0) {
    if (texto.length > 1 && texto !== '0') {
      setSesion(fromNumber, { estado: ESTADOS.BUSCANDO_PRODUCTO });
      return await manejarBusqueda(texto, fromNumber, enviar);
    }
    return await enviar(`⚠️ Opción no válida.\nPresiona un número del *1* al *${resultadosBusqueda.length}*.\n\nO escribe otro término para buscar.\n0️⃣ Volver al menú`);
  }

  if (idx >= resultadosBusqueda.length) return await enviar(`⚠️ Opción no válida. Hay ${resultadosBusqueda.length} resultado(s).\n\n0️⃣ Volver al menú`);

  const productoElegido = resultadosBusqueda[idx];
  let tiendaSeleccionada = null;

  try {
    const todasLasTiendas = await db.listarTodasLasTiendas();
    tiendaSeleccionada = todasLasTiendas.find(t => t.nombre === productoElegido.tienda);
  } catch (e) { console.warn('⚠️ No se pudo recuperar la tienda completa:', e.message); }

  if (!tiendaSeleccionada) {
    tiendaSeleccionada = {
      nombre: productoElegido.tienda,
      phoneId: productoElegido.tiendaId || productoElegido.phoneId || 'desconocido',
      email: null,
    };
  }

  const productoNormalizado = {
    nombre: productoElegido.nombre,
    precio: productoElegido.precio || productoElegido.precio_venta || 0,
    stock: productoElegido.stock || 0,
    id: productoElegido.id,
  };

  setSesion(fromNumber, { estado: ESTADOS.ESPERANDO_NOMBRE, productoSeleccionado: productoNormalizado, tiendaSeleccionada });

  const sesionActual2 = getSesion(fromNumber);
  if (sesionActual2.nombreCliente) {
    setSesion(fromNumber, { estado: ESTADOS.ESPERANDO_CANTIDAD });
    return await enviar(
      `✅ *${productoNormalizado.nombre}* seleccionado.\n` +
      `🏪 Proveedor: *${tiendaSeleccionada.nombre}*\n` +
      `💰 Precio: $${productoNormalizado.precio.toLocaleString('es-CO')}\n\n` +
      `¿Cuántas unidades deseas?\n📦 Disponibles: ${productoNormalizado.stock}\n\n_(Escribe solo el número)_`
    );
  }

  await enviar(
    `✅ *${productoNormalizado.nombre}* seleccionado.\n` +
    `🏪 Proveedor: *${tiendaSeleccionada.nombre}*\n` +
    `💰 Precio: $${productoNormalizado.precio.toLocaleString('es-CO')}\n\n` +
    `👤 ¿Cuál es tu nombre completo?\n_(Para registrar tu pedido)_`
  );
}

// ══════════════════════════════════════════════════════════════
//  SEGUIMIENTO
// ══════════════════════════════════════════════════════════════
async function consultarSeguimiento(codigo, fromNumber, enviar) {
  if (!codigo.startsWith('FLOW-') || codigo.length < 10) {
    return await enviar(`⚠️ Código no válido.\nEl formato es: *FLOW-XXXXXX*\n\nEscribe *menu* para volver.`);
  }
  try {
    const { getFirestore } = require('firebase-admin/firestore');
    const firestore = getFirestore();
    const doc = await firestore.collection('pedidos').doc(codigo).get();
    if (!doc.exists) {
      return await enviar(`❌ No encontramos un pedido con el código *${codigo}*.\n\nVerifica que el código sea correcto e intenta de nuevo.\n\n0️⃣ Volver al menú`);
    }
    const p = doc.data();
    const fecha = new Date(p.creadoEn).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const estadoEmoji = { 'PENDIENTE': '⏳', 'CONFIRMADO': '✅', 'EN_CAMINO': '🚚', 'ENTREGADO': '📦', 'CANCELADO': '❌' }[p.estado] || '📋';
    await enviar(
      `🔍 *ESTADO DE TU PEDIDO*\n\n📌 Código: *${codigo}*\n${estadoEmoji} Estado: *${p.estado}*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 Cliente: ${p.clienteNombre}\n🏪 Proveedor: ${p.tiendaNombre}\n🛍️ Producto: ${p.producto}\n` +
      `🔢 Cantidad: ${p.cantidad}\n💵 Total: $${(p.total || 0).toLocaleString('es-CO')}\n📅 Fecha: ${fecha}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n0️⃣ Volver al menú`
    );
    resetSesion(fromNumber);
  } catch (err) {
    console.error('❌ Error consultando pedido:', err.message);
    await enviar(`❌ Error al consultar el pedido. Intenta de nuevo.\n\n0️⃣ Volver al menú`);
  }
}

module.exports = { handleCliente, setSesionAdmin, esModoCliente };