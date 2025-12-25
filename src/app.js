import cookieParser from "cookie-parser";
import express from "express";
import {configDotenv} from 'dotenv';
import authRoutes from '../src/routes/auth.route.js';
import participantRoutes from '../src/routes/participant.route.js';
import roomRoutes from '../src/routes/room.route.js';
import cors from 'cors'
import morgan from 'morgan'
configDotenv();
const app=express();

app.use(express.json());

app.use(cookieParser());
app.use(cors({
    origin: "http://localhost:5173",   // your React frontend URL
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,   // IMPORTANT (allows cookies)
}));
app.use(morgan('dev'));
app.use("/api/auth", authRoutes);
app.use("/api/room", roomRoutes);
app.use("/api/participant", participantRoutes);


export default app;