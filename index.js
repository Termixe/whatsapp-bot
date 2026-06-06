const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory conversation store (replace with DB in production) ───────────
const conversations = {};

// ─── Load your product catalog ───────────────────────────────────────────────
const PRODUCT_CATALOG = require("./products");

// ─── Build system prompt ──────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `You are a friendly and persuasive WhatsApp sales assistant for ${process.env.BUSINESS_NAME || "Our Store"}.

PRODUCT CATALOG:
${PRODUCT_CATALOG.map(p =>
  `- ${p.name} | Price: ${p.price} | Sizes: ${p.sizes || "N/A"} | Colors: ${p.colors || "N/A"} | Stock: ${p.inStock ? "Available" : "Out of stock"} | Details: ${p.description}`
).join("\n")}

YOUR ROLE:
1. Greet new customers warmly
2. Answer product questions accurately using only the catalog above
3. Qualify leads — ask about their budget, size, and preferred color
4. Collect order details: full name, delivery address, phone number
5. Confirm orders by summarizing what was ordered
6. If a product is out of stock, suggest the closest alternative

RULES:
- Keep replies SHORT (2-4 sentences max) — this is WhatsApp
- Never invent products not in the catalog
- If you don't know something, say "Let me check and get back to you"
- Always end with a clear question or next step
- Use Nigerian Naira (₦) for prices
- Be warm, human, and conversational — not robotic

When a customer is ready to order, collect in this order:
1. Full name
2. Delivery address (city + area)
3. Phone number for delivery coordination
Then confirm: "Great! I'm placing your order for [items]. Our team will contact you within 2 hours to confirm delivery."`;
}

// ─── WhatsApp webhook verification (WATI / Meta) ──────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("Webhook verified ✓");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Incoming message handler ─────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  try {
    const body = req.body;

    // Support both Meta Cloud API and WATI formats
    let from, messageText;

    if (body.object === "whatsapp_business_account") {
      // Meta Cloud API format
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];
      if (!message || message.type !== "text") return;
      from = message.from;
      messageText = message.text.body;
    } else if (body.waId) {
      // WATI format
      from = body.waId;
      messageText = body.text;
    } else {
      return;
    }

    console.log(`Message from ${from}: ${messageText}`);

    // Get or create conversation history
    if (!conversations[from]) {
      conversations[from] = [];
    }

    // Add user message to history
    conversations[from].push({ role: "user", content: messageText });

    // Keep last 20 messages to avoid token limits
    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    // Call Claude
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: buildSystemPrompt(),
      messages: conversations[from],
    });

    const reply = response.content[0].text;

    // Add assistant reply to history
    conversations[from].push({ role: "assistant", content: reply });

    // Send reply via WhatsApp
    await sendWhatsAppMessage(from, reply);

    console.log(`Reply to ${from}: ${reply}`);
  } catch (err) {
    console.error("Error handling message:", err.message);
  }
});

// ─── Send message via WhatsApp API ────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  const provider = process.env.WHATSAPP_PROVIDER || "meta"; // "meta" or "wati"

  if (provider === "wati") {
    // WATI API
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
    // Meta Cloud API
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "WhatsApp Sales Bot running ✓" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
