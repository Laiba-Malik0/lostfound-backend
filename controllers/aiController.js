const { GoogleGenerativeAI } = require("@google/generative-ai");
const Item = require("../models/Item");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// Recommended active models priority list
const MODEL_PRIORITY = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite"
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Local Fallback Matcher
const getKeywordMatches = (currentItem, candidateItems) => {
  return candidateItems
    .map((candidate) => {
      let score = 0;
      const targetText = `${currentItem.title} ${currentItem.description} ${currentItem.location}`.toLowerCase();
      const candText = `${candidate.title} ${candidate.description} ${candidate.location}`.toLowerCase();

      if (currentItem.category.toLowerCase() === candidate.category.toLowerCase()) {
        score += 40;
      }

      const targetWords = targetText.split(/\s+/).filter((w) => w.length > 3);
      let matchedWords = 0;
      targetWords.forEach((word) => {
        if (candText.includes(word)) matchedWords++;
      });

      if (targetWords.length > 0) {
        score += Math.min(50, Math.round((matchedWords / targetWords.length) * 60));
      }

      return {
        candidateId: candidate._id.toString(),
        matchScore: score,
        reason: `Matched based on category (${candidate.category}) and location keywords.`,
      };
    })
    .filter((m) => m.matchScore >= 40)
    .sort((a, b) => b.matchScore - a.matchScore);
};

// 1. AI Matchmaker Function
const matchItemWithAI = async (req, res) => {
  try {
    const { itemId } = req.body;

    if (!itemId) {
      return res.status(400).json({ message: "Item ID is required" });
    }

    const currentItem = await Item.findById(itemId);
    if (!currentItem) {
      return res.status(404).json({ message: "Item not found in database" });
    }

    const oppositeType = currentItem.type === "lost" ? "found" : "lost";

    let candidateItems = await Item.find({
      type: oppositeType,
      category: currentItem.category,
    }).limit(15);

    if (candidateItems.length < 5) {
      const extraItems = await Item.find({
        type: oppositeType,
        _id: { $nin: candidateItems.map((i) => i._id) },
      }).limit(15 - candidateItems.length);
      candidateItems = candidateItems.concat(extraItems);
    }

    if (!candidateItems || candidateItems.length === 0) {
      return res.status(200).json({
        success: true,
        currentItemId: currentItem._id,
        matches: [],
        message: `No ${oppositeType} items available in database to compare`,
      });
    }

    const prompt = `
      You are an AI Lost & Found Matchmaker.
      Compare TARGET ITEM with CANDIDATE ITEMS and calculate match score (0 to 100%) for each.

      TARGET ITEM:
      - Title: ${currentItem.title}
      - Category: ${currentItem.category}
      - Location: ${currentItem.location}
      - Description: ${currentItem.description}

      CANDIDATE ITEMS:
      ${JSON.stringify(
        candidateItems.map((item) => ({
          candidateId: item._id.toString(),
          title: item.title,
          category: item.category,
          location: item.location,
          description: item.description,
        }))
      )}

      Only return candidates with matchScore >= 50%.
      Return RAW JSON ARRAY containing objects with keys: candidateId, matchScore, reason. Do not wrap in markdown code blocks.
    `;

    let rawText = null;

    for (const modelName of MODEL_PRIORITY) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`🤖 Attempting AI matching with model: ${modelName} (Attempt ${attempt})`);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent(prompt);
          rawText = result.response.text().trim();
          if (rawText) break;
        } catch (err) {
          console.warn(`⚠️ Model ${modelName} attempt ${attempt} failed: ${err.message}`);
          await delay(1000);
        }
      }
      if (rawText) break;
    }

    let matches = [];

    if (rawText) {
      rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
      try {
        matches = JSON.parse(rawText);
      } catch (parseError) {
        console.error("❌ JSON Parse Error, using local fallback matcher.");
        matches = getKeywordMatches(currentItem, candidateItems);
      }
    } else {
      console.warn("⚠️ AI Service unavailable. Serving local heuristic matches.");
      matches = getKeywordMatches(currentItem, candidateItems);
    }

    return res.status(200).json({
      success: true,
      currentItemId: currentItem._id,
      matches,
    });
  } catch (error) {
    console.error("❌ BACKEND AI CONTROLLER ERROR:", error.stack || error.message || error);
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
          description: "Image uploaded successfully. Please add item details."
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