const db = require('../services/database');
const ai = require('../services/aiEngine');
const wa = require('../services/whatsapp');
const { google } = require('googleapis');

let negocio = await db.obtenerOCrearNegocio(from);

try {
  const crmService = require('../services/crmService');
  await crmService.upsertContacto(businessId, from, {
    ultimoMensaje: textoMensaje.substring(0, 80),
    nombre: negocio.propietario || negocio.nombre || `+${from}`,
  });
} catch (e) { console.warn('⚠️ CRM:', e.message); }

try {
  const crmService = require('../services/crmService');
  await crmService.upsertContacto(businessId, from, {
    ultimoMensaje: textoMensaje.substring(0, 80),
    nombre: negocio.propietario || negocio.nombre || `+${from}`,
  });
} catch (e) { /* CRM no bloquea el flujo principal */ }

// ── Google Sheets config ──
const SHEET_ID = '1-jWv_hbs7hTFRZHIXqRH2GECm3ErLiSKuI5Kw-QDZ8w';
const SHEET_NAME = 'Ventas';

// ── Sesiones de gestión de pedidos (en memoria) ──
const sesionesGestion = new Map();

// ══════════════════════════════════════════════════════════════
//  ESTADOS DE PEDIDO
// ══════════════════════════════════════════════════════════════
const ESTADOS_PEDIDO = {
  '1': { label: 'Preparando Orden', emoji: '👨‍🍳', codigo: 'PREPARANDO' },
  '2': { label: 'Orden En Camino', emoji: '🚚', codigo: 'EN_CAMINO' },
  '3': { label: 'Orden Entregada - Pago Exitoso', emoji: '✅', codigo: 'ENTREGADO_PAGO_EXITOSO' },
  '4': { label: 'Orden Entregada - Pago Crédito', emoji: '📋', codigo: 'ENTREGADO_PAGO_CREDITO' },
  '5': { label: 'Cancelado', emoji: '❌', codigo: 'CANCELADO' },
};

// ══════════════════════════════════════════════════════════════
//  ACTUALIZAR ESTADO EN FIRESTORE Y GOOGLE SHEETS
// ══════════════════════════════════════════════════════════════
async function actualizarEstadoPedido(codigo, nuevoEstado) {
  const { Firestore } = require('@google-cloud/firestore');
  const firestore = new Firestore({ projectId: process.env.GCLOUD_PROJECT || 'melodic-park-489419-k5' });

  await firestore.collection('pedidos').doc(codigo).update({
    estado: nuevoEstado,
    actualizadoEn: new Date().toISOString(),
  });

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: './google-credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:A`,
    });
    const filas = resp.data.values || [];
    const filaIdx = filas.findIndex(f => f[0] === codigo);
    if (filaIdx !== -1) {
      const filaNum = filaIdx + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!C${filaNum}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[nuevoEstado]] },
      });
      console.log(`✅ Estado actualizado en Sheets fila ${filaNum}: ${nuevoEstado}`);
    } else {
      console.warn(`⚠️ Código ${codigo} no encontrado en Sheets`);
    }
  } catch (err) {
    console.warn(`⚠️ Error actualizando Sheets: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
//  NOTIFICAR AL CLIENTE EL CAMBIO DE ESTADO
// ══════════════════════════════════════════════════════════════
async function notificarClienteCambioEstado(clienteNumero, codigo, estadoInfo, businessId) {
  const mensajes = {
    'PREPARANDO': `👨‍🍳 *¡Tu pedido está siendo preparado!*\n\nEstamos alistando tu orden con todo el cuidado.`,
    'EN_CAMINO': `🚚 *¡Tu pedido ya está en camino!*\n\nEl repartidor está dirigiéndose hacia ti. ¡Prepárate para recibirlo!`,
    'ENTREGADO_PAGO_EXITOSO': `✅ *¡Pedido entregado y pago confirmado!*\n\n¡Gracias por tu compra! Esperamos verte pronto en Flow Marketplace. 🌊`,
    'ENTREGADO_PAGO_CREDITO': `📋 *¡Pedido entregado!*\n\nRecuerda que tienes un saldo pendiente de pago a crédito. Coordina con la tienda el método de pago.`,
    'CANCELADO': `❌ *Tu pedido ha sido cancelado.*\n\nSi tienes dudas, comunícate directamente con la tienda.\n\nEscribe *menu* para hacer un nuevo pedido. 🌊`,
  };
  const clientePhone = `whatsapp:+${clienteNumero.replace(/\D/g, '')}`;
  const msg =
    `📦 *ACTUALIZACIÓN DE TU PEDIDO*\n\n` +
    `📌 Código: *${codigo}*\n` +
    `${estadoInfo.emoji} Estado: *${estadoInfo.label}*\n\n` +
    (mensajes[estadoInfo.codigo] || `Tu pedido ha sido actualizado.`) +
    `\n\n_Escribe *seguimiento* para ver el detalle completo._`;
  try {
    await wa.enviarMensaje(businessId, clientePhone, msg);
    console.log(`✅ Cliente ${clienteNumero} notificado: ${estadoInfo.codigo}`);
  } catch (e) {
    console.warn(`⚠️ No se pudo notificar al cliente: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
//  FLUJO DE GESTIÓN DE PEDIDOS (para la tienda por WhatsApp)
//  La tienda escribe: "pedido FLOW-XXXXXX"
// ══════════════════════════════════════════════════════════════
async function manejarGestionPedido(from, texto, businessId) {
  const sesion = sesionesGestion.get(from) || {};

  const matchCodigo = texto.match(/flow-[a-z0-9]{6}/i);
  if (matchCodigo && !sesion.esperandoEstado) {
    const codigo = matchCodigo[0].toUpperCase();
    try {
      const { Firestore } = require('@google-cloud/firestore');
      const firestore = new Firestore({ projectId: process.env.GCLOUD_PROJECT || 'melodic-park-489419-k5' });
      const doc = await firestore.collection('pedidos').doc(codigo).get();
      if (!doc.exists) {
        await wa.enviarMensaje(businessId, from, `❌ No se encontró el pedido *${codigo}*.\n\nVerifica el código e intenta de nuevo.`);
        return true;
      }
      const p = doc.data();
      const estadoEmojis = {
        'PENDIENTE': '⏳', 'PREPARANDO': '👨‍🍳', 'EN_CAMINO': '🚚',
        'ENTREGADO_PAGO_EXITOSO': '✅', 'ENTREGADO_PAGO_CREDITO': '📋', 'CANCELADO': '❌',
      };
      sesionesGestion.set(from, { esperandoEstado: true, codigo, clienteNumero: p.clienteNumero, pedidoData: p });
      await wa.enviarMensaje(businessId, from,
        `📦 *GESTIÓN DE PEDIDO*\n\n` +
        `📌 Código: *${codigo}*\n` +
        `👤 Cliente: *${p.clienteNombre}* (+${p.clienteNumero})\n` +
        `🛍️ Producto: *${p.producto}* x${p.cantidad}\n` +
        `💵 Total: $${(p.total || 0).toLocaleString('es-CO')}\n` +
        `${estadoEmojis[p.estado] || '📋'} Estado actual: *${p.estado}*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `*¿A qué estado deseas cambiar?*\n\n` +
        `1️⃣ 👨‍🍳 Preparando Orden\n` +
        `2️⃣ 🚚 Orden En Camino\n` +
        `3️⃣ ✅ Orden Entregada — Pago Exitoso\n` +
        `4️⃣ 📋 Orden Entregada — Pago Crédito\n` +
        `5️⃣ ❌ Cancelado\n\n` +
        `0️⃣ Cancelar`
      );
      return true;
    } catch (err) {
      console.error('❌ Error buscando pedido:', err.message);
      await wa.enviarMensaje(businessId, from, `❌ Error al buscar el pedido. Intenta de nuevo.`);
      return true;
    }
  }

  if (sesion.esperandoEstado) {
    if (texto === '0') {
      sesionesGestion.delete(from);
      await wa.enviarMensaje(businessId, from, `✅ Operación cancelada.`);
      return true;
    }
    const estadoElegido = ESTADOS_PEDIDO[texto];
    if (!estadoElegido) {
      await wa.enviarMensaje(businessId, from, `⚠️ Opción no válida. Elige un número del *1* al *5* o *0* para cancelar.`);
      return true;
    }
    const { codigo, clienteNumero, pedidoData } = sesion;
    try {
      await actualizarEstadoPedido(codigo, estadoElegido.codigo);
      await notificarClienteCambioEstado(clienteNumero, codigo, estadoElegido, businessId);
      await wa.enviarMensaje(businessId, from,
        `✅ *¡ESTADO ACTUALIZADO!*\n\n` +
        `📌 Pedido: *${codigo}*\n` +
        `👤 Cliente: *${pedidoData.clienteNombre}*\n` +
        `${estadoElegido.emoji} Nuevo estado: *${estadoElegido.label}*\n\n` +
        `El cliente ha sido notificado automáticamente. 📲`
      );
      sesionesGestion.delete(from);
    } catch (err) {
      console.error('❌ Error actualizando estado:', err.message);
      await wa.enviarMensaje(businessId, from, `❌ Error al actualizar el estado. Intenta de nuevo.`);
    }
    return true;
  }

  return false;
}

// ══════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ══════════════════════════════════════════════════════════════
async function handleMessage(body) {
  try {
    if (!body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      console.log("⚠️ Notificación de WhatsApp sin mensaje (posible lectura de estado).");
      return;
    }

    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const businessId = body.entry[0].changes[0].value.metadata.phone_number_id;
    const textoMensaje = message.text?.body || "";

    // 1. CARGAR NEGOCIO Y FORZAR SUPER ADMIN
    let negocio = await db.obtenerOCrearNegocio(from);
    if (from.includes('3183879336')) {
      negocio.tipo_usuario = 'SUPER_ADMIN';
      negocio.rol_usuario = 'ADMIN';
      negocio.onboarding_completo = true;
      console.log("👑 Identidad Confirmada: Martin Gomez (Super Admin)");
    }

    // 2. INTERCEPTAR GESTIÓN DE PEDIDOS (solo tiendas/admin)
    const esSesionActiva = sesionesGestion.has(from);
    const esComandoPedido = textoMensaje.toLowerCase().includes('flow-') || textoMensaje.toLowerCase().startsWith('pedido');
    if (esComandoPedido || esSesionActiva) {
      if (negocio.tipo_usuario === 'NEGOCIO' || negocio.tipo_usuario === 'SUPER_ADMIN') {
        const manejado = await manejarGestionPedido(from, textoMensaje.toLowerCase(), businessId);
        if (manejado) return;
      }
    }

    // 3. COMANDOS ESPECIALES
    const comandoEspecial = await manejarComandoEspecial(textoMensaje, negocio, businessId, from);
    if (comandoEspecial) return;

    // 4. ONBOARDING
    if (!negocio.onboarding_completo) {
      return await manejarOnboarding(negocio, textoMensaje, businessId, from);
    }

    // 4.5 VERIFICAR PERÍODO DE PRUEBA VENCIDO
    if (
      negocio.tipo_usuario === 'NEGOCIO' &&
      !negocio.comision_aceptada &&
      negocio.en_periodo_prueba
    ) {
      const ahora = new Date();
      const finPrueba = negocio.prueba_fin ? new Date(negocio.prueba_fin) : null;
      if (finPrueba && ahora > finPrueba) {
        // Prueba vencida → interceptar y pedir aceptación
        const cmdCheck = textoMensaje.toUpperCase().trim();
        if (cmdCheck === 'ACEPTO') {
          await db.actualizarNegocio(from, {
            comision_aceptada: true,
            comision_aceptada_en: ahora.toISOString(),
            en_periodo_prueba: false,
          });
          return await wa.enviarMensaje(businessId, from,
            `✅ *¡Comisión aceptada!* Tu tienda *${negocio.nombre}* sigue activa en Flow Marketplace.\n\n` +
            `Recuerda: retenemos el *15%* de cada venta y te transferimos el *85%* restante. 💸\n\n` +
            `¡Continúa gestionando tu negocio como siempre! 🚀`
          );
        }
        // Bloquear y mostrar aviso (máx 1 vez por mensaje)
        return await wa.enviarMensaje(businessId, from,
          `⏰ *Tu período de prueba ha terminado.*\n\n` +
          `Para continuar usando Flow Marketplace debes aceptar nuestra comisión:\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `💸 *15% sobre ventas del marketplace*\n` +
          `• Sin suscripción mensual.\n` +
          `• El pago llega a *Flow.Ai* y te transferimos el *85%*.\n` +
          `• Sin ventas = sin cobros. ✅\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `✅ Escribe *ACEPTO* para reactivar tu tienda.`
        );
      }
    }

    // 5. PROCESAR CON IA Y EJECUTAR ACCIÓN
    const resultado = await ai.procesarMensaje(textoMensaje, negocio);
    await ejecutarAccion(negocio, resultado, businessId, from);

  } catch (error) {
    console.error('❌ [ERROR CRÍTICO]:', error.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  SEGURIDAD Y PERMISOS (RBAC)
// ══════════════════════════════════════════════════════════════
const PERMISOS = {
  NEGOCIO: ['REGISTRAR_VENTA', 'REGISTRAR_INVENTARIO', 'SOLICITAR_DOCS', 'ENVIAR_RECORDATORIO', 'CONSULTA', 'REGISTRAR_COBRO', 'REGISTRAR_GASTO', 'REGISTRAR_PROVEEDOR', 'REGISTRAR_ABONO', 'IMPORTAR'],
  CLIENTE: ['VER_CATEGORIAS', 'BUSCAR_TIENDAS', 'VER_CATALOGO', 'CATALOGO_GLOBAL', 'CONSULTA', 'INICIAR_COMPRA', 'CONFIRMAR_PAGO', 'BUSCAR_PRODUCTO_GLOBAL'],
};
const PERMISOS_INTERNOS = {
  ADMIN: ['REGISTRAR_VENTA', 'REGISTRAR_INVENTARIO', 'SOLICITAR_DOCS', 'ENVIAR_RECORDATORIO', 'CONSULTA', 'REGISTRAR_COBRO', 'REGISTRAR_GASTO', 'REGISTRAR_PROVEEDOR', 'REPORTE', 'REGISTRAR_ABONO', 'IMPORTAR'],
  VENDEDOR: ['REGISTRAR_VENTA', 'REGISTRAR_INVENTARIO', 'CONSULTA', 'REGISTRAR_ABONO'],
};

function tienePermiso(negocio, intencion) {
  const { tipo_usuario, rol_usuario } = negocio;
  if (!tipo_usuario) {
    console.log(`ℹ️ [PERMISOS] Sin tipo_usuario, asumiendo CONSULTA.`);
    return intencion === 'CONSULTA';
  }
  const permisosGenerales = PERMISOS[tipo_usuario] || [];
  if (!permisosGenerales.includes(intencion) && intencion !== 'CONSULTA') {
    console.log(`🚫 [PERMISOS] ${tipo_usuario} no tiene permiso para ${intencion}`);
    return false;
  }
  if (tipo_usuario === 'NEGOCIO') {
    const permisosInternos = PERMISOS_INTERNOS[rol_usuario] || [];
    const tienePermisoInterno = permisosInternos.includes(intencion) || intencion === 'CONSULTA';
    if (!tienePermisoInterno) console.log(`🚫 [PERMISOS] Rol ${rol_usuario} no puede ${intencion}`);
    return tienePermisoInterno;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════
//  EJECUTAR ACCIÓN SEGÚN INTENCIÓN
// ══════════════════════════════════════════════════════════════
async function ejecutarAccion(negocio, analisis, businessId, from) {
  const { intencion, mensaje_usuario, datos, acciones_adicionales } = analisis;
  console.log(`🎯 [INTENCION DETECTADA]: ${intencion}`);

  const esSuperAdmin = from.includes('3183879336');
  if (!esSuperAdmin && !tienePermiso(negocio, intencion)) {
    console.error(`⚠️ BLOQUEO: ${from} (${negocio.tipo_usuario}|${negocio.rol_usuario}) intentó ${intencion}`);
    return await wa.enviarMensaje(businessId, from, "🚫 *Acceso Denegado.* Tu cuenta no tiene permisos para realizar esta acción.");
  }

  switch (intencion) {

    case 'REGISTRAR_VENTA': {
      if (!datos.productos?.length) return await wa.enviarMensaje(businessId, from, mensaje_usuario || "Dime qué vendiste exactamente para registrarlo.");
      const venta = await db.registrarVenta(negocio.phoneId, { ...datos, fecha: new Date().toISOString(), vendedor_id: from });
      console.log(`💰 [VENTA] Guardada con éxito en DB.`);
      await wa.enviarConfirmacionVenta(businessId, from, { venta });
      break;
    }

    case 'REGISTRAR_COBRO': {
      if (!datos.monto) return await wa.enviarMensaje(businessId, from, mensaje_usuario || "¿Cuánto dinero recibiste?");
      await db.registrarCobro(negocio.phoneId, datos);
      const moneda = negocio.configuracion?.moneda || 'COP';
      await wa.enviarMensaje(businessId, from, `✅ *COBRO REGISTRADO*\n\n💵 Monto: ${ai.formatMoney(datos.monto, moneda)}\n👤 Cliente: ${datos.cliente_nombre || 'General'}\n\n_¡Dinero en caja!_ 🎉`);
      break;
    }

    case 'REGISTRAR_INVENTARIO': {
      if (!datos.productos?.length) return await wa.enviarMensaje(businessId, from, mensaje_usuario || "¿Qué productos y cuántas cantidades quieres registrar?");
      for (const p of datos.productos) await db.actualizarStock(negocio.phoneId, p.nombre, p.cantidad, p.precio);
      await wa.enviarMensaje(businessId, from,
        `📦 *INVENTARIO ACTUALIZADO*\n\n` +
        datos.productos.map(p => `✅ ${p.nombre}: +${p.cantidad}`).join('\n') +
        `\n\n_¡Stock al día!_ 🚀`
      );
      break;
    }

    case 'EXPORTAR_PDF': {
      await wa.enviarMensaje(businessId, from, "⏳ *Generando tu reporte en PDF...* Un momento por favor.");
      try {
        const transacciones = await db.getTransaccionesPeriodo(negocio.phoneId, 7);
        const moneda = negocio.moneda || 'COP';
        const datosReporte = {
          usuario: negocio.nombre, moneda,
          items: transacciones.map(t => ({
            fecha: new Date(t.timestamp).toLocaleDateString('es-CO'),
            tipo: t.tipo,
            monto: ai.formatMoney(t.total || t.monto, moneda),
          })),
          total: ai.formatMoney(transacciones.reduce((acc, t) => acc + (t.total || t.monto || 0), 0), moneda),
        };
        // const pdfUrl = await pdfService.generarYSubir(datosReporte);
        // await wa.enviarDocumento(businessId, from, pdfUrl, "Reporte_FlowAi.pdf");
        await wa.enviarMensaje(businessId, from, "✅ *Reporte listo.*\n\n_(Para descarga real, configura Firebase Storage o AWS)_");
      } catch (err) {
        console.error("Error PDF:", err);
        await wa.enviarMensaje(businessId, from, "❌ Hubo un error al generar el archivo PDF.");
      }
      break;
    }

    case 'REGISTRAR_GASTO': {
      if (!datos.monto) return await wa.enviarMensaje(businessId, from, mensaje_usuario || "¿Cuánto gastaste y en qué?");
      await db.registrarGasto(negocio.phoneId, datos);
      const moneda = negocio.moneda || 'COP';
      let extraProv = datos.proveedor_nombre ? `\n🏢 Proveedor: ${datos.proveedor_nombre}` : "";
      await wa.enviarMensaje(businessId, from, `📉 *GASTO REGISTRADO*\n\n💰 Monto: ${ai.formatMoney(datos.monto, moneda)}\n📝 Motivo: ${datos.gasto_descripcion || 'No especificado'}${extraProv}\n\n_Egreso contabilizado correctamente._ 💸`);
      break;
    }

    case 'REGISTRAR_PROVEEDOR': {
      if (!datos.nombre) return await wa.enviarMensaje(businessId, from, mensaje_usuario || "¿Cómo se llama el proveedor?");
      await db.registrarProveedor(negocio.phoneId, datos);
      await wa.enviarMensaje(businessId, from, `🤝 *PROVEEDOR REGISTRADO*\n\n✅ Nombre: ${datos.nombre}\n\n_Ahora puedes asociar gastos a este proveedor._`);
      break;
    }

    case 'IMPORTAR': {
      if (!datos.items?.length || !datos.sub_coleccion) return await wa.enviarMensaje(businessId, from, mensaje_usuario || "Dime qué lista quieres importar (clientes o productos).");
      await wa.enviarMensaje(businessId, from, `⚙️ *Procesando ingesta masiva de ${datos.items.length} registros...*`);
      const realSubColl = datos.sub_coleccion === 'clientes' ? db.COLECCIONES.CLIENTES_COLECCION : db.COLECCIONES.INVENTARIO;
      await db.registrarEnLote(negocio.phoneId, realSubColl, datos.items);
      await wa.enviarMensaje(businessId, from, `✅ *IMPORTACIÓN EXITOSA*\n\n📊 Se han registrado *${datos.items.length}* elementos en la sección de *${datos.sub_coleccion}*.\n\n_¡Tu base de datos está creciendo!_ 🚀`);
      break;
    }

    case 'REGISTRAR_ABONO': {
      if (!datos.monto) return await wa.enviarMensaje(businessId, from, mensaje_usuario || "¿Cuánto dinero abonó el cliente?");
      const bId = negocio.phoneId;
      let ventaId = datos.venta_id;
      if (!ventaId) {
        const transacciones = await db.getTransaccionesPeriodo(bId, 180);
        const deudas = transacciones.filter(t =>
          t.tipo === 'VENTA' && t.metodo_pago === 'CREDITO' && !t.pagado &&
          (datos.cliente_nombre ? t.cliente_nombre?.toLowerCase().includes(datos.cliente_nombre.toLowerCase()) : true)
        );
        if (deudas.length === 0) return await wa.enviarMensaje(businessId, from, `❌ No encontré deudas pendientes para ${datos.cliente_nombre || 'este cliente'}.`);
        if (deudas.length > 1) {
          const lista = deudas.map(d => `• ID: ${d.id} - Saldo: ${ai.formatMoney(d.monto_pendiente, negocio.moneda)}`).join('\n');
          return await wa.enviarMensaje(businessId, from, `🤔 El cliente tiene varias deudas:\n\n${lista}\n\n_Por favor especifica el ID o abona al total._`);
        }
        ventaId = deudas[0].id;
      }
      const { nuevoMontoPendiente, pagadoCompletamente } = await db.registrarAbono(bId, ventaId, datos.monto);
      const moneda = negocio.moneda || 'COP';
      let msg = `✅ *ABONO REGISTRADO*\n\n💵 Monto: ${ai.formatMoney(datos.monto, moneda)}\n📉 Saldo Pendiente: ${ai.formatMoney(nuevoMontoPendiente, moneda)}`;
      if (pagadoCompletamente) msg += `\n\n🎉 *¡DEUDA PAGADA POR COMPLETO!*`;
      await wa.enviarMensaje(businessId, from, msg);
      break;
    }

    case 'SOLICITAR_DOCS': {
      const { tipo_documento, cliente_nombre } = datos;
      const msg = `📑 *SOLICITUD DE DOCUMENTOS*\n\nHola ${cliente_nombre || 'Cliente'}, el negocio *${negocio.nombre}* solicita tu *${tipo_documento || 'Documentación Legal'}* para completar el proceso.\n\n_Favor adjuntar foto o PDF aquí._`;
      await wa.enviarMensaje(businessId, from, msg);
      break;
    }

    case 'ENVIAR_RECORDATORIO': {
      const { cliente_nombre, total } = datos;
      const msg = `🔔 *RECORDATORIO DE PAGO*\n\nHola ${cliente_nombre || 'Cliente'}, te saludamos de *${negocio.nombre}*. Te recordamos que tienes un saldo pendiente de *${negocio.moneda} ${total || ''}*.\n\n_Cualquier duda, estamos atentos. ¡Gracias!_`;
      await wa.enviarMensaje(businessId, from, msg);
      break;
    }

    case 'VER_CATEGORIAS': {
      await db.actualizarNegocio(from, { tienda_actual_id: null });
      const tiendas = await db.listarTodasLasTiendas();
      if (tiendas.length === 0) return await wa.enviarMensaje(businessId, from, "Aún no hay tiendas registradas en el ecosistema Flow-Ai. ¡Vuelve pronto! 🌊");
      const conteoCategorias = tiendas.reduce((acc, t) => {
        const cat = t.industria || 'Otras';
        acc[cat] = (acc[cat] || 0) + 1;
        return acc;
      }, {});
      const listaMsg = `🏷️ *CATEGORÍAS DE FLOW-AI*\n\nExplora los sectores de nuestros comercios aliados:\n\n` +
        Object.entries(conteoCategorias).map(([nombre, cantidad]) => `🔹 *${nombre}* (${cantidad} tienda/s)`).join('\n') +
        `\n\n_Escribe el nombre de una categoría para ver sus tiendas (Ej: "Ver tiendas de ${Object.keys(conteoCategorias)[0]}")._`;
      await wa.enviarMensaje(businessId, from, listaMsg);
      break;
    }

    case 'BUSCAR_TIENDAS': {
      await db.actualizarNegocio(from, { tienda_actual_id: null });
      const tiendas = await db.listarTodasLasTiendas();
      if (tiendas.length === 0) return await wa.enviarMensaje(businessId, from, "Aún no hay tiendas registradas. ¡Vuelve pronto! 🌊");
      const filtroCategoria = datos.categoria;
      const tiendasFiltradas = filtroCategoria
        ? tiendas.filter(t => t.industria?.toLowerCase().includes(filtroCategoria.toLowerCase()))
        : tiendas;
      if (tiendasFiltradas.length === 0) return await wa.enviarMensaje(businessId, from, `No encontré tiendas en "${filtroCategoria}". Escribe "Ver categorías" para ver las disponibles.`);
      const titulo = filtroCategoria ? `🛍️ *TIENDAS DE ${filtroCategoria.toUpperCase()}*` : `🛍️ *TODAS LAS TIENDAS*`;
      const listaMsg = `${titulo}\n\nSelecciona una para ver su catálogo:\n\n` +
        tiendasFiltradas.map(t => `🔹 *${t.nombre}*`).join('\n') +
        `\n\n_Escribe el nombre de una tienda para entrar a su catálogo (Ej: "Entrar a ${tiendasFiltradas[0].nombre}")._`;
      await wa.enviarMensaje(businessId, from, listaMsg);
      break;
    }

    case 'VER_CATALOGO': {
      const nombreTienda = datos.nombre_tienda;
      const tiendas = await db.listarTodasLasTiendas();
      const tiendaEncontrada = tiendas.find(t => t.nombre.toLowerCase().includes(nombreTienda?.toLowerCase()));
      if (tiendaEncontrada) {
        await db.actualizarNegocio(from, { tienda_actual_id: tiendaEncontrada.phoneId });
        console.log(`🔗 [ANCLAJE] El usuario ${from} ahora navega por la tienda ${tiendaEncontrada.phoneId}`);
        const infoTienda = await db.obtenerNegocioCompleto(tiendaEncontrada.phoneId);
        const catalogo = infoTienda.productos.length > 0
          ? `📖 *CATÁLOGO DE ${tiendaEncontrada.nombre.toUpperCase()}*\n\n` +
          infoTienda.productos.map(p => `• ${p.nombre}: $${ai.formatMoney(p.precio, infoTienda.moneda)} (Stock: ${p.stock})`).join('\n') +
          `\n\n💬 *¿Quieres comprar algo?*\nSolo dímelo. Ejemplo: "Quiero 2 unidades del primero".`
          : `El negocio ${tiendaEncontrada.nombre} aún no tiene productos registrados.`;
        await wa.enviarMensaje(businessId, from, catalogo);
      } else {
        await wa.enviarMensaje(businessId, from, `No pudimos encontrar la tienda "${nombreTienda}". Escribe *BUSCAR TIENDAS* para ver la lista.`);
      }
      break;
    }

    case 'CATALOGO_GLOBAL': {
      await db.actualizarNegocio(from, { tienda_actual_id: null });
      const productos = await db.obtenerProductosGlobales();
      if (productos.length === 0) return await wa.enviarMensaje(businessId, from, "Aún no hay productos registrados en las tiendas de Flow-Ai. 🌊");
      const agrupados = productos.reduce((acc, p) => {
        if (!acc[p.tienda]) acc[p.tienda] = [];
        acc[p.tienda].push(p);
        return acc;
      }, {});
      let globalMsg = `🌎 *CATÁLOGO GLOBAL FLOW-AI*\n\nMira lo que ofrecen nuestros socios:\n\n`;
      for (const [tienda, prods] of Object.entries(agrupados)) {
        globalMsg += `🏬 *${tienda.toUpperCase()}*\n`;
        globalMsg += prods.map(p => `  • ${p.nombre}: $${ai.formatMoney(p.precio, 'COP')}`).join('\n') + `\n\n`;
      }
      globalMsg += `👉 *Escribe el nombre de la tienda* para ver su catálogo completo.\n\n🌊 _Flow-Ai: Conectando negocios y clientes._`;
      await wa.enviarMensaje(businessId, from, globalMsg);
      break;
    }

    case 'BUSCAR_PRODUCTO_GLOBAL': {
      const nombreProducto = datos.producto_nombre;
      if (!nombreProducto) return await wa.enviarMensaje(businessId, from, "Ok, dime el nombre del producto que quieres buscar.");
      await wa.enviarMensaje(businessId, from, `🔎 Buscando "${nombreProducto}" en todas las tiendas...`);
      const productos = await db.buscarProductoGlobal(nombreProducto);
      if (!productos || productos.length === 0) return await wa.enviarMensaje(businessId, from, `😔 No encontré el producto "${nombreProducto}" en ninguna de nuestras tiendas aliadas.`);
      const agrupados = productos.reduce((acc, p) => {
        if (!acc[p.tienda]) acc[p.tienda] = [];
        acc[p.tienda].push(p);
        return acc;
      }, {});
      let resultsMsg = `✅ *Resultados para "${nombreProducto}":*\n\n`;
      for (const [tienda, prods] of Object.entries(agrupados)) {
        resultsMsg += `🏬 *${tienda.toUpperCase()}*\n`;
        resultsMsg += prods.map(p => `  • ${p.nombre}: $${ai.formatMoney(p.precio, 'COP')} (Stock: ${p.stock})`).join('\n') + `\n\n`;
      }
      resultsMsg += `_Para comprar, escribe "Entrar a [nombre de la tienda]" y luego haz tu pedido._`;
      await wa.enviarMensaje(businessId, from, resultsMsg);
      break;
    }

    case 'INICIAR_COMPRA': {
      if (!negocio.tienda_actual_id || !negocio.tienda_contexto) {
        return await wa.enviarMensaje(businessId, from, '❌ No tienes ninguna tienda seleccionada. Por favor, primero explora el catálogo de una tienda.');
      }
      const tiendaActual = negocio.tienda_contexto;
      if (!datos.productos?.length) return await wa.enviarMensaje(businessId, from, '¿Qué deseas comprar exactamente?');
      const totalCompra = datos.productos.reduce((acc, p) => acc + ((p.precio || 0) * (p.cantidad || 1)), 0);
      const listadoProductos = datos.productos.map(p => `• ${p.cantidad}x ${p.nombre} - $${ai.formatMoney(p.precio * p.cantidad, tiendaActual.moneda)}`).join('\n');
      const linkPago = tiendaActual.configuracion?.stripe_link || '_(Link de pago no configurado por la tienda)_';
      let resumenCliente = `🛒 *RESUMEN DE TU COMPRA*\n\n` +
        `Tienda: *${tiendaActual.nombre}*\n\nProductos:\n${listadoProductos}\n\n` +
        `💰 *TOTAL a pagar:* ${ai.formatMoney(totalCompra, tiendaActual.moneda)}\n\n` +
        `Para confirmar tu pedido, realiza el pago aquí:\n🔗 ${linkPago}\n\n` +
        `⚠️ *IMPORTANTE*: Cuando termines el pago responde *"¡Listo, ya pagué!"* para notificar a la tienda y procesar tu envío de inmediato.`;
      await wa.enviarMensaje(businessId, from, resumenCliente);
      let dueñoMsj = `💰 *¡NUEVO LEAD EN CAMINO!*\n\nEl cliente ${from} está intentando comprar en Flow-Ai:\n\n` +
        `🛒 Carrito:\n${listadoProductos}\n💰 Total: ${ai.formatMoney(totalCompra, tiendaActual.moneda)}\n\n` +
        `💬 Contacta directamente: wa.me/${from}\nRevisa tus pagos para confirmar si se completó.`;
      await wa.enviarMensaje(businessId, tiendaActual.phoneId, dueñoMsj);
      break;
    }

    case 'CONFIRMAR_PAGO': {
      if (!negocio.tienda_actual_id) return await wa.enviarMensaje(businessId, from, "Actualmente no estás en una tienda. Escribe 'Ver categorías' para explorar y comprar.");
      const tiendaId = negocio.tienda_actual_id;
      const tienda = await db.obtenerNegocioCompleto(tiendaId);
      let dueñoMsj = `✅ *PAGO CONFIRMADO POR CLIENTE*\n\n` +
        `El cliente *${from}* acaba de informar que realizó el pago en tu link de Stripe.\n\n` +
        `👉 *Acción requerida:* Por favor revisa tu cuenta (o notificaciones de Stripe) para confirmar el ingreso y luego contacta a este número para coordinar la entrega.`;
      await wa.enviarMensaje(businessId, tienda.phoneId, dueñoMsj);
      let respuestaCliente = `🙌 ¡Excelente! Ya le hemos notificado directamente al dueño de *${tienda.nombre}* que realizaste el pago.\n\n` +
        `Ellos verificarán la transacción y se pondrán en contacto contigo por este medio muy pronto para coordinar la entrega de tu pedido. ¡Gracias por usar Flow-Ai! 🌊`;
      await wa.enviarMensaje(businessId, from, respuestaCliente);
      break;
    }

    default: {
      const respuesta = mensaje_usuario || "Entendido. ¿En qué más puedo ayudarte con tu negocio?";
      await wa.enviarMensaje(businessId, from, respuesta);
      break;
    }
  }

  if (acciones_adicionales?.includes('ALERTAR_STOCK_BAJO')) {
    const alerta = await ai.generarAlertaStockBajo(negocio);
    if (alerta) await wa.enviarMensaje(businessId, from, alerta);
  }
}

// ══════════════════════════════════════════════════════════════
//  ONBOARDING (FLUJO DE BIENVENIDA)
// ══════════════════════════════════════════════════════════════
async function manejarOnboarding(negocio, mensaje, businessId, from) {
  const textoReal = typeof mensaje === 'string' ? mensaje : (mensaje.body || "");
  const cmd = textoReal.toUpperCase().trim();

  if (cmd === 'REINICIAR') {
    await db.actualizarNegocio(from, {
      onboarding_paso: 'inicio', onboarding_completo: false,
      nombre: null, propietario: null, industria: null, tipo_usuario: null,
    });
    return await wa.enviarMensaje(businessId, from, "🔄 *Proceso reiniciado.* \n\nEscribe *EMPEZAR* para crear tu perfil de negocio desde cero.");
  }

  const paso = negocio.onboarding_paso || 'inicio';

  if (paso === 'inicio') {
    const bienvenida =
      `🌊 *¡Bienvenido a FLOW-AI!* 🚀\n\n` +
      `Soy tu asistente inteligente diseñado para que tu negocio crezca sin límites directamente desde WhatsApp.\n\n` +
      `*Para empezar, dinos quién eres:*\n` +
      `1️⃣ Escribe *1* si eres el **Dueño del Negocio / Vendedor**\n` +
      `2️⃣ Escribe *2* si eres un **Cliente Final** (Para consultar tus deudas o catálogo del vendedor)\n\n` +
      `🎤 *Audio y Texto*: ¡Háblame o escríbeme, te entiendo perfecto!`;
    const mediaUrl = "https://res.cloudinary.com/dusha2zjd/image/upload/v1772674679/bienvenida_osl7nm.jpg";
    await wa.enviarMensaje(businessId, from, bienvenida, mediaUrl);
    await db.actualizarNegocio(from, { onboarding_paso: 'seleccionar_rol', nombre: 'Nuevo Usuario' });
    return;
  }

  if (paso === 'seleccionar_rol') {
    if (cmd === '1' || cmd.includes('NEGOCIO') || cmd.includes('DUEÑO') || cmd.includes('VENDEDOR')) {
      await db.actualizarNegocio(from, { tipo_usuario: 'NEGOCIO', onboarding_paso: 'negocio_inicio' });
      return await wa.enviarMensaje(businessId, from,
        `🎬 *¡Excelente decisión, Empresario!* 🚀\n\n` +
        `*Flow-Ai te permite:*\n` +
        `✅ *Registrar Ventas*: "Vendí 3 cafés a $15k a Carlos"\n` +
        `✅ *Mora*: "¿Quiénes me deben hoy?"\n` +
        `✅ *Stock*: "Llegaron 50 Camisas XL"\n\n` +
        `👉 Escribe *EMPEZAR* para registrar tu tienda.`
      );
    } else if (cmd === '2' || cmd.includes('CLIENTE')) {
      await db.actualizarNegocio(from, { tipo_usuario: 'CLIENTE', onboarding_completo: true });
      return await wa.enviarMensaje(businessId, from,
        `👋 *¡Hola Cliente!*\n\n` +
        `*Bienvenido al Marketplace de Flow-Ai. Aquí podrás:*\n` +
        `🔎 *Buscar un producto*: Escribe "Busca [nombre del producto]" para encontrarlo en todas las tiendas.\n` +
        `🏷️ *Ver Categorías*: Escribe "Ver categorías" para explorar los sectores.\n` +
        `🛍️ *Ver Tiendas*: Múltiples comercios listos para atenderte desde un mismo chat.\n\n` +
        `_¿Qué quieres hacer hoy? Prueba escribiendo: "Busca Dolex"_`
      );
    } else {
      return await wa.enviarMensaje(businessId, from, "Por favor, elige una opción válida:\n1. Soy Dueño de Negocio\n2. Soy Cliente Final");
    }
  }

  if (paso === 'negocio_inicio') {
    if (cmd === 'EMPEZAR') {
      await db.actualizarNegocio(from, { onboarding_paso: 'nombre' });
      return await wa.enviarMensaje(businessId, from, `*Paso 1 de 3:* ¿Cuál es el nombre de tu Empresa o Negocio? (Ej: _Naked_)`);
    } else {
      await wa.enviarMensaje(businessId, from, `👉 Escribe *EMPEZAR* para registrar tu tienda.`);
    }
    return;
  }

  if (paso === 'nombre') {
    const nombreNegocio = mensaje.trim();
    await db.actualizarNegocio(from, { nombre: nombreNegocio, onboarding_paso: 'propietario' });
    return await wa.enviarMensaje(businessId, from, `¡Excelente, *${nombreNegocio}*! 🎉\n\n*Paso 2 de 3:* ¿A nombre de quién estará registrada la cuenta principal? (Dime tu nombre completo)\n\n_(Escribe *REINICIAR* para volver al inicio)_`);
  }

  if (paso === 'propietario') {
    const nombrePropietario = mensaje.trim();
    await db.actualizarNegocio(from, { propietario: nombrePropietario, onboarding_paso: 'identificacion' });
    return await wa.enviarMensaje(businessId, from, `Mucho gusto, *${nombrePropietario}*. 👋\n\n*Paso 3 de 3:* ¿Cuál es tu Cédula o NIT? (Para filtrado y seguridad)\n\n_(Escribe *REINICIAR* para volver al inicio)_`);
  }

  if (paso === 'identificacion') {
    const id = mensaje.trim();
    if (id.length < 5) return await wa.enviarMensaje(businessId, from, "⚠️ *Por favor, ingresa una identificación válida.* \n\nDebe tener al menos 6 caracteres (Cédula o NIT).");
    await db.actualizarNegocio(from, { identificacion: id, onboarding_paso: 'industria' });
    return await wa.enviarMensaje(businessId, from,
      `Perfecto. ✅\n\n*Paso 4 de 4: ¿A qué industria pertenece tu negocio?*\n\n` +
      `1️⃣ Comida / Restaurante\n2️⃣ Ropa / Moda\n3️⃣ Salud / Bienestar\n4️⃣ Tecnología / Electrónica\n` +
      `5️⃣ Hogar / Ferretería\n6️⃣ Servicios Profesionales\n7️⃣ Educación\n8️⃣ Belleza / Estética\n9️⃣ Otro\n\n` +
      `👉 *Escribe el número o el nombre de tu industria.*`
    );
  }

  if (paso === 'industria') {
    let industria = mensaje.trim();
    const mapaIndustrias = {
      '1': 'Comida / Restaurante', '2': 'Ropa / Moda', '3': 'Salud / Bienestar',
      '4': 'Tecnología / Electrónica', '5': 'Hogar / Ferretería', '6': 'Servicios Profesionales',
      '7': 'Educación', '8': 'Belleza / Estética', '9': 'Otro',
    };
    if (mapaIndustrias[industria]) {
      industria = mapaIndustrias[industria];
    } else if (industria === '9' || industria.toLowerCase().includes('otro')) {
      if (industria === '9' || industria.toLowerCase() === 'otro') {
        return await wa.enviarMensaje(businessId, from, "Entendido. ¿Me podrías decir cuál es tu industria entonces? (Ej: _Artesanías_)");
      }
    }
    await db.actualizarNegocio(from, { industria, onboarding_paso: 'email' });
    return await wa.enviarMensaje(businessId, from,
      `✅ Industria registrada.\n\n📧 *¿Cuál es el email de tu tienda?*\n\n_(Ej: ventas@minegocio.com)_\n\n_Escribe *SALTAR* si no tienes uno._`
    );
  }
  if (paso === 'email') {
    const email = cmd === 'SALTAR' ? '' : mensaje.trim().toLowerCase();
    await db.actualizarNegocio(from, { email, onboarding_paso: 'web' });
    return await wa.enviarMensaje(businessId, from,
      `✅ Email registrado.\n\n🌐 *¿Tienes sitio web o Instagram?*\n\n_(Ej: https://minegocio.com o @minegocio)_\n\n_Escribe *SALTAR* si no tienes._`
    );
  }

  if (paso === 'web') {
    const web = cmd === 'SALTAR' ? '' : mensaje.trim();
    await db.actualizarNegocio(from, { web, onboarding_paso: 'confirmar_datos' });
    return await wa.enviarMensaje(businessId, from,
      `📝 *RESUMEN DE TU PERFIL:*\n\n` +
      `🏢 *Negocio:* ${negocio.nombre || 'No definido'}\n` +
      `👤 *Dueño:* ${negocio.propietario || 'No definido'}\n` +
      `🆔 *ID/NIT:* ${negocio.identificacion || 'No definido'}\n` +
      `📦 *Industria:* ${negocio.industria || 'No definido'}\n` +
      `📧 *Email:* ${negocio.email || 'No definido'}\n` +
      `🌐 *Web:* ${web || 'No definido'}\n\n` +
      `¿Es correcta esta información?\n✅ Escribe *SÍ* para finalizar.\n❌ Escribe *REINICIAR* si quieres cambiar algo.`
    );
  }
  if (paso === 'confirmar_datos') {
    if (cmd === 'SÍ' || cmd === 'SI' || cmd === 'S') {
      // Ir al paso de aceptación de comisión (siempre la primera vez)
      await db.actualizarNegocio(from, { onboarding_paso: 'aceptar_comision' });
      return await wa.enviarMensaje(businessId, from,
        `📋 *CONDICIONES DE USO — FLOW MARKETPLACE*\n\n` +
        `Antes de activar tu tienda, necesitamos que conozcas y aceptes nuestra única condición:\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💸 *COMISIÓN: 15% sobre ventas*\n\n` +
        `• Flow.Ai *NO cobra suscripción mensual*.\n` +
        `• Solo retenemos el *15%* del valor de cada venta realizada a través del marketplace.\n` +
        `• El pago de los clientes llega a la cuenta bancaria de *Flow.Ai*.\n` +
        `• Luego te transferimos el *85% restante* directamente a tu cuenta.\n` +
        `• Sin ventas = sin cobros. Solo pagas cuando ganas. ✅\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `¿Aceptas estas condiciones?\n\n` +
        `✅ Escribe *ACEPTO* para activar tu tienda.\n` +
        `⏳ Escribe *PRUEBA* para iniciar 7 días de prueba gratuita.`
      );
    } else {
      return await wa.enviarMensaje(businessId, from, "Por favor, escribe *SÍ* para confirmar o *REINICIAR* para empezar de nuevo.");
    }
  }

  // ── ACEPTACIÓN DE COMISIÓN DEL 15% ──────────────────────────
  if (paso === 'aceptar_comision') {
    const industriaFinal = negocio.industria || 'Otro';
    const mapaEjemplos = {
      'Comida / Restaurante': 'Vendí 2 hamburguesas combo por $45.000 a Juan',
      'Ropa / Moda': 'Vendí una chaqueta de cuero en $250.000 a Sofia',
      'Salud / Bienestar': 'Realicé una consulta de bienestar de $120.000 a Carlos',
      'Tecnología / Electrónica': 'Vendí unos audífonos bluetooth por $150.000',
      'Hogar / Ferretería': 'Vendí un taladro percutor en $300.000',
      'Servicios Profesionales': 'Facturé $500.000 por asesoría técnica a Sandra',
      'Educación': 'Inscribí a Laura en el taller de cocina por $200.000',
      'Belleza / Estética': 'Realicé una limpieza facial de $90.000 a Paula',
      'Otro': 'Vendí un producto por $50.000',
    };
    const ejemplo = mapaEjemplos[industriaFinal] || mapaEjemplos['Otro'];

    if (cmd === 'ACEPTO') {
      // Aceptó: activar tienda completa y marcar comisión aceptada PERMANENTEMENTE
      const ahora = new Date();
      await db.actualizarNegocio(from, {
        onboarding_completo: true,
        phoneId: from,
        comision_aceptada: true,
        comision_aceptada_en: ahora.toISOString(),
        en_periodo_prueba: false,
        activo: true,
        tipo_usuario: 'NEGOCIO',
      });
      await wa.enviarMensaje(businessId, from, "⚙️ *Configurando tu entorno de trabajo profesional...*");
      return await wa.enviarMensaje(businessId, from,
        `🎉 *¡TODO LISTO, BIENVENIDO A BORDO!* 🌊\n\n` +
        `Tu tienda *${negocio.nombre}* está activa en Flow Marketplace.\n\n` +
        `💡 *Cómo empezar*: Escribe o envía un audio diciendo:\n_"${ejemplo}"_\n\n` +
        `🛍️ Para gestionar pedidos escribe: _"pedido FLOW-XXXXXX"_\n` +
        `📊 Para ver tu reporte escribe: _"REPORTE"_\n\n` +
        `¡Yo me encargo del resto! 🚀`
      );

    } else if (cmd === 'PRUEBA') {
      // Período de prueba: 7 días. Al vencerse se le vuelve a preguntar.
      const ahora = new Date();
      const finPrueba = new Date();
      finPrueba.setDate(ahora.getDate() + 7);
      await db.actualizarNegocio(from, {
        onboarding_completo: true,
        phoneId: from,
        comision_aceptada: false,
        en_periodo_prueba: true,
        prueba_inicio: ahora.toISOString(),
        prueba_fin: finPrueba.toISOString(),
        activo: true,
        tipo_usuario: 'NEGOCIO',
      });
      await wa.enviarMensaje(businessId, from, "⚙️ *Configurando tu entorno de trabajo profesional...*");
      return await wa.enviarMensaje(businessId, from,
        `✅ *¡PERÍODO DE PRUEBA ACTIVADO!* 🌊\n\n` +
        `Tienes *7 días gratuitos* para explorar Flow Marketplace.\n` +
        `📅 Tu prueba vence el *${finPrueba.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' })}*.\n\n` +
        `Al terminar la prueba te pediremos que aceptes la comisión del 15% para continuar.\n\n` +
        `💡 *Empieza ahora*: _"${ejemplo}"_\n\n` +
        `🛍️ Gestiona pedidos con: _"pedido FLOW-XXXXXX"_\n` +
        `📊 Ve tu reporte con: _"REPORTE"_ 🚀`
      );

    } else {
      return await wa.enviarMensaje(businessId, from,
        `Por favor responde:\n\n` +
        `✅ *ACEPTO* — Activar tienda con 15% de comisión.\n` +
        `⏳ *PRUEBA* — Iniciar 7 días de prueba gratuita.`
      );
    }
  }

  if (paso === 'ingesta_inicio') {
    if (cmd === '1' || cmd.includes('PRODUCTO') || cmd.includes('CATALOGO')) {
      await db.actualizarNegocio(from, { onboarding_paso: 'ingesta_catalogo' });
      return await wa.enviarMensaje(businessId, from, "📦 *MODO CARGA DE CATÁLOGO*\n\nEnvíame un audio o texto con la lista de tus productos y sus precios.\n\n_Ejemplo: 'Vendo tintos a $2000 y buñuelos a $1500'_");
    } else if (cmd === '2' || cmd.includes('EMPRESA') || cmd.includes('NEGOCIO') || cmd.includes('SOBRE')) {
      await db.actualizarNegocio(from, { onboarding_paso: 'ingesta_descripcion' });
      return await wa.enviarMensaje(businessId, from, "🏢 *MODO PERFIL DE EMPRESA*\n\nCuéntame un poco más sobre tu negocio: ¿Qué hacen? ¿Cuál es su horario? ¿Tienen políticas de pago o envío?\n\n_Escríbelo con total libertad, yo aprenderé de lo que me digas._");
    } else {
      return await wa.enviarMensaje(businessId, from, "Por favor, elige:\n1️⃣ Cargar Catálogo\n2️⃣ Contarme sobre tu Empresa");
    }
  }

  if (paso === 'ingesta_catalogo') {
    const resultado = await ai.procesarMensaje(mensaje, negocio);
    if (resultado.intencion === 'REGISTRAR_INVENTARIO' && resultado.datos.productos?.length > 0) {
      await ejecutarAccion(negocio, resultado, businessId, from);
      await db.actualizarNegocio(from, { onboarding_paso: 'finalizado', onboarding_completo: true });
      const resumen = `✅ *CARGA EXITOSA:*\n\n` +
        resultado.datos.productos.map(p => `🔹 ${p.nombre}: $${p.precio} (Stock: ${p.cantidad})`).join('\n') +
        `\n\nTu catálogo está configurado. ¡Flow-Ai ya puede empezar a vender por ti! 🚀`;
      return await wa.enviarMensaje(businessId, from, resumen);
    } else {
      return await wa.enviarMensaje(businessId, from, "🤔 No logré extraer los productos claramente. \n\n*Prueba con un formato simple, ej:*\n_Zapato $100.000 (10 unidades), Camisa $50.000 (5 unidades)_");
    }
  }

  if (paso === 'ingesta_descripcion') {
    await db.actualizarNegocio(from, { descripcion: mensaje, onboarding_paso: 'finalizado', onboarding_completo: true });
    return await wa.enviarMensaje(businessId, from, "📝 *¡Perfil de empresa guardado!* \n\nHe aprendido sobre tu negocio. Ya puedes usar Flow-Ai normalmente. \n\n💡 *Prueba ahora*: Pregúntame algo sobre lo que me acabas de contar.");
  }
}

// ══════════════════════════════════════════════════════════════
//  HELPERS & COMANDOS ESPECIALES
// ══════════════════════════════════════════════════════════════
async function manejarComandoEspecial(texto, negocio, businessId, from) {
  const cmd = texto.toUpperCase().trim();

  if (cmd === 'REINICIAR') {
    await db.actualizarNegocio(from, {
      onboarding_paso: 'inicio', onboarding_completo: false,
      nombre: null, propietario: null, identificacion: null, industria: null,
    });
    await wa.enviarMensaje(businessId, from, "🔄 *Cuenta reseteada.* \n\nTu perfil ha sido borrado. Escribe *EMPEZAR* para crear uno nuevo.");
    return true;
  }

  if (cmd === 'AYUDA') {
    await manejarAyuda(businessId, from);
    return true;
  }

  if (cmd.startsWith('AGREGAR VENDEDOR')) {
    if (negocio.rol_usuario !== 'ADMIN') {
      await wa.enviarMensaje(businessId, from, "🚫 Solo el administrador puede agregar vendedores.");
      return true;
    }
    const nuevoNumero = cmd.replace('AGREGAR VENDEDOR', '').replace(/\s+/g, '').replace('+', '');
    if (!nuevoNumero || nuevoNumero.length < 10) {
      await wa.enviarMensaje(businessId, from, "❌ Formato incorrecto. Usa: *AGREGAR VENDEDOR 57300...*");
      return true;
    }
    await db.vincularColaborador(negocio.phoneId, nuevoNumero, 'VENDEDOR');
    await wa.enviarMensaje(businessId, from, `✅ *¡VENDEDOR VINCULADO!*\n\nEl número *${nuevoNumero}* ahora puede registrar ventas e inventario en *${negocio.nombre}*. 🚀`);
    return true;
  }

  // REPORTE DE VENTAS — filtra por período opcional
  if (cmd === 'REPORTE' || cmd === 'REPORTE HOY' || cmd === 'REPORTE SEMANA' || cmd === 'REPORTE MES' || cmd === 'MIS VENTAS') {
    if (negocio.tipo_usuario !== 'NEGOCIO' && negocio.tipo_usuario !== 'SUPER_ADMIN') {
      await wa.enviarMensaje(businessId, from, "🚫 El reporte de ventas solo está disponible para administradores de tienda.");
      return true;
    }
    let periodo = 'semana';
    if (cmd.includes('HOY')) periodo = 'hoy';
    if (cmd.includes('MES')) periodo = 'mes';
    await wa.enviarMensaje(businessId, from, "⏳ Generando tu reporte...");
    const reporte = await generarReporteExcelStyle(negocio, periodo);
    await wa.enviarMensaje(businessId, from, reporte);
    return true;
  }

  if (cmd === 'EJECUTAR COBROS' || cmd === 'COBROS AUTOMATICOS') {
    if (negocio.rol_usuario !== 'ADMIN') {
      await wa.enviarMensaje(businessId, from, "🚫 Solo el administrador puede ejecutar cobros masivos.");
      return true;
    }
    const scheduler = require('../functions/scheduler');
    await wa.enviarMensaje(businessId, from, "⏳ *Iniciando proceso de cobro...* \n\nVoy a revisar las deudas vencidas y enviaré recordatorios automáticamente.");
    const enviados = await scheduler.procesarCobrosAutomaticos(negocio);
    await wa.enviarMensaje(businessId, from, `✅ *¡PROCESO COMPLETADO!*\n\nSe enviaron *${enviados}* recordatorios a tus deudores hoy de forma automática. 🌊🚀`);
    return true;
  }

  return false;
}

async function manejarAyuda(businessId, from) {
  const ayuda =
    `🤖 *Centro de Ayuda Flow*\n\n` +
    `• "Vendí 2 pizzas a $15.000 a Carlos"\n` +
    `• "María me pagó $20.000"\n` +
    `• Escribe *REPORTE* para ver tus ventas.\n` +
    `• Escribe *pedido FLOW-XXXXXX* para gestionar el estado de un pedido.`;
  await wa.enviarMensaje(businessId, from, ayuda);
}

async function generarReporteExcelStyle(negocio, periodo = 'semana') {
  try {
    const moneda = negocio.moneda || 'COP';
    const ahora = new Date();

    // Calcular rangos de fechas
    const inicioHoy = new Date(ahora); inicioHoy.setHours(0, 0, 0, 0);
    const inicioSemana = new Date(ahora); inicioSemana.setDate(ahora.getDate() - 6); inicioSemana.setHours(0, 0, 0, 0);
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

    // Traer transacciones del último mes para cubrir todos los períodos
    const todas = await db.getTransaccionesPeriodo(negocio.phoneId, 31);
    const soloVentas = todas.filter(t => t.tipo === 'VENTA');

    const filtrar = (inicio) => soloVentas.filter(t => new Date(t.timestamp) >= inicio);
    const sumar = (arr) => arr.reduce((acc, t) => acc + (t.total || t.monto || 0), 0);
    const comision = (total) => Math.round(total * 0.15);
    const neto = (total) => Math.round(total * 0.85);
    const fmt = (n) => '$' + n.toLocaleString('es-CO');

    const ventasHoy = filtrar(inicioHoy);
    const ventasSemana = filtrar(inicioSemana);
    const ventasMes = filtrar(inicioMes);

    const totalHoy = sumar(ventasHoy);
    const totalSemana = sumar(ventasSemana);
    const totalMes = sumar(ventasMes);

    // ── TABLA RESUMEN POR PERÍODO ──────────────────────────────
    let msg = `📊 *REPORTE DE VENTAS — ${negocio.nombre || 'Mi Tienda'}*\n`;
    msg += `_${ahora.toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}_\n\n`;

    msg += `\`\`\`\n`;
    msg += `PERÍODO   │ VENTAS │  BRUTO      │ -15%       │  TU NETO   \n`;
    msg += `──────────┼────────┼─────────────┼────────────┼────────────\n`;

    const padL = (s, n) => String(s).padEnd(n, ' ');
    const padR = (s, n) => String(s).padStart(n, ' ');

    msg += `${padL('HOY', 9)} │ ${padR(ventasHoy.length, 6)} │ ${padR(fmt(totalHoy), 11)} │ ${padR(fmt(comision(totalHoy)), 10)} │ ${padR(fmt(neto(totalHoy)), 10)}\n`;
    msg += `${padL('SEMANA', 9)} │ ${padR(ventasSemana.length, 6)} │ ${padR(fmt(totalSemana), 11)} │ ${padR(fmt(comision(totalSemana)), 10)} │ ${padR(fmt(neto(totalSemana)), 10)}\n`;
    msg += `${padL('MES', 9)} │ ${padR(ventasMes.length, 6)} │ ${padR(fmt(totalMes), 11)} │ ${padR(fmt(comision(totalMes)), 10)} │ ${padR(fmt(neto(totalMes)), 10)}\n`;
    msg += `\`\`\`\n\n`;

    // ── DETALLE: ÚLTIMAS VENTAS DE HOY ─────────────────────────
    if (ventasHoy.length > 0) {
      msg += `📋 *DETALLE DE HOY (últimas ${Math.min(ventasHoy.length, 8)}):*\n`;
      msg += `\`\`\`\n`;
      msg += `HORA  │ PRODUCTO            │ MONTO      \n`;
      msg += `──────┼─────────────────────┼────────────\n`;
      ventasHoy.slice(0, 8).forEach(t => {
        const hora = new Date(t.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        const prod = (t.productos?.[0]?.nombre || t.descripcion || 'Venta').substring(0, 19).padEnd(19, ' ');
        const monto = fmt(t.total || t.monto || 0).padStart(10, ' ');
        msg += `${hora}  │ ${prod} │ ${monto}\n`;
      });
      msg += `\`\`\`\n\n`;
    } else {
      msg += `_Sin ventas registradas hoy._\n\n`;
    }

    // ── PIE DEL MENSAJE ────────────────────────────────────────
    msg += `💡 *Recuerda:* Flow retiene el 15% de cada venta.\n`;
    msg += `💸 Tu porcentaje neto es siempre el *85%*.\n\n`;
    msg += `📊 Escribe *REPORTE HOY*, *REPORTE SEMANA* o *REPORTE MES* para filtrar.`;

    return msg;
  } catch (error) {
    console.error('❌ Error en reporte:', error.message);
    return "❌ Error al generar el reporte. Intenta de nuevo.";
  }
}

async function verificarEstadoPlan(negocio) {
  if (negocio.activo === false) return { activo: false, mensaje: "Cuenta pausada por administración." };
  return { activo: true };
}

function extraerTextoMensaje(message) {
  if (message.type === 'text') return message.text?.body?.trim();
  if (message.type === 'interactive') return message.interactive?.button_reply?.title;
  return null;
}

module.exports = { handleMessage };