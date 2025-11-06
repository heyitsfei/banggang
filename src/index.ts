import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import commands from './commands'
import { GameManager } from './gameManager'
import { formatAmount } from './game'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

// Initialize game manager
const gameManager = new GameManager()

// Helper to send game messages
async function sendGameMessage(channelId: string, message: string): Promise<void> {
    await bot.sendMessage(channelId, message)
}

// Handle tips as entry fees
bot.onTip(async (handler, event) => {
    const { channelId, messageId, senderAddress, receiverAddress, amount, spaceId } = event

    // Check if bot received the tip
    if (receiverAddress !== bot.botId) {
        return
    }

    // Check if there's a waiting game in this channel
    const game = gameManager.getGame(channelId)
    if (!game || game.state !== 'waiting') {
        await handler.sendMessage(
            channelId,
            `💸 Thanks for the tip of ${formatAmount(amount)} ETH! Start a game with /start to use tips as entry fees.`,
        )
        return
    }

    // Add player to game
    const result = gameManager.addPlayer(channelId, senderAddress, senderAddress.slice(0, 10), amount)

    if (result.success && result.game) {
        const game = result.game
            await handler.sendMessage(
                channelId,
                `💀 <@${senderAddress}> joined! (${game.players.length}/${gameManager.config.maxPlayers})\n` +
                    `💰 Pool A: ${formatAmount(game.poolA)} ETH | House rake: ${formatAmount(game.houseRake)} ETH\n` +
                    (game.players.length >= gameManager.config.minPlayers
                        ? `Ready to start! Use /start when all players have joined.`
                        : `Need ${gameManager.config.minPlayers - game.players.length} more player(s) to start.`),
            )
    } else {
        await handler.sendMessage(channelId, `❌ ${result.message}`)
    }
})

// Start game command
bot.onSlashCommand('start', async (handler, { channelId, spaceId, userId }) => {
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

            await handler.sendMessage(
                channelId,
                `🔫 **Game started!**\n\n` +
                    `Players: ${game.alivePlayers.length}\n` +
                    `💰 Pool A: ${formatAmount(game.poolA)} ETH | 🔥 Pool B: ${formatAmount(game.poolB)} ETH\n` +
                    `Gun loaded...\n\n` +
                    `⏱️ <@${currentPlayer.userId}> your turn! (10s)\n` +
                    `Use /shoot or /pass`,
            )

            // Start turn timer
            gameManager.startTurnTimer(game, async (g, msg) => {
                await sendGameMessage(g.channelId, msg)
            })
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

// Shoot command
bot.onSlashCommand('shoot', async (handler, { channelId, userId }) => {
    const result = await gameManager.handleAction(channelId, userId, 'shoot', async (game, message) => {
        await sendGameMessage(game.channelId, message)

        // If game is still active, show next turn
        if (game.state === 'active' && game.alivePlayers.length > 0) {
            const currentPlayer = game.alivePlayers[game.currentTurnIndex]
            if (game.forcedShoot) {
                await sendGameMessage(
                    game.channelId,
                    `⚠️ <@${currentPlayer.userId}> must /shoot! (10s)`,
                )
            } else {
                await sendGameMessage(
                    game.channelId,
                    `⏱️ <@${currentPlayer.userId}> your turn! (10s)\nUse /shoot or /pass`,
                )
            }
        }
    })

    if (!result.success) {
        await handler.sendMessage(channelId, `❌ ${result.message}`)
    }
})

// Pass command
bot.onSlashCommand('pass', async (handler, { channelId, userId }) => {
    const result = await gameManager.handleAction(channelId, userId, 'pass', async (game, message) => {
        await sendGameMessage(game.channelId, message)

        // Show next turn
        if (game.state === 'active' && game.alivePlayers.length > 0) {
            const currentPlayer = game.alivePlayers[game.currentTurnIndex]
            if (game.forcedShoot) {
                await sendGameMessage(
                    game.channelId,
                    `⚠️ <@${currentPlayer.userId}> must /shoot! (10s)`,
                )
            } else {
                await sendGameMessage(
                    game.channelId,
                    `⏱️ <@${currentPlayer.userId}> your turn! (10s)\nUse /shoot or /pass`,
                )
            }
        }
    })

    if (!result.success) {
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
            '• `/pass` - Pass your turn (costs 0.00015 ETH)\n\n' +
            '**How to Play:**\n' +
            '1. Tip any amount of ETH to the bot to join a game\n' +
            '2. Use `/start` when enough players have joined\n' +
            '3. Take turns choosing `/shoot` or `/pass`\n' +
            '4. Last survivor wins the pot!\n\n' +
            '**Rules:**\n' +
            '• Entry tips can be any amount (10% house rake)\n' +
            '• Passing costs 0.00015 ETH (goes to bonus pool)\n' +
            '• Surviving a shot earns 0.00015 ETH from bonus pool\n' +
            '• 10 second timer per turn (auto-shoot on timeout)\n' +
            '• Full table passes = forced shoot\n' +
            '• All amounts in Base Sepolia ETH',
    )
})

// Keep old commands for backward compatibility
bot.onSlashCommand('time', async (handler, { channelId }) => {
    const currentTime = new Date().toLocaleString()
    await handler.sendMessage(channelId, `Current time: ${currentTime} ⏰`)
})

bot.onMessage(async (handler, { message, channelId, eventId, createdAt }) => {
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

export default app
