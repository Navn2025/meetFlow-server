import mongoose from "mongoose";

const participantSchema=new mongoose.Schema({
    roomId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Room",
        required: true
    },

    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    joinedAt: {
        type: Date,
        default: Date.now
    },

    leftAt: {
        type: Date
    },

    isMuted: {
        type: Boolean,
        default: false
    },

    languageSpoken: {
        type: String,
        default: "en"
    },

    targetLanguage: {
        type: String,
        default: "hi"
    }
});

const participantModel=mongoose.model("Participant", participantSchema);
export default participantModel;

