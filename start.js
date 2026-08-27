const { spawn } = require('child_process');
const path = require('path');

console.log('Starting Cloudflare quick tunnel...');

const tunnel = spawn(path.join(__dirname, 'cloudflared.exe'), ['tunnel', '--url', 'http://localhost:3000']);

let serverStarted = false;
const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function handleOutput(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);

  if (serverStarted) return;

  const match = text.match(urlPattern);
  if (match) {
    serverStarted = true;
    const publicUrl = match[0];

    console.log('\n============================================');
    console.log(' Public URL captured: ' + publicUrl);
    console.log(' Open the Admin dashboard at:');
    console.log(' ' + publicUrl + '/index.html?role=admin');
    console.log('============================================\n');

    const server = spawn('node', ['server.js'], {
      stdio: 'inherit',
      env: { ...process.env, PUBLIC_BASE_URL: publicUrl }
    });

    server.on('exit', (code) => {
      tunnel.kill();
      process.exit(code);
    });
  }
}

tunnel.stdout.on('data', handleOutput);
tunnel.stderr.on('data', handleOutput);

tunnel.on('exit', (code) => {
  if (!serverStarted) {
    console.error('cloudflared exited before a tunnel URL was found (exit code ' + code + '). Try running start.js again.');
    process.exit(1);
  }
});

process.on('SIGINT', () => {
  tunnel.kill();
  process.exit(0);
});