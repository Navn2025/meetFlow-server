import express from "express";
import {authMiddleware} from "../middleware/auth.middleware.js";
import {addParticipant, deleteParticipant, getParticipantById, getParticipantsByRoomId, updateParticipant} from "../controllers/participant.controller.js";
const router=express.Router();
router.post("/add-participant", authMiddleware, addParticipant)
router.get("/get-participant-by-id/:id", authMiddleware, getParticipantById)
router.get("/get-participant-by-room-id/:id", authMiddleware, getParticipantsByRoomId);
router.put("/update-participant/:id", authMiddleware, updateParticipant);
router.delete("/delete-participant/:id", authMiddleware, deleteParticipant);



export default router;

