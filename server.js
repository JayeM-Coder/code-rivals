// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors'); // Import cors

const authRoutes = require('./routes/auth');
const lobbyRoutes = require('./routes/lobby'); // This now contains the Lobby model definition
const User = require('./models/User'); // For penalty tracking and user data
const { Lobby } = require('./routes/lobby'); // Explicitly import Lobby model from combined file

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.IO and Express
const corsOptions = {
    origin: '*', // Allow all origins for development. In production, restrict to your GitHub Pages URL.
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token'], // Allow x-auth-token header
    credentials: true // Allow cookies and auth headers
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Enable pre-flight for all routes

// Initialize Socket.IO
const io = new Server(server, {
    cors: corsOptions
});

// Export io for use in other modules (e.g., lobby routes)
module.exports.io = io;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.error(err));

// Middleware
app.use(express.json()); // Body parser for JSON

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/lobbies', lobbyRoutes); // Lobby routes will use Socket.IO instance

// Global leaderboard route (can be public)
app.get('/api/global-leaderboard', async (req, res) => {
    try {
        const leaderboard = await User.find({})
            .select('username elo rankedCorrectAnswers rankedTotalAnswers')
            .sort({ elo: -1 })
            .limit(10); // Limit to top 10 for example
        res.json(leaderboard);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Join a lobby room
    socket.on('joinLobbyRoom', (lobbyId) => {
        socket.join(lobbyId);
        console.log(`${socket.id} joined lobby room: ${lobbyId}`);
    });

    // Leave a lobby room
    socket.on('leaveLobbyRoom', (lobbyId) => {
        socket.leave(lobbyId);
        console.log(`${socket.id} left lobby room: ${lobbyId}`);
    });

    // Inactivity tracking (server-side)
    let inactivityTimer;
    const INACTIVITY_WARNING_THRESHOLD_MS = 30000; // 30 seconds of inactivity
    const MAX_WARNINGS = 3;
    const PENALTY_DURATION_MS = 60 * 1000; // 1 minute penalty

    const resetInactivityTimer = (userId) => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        // Only start inactivity timer if user is in a game
        const userSocket = Array.from(io.sockets.sockets.values()).find(s => s.userId === userId);
        if (userSocket && userSocket.isInGame) { // isInGame flag set when game starts
            inactivityTimer = setTimeout(async () => {
                try {
                    const user = await User.findById(userId);
                    if (!user) return;

                    user.warningCount = (user.warningCount || 0) + 1;
                    if (user.warningCount >= MAX_WARNINGS) {
                        user.penaltyEndTime = new Date(Date.now() + PENALTY_DURATION_MS);
                        user.warningCount = 0; // Reset warnings after penalty
                        io.to(userSocket.id).emit('penaltyApplied', { duration: PENALTY_DURATION_MS });
                        // Force user out of game if penalized while in one
                        const currentLobby = await Lobby.findOne({ 'players.id': userId, gameStarted: true });
                        if (currentLobby) {
                            currentLobby.players = currentLobby.players.filter(p => p.id !== userId);
                             if (currentLobby.players.filter(p => p.type === 'human').length === 0) {
                                await Lobby.deleteOne({ _id: currentLobby._id });
                                io.emit('lobbyDeleted', currentLobby.lobbyId);
                            } else {
                                await currentLobby.save();
                                io.to(currentLobby.lobbyId).emit('lobbyUpdated', currentLobby);
                            }
                            io.to(userSocket.id).emit('kickedFromGame', { reason: 'inactivity' });
                        }
                    } else {
                        io.to(userSocket.id).emit('inactivityWarning', { warningCount: user.warningCount, maxWarnings: MAX_WARNINGS });
                    }
                    await user.save();
                } catch (error) {
                    console.error('Error in inactivity timer:', error);
                }
            }, INACTIVITY_WARNING_THRESHOLD_MS);
        }
    };

    // Listen for client-side activity events to reset timer
    socket.on('activity', (userId) => {
        resetInactivityTimer(userId);
    });

    // Set isInGame flag when a user enters a game
    socket.on('userEnteredGame', (userId) => {
        socket.userId = userId; // Associate socket with user ID
        socket.isInGame = true;
        resetInactivityTimer(userId); // Start tracking inactivity
    });

    // Clear isInGame flag when a user leaves a game
    socket.on('userLeftGame', () => {
        socket.isInGame = false;
        if (inactivityTimer) clearTimeout(inactivityTimer);
    });


    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        // Handle user leaving lobbies on disconnect (optional, can be complex)
    });
});


const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
