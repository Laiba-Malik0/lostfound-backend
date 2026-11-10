const express = require("express");
const router = express.Router();
const { matchItemWithAI, analyzeImageWithAI } = require("../controllers/aiController");
const { protect } = require("../middleware/authMiddleware");

// Matchmaker Route
router.post("/match", protect, matchItemWithAI);

// Image Auto-Fill Scan Route (YE MISSING THA!)
router.post("/analyze-image", protect, analyzeImageWithAI);

module.exports = router;