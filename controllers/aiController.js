const { GoogleGenerativeAI } = require("@google/generative-ai");
const Item = require("../models/Item");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// Recommended active models priority list
const MODEL_PRIORITY = [
  "gemini-3.8-flash",
  "gemini-1.5-flash"
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Local fallback matcher. Candidate records are always supplied by the
// database query, which already restricts them to the opposite item type.
const getKeywordMatches = (currentItem, candidateItems) => {
  const targetText = `${currentItem.title || ""} ${currentItem.description || ""} ${currentItem.location || ""}`.toLowerCase();
  const targetWords = [...new Set(targetText.split(/\s+/).filter((word) => word.length > 3))];

  return candidateItems
    .map((candidate) => {
      const candidateText = `${candidate.title || ""} ${candidate.description || ""} ${candidate.location || ""}`.toLowerCase();
      let score = 0;

      if ((currentItem.category || "").toLowerCase() === (candidate.category || "").toLowerCase()) {
        score += 40;
      }

      const matchedWords = targetWords.filter((word) => candidateText.includes(word)).length;
      if (targetWords.length) {
        score += Math.min(60, Math.round((matchedWords / targetWords.length) * 60));
      }

      return {
        candidateId: candidate._id.toString(),
        matchScore: Math.min(100, score),
        reason: `Matched using item category, description and location details.`,
      };
    })
    .filter((match) => match.matchScore >= 40)
    .sort((a, b) => b.matchScore - a.matchScore);
};

// 1. AI Matchmaker Function
const matchItemWithAI = async (req, res) => {
  try {
    const { itemId } = req.body;

    if (!itemId) {
      return res.status(400).json({ message: "Item ID is required" });
    }

    if (!require("mongoose").isValidObjectId(itemId)) {
      return res.status(400).json({ message: "Invalid item ID" });
    }

    const currentItem = await Item.findById(itemId);
    if (!currentItem) {
      return res.status(404).json({ message: "Item not found in database" });
    }

    const oppositeType = currentItem.type === "lost" ? "found" : "lost";
    const requesterId = req.user?._id;

    // Only open records of the opposite type can be matches.
    // Exclude the logged-in user's own records so the UI cannot offer
    // a claim request against an item they own.
    const candidateItems = await Item.find({
      type: oppositeType,
      status: "open",
      ...(requesterId ? { user: { $ne: requesterId } } : {}),
    })
      .populate("user", "name email phone")
      .sort({ createdAt: -1 })
      .limit(30);

    if (!candidateItems.length) {
      return res.status(200).json({
        success: true,
        currentItemId: currentItem._id,
        currentItemType: currentItem.type,
        expectedMatchType: oppositeType,
        matches: [],
        message: `No open ${oppositeType} items are available to compare.`,
      });
    }

    const candidatePayload = candidateItems.map((candidate) => ({
      candidateId: candidate._id.toString(),
      title: candidate.title,
      category: candidate.category,
      location: candidate.location,
      description: candidate.description,
    }));

    const prompt = `
      You are an AI Lost & Found Matchmaker.
      Compare the TARGET ITEM with the CANDIDATE ITEMS.
      Return only genuine possible matches with matchScore from 50 to 100.
      You MUST only use candidateId values supplied in the candidate list.

      TARGET ITEM:
      ${JSON.stringify({
        title: currentItem.title,
        category: currentItem.category,
        location: currentItem.location,
        description: currentItem.description,
        type: currentItem.type,
      })}

      CANDIDATE ITEMS:
      ${JSON.stringify(candidatePayload)}

      Return a raw JSON array. Each object must contain candidateId, matchScore,
      and reason. Do not include markdown or any text outside the JSON array.
    `;

    let rawText = null;

    if (process.env.GEMINI_API_KEY) {
      for (const modelName of MODEL_PRIORITY) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`AI matching with ${modelName} (attempt ${attempt})`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            rawText = result.response.text().trim();
            if (rawText) break;
          } catch (err) {
            console.warn(`AI model ${modelName} attempt ${attempt} failed: ${err.message}`);
            await delay(800);
          }
        }
        if (rawText) break;
      }
    }

    let scoredMatches = [];
    if (rawText) {
      try {
        const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          const allowedIds = new Set(candidateItems.map((candidate) => candidate._id.toString()));
          scoredMatches = parsed
            .filter((match) => match && allowedIds.has(String(match.candidateId)))
            .map((match) => ({
              candidateId: String(match.candidateId),
              matchScore: Math.max(0, Math.min(100, Number(match.matchScore) || 0)),
              reason: String(match.reason || "Potential match based on item details."),
            }))
            .filter((match) => match.matchScore >= 50);
        } else {
          scoredMatches = getKeywordMatches(currentItem, candidateItems);
        }
      } catch (parseError) {
        console.error("AI response JSON parsing failed; using local matching.", parseError.message);
        scoredMatches = getKeywordMatches(currentItem, candidateItems);
      }
    } else {
      scoredMatches = getKeywordMatches(currentItem, candidateItems);
    }

    // Attach the exact database record to every score. The frontend must use
    // this _id for claims; it must never search by title to guess an ID.
    const candidateById = new Map(
      candidateItems.map((candidate) => [candidate._id.toString(), candidate])
    );

    const matches = scoredMatches
      .map((match) => {
        const candidate = candidateById.get(match.candidateId);
        if (!candidate || candidate.type !== oppositeType || candidate.status !== "open") return null;
        return {
          candidateId: candidate._id.toString(),
          matchScore: match.matchScore,
          reason: match.reason,
          _id: candidate._id,
          title: candidate.title,
          description: candidate.description,
          category: candidate.category,
          location: candidate.location,
          type: candidate.type,
          imageUrl: candidate.imageUrl,
          image: candidate.imageUrl,
          date: candidate.date,
          status: candidate.status,
          user: candidate.user,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.matchScore - a.matchScore);

    return res.status(200).json({
      success: true,
      currentItemId: currentItem._id,
      currentItemType: currentItem.type,
      expectedMatchType: oppositeType,
      matches,
    });
  } catch (error) {
    console.error("BACKEND AI CONTROLLER ERROR:", error.stack || error.message || error);
    return res.status(500).json({
      message: error.message || "Error processing AI match",
    });
  }
};

// 2. Image Auto-Fill Scan Function (Smart Fallback)
const analyzeImageWithAI = async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ message: "Image base64 data is required" });
    }

    const cleanBase64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;

    const prompt = `
      Analyze this image for a Lost & Found item.
      Return ONLY a JSON object with:
      1. title: Short 2-3 word object name (e.g., "Black Leather Wallet", "iPhone 13").
      2. category: Must be EXACTLY one of: "Electronics", "Documents", "Keys", "Clothing", "Jewelry", "Others".
      3. description: Short 1-2 sentence description of visible physical details.

      Do NOT wrap in markdown code blocks.
    `;

    let rawText = null;

    for (const modelName of MODEL_PRIORITY) {
      try {
        console.log(`🔍 AI Scanning Image with model: ${modelName}`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([
          prompt,
          {
            inlineData: {
              data: cleanBase64,
              mimeType: mimeType || "image/jpeg",
            },
          },
        ]);
        rawText = result.response.text().trim();
        if (rawText) break;
      } catch (err) {
        console.warn(`⚠️ Image Scan ${modelName} failed: ${err.message}`);
      }
    }

    // 🛡️ Clean fallback response when Google AI is busy (503/404)
    if (!rawText) {
      console.warn("⚠️ AI Service busy. Using clean fallback structure.");
      return res.status(200).json({
        success: true,
        analysis: {
          title: "",
          category: "Others",
          description: "Image uploaded. Please add item details."
        }
      });
    }

    rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const analysis = JSON.parse(rawText);

    return res.status(200).json({
      success: true,
      analysis,
    });
  } catch (error) {
    console.error("❌ Image AI Analysis Error:", error.message);
    return res.status(200).json({ 
      success: true, 
      analysis: {
        title: "",
        category: "Others",
        description: "Please update description manually."
      } 
    });
  }
};

module.exports = {
  matchItemWithAI,
  analyzeImageWithAI,
};