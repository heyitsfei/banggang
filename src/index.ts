import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import commands from './commands'
import { GameManager } from './gameManager'
import { formatAmount } from './game'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

// Initialize game manager
const gameManager = new GameManager()

// Cache user usernames (userId -> username)
// In Towns Protocol, displayName from mentions is the username
const userUsernames = new Map<string, string>()

// Helper to get user username (with fallback)
function getUserUsername(userId: string): string {
    return userUsernames.get(userId) || userId.slice(0, 10) + '...'
}

// Helper to cache usernames from mentions
// displayName in mentions is the username used in Towns
function cacheUsernamesFromMentions(mentions?: Array<{ userId: string; displayName: string }>): void {
    if (mentions && mentions.length > 0) {
        for (const mention of mentions) {
            if (mention.displayName) {
                // displayName from mentions is the username
                userUsernames.set(mention.userId, mention.displayName)
            }
        }
    }
}

// Helper to send game messages with automatic username mentions
async function sendGameMessage(channelId: string, message: string): Promise<void> {
    // Extract user IDs from mentions in message text (<@0x...>)
    // Towns Protocol user IDs are hex addresses with 0x prefix
    const mentionRegex = /<@(0x[a-fA-F0-9]{40})>/g
    const mentions: Array<{ userId: string; displayName: string; mentionBehavior: { case: undefined } }> = []
    let match
    
    while ((match = mentionRegex.exec(message)) !== null) {
        const userId = match[1]
        const username = getUserUsername(userId)
        // Only add if we have a username cached (avoid duplicates)
        if (!mentions.some(m => m.userId.toLowerCase() === userId.toLowerCase())) {
            mentions.push({
                userId: userId,
                displayName: username,
                mentionBehavior: { case: undefined },
            })
        }
    }
    
    await bot.sendMessage(channelId, message, mentions.length > 0 ? { mentions } : undefined)
}

// Handle tips as entry fees
bot.onTip(async (handler, event) => {
    const { channelId, messageId, senderAddress, receiverAddress, amount, spaceId, currency, userId } = event

    // Log tip event for debugging
    console.log('Tip received:', {
        receiverAddress,
        botAppAddress: bot.appAddress,
        botBotId: bot.botId,
        amount: formatAmount(amount),
        currency,
        senderAddress,
        channelId,
    })

    // Check if bot's app contract received the tip
    // Tips go to the app contract address, not bot.botId
    const expectedAddress = bot.appAddress.toLowerCase()
    const receivedAddress = receiverAddress.toLowerCase()
    
    if (receivedAddress !== expectedAddress) {
        console.log(`Tip not for bot: received ${receivedAddress}, expected ${expectedAddress}`)
        return
    }

    // Check if there's a waiting game in this channel
    const game = gameManager.getGame(channelId)
    if (!game || game.state !== 'waiting') {
        console.log('No waiting game found, creating one or informing user')
        // If no game exists, create one automatically
        if (!game) {
            gameManager.createGame(channelId, spaceId)
            // Now add the player
            const username = getUserUsername(userId)
            const result = gameManager.addPlayer(channelId, userId, username, amount)
            if (result.success && result.game) {
                const game = result.game
                await handler.sendMessage(
                    channelId,
                    `💀 **Game created!** <@${userId}> joined with ${formatAmount(amount)} ETH tip!\n` +
                        `💰 Pool A: ${formatAmount(game.poolA)} ETH | House rake: ${formatAmount(game.houseRake)} ETH\n` +
                        `Tip ETH to join! (min ${gameManager.config.minPlayers} players, max ${gameManager.config.maxPlayers})\n` +
                        (game.players.length >= gameManager.config.minPlayers
                            ? `Ready to start! Use /start when all players have joined.`
                            : `Need ${gameManager.config.minPlayers - game.players.length} more player(s) to start.`),
                    {
                        mentions: [{
                            userId: userId,
                            displayName: username,
                            mentionBehavior: { case: undefined },
                        }],
                    },
                )
            }
            return
        }
        await handler.sendMessage(
            channelId,
            `💸 Thanks for the tip of ${formatAmount(amount)} ETH! Start a game with /start to use tips as entry fees.`,
        )
        return
    }

    // Add player to game
    const username = getUserUsername(userId)
    const result = gameManager.addPlayer(channelId, userId, username, amount)

    if (result.success && result.game) {
        const game = result.game
        await handler.sendMessage(
            channelId,
            `💀 <@${userId}> joined! (${game.players.length}/${gameManager.config.maxPlayers})\n` +
                `💰 Pool A: ${formatAmount(game.poolA)} ETH | House rake: ${formatAmount(game.houseRake)} ETH\n` +
                (game.players.length >= gameManager.config.minPlayers
                    ? `Ready to start! Use /start when all players have joined.`
                    : `Need ${gameManager.config.minPlayers - game.players.length} more player(s) to start.`),
            {
                mentions: [{
                    userId: userId,
                    displayName: username,
                    mentionBehavior: { case: undefined },
                }],
            },
        )
    } else {
        await handler.sendMessage(channelId, `❌ ${result.message}`)
    }
})

// Start game command
bot.onSlashCommand('start', async (handler, { channelId, spaceId, userId, mentions }) => {
    cacheUsernamesFromMentions(mentions)
    try {
        // Create game if it doesn't exist
        let game = gameManager.getGame(channelId)
        if (!game) {
            game = gameManager.createGame(channelId, spaceId)
            await handler.sendMessage(
                channelId,
                `💀 **Bang Gang started!**\n\n` +
                    `Tip ETH to join! (min ${gameManager.config.minPlayers} players, max ${gameManager.config.maxPlayers})\n` +
                    `House takes 10% rake. Last survivor wins the pot!`,
            )
            return
        }

        // Start existing game
        const result = gameManager.startGame(channelId)
        if (result.success && result.game) {
            const game = result.game
            const currentPlayer = game.alivePlayers[game.currentTurnIndex]
            const baseUrl = getBaseUrl()
            const username = encodeURIComponent(currentPlayer.displayName || currentPlayer.userId)
            const gameUrl = `${baseUrl}/game?channelId=${channelId}&username=${username}`

            await handler.sendMessage(
                channelId,
                `🔫 **Game started!**\n\n` +
                    `Players: ${game.alivePlayers.length}\n` +
                    `💰 Pool A: ${formatAmount(game.poolA)} ETH | 🔥 Pool B: ${formatAmount(game.poolB)} ETH\n` +
                    `Gun loaded...\n\n` +
                    `⏱️ <@${currentPlayer.userId}> your turn!\n` +
                    `Use /shoot or /pass`,
                {
                    attachments: [{
                        type: 'link',
                        url: gameUrl,
                    }],
                },
            )

            // No turn timer - players take action manually via miniapp
        } else {
            await handler.sendMessage(channelId, `❌ ${result.message}`)
        }
    } catch (error) {
        await handler.sendMessage(channelId, `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
})

// Status command
bot.onSlashCommand('status', async (handler, { channelId }) => {
    const status = gameManager.getStatus(channelId)
    await handler.sendMessage(channelId, status)
})

// Shoot command (can be used as fallback, but miniapp is primary)
bot.onSlashCommand('shoot', async (handler, { channelId, userId }) => {
    const result = await gameManager.handleAction(channelId, userId, 'shoot', async (game, message) => {
        // Only send brief result message, gameplay happens in miniapp
        await sendGameMessage(game.channelId, message)

        // If game is still active, notify next player with miniapp link
        if (game.state === 'active' && game.alivePlayers.length > 0) {
            const currentPlayer = game.alivePlayers[game.currentTurnIndex]
            const baseUrl = getBaseUrl()
            const username = encodeURIComponent(currentPlayer.displayName || currentPlayer.userId)
            const gameUrl = `${baseUrl}/game?channelId=${game.channelId}&username=${username}`
            
            await bot.sendMessage(
                game.channelId,
                `⏱️ <@${currentPlayer.userId}> your turn!`,
                {
                    attachments: [{
                        type: 'link',
                        url: gameUrl,
                    }],
                },
            )
        }
    })

    if (!result.success) {
        await handler.sendMessage(channelId, `❌ ${result.message}`)
    }
})

// Pass command (can be used as fallback, but miniapp is primary)
bot.onSlashCommand('pass', async (handler, { channelId, userId }) => {
    const result = await gameManager.handleAction(channelId, userId, 'pass', async (game, message) => {
        // Only send brief result message, gameplay happens in miniapp
        await sendGameMessage(game.channelId, message)

        // If game is still active, notify next player with miniapp link
        if (game.state === 'active' && game.alivePlayers.length > 0) {
            const currentPlayer = game.alivePlayers[game.currentTurnIndex]
            const baseUrl = getBaseUrl()
            const username = encodeURIComponent(currentPlayer.displayName || currentPlayer.userId)
            const gameUrl = `${baseUrl}/game?channelId=${game.channelId}&username=${username}`
            
            await bot.sendMessage(
                game.channelId,
                `⏱️ <@${currentPlayer.userId}> your turn!`,
                {
                    attachments: [{
                        type: 'link',
                        url: gameUrl,
                    }],
                },
            )
        }
    })

    if (!result.success) {
        await handler.sendMessage(channelId, `❌ ${result.message}`)
    }
})

// Stop command
bot.onSlashCommand('stop', async (handler, { channelId }) => {
    const result = gameManager.stopGame(channelId)
    if (result.success) {
        await handler.sendMessage(channelId, result.message)
    } else {
        await handler.sendMessage(channelId, `❌ ${result.message}`)
    }
})

// Help command
bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**💀 Bang Gang - Russian Roulette Tipping Game**\n\n' +
            '**Commands:**\n' +
            '• `/start` - Start a new game\n' +
            '• `/status` - Check game status\n' +
            '• `/shoot` - Pull the trigger (your turn)\n' +
            '• `/pass` - Pass your turn (costs 0.00015 ETH)\n' +
            '• `/stop` - Stop the current game and refund players\n\n' +
            '**How to Play:**\n' +
            '1. Tip any amount of ETH to the bot to join a game\n' +
            '2. Use `/start` when enough players have joined\n' +
            '3. Take turns choosing `/shoot` or `/pass`\n' +
            '4. Last survivor wins the pot!\n\n' +
            '**Rules:**\n' +
            '• Entry tips can be any amount (10% house rake)\n' +
            '• Passing costs 0.00015 ETH (goes to bonus pool)\n' +
            '• Surviving a shot earns 0.00015 ETH from bonus pool\n' +
            '• Players take turns manually via miniapp\n' +
            '• Full table passes = forced shoot\n' +
            '• All amounts in Base Sepolia ETH',
    )
})

// Keep old commands for backward compatibility
bot.onSlashCommand('time', async (handler, { channelId }) => {
    const currentTime = new Date().toLocaleString()
    await handler.sendMessage(channelId, `Current time: ${currentTime} ⏰`)
})

bot.onMessage(async (handler, { message, channelId, eventId, createdAt, userId, mentions }) => {
    // Cache usernames from mentions in messages
    // displayName in mentions is the username
    cacheUsernamesFromMentions(mentions)
    
    // Note: We can't get the sender's username directly from onMessage events
    // We rely on mentions to learn usernames, or they'll be learned when they're mentioned

    if (message.includes('hello')) {
        await handler.sendMessage(channelId, 'Hello there! 👋')
        return
    }
    if (message.includes('ping')) {
        const now = new Date()
        await handler.sendMessage(channelId, `Pong! 🏓 ${now.getTime() - createdAt.getTime()}ms`)
        return
    }
    if (message.includes('react')) {
        await handler.sendReaction(channelId, eventId, '👍')
        return
    }
})

bot.onReaction(async (handler, { reaction, channelId }) => {
    if (reaction === '👋') {
        await handler.sendMessage(channelId, 'I saw your wave! 👋')
    }
})

const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())
app.post('/webhook', jwtMiddleware, handler)

// Serve game.html page
app.get('/game.html', (c) => {
    try {
        const htmlPath = join(process.cwd(), 'game.html')
        const html = readFileSync(htmlPath, 'utf-8')
        return c.html(html)
    } catch (error) {
        return c.text('Error loading game.html', 500)
    }
})

// Also serve at /game for convenience
app.get('/game', (c) => {
    try {
        const htmlPath = join(process.cwd(), 'game.html')
        const html = readFileSync(htmlPath, 'utf-8')
        return c.html(html)
    } catch (error) {
        return c.text('Error loading game.html', 500)
    }
})

// Serve static images
app.get('/og-image.png', (c) => {
    try {
        const imagePath = join(process.cwd(), 'public', 'og-image.png')
        if (existsSync(imagePath)) {
            const image = readFileSync(imagePath)
            return c.body(image, 200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=3600',
            })
        } else {
            return c.text('Image not found', 404)
        }
    } catch (error) {
        return c.text('Error loading image', 500)
    }
})

app.get('/splash.png', (c) => {
    try {
        const imagePath = join(process.cwd(), 'public', 'splash.png')
        if (existsSync(imagePath)) {
            const image = readFileSync(imagePath)
            return c.body(image, 200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=3600',
            })
        } else {
            return c.text('Image not found', 404)
        }
    } catch (error) {
        return c.text('Error loading image', 500)
    }
})

// Get base URL for miniapp links
function getBaseUrl(): string {
    // Use BASE_URL env var if set, otherwise default to Render URL
    const baseUrl = process.env.BASE_URL || 'https://banggang.onrender.com'
    return baseUrl
}

// API endpoint to get game data
app.get('/api/game', (c) => {
    try {
        const channelId = c.req.query('channelId')
        const username = c.req.query('username')
        
        if (!channelId) {
            return c.json({ error: 'channelId is required' }, 400)
        }
        
        const game = gameManager.getGame(channelId)
        if (!game) {
            return c.json({ error: 'No game found for this channel. Start a new game with /start' }, 404)
        }
        
        // Check if it's the user's turn by matching username
        let isMyTurn = false
        if (username && game.state === 'active' && game.alivePlayers.length > 0) {
            const currentPlayer = game.alivePlayers[game.currentTurnIndex]
            if (currentPlayer) {
                const decodedUsername = decodeURIComponent(username)
                // Match by username (displayName)
                isMyTurn = (currentPlayer.displayName || currentPlayer.userId).toLowerCase() === decodedUsername.toLowerCase()
            }
        }
        
        // Format game data for frontend
        const gameData = {
            game: {
                state: game.state,
                poolA: formatAmount(game.poolA),
                poolB: formatAmount(game.poolB),
                gunChamber: game.gunChamber,
                currentTurnIndex: game.currentTurnIndex,
                forcedShoot: game.forcedShoot,
                players: game.players.map(p => ({
                    userId: p.userId,
                    username: p.displayName,
                    isAlive: p.isAlive,
                })),
            },
            isMyTurn,
        }
        
        return c.json(gameData)
    } catch (error) {
        console.error('Error in /api/game:', error)
        return c.json({ error: 'Internal server error' }, 500)
    }
})

app.get('/api/find-game', (c) => {
    try {
        const username = c.req.query('username')
        if (!username) {
            return c.json({ error: 'username is required' }, 400)
        }

        const games = gameManager.findGamesByUsername(username)
        if (games.length === 0) {
            return c.json({ found: false })
        }

        const serialized = games.map((game) => ({
            channelId: game.channelId,
            state: game.state,
            poolA: formatAmount(game.poolA),
            players: game.players.map((player) => ({
                userId: player.userId,
                username: player.displayName,
                isAlive: player.isAlive,
            })),
        }))

        return c.json({ found: true, games: serialized })
    } catch (error) {
        console.error('Error in /api/find-game:', error)
        return c.json({ error: 'Internal server error' }, 500)
    }
})

// API endpoint to send commands
app.post('/api/command', async (c) => {
    try {
        const body = await c.req.json()
        const { command, channelId, username } = body
        
        if (!command || !channelId || !username) {
            return c.json({ success: false, error: 'Missing required fields' }, 400)
        }
        
        if (command !== 'shoot' && command !== 'pass') {
            return c.json({ success: false, error: 'Invalid command' }, 400)
        }
        
        // Find userId from username in the game
        const game = gameManager.getGame(channelId)
        if (!game) {
            return c.json({ success: false, error: 'No game found' }, 404)
        }
        
        // Find player by username
        const player = game.players.find(p => 
            (p.displayName || p.userId).toLowerCase() === username.toLowerCase()
        )
        
        if (!player) {
            return c.json({ success: false, error: 'Player not found in game' }, 404)
        }
        
        // Process the command through game manager
        const result = await gameManager.handleAction(
            channelId,
            player.userId,
            command,
            async (game, message) => {
                await sendGameMessage(game.channelId, message)
                
                // Show next turn with miniapp link if game is still active
                if (game.state === 'active' && game.alivePlayers.length > 0) {
                    const currentPlayer = game.alivePlayers[game.currentTurnIndex]
                    const baseUrl = getBaseUrl()
                    const username = encodeURIComponent(currentPlayer.displayName || currentPlayer.userId)
                    const gameUrl = `${baseUrl}/game?channelId=${channelId}&username=${username}`
                    
                    await bot.sendMessage(
                        game.channelId,
                        `⏱️ <@${currentPlayer.userId}> your turn!`,
                        {
                            attachments: [{
                                type: 'link',
                                url: gameUrl,
                            }],
                        },
                    )
                }
            },
        )
        
        if (result.success) {
            return c.json({ success: true, message: result.message })
        } else {
            return c.json({ success: false, error: result.message }, 400)
        }
    } catch (error) {
        console.error('Error processing command:', error)
        return c.json({ success: false, error: 'Internal server error' }, 500)
    }
})

export default app
