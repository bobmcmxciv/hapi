/**
 * The access log printed full request URLs, so every SSE reconnect wrote the
 * caller's JWT (`/api/events?token=…`) and every client download wrote the
 * download token (`/download/<token>/<file>`) to `docker logs`. Keep the rest
 * of the URL: cursors such as `afterSeq` are what make the log useful.
 */
const SENSITIVE_QUERY_PARAM = /([?&](?:token|access_token|accessToken|jwt|key|secret|password)=)[^&\s]*/gi
const DOWNLOAD_PATH_TOKEN = /(\/download\/)[^/\s?]+/g

export function redactAccessLogLine(line: string): string {
    return line
        .replace(SENSITIVE_QUERY_PARAM, '$1[redacted]')
        .replace(DOWNLOAD_PATH_TOKEN, '$1[redacted]')
}
