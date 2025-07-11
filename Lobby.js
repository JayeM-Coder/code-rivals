// routes/lobby.js (Combined Model and Routes)
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose'); // Import mongoose here
const User = require('../models/User'); // User model is still separate
const { io } = require('../server'); // Import the Socket.IO instance
const jwt = require('jsonwebtoken'); // For auth middleware

// Define Lobby Schema and Model directly in this file
const playerInLobbySchema = new mongoose.Schema({
    id: { type: String, required: true }, // User's unique ID
    name: { type: String, required: true },
    isReady: { type: Boolean, default: false },
    type: { type: String, enum: ['human', 'bot'], required: true },
    elo: { type: Number, default: 0 },
    casualPoints: { type: Number, default: 0 },
    lives: { type: Number, default: 3 }, // Current lives in game
    currentRoundScore: { type: Number, default: 0 }, // Score for current game round
    roundCorrectAnswers: { type: Number, default: 0 },
    roundTotalAnswers: { type: Number, default: 0 },
    cards: { type: [{ id: String, name: String }], default: [] }, // Ability cards in hand
    shields: { type: Number, default: 0 },
    goldenDefenseUsed: { type: Boolean, default: false }
}, { _id: false }); // Do not create _id for subdocuments

const chatMessageSchema = new mongoose.Schema({
    senderId: { type: String, required: true },
    senderName: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
}, { _id: false });

const lobbySchema = new mongoose.Schema({
    lobbyId: { type: String, required: true, unique: true }, // Custom readable ID
    name: { type: String, required: true },
    type: { type: String, required: true, enum: [
        'free-for-all-qna', '1v1-fill-in-blanks', 'solo-coding-challenge',
        'ranked-free-for-all-qna', 'ranked-1v1-fill-in-blanks',
        'custom-qna', 'custom-fill-in-blanks'
    ]},
    hostId: { type: String, required: true }, // ID of the user who created the lobby
    players: { type: [playerInLobbySchema], default: [] },
    maxPlayers: { type: Number, required: true },
    gameStarted: { type: Boolean, default: false },
    chatMessages: { type: [chatMessageSchema], default: [] },
    isRanked: { type: Boolean, default: false },
    isCustom: { type: Boolean, default: false },
    isFrenzyMode: { type: Boolean, default: false }, // Custom mode setting
    initialLives: { type: Number, default: 3 }, // Custom mode setting
    questionTimer: { type: Number, default: 30 }, // Custom mode setting
    playerCycles: { type: Number, default: 0 }, // For card distribution in custom mode
    currentQuestionIndex: { type: Number, default: 0 }, // Game state
    currentPlayerIndex: { type: Number, default: 0 }, // Game state
    questions: { type: [{ q: String, a: String, hint: String }], default: [] }, // Questions for the current game
}, { timestamps: true });

const Lobby = mongoose.model('Lobby', lobbySchema); // Define the Lobby model here

// Export the Lobby model so server.js can access it for inactivity cleanup
module.exports.Lobby = Lobby;

// Middleware to verify JWT (same as in auth.js, or import from a central middleware file)
const auth = (req, res, next) => {
    const token = req.header('x-auth-token');
    if (!token) {
        return res.status(401).json({ msg: 'No token, authorization denied' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded.user;
        next();
    } catch (e) {
        res.status(401).json({ msg: 'Token is not valid' });
    }
};

// Helper function to generate a simple unique ID
const generateLobbyId = (prefix) => {
    return `${prefix}-${Math.random().toString(36).substring(2, 8)}`;
};

// Pre-defined game questions (move to a config file if grows large)
const originalQuestions = [
    { q: "What is the output of: cout << 2 + 2;", a: "4" },
    { q: "Which keyword is used for constant?", a: "const" },
    { q: "How many bytes is an int?", a: "4" },
    { q: "C++ pointer access operator?", a: "->" },
    { q: "Declare a pointer to int", a: "int* ptr;" }
];

const fillInBlanksQuestions = [
    { q: "int main() { cout << \"Hello, ___\"; return 0; }", a: "world", hint: "Common greeting" },
    { q: "int ___ = 10;", a: "x", hint: "A common variable name" },
    { q: "for (int i = 0; i < ___; i++)", a: "10", hint: "A typical loop limit" },
    { q: "class MyClass { public: MyClass() { /* constructor */ } };", a: "MyClass", hint: "Name of the class" },
    { q: "std::string ___ = \"C++\";", a: "language", hint: "What is C++?" }
];

const abilityCards = [
    { id: 'card_copy', name: 'Copy', description: 'Copy 1 card from another player (randomly chosen from available types).', icon: '<svg class="card-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9-2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>' },
    { id: 'card_control', name: 'Control', description: 'Skip your turn to play safe, or pick another player to start their turn.', icon: '<svg class="card-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>' },
    { id: 'card_golden_defense', name: 'Golden Defense', description: 'Gain 2 shields. Incorrect answers deduct shield instead of life. Max 2 shields, one-time use per game.', icon: '<svg class="card-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.76-7 8.94V12H5V6.3l7-3.11v8.79z"/></svg>' },
    { id: 'card_meta_vision', name: 'Meta Vision', description: 'See your opponents\' hands (current cards).', icon: '<svg class="card-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>' },
    { id: 'card_evolved_meta_vision', name: 'Evolved Meta Vision', description: 'Receive a clue for the current question.', icon: '<svg class="card-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>' }
];

// @route   GET /api/lobbies
// @desc    Get all available lobbies (filtered by type, excluding ranked)
// @access  Private
router.get('/', auth, async (req, res) => {
    const { type } = req.query; // Expect type query param
    try {
        let query = { gameStarted: false };
        if (type) {
            query.type = type;
        }
        // Exclude ranked lobbies from the general list
        query.isRanked = false;
        const lobbies = await Lobby.find(query);
        res.json(lobbies);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/lobbies
// @desc    Create a new lobby
// @access  Private
router.post('/', auth, async (req, res) => {
    const { name, maxPlayers, type, isFrenzyMode, initialLives, questionTimer } = req.body;
    const hostId = req.user.id;
    const hostUsername = req.user.username; // Assuming username is in JWT payload

    try {
        const user = await User.findById(hostId);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        if (user.penaltyEndTime && new Date() < user.penaltyEndTime) {
            return res.status(403).json({ msg: 'You are penalized and cannot create a lobby.' });
        }

        const newLobbyId = generateLobbyId(type.replace(/-/g, '_'));
        const isRanked = type.startsWith('ranked-');
        const isCustom = type.startsWith('custom-');

        // Helper to get starting cards for frenzy mode
        const getStartingCards = () => {
            if (!isFrenzyMode) return [];
            const cards = [];
            for (let i = 0; i < 3; i++) {
                const randomCard = abilityCards[Math.floor(Math.random() * abilityCards.length)];
                cards.push({ id: randomCard.id, name: randomCard.name });
            }
            return cards;
        };

        const initialPlayer = {
            id: hostId,
            name: hostUsername,
            isReady: isRanked ? true : false, // Auto ready for ranked
            type: 'human',
            elo: user.elo,
            casualPoints: user.casualPoints,
            rankedCorrectAnswers: user.rankedCorrectAnswers,
            rankedTotalAnswers: user.rankedTotalAnswers,
            casualCorrectAnswers: user.casualCorrectAnswers,
            casualTotalAnswers: user.casualTotalAnswers,
            lives: initialLives,
            cards: getStartingCards(),
            shields: 0,
            goldenDefenseUsed: false
        };

        const newLobby = new Lobby({
            lobbyId: newLobbyId,
            name,
            maxPlayers,
            type,
            hostId,
            players: [initialPlayer],
            gameStarted: false,
            chatMessages: [], // Initialize empty chat for new lobby
            isRanked,
            isCustom,
            isFrenzyMode,
            initialLives,
            questionTimer
        });

        // Add bots if maxPlayers > 1 for simulation purposes
        for (let i = 1; i < maxPlayers; i++) {
            newLobby.players.push({
                id: `bot_${newLobbyId}_${i}`,
                name: `Bot_${i}`,
                isReady: true, // Bots are always ready
                type: 'bot',
                elo: 0,
                casualPoints: 0,
                lives: initialLives,
                cards: getStartingCards(),
                shields: 0,
                goldenDefenseUsed: false
            });
        }

        await newLobby.save();

        // Emit update to all clients that a new lobby was created
        io.emit('lobbyCreated', newLobby);

        res.status(201).json(newLobby);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/lobbies/:lobbyId/join
// @desc    Join an existing lobby
// @access  Private
router.post('/:lobbyId/join', auth, async (req, res) => {
    const { lobbyId } = req.params;
    const userId = req.user.id;
    const username = req.user.username;

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        if (user.penaltyEndTime && new Date() < user.penaltyEndTime) {
            return res.status(403).json({ msg: 'You are penalized and cannot join a lobby.' });
        }

        let lobby = await Lobby.findOne({ lobbyId });
        if (!lobby) {
            return res.status(404).json({ msg: 'Lobby not found' });
        }

        if (lobby.players.length >= lobby.maxPlayers || lobby.gameStarted) {
            return res.status(400).json({ msg: 'Lobby is full or game has started' });
        }

        // Check if player is already in this lobby
        if (lobby.players.some(p => p.id === userId)) {
            return res.json(lobby); // Already in lobby, just return lobby info
        }

        const getStartingCards = () => {
            if (!lobby.isFrenzyMode) return [];
            const cards = [];
            for (let i = 0; i < 3; i++) {
                const randomCard = abilityCards[Math.floor(Math.random() * abilityCards.length)];
                cards.push({ id: randomCard.id, name: randomCard.name });
            }
            return cards;
        };

        const playerToAdd = {
            id: userId,
            name: username,
            isReady: lobby.isRanked ? true : false,
            type: 'human',
            elo: user.elo,
            casualPoints: user.casualPoints,
            rankedCorrectAnswers: user.rankedCorrectAnswers,
            rankedTotalAnswers: user.rankedTotalAnswers,
            casualCorrectAnswers: user.casualCorrectAnswers,
            casualTotalAnswers: user.casualTotalAnswers,
            lives: lobby.initialLives,
            cards: getStartingCards(),
            shields: 0,
            goldenDefenseUsed: false
        };

        lobby.players.push(playerToAdd);
        await lobby.save();

        io.to(lobbyId).emit('lobbyUpdated', lobby); // Emit update to lobby members
        res.json(lobby);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/lobbies/:lobbyId/leave
// @desc    Leave a lobby
// @access  Private
router.post('/:lobbyId/leave', auth, async (req, res) => {
    const { lobbyId } = req.params;
    const userId = req.user.id;

    try {
        let lobby = await Lobby.findOne({ lobbyId });
        if (!lobby) {
            return res.status(404).json({ msg: 'Lobby not found' });
        }

        const initialPlayerCount = lobby.players.length;
        lobby.players = lobby.players.filter(p => p.id !== userId);

        if (lobby.players.length === initialPlayerCount) {
            return res.status(400).json({ msg: 'User not found in lobby' });
        }

        // If no human players left, delete the lobby
        if (lobby.players.filter(p => p.type === 'human').length === 0) {
            await Lobby.deleteOne({ lobbyId });
            io.emit('lobbyDeleted', lobbyId); // Notify all clients
            return res.json({ msg: 'Lobby deleted as no human players remain' });
        }

        // If the host left, assign new host (first human player)
        if (lobby.hostId === userId) {
            const newHost = lobby.players.find(p => p.type === 'human');
            if (newHost) {
                lobby.hostId = newHost.id;
            } else {
                // Should not happen if previous check passed, but safety
                await Lobby.deleteOne({ lobbyId });
                io.emit('lobbyDeleted', lobbyId);
                return res.json({ msg: 'Lobby deleted as no human players remain' });
            }
        }

        await lobby.save();
        io.to(lobbyId).emit('lobbyUpdated', lobby); // Emit update to lobby members
        res.json({ msg: 'Left lobby successfully', lobby });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/lobbies/:lobbyId/ready
// @desc    Toggle player ready status
// @access  Private
router.post('/:lobbyId/ready', auth, async (req, res) => {
    const { lobbyId } = req.params;
    const userId = req.user.id;

    try {
        let lobby = await Lobby.findOne({ lobbyId });
        if (!lobby) {
            return res.status(404).json({ msg: 'Lobby not found' });
        }

        const player = lobby.players.find(p => p.id === userId);
        if (!player) {
            return res.status(400).json({ msg: 'Player not in this lobby' });
        }

        if (lobby.isRanked) {
             return res.status(400).json({ msg: 'Players are automatically ready in ranked lobbies.' });
        }

        player.isReady = !player.isReady;
        await lobby.save();

        io.to(lobbyId).emit('lobbyUpdated', lobby);
        res.json({ msg: 'Ready status updated', playerReady: player.isReady });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/lobbies/:lobbyId/start
// @desc    Start the game in a lobby
// @access  Private
router.post('/:lobbyId/start', auth, async (req, res) => {
    const { lobbyId } = req.params;
    const userId = req.user.id;

    try {
        let lobby = await Lobby.findOne({ lobbyId });
        if (!lobby) {
            return res.status(404).json({ msg: 'Lobby not found' });
        }

        if (lobby.hostId !== userId) {
            return res.status(403).json({ msg: 'Only the host can start the game' });
        }

        if (lobby.players.length < 2) {
            return res.status(400).json({ msg: 'Need at least 2 players to start' });
        }

        if (!lobby.players.every(p => p.isReady)) {
            return res.status(400).json({ msg: 'Not all players are ready' });
        }

        // Initialize game state for the lobby
        lobby.gameStarted = true;
        lobby.currentQuestionIndex = 0;
        lobby.currentPlayerIndex = 0;
        lobby.playerCycles = 0; // Reset for new game

        // Determine questions based on lobby type
        if (lobby.type.includes('qna')) {
            lobby.questions = [...originalQuestions].sort(() => Math.random() - 0.5);
        } else if (lobby.type.includes('fill-in-blanks')) {
            lobby.questions = [...fillInBlanksQuestions].sort(() => Math.random() - 0.5);
        } else {
            lobby.questions = [...originalQuestions].sort(() => Math.random() - 0.5); // Default
        }

        // Reset player specific game stats for the new game
        lobby.players = lobby.players.map(p => {
            const getStartingCards = () => {
                if (!lobby.isFrenzyMode) return [];
                const cards = [];
                for (let i = 0; i < 3; i++) {
                    const randomCard = abilityCards[Math.floor(Math.random() * abilityCards.length)];
                    cards.push({ id: randomCard.id, name: randomCard.name });
                }
                return cards;
            };

            return {
                ...p.toObject(), // Convert Mongoose document to plain object
                lives: lobby.initialLives,
                currentRoundScore: 0,
                roundCorrectAnswers: 0,
                roundTotalAnswers: 0,
                cards: getStartingCards(), // Re-deal cards for new game
                shields: 0,
                goldenDefenseUsed: false
            };
        });

        await lobby.save();

        io.to(lobbyId).emit('gameStarted', lobby);
        res.json({ msg: 'Game started', lobby });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/lobbies/:lobbyId/answer
// @desc    Submit an answer during a game
// @access  Private
router.post('/:lobbyId/answer', auth, async (req, res) => {
    const { lobbyId } = req.params;
    const { userAnswer } = req.body;
    const userId = req.user.id;

    try {
        let lobby = await Lobby.findOne({ lobbyId });
        if (!lobby || !lobby.gameStarted) {
            return res.status(400).json({ msg: 'Game not active or lobby not found' });
        }

        const currentPlayerInTurn = lobby.players.find(p => p.id === userId); // Find the actual player object
        if (!currentPlayerInTurn || currentPlayerInTurn.id !== lobby.players[lobby.currentPlayerIndex].id) {
            return res.status(403).json({ msg: 'It is not your turn or you are not in this game.' });
        }

        const currentQuestion = lobby.questions[lobby.currentQuestionIndex];
        const isCorrect = userAnswer.toLowerCase() === currentQuestion.a.toLowerCase();

        let actualIsCorrect = isCorrect;

        // Apply Golden Defense logic
        if (!isCorrect && currentPlayerInTurn.shields > 0) {
            currentPlayerInTurn.shields--;
            actualIsCorrect = true; // Treat as correct for life deduction purposes
            io.to(lobbyId).emit('chatMessage', { senderName: 'Game System', message: `${currentPlayerInTurn.name}'s Golden Defense absorbed the hit! Shields remaining: ${currentPlayerInTurn.shields}` });
        }

        currentPlayerInTurn.roundTotalAnswers++;
        if (actualIsCorrect) {
            currentPlayerInTurn.roundCorrectAnswers++;
            // Assume you have a timer on client, so score based on time is client-side.
            // For server, we can just give a base score. Or pass time left from client.
            currentPlayerInTurn.currentRoundScore += 100; // Base score for correct answer
            io.to(lobbyId).emit('chatMessage', { senderName: 'Game System', message: `${currentPlayerInTurn.name} answered correctly!` });
        } else {
            currentPlayerInTurn.lives--;
            currentPlayerInTurn.currentRoundScore -= 50; // Penalty for wrong answer
            io.to(lobbyId).emit('chatMessage', { senderName: 'Game System', message: `${currentPlayerInTurn.name} answered incorrectly! The answer was "${currentQuestion.a}".` });
        }

        // Update global user stats in User model
        const user = await User.findById(userId);
        if (user) {
            if (lobby.isRanked) {
                user.rankedTotalAnswers++;
                if (isCorrect) { // Only original correctness affects ranked stats
                    user.rankedCorrectAnswers++;
                    user.elo += 15;
                } else {
                    user.elo -= 10;
                }
                if (user.elo < 0) user.elo = 0;
            } else { // Casual or Custom match
                user.casualTotalAnswers++;
                if (isCorrect) { // Only original correctness affects casual stats
                    user.casualCorrectAnswers++;
                    user.casualPoints += 10;
                } else {
                    user.casualPoints -= 5;
                }
                if (user.casualPoints < 0) user.casualPoints = 0;
            }
            await user.save(); // Save updated user stats
        }

        // Check for elimination
        if (currentPlayerInTurn.lives <= 0) {
            io.to(lobbyId).emit('chatMessage', { senderName: 'Game System', message: `${currentPlayerInTurn.name} has been eliminated!` });
            lobby.players = lobby.players.filter(p => p.id !== currentPlayerInTurn.id);
        }

        // Check for game end
        if (lobby.players.filter(p => p.type === 'human').length <= 1) { // Only one human player left or no human players
            lobby.gameStarted = false;
            // Award tokens to winner (if human)
            const winner = lobby.players.find(p => p.type === 'human');
            if (winner) {
                const winningUser = await User.findById(winner.id);
                if (winningUser) {
                    let tokensEarned = 100; // Base tokens
                    if (lobby.isRanked) tokensEarned += 150;
                    else if (lobby.isCustom) tokensEarned += 100;
                    winningUser.tokens += tokensEarned;
                    await winningUser.save();
                    io.to(lobbyId).emit('chatMessage', { senderName: 'Game System', message: `${winner.name} won and earned ${tokensEarned} tokens!` });
                }
            }
            io.to(lobbyId).emit('gameEnded', lobby);
            await lobby.save(); // Save final lobby state
            return res.json({ msg: 'Game over', lobby });
        }

        // Move to next player
        lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;
        // Skip eliminated players
        while (lobby.players[lobby.currentPlayerIndex] && lobby.players[lobby.currentPlayerIndex].lives <= 0) {
            lobby.currentPlayerIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;
        }

        // Move to next question after each answer
        lobby.currentQuestionIndex++;
        if (lobby.currentQuestionIndex >= lobby.questions.length) {
            lobby.currentQuestionIndex = 0; // Loop questions for continuous play
        }

        // Increment playerCycles only if it was a human player's turn or a bot in multiplayer
        if (currentPlayerInTurn.type === 'human' || (currentPlayerInTurn.type === 'bot' && !lobby.type.startsWith('solo-'))) {
            lobby.playerCycles++;
            // Distribute new card every 2 cycles of players in Frenzy Mode
            if (lobby.isFrenzyMode && lobby.playerCycles % (lobby.players.length * 2) === 0) {
                // Distribute a random card to all remaining players
                const randomCard = abilityCards[Math.floor(Math.random() * abilityCards.length)];
                lobby.players.forEach(p => p.cards.push({ id: randomCard.id, name: randomCard.name }));
                io.to(lobbyId).emit('chatMessage', { senderName: 'Game System', message: `New ability cards distributed!` });
            }
        }

        await lobby.save();
        io.to(lobbyId).emit('lobbyUpdated', lobby); // Send updated lobby state
        res.json({ msg: 'Answer processed', lobby });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/lobbies/:lobbyId/chat
// @desc    Send a chat message in a lobby
// @access  Private
router.post('/:lobbyId/chat', auth, async (req, res) => {
    const { lobbyId } = req.params;
    const { message } = req.body;
    const userId = req.user.id;
    const username = req.user.username;

    try {
        let lobby = await Lobby.findOne({ lobbyId });
        if (!lobby) {
            return res.status(404).json({ msg: 'Lobby not found' });
        }

        const chatMessage = {
            senderId: userId,
            senderName: username,
            message,
            timestamp: new Date()
        };

        lobby.chatMessages.push(chatMessage);
        await lobby.save();

        io.to(lobbyId).emit('chatMessage', chatMessage); // Emit to all in lobby
        res.status(201).json({ msg: 'Message sent' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/solo/evaluate
// @desc    Evaluate solo challenge code using Gemini API
// @access  Private
router.post('/solo/evaluate', auth, async (req, res) => {
    const { code, stageData } = req.body;
    const userId = req.user.id;

    if (!code || !stageData) {
        return res.status(400).json({ msg: 'Code and stage data are required' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        if (user.penaltyEndTime && new Date() < user.penaltyEndTime) {
            return res.status(403).json({ msg: 'You are penalized and cannot submit code.' });
        }

        const prompt = `You are a C++ code evaluator. Your task is to determine if the provided C++ code correctly solves the given problem and produces the exact expected output. Additionally, provide an accuracy score (0-100) based on code simplicity, efficiency, and adherence to best practices.

Problem Description:
${stageData.problem}

Expected Output:
${stageData.expectedOutput}

User's C++ Code:
\`\`\`cpp
${code}
\`\`\`

Evaluate the code. If the code correctly solves the problem and produces the exact expected output, respond with 'CORRECT (Accuracy: [0-100])'. If it does not, respond with 'INCORRECT (Accuracy: [0-100]) - [Explanation]'. The accuracy score should reflect how well the code is written, not just if it passes tests. For example, a correct but overly complex solution might get a lower accuracy score than a correct and simple one.`;

        const geminiApiKey = process.env.GEMINI_API_KEY;
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;

        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
        });

        const geminiResult = await geminiResponse.json();

        let geminiResponseText = "Evaluation failed.";
        let accuracyScore = 0;

        if (geminiResult.candidates && geminiResult.candidates.length > 0 &&
            geminiResult.candidates[0].content && geminiResult.candidates[0].content.parts &&
            geminiResult.candidates[0].content.parts.length > 0) {
            geminiResponseText = geminiResult.candidates[0].content.parts[0].text;

            const accuracyMatch = geminiResponseText.match(/Accuracy:\s*(\d+)/i);
            if (accuracyMatch && accuracyMatch[1]) {
                accuracyScore = parseInt(accuracyMatch[1]);
            }
        }

        const isCorrect = geminiResponseText.trim().toUpperCase().startsWith('CORRECT');

        if (isCorrect) {
            // Update soloStageAccuracy for the current stage
            const soloStageAccuracyMap = user.soloStageAccuracy || new Map();
            if (!soloStageAccuracyMap.has(String(stageData.stage)) || accuracyScore > soloStageAccuracyMap.get(String(stageData.stage))) {
                soloStageAccuracyMap.set(String(stageData.stage), accuracyScore);
                user.soloStageAccuracy = soloStageAccuracyMap;
            }

            if (user.soloStage === stageData.stage) {
                user.soloStage++;
                user.elo += 75;
                user.tokens += 50;
            }
            await user.save();
        }

        res.json({ evaluation: geminiResponseText, accuracy: accuracyScore, isCorrect });

    } catch (err) {
        console.error("Error evaluating solo code:", err.message);
        res.status(500).json({ msg: 'Server error during code evaluation' });
    }
});

// @route   POST /api/users/redeem-code
// @desc    Redeem a special code for tokens
// @access  Private
router.post('/users/redeem-code', auth, async (req, res) => {
    const { code } = req.body;
    const userId = req.user.id;

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        if (code === "BlueLock") {
            const tokensAwarded = 50000;
            user.tokens += tokensAwarded;
            await user.save();
            return res.json({ msg: `Successfully redeemed code! You received ${tokensAwarded} tokens.`, newTokens: user.tokens });
        } else {
            return res.status(400).json({ msg: 'Invalid code' });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   GET /api/users/leaderboard
// @desc    Get global leaderboard data
// @access  Public (or Private if you want to restrict)
router.get('/users/leaderboard', async (req, res) => {
    try {
        const users = await User.find({}).select('username elo rankedCorrectAnswers rankedTotalAnswers').sort({ elo: -1 });
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/users/buy-item
// @desc    Buy an item from the shop
// @access  Private
router.post('/users/buy-item', auth, async (req, res) => {
    const { itemId, itemPrice, itemCategory, itemName } = req.body;
    const userId = req.user.id;

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        if (user.inventory.includes(itemId)) {
            return res.status(400).json({ msg: 'You already own this item.' });
        }

        if (user.tokens < itemPrice) {
            return res.status(400).json({ msg: 'Insufficient tokens.' });
        }

        user.tokens -= itemPrice;
        user.inventory.push(itemId);

        if (itemCategory === 'title') {
            user.equippedTitle = itemName; // Equip title immediately
        }

        await user.save();
        res.json({ msg: `Successfully purchased ${itemName}!`, newTokens: user.tokens, newInventory: user.inventory, newEquippedTitle: user.equippedTitle });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// @route   POST /api/users/update-penalty
// @desc    Update user penalty status (for inactivity)
// @access  Private (called internally by server or from client if needed, but better server-side)
router.post('/users/update-penalty', auth, async (req, res) => {
    const { warningCount, penaltyEndTime } = req.body;
    const userId = req.user.id;

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.warningCount = warningCount;
        user.penaltyEndTime = penaltyEndTime ? new Date(penaltyEndTime) : null;
        await user.save();

        res.json({ msg: 'Penalty status updated', user });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

module.exports = router;
