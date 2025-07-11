// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    elo: { type: Number, default: 0 },
    casualPoints: { type: Number, default: 0 },
    rankedCorrectAnswers: { type: Number, default: 0 },
    rankedTotalAnswers: { type: Number, default: 0 },
    casualCorrectAnswers: { type: Number, default: 0 },
    casualTotalAnswers: { type: Number, default: 0 },
    soloStage: { type: Number, default: 0 },
    soloStageAccuracy: { type: Map, of: Number, default: {} }, // Store accuracy for each stage
    tokens: { type: Number, default: 0 },
    inventory: { type: [String], default: [] }, // Array of item IDs
    equippedTitle: { type: String, default: 'New Rival' },
    warningCount: { type: Number, default: 0 }, // For inactivity penalty
    penaltyEndTime: { type: Date, default: null }, // Timestamp for penalty end
    // Add other user-specific stats or properties as needed
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
