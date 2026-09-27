// Forward localhost:8080 to FORWARD_TO (host:port) so the browser sees a secure-context origin.
import { connect, createServer } from 'node:net';

const [host, port] = (process.env.FORWARD_TO ?? 'lab:8080').split(':');
createServer((c) => {
  const up = connect(Number(port), host);
  c.pipe(up).pipe(c);
  const close = () => { c.destroy(); up.destroy(); };
  c.on('error', close);
  up.on('error', close);
}).listen(8080, '127.0.0.1');
