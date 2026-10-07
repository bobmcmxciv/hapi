import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claudeHookCommandJoin, shellJoin, windowsCommandQuote } from './shellQuote';

describe('Windows hook command quoting', () => {
    it('quotes executable paths with spaces for cmd /c', () => {
        expect(shellJoin(['C:\\Program Files\\HAPI\\hapi.exe', 'hook-forwarder'], 'win32'))
            .toBe('"C:\\Program Files\\HAPI\\hapi.exe" hook-forwarder');
    });

    it('preserves trailing backslashes and embedded quotes', () => {
        expect(windowsCommandQuote('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
        expect(windowsCommandQuote('say"hi')).toBe('"say\\"hi"');
    });

    it('fails closed for cmd expansions that cannot be safely quoted', () => {
        expect(() => windowsCommandQuote('C:\\Users\\%USERNAME%\\hapi.exe')).toThrow();
        expect(() => windowsCommandQuote('C:\\Users\\name!\\hapi.exe')).toThrow();
    });

    it.runIf(process.platform === 'win32')('round-trips argv through the documented cmd /c hook shell', () => {
        const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
        const expected = ['space & paren()', 'embedded"quote', 'trailing\\'];
        const command = shellJoin([process.execPath, '-e', script, ...expected], 'win32');
        const output = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
            encoding: 'utf8'
        });
        expect(JSON.parse(output)).toEqual(expected);
    });
});

// Claude Code on Windows runs hook commands through Git Bash, not cmd. The cmd-style
// `C:\Users\...\hapi.exe` form reached bash as `C:UsersAdministrator...hapi.exe`
// and exited 127 on every SessionStart (DESKTOP-4SQALMG, 2026-10-07).
describe('Claude hook command for the Windows hook shell', () => {
    it('uses an unquoted forward-slash path that bash, cmd and PowerShell all execute', () => {
        expect(claudeHookCommandJoin([
            'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@twsxtd\\hapi\\bin\\hapi.exe',
            'hook-forwarder', '--flavor', 'claude', '--port', '1189', '--token', 'abc123'
        ], 'win32')).toBe(
            'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@twsxtd/hapi/bin/hapi.exe hook-forwarder --flavor claude --port 1189 --token abc123'
        );
    });

    it('double-quotes paths that contain spaces', () => {
        expect(claudeHookCommandJoin(['C:\\Program Files\\HAPI\\hapi.exe', 'hook-forwarder'], 'win32'))
            .toBe('"C:/Program Files/HAPI/hapi.exe" hook-forwarder');
    });

    it('keeps POSIX quoting unchanged on other platforms', () => {
        const parts = ['/usr/local/bin/hapi', 'hook-forwarder', '--token', 'a b'];
        expect(claudeHookCommandJoin(parts, 'darwin')).toBe(shellJoin(parts, 'darwin'));
    });

    it.runIf(process.platform === 'win32')('runs through Git Bash when the hook shell is bash', () => {
        const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
        const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
        const command = claudeHookCommandJoin([process.execPath, '-e', script, 'hook-forwarder', '--port', '1189'], 'win32');
        const output = execFileSync(bash, ['-c', command], { encoding: 'utf8' });
        expect(JSON.parse(output)).toEqual(['hook-forwarder', '--port', '1189']);
    });
});
