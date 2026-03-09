/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           FLOW — crmHandler.js (REST API PIPELINE CRM)       ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Endpoints REST para el dashboard CRM.
 * Montar en Express con:
 *   const crmHandler = require('./handlers/crmHandler');
 *   app.use('/api/crm', crmHandler);
 *
 * CORS habilitado para acceso desde el dashboard HTML.
 */

const express = require('express');
const router = express.Router();
const crm = require('../services/crmService');
const wa = require('../services/whatsapp');
const db = require('../services/database');

// ── Middleware: CORS para el dashboard ─────────────────────
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-business-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Middleware: Validar businessId ──────────────────────────
const validarBusiness = async (req, res, next) => {
  const businessId = req.params.businessId || req.headers['x-business-id'];
  if (!businessId) return res.status(400).json({ error: 'businessId requerido' });

  try {
    const negocio = await db.obtenerOCrearNegocio(businessId);
    if (!negocio || negocio.tipo_usuario === 'CLIENTE') {
      return res.status(403).json({ error: 'Sin permisos de acceso al CRM' });
    }
    req.negocio = negocio;
    req.businessId = negocio.phoneId || businessId;
    next();
  } catch (err) {
    console.error('❌ Error validando negocio:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
};

// ══════════════════════════════════════════════════════════════
//  AUTENTICACIÓN / INFO DEL NEGOCIO
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/crm/negocio/:businessId
 * Retorna info del negocio + etapas del pipeline.
 */
router.get('/negocio/:businessId', validarBusiness, async (req, res) => {
  const { negocio } = req;
  res.json({
    ok: true,
    negocio: {
      phoneId: negocio.phoneId,
      nombre: negocio.nombre,
      industria: negocio.industria,
      propietario: negocio.propietario,
      plan: negocio.plan,
    },
    etapas: crm.ETAPAS,
  });
});

// ══════════════════════════════════════════════════════════════
//  PIPELINE — CONTACTOS
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/crm/:businessId/pipeline
 * Retorna contactos agrupados por etapa (para el Kanban).
 */
router.get('/:businessId/pipeline', validarBusiness, async (req, res) => {
  try {
    const stats = await crm.getEstadisticasPipeline(req.businessId);
    res.json({ ok: true, pipeline: stats, etapas: crm.ETAPAS });
  } catch (err) {
    console.error('❌ Error pipeline:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/crm/:businessId/contactos
 * Lista todos los contactos (con filtros opcionales).
 */
router.get('/:businessId/contactos', validarBusiness, async (req, res) => {
  try {
    const { etapa, buscar } = req.query;
    let contactos = await crm.getContactos(req.businessId);

    if (etapa) contactos = contactos.filter(c => c.etapa === etapa);
    if (buscar) {
      const term = buscar.toLowerCase();
      contactos = contactos.filter(c =>
        (c.nombre || '').toLowerCase().includes(term) ||
        (c.telefono || '').includes(term)
      );
    }

    res.json({ ok: true, contactos, total: contactos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crm/:businessId/contactos
 * Crea un nuevo contacto manualmente.
 */
router.post('/:businessId/contactos', validarBusiness, async (req, res) => {
  try {
    const { telefono, nombre, etapa = 'NUEVO', notas = '', etiquetas = [] } = req.body;
    if (!telefono) return res.status(400).json({ error: 'telefono requerido' });

    const contacto = await crm.upsertContacto(req.businessId, telefono, {
      nombre, etapa, notas, etiquetas,
    });
    res.json({ ok: true, contacto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/crm/:businessId/contactos/:telefono/etapa
 * Cambia la etapa de un contacto (drag & drop del Kanban).
 */
router.put('/:businessId/contactos/:telefono/etapa', validarBusiness, async (req, res) => {
  try {
    const { telefono } = req.params;
    const { etapa } = req.body;
    if (!etapa) return res.status(400).json({ error: 'etapa requerida' });

    const result = await crm.actualizarEtapa(req.businessId, telefono, etapa);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /api/crm/:businessId/contactos/:telefono
 * Actualiza datos de un contacto (nombre, notas, etiquetas).
 */
router.put('/:businessId/contactos/:telefono', validarBusiness, async (req, res) => {
  try {
    const { telefono } = req.params;
    const datos = req.body;
    await crm.actualizarContacto(req.businessId, telefono, datos);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crm/:businessId/contactos/:telefono/leido
 * Marca mensajes como leídos al abrir la conversación.
 */
router.post('/:businessId/contactos/:telefono/leido', validarBusiness, async (req, res) => {
  try {
    await crm.marcarLeido(req.businessId, req.params.telefono);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  MENSAJES / CONVERSACIÓN
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/crm/:businessId/conversacion/:telefono
 * Historial de mensajes con un contacto.
 */
router.get('/:businessId/conversacion/:telefono', validarBusiness, async (req, res) => {
  try {
    const { telefono } = req.params;
    const mensajes = await crm.getConversacion(req.businessId, telefono);
    await crm.marcarLeido(req.businessId, telefono);
    res.json({ ok: true, mensajes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crm/:businessId/enviar
 * Envía un mensaje de WhatsApp desde el dashboard.
 */
router.post('/:businessId/enviar', validarBusiness, async (req, res) => {
  try {
    const { telefono, mensaje, mediaUrl } = req.body;
    if (!telefono || !mensaje) {
      return res.status(400).json({ error: 'telefono y mensaje requeridos' });
    }

    const telefonoFormatted = `whatsapp:+${telefono.replace(/\D/g, '')}`;

    await wa.enviarMensaje(
      process.env.TWILIO_WHATSAPP_NUMBER,
      telefonoFormatted,
      mensaje,
      mediaUrl || null
    );

    // Registrar en historial CRM
    await crm.guardarMensajeCRM(req.businessId, telefono.replace(/\D/g, ''), mensaje, 'SALIENTE_CRM');

    // Actualizar último mensaje del contacto
    await crm.upsertContacto(req.businessId, telefono, {
      ultimoMensaje: `📤 ${mensaje.substring(0, 60)}...`,
    });

    res.json({ ok: true, mensaje: 'Enviado exitosamente' });
  } catch (err) {
    console.error('❌ Error enviando mensaje CRM:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crm/:businessId/envio-masivo
 * Envía un mensaje a múltiples contactos de una etapa.
 */
router.post('/:businessId/envio-masivo', validarBusiness, async (req, res) => {
  try {
    const { telefonos, mensaje, etapa } = req.body;
    if (!mensaje) return res.status(400).json({ error: 'mensaje requerido' });

    let destinatarios = telefonos || [];

    // Si se pasa etapa, obtener todos los contactos de esa etapa
    if (etapa && !telefonos?.length) {
      const contactos = await crm.getContactos(req.businessId);
      destinatarios = contactos
        .filter(c => c.etapa === etapa)
        .map(c => c.telefono);
    }

    if (!destinatarios.length) {
      return res.status(400).json({ error: 'No hay destinatarios' });
    }

    let enviados = 0;
    let errores = 0;
    const { negocio } = req;

    for (const tel of destinatarios) {
      try {
        const mensajeFinal = mensaje
          .replace('{nombre}', 'Cliente')
          .replace('{negocio}', negocio.nombre || 'Flow');

        await wa.enviarMensaje(
          process.env.TWILIO_WHATSAPP_NUMBER,
          `whatsapp:+${tel.replace(/\D/g, '')}`,
          mensajeFinal
        );
        enviados++;
        // Pequeño delay para evitar spam
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        errores++;
        console.warn(`⚠️ Error enviando a ${tel}:`, e.message);
      }
    }

    res.json({ ok: true, enviados, errores, total: destinatarios.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  SCRIPTS DE RESPUESTA RÁPIDA
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/crm/:businessId/scripts
 */
router.get('/:businessId/scripts', validarBusiness, async (req, res) => {
  try {
    const scripts = await crm.getScripts(req.businessId);
    res.json({ ok: true, scripts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/crm/:businessId/scripts
 * Crea o actualiza un script.
 */
router.post('/:businessId/scripts', validarBusiness, async (req, res) => {
  try {
    const script = await crm.guardarScript(req.businessId, req.body);
    res.json({ ok: true, script });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/crm/:businessId/scripts/:scriptId
 */
router.delete('/:businessId/scripts/:scriptId', validarBusiness, async (req, res) => {
  try {
    await crm.eliminarScript(req.businessId, req.params.scriptId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ESTADÍSTICAS / REPORTE
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/crm/:businessId/estadisticas
 */
router.get('/:businessId/estadisticas', validarBusiness, async (req, res) => {
  try {
    const [pipeline, ventas] = await Promise.all([
      crm.getEstadisticasPipeline(req.businessId),
      db.getTransaccionesPeriodo(req.businessId, 30),
    ]);

    const totalContactos = Object.values(pipeline).reduce((a, e) => a + e.count, 0);
    const totalVentasMes = ventas
      .filter(t => t.tipo === 'VENTA')
      .reduce((a, t) => a + (t.total || 0), 0);
    const tasaConversion = totalContactos > 0
      ? ((pipeline.CERRADO?.count || 0) / totalContactos * 100).toFixed(1)
      : 0;

    res.json({
      ok: true,
      stats: {
        totalContactos,
        contactosNuevos: pipeline.NUEVO?.count || 0,
        contactosCerrados: pipeline.CERRADO?.count || 0,
        tasaConversion: `${tasaConversion}%`,
        totalVentasMes,
        porEtapa: Object.fromEntries(
          Object.entries(pipeline).map(([k, v]) => [k, v.count])
        ),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
