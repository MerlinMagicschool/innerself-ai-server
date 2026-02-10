import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "innerself-ai",
    time: new Date().toISOString(),
  });
});

/* ---------- Utils ---------- */
function badRequest(res, message) {
  return res.status(400).json({ error: "Invalid request body", message });
}

function extractText(resp) {
  // 1) SDK convenience (sometimes empty depending on format)
  if (typeof resp?.output_text === "string" && resp.output_text.trim().length > 0) {
    return resp.output_text.trim();
  }

  // 2) Walk through output -> content to find any text
  const chunks = [];
  const out = resp?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (typeof c?.text === "string" && c.text.trim().length > 0) {
          chunks.push(c.text.trim());
        }
      }
    }
  }

  if (chunks.length > 0) return chunks.join("\n");
  return "";
}

/* ---------- Prompt builders (你的新版規則文字，可維持) ---------- */
function buildBasicPrompt({ question, context, mainCards }) {
  const ctx = context && context.trim() ? context.trim() : "null";
  return `
你是 innerSelf App 的「基礎版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

【輸入】
- 使用者問題：${question}
-（可選）既有前提／已選擇的路徑：${ctx}

主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

【嚴格規則】
1) 不改寫牌文（cardText 必須逐字等於輸入）。
2) 每張牌都要有 actionDirection（15～30 個全形中文字）與 possibleOutcome（≤50 個全形中文字）。
3) 【定錨規則】actionDirection 與 possibleOutcome 必須同時回應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   不得只描述抽象態度或通用建議。
4) 不占卜、不保證、不下結論。

【輸出】
請用「可讀的文字段落」輸出（先不要 JSON）。
每張牌用以下格式：
- [A] 牌文：...
  行動方向：...
  可能結果：...
`.trim();
}

function buildClearPrompt({ question, context, mainCards, branchCards }) {
  const ctx = context && context.trim() ? context.trim() : "null";
  return `
你是 innerSelf App 的「明晰版三張回應卡」引導者。
抽牌已在 App 端完成，你不需要也不可以再抽牌。

【輸入】
- 使用者問題：${question}
-（可選）既有前提／已選擇的路徑：${ctx}

主牌：
A) ${mainCards[0]}
B) ${mainCards[1]}
C) ${mainCards[2]}

子牌：
A-1) ${branchCards[0]}  A-2) ${branchCards[1]}  A-3) ${branchCards[2]}
B-1) ${branchCards[3]}  B-2) ${branchCards[4]}  B-3) ${branchCards[5]}
C-1) ${branchCards[6]}  C-2) ${branchCards[7]}  C-3) ${branchCards[8]}

【嚴格規則】
1) 不改寫牌文（cardText 必須逐字等於輸入）。
2) 主牌 actionDirection（15～30 全形字）與 possibleOutcome（≤50 全形字）。
3) 子牌只輸出 possibleOutcome（≤50 全形字）。
4) 【定錨規則】主牌 actionDirection 與 possibleOutcome 必須同時回應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   不得只描述抽象態度或通用建議。
5) 不占卜、不保證、不下結論。

【輸出】
請用「可讀的文字段落」輸出（先不要 JSON）。
格式：
[A] 主牌：...
  行動方向：...
  主結果：...
  子牌：
    - A-1 ...：...
    - A-2 ...：...
    - A-3 ...：...
(依序輸出 B / C)
`.trim();
}

/* ---------- API: Basic (RAW) ---------- */
app.post("/ai/three-card/basic", async (req, res) => {
  const { question, context, mainCards } = req.body || {};
  if (!question) return badRequest(res, "missing question");
  if (!Array.isArray(mainCards) || mainCards.length !== 3) {
    return badRequest(res, "mainCards must be length 3");
  }

  try {
    console.log("➡️ calling OpenAI (basic)");

    const prompt = buildBasicPrompt({ question, context, mainCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
    });

    const raw = extractText(ai);

    console.log("🔎 output_text length:", (ai.output_text || "").length);
    console.log("🔎 extracted text chars:", (raw || "").length);

    console.log(
      "🔎 raw OpenAI response (truncated):",
      JSON.stringify(ai, null, 2).slice(0, 4000)
    );

    if (raw && raw.trim().length > 0) {
      return res.type("text/plain; charset=utf-8").send(raw);
    }

    // 如果真的抽不到文字，就把 ai 結構回傳（讓你查是哪個欄位）
    return res
      .status(200)
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ note: "NO_TEXT_EXTRACTED", ai }, null, 2));
  } catch (err) {
    console.error("⚠️ OpenAI failed (basic):", err);
    return res.status(502).json({
      error: "OPENAI_BASIC_FAILED",
      message: err?.message ?? String(err),
      code: err?.code ?? null,
    });
  }
});

/* ---------- API: Clear (RAW) ---------- */
app.post("/ai/three-card/clear", async (req, res) => {
  const { question, context, mainCards, branchCards } = req.body || {};
  if (!question) return badRequest(res, "missing question");
  if (!Array.isArray(mainCards) || mainCards.length !== 3) {
    return badRequest(res, "mainCards must be length 3");
  }
  if (!Array.isArray(branchCards) || branchCards.length !== 9) {
    return badRequest(res, "branchCards must be length 9");
  }

  try {
    console.log("➡️ calling OpenAI (clear)");

    const prompt = buildClearPrompt({ question, context, mainCards, branchCards });

    const ai = await openai.responses.create({
      model: "o4-mini",
      input: prompt,
    });

    const raw = extractText(ai);

    console.log("🔎 output_text length:", (ai.output_text || "").length);
    console.log("🔎 extracted text chars:", (raw || "").length);

    console.log(
      "🔎 raw OpenAI response (truncated):",
      JSON.stringify(ai, null, 2).slice(0, 4000)
    );

    if (raw && raw.trim().length > 0) {
      return res.type("text/plain; charset=utf-8").send(raw);
    }

    return res
      .status(200)
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ note: "NO_TEXT_EXTRACTED", ai }, null, 2));
  } catch (err) {
    console.error("⚠️ OpenAI failed (clear):", err);
    return res.status(502).json({
      error: "OPENAI_CLEAR_FAILED",
      message: err?.message ?? String(err),
      code: err?.code ?? null,
    });
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
