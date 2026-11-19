// main.ts — forge entrypoint. Binds an ephemeral port, registers it with the
// trial harness, serves until the harness says the run is done, then exits 0.
// Without MAKEFUN_ENV_URL (local development) it just listens on $PORT and
// serves until stopped.

import { createServer } from './app.ts';
import { Store } from './store.ts';

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
const store = new Store();
const server = createServer(store, { token });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/register`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return;
    } catch {
      // fall through to retry
    }
    await sleep(500);
  }
  throw new Error(`Failed to register port ${port} with ${url}`);
}

async function waitDone(): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/done`;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // harness not ready yet; keep polling
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine listen address'));
        return;
      }
      resolve(address.port);
    });
  });

  if (envUrl === '') {
    const requested = process.env.PORT !== undefined ? parseInt(process.env.PORT, 10) : null;
    if (requested !== null && Number.isFinite(requested) && requested !== 0) {
      // Rebind on the requested port for local manual testing.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(requested, '127.0.0.1', () => resolve());
      });
      console.log(`forge listening on http://127.0.0.1:${requested}`);
    } else {
      console.log(`forge listening on http://127.0.0.1:${port}`);
    }
    return;
  }

  await register(port);
  await waitDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
