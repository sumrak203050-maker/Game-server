'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');

const app = express();
app.disable('x-powered-by');
app.enable('trust proxy');

// PeerJS listAllPeers() is used by the game to build the active lobby browser.
// CORS is required because the game HTML may be hosted on a different domain.
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.get('/', (_req, res) => {
  res.json({
    service: 'Platy Dom PeerJS signaling server',
    status: 'ok',
    peerPath: '/peerjs',
    lobbyDiscovery: true
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, discovery: true });
});

const server = http.createServer(app);
const peerServer = ExpressPeerServer(server, {
  // Mounted below /peerjs. The client uses path: '/peerjs' and the default
  // PeerJS key 'peerjs', so API and WebSocket paths remain compatible.
  path: '/',
  proxied: true,
  allow_discovery: true,
  alive_timeout: 90000,
  expire_timeout: 10000,
  corsOptions: {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS']
  }
});

peerServer.on('connection', client => {
  console.log('[PeerJS] connected:', client.getId());
});
peerServer.on('disconnect', client => {
  console.log('[PeerJS] disconnected:', client.getId());
});

app.use('/peerjs', peerServer);

const port = Number(process.env.PORT) || 10000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Platy Dom PeerJS server listening on ${port}`);
  console.log('PeerJS path: /peerjs/peerjs');
  console.log('Peer discovery: enabled');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
