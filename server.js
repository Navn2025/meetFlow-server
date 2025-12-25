import app from "./src/app.js";
import http from 'http';
import initSocketServer from "./src/socket/socket.server.js";
import connectToDB from "./src/db/db.js";
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Connect to database
connectToDB();

const httpServer=http.createServer(app);
const PORT=process.env.PORT||3000;

// Initialize Socket.IO with mediasoup
const io=initSocketServer(httpServer);

httpServer.listen(PORT, () =>
{
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`📡 WebSocket server ready`);
    console.log(`🎥 Mediasoup SFU initialized`);
});

export {io};


