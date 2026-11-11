import type { ClientToServerEvents, ServerToClientEvents } from '@hapi/protocol'
import type { DefaultEventsMap, Server, Socket } from 'socket.io'

export type SocketData = {
    namespace?: string
    userId?: number
    /** Gateway account id when the CLI authenticated with a gateway API token. */
    gatewayAccountId?: number
    /** Gateway API-token row id; lets runtime paths re-check revocation per frame. */
    gatewayTokenId?: number
    /** True when authenticated via the trusted runner/master CLI_API_TOKEN. */
    cliTrusted?: boolean
}

export type SocketServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>
export type SocketWithData = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>
export type CliSocketServer = Server<ServerToClientEvents, ClientToServerEvents, DefaultEventsMap, SocketData>
export type CliSocketWithData = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>
