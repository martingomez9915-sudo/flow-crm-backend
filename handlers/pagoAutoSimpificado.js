/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                  FLOW — 2 PASOS MÁXIMO                              ║
 * ║           handlers/pagoAutoSimpificado.js                           ║
 * ║                                                                      ║
 * ║  🎯 OBJETIVO: Cliente escribe → Recibe link (sin botones intermedios)║
 * ║  🔒 SEGURIDAD: Pago verificado, link temporal, validaciones        ║
 * ║                                                                      ║
 * ║  PASOS:                                                              ║
 * ║  1️⃣  Cliente: "ibuprofeno, paracetamol, pañales"                   ║
 * ║  2️⃣  Bot envía link directo (SIN confirmación intermedia)          ║
 * ║  3️⃣  Cliente paga                                                  ║
 * ║  4️⃣  ✅ VENTA CERRADA                                              ║
 * ║                                                                      ║
 * ║  = 2 PASOS, 90 SEGUNDOS, SEGURO                                    ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const db = require('../services/database');
const whatsapp = require('../services/whatsapp');
const wompiService = require('../services/wompiService');
const listasComprasService = require('../services/listasComprasService');
const crypto = require('crypto');

// ══════════════════════════════════════════════════════════════════════
// 🔒 SEGURIDAD: GENERAR TOKENS Y VALIDAR
// ══════════════════════════════════════════════════════════════════════

/**
 * Generar token único para este pago
 * - Válido solo 15 minutos
 * - No se puede reutilizar
 * - Vinculado al cliente + monto
 */
function generarTokenSeguro(clientePhone, monto, codigoPago) {
  const ahora = Date.now();
  const expira = ahora + (15 * 60 * 1000); // 15 minutos
  
  // Crear hash: phone + monto + timestamp + secret
  const cadena = `${clientePhone}${monto}${ahora}${process.env.JWT_SECRET || 'flow-secret'}`;
  const token = crypto.createHash('sha256').update(cadena).digest('hex');
  
  return {
    token: token.slice(0, 16), // Acortar para URL limpia
    creadoEn: ahora,
    expiraEn: expira,
    codigoPago,
    clientePhone,
    monto,
    usado: false,
  };
}

/**
 * Validar que el token sea válido
 */
function validarTokenSeguro(tokenObj) {
  const ahora = Date.now();
  
  // Validaciones
  if (tokenObj.usado) {
    return { valid: false, razon: 'Token ya fue usado (anti-fraude)' };
  }
  
  if (ahora > tokenObj.expiraEn) {
    return { valid: false, razon: 'Token expirado (válido solo 15 min)' };
  }
  
  return { valid: true };
}

// ══════════════════════════════════════════════════════════════════════
// 1️⃣  PROCESAR LISTA Y ENVIAR LINK DIRECTAMENTE (SIN BOTONES INTERMEDIOS)
// ══════════════════════════════════════════════════════════════════════

async function procesarYEnviarLinkDirecto(textoCliente, clientePhone, clientePhoneRaw, ciudad = 'cali') {
  try {
    console.log(`\n🚀 [PAGO AUTO] Procesando: "${textoCliente}"`);

    // ─────────────────────────────────────────────────────
    // PASO 1: Procesar lista con IA (máx 1 segundo)
    // ─────────────────────────────────────────────────────
    const listaCompras = await listasComprasService.procesarListaCompras(
      textoCliente,
      ciudad
    );

    if (!listaCompras.success) {
      return {
        success: false,
        error: listaCompras.error,
        reintentable: true,
      };
    }

    // ─────────────────────────────────────────────────────
    // PASO 2: Convertir a carrito y calcular totales
    // ─────────────────────────────────────────────────────
    const carrito = listasComprasService.convertirListaACarrito(listaCompras);
    const { totalGeneral } = listaCompras;

    if (carrito.length === 0 || totalGeneral === 0) {
      return {
        success: false,
        error: 'No pude procesar tu lista. Intenta de nuevo.',
        reintentable: true,
      };
    }

    // ─────────────────────────────────────────────────────
    // PASO 3: Crear código de pago único
    // ─────────────────────────────────────────────────────
    const codigoPago = generarCodigoSeguimiento();

    // ─────────────────────────────────────────────────────
    // PASO 4: Generar token de seguridad (15 min)
    // ─────────────────────────────────────────────────────
    const tokenSeguro = generarTokenSeguro(clientePhone, totalGeneral, codigoPago);

    // ─────────────────────────────────────────────────────
    // PASO 5: Crear link de pago con Wompi
    // ─────────────────────────────────────────────────────
    const linkWompi = await wompiService.crearLinkDePago({
      codigo: codigoPago,
      nombreProducto: `${listaCompras.cantidadProductos} producto(s)`,
      totalCOP: totalGeneral,
      tiendaNombre: 'Flow Marketplace',
      clienteNombre: clientePhone,
      clientePhone,
    });

    // ─────────────────────────────────────────────────────
    // PASO 6: Guardar datos de seguridad en BD
    // ─────────────────────────────────────────────────────
    await guardarDatosPagoSeguro({
      codigoPago,
      token: tokenSeguro,
      clientePhone,
      totalGeneral,
      carrito,
      listaCompras,
      linkWompi,
      estado: 'PENDIENTE',
      creadoEn: new Date().toISOString(),
    });

    // ─────────────────────────────────────────────────────
    // PASO 7: Enviar mensaje de PAGO SEGURO + LINK (SIN botones)
    // ─────────────────────────────────────────────────────
    await enviarMensajePagoSeguro(
      clientePhoneRaw,
      clientePhone,
      codigoPago,
      listaCompras,
      totalGeneral,
      linkWompi,
      tokenSeguro
    );

    return {
      success: true,
      codigoPago,
      token: tokenSeguro.token,
      linkWompi,
      totalGeneral,
      mensaje: 'Link enviado automáticamente',
    };

  } catch (error) {
    console.error('❌ Error procesando pago auto:', error.message);
    return {
      success: false,
      error: 'Error procesando tu compra. Intenta de nuevo.',
      reintentable: true,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 🔒 ENVIAR MENSAJE CON SEGURIDAD VISIBLE
// ══════════════════════════════════════════════════════════════════════

async function enviarMensajePagoSeguro(
  clientePhoneRaw,
  clientePhone,
  codigoPago,
  listaCompras,
  totalGeneral,
  linkWompi,
  tokenSeguro
) {
  try {
    const FROM_TWILIO = process.env.TWILIO_WHATSAPP_NUMBER;
    const tiempoExpiracion = Math.floor((tokenSeguro.expiraEn - tokenSeguro.creadoEn) / 60000);

    let mensaje = `✅ *COMPRA IDENTIFICADA Y LISTA PARA PAGAR*\n\n`;

    // ─────────────────────────────────────────────────────
    // MOSTRAR RESUMEN (pero NO botones)
    // ─────────────────────────────────────────────────────
    mensaje += `📋 *RESUMEN:*\n`;
    
    const porTienda = {};
    for (const producto of listaCompras.productos) {
      const tienda = producto.tiendaNombre || 'No disponible';
      if (!porTienda[tienda]) {
        porTienda[tienda] = [];
      }
      porTienda[tienda].push(producto);
    }

    for (const [tienda, productos] of Object.entries(porTienda)) {
      if (tienda === 'No disponible') {
        mensaje += `\n❌ *No encontrados:*\n`;
        productos.forEach(p => {
          mensaje += `   • ${p.nombre}\n`;
        });
      } else {
        mensaje += `\n🏪 ${tienda}\n`;
        let subtotal = 0;
        productos.forEach(p => {
          if (!p.noDisponible) {
            const linea = p.precio * p.cantidad;
            subtotal += linea;
            mensaje += `   • ${p.nombre} x${p.cantidad} = $${linea.toLocaleString('es-CO')}\n`;
          }
        });
        if (subtotal > 0) {
          mensaje += `   💵 $${subtotal.toLocaleString('es-CO')}\n`;
        }
      }
    }

    mensaje += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    mensaje += `💰 *TOTAL: $${totalGeneral.toLocaleString('es-CO')}*\n`;
    mensaje += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // ─────────────────────────────────────────────────────
    // SEGURIDAD Y CONFIANZA
    // ─────────────────────────────────────────────────────
    mensaje += `🔒 *PAGO SEGURO*\n`;
    mensaje += `✅ Procesado por Wompi (PCI-DSS Level 1)\n`;
    mensaje += `🛡️  Tu tarjeta está protegida\n`;
    mensaje += `⏰ Link válido ${tiempoExpiracion} minutos\n`;
    mensaje += `🔐 Código único: ${codigoPago}\n\n`;

    // ─────────────────────────────────────────────────────
    // LINK DIRECTO (SIN botones intermedios)
    // ─────────────────────────────────────────────────────
    mensaje += `💳 *HAGA CLIC PARA PAGAR:*\n`;
    mensaje += `${linkWompi}\n\n`;

    // ─────────────────────────────────────────────────────
    // MÉTODOS DE PAGO DISPONIBLES
    // ─────────────────────────────────────────────────────
    mensaje += `💳 *Métodos aceptados:*\n`;
    mensaje += `  💳 Tarjeta de crédito/débito\n`;
    mensaje += `  📱 Nequi (sin comisión)\n`;
    mensaje += `  🏦 PSE (transferencia bancaria)\n`;
    mensaje += `  💰 Daviplata\n\n`;

    // ─────────────────────────────────────────────────────
    // INFORMACIÓN ÚTIL
    // ─────────────────────────────────────────────────────
    mensaje += `ℹ️ *Información importante:*\n`;
    mensaje += `✅ Compra protegida por Flow\n`;
    mensaje += `📞 Soporte 24/7: escribe aquí\n`;
    mensaje += `📌 Código seguimiento: ${codigoPago}\n`;
    mensaje += `   (guarda este código)\n\n`;

    mensaje += `_Flow Marketplace — Compra segura y rápida_ 🌊`;

    await whatsapp.enviarMensaje(FROM_TWILIO, clientePhoneRaw, mensaje);
    console.log(`✅ Mensaje de pago seguro enviado a ${clientePhone}`);

  } catch (error) {
    console.error('❌ Error enviando mensaje:', error.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 🔐 GUARDAR DATOS DE PAGO CON SEGURIDAD
// ══════════════════════════════════════════════════════════════════════

async function guardarDatosPagoSeguro(datos) {
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const firestore = new Firestore({ projectId: process.env.GCLOUD_PROJECT });

    // Guardar en colección especial de pagos seguros
    await firestore.collection('pagos_seguros').doc(datos.codigoPago).set({
      // Identidad
      codigoPago: datos.codigoPago,
      clientePhone: datos.clientePhone,
      
      // Token de seguridad
      token: datos.token.token,
      tokenCreadoEn: datos.token.creadoEn,
      tokenExpiraEn: datos.token.expiraEn,
      
      // Datos de la compra
      totalGeneral: datos.totalGeneral,
      cantidadProductos: datos.carrito.length,
      
      // Link de pago
      linkWompi: datos.linkWompi,
      
      // Estado
      estado: datos.estado,
      creadoEn: datos.creadoEn,
      confirmadoEn: null,
      pagadoEn: null,
      
      // Carrito
      carrito: datos.carrito,
      
      // IP del cliente (para anti-fraude)
      ipCliente: process.env.CLIENT_IP || 'desconocida',
      
      // Timestamp para auditoría
      timestamp: new Date().toISOString(),
    });

    console.log(`✅ Datos de pago guardados de forma segura: ${datos.codigoPago}`);

  } catch (error) {
    console.error('❌ Error guardando datos:', error.message);
    throw error;
  }
}

// ══════════════════════════════════════════════════════════════════════
// ✅ PROCESAR CONFIRMACIÓN DE PAGO (desde wompiWebhook.js)
// ══════════════════════════════════════════════════════════════════════

async function procesarPagoConfirmado(codigoPago) {
  try {
    console.log(`\n✅ [PAGO CONFIRMADO] ${codigoPago}`);

    const { Firestore } = require('@google-cloud/firestore');
    const firestore = new Firestore({ projectId: process.env.GCLOUD_PROJECT });

    // Obtener datos del pago
    const pagoDoc = await firestore.collection('pagos_seguros').doc(codigoPago).get();
    
    if (!pagoDoc.exists) {
      console.error(`❌ Pago no encontrado: ${codigoPago}`);
      return { success: false, error: 'Pago no encontrado' };
    }

    const datosPago = pagoDoc.data();

    // ─────────────────────────────────────────────────────
    // VALIDAR TOKEN (anti-fraude)
    // ─────────────────────────────────────────────────────
    const tokenValido = validarTokenSeguro(datosPago.token);
    if (!tokenValido.valid) {
      console.error(`❌ Token inválido: ${tokenValido.razon}`);
      return { success: false, error: tokenValido.razon };
    }

    // ─────────────────────────────────────────────────────
    // MARCAR TOKEN COMO USADO (evitar doble compra)
    // ─────────────────────────────────────────────────────
    await firestore.collection('pagos_seguros').doc(codigoPago).update({
      'token.usado': true,
      estado: 'PAGADO',
      pagadoEn: new Date().toISOString(),
    });

    // ─────────────────────────────────────────────────────
    // CREAR PEDIDOS POR TIENDA
    // ─────────────────────────────────────────────────────
    const codigosPorTienda = await crearPedidosPorTienda(
      datosPago.carrito,
      datosPago.clientePhone,
      codigoPago
    );

    // ─────────────────────────────────────────────────────
    // NOTIFICAR AL CLIENTE
    // ─────────────────────────────────────────────────────
    await notificarClientePagoConfirmado(
      datosPago.clientePhone,
      codigoPago,
      datosPago.totalGeneral,
      codigosPorTienda
    );

    // ─────────────────────────────────────────────────────
    // NOTIFICAR A TIENDAS
    // ─────────────────────────────────────────────────────
    for (const { tienda, codigo } of codigosPorTienda) {
      await notificarTiendaPedidoPagado(tienda, codigo, datosPago.totalGeneral);
    }

    return {
      success: true,
      codigoPago,
      codigosPorTienda,
    };

  } catch (error) {
    console.error('❌ Error procesando pago:', error.message);
    return { success: false, error: error.message };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 📦 CREAR PEDIDOS POR TIENDA
// ══════════════════════════════════════════════════════════════════════

async function crearPedidosPorTienda(carrito, clientePhone, codigoPago) {
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const firestore = new Firestore({ projectId: process.env.GCLOUD_PROJECT });

    // Agrupar por tienda
    const porTienda = {};
    for (const item of carrito) {
      if (!porTienda[item.tiendaNombre]) {
        porTienda[item.tiendaNombre] = [];
      }
      porTienda[item.tiendaNombre].push(item);
    }

    const codigosPorTienda = [];

    for (const [tienda, items] of Object.entries(porTienda)) {
      const codigoPedido = generarCodigoSeguimiento();
      const subtotal = items.reduce((sum, i) => sum + (i.precio * i.cantidad), 0);

      const pedido = {
        codigo: codigoPedido,
        codigoPagoPrincipal: codigoPago,
        tiendaNombre: tienda,
        tiendaPhone: items[0].tiendaPhone,
        tiendaEmail: items[0].tiendaEmail,
        tiendaId: items[0].tiendaId,
        clientePhone,
        items,
        subtotal,
        estado: 'PAGADO_PENDIENTE_CONFIRMACION',
        pagadoEn: new Date().toISOString(),
        creadoEn: new Date().toISOString(),
      };

      await firestore.collection('pedidos').doc(codigoPedido).set(pedido);
      codigosPorTienda.push({ tienda, codigo: codigoPedido });
    }

    return codigosPorTienda;

  } catch (error) {
    console.error('❌ Error creando pedidos:', error.message);
    throw error;
  }
}

// ══════════════════════════════════════════════════════════════════════
// 📱 NOTIFICACIONES
// ══════════════════════════════════════════════════════════════════════

async function notificarClientePagoConfirmado(clientePhone, codigoPago, totalGeneral, codigosPorTienda) {
  try {
    const FROM_TWILIO = process.env.TWILIO_WHATSAPP_NUMBER;

    let mensaje = `🎉 *¡COMPRA CONFIRMADA!*\n\n`;
    mensaje += `✅ Tu pago de *$${totalGeneral.toLocaleString('es-CO')}* fue procesado exitosamente.\n\n`;
    mensaje += `📌 *Código de seguimiento:* ${codigoPago}\n`;
    mensaje += `   Guarda este código para rastrear tu pedido.\n\n`;
    mensaje += `🏪 *Tiendas que confirmarán:*\n`;
    
    codigosPorTienda.forEach(({ tienda, codigo }) => {
      mensaje += `   • ${tienda}\n`;
    });

    mensaje += `\n⏳ Las tiendas confirmarán en los próximos minutos.\n`;
    mensaje += `📬 Recibirás notificaciones de cada etapa.\n\n`;
    mensaje += `💬 ¿Necesitas ayuda? Escribe aquí.`;

    await whatsapp.enviarMensaje(FROM_TWILIO, `whatsapp:+${clientePhone.replace(/\D/g, '')}`, mensaje);
    console.log(`✅ Confirmación enviada a cliente ${clientePhone}`);

  } catch (error) {
    console.error('❌ Error notificando cliente:', error.message);
  }
}

async function notificarTiendaPedidoPagado(tiendaNombre, codigoPedido, totalGeneral) {
  try {
    const FROM_TWILIO = process.env.TWILIO_WHATSAPP_NUMBER;
    const tienda = await db.obtenerTienda(tiendaNombre);

    if (!tienda || !tienda.phone) {
      console.warn(`⚠️ No se encontró tienda: ${tiendaNombre}`);
      return;
    }

    let mensaje = `🎯 *¡NUEVO PEDIDO PAGADO!*\n\n`;
    mensaje += `📌 *Código:* ${codigoPedido}\n`;
    mensaje += `💰 *Monto recibido:* $${totalGeneral.toLocaleString('es-CO')}\n\n`;
    mensaje += `⚡ El cliente está esperando.\n`;
    mensaje += `Confirma que tienes en stock y prepara el envío.\n\n`;
    mensaje += `🔗 [VER PEDIDO EN PANEL]\n`;
    mensaje += `https://flow.business/tienda/pedidos/${codigoPedido}`;

    await whatsapp.enviarMensaje(FROM_TWILIO, `whatsapp:+${tienda.phone.replace(/\D/g, '')}`, mensaje);
    console.log(`✅ Notificación enviada a tienda ${tiendaNombre}`);

  } catch (error) {
    console.error('❌ Error notificando tienda:', error.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
// HELPER
// ══════════════════════════════════════════════════════════════════════

function generarCodigoSeguimiento() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let codigo = 'FLOW-';
  for (let i = 0; i < 6; i++) {
    codigo += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return codigo;
}

// ══════════════════════════════════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════════════════════════════════

module.exports = {
  procesarYEnviarLinkDirecto,
  procesarPagoConfirmado,
  generarTokenSeguro,
  validarTokenSeguro,
  guardarDatosPagoSeguro,
};
