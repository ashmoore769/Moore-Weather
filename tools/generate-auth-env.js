#!/usr/bin/env node
"use strict";

const crypto = require("crypto");

function readHidden(promptText) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new Error("Run this helper directly in an interactive Terminal window."));
      return;
    }

    const previousRaw = Boolean(input.isRaw);
    let value = "";

    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(previousRaw);
      input.pause();
    };

    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          cleanup();
          output.write("\n");
          process.exit(130);
        }

        if (char === "\r" || char === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }

        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        if (char >= " ") value += char;
      }
    };

    output.write(promptText);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main() {
  const password = await readHidden("Shared Moore Weather password: ");
  const confirmation = await readHidden("Confirm password: ");

  if (password !== confirmation) {
    throw new Error("Passwords did not match. Nothing was generated.");
  }

  if (password.length < 10) {
    throw new Error("Use at least 10 characters. A short multi-word passphrase is ideal.");
  }

  if (password.length > 256) {
    throw new Error("Password is too long (maximum 256 characters).");
  }

  const salt = crypto.randomBytes(24);
  const derived = crypto.scryptSync(password, salt, 64);
  const cookieSecret = crypto.randomBytes(48).toString("base64url");
  const passwordHash = `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;

  process.stdout.write("\nCopy these values into Render Environment Variables:\n\n");
  process.stdout.write(`MOORE_AUTH_PASSWORD_HASH=${passwordHash}\n`);
  process.stdout.write(`MOORE_AUTH_COOKIE_SECRET=${cookieSecret}\n`);
  process.stdout.write("MOORE_AUTH_MAX_AGE_DAYS=730\n");
  process.stdout.write("\nThe plaintext password was not written to disk or printed.\n");
}

main().catch((error) => {
  process.stderr.write(`\nError: ${error.message}\n`);
  process.exit(1);
});
