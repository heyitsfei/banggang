/**
 * Game Manager - Handles game state, turn management, and game logic
 */

import type { Game, Player, GameConfig, GameState } from './game'
import {
    DEFAULT_CONFIG,
    calculateEntryDistribution,
    randomBulletPosition,
    checkChamber,
    advanceChamber,
    resetGun,
    formatAmount,
} from './game'

type GameActionCallback = (
    game: Game,
    message: string,
) => Promise<void>

export class GameManager {
    private games = new Map<string, Game>() // channelId -> Game
    public readonly config: GameConfig

    constructor(config: GameConfig = DEFAULT_CONFIG) {
        this.config = config
    }

    /**
     * Create a new game in a channel
     */
    createGame(channelId: string, spaceId: string): Game {
        const existing = this.games.get(channelId)
        if (existing && existing.state === 'active') {
            throw new Error('A game is already active in this channel')
        }

        const game: Game = {
            gameId: `game-${Date.now()}`,
            channelId,
            spaceId,
            state: 'waiting',
            players: [],
            alivePlayers: [],
            currentTurnIndex: 0,
            poolA: BigInt(0),
            poolB: BigInt(0),
            houseRake: BigInt(0),
            gunChamber: 0,
            bulletChamber: randomBulletPosition(),
            consecutivePasses: 0,
            forcedShoot: false,
            consecutiveSafeShots: 0,
            createdAt: new Date(),
        }

        this.games.set(channelId, game)
        return game
    }

    /**
     * Get active game in channel
     */
    getGame(channelId: string): Game | undefined {
        return this.games.get(channelId)
    }

    /**
     * Find all games where the provided username/displayName is participating.
     * Falls back to matching on userId if displayName is unavailable.
     */
    findGamesByUsername(username: string): Game[] {
        if (!username) {
            return []
        }

        const normalized = username.trim().toLowerCase()
        if (!normalized) {
            return []
        }

        const matches: Game[] = []
        for (const game of this.games.values()) {
            const hasPlayer = game.players.some((player) => {
                const displayName = (player.displayName || '').trim().toLowerCase()
                if (displayName && displayName === normalized) {
                    return true
                }

                return player.userId.toLowerCase() === normalized
            })

            if (hasPlayer) {
                matches.push(game)
            }
        }

        return matches
    }

    /**
     * Add player to game with entry tip
     */
    addPlayer(
        channelId: string,
        userId: string,
        displayName: string,
        entryAmount: bigint,
    ): { success: boolean; message: string; game?: Game } {
        const game = this.games.get(channelId)
        if (!game) {
            return { success: false, message: 'No game found. Start a game with /start' }
        }

        if (game.state !== 'waiting') {
            return { success: false, message: 'Game is already in progress' }
        }

        // Check if player already joined
        if (game.players.some((p) => p.userId === userId)) {
            return { success: false, message: 'You are already in this game' }
        }

        // Check max players
        if (game.players.length >= this.config.maxPlayers) {
            return {
                success: false,
                message: `Game is full (max ${this.config.maxPlayers} players)`,
            }
        }

        // Calculate distribution
        const { rake, toPoolA } = calculateEntryDistribution(
            entryAmount,
            this.config.rakePercent,
        )

        // Add player
        const player: Player = {
            userId,
            displayName,
            isAlive: true,
            entryAmount,
        }

        game.players.push(player)
        game.alivePlayers.push(player)
        game.poolA += toPoolA
        game.houseRake += rake

        return {
            success: true,
            message: `Joined! Pool A: ${formatAmount(game.poolA)}`,
            game,
        }
    }

    /**
     * Start the game
     */
    startGame(channelId: string): { success: boolean; message: string; game?: Game } {
        const game = this.games.get(channelId)
        if (!game) {
            return { success: false, message: 'No game found' }
        }

        if (game.state === 'active') {
            return { success: false, message: 'Game is already active' }
        }

        if (game.players.length < this.config.minPlayers) {
            return {
                success: false,
                message: `Need at least ${this.config.minPlayers} players to start`,
            }
        }

        game.state = 'active'
        game.currentTurnIndex = 0
        game.consecutivePasses = 0
        game.forcedShoot = false
        game.consecutiveSafeShots = 0
        game.lastDeathTime = undefined
        resetGun(game)
        
        console.log('Game started:', {
            players: game.players.length,
            gunChamber: game.gunChamber,
            bulletChamber: game.bulletChamber,
        })

        return { success: true, message: 'Game started!', game }
    }

    /**
     * Handle player action (shoot or pass)
     */
    async handleAction(
        channelId: string,
        userId: string,
        action: 'shoot' | 'pass',
        onAction: GameActionCallback,
    ): Promise<{ success: boolean; message: string }> {
        const game = this.games.get(channelId)
        if (!game) {
            return { success: false, message: 'No active game found' }
        }

        if (game.state !== 'active') {
            return { success: false, message: 'Game is not active' }
        }

        const currentPlayer = game.alivePlayers[game.currentTurnIndex]
        
        // Debug logging for turn check
        console.log('Turn check:', {
            currentTurnIndex: game.currentTurnIndex,
            currentPlayerId: currentPlayer?.userId,
            requestingUserId: userId,
            alivePlayers: game.alivePlayers.map(p => p.userId),
            match: currentPlayer?.userId?.toLowerCase() === userId.toLowerCase(),
        })
        
        if (!currentPlayer || currentPlayer.userId.toLowerCase() !== userId.toLowerCase()) {
            const expectedPlayer = currentPlayer?.userId || 'none'
            return { success: false, message: `It's not your turn. Current turn: <@${expectedPlayer}>` }
        }

        if (!currentPlayer.isAlive) {
            return { success: false, message: 'You are already eliminated' }
        }

        // Check if player is forced to shoot (full table passed previously)
        if (action === 'pass' && game.forcedShoot) {
            return { success: false, message: '⚠️ Full table passed! You must /shoot' }
        }

        // Clear turn timer
        if (game.turnTimer) {
            clearTimeout(game.turnTimer)
            game.turnTimer = undefined
        }

        let resultMessage = ''
        let playerDied = false

        if (action === 'pass') {
            // Pass: add to Pool B
            // Note: In real implementation, we'd deduct from player's balance
            // For now, we'll just add to Pool B (simplified - assumes player has balance)
            game.poolB += this.config.passPenalty
            game.consecutivePasses++

            resultMessage = `💨 Passed! 0.00015 ETH → Pool B\n💰 A = ${formatAmount(game.poolA)} ETH | 🔥 B = ${formatAmount(game.poolB)} ETH`

            // Check for forced shoot (all players passed in this round)
            if (game.consecutivePasses >= game.alivePlayers.length) {
                resultMessage += '\n⚠️ Full table passed! Next player must /shoot'
                game.forcedShoot = true // Mark next player as forced
            }
        } else {
            // Shoot
            game.consecutivePasses = 0
            game.forcedShoot = false // Reset forced flag
            
            // Debug logging
            console.log('Shoot action:', {
                gunChamber: game.gunChamber,
                bulletChamber: game.bulletChamber,
                player: userId,
            })
            
            // Check if current chamber has the bullet
            // The bullet is randomly placed at game start and after each death
            const hasBullet = checkChamber(game)

            if (hasBullet) {
                // Player dies
                playerDied = true
                currentPlayer.isAlive = false
                game.alivePlayers = game.alivePlayers.filter((p) => p.isAlive)
                
                // Reset safe shot counter
                game.consecutiveSafeShots = 0
                game.lastDeathTime = new Date()
                
                // Adjust turn index: if current player was at the end, wrap to 0
                // Otherwise, the next player is already at the correct index after filtering
                if (game.currentTurnIndex >= game.alivePlayers.length) {
                    game.currentTurnIndex = 0
                }

                resultMessage = `💥 BANG! <@${userId}> is out!`

                // Reset gun and forced shoot flag
                resetGun(game)
                game.forcedShoot = false

                // Check win condition
                if (game.alivePlayers.length === 1) {
                    const winner = game.alivePlayers[0]
                    game.state = 'finished'

                    // Payout Pool A to winner
                    resultMessage += `\n\n🏆 <@${winner.userId}> wins! 💰 ${formatAmount(game.poolA)} ETH`

                    // Reset game
                    this.games.delete(channelId)
                } else {
                    // Continue game - don't advance turn, next player is already at currentTurnIndex
                    resultMessage += `\n\n🔫 Gun reloaded... ${game.alivePlayers.length} players remain`
                }
            } else {
                // Player survives
                game.consecutiveSafeShots++
                
                // Check for infinite loop (too many safe shots)
                if (game.consecutiveSafeShots >= this.config.maxSafeShots) {
                    // Terminate game due to infinite loop
                    game.state = 'finished'
                    const refundPerPlayer = game.poolA / BigInt(game.alivePlayers.length)
                    
                    resultMessage = `🔫 Click! Safe!\n\n` +
                        `⚠️ **Game terminated** - Too many safe shots detected (possible bug)\n` +
                        `Refunding ${formatAmount(refundPerPlayer)} ETH to each remaining player\n` +
                        `Players: ${game.alivePlayers.map(p => `<@${p.userId}>`).join(', ')}`
                    
                    this.games.delete(channelId)
                    playerDied = false // Don't skip turn advance since game is ending
                } else {
                    resultMessage = `🔫 Click! Safe!`

                    // Bonus from Pool B
                    if (game.poolB >= this.config.bonusFromB) {
                        game.poolA += this.config.bonusFromB
                        game.poolB -= this.config.bonusFromB
                        resultMessage += ` (+0.00015 ETH B→A)`
                    }

                    resultMessage += `\n💰 A = ${formatAmount(game.poolA)} ETH | 🔥 B = ${formatAmount(game.poolB)} ETH`

                    advanceChamber(game)
                }
            }
        }

        // Check game duration limit
        if (game.state === 'active') {
            const gameDurationMinutes = (Date.now() - game.createdAt.getTime()) / (1000 * 60)
            if (gameDurationMinutes >= this.config.maxGameDurationMinutes) {
                game.state = 'finished'
                const refundPerPlayer = game.poolA / BigInt(game.alivePlayers.length)
                
                await onAction(
                    game,
                    `⏰ **Game terminated** - Maximum duration (${this.config.maxGameDurationMinutes} minutes) exceeded\n` +
                        `Refunding ${formatAmount(refundPerPlayer)} ETH to each remaining player\n` +
                        `Players: ${game.alivePlayers.map(p => `<@${p.userId}>`).join(', ')}`
                )
                
                this.games.delete(channelId)
                return { success: true, message: 'Game terminated due to duration limit' }
            }
        }

        // Move to next player if game still active
        if (game.state === 'active') {
            // Advance turn after action (unless player died, in which case next player is already at currentTurnIndex)
            if (!playerDied) {
                this.advanceTurn(game)
            }

            // No auto-shoot timer - players must manually take action via miniapp
        }

        await onAction(game, resultMessage)

        return { success: true, message: resultMessage }
    }

    /**
     * Advance to next player's turn
     */
    private advanceTurn(game: Game): void {
        if (game.alivePlayers.length === 0) return

        game.currentTurnIndex = (game.currentTurnIndex + 1) % game.alivePlayers.length
    }

    /**
     * Start turn timer (DISABLED - no auto-shoot, players must act manually)
     * This method is kept for compatibility but does nothing
     */
    public startTurnTimer(game: Game, onAction: GameActionCallback): void {
        // Timer disabled - players must manually take action via miniapp
        // Clear any existing timer
        if (game.turnTimer) {
            clearTimeout(game.turnTimer)
            game.turnTimer = undefined
        }
        game.turnStartTime = new Date()
    }

    /**
     * Get formatted game status
     */
    getStatus(channelId: string): string {
        const game = this.games.get(channelId)
        if (!game) {
            return 'No active game in this channel. Start one with /start'
        }

        if (game.state === 'waiting') {
            const playerList = game.players.map(p => `<@${p.userId}>`).join(', ')
            return `💀 Bang Gang - Waiting for players\n\n` +
                `Players (${game.players.length}/${this.config.maxPlayers}): ${playerList}\n` +
                `💰 Pool A: ${formatAmount(game.poolA)} ETH | House rake: ${formatAmount(game.houseRake)} ETH\n` +
                `Tip ETH to join! Use /start when ready.`
        }

        if (game.state === 'active') {
            const currentPlayer = game.alivePlayers[game.currentTurnIndex]

            const turnInfo = game.forcedShoot
                ? `⚠️ <@${currentPlayer?.userId}> must /shoot!`
                : `<@${currentPlayer?.userId}> - /shoot or /pass`

            const remainingChambers = game.chambers - game.gunChamber
            const deathProbability = remainingChambers > 0 ? (1 / remainingChambers * 100).toFixed(1) : '100'
            
            return `💀 Bang Gang - Round Active\n\n` +
                `Players: ${game.alivePlayers.length}/${game.players.length} alive\n` +
                `💰 Pool A: ${formatAmount(game.poolA)} ETH | 🔥 Pool B: ${formatAmount(game.poolB)} ETH\n` +
                `Current turn: ${turnInfo}\n` +
                `Chamber: ${game.gunChamber + 1}/6 (${deathProbability}% death chance)\n` +
                `Safe shots: ${game.consecutiveSafeShots}/${this.config.maxSafeShots}`
        }

        return 'Game finished'
    }

    /**
     * Stop/terminate the current game and refund players
     */
    stopGame(channelId: string): { success: boolean; message: string; game?: Game } {
        const game = this.games.get(channelId)
        if (!game) {
            return { success: false, message: 'No active game found' }
        }

        if (game.state === 'finished') {
            return { success: false, message: 'Game is already finished' }
        }

        // Clean up timers
        if (game.turnTimer) {
            clearTimeout(game.turnTimer)
        }

        // Calculate refund per player (only alive players get refunds)
        const aliveCount = game.alivePlayers.length
        let refundMessage = ''
        
        if (aliveCount > 0 && game.poolA > BigInt(0)) {
            const refundPerPlayer = game.poolA / BigInt(aliveCount)
            const playerList = game.alivePlayers.map(p => `<@${p.userId}>`).join(', ')
            refundMessage = `\n\n💰 Refunding ${formatAmount(refundPerPlayer)} ETH to each remaining player\n` +
                `Players: ${playerList}`
        } else if (game.state === 'waiting') {
            // If game hasn't started, refund all players
            const totalRefund = game.poolA + game.houseRake // Return house rake too
            if (game.players.length > 0 && totalRefund > BigInt(0)) {
                const refundPerPlayer = totalRefund / BigInt(game.players.length)
                const playerList = game.players.map(p => `<@${p.userId}>`).join(', ')
                refundMessage = `\n\n💰 Refunding ${formatAmount(refundPerPlayer)} ETH to each player\n` +
                    `Players: ${playerList}`
            }
        }

        game.state = 'finished'
        this.games.delete(channelId)

        return {
            success: true,
            message: `🛑 **Game stopped**${refundMessage}`,
            game,
        }
    }

    /**
     * Clean up game
     */
    endGame(channelId: string): void {
        const game = this.games.get(channelId)
        if (game?.turnTimer) {
            clearTimeout(game.turnTimer)
        }
        this.games.delete(channelId)
    }
}

