import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "innerself-ai", time: new Date().toISOString() });
});

/* ---------- Utils ---------- */
function nowMs() { return Date.now(); }

function badRequest(res, message) {
  return res.status(400).json({ error: "Invalid request body", message });
}

function extractText(resp) {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }

  const out = resp?.output;
  if (Array.isArray(out)) {
    const chunks = [];
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (typeof c?.text === "string" && c.text.trim()) chunks.push(c.text);
      }
    }
    if (chunks.length) return chunks.join("").trim();
  }

  return "";
}

function parseModelJSON(raw) {
  const s = (raw ?? "").trim();
  if (!s) {
    const err = new Error("EMPTY_MODEL_OUTPUT");
    err.code = "EMPTY_MODEL_OUTPUT";
    throw err;
  }

  // 先嘗試直接 parse
  try {
    return JSON.parse(s);
  } catch (_) {
    // 再嘗試擷取第一個 { 到最後一個 }
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const sliced = s.slice(first, last + 1);
      try {
        return JSON.parse(sliced);
      } catch (e2) {
        const err = new Error("JSON_PARSE_FAILED");
        err.code = "JSON_PARSE_FAILED";
        err.details = e2?.message ?? String(e2);
        err.preview = sliced.slice(0, 300);
        throw err;
      }
    }

    const err = new Error("JSON_PARSE_FAILED");
    err.code = "JSON_PARSE_FAILED";
    err.preview = s.slice(0, 300);
    throw err;
  }
}

/* ---------- Prompt builders (維持你新版規則) ---------- */
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
2) 每張牌都要有：
   - actionDirection：一句（15～30 個全形中文字）
   - possibleOutcome：一句（≤50 個全形中文字，含標點）
3) 【定錨規則】actionDirection 與 possibleOutcome 必須同時回應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   不得只描述抽象態度或通用建議。
4) 不占卜、不保證、不下結論。
5) 嚴格輸出 JSON，不得有多餘文字。

【輸出 JSON Schema】
{
  "version": "basic_v1_json",
  "language": "zh-Hant",
  "question": string,
  "context": string | null,
  "directions": [
    { "id": "A", "cardText": string, "actionDirection": string, "possibleOutcome": string },
    { "id": "B", "cardText": string, "actionDirection": string, "possibleOutcome": string },
    { "id": "C", "cardText": string, "actionDirection": string, "possibleOutcome": string }
  ]
}

請直接輸出 JSON。
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
2) 主牌：每個都要有
   - actionDirection：一句（15～30 個全形中文字）
   - possibleOutcome：一句（≤50 個全形中文字，含標點）
3) 子牌：只輸出 possibleOutcome（≤50 個全形中文字，含標點）。
4) 【定錨規則】主牌 actionDirection 與 possibleOutcome 必須同時回應：
   - 使用者問題
   -（若有）既有前提／已選擇的路徑
   - 該牌卡在此情境下提供的行動視角
   不得只描述抽象態度或通用建議。
5) 12 句 possibleOutcome 的句型與語氣盡量避免重複。
6) 不占卜、不保證、不下結論。
7) 嚴格輸出 JSON，不得有多餘文字。

【輸出 JSON Schema】
{
  "version": "clear_v1_json",
  "language": "zh-Hant",
  "question": string,
  "context": string | null,
  "directions": [
    {
      "id": "A",
      "cardText": string,
      "actionDirection": string,
      "possibleOutcome": string,
      "branches": [
        { "id": "A-1", "cardText": string, "possibleOutcome": string },
        { "id": "A-2", "cardText": string, "possibleOutcome": string },
        { "id": "A-3", "cardText": string, "possibleOutcome": string }
      ]
    },
    {
      "id": "B",
      "cardText": string,
      "actionDirection": string,
      "possibleOutcome": string,
      "branches": [
        { "id": "B-1", "cardText": string, "possibleOutcome": string },
        { "id": "B-2", "cardText": string, "possibleOutcome": string },
        { "id": "B-3", "cardText": string, "possibleOutcome": string }
      ]
    },
    {
      "id": "C",
      "cardText": string,
      "actionDirection": string,
      "possibleOutcome": string,
      "branches": [
        { "id": "C-1", "cardText": string, "possibleOutcome": string },
        { "id": "C-2", "cardText": string, "possibleOutcome": string },
        { "id": "C-3", "cardText": string, "possibleOutcome": string }
      ]
    }
  ]
}

請直接輸出 JSON。
`.trim();
}

/* ---------- OpenAI caller (取消 max_output_tokens) ---------- */
async function callOpenAIJSON({ prompt, tag }) {
  const t0 = nowMs();

  const resp = await openai.responses.create({
    model: "o4-mini",
    input: prompt,
    text: { format: { type: "json_object" } }
  });

  const t1 = nowMs();
  return { resp, ms: t1 - t0 };
}

/* ---------- API: Basic ---------- */
app.post("/ai/three-card/basic", async (req, res) => {
  const total0 = nowMs();

  const { question, context, mainCards } = req.body || {};
  if (!question) return badRequest(res, "missing question");
  if (!Array.isArray(mainCards) || mainCards.length !== 3) return badRequest(res, "mainCards must be length 3");

  try {
    console.log("➡️ calling OpenAI (basic)");

    const tPrompt0 = nowMs();
    const prompt = buildBasicPrompt({ question, context, mainCards });
    console.log("⏱ basic buildPrompt ms:", nowMs() - tPrompt0);

    const { resp, ms } = await callOpenAIJSON({ prompt, tag: "basic" });
    console.log("⏱ basic openai ms:", ms);

    const raw = extractText(resp);
    console.log("📏 basic output chars:", raw.length);
    if (resp?.id) console.log("🧾 basic request_id:", resp.id);

    const tParse0 = nowMs();
    const parsed = parseModelJSON(raw);
    console.log("⏱ basic parse ms:", nowMs() - tParse0);

    console.log("⏱ basic total ms:", nowMs() - total0);
    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed (basic):", err?.code ?? err);
    if (err?.preview) console.error("🧩 preview:", err.preview);
    console.log("⏱ basic total ms (fallback):", nowMs() - total0);

    // 你若要 fallback 也可以，但你現在主要在 debug，我先回錯誤讓你看得清楚
    return res.status(500).json({
      error: "OPENAI_BASIC_FAILED",
      code: err?.code ?? "UNKNOWN",
      details: err?.details ?? null,
      preview: err?.preview ?? null
    });
  }
});

/* ---------- API: Clear ---------- */
app.post("/ai/three-card/clear", async (req, res) => {
  const total0 = nowMs();

  const { question, context, mainCards, branchCards } = req.body || {};
  if (!question) return badRequest(res, "missing question");
  if (!Array.isArray(mainCards) || mainCards.length !== 3) return badRequest(res, "mainCards must be length 3");
  if (!Array.isArray(branchCards) || branchCards.length !== 9) return badRequest(res, "branchCards must be length 9");

  try {
    console.log("➡️ calling OpenAI (clear)");

    const tPrompt0 = nowMs();
    const prompt = buildClearPrompt({ question, context, mainCards, branchCards });
    console.log("⏱ clear buildPrompt ms:", nowMs() - tPrompt0);

    const { resp, ms } = await callOpenAIJSON({ prompt, tag: "clear" });
    console.log("⏱ clear openai ms:", ms);

    const raw = extractText(resp);
    console.log("📏 clear output chars:", raw.length);
    if (resp?.id) console.log("🧾 clear request_id:", resp.id);

    const tParse0 = nowMs();
    const parsed = parseModelJSON(raw);
    console.log("⏱ clear parse ms:", nowMs() - tParse0);

    console.log("⏱ clear total ms:", nowMs() - total0);
    return res.json(parsed);

  } catch (err) {
    console.error("⚠️ OpenAI failed (clear):", err?.code ?? err);
    if (err?.preview) console.error("🧩 preview:", err.preview);
    console.log("⏱ clear total ms (fallback):", nowMs() - total0);

    return res.status(500).json({
      error: "OPENAI_CLEAR_FAILED",
      code: err?.code ?? "UNKNOWN",
      details: err?.details ?? null,
      preview: err?.preview ?? null
    });
  }
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
