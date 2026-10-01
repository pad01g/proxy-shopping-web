/**
 * The libp2p node (§10) for apps, browsers and Node: `P2PNode.start({...})`, then `session.attachP2P(node)`.
 * A separate entry point so that users of core without P2P do not bundle libp2p.
 */
export { P2PNode, libp2pPeerId, libp2pPrivateKey, webRTCWorks, type P2PNodeOptions } from './p2p/node.js';
export * from './p2p/types.js';
