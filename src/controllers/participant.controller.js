import participantModel from "../model/participant.model.js";
import roomModel from "../model/room.model.js";

export const addParticipant=async (req, res) =>
{
    try
    {
        const {roomId}=req.body;
        const userId=req.user.id;

        // 1️⃣ Validate input
        if (!roomId)
        {
            return res.status(400).json({message: "Room ID is required"});
        }

        // 2️⃣ Check if room exists
        const existingRoom=await roomModel.findOne({
            _id: roomId
        });
        if (!existingRoom)
        {
            return res.status(404).json({message: "No such room exists"});
        }

        // 3️⃣ Check if user already joined this room
        const existingParticipant=await participantModel.findOne({roomId, userId});
        if (existingParticipant)
        {
            return res.status(409).json({
                message: "User is already a participant in this room",
            });
        }

        // 4️⃣ Create new participant
        const newParticipant=await participantModel.create({
            roomId,
            userId,
        });

        // 5️⃣ Push user ID to the room's participants array (avoid duplicates)
        const room=await roomModel.findByIdAndUpdate(roomId, {
            $addToSet: {participants: userId},
        });

        // 6️⃣ Respond with success
        return res.status(200).json({
            message: "Participant added successfully",
            participant: newParticipant,
            room: room

        });
    } catch (error)
    {
        console.error("Error adding participant:", error);
        return res.status(500).json({
            message: "An error occurred while adding participant",
            error: error.message,
        });
    }
};

export const getParticipantById=async (req, res) =>
{
    try
    {
        const {id}=req.params;
        if (!id)
        {
            return res.status(400).json({
                message: "Participant id is required"
            })
        }
        const participant=await participantModel.findById(id);
        if (!participant)
        {
            return res.status(400).json({
                message: "Participant not found"
            })
        }
        return res.status(200).json({
            message: "participant fetched Successfully",
            participant
        });
    }
    catch (err)
    {
        return res.status(400).json({
            message: "Error in finding participant"
        })
    }
}
export const getParticipantsByRoomId=async (req, res) =>
{
    try
    {

        const {id}=req.params;
        if (!id)
        {
            return res.status(400).json({
                message: "Room id is required"
            })
        };
        const room=await roomModel.findById(id);
        if (!room)
        {
            return res.status(400).json({
                message: "Room does not exists"
            });

        };
        return res.status(200).json({
            message: "room participants",
            participants: room.participants

        });
    } catch (err)
    {
        return res.status(200).json({
            message: "error in finding participangts in room"
        });

    }
}

export const updateParticipant=async (req, res) =>
{
    try
    {
        const {id}=req.params;
        const updates=req.body;

        const participant=await participantModel.findByIdAndUpdate(
            id,
            {$set: updates},
            {new: true}
        );

        if (!participant)
        {
            return res.status(404).json({success: false, message: "Participant not found"});
        }

        res.status(200).json({
            success: true,
            message: "Participant updated successfully",
            data: participant,
        });
    } catch (error)
    {
        console.error("Error updating participant:", error);
        res.status(500).json({
            success: false,
            message: "Server error while updating participant",
        });
    }
};
export const deleteParticipant=async (req, res) =>
{
    try
    {
        const {id}=req.params; // participant ID from URL

        const participant=await participantModel.findByIdAndDelete(id);

        if (!participant)
        {
            return res.status(404).json({
                success: false,
                message: "Participant not found",
            });
        }

        res.status(200).json({
            success: true,
            message: "Participant removed successfully",
            data: participant,
        });
    } catch (error)
    {
        console.error("Error deleting participant:", error);
        res.status(500).json({
            success: false,
            message: "Server error while deleting participant",
        });
    }
};
