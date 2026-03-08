const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "flow-crm-secret";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.get("/", (req, res) => res.json({ status: "Flow CRM Backend running 🚀" }));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    const contacts = req.body?.entry?.[0]?.changes?.[0]?.value?.contacts;
    if (!messages) return;
    for (const msg of messages) {
      const from = msg.from;
      const text = msg.text?.body || "[no texto]";
      const timestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString();
      const name = contacts?.[0]?.profile?.name || from;
      await supabase.from("contacts").upsert({ phone: from, name, updated_at: timestamp }, { onConflict: "phone" });
      await supabase.from("messages").insert({ from_number: from, to_number: PHONE_NUMBER_ID, body: text, direction: "inbound", timestamp });
      await supabase.from("conversations").upsert({ phone: from, contact_name: name, last_message: text, last_message_at: timestamp, status: "open" }, { onConflict: "phone" });
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
});

app.post("/send", async (req, res) => {
  const { to, message } = req.body;
  try {
    await axios.post(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: message } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    const timestamp = new Date().toISOString();
    await supabase.from("messages").insert({ from_number: PHONE_NUMBER_ID, to_number: to, body: message, direction: "outbound", timestamp });
    await supabase.from("conversations").upsert({ phone: to, last_message: message, last_message_at: timestamp }, { onConflict: "phone" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get("/conversations", async (req, res) => {
  const { data, error } = await supabase.from("conversations").select("*").order("last_message_at", { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get("/messages/:phone", async (req, res) => {
  const { data, error } = await supabase.from("messages").select("*")
    .or(`from_number.eq.${req.params.phone},to_number.eq.${req.params.phone}`)
    .order("timestamp", { ascending: true });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Servidor corriendo"));
