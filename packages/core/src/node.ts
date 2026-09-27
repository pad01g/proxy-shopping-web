import WebSocket from 'ws';
import { useWebSocketImplementation } from 'nostr-tools/pool';

// Node 22's built-in WebSocket fires 'error' synchronously from close(), and nostr-tools closes the
// socket from its onerror handler, which recurses until the stack overflows when a relay refuses
// the connection. The ws package dispatches asynchronously, like browsers do.
// ws also emits 'error' when nostr-tools gives up on a connection that is still opening; with no
// listener that would crash the process, and nostr-tools already reports the failure itself.
class QuietWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    this.on('error', () => {});
  }
}
useWebSocketImplementation(QuietWebSocket);

export * from './index.js';
export { FileStorage } from './storage/file.js';
