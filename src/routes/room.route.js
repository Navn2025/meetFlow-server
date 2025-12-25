import express from "express";
import {authMiddleware} from "../middleware/auth.middleware.js";
import {endRoom, getAllRoom, getRoomsById, roomCreate} from "../controllers/room.controller.js";
const router=express.Router();
router.post("/create-room", authMiddleware, roomCreate)
router.get("/get-all-room", authMiddleware, getAllRoom)
router.get("/get-room-by-id/:id", authMiddleware, getRoomsById);
router.delete("/delete-room/:id", authMiddleware, endRoom);

export default router;

