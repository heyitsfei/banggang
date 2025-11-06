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
        resetGun(game)

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
        if (!currentPlayer || currentPlayer.userId !== userId) {
            return { success: false, message: "It's not your turn" }
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
            const hasBullet = checkChamber(game)

            if (hasBullet) {
                // Player dies
                currentPlayer.isAlive = false
                game.alivePlayers = game.alivePlayers.filter((p) => p.isAlive)

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
                    // Continue game
                    resultMessage += `\n\n🔫 Gun reloaded... ${game.alivePlayers.length} players remain`
                }
            } else {
                // Player survives
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

        // Move to next player if game still active
        if (game.state === 'active') {
            // Always advance turn after action
            this.advanceTurn(game)

            // Set up next turn timer
            this.startTurnTimer(game, onAction)
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
     * Start turn timer (auto-shoot after timeout)
     */
    public startTurnTimer(game: Game, onAction: GameActionCallback): void {
        if (game.turnTimer) {
            clearTimeout(game.turnTimer)
        }

        const currentPlayer = game.alivePlayers[game.currentTurnIndex]
        if (!currentPlayer) return

        game.turnStartTime = new Date()
        let secondsLeft = this.config.turnTimerSeconds

        // Send countdown updates
        const countdownInterval = setInterval(async () => {
            if (game.state !== 'active' || !game.turnTimer) {
                clearInterval(countdownInterval)
                return
            }

            secondsLeft--
            if (secondsLeft > 0 && secondsLeft <= 5) {
                await onAction(
                    game,
                    `⏱️ <@${currentPlayer.userId}> ${secondsLeft}s remaining...`,
                )
            }
        }, 1000)

        const channelId = game.channelId
        game.turnTimer = setTimeout(async () => {
            clearInterval(countdownInterval)
            const currentGame = this.games.get(channelId)
            if (currentGame?.state === 'active' && currentGame.alivePlayers[currentGame.currentTurnIndex]?.userId === currentPlayer.userId) {
                // Auto-shoot
                await this.handleAction(channelId, currentPlayer.userId, 'shoot', onAction)
            }
        }, this.config.turnTimerSeconds * 1000)
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
            const timeLeft = game.turnStartTime
                ? Math.max(0, this.config.turnTimerSeconds - Math.floor((Date.now() - game.turnStartTime.getTime()) / 1000))
                : this.config.turnTimerSeconds

            const turnInfo = game.forcedShoot
                ? `⚠️ <@${currentPlayer?.userId}> must /shoot! (${timeLeft}s)`
                : `<@${currentPlayer?.userId}> (${timeLeft}s) - /shoot or /pass`

            return `💀 Bang Gang - Round Active\n\n` +
                `Players: ${game.alivePlayers.length}/${game.players.length} alive\n` +
                `💰 Pool A: ${formatAmount(game.poolA)} ETH | 🔥 Pool B: ${formatAmount(game.poolB)} ETH\n` +
                `Current turn: ${turnInfo}\n` +
                `Chamber: ${game.gunChamber + 1}/6`
        }

        return 'Game finished'
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

