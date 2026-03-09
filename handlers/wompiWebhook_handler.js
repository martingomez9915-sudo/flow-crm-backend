/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║   FLOW — handlers/wompiWebhook.js                                    ║
 * ║   Pago Aprobado → Sheets + Email + WhatsApp + Firestore              ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * FLUJO COMPLETO AL RECIBIR PAGO APROBADO:
 *  1. Verificar firma Wompi (seguridad)
 *  2. Buscar pedido en Firestore por referencia
 *  3. Ejecutar split: 15% Flow / 85% tienda
 *  4. Registrar venta en Google Sheets Global
 *  5. Notificar al CLIENTE: WhatsApp con código(s) por tienda
 *  6. Notificar a cada TIENDA: WhatsApp + Email con código y monto
 *  7. Actualizar estado en Firestore → PAGADO
 */

const express = require('express');
const router = express.Router();
const { Firestore } = require('@google-cloud/firestore');
const wompi = require('../services/wompiService');
const whatsapp = require('../services/whatsapp');
const { notificarPedido } = require('../services/emailService');
const { registrarVentaEnSheet } = require('../services/sheetsService');

const db = new Firestore({ projectId: process.env.GCLOUD_PROJECT || 'melodic-park-489419-k5' });
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

// ══════════════════════════════════════════════════════════
//  POST /wompi/webhook
// ══════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const evento = req.body;
    const firma = req.headers['x-event-checksum'] || '';

    console.log(`\n🔔 [WOMPI] Evento: ${evento?.event}`);

    if (!wompi.verificarFirmaWebhook(evento, firma)) {
      console.error('❌ [WOMPI] Firma inválida — ignorado');
      return;
    }

    const tx = evento?.data?.transaction;
    if (!tx || evento?.event !== 'transaction.updated') return;

    if (tx.status === 'APPROVED') {
      await manejarPagoAprobado(tx);
    } else if (['DECLINED', 'ERROR', 'VOIDED'].includes(tx.status)) {
      await manejarPagoFallido(tx);
    }

  } catch (err) {
    console.error('❌ [WOMPI] Error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════
//  PAGO APROBADO
// ══════════════════════════════════════════════════════════
async function manejarPagoAprobado(tx) {
  const codigo = tx.reference;
  const totalCOP = tx.amount_in_cents / 100;
  const metodo = tx.payment_method_type;

  const pedidoRef = db.collection('pedidos').doc(codigo);
  const pedidoDoc = await pedidoRef.get();

  if (!pedidoDoc.exists) {
    console.error(`❌ [WOMPI] Pedido no encontrado: ${codigo}`);
    return;
  }

  const pedido = pedidoDoc.data();

  if (pedido.wompi_estado === 'APROBADO') {
    console.warn(`⚠️ [WOMPI] ${codigo} ya procesado — ignorando duplicado`);
    return;
  }

  console.log(`✅ [WOMPI] Aprobado: ${codigo} | $${totalCOP.toLocaleString('es-CO')}`);

  // Actualizar Firestore
  await pedidoRef.set({
    wompi_estado: 'APROBADO',
    wompi_tx_id: tx.id,
    wompi_metodo_pago: metodo,
    wompi_pagado_en: new Date().toISOString(),
    estado: 'PAGADO',
  }, { merge: true });

  // Split
  const { flowComision, tiendaMonto } = await wompi.procesarSplit(
    codigo, totalCOP, pedido.tiendaId
  );

  // Multi-tienda vs simple
  const esMultiTienda = Array.isArray(pedido.tiendas) && pedido.tiendas.length > 1;

  if (esMultiTienda) {
    await procesarCarritoMultiTienda(pedido, codigo, totalCOP, metodo);
  } else {
    await procesarPedidoSimple(pedido, codigo, totalCOP, tiendaMonto, flowComision, metodo);
  }

  console.log(`🎉 [WOMPI] ${codigo} completado.`);
}

// ══════════════════════════════════════════════════════════
//  PEDIDO SIMPLE — una sola tienda
// ══════════════════════════════════════════════════════════
async function procesarPedidoSimple(pedido, codigo, totalCOP, tiendaMonto, flowComision, metodo) {
  const metodoPago = formatMetodoPago(metodo);

  // Google Sheets
  await registrarVentaEnSheet({
    codigo,
    clienteNombre: pedido.clienteNombre,
    clienteNumero: pedido.clienteNumero,
    tiendaNombre: pedido.tiendaNombre,
    productos: [{ nombre: pedido.producto, cantidad: pedido.cantidad, precio: totalCOP }],
    total: totalCOP,
  }).catch(err => console.warn('⚠️ Sheets:', err.message));

  // WhatsApp → Cliente
  await whatsapp.enviarMensaje(FROM, formatWa(pedido.clienteNumero),
    `✅ *¡PAGO CONFIRMADO!*\n\n` +
    `Hola *${pedido.clienteNombre}* 👋\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔑 *Tu código de compra:*\n` +
    `*${codigo}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏪 Tienda: ${pedido.tiendaNombre}\n` +
    `🛍️ ${pedido.producto} x${pedido.cantidad}\n` +
    `💳 Método: ${metodoPago}\n` +
    `💵 *Total: $${totalCOP.toLocaleString('es-CO')}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 La tienda fue notificada.\n` +
    `Escribe *seguimiento ${codigo}* para rastrear. 🌊`
  );

  // WhatsApp → Tienda
  await whatsapp.enviarMensaje(FROM, formatWa(pedido.tiendaId),
    `🔔 *¡NUEVO PEDIDO PAGADO!*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔑 Código: *${codigo}*\n` +
    `👤 Cliente: *${pedido.clienteNombre}*\n` +
    `📱 https://wa.me/${String(pedido.clienteNumero).replace(/\D/g, '')}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🛍️ *${pedido.producto}* x${pedido.cantidad}\n` +
    `💳 Pago vía: ${metodoPago}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Total:          $${totalCOP.toLocaleString('es-CO')}\n` +
    `   ├─ Flow (${wompi.COMISION_PCT}%): -$${flowComision.toLocaleString('es-CO')}\n` +
    `   └─ *Tu ingreso: $${tiendaMonto.toLocaleString('es-CO')}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚡ Prepara y despacha el pedido. 🌊`
  );

  // Email → Tienda
  await notificarPedido({
    emailTienda: pedido.emailTienda,
    tiendaNombre: pedido.tiendaNombre,
    codigo,
    clienteNombre: pedido.clienteNombre,
    clienteNumero: pedido.clienteNumero,
    producto: pedido.producto,
    cantidad: pedido.cantidad,
    total: totalCOP,
  }).catch(err => console.warn('⚠️ Email:', err.message));

  // ✅ SYNC → CRM tienda (dashboard ventas/pedidos)
  const fechaISO = new Date().toISOString();
  await db.collection('negocios').doc(String(pedido.tiendaId))
    .collection('transacciones').doc(codigo)
    .set({
      tipo: 'VENTA',
      codigo,
      total: totalCOP,
      producto: pedido.producto,
      cantidad: pedido.cantidad,
      cliente: pedido.clienteNombre,           // campo que lee /orders
      clienteNumero: String(pedido.clienteNumero),
      metodoPago: metodo,
      fecha: fechaISO,                       // ISO string que compara /stats
      estado: 'CONFIRMADO',
    });

  // ✅ SYNC → estadisticas (dashboard admin)
  await db.collection('negocios').doc(String(pedido.tiendaId)).set({
    estadisticas: {
      total_ventas: Firestore.FieldValue.increment(totalCOP),
      clientes_total: Firestore.FieldValue.increment(1),
    }
  }, { merge: true });

  console.log(`📊 [CRM] Venta registrada para tienda ${pedido.tiendaId}`);
}

// ══════════════════════════════════════════════════════════
//  CARRITO MULTI-TIENDA
//  Un código por tienda → cliente recibe todos, cada tienda el suyo
// ══════════════════════════════════════════════════════════
async function procesarCarritoMultiTienda(pedido, codigoBase, totalCOP, metodo) {
  const metodoPago = formatMetodoPago(metodo);
  const tiendas = pedido.tiendas;

  // Armar mensaje resumen para el cliente
  let msgCliente =
    `✅ *¡PAGO CONFIRMADO!*\n\n` +
    `Hola *${pedido.clienteNombre}* 👋\n` +
    `Compraste en *${tiendas.length} tiendas*. Tus códigos:\n\n`;

  for (const tienda of tiendas) {
    // Código único por tienda: FLOW-XXXX-TIENDA
    const codigoTienda = `${codigoBase}-${tienda.tiendaId.slice(-4).toUpperCase()}`;
    const subtotal = tienda.subtotal || 0;
    const comision = Math.round(subtotal * (wompi.COMISION_PCT / 100));
    const ingresoTienda = subtotal - comision;

    // Guardar sub-pedido en Firestore
    await db.collection('pedidos').doc(codigoBase)
      .collection('tiendas').doc(tienda.tiendaId)
      .set({
        codigoTienda,
        estado: 'PAGADO',
        subtotal,
        comision,
        ingresoTienda,
        procesado_en: new Date().toISOString(),
      }, { merge: true });

    // Google Sheets Global
    await registrarVentaEnSheet({
      codigo: codigoTienda,
      clienteNombre: pedido.clienteNombre,
      clienteNumero: pedido.clienteNumero,
      tiendaNombre: tienda.tiendaNombre,
      productos: tienda.productos,
      total: subtotal,
    }).catch(err => console.warn(`⚠️ Sheets [${tienda.tiendaNombre}]:`, err.message));

    // Añadir al resumen del cliente
    msgCliente +=
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🏪 *${tienda.tiendaNombre}*\n` +
      `🔑 Código: *${codigoTienda}*\n` +
      `🛍️ ${tienda.productos.map(p => `${p.nombre} x${p.cantidad}`).join(', ')}\n` +
      `💵 $${subtotal.toLocaleString('es-CO')}\n\n`;

    // WhatsApp → cada Tienda
    const lista = tienda.productos
      .map(p => `• ${p.nombre} x${p.cantidad} — $${(p.precio * p.cantidad).toLocaleString('es-CO')}`)
      .join('\n');

    await whatsapp.enviarMensaje(FROM, formatWa(tienda.tiendaId),
      `🔔 *¡NUEVO PEDIDO PAGADO!*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔑 Tu código: *${codigoTienda}*\n` +
      `👤 Cliente: *${pedido.clienteNombre}*\n` +
      `📱 https://wa.me/${String(pedido.clienteNumero).replace(/\D/g, '')}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🛍️ *Productos:*\n${lista}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💵 Tu subtotal:    $${subtotal.toLocaleString('es-CO')}\n` +
      `   ├─ Flow (${wompi.COMISION_PCT}%): -$${comision.toLocaleString('es-CO')}\n` +
      `   └─ *Tu ingreso: $${ingresoTienda.toLocaleString('es-CO')}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚡ Prepara y despacha el pedido. 🌊`
    );

    // Email → cada Tienda
    await notificarPedido({
      emailTienda: tienda.emailTienda,
      tiendaNombre: tienda.tiendaNombre,
      codigo: codigoTienda,
      clienteNombre: pedido.clienteNombre,
      clienteNumero: pedido.clienteNumero,
      producto: tienda.productos.map(p => p.nombre).join(', '),
      cantidad: tienda.productos.reduce((a, p) => a + p.cantidad, 0),
      total: subtotal,
    }).catch(err => console.warn(`⚠️ Email [${tienda.tiendaNombre}]:`, err.message));

    // ✅ SYNC → CRM tienda (dashboard ventas/pedidos)
    const fechaISO = new Date().toISOString();
    await db.collection('negocios').doc(String(tienda.tiendaId))
      .collection('transacciones').doc(codigoTienda)
      .set({
        tipo: 'VENTA',
        codigo: codigoTienda,
        total: subtotal,
        productos: tienda.productos,
        cliente: pedido.clienteNombre,         // campo que lee /orders
        clienteNumero: String(pedido.clienteNumero),
        metodoPago: metodo,
        fecha: fechaISO,                     // ISO string que compara /stats
        estado: 'CONFIRMADO',
      });

    // ✅ SYNC → estadisticas (dashboard admin)
    await db.collection('negocios').doc(String(tienda.tiendaId)).set({
      estadisticas: {
        total_ventas: Firestore.FieldValue.increment(subtotal),
        clientes_total: Firestore.FieldValue.increment(1),
      }
    }, { merge: true });

    console.log(`📊 [CRM] Venta registrada para tienda ${tienda.tiendaId}`);
  }

  // Cerrar mensaje cliente y enviar
  msgCliente +=
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 *Total pagado: $${totalCOP.toLocaleString('es-CO')}*\n` +
    `💳 Método: ${metodoPago}\n\n` +
    `Escribe *seguimiento ${codigoBase}* para rastrear. 🌊`;

  await whatsapp.enviarMensaje(FROM, formatWa(pedido.clienteNumero), msgCliente);
}

// ══════════════════════════════════════════════════════════
//  PAGO FALLIDO
// ══════════════════════════════════════════════════════════
async function manejarPagoFallido(tx) {
  const codigo = tx.reference;
  console.log(`❌ [WOMPI] Pago fallido: ${codigo} → ${tx.status}`);

  const pedidoDoc = await db.collection('pedidos').doc(codigo).get();
  if (!pedidoDoc.exists) return;

  const pedido = pedidoDoc.data();

  await db.collection('pedidos').doc(codigo).set({
    wompi_estado: tx.status,
    wompi_tx_id: tx.id,
    estado: 'PAGO_FALLIDO',
  }, { merge: true });

  await whatsapp.enviarMensaje(FROM, formatWa(pedido.clienteNumero),
    `❌ *Pago no procesado*\n\n` +
    `Hubo un problema con tu pago del pedido *${codigo}*.\n\n` +
    `💡 Intenta de nuevo escribiendo *seguimiento ${codigo}*.\n\n` +
    `Si el problema persiste, contáctanos 🙏`
  );
}

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════
function formatWa(numero) {
  return `whatsapp:+${String(numero).replace(/\D/g, '')}`;
}

function formatMetodoPago(tipo) {
  const map = {
    'CARD': '💳 Tarjeta',
    'NEQUI': '📱 Nequi',
    'PSE': '🏦 PSE',
    'BANCOLOMBIA_TRANSFER': '🏦 Bancolombia',
    'BANCOLOMBIA_COLLECT': '📲 Bancolombia App',
    'DAVIPLATA': '📱 Daviplata',
    'EFECTY': '💵 Efecty',
  };
  return map[tipo] || tipo || 'Otro';
}

module.exports = router;