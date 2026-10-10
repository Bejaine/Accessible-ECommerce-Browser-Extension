// Starts Track C's real FastAPI backend (MOCK=1: no LLM or language-API calls on these paths)
// for the persona runs, and stops it afterwards.
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PORT = 8765;
let server: ChildProcess | null = null;

function healthy(): Promise<boolean> {
  return new Promise((ok) => {
    http
      .get(`http://127.0.0.1:${PORT}/health`, (res) => {
        res.resume();
        ok(res.statusCode === 200);
      })
      .on('error', () => ok(false));
  });
}

export async function setup(): Promise<void> {
  server = spawn(join(ROOT, '.venv/bin/uvicorn'), ['app.main:app', '--port', String(PORT)], {
    cwd: join(ROOT, 'backend'),
    env: { ...process.env, MOCK: '1', PYTHONPATH: join(ROOT, 'shared/generated/py') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (await healthy()) {
      process.env.ASL_E2E_BACKEND = `http://127.0.0.1:${PORT}`;
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('backend did not start (is .venv set up? run make setup)');
}

export async function teardown(): Promise<void> {
  server?.kill();
}
