/**
 * ╔═══════════════════════════════════════════════════════╗
 * ║      FLOW — Panel de Administración                   ║
 * ║         handlers/adminHandler.js                      ║
 * ╚═══════════════════════════════════════════════════════╝
 * 
 * Endpoints para administrar los 10,000 negocios:
 * - Ver estado de un negocio
 * - Cambiar plan (cuando pagan)
 * - Pausar/activar cuenta
 * - Ver métricas globales
 */

const db = require('../services/database');
const wa = require('../services/whatsapp');
const { PLANES } = require('../config/plans');

// ── GET /business/:phone ─────────────────────────────────
async function getBusinessStatus(req, res) {
  try {
    const { phone } = req.params;
    const negocio = await db.obtenerOCrearNegocio(phone);
    const uso = await db.getUsoMes(phone);
    const resumen = await db.getResumenMes(phone);

    res.json({
      negocio,
      uso_mes_actual: uso,
      resumen_mes: resumen,
      plan_info: PLANES[negocio.plan] || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ── POST /business/:phone/plan ───────────────────────────
// Llamar esto cuando el cliente realiza el pago
async function updatePlan(req, res) {
  try {
    const { phone } = req.params;
    const { plan, meses = 1 } = req.body;

    if (!PLANES[plan]) {
      return res.status(400).json({ error: `Plan inválido: ${plan}` });
    }

    // Calcular nueva fecha de vencimiento
    const vencimiento = new Date();
    vencimiento.setMonth(vencimiento.getMonth() + meses);

    await db.actualizarNegocio(phone, {
      plan,
      activo: true,
      plan_inicio: new Date().toISOString(),
      plan_vencimiento: vencimiento.toISOString(),
      pausa_razon: null,
    });

    // Notificar al negocio por WhatsApp
    const planInfo = PLANES[plan];
    const businessId = process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID;

    if (businessId) {
      await wa.enviarMensaje(
        businessId,
        phone,
        `🎉 *¡Pago confirmado!*\n\nActivaste el *${planInfo.nombre}* por ${meses} mes${meses > 1 ? 'es' : ''}.\n\nVence el: ${vencimiento.toLocaleDateString('es-CO')}\n\n¡Ya puedes seguir usando FLOW! 🚀`
      );
    }

    res.json({
      success: true,
      plan,
      vencimiento: vencimiento.toISOString(),
      mensaje: `Plan ${plan} activado hasta ${vencimiento.toLocaleDateString()}`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ── POST /business/:phone/toggle ─────────────────────────
async function toggleBusiness(req, res) {
  try {
    const { phone } = req.params;
    const { activo, razon } = req.body;

    await db.toggleNegocio(phone, activo, razon);

    res.json({
      success: true,
      phone,
      activo,
      razon,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = { getBusinessStatus, updatePlan, toggleBusiness };
