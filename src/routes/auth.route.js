import express from "express";
import {currentUser, loginController, registerController} from "../controllers/auth.controller.js";
import {authMiddleware} from "../middleware/auth.middleware.js";
const router=express.Router();


router.post("/login", loginController);
router.post("/register", registerController);
router.get("/get-user", authMiddleware, currentUser)


export default router;

