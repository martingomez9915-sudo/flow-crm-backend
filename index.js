const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const app = express();
app.use(express.json());
app.use(cors());

// ── Firebase ───────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── WhatsApp (Twilio) ──────────────────────────────────────────────
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // ej: whatsapp:+17025531681

const sendWhatsApp = async (to, message) => {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const params = new URLSearchParams({
    From: TWILIO_NUMBER,
    To: `whatsapp:+${to.replace(/\D/g, "")}`,
    Body: message,
  });
  await axios.post(url, params.toString(), {
    auth: { username: TWILIO_SID, password: TWILIO_TOKEN },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
};

// ── Status ─────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Flow CRM Backend running 🚀" }));

// ══════════════════════════════════════════════════════════════════
//  AUTH — OTP por WhatsApp
// ══════════════════════════════════════════════════════════════════
app.post("/auth/send-code", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Número requerido" });

  const fullPhone = phone.replace(/\D/g, "");
  const phoneWithCode = fullPhone.startsWith("57") ? fullPhone : `57${fullPhone}`;

  try {
    // Verificar que el número está registrado como negocio en Firestore
    const negocioRef = db.collection("negocios").doc(phoneWithCode);
    const negocioDoc = await negocioRef.get();

    if (!negocioDoc.exists) {
      return res.status(404).json({ error: "Número no registrado. Contacta a Flow AI." });
    }

    const negocio = negocioDoc.data();
    if (negocio.tipo_usuario !== "NEGOCIO" && negocio.tipo_usuario !== "SUPER_ADMIN") {
      return res.status(403).json({ error: "Esta cuenta no tiene acceso al dashboard." });
    }

    // Generar código OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.collection("otp_codes").doc(phoneWithCode).set({ code, expiresAt });

    // Enviar por WhatsApp (Twilio)
    await sendWhatsApp(phoneWithCode,
      `🔐 Tu código de acceso a *Flow Dashboard* es:\n\n*${code}*\n\nExpira en 10 minutos.`
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error send-code:", err.message);
    res.status(500).json({ error: "Error enviando código: " + err.message });
  }
}
);

app.post("/auth/verify-code", async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: "Datos incompletos" });

  const fullPhone = phone.replace(/\D/g, "");
  const phoneWithCode = fullPhone.startsWith("57") ? fullPhone : `57${fullPhone}`;

  try {
    const otpDoc = await db.collection("otp_codes").doc(phoneWithCode).get();
    if (!otpDoc.exists) return res.status(400).json({ error: "No hay código activo" });

    const { code: storedCode, expiresAt } = otpDoc.data();
    if (storedCode !== code) return res.status(401).json({ error: "Código incorrecto" });
    if (new Date(expiresAt) < new Date()) return res.status(401).json({ error: "Código expirado" });

    await db.collection("otp_codes").doc(phoneWithCode).delete();

    // DESPUÉS
    const negocioDoc = await db.collection("negocios").doc(phoneWithCode).get();
    const negocioData = negocioDoc.data();

    if (negocioData.tipo_usuario === "SUPER_ADMIN") {
      return res.json({
        success: true,
        store: null,
        role: "SUPER_ADMIN",
        phone: phoneWithCode
      });
    }

    const negocio = { ...negocioData, phone: phoneWithCode };
    res.json({ success: true, store: negocio });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  INVENTARIO — Lee/escribe en Firestore
// ══════════════════════════════════════════════════════════════════
app.get("/products", async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  try {
    const snap = await db.collection("negocios").doc(phone).collection("inventario").get();
    const productos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(productos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/products", async (req, res) => {
  const { nombre, precio, stock, categoria, store_phone } = req.body;
  if (!store_phone) return res.status(400).json({ error: "store_phone requerido" });
  try {
    const slug = nombre.toLowerCase().replace(/\s+/g, "_") + "_" + Date.now();
    const ref = db.collection("negocios").doc(store_phone).collection("inventario").doc(slug);
    const producto = { nombre, precio: parseInt(precio), stock: parseInt(stock) || 0, categoria, actualizado_en: new Date().toISOString() };
    await ref.set(producto);
    res.json({ id: slug, ...producto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/products/:id", async (req, res) => {
  const { store_phone, nombre, precio, stock, categoria } = req.body;
  if (!store_phone) return res.status(400).json({ error: "store_phone requerido" });
  try {
    const ref = db.collection("negocios").doc(store_phone).collection("inventario").doc(req.params.id);
    const update = { actualizado_en: new Date().toISOString() };
    if (nombre !== undefined) update.nombre = nombre;
    if (precio !== undefined) update.precio = parseInt(precio);
    if (stock !== undefined) update.stock = parseInt(stock);
    if (categoria !== undefined) update.categoria = categoria;
    await ref.update(update);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/products/:id", async (req, res) => {
  const { store_phone } = req.query;
  if (!store_phone) return res.status(400).json({ error: "store_phone requerido" });
  try {
    await db.collection("negocios").doc(store_phone).collection("inventario").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  PEDIDOS — Lee de transacciones Firestore
// ══════════════════════════════════════════════════════════════════
app.get("/orders", async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  try {
    const snap = await db.collection("negocios").doc(phone)
      .collection("transacciones")
      .where("tipo", "==", "VENTA")
      .orderBy("fecha", "desc")
      .limit(50)
      .get();

    const orders = snap.docs.map(d => ({
      id: d.id,
      cliente: d.data().cliente || d.data().nombre_cliente || "Cliente",
      producto: d.data().producto || d.data().descripcion || "",
      total: d.data().total || d.data().monto || 0,
      estado: d.data().estado || (d.data().pagado ? "ENTREGADO" : "PENDIENTE"),
      created_at: d.data().fecha,
      ...d.data(),
    }));

    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/orders/:id", async (req, res) => {
  const { store_phone, estado } = req.body;
  if (!store_phone) return res.status(400).json({ error: "store_phone requerido" });
  try {
    await db.collection("negocios").doc(store_phone)
      .collection("transacciones").doc(req.params.id)
      .update({ estado, actualizado_en: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  STATS — Calcula desde Firestore
// ══════════════════════════════════════════════════════════════════
app.get("/stats", async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone requerido" });

  try {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const hace7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Transacciones últimos 7 días
    const snap = await db.collection("negocios").doc(phone)
      .collection("transacciones")
      .where("tipo", "==", "VENTA")
      .where("fecha", ">=", hace7dias.toISOString())
      .get();

    const transacciones = snap.docs.map(d => d.data());
    const hoyISO = hoy.toISOString();

    const ventasHoy = transacciones
      .filter(t => t.fecha >= hoyISO)
      .reduce((a, t) => a + (t.total || 0), 0);

    const pedidosHoy = transacciones.filter(t => t.fecha >= hoyISO).length;
    const pendientes = transacciones.filter(t => t.estado === "PENDIENTE").length;
    const totalSemana = transacciones.reduce((a, t) => a + (t.total || 0), 0);

    // Inventario
    const invSnap = await db.collection("negocios").doc(phone).collection("inventario").get();
    const productos = invSnap.docs.map(d => d.data());
    const totalStock = productos.reduce((a, p) => a + (p.stock || 0), 0);

    // Ventas por día (últimos 7 días)
    const diasSemana = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const ventasPorDia = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().split("T")[0];
      ventasPorDia[key] = { dia: i === 0 ? "Hoy" : diasSemana[d.getDay()], ventas: 0 };
    }
    for (const t of transacciones) {
      const key = t.fecha?.split("T")[0];
      if (ventasPorDia[key]) ventasPorDia[key].ventas += t.total || 0;
    }

    res.json({
      ventasHoy,
      pedidosHoy,
      pendientes,
      totalStock,
      numProductos: productos.length,
      totalSemana,
      ventasSemana: Object.values(ventasPorDia),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ADMIN — Dashboard para SUPER_ADMIN
// ══════════════════════════════════════════════════════════════════

// 📌 Obtener todos los negocios (solo SUPER_ADMIN)
app.get("/admin/negocios", async (req, res) => {
  try {
    // Obtener teléfono del header de autorización
    const phoneWithCode = req.headers.authorization?.replace("Bearer ", "");

    if (!phoneWithCode) {
      return res.status(401).json({ error: "No autorizado" });
    }

    // Verificar que sea SUPER_ADMIN
    const adminDoc = await db.collection("negocios").doc(phoneWithCode).get();

    if (!adminDoc.exists) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const adminData = adminDoc.data();

    if (adminData.tipo_usuario !== "SUPER_ADMIN") {
      return res.status(403).json({ error: "Solo SUPER_ADMIN puede acceder" });
    }

    // Obtener todos los negocios
    const negociosSnapshot = await db.collection("negocios")
      .where("tipo_usuario", "==", "NEGOCIO")
      .get();

    const negocios = [];
    negociosSnapshot.forEach(doc => {
      negocios.push({
        id: doc.id,
        ...doc.data()
      });
    });

    console.log(`✅ Admin ${phoneWithCode} solicitó ${negocios.length} negocios`);

    res.json(negocios);
  } catch (error) {
    console.error("❌ Error en /admin/negocios:", error);
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  INICIO DEL SERVIDOR
// ══════════════════════════════════════════════════════════════════

app.listen(process.env.PORT || 3000, () => console.log("🚀 Flow CRM corriendo en puerto " + (process.env.PORT || 3000)));
