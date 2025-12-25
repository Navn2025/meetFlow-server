import mongoose from "mongoose";

const userSchema=new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },

    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },

    password: {
        type: String,
        required: true,
        select: false // ✅ this hides password by default
    },

    preferred_language: {
        type: String,
        default: "en"
    },

    preferred_voice: {
        type: String,
        default: "en-US-Wavenet-D"
    },

    created_at: {
        type: Date,
        default: Date.now
    }
});

const userModel=mongoose.model("User", userSchema);
export default userModel;
