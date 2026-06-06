require("dotenv").config();

const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ─────────────────────────────
//  INIT CLIENTS
// ─────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─────────────────────────────
//  MEMORY STORE (simple)
// ─────────────────────────────
const conversations = {};

// ─────────────────────────────
//  PRODUCTS
// ─────────────────────────────
const PRODUCT_CATALOG = require("./products");

// ─────────────────────────────
//  SYSTEM PROMPT
// ─────────────────────────────
function buildSystemPrompt() {
  return `You are a WhatsApp sales assistant for ${process.env.BUSINESS_NAME || "Our Store"}.

PRODUCTS:
${PRODUCT_CATALOG.map(
  (p) =>
    `- ${p.name} | ₦${p.price} | Sizes: ${p.sizes} | Colors: ${p.colors} | ${p.inStock ? "In stock" : "Out of stock"} | ${p.description}`
).join("\n")}

Rules:
- Keep replies short
- Be friendly and human
- Never invent products outside catalog
- Always end with a question`;
}

// ─────────────────────────────
//  WEBHOOK VERIFY (WATI / META)
// ─────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ─────────────────────────────
//  MAIN WEBHOOK
// ─────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("📩 Webhook received:", JSON.stringify(req.body));

    let from;
    let messageText;

    const body = req.body;

    // ── WATI FORMAT (flexible) ──
    if (body.waId || body.sender || body.phone) {
      from = body.waId || body.sender || body.phone;
      messageText =
        body.text ||
        body.message ||
        body.body?.text ||
        body.data?.text;
    }

    // ── META FORMAT ──
    else if (body.object === "whatsapp_business_account") {
      const msg =
        body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

      if (!msg) return;

      from = msg.from;
      messageText = msg.text?.body;
    }

    if (!from || !messageText) {
      console.log("⚠️ Unrecognized message format");
      return;
    }

    console.log(`💬 From ${from}: ${messageText}`);

    // ── Conversation memory ──
    if (!conversations[from]) conversations[from] = [];

    conversations[from].push({ role: "user", content: messageText });

    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    // ── Claude AI call ──
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: buildSystemPrompt(),
      messages: conversations[from],
    });

    const reply =
      response?.content?.[0]?.text ||
      "Sorry, I couldn't process that right now.";

    conversations[from].push({
      role: "assistant",
      content: reply,
    });

    await sendWhatsAppMessage(from, reply);

    console.log("✅ Reply sent");
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
});

// ─────────────────────────────
//  SEND MESSAGE (WATI / META)
// ─────────────────────────────
async function sendWhatsAppMessage(to, text) {
  const provider = process.env.WHATSAPP_PROVIDER || "wati";

  if (provider === "wati") {
    await axios.post(
      `${process.env.WATI_API_URL}/api/v1/sendSessionMessage/${to}`,
      { messageText: text },
      {
        headers: {
          Authorization: `Bearer ${process.env.WATI_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } else {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
        },
      }
    );
  }
}

// ─────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Bot running ✔️" });
});

// ─────────────────────────────
//  START SERVER (RAILWAY SAFE)
// ─────────────────────────────
const PORT = process.env.PORT;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
