import userModel from "../model/user.model.js";
import jwt from 'jsonwebtoken';

//making auth-middleware
export const authMiddleware=async (req, res, next) =>
{
    try
    {
        // Check Authorization header (Bearer token)
        const authHeader=req.headers.authorization||req.headers.cookie;
        if (!authHeader)
        {
            return res.status(401).json({
                message: "Unauthorized - No token provided"
            });
        }

        // Extract token from "Bearer <token>"
        const token=authHeader.split(' ')[1];
        if (!token)
        {
            return res.status(401).json({
                message: "Unauthorized - Invalid token format"
            });
        }

        // Verify JWT token
        const decoded=jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded)
        {
            return res.status(401).json({
                message: "Unauthorized - Invalid token"
            });
        }

        req.user=decoded;
        next();
    }
    catch (err)
    {
        console.error("Auth Error:", err.message);
        return res.status(401).json({
            message: "Unauthorized - "+err.message
        });
    }
}