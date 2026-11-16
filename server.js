const { PeerServer } = require("peer");

const server = PeerServer({
    port: process.env.PORT || 9000,
    path: "/peerjs"
});

console.log("Сервер запущен на порту " + (process.env.PORT || 9000));
