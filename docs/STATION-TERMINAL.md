# Station terminal

Moore Weather 1.2.0 adds a small station terminal at `/terminal.html`, linked from the footer of Current Readings, Daily Summary and Forecast. It requires the normal portal login and a separate terminal password.

## Use

Unlock the terminal, select **Connect**, enter one command and select **Send** or press Enter. `TIME`, `VER`, `LISTALL` and `r3` shortcuts fill the command field; they do not send automatically. The server adds CRLF. Up and Down recall commands from this page session. Output can be selected, copied, saved as text or cleared.

The terminal connects only to the station already configured for the app. It is a text terminal, not a shell. Output is displayed as text, with no HTML or terminal-escape interpretation. Passwords, commands and station output are excluded from analytics and routine application logs. Command history and output stay in page memory unless the operator saves a transcript.

## Connection and Abort

One connected terminal owns the shared station queue. A current automatic request finishes before it connects; subsequent automatic reads and clock checks wait until it disconnects. This avoids two TCP clients sending commands into the same EW10 serial path. The page displays this pause explicitly.

Disconnect when finished. Inactivity for 60 seconds or a five-minute connection limit also ends the connection. Closing the page, locking the terminal, logging out or restarting the server triggers bounded cleanup. The automatic collectors are not permanently stopped by a terminal session.

**Abort** sends five ASCII Ctrl+C (`0x03`) bytes, 100 milliseconds apart, on the owned connection. This implements the requested repeated Ctrl+C operation. It does not promise that the logger acknowledged the signal or that an already applied setting was undone. Disconnect cleanup interrupts and drains the connection before releasing the queue. An established connection retains one fixed eight-second cleanup period even if TCP closes early: the gateway's serial output may outlive its TCP client. This bounded wait is not a logger acknowledgement, and it does not reconnect or retry commands.

Commands are not automatically retried after an uncertain result. Check the station state before resending a setting command. The terminal accepts one printable command line of up to 512 bytes; it does not upload schedules or send arbitrary files. A connection has a bounded 2 MiB output allowance.

## Access configuration

`MOORE_TERMINAL_PASSWORD_HASH` is a separately salted `scrypt$salt$hash` value stored in the service's private environment configuration. No real password or hash belongs in this repository. Missing or malformed configuration disables terminal access while leaving the weather app available. Setting `WEATHER_TERMINAL_ENABLED=false` also disables the terminal without changing its password hash.

An unlock issues a short-lived, HttpOnly, SameSite=Strict cookie. Production cookies are Secure. State-changing requests require the exact same origin, JSON input and, after unlocking, the session's CSRF token. Each active connection also has its own tab capability, so another tab or browser cannot send commands, read output or interrupt it. Login attempts and server memory are bounded. Password checking is asynchronous.

## Station configuration changes

Commands act on the real logger. In particular, changing `STORAGE` can change the meaning of downloaded columns. Coordinate those changes with the application's stored layout and a verified cutover boundary. See [the black globe storage recommendation](BLACK-GLOBE-STORAGE.md) before replacing the ten-minute S-THETA entry.

The terminal does not silently rewrite the app's sensor mapping, delete archives, or turn a manually entered `SETTIME` into an automatically journalled clock correction.

## Verification

Offline tests exercise password and portal boundaries, origin/CSRF checks, connection ownership, queued cancellation, repeated Ctrl+C, output bounds, browser disconnect, expiry and queue release. The browser fixture uses fake responses and sends no station commands. A production operator can verify the live terminal by connecting, sending `TIME` and `VER`, then disconnecting and checking that normal weather collection resumes.
