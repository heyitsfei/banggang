import type { PlainMessage, SlashCommand } from '@towns-protocol/proto'

const commands = [
    {
        name: 'help',
        description: 'Get help with bot commands',
    },
    {
        name: 'time',
        description: 'Get the current time',
    },
    {
        name: 'start',
        description: 'Start a new Bang Gang game',
    },
    {
        name: 'status',
        description: 'Check current game status',
    },
    {
        name: 'shoot',
        description: 'Pull the trigger (your turn)',
    },
    {
        name: 'pass',
        description: 'Pass your turn (costs 0.00015 ETH)',
    },
    {
        name: 'stop',
        description: 'Stop the current game and refund players',
    },
] as const satisfies PlainMessage<SlashCommand>[]

export default commands
