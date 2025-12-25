// socketServer.js

import {Server} from "socket.io";
import {roomController} from "../mediasoup/room.controller.js";

import {createWorkers} from "../mediasoup/worker.manager.js";

const initSocketServer=async (httpServer) =>
{

    // 🔥 Start mediasoup workers
    await createWorkers();

    // 🔥 Start socket.io
    const io=new Server(httpServer, {

        cors: {
            origin: "https://meet-flow-zy99.vercel.app",
            allowedHeaders: ["Content-Type", "Authorization"],
            credentials: true
        }

    });

    console.log("⚡ Socket.IO initialized");

    // 🔥 Attach mediasoup signaling
    roomController(io);


    return io;
};

export default initSocketServer;
