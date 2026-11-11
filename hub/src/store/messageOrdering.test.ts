import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initializeMessageOrdering } from './messageOrdering'
import { addMessage, getMessagesByPosition, getLocalMessageStates, markMessagesInvoked } from './messages'
import { initializeMessageResolutions, resolveMessages } from './messageResolutions'
import { initializeMessageTurnIndex, getTurnHistoryRows, getTurnStartsBefore } from './messageTurnQueries'

function dbWithMessages() {
    const db = new Database(':memory:')
    db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        INSERT INTO sessions VALUES ('session');
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
            content BLOB, created_at INTEGER NOT NULL, seq INTEGER NOT NULL,
            local_id TEXT, invoked_at INTEGER, scheduled_at INTEGER
        );
        CREATE INDEX idx_messages_session ON messages(session_id, seq);
        CREATE INDEX idx_messages_local_id ON messages(session_id, local_id);
        CREATE TABLE message_epochs (session_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
    `)
    initializeMessageResolutions(db)
    initializeMessageOrdering(db)
    initializeMessageTurnIndex(db)
    return db
}

function userMessage(text: string) {
    return { role: 'user', content: [{ type: 'text', text }] }
}

function agentMessage(text: string) {
    return { role: 'agent', content: { type: 'output', data: { text } } }
}

const origin = (entryId: string, entryOrder: number, eventOrder = 0) => ({
    sessionId: 'native-a', entryId, entryOrder, eventOrder
})

describe('authoritative OMP message ordering', () => {
    it('keeps a late delivery ACK before its already-persisted reply without clamping clocks', () => {
        const db = dbWithMessages()
        const user = addMessage(db, 'session', userMessage('first'), 'local-1', null, 1_700_000_000_000)
        const answer = addMessage(db, 'session', agentMessage('answer'), undefined, null, 1_700_000_000_040, origin('A1', 5, 3))
        const changed = markMessagesInvoked(db, 'session', ['local-1'], Date.now(), {
            sessionId: 'native-a', entryId: 'U1', entryOrder: 4, deliveredAt: '2024-03-10T00:00:00.000Z'
        })
        expect(changed).toBe(1)
        const messages = getMessagesByPosition(db, 'session', 10)
        expect(messages.map(m => m.id)).toEqual([user.id, answer.id])
        const epoch = answer.position!.at
        expect(messages[0]?.position).toEqual({ at: epoch, order: 4, eventOrder: 0 })
        expect(messages[0]?.invokedAt).toBe(Date.parse('2024-03-10T00:00:00.000Z'))
        expect(markMessagesInvoked(db, 'session', ['local-1'], Date.now(), {
            sessionId: 'native-a', entryId: 'U1', entryOrder: 4, deliveredAt: '2024-03-10T00:00:00.000Z'
        })).toBe(0)
        db.close()
    })

    it('orders a follow-up queued before a prior reply by committed journal entry', () => {
        const db = dbWithMessages()
        const first = addMessage(db, 'session', userMessage('first'), 'u1')
        const second = addMessage(db, 'session', userMessage('second'), 'u2')
        const answer1 = addMessage(db, 'session', agentMessage('a1'), undefined, null, 1_710_000_000_000, origin('A1', 5, 3))
        markMessagesInvoked(db, 'session', ['u1'], Date.now(), { sessionId: 'native-a', entryId: 'U1', entryOrder: 4, deliveredAt: '2024-03-10T00:00:00.000Z' })
        markMessagesInvoked(db, 'session', ['u2'], Date.now(), { sessionId: 'native-a', entryId: 'U2', entryOrder: 6, deliveredAt: '2024-03-10T00:00:00.000Z' })
        const answer2 = addMessage(db, 'session', agentMessage('a2'), undefined, null, 1_710_000_000_000, origin('A2', 6, 3))
        expect(getMessagesByPosition(db, 'session', 10).map(m => m.id)).toEqual([first.id, answer1.id, second.id, answer2.id])
        const cursor = answer2.position ? { ...answer2.position, seq: answer2.seq } : { at: 0, seq: answer2.seq }
        expect(getTurnStartsBefore(db, 'session', cursor, 1)[0]?.id).toBe(second.id)
        db.close()
    })

    it('is causal under ±60 seconds of source-clock skew because display order uses journal coordinates', () => {
        const db = dbWithMessages()
        const user = addMessage(db, 'session', userMessage('skewed'), 'skew')
        const earlyHub = addMessage(db, 'session', agentMessage('legacy tool'), undefined, null, 1_709_999_940_000)
        const native = addMessage(db, 'session', agentMessage('native'), undefined, null, 1_709_999_940_000, origin('A1', 5, 2))
        const lateHub = addMessage(db, 'session', agentMessage('late tool'), undefined, null, 1_710_000_060_000)
        markMessagesInvoked(db, 'session', ['skew'], Date.now(), {
            sessionId: 'native-a', entryId: 'U1', entryOrder: 4, deliveredAt: '2024-03-10T00:00:00.000Z'
        })
        const history = getMessagesByPosition(db, 'session', 10)
        const userIndex = history.findIndex(m => m.id === user.id)
        const nativeIndex = history.findIndex(m => m.id === native.id)
        expect(userIndex).toBeLessThan(nativeIndex)
        expect(history[0]?.id).toBe(earlyHub.id)
        expect(history.at(-1)?.id).toBe(lateHub.id)
        db.close()
    })

    it('keeps host terminal rows inside the active native epoch', () => {
        const db = dbWithMessages()
        const native = addMessage(db, 'session', agentMessage('native'), undefined, null, 1_710_000_000_000, origin('A1', 3, 4))
        const handled = addMessage(db, 'session', userMessage('/local'), 'local-cmd')
        resolveMessages(db, 'session', [{ localId: 'local-cmd', outcome: 'handled' }], Date.now())
        const future = addMessage(db, 'session', agentMessage('future'), undefined, null, 1_710_000_001_000, origin('A2', 4, 1))
        const terminal = addMessage(db, 'session', agentMessage('terminal'), undefined, null, 1_710_000_002_000)
        const history = getMessagesByPosition(db, 'session', 10)
        const epoch = native.position!.at
        expect(history[1]?.position).toEqual({ at: epoch, order: 3, eventOrder: 5 })
        expect(history.map(row => row.id)).toEqual([native.id, handled.id, future.id, terminal.id])
        db.close()
    })

    it('rejects duplicate or conflicting committed delivery identities instead of text/time matching', () => {
        const db = dbWithMessages()
        addMessage(db, 'session', userMessage('same text'), 'u1')
        addMessage(db, 'session', userMessage('same text'), 'u2')
        markMessagesInvoked(db, 'session', ['u1'], Date.now(), { sessionId: 'native-a', entryId: 'U1', entryOrder: 2, deliveredAt: '2024-03-10T00:00:00.000Z' })
        expect(() => markMessagesInvoked(db, 'session', ['u2'], Date.now(), { sessionId: 'native-a', entryId: 'U1', entryOrder: 2, deliveredAt: '2024-03-10T00:00:00.000Z' })).toThrow('identity conflict')
        expect(markMessagesInvoked(db, 'session', ['u2'], Date.now(), { sessionId: 'native-a', entryId: 'U2', entryOrder: 3, deliveredAt: '2024-03-10T00:00:00.000Z' })).toBe(1)
        db.close()
    })

    it('turn boundaries follow the logical tuple for tool and replayed subagent frames', () => {
        const db = dbWithMessages()
        const user = addMessage(db, 'session', userMessage('u'), 'u')
        markMessagesInvoked(db, 'session', ['u'], Date.now(), { sessionId: 'native-a', entryId: 'U', entryOrder: 2, deliveredAt: '2024-03-10T00:00:00.000Z' })
        const replay = addMessage(db, 'session', agentMessage('subagent replay'), undefined, null, 10, origin('A', 2, 9))
        const tool = addMessage(db, 'session', agentMessage('tool'), undefined, null, 11, origin('A', 3, 1))
        const next = addMessage(db, 'session', agentMessage('next'), undefined, null, 12, origin('A', 4, 1))
        const rows = getTurnHistoryRows(db, 'session', { limit: 10, descending: false })
        expect(rows.map(row => row.id)).toEqual([user.id, replay.id, tool.id, next.id])
        db.close()
    })

    it('registers recovered proof without retagging an already-invoked legacy user', () => {
        const db = dbWithMessages()
        const user = addMessage(db, 'session', userMessage('legacy'), 'legacy')
        markMessagesInvoked(db, 'session', ['legacy'], 100)
        const reply = addMessage(db, 'session', agentMessage('legacy reply'), undefined, null, 200)
        const epoch = db.prepare('SELECT epoch FROM message_epochs WHERE session_id = ?').get('session')
        const proof = { sessionId: 'native-a', entryId: 'U1', entryOrder: 2, deliveredAt: '2024-03-10T00:00:00.000Z' }
        expect(markMessagesInvoked(db, 'session', ['legacy'], Date.now(), proof)).toBe(0)
        expect(getLocalMessageStates(db, 'session', ['legacy'])).toEqual([{ localId: 'legacy', invokedAt: 100 }])
        expect(getMessagesByPosition(db, 'session', 10).map(row => row.id)).toEqual([user.id, reply.id])
        expect(db.prepare('SELECT epoch FROM message_epochs WHERE session_id = ?').get('session')).toEqual(epoch)
        expect(markMessagesInvoked(db, 'session', ['legacy'], Date.now(), proof)).toBe(0)
        expect(() => markMessagesInvoked(db, 'session', ['legacy'], Date.now(), { ...proof, entryId: 'conflict' })).toThrow('identity conflict')
        db.close()
    })

    it('returns persisted logical positions with local states and resolutions', () => {
        const db = dbWithMessages()
        const native = addMessage(db, 'session', agentMessage('native'), undefined, null, 1_710_000_000_000, origin('A1', 3, 4))
        addMessage(db, 'session', userMessage('delivered'), 'u')
        markMessagesInvoked(db, 'session', ['u'], Date.now(), {
            sessionId: 'native-a', entryId: 'U', entryOrder: 2, deliveredAt: '2024-03-10T00:00:00.000Z'
        })
        addMessage(db, 'session', userMessage('/local'), 'cmd')
        const resolved = resolveMessages(db, 'session', [{ localId: 'cmd', outcome: 'handled' }], 1234)
        const epoch = native.position!.at
        expect(resolved[0]?.position).toEqual({ at: epoch, order: 3, eventOrder: 5 })
        const states = getLocalMessageStates(db, 'session', ['u', 'cmd'])
        expect(states[0]?.position).toEqual({ at: epoch, order: 2, eventOrder: 0 })
        expect(states[1]?.position).toEqual({ at: epoch, order: 3, eventOrder: 5 })
        db.close()
    })
})
