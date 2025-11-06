/**
 * Bang Gang - Russian Roulette Tipping Game
 * 
 * Players tip to enter, take turns choosing /shoot or /pass.
 * Last survivor wins the pot.
 */

export type GameState = 'waiting' | 'active' | 'finished'

export interface Player {
    userId: string
    displayName: string
    isAlive: boolean
    entryAmount: bigint // Amount tipped to enter (in wei)
}

export interface Game {
    gameId: string
    channelId: string
    spaceId: string
    state: GameState
    players: Player[]
    alivePlayers: Player[]
    currentTurnIndex: number
    poolA: bigint // Winnings pool (90% of entry tips)
    poolB: bigint // Bonus pool (from passes)
    houseRake: bigint // 10% of all entry tips
    gunChamber: number // Current chamber position (0-5)
    bulletChamber: number // Which chamber has the bullet (0-5)
    consecutivePasses: number // Track full-table passes
    forcedShoot: boolean // Next player must shoot (full table passed)
    consecutiveSafeShots: number // Track shots without death (for loop detection)
    lastDeathTime?: Date // Track when last death occurred
    turnTimer?: NodeJS.Timeout
    turnStartTime?: Date
    createdAt: Date
}

export interface GameConfig {
    minPlayers: number
    maxPlayers: number
    rakePercent: number // 10 = 10%
    passPenalty: bigint // 0.00015 ETH in wei
    bonusFromB: bigint // 0.00015 ETH in wei
    turnTimerSeconds: number
    chambers: number
    bullets: number
    maxSafeShots: number // Maximum safe shots before terminating (prevents infinite loops)
    maxGameDurationMinutes: number // Maximum game duration in minutes
}

export const DEFAULT_CONFIG: GameConfig = {
    minPlayers: 2,
    maxPlayers: 6,
    rakePercent: 10,
    passPenalty: BigInt('150000000000000'), // 0.00015 ETH in wei (Base Sepolia)
    bonusFromB: BigInt('150000000000000'), // 0.00015 ETH in wei (Base Sepolia)
    turnTimerSeconds: 10,
    chambers: 6,
    bullets: 1,
    maxSafeShots: 18, // 3 full rotations of 6-chamber gun (should be impossible)
    maxGameDurationMinutes: 30, // 30 minutes max game duration
}

/**
 * Calculate entry fee distribution
 */
export function calculateEntryDistribution(entryAmount: bigint, rakePercent: number): {
    rake: bigint
    toPoolA: bigint
} {
    const rake = (entryAmount * BigInt(rakePercent)) / BigInt(100)
    const toPoolA = entryAmount - rake
    return { rake, toPoolA }
}

/**
 * Generate random bullet position (0-5)
 */
export function randomBulletPosition(): number {
    return Math.floor(Math.random() * 6)
}

/**
 * Check if current chamber has bullet
 */
export function checkChamber(game: Game): boolean {
    return game.gunChamber === game.bulletChamber
}

/**
 * Advance gun chamber
 */
export function advanceChamber(game: Game): void {
    game.gunChamber = (game.gunChamber + 1) % game.chambers
}

/**
 * Reset gun after death
 */
export function resetGun(game: Game): void {
    game.gunChamber = 0
    game.bulletChamber = randomBulletPosition()
    console.log('Gun reset:', {
        gunChamber: game.gunChamber,
        bulletChamber: game.bulletChamber,
    })
}

/**
 * Get death probability for current shot
 */
export function getDeathProbability(game: Game): number {
    const remainingChambers = game.chambers - game.gunChamber
    return 1 / remainingChambers
}

/**
 * Format wei amount to readable string
 */
export function formatAmount(amount: bigint, decimals: number = 18): string {
    const divisor = BigInt(10 ** decimals)
    const whole = amount / divisor
    const fraction = amount % divisor
    const fractionStr = fraction.toString().padStart(decimals, '0')
    const trimmed = fractionStr.replace(/0+$/, '')
    return trimmed ? `${whole}.${trimmed}` : whole.toString()
}

