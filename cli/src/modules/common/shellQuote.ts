/**
 * Shell quoting for command strings executed by agent hook runners.
 *
 * Shared by the hook settings generator and the agy PTY launcher, which both
 * need to embed a resolved CLI command (with arbitrary path/arg characters)
 * into a single shell command string.
 */

/** Quote a single argument so it survives `sh -c` word-splitting intact. */
export function shellQuote(value: string): string {
    if (value.length === 0) {
        return '""';
    }

    if (/^[A-Za-z0-9_\/:=-]+$/.test(value)) {
        return value;
    }

    return '"' + value.replace(/(["\\$`])/g, '\\$1') + '"';
}

/** Quote one argv element using the CommandLineToArgvW escaping convention. */
export function windowsCommandQuote(value: string): string {
    // cmd.exe expands %VAR% even inside quotes, and may expand !VAR! when its
    // caller enables delayed expansion. There is no context-free escaping that
    // survives every cmd /c mode, so reject those uncommon path characters
    // instead of silently launching a different command.
    if (/[%!\r\n]/.test(value)) {
        throw new Error('Windows hook command paths and arguments cannot contain %, !, CR, or LF');
    }
    if (value.length > 0 && !/[\s"&|<>^()]/.test(value)) return value;
    let result = '"';
    let backslashes = 0;
    for (const char of value) {
        if (char === '\\') {
            backslashes += 1;
        } else if (char === '"') {
            result += '\\'.repeat(backslashes * 2 + 1) + '"';
            backslashes = 0;
        } else {
            result += '\\'.repeat(backslashes) + char;
            backslashes = 0;
        }
    }
    return result + '\\'.repeat(backslashes * 2) + '"';
}

/**
 * Join a command for Claude Code hook settings.
 *
 * Claude Code on Windows executes hook commands through Git Bash, so the cmd-style
 * `C:\Users\...\hapi.exe` form loses every backslash (`C:UsersAdministrator...`, exit 127).
 * Drive-letter paths are rewritten with forward slashes, which Windows accepts; left
 * unquoted they run unchanged under bash, cmd and PowerShell. Only parts with spaces or
 * shell metacharacters are double-quoted (bash semantics). Other platforms keep shellJoin.
 */
export function claudeHookCommandJoin(parts: string[], platform: NodeJS.Platform = process.platform): string {
    if (platform !== 'win32') {
        return shellJoin(parts, platform);
    }
    return parts.map((part) => {
        if (/[%!\r\n]/.test(part)) {
            throw new Error('Windows hook command paths and arguments cannot contain %, !, CR, or LF');
        }
        const value = /^[A-Za-z]:[\\/]/.test(part) ? part.replace(/\\/g, '/') : part;
        if (value.length > 0 && /^[A-Za-z0-9_\/:=@.+,-]+$/.test(value)) {
            return value;
        }
        return '"' + value.replace(/(["\\$`])/g, '\\$1') + '"';
    }).join(' ');
}

/** Quote each part for AGY's documented `sh -c` / `cmd /c` hook runner. */
export function shellJoin(parts: string[], platform: NodeJS.Platform = process.platform): string {
    const quote = platform === 'win32' ? windowsCommandQuote : shellQuote;
    return parts.map(quote).join(' ');
}
