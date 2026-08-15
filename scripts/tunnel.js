/**
 * SHARE THE SHOP.
 *
 *   npm run tunnel
 *
 * Builds the client, keeps rebuilding it on every save, and exposes the game
 * server through a public Cloudflare URL. That single URL serves:
 *
 *   - the game itself (so the other person just opens a link), and
 *   - the /api control surface (so their agent's MCP server can reach it).
 *
 * Because the build watcher is running, code edits on this machine — whether
 * made by you or by someone's agent over MCP — show up for everyone after a
 * couple of seconds. Content edits (items, crops, customers) are instant, since
 * those live in the database and never touch a file.
 *
 * Set SNS_TOKEN before running if you don't want the control API open to
 * whoever has the link.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = process.env.PORT ?? 2567;
const children = [];

function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const tag = `[${name}]`;
  const pipe = (stream, out) => {
    stream.on('data', (buf) => {
      for (const line of String(buf).split('\n')) {
        if (line.trim()) out(`${tag} ${line}`);
      }
    });
  };
  pipe(child.stdout, console.log);
  pipe(child.stderr, (line) => {
    console.log(line);
    // cloudflared prints the public URL to stderr — surface it loudly.
    const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (url) {
      console.log(`\n  🌍 Shop is live at: ${url[0]}`);
      console.log(`     Game:     ${url[0]}`);
      console.log(`     MCP/API:  ${url[0]}/api\n`);
    }
  });
  child.on('exit', (code) => console.log(`${tag} exited (${code})`));
  children.push(child);
  return child;
}

if (!process.env.SNS_TOKEN) {
  console.log('\n⚠️  SNS_TOKEN is not set — anyone with the link can drive the control API.');
  console.log('   For a private session that is usually fine. To lock it down:');
  console.log('   SNS_TOKEN=some-shared-secret npm run tunnel\n');
}

run('build', 'npx', ['vite', 'build', '--watch']);
run('server', process.execPath, ['server/index.js'], { NODE_ENV: 'production' });

// Give the build a moment to produce dist/ before the tunnel starts serving.
setTimeout(() => run('tunnel', 'cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`]), 4000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of children) c.kill();
    process.exit(0);
  });
}
