app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // always acknowledge fast

  try {
    console.log("📩 Incoming webhook:", JSON.stringify(req.body, null, 2));

    const body = req.body;

    let from;
    let messageText;

    // ─── WATI FORMAT (more flexible parsing) ─────────────────────
    if (body.waId || body.sender || body.phone) {
      from = body.waId || body.sender || body.phone;

      messageText =
        body.text ||
        body.message ||
        body.textMessage ||
        body.body?.text ||
        body.data?.text;

    // ─── META FORMAT ─────────────────────────────────────────────
    } else if (body.object === "whatsapp_business_account") {
      const message =
        body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

      if (!message) return;

      from = message.from;
      messageText = message.text?.body;
    }

    if (!from || !messageText) {
      console.log("⚠️ Could not parse message format");
      return;
    }

    console.log(`💬 Message from ${from}: ${messageText}`);

    // ─── Conversations ───────────────────────────────────────────
    if (!conversations[from]) conversations[from] = [];

    conversations[from].push({ role: "user", content: messageText });

    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    // ─── Claude call ─────────────────────────────────────────────
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: buildSystemPrompt(),
      messages: conversations[from],
    });

    const reply =
      response?.content?.[0]?.text ||
      "Sorry, I couldn't generate a response.";

    conversations[from].push({ role: "assistant", content: reply });

    await sendWhatsAppMessage(from, reply);

    console.log(`✅ Reply sent to ${from}`);
  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
});
